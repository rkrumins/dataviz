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
# Consistency verifier cadence. Default 24h aligns with the
# operational guidance documented in verifier.py. <= 0 disables.
_VERIFIER_TICK_SECS = int(os.getenv("AGGREGATION_VERIFIER_TICK_SECS", "86400"))
# Per-tick sleep for the scheduler loop. Used to be hardcoded at 60s;
# now operator-tunable so deployments with tight drift-detection SLAs
# can dial it down (e.g. 15s) and quiet deployments can lift it (e.g.
# 300s) to cut wakeups. The whole tick is bounded — at this cadence the
# only cost is the drift loop iterating idle data sources.
_SCHEDULER_TICK_SECS = max(1, int(os.getenv("AGGREGATION_SCHEDULER_TICK_SECS", "60")))
# Watchdog cutoff for jobs stuck in status='pending'. A pending job
# that never reached 'running' usually means the trigger handler or
# skip-decision crashed mid-transaction. Default 10 min: large enough
# to absorb a slow trigger (provider warmup, lock contention) but
# small enough to flip a real crash before operators notice.
_PENDING_WATCHDOG_SECS = int(os.getenv("AGGREGATION_PENDING_WATCHDOG_SECS", "600"))


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
        # Last wall-clock time the consistency verifier ran. Same
        # debounce pattern as retention but on the verifier cadence.
        self._last_verifier_at: Optional[datetime] = None

    async def start(self) -> None:
        """Called on application startup. Runs forever, checking schedules."""
        self._running = True
        logger.info("AggregationScheduler started")
        while self._running:
            try:
                await self._tick()
            except Exception as e:
                logger.error("Scheduler tick error: %s", e, exc_info=True)
            await asyncio.sleep(_SCHEDULER_TICK_SECS)

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

            await self._run_watchdog(session)

        # Retention task — runs on a coarser cadence than the per-minute
        # tick. Uses its own session so a failure here can't roll back
        # the watchdog commit above.
        await self._maybe_run_retention()

        # Consistency verifier — runs on an even coarser cadence. The
        # safety net for the documented skip-path eventual-consistency
        # window. Failures emit metrics + log but never auto-rebuild.
        await self._maybe_run_consistency_verifier()

    async def _run_watchdog(self, session: Any) -> None:
        """Sweep aggregation_jobs for stuck rows and mark them failed.

        Two stuck states are covered:

          1. ``status='running'`` with no checkpoint update for
             ``AGGREGATION_JOB_TIMEOUT_SECS * 2`` — the original
             watchdog. Catches worker crashes mid-materialise.
          2. ``status='pending'`` older than
             ``AGGREGATION_PENDING_WATCHDOG_SECS`` — the P2-3 addition.
             Catches trigger / skip-decision crashes that left the row
             never transitioning to running; without this the data
             source would be permanently blocked (the trigger endpoint
             rejects new triggers while any pending/running job exists).

        Commits at most once per call; if both queries return empty
        the session is left untouched.
        """
        from .models import AggregationDataSourceStateORM, AggregationJobORM

        now = datetime.now(tz=timezone.utc)
        job_timeout = int(os.getenv("AGGREGATION_JOB_TIMEOUT_SECS", "7200"))
        running_cutoff = now - timedelta(seconds=job_timeout * 2)

        stale_stmt = select(AggregationJobORM).where(
            and_(
                AggregationJobORM.status == "running",
                AggregationJobORM.updated_at < running_cutoff.isoformat(),
            )
        )
        stale_jobs = (await session.execute(stale_stmt)).scalars().all()
        for stale_job in stale_jobs:
            elapsed = (now - datetime.fromisoformat(stale_job.updated_at)).total_seconds()
            stale_job.status = "failed"
            stale_job.error_message = (
                f"Watchdog timeout: no checkpoint update in {int(elapsed)}s"
            )
            stale_job.updated_at = now.isoformat()
            logger.warning(
                "Watchdog marked stale job %s as failed (no update in %ds)",
                stale_job.id, int(elapsed),
            )
            state = await session.get(
                AggregationDataSourceStateORM, stale_job.data_source_id,
            )
            if state:
                state.aggregation_status = "failed"

        pending_cutoff = now - timedelta(seconds=_PENDING_WATCHDOG_SECS)
        stuck_pending_stmt = select(AggregationJobORM).where(
            and_(
                AggregationJobORM.status == "pending",
                AggregationJobORM.created_at < pending_cutoff.isoformat(),
            )
        )
        stuck_pending = (await session.execute(stuck_pending_stmt)).scalars().all()
        for job in stuck_pending:
            elapsed = (now - datetime.fromisoformat(job.created_at)).total_seconds()
            job.status = "failed"
            job.error_message = (
                f"Watchdog: pending job never reached 'running' after {int(elapsed)}s "
                f"(likely trigger or skip-decision crash)"
            )
            job.updated_at = now.isoformat()
            logger.warning(
                "Watchdog marked stuck-pending job %s as failed (created %ds ago, "
                "never transitioned to running)", job.id, int(elapsed),
            )
            state = await session.get(
                AggregationDataSourceStateORM, job.data_source_id,
            )
            # Only clear DS state if it still reflects the crashed job
            # — don't stomp a state advanced by a subsequent run.
            if state and state.aggregation_status in ("pending", "running"):
                state.aggregation_status = "failed"

        if stale_jobs or stuck_pending:
            await session.commit()
            logger.info(
                "Watchdog marked %d stale + %d stuck-pending aggregation jobs as failed",
                len(stale_jobs), len(stuck_pending),
            )

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

    async def _maybe_run_consistency_verifier(self) -> None:
        """Run AggregationConsistencyVerifier against every ready data
        source on the configured cadence. Failures are alerts only —
        operators decide whether to issue a force-rebuild.

        Disabled when AGGREGATION_VERIFIER_TICK_SECS <= 0. The verifier
        itself has hard per-data-source and per-edge timeouts so a
        runaway query can't stall the scheduler loop.
        """
        if _VERIFIER_TICK_SECS <= 0:
            return
        now = datetime.now(tz=timezone.utc)
        if (
            self._last_verifier_at is not None
            and (now - self._last_verifier_at).total_seconds() < _VERIFIER_TICK_SECS
        ):
            return
        self._last_verifier_at = now

        from .verifier import verify_all_ready_data_sources

        try:
            results = await verify_all_ready_data_sources(
                session_factory=self._session_factory,
                registry=self._registry,
            )
            total_failed = sum(r.failed for r in results)
            total_sampled = sum(r.sampled for r in results)
            failed_ds = [r.data_source_id for r in results if r.failed > 0]
            if failed_ds:
                logger.warning(
                    "Consistency verifier completed across %d data sources: "
                    "%d/%d edges failed verification across %d data sources "
                    "(%s). Consider force_rebuild on affected sources.",
                    len(results), total_failed, total_sampled,
                    len(failed_ds), failed_ds[:10],
                )
            else:
                logger.info(
                    "Consistency verifier completed across %d data sources: "
                    "%d edges verified, 0 failures.",
                    len(results), total_sampled,
                )
        except Exception as exc:
            logger.warning(
                "Consistency verifier run failed (will retry next tick): %s",
                exc,
            )
