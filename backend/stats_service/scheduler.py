"""Scheduler task: finds due data sources and enqueues them to Redis.

Runs in every stats-service replica. Duplicate-enqueue protection comes
from the Redis ``SET NX`` dedup key — only one replica's XADD wins per
(ds_id, tick). Auto-creates a polling config for newly-discovered data
sources using operator-configured defaults.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.engine import PoolRole, get_session_factory
from backend.app.db.models import (
    DataSourcePollingConfigORM,
    DataSourceStatsORM,
    WorkspaceDataSourceORM,
)

from .config import StatsServiceConfig
from .redis_streams import enqueue, try_claim
from .schemas import StatsJobEnvelope

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class TickSummary:
    """What a single scheduler pass observed and did. Surfaced in logs
    and via ``get_scheduler_status()`` for the /health payload."""
    seen: int
    due: int
    enqueued: int
    skipped_dedup: int
    materialized: int


_last_tick: Optional[TickSummary] = None
_last_tick_at: Optional[datetime] = None


def get_scheduler_status() -> dict:
    """Return a JSON-friendly snapshot of the last tick for /health."""
    if _last_tick is None or _last_tick_at is None:
        return {"last_tick_at": None}
    return {"last_tick_at": _last_tick_at.isoformat(), **asdict(_last_tick)}


async def _materialize_config(
    session: AsyncSession,
    ds_id: str,
    default_interval_secs: int,
    min_interval_secs: int,
) -> DataSourcePollingConfigORM:
    """Create a polling config row if missing. Returns the row."""
    interval = max(default_interval_secs, min_interval_secs)
    config = DataSourcePollingConfigORM(
        data_source_id=ds_id,
        is_enabled=True,
        interval_seconds=interval,
    )
    session.add(config)
    await session.flush()
    logger.info("Created default polling config for data source %s (interval=%ds)", ds_id, interval)
    return config


def _is_due(config: DataSourcePollingConfigORM, now: datetime, min_interval_secs: int) -> bool:
    if not config.is_enabled:
        return False
    if not config.last_polled_at:
        return True
    try:
        last = datetime.fromisoformat(config.last_polled_at)
    except ValueError:
        # Corrupt timestamp — treat as due, we'll overwrite on success.
        return True
    interval = max(config.interval_seconds or 0, min_interval_secs)
    return (now - last).total_seconds() >= interval


async def _tick(config: StatsServiceConfig) -> TickSummary:
    """Single scheduler pass. Returns a summary of what was seen and done."""
    factory = get_session_factory(PoolRole.JOBS)
    seen = due = enqueued = skipped_dedup = materialized = 0
    now = datetime.now(timezone.utc)

    async with factory() as session:
        result = await session.execute(
            select(WorkspaceDataSourceORM, DataSourcePollingConfigORM)
            .join(
                DataSourcePollingConfigORM,
                WorkspaceDataSourceORM.id == DataSourcePollingConfigORM.data_source_id,
                isouter=True,
            )
            .where(WorkspaceDataSourceORM.is_active.is_(True))
        )
        rows = result.all()
        seen = len(rows)

        for ds, polling_config in rows:
            if polling_config is None:
                polling_config = await _materialize_config(
                    session, ds.id, config.default_interval_secs, config.min_interval_secs
                )
                materialized += 1

            if not _is_due(polling_config, now, config.min_interval_secs):
                continue
            due += 1

            claimed = await try_claim(ds.id, ttl_secs=config.dedup_ttl_secs)
            if not claimed:
                # Another replica already enqueued, or a previous job is
                # still in-flight. Silently skip.
                skipped_dedup += 1
                continue

            envelope = StatsJobEnvelope(
                data_source_id=ds.id,
                workspace_id=ds.workspace_id,
                enqueued_at=now,
            )
            msg_id = await enqueue(envelope.to_stream_fields())
            logger.info(
                "Enqueued stats job for ds=%s (workspace=%s, msg_id=%s)",
                ds.id, ds.workspace_id, msg_id,
            )
            enqueued += 1

        await session.commit()

    return TickSummary(
        seen=seen,
        due=due,
        enqueued=enqueued,
        skipped_dedup=skipped_dedup,
        materialized=materialized,
    )


async def run_scheduler(config: StatsServiceConfig, shutdown: asyncio.Event) -> None:
    """Scheduler coroutine — loops until shutdown is set."""
    logger.info(
        "Stats scheduler started (tick=%ss, default_interval=%ds, min_interval=%ds)",
        config.scheduler_tick_secs,
        config.default_interval_secs,
        config.min_interval_secs,
    )
    global _last_tick, _last_tick_at
    while not shutdown.is_set():
        try:
            summary = await _tick(config)
            _last_tick = summary
            _last_tick_at = datetime.now(timezone.utc)
            logger.info(
                "Scheduler tick: seen=%d due=%d enqueued=%d dedup_skipped=%d new_configs=%d",
                summary.seen, summary.due, summary.enqueued,
                summary.skipped_dedup, summary.materialized,
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.error("Scheduler tick failed: %s", exc, exc_info=True)

        try:
            await asyncio.wait_for(shutdown.wait(), timeout=config.scheduler_tick_secs)
        except asyncio.TimeoutError:
            continue

    logger.info("Stats scheduler stopped")


async def get_known_node_counts() -> dict[str, int]:
    """Return {ds_id: node_count} from the stats cache. Used by the
    worker to size poll timeouts. Read-only; safe on the READONLY pool."""
    factory = get_session_factory(PoolRole.READONLY)
    async with factory() as session:
        result = await session.execute(select(DataSourceStatsORM))
        return {row.data_source_id: (row.node_count or 0) for row in result.scalars()}
