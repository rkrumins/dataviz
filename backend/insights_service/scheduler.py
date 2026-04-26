"""Scheduler task: finds due data sources and enqueues them to Redis.

Runs in every stats-service replica. Duplicate-enqueue protection comes
from the Redis ``SET NX`` dedup key — only one replica's XADD wins per
(ds_id, tick). Auto-creates a polling config for newly-discovered data
sources using operator-configured defaults.

This module also hosts the periodic stream-trim task — see
``run_trim_scheduler``. The trim cadence is independent of the main
poll tick because trimming is much cheaper than polling and only
needs to keep growth bounded over hours, not seconds.
"""
from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.config import resilience
from backend.app.db.engine import PoolRole, get_session_factory
from backend.app.db.models import (
    AssetDiscoveryCacheORM,
    DataSourcePollingConfigORM,
    DataSourceStatsORM,
    ProviderORM,
    WorkspaceDataSourceORM,
)

from .config import StatsServiceConfig
from .redis_streams import (
    XAUTOCLAIM_MIN_IDLE_MS,
    enqueue,
    trim_streams_by_minid,
    try_claim,
)
from .schemas import StatsJobEnvelope

logger = logging.getLogger(__name__)


# 1 hour default. Trim is cheap; the only reason not to run it more
# often is the small Redis EVAL cost of XPENDING + XTRIM per stream.
_TRIM_INTERVAL_SECS = float(os.getenv("INSIGHTS_TRIM_INTERVAL_SECS", "3600"))

# 24 hours default cutoff. Anything older that's still in PEL would
# already have been redelivered or DLQ'd many times over; if not, the
# PEL-freshness gate inside ``trim_streams_by_minid`` skips the trim
# anyway. Bounded below by 2× XAUTOCLAIM_MIN_IDLE_MS so a single
# redelivery cycle can't race the trim.
_TRIM_CUTOFF_AGE_MS = max(
    int(os.getenv("INSIGHTS_TRIM_CUTOFF_AGE_MS", str(24 * 60 * 60 * 1000))),
    2 * XAUTOCLAIM_MIN_IDLE_MS,
)


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


# ── Periodic stream trim ────────────────────────────────────────────

async def run_trim_scheduler(shutdown: asyncio.Event) -> None:
    """Periodic MINID-based trim of all jobs streams.

    Runs every ``INSIGHTS_TRIM_INTERVAL_SECS`` (default 1h). The trim
    helper is PEL-safe — see ``trim_streams_by_minid``. Failures here
    are logged and the loop continues; bounded growth is operationally
    important but not safety-critical (DLQ length and worker progress
    are surfaced separately via ``/health``).
    """
    logger.info(
        "Trim scheduler started (interval=%.0fs, cutoff_age_ms=%d)",
        _TRIM_INTERVAL_SECS, _TRIM_CUTOFF_AGE_MS,
    )
    while not shutdown.is_set():
        # Wait first so the very first trim doesn't fight a fresh
        # deploy still drying its consumer-group state.
        try:
            await asyncio.wait_for(shutdown.wait(), timeout=_TRIM_INTERVAL_SECS)
            return  # shutdown triggered while waiting
        except asyncio.TimeoutError:
            pass

        try:
            results = await trim_streams_by_minid(_TRIM_CUTOFF_AGE_MS)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.error("Trim tick failed: %s", exc, exc_info=True)
            continue

        for stream_name, result in results.items():
            if result.skipped:
                logger.info(
                    "trim_skipped stream=%s reason=%s",
                    stream_name, result.reason,
                )
            else:
                logger.info(
                    "trim_done stream=%s trimmed=%d",
                    stream_name, result.trimmed,
                )

    logger.info("Trim scheduler stopped")


# ── Discovery scheduler (background asset cache refresh) ────────────
#
# Refreshes ``asset_discovery_cache`` rows on a configured cadence so
# the UI is never the thing that drives discovery. The frontend just
# reads the cache; this scheduler keeps it warm. Eliminates the
# "Stale for X minutes" failure mode where UI polling is responsible
# for kicking refresh and a stalled worker leaves the cache wedged.


@dataclass(frozen=True)
class DiscoveryTickSummary:
    """One discovery scheduler pass — surfaced in tick log lines."""
    providers: int        # active providers we tried to refresh
    list_jobs: int        # successful list-all enqueues
    asset_jobs: int       # successful per-asset enqueues
    dedup_skipped: int    # enqueues blocked by an in-flight claim


# Module-level status. The /health snapshot and the discovery-status
# endpoint both read these — same pattern as ``_last_tick`` /
# ``_last_tick_at`` for the stats scheduler above.
_last_discovery_summary: Optional[DiscoveryTickSummary] = None
_last_discovery_tick_at: Optional[datetime] = None


def get_discovery_scheduler_status() -> dict:
    """JSON-friendly snapshot of the most recent discovery tick.

    Returned by the /health snapshot task and the
    ``GET /admin/insights/discovery/status`` endpoint. ``None`` values
    when the scheduler hasn't completed its first tick yet (during
    bootstrap delay or right after process start).
    """
    interval = resilience.DISCOVERY_REFRESH_INTERVAL_SECS
    if _last_discovery_summary is None or _last_discovery_tick_at is None:
        return {
            "last_tick_at": None,
            "interval_secs": interval,
            "next_tick_eta_secs": None,
            "providers": None,
            "list_jobs": None,
            "asset_jobs": None,
            "dedup_skipped": None,
        }
    age_secs = max(
        0,
        int((datetime.now(timezone.utc) - _last_discovery_tick_at).total_seconds()),
    )
    return {
        "last_tick_at": _last_discovery_tick_at.isoformat(),
        "interval_secs": interval,
        "next_tick_eta_secs": max(0, interval - age_secs),
        "providers": _last_discovery_summary.providers,
        "list_jobs": _last_discovery_summary.list_jobs,
        "asset_jobs": _last_discovery_summary.asset_jobs,
        "dedup_skipped": _last_discovery_summary.dedup_skipped,
    }


