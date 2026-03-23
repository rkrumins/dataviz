"""
Feature Flag Service — cached runtime evaluation of feature flags.

Usage in endpoints:
    from backend.app.services.feature_flags import feature_flags
    enabled = await feature_flags.is_enabled("announcementsEnabled", session)
    modes  = await feature_flags.get_value("allowedViewModes", session)

The service keeps an in-memory cache with a short TTL (default 30s) so that
repeated flag checks within the same request burst don't hit the DB every time.
Admin writes (PATCH) call invalidate() to bust the cache immediately.
"""
import json
import logging
import time
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import FeatureFlagsORM, FeatureDefinitionORM

logger = logging.getLogger(__name__)

_CACHE_TTL_SECONDS = 30.0


class FeatureFlagService:
    """Lightweight, cached feature flag evaluator."""

    def __init__(self, ttl: float = _CACHE_TTL_SECONDS):
        self._ttl = ttl
        self._cache: dict[str, Any] | None = None
        self._cache_version: int = 0
        self._cache_updated_at: str | None = None
        self._cache_ts: float = 0.0

    def invalidate(self) -> None:
        """Bust the cache (call after admin writes)."""
        self._cache = None
        self._cache_ts = 0.0

    async def _load(self, session: AsyncSession) -> dict[str, Any]:
        """Load merged flag values (defaults + stored config) from DB."""
        now = time.monotonic()
        if self._cache is not None and (now - self._cache_ts) < self._ttl:
            return self._cache

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

    @property
    def cached_version(self) -> int:
        return self._cache_version

    @property
    def cached_updated_at(self) -> str | None:
        return self._cache_updated_at


# Module-level singleton — shared across all requests in the same worker process.
feature_flags = FeatureFlagService()
