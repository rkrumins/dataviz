"""
Feature Flag Service — cached runtime evaluation of feature flags.

Usage in endpoints:
    from backend.app.services.feature_flags import feature_flags
    enabled = await feature_flags.is_enabled("announcementsEnabled", session)
    modes  = await feature_flags.get_value("allowedViewModes", session)

The service keeps an in-memory cache with a short TTL (default 30s) so that
repeated flag checks within the same request burst don't hit the DB every time.
Admin writes (PATCH) call invalidate() to bust the cache immediately, and, once
committed, announce() to move the flags' generation in Redis (``features:gen``).
A cache still fresh by its TTL asks Redis at most every two seconds whether the
generation moved, and reloads when it has: a switch flipped in one process is
seen by every other within about two seconds. With Redis out of reach, the TTL
is the bound, as before.
"""
import asyncio
import json
import logging
import time
from typing import Any, Callable

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import FeatureFlagsORM, FeatureDefinitionORM

logger = logging.getLogger(__name__)

_CACHE_TTL_SECONDS = 30.0
#: How often a cache still fresh by its TTL asks Redis whether a save moved the flags' generation.
_GEN_CHECK_SECONDS = 2.0
#: The Redis key every committed save of the flags moves (:meth:`FeatureFlagService.announce`).
GEN_KEY = "features:gen"
#: The longest a generation read, and a move, wait on Redis.
_GEN_WAIT_SECONDS = 0.2
_ANNOUNCE_WAIT_SECONDS = 0.5


def _bus():
    """The Redis the generation lives on: the coordination bus the settings' generation uses."""
    from backend.app.services.aggregation.redis_client import get_redis

    return get_redis()


class FeatureDisabledError(Exception):
    """A write was attempted against a feature an admin has turned off.

    Raised outside the API layer (e.g. the versioned write-through provider) so
    non-HTTP callers get a typed error; the API maps it to 403 ``feature_disabled``
    via a global exception handler in ``main.py``.
    """

    def __init__(self, feature: str, message: str | None = None):
        self.feature = feature
        self.message = message or f"The '{feature}' feature is turned off for this deployment."
        super().__init__(self.message)


