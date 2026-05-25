"""
AggregationScheduler — cron-like drift detection for aggregated data.

Runs periodic fingerprint checks for data sources with configured schedules.
When drift is detected, it updates the data source but does NOT automatically
re-aggregate — the user must confirm.

Uses AggregationDataSourceStateORM (aggregation schema) instead of
WorkspaceDataSourceORM (public schema) — fully decoupled.

Architecture: In-process via asyncio.create_task() on startup.
For K8s: extract to a standalone cron-job pod or use K8s CronJob.
"""
import asyncio
import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from sqlalchemy import and_, select, text

logger = logging.getLogger(__name__)

# Retention task cadence — runs at most once per this many seconds, so
# the per-minute scheduler tick doesn't hammer the table every minute.
_RETENTION_TICK_SECS = int(os.getenv("AGGREGATION_RETENTION_TICK_SECS", "3600"))
# Hard floor on retention age — operators can lift this via env, but a
# 0/negative value is treated as "disabled" rather than "delete
# everything" to avoid foot-guns.
_RETENTION_DAYS = int(os.getenv("AGGREGATION_JOBS_RETENTION_DAYS", "30"))


class AggregationScheduler:
    """Runs periodic change detection checks for data sources with configured schedules.

    Checks are non-blocking — drift detection never auto-triggers re-aggregation.
    """

    def __init__(self, session_factory: Any, registry: Any) -> None:
        self._session_factory = session_factory
        self._registry = registry
        self._running = False
        # Last wall-clock time the retention task ran. ``None`` means
        # "never run this process lifetime"; the first tick will fire
        # it. Subsequent ticks honour ``_RETENTION_TICK_SECS``.
        self._last_retention_at: Optional[datetime] = None

    async def start(self) -> None:
        """Called on application startup. Runs forever, checking schedules."""
        self._running = True
        logger.info("AggregationScheduler started")
        while self._running:
            try:
                await self._tick()
            except Exception as e:
                logger.error("Scheduler tick error: %s", e, exc_info=True)
            await asyncio.sleep(60)  # Check every minute for due schedules

    async def stop(self) -> None:
        """Gracefully stop the scheduler."""
        self._running = False

    async def _tick(self) -> None:
        """Check all data sources with aggregation_schedule set.

        For each due schedule:
        1. Compute current fingerprint
        2. Compare against stored fingerprint
        3. If changed: log drift detection (non-blocking)
        4. Only notify — never auto-trigger re-aggregation
        """
        from .models import AggregationDataSourceStateORM, AggregationJobORM
        from .fingerprint import compute_graph_fingerprint, fingerprints_match

        async with self._session_factory() as session:
            # Find data sources with schedules configured AND status = 'ready'
            # Uses aggregation-owned state table (no public schema dependency)
            result = await session.execute(
                select(AggregationDataSourceStateORM).where(
                    AggregationDataSourceStateORM.aggregation_schedule.isnot(None),
                    AggregationDataSourceStateORM.aggregation_status == "ready",
                )
            )

            # Per-provider timeout: prevent a slow/hung provider from
            # blocking the scheduler (and, by extension, the API event loop
            # when running in-process).
            _DRIFT_TIMEOUT = float(os.getenv("SCHEDULER_DRIFT_CHECK_TIMEOUT", "5"))

            for state in result.scalars():
                try:
                    provider = await asyncio.wait_for(
                        self._registry.get_provider_for_workspace(
                            state.workspace_id, session, data_source_id=state.data_source_id,
                        ),
                        timeout=_DRIFT_TIMEOUT,
                    )
                    current_fp = await asyncio.wait_for(
                        compute_graph_fingerprint(provider),
                        timeout=_DRIFT_TIMEOUT,
                    )

                    if not fingerprints_match(state.graph_fingerprint, current_fp):
                        logger.info(
                            "Drift detected for data source %s "
                            "(stored: %s, current: %s)",
                            state.data_source_id, state.graph_fingerprint, current_fp,
                        )
                        # Note: we do NOT change aggregation_status here.
                        # The frontend polls for drift via the readiness endpoint.
                        # The user decides whether to re-aggregate.
                except (asyncio.TimeoutError, Exception) as e:
                    logger.warning(
                        "Drift check failed for data source %s: %s",
                        state.data_source_id, e,
                    )

            # Stale-job watchdog — catch jobs stuck in 'running' with no
            # checkpoint update (e.g. worker died silently).
            job_timeout = int(os.getenv("AGGREGATION_JOB_TIMEOUT_SECS", "7200"))
            watchdog_cutoff = datetime.now(tz=timezone.utc) - timedelta(seconds=job_timeout * 2)

            stale_stmt = select(AggregationJobORM).where(
                and_(
                    AggregationJobORM.status == "running",
                    AggregationJobORM.updated_at < watchdog_cutoff.isoformat(),
                )
            )
            stale_result = await session.execute(stale_stmt)
            stale_jobs = stale_result.scalars().all()

            for stale_job in stale_jobs:
                elapsed = (datetime.now(tz=timezone.utc) - datetime.fromisoformat(stale_job.updated_at)).total_seconds()
                stale_job.status = "failed"
                stale_job.error_message = f"Watchdog timeout: no checkpoint update in {int(elapsed)}s"
                stale_job.updated_at = datetime.now(tz=timezone.utc).isoformat()
                logger.warning(
                    "Watchdog marked stale job %s as failed (no update in %ds)",
                    stale_job.id, int(elapsed),
                )
                # Update aggregation-owned state table
                state = await session.get(
                    AggregationDataSourceStateORM, stale_job.data_source_id,
                )
                if state:
                    state.aggregation_status = "failed"

            if stale_jobs:
                await session.commit()
                logger.info("Watchdog marked %d stale aggregation jobs as failed", len(stale_jobs))

        # Retention task — runs on a coarser cadence than the per-minute
        # tick. Uses its own session so a failure here can't roll back
        # the watchdog commit above.
        await self._maybe_run_retention()

    async def _maybe_run_retention(self) -> None:
        """Delete `aggregation_jobs` rows older than the configured
        retention window, while preserving the most recent completed
        job per data source (the skip-path lookup in
        ``worker._maybe_skip_unchanged`` depends on it).

        Honours ``AGGREGATION_RETENTION_TICK_SECS`` so the table isn't
        scanned every minute. A retention window ≤ 0 disables the task
        entirely — operators who want unbounded history (e.g. for an
        external audit warehouse) set
        ``AGGREGATION_JOBS_RETENTION_DAYS=0``.
        """
        if _RETENTION_DAYS <= 0:
            return
        now = datetime.now(tz=timezone.utc)
        if (
            self._last_retention_at is not None
            and (now - self._last_retention_at).total_seconds() < _RETENTION_TICK_SECS
        ):
            return
        self._last_retention_at = now
        cutoff_iso = (now - timedelta(days=_RETENTION_DAYS)).isoformat()

        # The DELETE preserves the most-recent completed row per data
        # source via a NOT EXISTS sub-query. We use raw SQL because the
        # set-correlated DISTINCT ON pattern is awkward to express via
        # the ORM and the table is in a fixed schema we control.
        stmt = text(
            """
            DELETE FROM aggregation.aggregation_jobs AS j
            WHERE j.completed_at IS NOT NULL
              AND j.completed_at < :cutoff
              AND NOT EXISTS (
                SELECT 1
                FROM aggregation.aggregation_jobs k
                WHERE k.data_source_id = j.data_source_id
                  AND k.status = 'completed'
                  AND k.completed_at = (
                    SELECT MAX(m.completed_at)
                    FROM aggregation.aggregation_jobs m
                    WHERE m.data_source_id = j.data_source_id
                      AND m.status = 'completed'
                  )
                  AND k.id = j.id
              )
            """
        )
        try:
            async with self._session_factory() as session:
                result = await session.execute(stmt, {"cutoff": cutoff_iso})
                await session.commit()
                deleted = getattr(result, "rowcount", -1) or 0
                if deleted > 0:
                    logger.info(
                        "Retention: deleted %d aggregation_jobs rows older than %d days "
                        "(latest per-data-source completed job preserved)",
                        deleted, _RETENTION_DAYS,
                    )
                else:
                    logger.debug(
                        "Retention: no aggregation_jobs rows older than %d days",
                        _RETENTION_DAYS,
                    )
        except Exception as exc:
            logger.warning(
                "Retention task failed (will retry next tick): %s", exc,
            )
