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

    def __init__(self, storage_uri: Optional[str] = None):
        self._storage = storage_from_string(_as_async_uri(storage_uri))
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
        from .api.router import _resolve_ratelimit_storage_uri

        _account_limiter = AccountRateLimiter(_resolve_ratelimit_storage_uri())
    return _account_limiter


def reset_account_limiter_for_tests() -> None:
    """Drop the cached instance so a test can rebuild it under new env."""
    global _account_limiter
    _account_limiter = None
