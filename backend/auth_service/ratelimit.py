"""Per-account rate limiting.

The request limiter in ``api/router.py`` keys on the client address.
That is a flood guard, not a brute-force control, and behind a NAT or an
ingress it is barely even that: every user shares one address, so a cap
tight enough to stop an attacker also stops an office, and an attacker
with a handful of addresses walks past it either way.

This module is the other half. It keys on the **account being attacked**
rather than the address attacking it, so a password spray against one
user is bounded no matter how many hosts it comes from, and a busy
tenant behind one egress IP is never affected by its neighbours.

Storage is shared with the request limiter — the same Redis when one is
configured, in-process memory otherwise. The in-memory fallback is
per-worker and therefore weaker, which is acceptable for the same reason
it is acceptable there: losing the limiter costs a window of extra
attempts, not a lockout, and a deployment that cares has Redis.

Keys are a truncated SHA-256 of the normalised identifier rather than
the identifier itself, so the store never holds a list of the tenant's
email addresses.
"""
from __future__ import annotations

import hashlib
import logging
import os
from typing import Optional

from limits import RateLimitItem, parse
from limits.aio.strategies import MovingWindowRateLimiter
from limits.storage import storage_from_string

logger = logging.getLogger(__name__)

# ``limits`` selects the async backend from an ``async+`` scheme prefix.
# The request limiter's URI is the sync form (slowapi drives it
# synchronously), so the same Redis has to be re-addressed here rather
# than reused verbatim — without the prefix this gets a sync storage the
# async strategy cannot await.
_ASYNC_SCHEME_PREFIX = "async+"


def _as_async_uri(uri: Optional[str]) -> str:
    if not uri:
        return "async+memory://"
    if uri.startswith(_ASYNC_SCHEME_PREFIX):
        return uri
    return f"{_ASYNC_SCHEME_PREFIX}{uri}"


def resolve_storage(role: str = "streams") -> tuple[Optional[str], dict]:
    """Where rate-limit counters live: ``(uri, storage_options)``.

    ``RATELIMIT_STORAGE_URI`` wins when set. Otherwise this resolves the
    endpoint through ``backend.common.adapters.redis_endpoint``, the same
    central resolver the revocation service and the providers use.

    Going through the resolver rather than reading ``REDIS_URL`` is not
    tidiness. Production replaces the in-cluster Redis with two
    Memorystore instances addressed by role-prefixed vars, each with its
    own AUTH password and TLS CA, and *blanks* ``REDIS_URL`` on purpose
    so no stale coordinate survives the overlay merge. A limiter reading
    ``REDIS_URL`` therefore finds nothing in production and silently
    falls back to per-process memory — which is exactly the per-worker
    counting the shared store exists to eliminate, restored in the one
    environment that needs it most, and invisible because the limiter
    swallows storage errors.

    Rate limits belong on the STREAMS (coordination) endpoint: ADR-020
    and the launch-scale spec both list rate-limit alongside locks and
    revocation there, and the revocation service already resolves the
    same role.

    ``backend.common`` is not ``backend.app``, so this import respects
    the auth_service isolation rule (``test_auth_service_isolation``).
    """
    override = os.getenv("RATELIMIT_STORAGE_URI")
    if override:
        return override, {}

    try:
        from backend.common.adapters.redis_endpoint import (
            RedisRole,
            resolve_redis_config,
        )

        cfg = resolve_redis_config(RedisRole(role))
    except Exception as exc:  # noqa: BLE001
        logger.warning("Rate-limit storage could not be resolved: %s", exc)
        return None, {}

    # The resolver always answers — with ``localhost`` when nothing is
    # configured — and it records where each field came from. "Nobody
    # configured a Redis" and "somebody configured localhost" are
    # different situations, and only the provenance distinguishes them.
    # Treating the default as real points tests and Redis-less dev at a
    # port with nothing behind it, which costs a connection attempt per
    # request to reach the same answer in-process memory gives for free.
    if cfg.source.get("host", "default") == "default":
        return None, {}

    if cfg.mode == "sentinel":
        nodes = ",".join(f"{h}:{p}" for h, p in cfg.sentinel_nodes)
        if not nodes or not cfg.sentinel_master:
            return None, {}
        uri = f"redis+sentinel://{nodes}/{cfg.sentinel_master}/{cfg.db}"
    elif cfg.host:
        uri = f"redis://{cfg.host}:{cfg.port}/{cfg.db}"
    else:
        return None, {}

    options: dict = {}
    if cfg.username:
        options["username"] = cfg.username
    if cfg.password:
        options["password"] = cfg.password
    if cfg.tls.enabled:
        # limits passes these straight to redis-py.
        uri = uri.replace("redis://", "rediss://", 1)
        options["ssl_cert_reqs"] = cfg.tls.cert_reqs
        if cfg.tls.ca_certs:
            options["ssl_ca_certs"] = cfg.tls.ca_certs
        if cfg.tls.certfile:
            options["ssl_certfile"] = cfg.tls.certfile
        if cfg.tls.keyfile:
            options["ssl_keyfile"] = cfg.tls.keyfile
    return uri, options