class FeatureFlagService:
    """Lightweight, cached feature flag evaluator."""

    def __init__(self, ttl: float = _CACHE_TTL_SECONDS, *, redis: Callable[[], Any] = _bus,
                 clock: Callable[[], float] = time.monotonic):
        self._ttl = ttl
        self._redis = redis
        self._clock = clock
        self._cache: dict[str, Any] | None = None
        self._cache_version: int = 0
        self._cache_updated_at: str | None = None
        self._cache_ts: float = 0.0
        # The generation the cache was loaded at (None: not known, so only the TTL ages it), and
        # when it was last compared with the one in Redis.
        self._cache_gen: str | None = None
        self._gen_checked_at: float = 0.0

    def invalidate(self) -> None:
        """Bust the cache (call after admin writes)."""
        self._cache = None
        self._cache_ts = 0.0
        self._cache_gen = None

    async def _generation(self) -> str | None:
        """The flags' generation in Redis ("" before any save moved it); None when Redis can't say."""
        try:
            gen = await asyncio.wait_for(self._redis().get(GEN_KEY), timeout=_GEN_WAIT_SECONDS)
        except Exception:  # noqa: BLE001 — without Redis, the TTL bounds how stale a flag gets
            return None
        if isinstance(gen, bytes):
            gen = gen.decode()
        return "" if gen is None else str(gen)

    async def announce(self) -> bool:
        """Move the flags' generation in Redis, once a save has committed, so every process reads
        it within two seconds. Best effort: False when Redis can't take it, and the other processes
        then see the save within their TTL."""
        try:
            await asyncio.wait_for(self._redis().incr(GEN_KEY), timeout=_ANNOUNCE_WAIT_SECONDS)
            return True
        except Exception:  # noqa: BLE001 — a save never fails over it
            logger.info("feature flags: the generation could not be moved", exc_info=True)
            return False

    async def _fresh(self) -> bool:
        """Whether the cache may answer: loaded less than the TTL ago and — asked of Redis at most
        every two seconds — with no save elsewhere having moved the flags' generation since."""
        now = self._clock()
        if self._cache is None or (now - self._cache_ts) >= self._ttl:
            return False
        if self._cache_gen is None or (now - self._gen_checked_at) < _GEN_CHECK_SECONDS:
            return True
        self._gen_checked_at = now
        gen = await self._generation()
        if gen is not None and gen != self._cache_gen:
            self.invalidate()
            return False
        return True

    async def _load(self, session: AsyncSession) -> dict[str, Any]:
        """Load merged flag values (defaults + stored config) from DB."""
        if await self._fresh():
            return self._cache
        now = self._clock()
        # Read before the flags, so a save committed after it moves it again and is reloaded. A
        # service that never trusts its cache (ttl 0) has no use for it.
        gen = await self._generation() if self._ttl > 0 else None

        # Load defaults from definitions
        defs_result = await session.execute(
            select(FeatureDefinitionORM.key, FeatureDefinitionORM.default_value)
            .where(FeatureDefinitionORM.deprecated == False)  # noqa: E712
        )
        defaults: dict[str, Any] = {}
        for key, raw_default in defs_result:
            try:
                defaults[key] = json.loads(raw_default)
            except (json.JSONDecodeError, TypeError):
                defaults[key] = raw_default

        # Load stored config
        row_result = await session.execute(
            select(FeatureFlagsORM).where(FeatureFlagsORM.id == 1)
        )
        row = row_result.scalar_one_or_none()

        values = dict(defaults)
        if row and row.config:
            stored = json.loads(row.config)
            for k, v in stored.items():
                if k in values:
                    values[k] = v
            self._cache_version = getattr(row, "version", 0)
            self._cache_updated_at = row.updated_at
        else:
            self._cache_version = 0
            self._cache_updated_at = None

        self._cache = values
        self._cache_ts = now
        self._cache_gen, self._gen_checked_at = gen, now
        return values

    async def get_all(self, session: AsyncSession) -> dict[str, Any]:
        """Return all current flag values (merged defaults + stored)."""
        return dict(await self._load(session))

    async def get_value(self, key: str, session: AsyncSession, default: Any = None) -> Any:
        """Return the value of a single flag, or *default* if the key doesn't exist."""
        values = await self._load(session)
        return values.get(key, default)

    async def is_enabled(self, key: str, session: AsyncSession, default: bool = False) -> bool:
        """Check if a boolean flag is enabled. Returns *default* if key missing."""
        val = await self.get_value(key, session, default=default)
        return bool(val)

    async def is_enabled_self_session(self, key: str, default: bool = False) -> bool:
        """Flag check for call sites OUTSIDE a request-scoped session (router-level
        gates on hot paths, provider backstops).

        Cache-first: while the TTL cache is fresh this never touches the DB or the
        connection pool; only a stale cache opens one short-lived session to reload.
        """
        if await self._fresh():
            return bool(self._cache.get(key, default))
        from backend.app.db.engine import get_async_session
        async with get_async_session() as session:
            return await self.is_enabled(key, session, default=default)

    async def get_value_self_session(self, key: str, default: Any = None) -> Any:
        """``get_value`` for call sites outside a request-scoped session.

        The non-boolean sibling of :meth:`is_enabled_self_session`, for
        single-select flags where "on/off" is not the question — the caller
        needs the chosen option, not its truthiness. Same cache-first
        behaviour: a fresh TTL cache never touches the DB.
        """
        if await self._fresh():
            return self._cache.get(key, default)
        from backend.app.db.engine import get_async_session
        async with get_async_session() as session:
            return await self.get_value(key, session, default=default)

    @property
    def cached_version(self) -> int:
        return self._cache_version

    @property
    def cached_updated_at(self) -> str | None:
        return self._cache_updated_at


# Module-level singleton — shared across all requests in the same worker process.
feature_flags = FeatureFlagService()
