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
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.config import resilience
from backend.app.db.engine import get_jobs_session, get_readonly_session
from backend.app.db.models import (
    AssetDiscoveryCacheORM,
    DataSourcePollingConfigORM,
    DataSourceStatsORM,
    ProviderORM,
    WorkspaceDataSourceORM,
)

from .config import StatsServiceConfig
from .redis_streams import (
    STATS_DEEP_STREAM,
    XAUTOCLAIM_MIN_IDLE_MS,
    enqueue,
    trim_streams_by_minid,
    try_claim,
)
from .schemas import StatsDeepJobEnvelope, StatsJobEnvelope

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
    deep_due: int = 0
    deep_enqueued: int = 0


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


def _is_deep_due(
    config: DataSourcePollingConfigORM,
    schema_updated_at: Optional[str],
    now: datetime,
    min_interval_secs: int,
) -> bool:
    """Deep-facet due-ness is driven by ``data_source_stats.schema_updated_at``
    (stamped only by a completed deep poll), not the polling config's
    ``last_polled_at`` (which the cheap counts facet owns)."""
    if not config.is_enabled:
        return False
    if not schema_updated_at:
        return True
    try:
        last = datetime.fromisoformat(schema_updated_at)
    except ValueError:
        return True
    interval = max(config.interval_seconds or 0, min_interval_secs)
    return (now - last).total_seconds() >= interval


def _claim_ttl(config: StatsServiceConfig, node_count: Optional[int]) -> int:
    """Size-aware dedup-claim TTL: ``clamp(2 × poll timeout, 180, dedup_ttl)``.

    The flat 1200s TTL meant a crashed worker blocked re-enqueue for up
    to 20 minutes even for a 2-second small-graph poll. Sizing by the
    resolved poll timeout keeps the duplicate-poll protection for large
    graphs while small graphs (the common case) recover in ≤3 minutes.
    """
    timeout = config.resolve_poll_timeout(int(node_count or 0))
    return int(max(180, min(2 * timeout, config.dedup_ttl_secs)))