# Short delay before the first discovery tick so other services
# (DB pool, Redis, the worker's consumer-group setup) have a chance
# to settle. Without this, a fresh deploy fires a tick against a
# half-initialised stack and the first run looks broken in logs.
_DISCOVERY_BOOTSTRAP_DELAY_SECS = float(
    os.getenv("DISCOVERY_BOOTSTRAP_DELAY_SECS", "15"),
)


async def _discovery_tick() -> DiscoveryTickSummary:
    """Single discovery scheduler pass.

    Reads active providers + every cached row and enqueues a discovery
    refresh for each. Dedup is naturally handled by the SET NX claim
    inside ``enqueue_discovery_job_safe``; if a worker is already
    mid-job for ``(provider_id, asset_name)`` the call returns ``None``
    and we count it as ``dedup_skipped``.
    """
    # Lazy import: avoid circular module-graph at process start.
    from .enqueue import enqueue_discovery_job_safe

    factory = get_session_factory(PoolRole.READONLY)
    async with factory() as session:
        provider_rows = await session.execute(
            select(ProviderORM.id).where(ProviderORM.is_active.is_(True))
        )
        provider_ids = [row[0] for row in provider_rows.all()]

        cached_rows = await session.execute(
            select(
                AssetDiscoveryCacheORM.provider_id,
                AssetDiscoveryCacheORM.asset_name,
            )
        )
        cached_pairs: list[tuple[str, str]] = [
            (row[0], row[1]) for row in cached_rows.all()
        ]

    list_jobs = asset_jobs = dedup_skipped = 0

    # 1. List-all sentinel for every active provider — refreshes the
    #    "what assets exist on this provider" payload.
    for provider_id in provider_ids:
        msg_id = await enqueue_discovery_job_safe(provider_id, "")
        if msg_id is not None:
            list_jobs += 1
        else:
            dedup_skipped += 1

    # 2. Per-asset stats refresh for every row already in the cache.
    #    Skip the empty-string sentinel (already enqueued above).
    for provider_id, asset_name in cached_pairs:
        if not asset_name:
            continue
        msg_id = await enqueue_discovery_job_safe(provider_id, asset_name)
        if msg_id is not None:
            asset_jobs += 1
        else:
            dedup_skipped += 1

    return DiscoveryTickSummary(
        providers=len(provider_ids),
        list_jobs=list_jobs,
        asset_jobs=asset_jobs,
        dedup_skipped=dedup_skipped,
    )


async def trigger_discovery_tick_now() -> DiscoveryTickSummary:
    """Run one discovery tick immediately, updating module-level status.

    Used by the manual-trigger admin endpoint so operators can verify
    the scheduler wiring without waiting for the next cadence. Logs
    the same ``discovery_tick.complete`` line as a normal tick.
    """
    global _last_discovery_summary, _last_discovery_tick_at
    summary = await _discovery_tick()
    _last_discovery_summary = summary
    _last_discovery_tick_at = datetime.now(timezone.utc)
    logger.info(
        "discovery_tick.complete providers=%d list_jobs=%d "
        "asset_jobs=%d dedup_skipped=%d (manual_trigger=true)",
        summary.providers, summary.list_jobs,
        summary.asset_jobs, summary.dedup_skipped,
    )
    return summary


async def run_discovery_scheduler(shutdown: asyncio.Event) -> None:
    """Periodic background refresh of every provider's discovery cache.

    Cadence: ``DISCOVERY_REFRESH_INTERVAL_SECS`` (env, default 1800).

    Lifecycle: bootstrap-delay → first tick → wait-interval → tick → ...
    So a fresh deploy gets visible status within ~15 seconds (not 30
    minutes), but the bootstrap delay still gives DB / Redis / worker
    consumer-groups time to come up before the first tick fires.
    """
    global _last_discovery_summary, _last_discovery_tick_at

    interval = resilience.DISCOVERY_REFRESH_INTERVAL_SECS
    logger.info(
        "Discovery scheduler started (interval=%ds, bootstrap_delay=%.0fs)",
        interval, _DISCOVERY_BOOTSTRAP_DELAY_SECS,
    )

    # Bootstrap delay before the first tick.
    try:
        await asyncio.wait_for(
            shutdown.wait(), timeout=_DISCOVERY_BOOTSTRAP_DELAY_SECS,
        )
        return  # shutdown triggered during bootstrap
    except asyncio.TimeoutError:
        pass

    while not shutdown.is_set():
        # Tick first (so status is observable shortly after startup),
        # then wait the configured interval before the next.
        try:
            summary = await _discovery_tick()
            _last_discovery_summary = summary
            _last_discovery_tick_at = datetime.now(timezone.utc)
            logger.info(
                "discovery_tick.complete providers=%d list_jobs=%d "
                "asset_jobs=%d dedup_skipped=%d",
                summary.providers, summary.list_jobs,
                summary.asset_jobs, summary.dedup_skipped,
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.error("Discovery tick failed: %s", exc, exc_info=True)
            # Don't update status on failure — keep the last successful
            # snapshot so /health doesn't say "0 providers" right after
            # a transient blip.

        try:
            await asyncio.wait_for(shutdown.wait(), timeout=interval)
            return  # shutdown triggered during wait
        except asyncio.TimeoutError:
            continue

    logger.info("Discovery scheduler stopped")
