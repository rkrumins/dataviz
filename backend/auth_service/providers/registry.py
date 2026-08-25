"""DB-backed provider registry.

Each ``idp_providers`` row materialises into a provider instance
(``OidcProvider``, ``SamlProvider``, ``CustomIdentityProvider``) the
first time it's referenced; the result is cached for a short TTL so
the steady-state cost of resolving a provider per HTTP request is
zero DB round-trips. Admin mutations call :meth:`invalidate` so
operators see their changes immediately.

Boundary: this module is the only place in ``auth_service`` that
sees ``IdpProviderORM``-shaped data. Everything else accepts the
already-materialised provider object. The repo + decryption helpers
are injected via :class:`ProviderConfigLoader` so the
``auth-service-isolation`` test stays green (no
``backend.app.*`` imports).
"""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Optional, Protocol

from .base import IdentityProvider

logger = logging.getLogger(__name__)


# ── Wire shape from the app ──────────────────────────────────────────


@dataclass(frozen=True)
class ProviderConfigSnapshot:
    """The fully-decoded subset of an ``IdpProviderORM`` row the
    registry needs to build a provider object. The repo layer owns
    the decryption; we never see the encrypted blob.
    """
    id: str
    slug: str
    display_name: str
    kind: str                       # 'oidc' | 'saml2' | 'custom'
    enabled: bool
    priority: int
    settings: dict                  # decrypted, ready-to-use
    claim_mapping: dict             # operator override (may be empty)
    linking_policy: str             # 'strict' | 'allow_verified' | 'manual_only' | 'disabled'
    button_label: Optional[str]
    button_icon: Optional[str]
    #: 'draft' | 'live'. A draft is configured but not published. The
    #: public catalog already filters on it; authentication did not,
    #: which made "not published" mean "not advertised" rather than
    #: "not usable". Defaulted so a caller that predates the field
    #: (tests, the env boot-seeder) keeps behaving as before.
    lifecycle: str = "live"


class ProviderConfigLoader(Protocol):
    """Async callable wired by the app at startup. Reads (decrypted)
    provider rows from the DB. The registry calls it on cache miss /
    invalidation."""

    async def get_by_id(self, provider_id: str) -> Optional[ProviderConfigSnapshot]: ...
    async def get_by_slug(self, slug: str) -> Optional[ProviderConfigSnapshot]: ...
    async def list_enabled(self) -> list[ProviderConfigSnapshot]: ...


# ── Errors ───────────────────────────────────────────────────────────


class ProviderNotFound(LookupError):
    """No enabled provider matches the requested id/slug. Routes turn
    this into a 404."""


class ProviderDisabled(ProviderNotFound):
    """The provider exists but its ``enabled`` flag is False. Treated
    as "not found" externally to avoid an enumeration oracle."""


class ProviderNotPublished(ProviderNotFound):
    """The provider exists and is enabled, but is still a draft.

    ``lifecycle`` was honoured by the public catalog and by nothing
    else, so a draft — created by ``POST /admin/idp-providers``, which
    defaults ``enabled`` to True — was fully live at
    ``/auth/{slug}/login`` and its callback for anyone who guessed the
    slug, JIT provisioning included. Rehearsing a draft is what the
    dry-run flow is for, and that path opts in explicitly.

    Subclasses ``ProviderNotFound`` so routes keep answering 404 and the
    draft's existence stays private.
    """


# ── Factory protocol ─────────────────────────────────────────────────


ProviderBuilder = Callable[[ProviderConfigSnapshot], IdentityProvider]


# ── Registry ─────────────────────────────────────────────────────────


@dataclass
class _CacheEntry:
    snapshot: ProviderConfigSnapshot
    instance: IdentityProvider
    expires_at: float


