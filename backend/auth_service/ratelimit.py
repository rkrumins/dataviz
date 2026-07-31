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

# The prefix does more than pick sync vs async: the async Redis storage
# also picks a CLIENT LIBRARY, and its default is ``coredis`` — which
# this image does not ship and has no reason to. The sync storage that
# slowapi drives accepts redis-py, which is why the per-IP limiter kept
# working in production while this one raised ConfigurationError from its
# constructor and turned every login into a 500.
#
# ``redispy`` is redis-py's own asyncio client, already a declared
# dependency (``redis>=8.0.1``) and the same library revocation, the
# providers and the streams adapter use. Pinning it here keeps one Redis
# client in the image and means a ``limits`` upgrade that changes the
# default cannot quietly reintroduce a driver we do not install.
_ASYNC_REDIS_IMPLEMENTATION = "redispy"

# Where the limiter lands when the configured storage cannot be built.
# Weaker (per-worker counters) but functional, which is the whole point:
# the fallback exists so a storage problem degrades the control instead
# of denying authentication.
_FALLBACK_URI = "async+memory://"


def _as_async_uri(uri: Optional[str]) -> str:
    if not uri:
        return _FALLBACK_URI
    if uri.startswith(_ASYNC_SCHEME_PREFIX):
        return uri
    return f"{_ASYNC_SCHEME_PREFIX}{uri}"


def _storage_kwargs(async_uri: str, storage_options: Optional[dict]) -> dict:
    """Constructor kwargs for *async_uri*.

    ``implementation`` only means anything to the Redis-backed storages.
    ``MemoryStorage`` happens to swallow unknown kwargs today, but that
    is incidental — relying on it would make an unrelated ``limits``
    change break the fallback that exists to catch breakage.
    """
    kwargs = dict(storage_options or {})
    if "redis" in async_uri.partition("://")[0]:
        kwargs["implementation"] = _ASYNC_REDIS_IMPLEMENTATION
    return kwargs


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


def _redact(text: str, uri: Optional[str], options: Optional[dict]) -> str:
    """Strip anything secret out of a message we are about to log.

    Storage errors from ``limits`` quote the URI they were given —
    ``ConfigurationError(f"unknown storage scheme : {storage_string}")``
    — and that string carries ``user:password@`` when the resolver put
    credentials there. Interpolating the exception verbatim therefore
    writes the Redis password into the log at ERROR, on the one code
    path that is guaranteed to run in a misconfigured production.

    So the failing URI is replaced with its redacted form, and any
    credential passed through ``storage_options`` is masked too, rather
    than trusting that the library never echoes one back.
    """
    if uri:
        text = text.replace(uri, describe_storage(uri))
        text = text.replace(_as_async_uri(uri), describe_storage(uri))
    for key in ("password", "username"):
        secret = (options or {}).get(key)
        if isinstance(secret, str) and secret:
            text = text.replace(secret, f"<{key}>")
    return text


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
        requested = _as_async_uri(storage_uri)
        try:
            self._storage = storage_from_string(
                requested, **_storage_kwargs(requested, storage_options),
            )
            self.backend = requested.partition("://")[0].removeprefix(
                _ASYNC_SCHEME_PREFIX
            )
        except Exception as exc:  # noqa: BLE001
            # Every method below fails open on a storage error, for the
            # reason stated on ``check``: a limiter that cannot reach
            # Redis must not become a login outage. Construction was the
            # one place that did not, so a storage that could not be
            # BUILT — a driver ``limits`` defaults to and we do not ship,
            # a bad TLS path, a typo in RATELIMIT_STORAGE_URI, an option
            # a future version rejects — raised through the endpoint and
            # 500'd every sign-in attempt in the tenant.
            #
            # ERROR rather than WARNING: unlike a transient Redis blip,
            # this does not heal on its own and the limiter stays
            # per-worker until someone acts on it.
            logger.error(
                "Account rate-limit storage %s could not be built (%s: %s); "
                "falling back to in-memory. Per-account limits are now "
                "PER WORKER and not shared across replicas.",
                describe_storage(storage_uri),
                type(exc).__name__,
                _redact(str(exc), storage_uri, storage_options),
            )
            self._storage = storage_from_string(_FALLBACK_URI)
            self.backend = "memory (FELL BACK)"
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
