"""Scheduler task: finds due data sources and enqueues them to Redis.

Runs in every stats-service replica. Duplicate-enqueue protection comes
from the Redis ``SET NX`` dedup key — only one replica's XADD wins per
(ds_id, tick). Auto-creates a polling config for newly-discovered data
sources using operator-configured defaults.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

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


async def _tick(config: StatsServiceConfig) -> int:
    """Single scheduler pass. Returns the number of jobs enqueued."""
    factory = get_session_factory(PoolRole.JOBS)
    enqueued = 0
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

        for ds, polling_config in rows:
            if polling_config is None:
                polling_config = await _materialize_config(
                    session, ds.id, config.default_interval_secs, config.min_interval_secs
                )

            if not _is_due(polling_config, now, config.min_interval_secs):
                continue

            claimed = await try_claim(ds.id, ttl_secs=config.dedup_ttl_secs)
            if not claimed:
                # Another replica already enqueued, or a previous job is
                # still in-flight. Silently skip.
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

    return enqueued


async def run_scheduler(config: StatsServiceConfig, shutdown: asyncio.Event) -> None:
    """Scheduler coroutine — loops until shutdown is set."""
    logger.info(
        "Stats scheduler started (tick=%ss, default_interval=%ds, min_interval=%ds)",
        config.scheduler_tick_secs,
        config.default_interval_secs,
        config.min_interval_secs,
    )
    while not shutdown.is_set():
        try:
            enqueued = await _tick(config)
            if enqueued:
                logger.debug("Scheduler tick: enqueued %d job(s)", enqueued)
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