async def _tick(config: StatsServiceConfig) -> TickSummary:
    """Single scheduler pass. Routes each active data source to up to
    two job kinds: a cheap counts poll (``stats_poll``, due off the
    polling config) and a deep schema poll (``stats_deep``, due off
    ``data_source_stats.schema_updated_at``). Returns a summary."""
    seen = due = enqueued = skipped_dedup = materialized = 0
    deep_due = deep_enqueued = 0
    now = datetime.now(timezone.utc)

    async with get_jobs_session() as session:
        result = await session.execute(
            select(
                WorkspaceDataSourceORM,
                DataSourcePollingConfigORM,
                DataSourceStatsORM.node_count,
                DataSourceStatsORM.schema_updated_at,
            )
            .join(
                DataSourcePollingConfigORM,
                WorkspaceDataSourceORM.id == DataSourcePollingConfigORM.data_source_id,
                isouter=True,
            )
            .join(
                DataSourceStatsORM,
                WorkspaceDataSourceORM.id == DataSourceStatsORM.data_source_id,
                isouter=True,
            )
            # Without the deleted_at filter this service keeps polling a deleted
            # data source forever — hitting the provider, refreshing its stats and
            # re-materialising its polling config below (resurrection).
            .where(WorkspaceDataSourceORM.is_active.is_(True))
            .where(WorkspaceDataSourceORM.deleted_at.is_(None))
        )
        rows = result.all()
        seen = len(rows)

        for ds, polling_config, node_count, schema_updated_at in rows:
            if polling_config is None:
                polling_config = await _materialize_config(
                    session, ds.id, config.default_interval_secs, config.min_interval_secs
                )
                materialized += 1

            ttl = _claim_ttl(config, node_count)

            if _is_due(polling_config, now, config.min_interval_secs):
                due += 1
                if await try_claim(ds.id, ttl_secs=ttl):
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
                else:
                    # Another replica already enqueued, or a previous job
                    # is still in-flight. Silently skip.
                    skipped_dedup += 1

            if _is_deep_due(polling_config, schema_updated_at, now, config.min_interval_secs):
                deep_due += 1
                if await try_claim(ds.id, ttl_secs=ttl, stream=STATS_DEEP_STREAM):
                    deep_envelope = StatsDeepJobEnvelope(
                        data_source_id=ds.id,
                        workspace_id=ds.workspace_id,
                        enqueued_at=now,
                    )
                    msg_id = await enqueue(
                        deep_envelope.to_stream_fields(), stream=STATS_DEEP_STREAM,
                    )
                    logger.info(
                        "Enqueued deep stats job for ds=%s (workspace=%s, msg_id=%s)",
                        ds.id, ds.workspace_id, msg_id,
                    )
                    deep_enqueued += 1
                else:
                    skipped_dedup += 1

    return TickSummary(
        seen=seen,
        due=due,
        enqueued=enqueued,
        skipped_dedup=skipped_dedup,
        materialized=materialized,
        deep_due=deep_due,
        deep_enqueued=deep_enqueued,
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
                "Scheduler tick: seen=%d due=%d enqueued=%d deep_due=%d "
                "deep_enqueued=%d dedup_skipped=%d new_configs=%d",
                summary.seen, summary.due, summary.enqueued,
                summary.deep_due, summary.deep_enqueued,
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


async def get_due_backlog() -> dict:
    """SQL-derived staleness gauges for /health: how many enabled
    sources are past their poll interval, and how far the most overdue
    one is. Independent of the Redis stream metrics — this is the
    detector for stale-forever rows when stream depths look healthy
    (or after a Redis flush wiped the queues)."""
    now = datetime.now(timezone.utc)
    async with get_readonly_session() as session:
        rows = (
            (await session.execute(select(DataSourcePollingConfigORM)))
            .scalars()
            .all()
        )
    backlog = 0
    oldest_overdue_secs = 0
    for cfg in rows:
        if not cfg.is_enabled:
            continue
        if not cfg.last_polled_at:
            backlog += 1
            continue
        try:
            last = datetime.fromisoformat(cfg.last_polled_at)
        except ValueError:
            backlog += 1
            continue
        interval = max(cfg.interval_seconds or 0, 60)
        overdue = (now - last).total_seconds() - interval
        if overdue > 0:
            backlog += 1
            oldest_overdue_secs = max(oldest_overdue_secs, int(overdue))
    return {"due_backlog": backlog, "oldest_overdue_secs": oldest_overdue_secs}


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

        # Piggyback the purge reconcile on the trim cadence — both are
        # hourly-scale hygiene passes.
        try:
            requeued = await _reconcile_stuck_purges()
            if requeued:
                logger.warning(
                    "purge_reconcile: requeued %d stuck purge job(s)", requeued,
                )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.error("purge_reconcile failed: %s", exc, exc_info=True)

        # Counts-history retention rides the same tick but keeps its own
        # cadence gate, so retention can be tuned without changing how often
        # Redis housekeeping runs.
        try:
            await _maybe_purge_count_history()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.error("history_purge failed: %s", exc, exc_info=True)

        try:
            await _maybe_evaluate_count_alerts()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.error("alert_sweep failed: %s", exc, exc_info=True)

    logger.info("Trim scheduler stopped")


# ── counts-history retention ────────────────────────────────────────

# Cadence gate for the history purge, checked on each trim tick. Its own
# knob rather than the trim interval: one is Redis housekeeping, the other
# is how long an audit trail is kept, and an operator tuning the second
# should not have to think about the first.
_HISTORY_PURGE_INTERVAL_SECS = float(
    resilience.INSIGHTS_HISTORY_PURGE_INTERVAL_SECS
)

# Rows deleted per pass. Matches refresh_token_gc's batch: big enough that
# a backlog drains in a few ticks, small enough that no single statement
# holds a long lock on a hot table.
_HISTORY_PURGE_BATCH = 5000

_history_purge_state: dict = {
    "last_run_monotonic": 0.0,
    "last_run_at": None,
    "last_by_age": 0,
    "last_over_cap": 0,
    "last_error": None,
}


def get_history_purge_status() -> dict:
    """Last history-purge outcome, for the /health payload. Mirrors
    ``get_discovery_scheduler_status()``'s shape."""
    return {
        "last_run_at": _history_purge_state["last_run_at"],
        "last_by_age": _history_purge_state["last_by_age"],
        "last_over_cap": _history_purge_state["last_over_cap"],
        "last_error": _history_purge_state["last_error"],
        "interval_secs": _HISTORY_PURGE_INTERVAL_SECS,
    }


async def _maybe_purge_count_history() -> None:
    """Purge ``data_source_count_snapshots`` by age and per-source cap.

    Never raises — the caller logs, but a retention pass failing is not worth
    interrupting stream hygiene for, and the next tick retries. Idempotent: a
    second pass over a clean table deletes nothing.

    Batched, and deliberately NOT drained in a loop here: a very large backlog
    (a retention window shortened from 90 days to 7, say) drains over
    successive ticks instead of holding one long transaction against a table
    the counts path is actively writing to.
    """
    from backend.app.db.repositories import stats_history_repo

    now = time.monotonic()
    last = _history_purge_state["last_run_monotonic"]
    if last and (now - last) < _HISTORY_PURGE_INTERVAL_SECS:
        return
    _history_purge_state["last_run_monotonic"] = now

    async with get_jobs_session() as session:
        policy = await stats_history_repo.resolve_history_policy(session)
        result = await stats_history_repo.purge_snapshots(
            session, policy, batch=_HISTORY_PURGE_BATCH,
        )
        await session.commit()

    _history_purge_state["last_run_at"] = datetime.now(timezone.utc).isoformat()
    _history_purge_state["last_by_age"] = result["by_age"]
    _history_purge_state["last_over_cap"] = result["over_cap"]
    _history_purge_state["last_error"] = None
    if result["by_age"] or result["over_cap"]:
        logger.info(
            "history_purge: removed %d by age (>%dd) and %d over cap (>%d/source)",
            result["by_age"], policy.retention_days,
            result["over_cap"], policy.max_rows_per_source,
        )


# A purge row stuck at pending/running with no update for this long has
# lost its stream message (Redis flush, DLQ'd without terminal write, or
# a crashed worker whose claim expired without redelivery). 30 minutes
# sits far above any legitimate purge checkpoint cadence.
_PURGE_RECONCILE_STALE_SECS = float(os.getenv("PURGE_RECONCILE_STALE_SECS", "1800"))


async def _reconcile_stuck_purges() -> int:
    """Re-enqueue purge jobs wedged at ``pending``/``running``.

    The durable ``aggregation_jobs`` row is the source of truth — a
    wiped Redis stream message must not leave the row (and its 409
    duplicate-purge guard) stuck forever. Idempotent: the purge handler
    skips terminal rows and its MATCH...DELETE is safe to repeat.
    """
    from backend.app.services.aggregation.models import AggregationJobORM

    from .enqueue import enqueue_purge_job_force

    cutoff = (
        datetime.now(timezone.utc) - timedelta(seconds=_PURGE_RECONCILE_STALE_SECS)
    ).isoformat()
    async with get_readonly_session() as session:
        rows = (
            await session.execute(
                select(
                    AggregationJobORM.id,
                    AggregationJobORM.data_source_id,
                    AggregationJobORM.workspace_id,
                ).where(
                    AggregationJobORM.trigger_source == "purge",
                    AggregationJobORM.status.in_(("pending", "running")),
                    AggregationJobORM.updated_at < cutoff,
                )
            )
        ).all()

    requeued = 0
    for job_id, ds_id, ws_id in rows:
        msg_id = await enqueue_purge_job_force(job_id, ds_id, ws_id or "")
        if msg_id:
            requeued += 1
            logger.warning("purge_reconcile.requeued job_id=%s ds=%s", job_id, ds_id)
    return requeued


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


# When true (default), the background sweep's per-asset stats refresh
# is limited to REGISTERED assets (those with a catalog entry) — the
# ones users actually monitor. Unregistered assets refresh on demand
# only: their rows serve from cache while stale and self-heal (hot
# lane) when someone views them past the 7-day absolute expiry. Cuts
# the sweep's standing provider load from every-cached-asset to
# what's-actually-in-use.
_SWEEP_REGISTERED_ONLY = (
    os.getenv("DISCOVERY_SWEEP_REGISTERED_ONLY", "true").lower()
    in ("1", "true", "yes", "on")
)


async def _discovery_tick() -> DiscoveryTickSummary:
    """Single discovery scheduler pass.

    Enqueues a list-all refresh per active provider, plus per-asset
    stats refreshes for registered assets (all cached assets when
    ``DISCOVERY_SWEEP_REGISTERED_ONLY=false``). Dedup is naturally
    handled by the SET NX claim inside ``enqueue_discovery_job_safe``;
    if a worker is already mid-job for ``(provider_id, asset_name)``
    the call returns ``None`` and we count it as ``dedup_skipped``.
    """
    # Lazy import: avoid circular module-graph at process start.
    from .enqueue import enqueue_discovery_job_safe

    from backend.app.db.models import CatalogItemORM

    async with get_readonly_session() as session:
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

        registered: set[tuple[str, str]] | None = None
        if _SWEEP_REGISTERED_ONLY:
            reg_rows = await session.execute(
                select(CatalogItemORM.provider_id, CatalogItemORM.source_identifier)
            )
            registered = {
                (row[0], row[1]) for row in reg_rows.all() if row[1]
            }

    list_jobs = asset_jobs = dedup_skipped = 0

    # 1. List-all sentinel for every active provider — refreshes the
    #    "what assets exist on this provider" payload.
    for provider_id in provider_ids:
        msg_id = await enqueue_discovery_job_safe(provider_id, "")
        if msg_id is not None:
            list_jobs += 1
        else:
            dedup_skipped += 1

    # 2. Per-asset stats refresh. Skip the empty-string sentinel
    #    (already enqueued above) and, by default, unregistered assets.
    for provider_id, asset_name in cached_pairs:
        if not asset_name:
            continue
        if registered is not None and (provider_id, asset_name) not in registered:
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


# ── counts-anomaly alerting ─────────────────────────────────────────

# How often movements are judged. Its own knob, separate from the purge and
# from the trim: how quickly you learn about an anomaly is a different
# question from how long the evidence is kept.
_ALERT_INTERVAL_SECS = float(resilience.INSIGHTS_ALERT_INTERVAL_SECS)

_alert_sweep_state: dict = {
    "last_run_monotonic": 0.0,
    "last_run_at": None,
    "last_scanned": 0,
    "last_raised": 0,
    "last_error": None,
}


def get_alert_sweep_status() -> dict:
    """Last alert-sweep outcome, for the /health payload. An evaluator that
    silently stopped running looks exactly like a quiet fleet, which is the
    worst possible failure for an alerting system — so it reports itself."""
    return {
        "last_run_at": _alert_sweep_state["last_run_at"],
        "last_scanned": _alert_sweep_state["last_scanned"],
        "last_raised": _alert_sweep_state["last_raised"],
        "last_error": _alert_sweep_state["last_error"],
        "interval_secs": _ALERT_INTERVAL_SECS,
    }


async def _maybe_evaluate_count_alerts() -> None:
    """Judge recent movements and raise at most one alert per source.

    Notifications fire AFTER the commit that records the alerts, in their own
    transaction — the discipline the reconcile sweep already documents: a
    best-effort fan-out over another domain's tables must never be able to
    roll back (or, on Postgres, poison) the findings it describes.

    Never raises; the caller logs and the next tick retries. A pass that dies
    halfway leaves the alerts it already committed and re-judges the rest,
    which the per-source cooldown makes safe to repeat.
    """
    from backend.app.db.repositories import count_alerts_repo

    now = time.monotonic()
    last = _alert_sweep_state["last_run_monotonic"]
    if last and (now - last) < _ALERT_INTERVAL_SECS:
        return
    _alert_sweep_state["last_run_monotonic"] = now

    notices: list = []
    scanned = 0
    async with get_jobs_session() as session:
        policy = await count_alerts_repo.resolve_alert_policy(session)
        if not policy.enabled:
            _alert_sweep_state["last_run_at"] = datetime.now(timezone.utc).isoformat()
            _alert_sweep_state["last_scanned"] = 0
            _alert_sweep_state["last_raised"] = 0
            return

        for ds_id in await count_alerts_repo.sources_to_evaluate(session):
            scanned += 1
            try:
                notice = await count_alerts_repo.evaluate_source(
                    session, ds_id, policy,
                )
                # Commit as soon as an alert lands, not once at the end. Most
                # sources produce nothing, so this is rare — and it bounds what
                # a later failure can cost to the source being judged, instead
                # of the whole pass.
                if notice is not None:
                    await session.commit()
                    notices.append(notice)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                # One unreadable source must not cost the rest of the fleet its
                # pass — but `continue` alone is not enough on Postgres, where
                # a failed statement poisons the transaction until it is rolled
                # back and every subsequent flush would fail too. Roll back,
                # then carry on.
                logger.warning("alert_sweep: %s could not be judged: %s", ds_id, exc)
                try:
                    await session.rollback()
                except Exception:  # noqa: BLE001 - already in the failure path
                    logger.warning("alert_sweep: rollback after %s failed", ds_id)
                    break
                continue

    if notices:
        from backend.app.db.repositories.notification_repo import (
            notify_counts_anomaly,
        )
        try:
            async with get_jobs_session() as session:
                for notice in notices:
                    await notify_counts_anomaly(
                        session,
                        workspace_id=notice.workspace_id,
                        data_source_id=notice.data_source_id,
                        catalog_item_id=notice.catalog_item_id,
                        provider_name=notice.provider_name,
                        source_name=notice.source_name,
                        severity=notice.severity,
                        direction=notice.direction,
                        node_delta=notice.node_delta,
                        node_count=notice.node_count,
                    )
                await session.commit()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning(
                "alert_sweep: notification fan-out failed (%s) — the alerts "
                "themselves are committed and readable", exc,
            )

    _alert_sweep_state["last_run_at"] = datetime.now(timezone.utc).isoformat()
    _alert_sweep_state["last_scanned"] = scanned
    _alert_sweep_state["last_raised"] = len(notices)
    _alert_sweep_state["last_error"] = None
    if notices:
        logger.info(
            "alert_sweep: %d source(s) scanned, %d alert(s) raised",
            scanned, len(notices),
        )