def describe_storage(uri: Optional[str]) -> str:
    """One line for the startup log.

    Falling back to memory is a real degradation — per-worker counters
    across every replica — and it is otherwise completely silent,
    because the limiter swallows storage errors by design. Saying so at
    boot is the difference between an operator knowing and not.
    """
    if not uri:
        return "in-memory (PER WORKER — limits are not shared across replicas)"
    # Never log credentials; the netloc can carry them.
    scheme, _, rest = uri.partition("://")
    return f"{scheme}://{rest.rsplit('@', 1)[-1]}"


def _bucket_key(scope: str, identity: str) -> str:
    digest = hashlib.sha256(identity.strip().lower().encode("utf-8")).hexdigest()
    return f"acct:{scope}:{digest[:32]}"


class AccountRateLimiter:
    """Moving-window limiter keyed on an account identifier.

    A moving window rather than a fixed one on purpose: a fixed window
    lets an attacker spend the whole allowance at the end of one window
    and again at the start of the next, which doubles the real rate at
    exactly the boundary an attacker can find by watching for the reset.
    """

    def __init__(self, storage_uri: Optional[str] = None, storage_options: Optional[dict] = None):
        self._storage = storage_from_string(
            _as_async_uri(storage_uri), **(storage_options or {}),
        )
        self._limiter = MovingWindowRateLimiter(self._storage)

    async def check(self, scope: str, identity: str, limit: str) -> bool:
        """True when another attempt is allowed. Does not consume one.

        Fails **open** on a storage error. A limiter that cannot reach
        Redis must not become a login outage — the per-IP limit and
        argon2's own cost still apply, and the alternative is that a
        cache blip locks every account in the tenant.
        """
        try:
            return await self._limiter.test(parse(limit), _bucket_key(scope, identity))
        except Exception as exc:  # noqa: BLE001
            logger.warning("Account rate-limit check failed (%s): %s", scope, exc)
            return True

    async def record(self, scope: str, identity: str, limit: str) -> None:
        """Consume one attempt."""
        try:
            await self._limiter.hit(parse(limit), _bucket_key(scope, identity))
        except Exception as exc:  # noqa: BLE001
            logger.warning("Account rate-limit record failed (%s): %s", scope, exc)

    async def reset(self, scope: str, identity: str, limit: str) -> None:
        """Forget an account's attempts — called on a successful sign-in.

        This is what keeps the limit off legitimate users: only failures
        accumulate, and one success clears them.

        The limit string is required because the storage key is derived
        from the parsed item, not from the bucket name — clearing the
        bare bucket silently does nothing, which is a no-op that looks
        exactly like a working reset until someone is locked out after
        signing in successfully.
        """
        try:
            await self._storage.clear(
                parse(limit).key_for(_bucket_key(scope, identity))
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("Account rate-limit reset failed (%s): %s", scope, exc)

    async def retry_after_seconds(
        self, scope: str, identity: str, limit: str,
    ) -> int:
        """Seconds until the window frees up, for the ``Retry-After`` header."""
        try:
            item: RateLimitItem = parse(limit)
            reset_at, _ = await self._limiter.get_window_stats(
                item, _bucket_key(scope, identity),
            )
            import time

            return max(1, int(reset_at - time.time()))
        except Exception:  # noqa: BLE001
            return 60


_account_limiter: Optional[AccountRateLimiter] = None


def get_account_limiter() -> AccountRateLimiter:
    """Process-wide limiter, built on first use."""
    global _account_limiter
    if _account_limiter is None:
        uri, options = resolve_storage()
        _account_limiter = AccountRateLimiter(uri, options)
    return _account_limiter


def reset_account_limiter_for_tests() -> None:
    """Drop the cached instance so a test can rebuild it under new env."""
    global _account_limiter
    _account_limiter = None
