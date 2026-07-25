"""Auth-service-side accessor for the platform SSO posture.

The DB-backed truth lives at ``backend.app.db.repositories.app_auth_config_repo``;
this module exposes the small Protocol the auth_service calls through
(``AuthConfigProvider``), the matching DTO (``AuthConfigSnapshot``),
and a TTL-cached default implementation the app injects at startup.

Keeping the consumer surface in the auth_service module preserves
the isolation rule (``auth_service`` cannot import
``backend.app.*``) — the app wires the actual repo call in
``main.py``.
"""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Awaitable, Callable, Optional, Protocol


@dataclass(frozen=True)
class AuthConfigSnapshot:
    """The denormalised auth-posture view consumed by login / refresh
    / complete_sso_login. Field shape MUST stay aligned with
    ``backend.app.db.repositories.app_auth_config_repo.AuthConfigSnapshot``."""
    sso_enabled: bool
    allow_local_login: bool
    allow_jit_provisioning: bool
    version: int
    updated_at: str
    # Trails the required fields (and the repo mirror's ordering) only
    # because a dataclass cannot put a defaulted field before a bare one;
    # the default keeps existing keyword construction working.
    email_first_login: bool = False


# All-true default used when the loader has never been called or
# when the loader raises (defensive: a transient DB blip shouldn't
# lock the whole auth flow).
_DEFAULTS = AuthConfigSnapshot(
    sso_enabled=True,
    allow_local_login=True,
    allow_jit_provisioning=True,
    version=0,
    updated_at="",
    email_first_login=False,
)


class AuthConfigProvider(Protocol):
    """Injected at app startup. ``main.py`` wires a default
    :class:`CachedAuthConfigProvider` whose loader hits
    ``app_auth_config_repo.get_snapshot`` inside a fresh session.

    Tests pass a thin lambda that returns whatever snapshot the test
    case needs."""

    async def get(self) -> AuthConfigSnapshot: ...

    async def invalidate(self) -> None: ...


class CachedAuthConfigProvider:
    """TTL-cached provider. ``loader`` is an async callable returning
    the current :class:`AuthConfigSnapshot` (usually a session-scoped
    repo call). Cache TTL is 30s by default — short enough that admin
    PATCH effects show up quickly, long enough that the per-request
    cost stays near zero. Mutations call :meth:`invalidate` for
    immediate consistency."""

    def __init__(
        self,
        loader: Callable[[], Awaitable[AuthConfigSnapshot]],
        *,
        ttl_seconds: int = 30,
    ):
        self._loader = loader
        self._ttl = ttl_seconds
        self._cache: Optional[AuthConfigSnapshot] = None
        self._cache_at: float = 0.0
        self._lock = asyncio.Lock()

    def _now(self) -> float:
        return time.monotonic()

    async def get(self) -> AuthConfigSnapshot:
        snap = self._cache
        if snap is not None and (self._now() - self._cache_at) < self._ttl:
            return snap
        async with self._lock:
            snap = self._cache
            if snap is not None and (self._now() - self._cache_at) < self._ttl:
                return snap
            try:
                snap = await self._loader()
            except Exception:  # noqa: BLE001 — defensive fallback
                snap = self._cache or _DEFAULTS
            self._cache = snap
            self._cache_at = self._now()
            return snap

    async def invalidate(self) -> None:
        async with self._lock:
            self._cache = None
            self._cache_at = 0.0


class StaticAuthConfigProvider:
    """Test helper. Returns the wrapped snapshot verbatim."""

    def __init__(self, snapshot: AuthConfigSnapshot = _DEFAULTS):
        self._snapshot = snapshot

    async def get(self) -> AuthConfigSnapshot:
        return self._snapshot

    async def invalidate(self) -> None:
        return None


__all__ = [
    "AuthConfigSnapshot",
    "AuthConfigProvider",
    "CachedAuthConfigProvider",
    "StaticAuthConfigProvider",
]