class ProviderRegistry:
    """Process-singleton DB-backed registry. Thread/event-loop safe
    around the cache map (single async lock; cache ops are O(1))."""

    def __init__(
        self,
        *,
        loader: ProviderConfigLoader,
        builders: dict[str, ProviderBuilder],
        ttl_seconds: int = 60,
    ):
        self._loader = loader
        self._builders = builders
        self._ttl = ttl_seconds
        self._cache: dict[str, _CacheEntry] = {}
        self._slug_index: dict[str, str] = {}   # slug -> id
        self._lock = asyncio.Lock()

    def _build(self, snap: ProviderConfigSnapshot) -> IdentityProvider:
        builder = self._builders.get(snap.kind)
        if builder is None:
            raise ProviderNotFound(f"no builder registered for kind={snap.kind!r}")
        return builder(snap)

    def _now(self) -> float:
        return time.monotonic()

    # ── Public API ──

    @staticmethod
    def _assert_usable(snap: ProviderConfigSnapshot, *, allow_draft: bool) -> None:
        """Both gates on whether a row may authenticate anybody.

        ``enabled`` was always checked here. ``lifecycle`` was not, which
        is how an unpublished draft came to be reachable at
        ``/auth/{slug}/login``. They belong together: each is an operator
        saying "not this one, not yet".
        """
        if not snap.enabled:
            raise ProviderDisabled(snap.id)
        if snap.lifecycle != "live" and not allow_draft:
            raise ProviderNotPublished(snap.id)

    async def get(
        self, provider_id: str, *, allow_draft: bool = False,
    ) -> IdentityProvider:
        """Return the materialised provider for ``provider_id``.

        Raises :class:`ProviderNotFound` when the row is missing,
        disabled, or still a draft. ``allow_draft`` is for the dry-run
        rehearsal, which exists precisely to exercise an unpublished
        provider and is gated by its own admin-minted cookie.
        """
        entry = self._cache.get(provider_id)
        if entry is not None and entry.expires_at > self._now():
            # Cached instances are re-checked rather than trusted: a
            # provider unpublished during the 60s TTL must stop
            # authenticating now, not a minute from now.
            self._assert_usable(entry.snapshot, allow_draft=allow_draft)
            return entry.instance
        async with self._lock:
            # Re-check after acquiring the lock to avoid duplicate
            # loads under contention.
            entry = self._cache.get(provider_id)
            if entry is not None and entry.expires_at > self._now():
                self._assert_usable(entry.snapshot, allow_draft=allow_draft)
                return entry.instance
            snap = await self._loader.get_by_id(provider_id)
            if snap is None:
                raise ProviderNotFound(provider_id)
            self._assert_usable(snap, allow_draft=allow_draft)
            instance = self._build(snap)
            self._cache[provider_id] = _CacheEntry(
                snapshot=snap,
                instance=instance,
                expires_at=self._now() + self._ttl,
            )
            self._slug_index[snap.slug] = snap.id
            return instance

    async def get_snapshot(
        self, provider_id: str, *, allow_draft: bool = False,
    ) -> ProviderConfigSnapshot:
        """Return the cached snapshot — useful when callers need the
        slug, display name, or linking policy without spinning up a
        provider instance (e.g. the login-page provider listing)."""
        # populates cache + raises if missing / disabled / unpublished
        await self.get(provider_id, allow_draft=allow_draft)
        return self._cache[provider_id].snapshot

    async def resolve_slug(self, slug: str, *, allow_draft: bool = False) -> str:
        """Convert a URL slug to the canonical provider_id. The slug
        index is populated lazily on first ``get()``; on cache miss
        we round-trip the loader so URLs work after a fresh restart.

        Refuses a disabled or draft row on the uncached path. The
        authoritative gate is ``get()`` — the slug index short-circuits
        this method, and every caller resolves then gets — but checking
        here too means a lookup never hands back the id of a row that
        may not authenticate anyone.
        """
        cached_id = self._slug_index.get(slug)
        if cached_id is not None:
            return cached_id
        async with self._lock:
            cached_id = self._slug_index.get(slug)
            if cached_id is not None:
                return cached_id
            snap = await self._loader.get_by_slug(slug)
            if snap is None:
                raise ProviderNotFound(slug)
            self._assert_usable(snap, allow_draft=allow_draft)
            instance = self._build(snap)
            self._cache[snap.id] = _CacheEntry(
                snapshot=snap, instance=instance,
                expires_at=self._now() + self._ttl,
            )
            self._slug_index[snap.slug] = snap.id
            return snap.id

    async def list_enabled(self) -> list[ProviderConfigSnapshot]:
        """Return the enabled provider snapshots backing the public catalog
        (``GET /api/v1/auth/providers``) and the login UI.

        These snapshots are NOT themselves public-safe: every
        ``ProviderConfigSnapshot.settings`` carries the fully DECRYPTED
        settings blob, ``client_secret`` and ``shared_secret`` included. The
        route is what makes the response safe — ``ProviderSummary`` has no
        settings field, and its ``config`` is filled from the ``_public_config``
        whitelist. Keep that boundary at the route; a single extra field on
        the response model would leak every IdP secret to an unauthenticated
        caller.
        """
        snaps = await self._loader.list_enabled()
        return [s for s in snaps if s.enabled]

    async def invalidate(self, provider_id: Optional[str] = None) -> None:
        """Drop one (or all) cached entries. Called by the admin CRUD
        endpoint after writes so operators see config changes
        immediately."""
        async with self._lock:
            if provider_id is None:
                self._cache.clear()
                self._slug_index.clear()
            else:
                entry = self._cache.pop(provider_id, None)
                if entry is not None:
                    self._slug_index.pop(entry.snapshot.slug, None)


# ── Singleton wiring ─────────────────────────────────────────────────


_REGISTRY: Optional[ProviderRegistry] = None


def configure_registry(registry: ProviderRegistry) -> None:
    """Install the process registry. Called once at app startup."""
    global _REGISTRY
    _REGISTRY = registry


def get_registry() -> ProviderRegistry:
    if _REGISTRY is None:
        raise RuntimeError(
            "ProviderRegistry not configured. Call configure_registry() "
            "at app startup (see backend/app/main.py)."
        )
    return _REGISTRY
