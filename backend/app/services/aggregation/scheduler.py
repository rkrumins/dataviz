"""
AggregationScheduler — cron-like drift detection for aggregated data.

Runs periodic fingerprint checks for data sources with configured schedules.
When drift is detected, it calls AggregationService.signal_source_changed
(reason="drift") — the change-gated invalidate+rebuild entry point — as a
backstop for external writers that bypass the app's own write paths, unless
AGGREGATION_DRIFT_AUTO_REBUILD=false, in which case it only notifies (no
auto-rebuild; the historic behavior). The same pass reconciles sources left
marked stale (aggstale:v1) by a rebuild the cooldown deferred or a prior
attempt that failed, re-signaling each with reason="reconcile". This is
schedule-tick-driven only, never read-path-driven — read-path auto-heal was
removed after it caused backfill storms (commit 110cd431).

Uses AggregationDataSourceStateORM (aggregation schema) instead of
WorkspaceDataSourceORM (public schema) — fully decoupled.

Architecture: In-process via asyncio.create_task() on startup.
For K8s: extract to a standalone cron-job pod or use K8s CronJob.
"""
import asyncio
import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import and_, select

logger = logging.getLogger(__name__)

# Gates both the act-on-drift signal and the stale-marker reconciler
# (Task 4). ``signal_source_changed`` is the single choke point for the
# change gate and rebuild cooldown — this flag only controls whether the
# scheduler CALLS it; off preserves the historic notify-only sweep exactly.
# The ENV default is canonical in service.py (so ``get_settings`` reports the
# same fallback the tick resolves against); a persisted global cadence
# overrides it per tick. Kept as a module-level name here so tests can
# monkeypatch ``scheduler._DRIFT_AUTO_REBUILD`` and the tick reads it live.
from .service import AGGREGATION_DRIFT_AUTO_REBUILD as _DRIFT_AUTO_REBUILD


async def _recently_failed(session: Any, state: Any, interval_secs: int) -> bool:
    """True when ``state``'s most recent aggregation job is 'failed' and
    landed within ``interval_secs`` ago (H2 reconciler backoff, spec §9b).

    The state row itself carries no failure timestamp — aggregation_status
    flips to "failed" with no companion write (worker._update_ds_state),
    and last_aggregated_at only ever moves on success — so this reads the
    latest job row instead, the same lookup ``assemble_source_freshness``
    uses for failure surfacing. Migration-free: reuses
    ``AggregationJobORM.updated_at``, set in the worker's ``finally`` block
    on every terminal status including failure.
    """
    if interval_secs <= 0 or state is None:
        return False
    from .models import AggregationJobORM

    try:
        row = (await session.execute(
            select(AggregationJobORM.status, AggregationJobORM.updated_at)
            .where(AggregationJobORM.data_source_id == state.data_source_id)
            # NULLS LAST: a freshly-created (pending) job has updated_at=NULL,
            # which Postgres ranks FIRST on DESC (SQLite ranks it last) — pin
            # both engines to "latest updated row wins, never a NULL".
            .order_by(AggregationJobORM.updated_at.desc().nullslast())
            .limit(1)
        )).first()
    except Exception:
        # Never-raise: a lookup hiccup must fail OPEN toward the
        # pre-H2 behavior (proceed to signal) rather than silently
        # freezing this source's reconcile via the caller's catch-all.
        logger.warning(
            "stale-marker reconcile: failure-backoff lookup failed for "
            "%s — not backing off", state.data_source_id, exc_info=True,
        )
        return False
    if row is None or row[0] != "failed" or not row[1]:
        return False
    try:
        failed_at = datetime.fromisoformat(row[1])
    except (TypeError, ValueError):
        return False
    if failed_at.tzinfo is None:
        failed_at = failed_at.replace(tzinfo=timezone.utc)
    elapsed = (datetime.now(timezone.utc) - failed_at).total_seconds()
    return elapsed < interval_secs


class AggregationScheduler:
    """Runs periodic change detection checks for data sources with configured schedules.

    Drift detection auto-queues a change-gated rebuild via
    ``AggregationService.signal_source_changed`` (reason="drift") unless
    ``AGGREGATION_DRIFT_AUTO_REBUILD=false``, in which case checks stay
    non-blocking and notify-only (the historic behavior). The same flag
    also gates the marker reconciler, which re-signals (reason="reconcile")
    sources left marked stale by a deferred or failed rebuild. Repeat-fire
    is bounded: a source's status flips out of 'ready' while a job runs
    (the sweep skips it), the fingerprint-embedded idempotency key
    collapses repeat triggers, and an active-job conflict is a no-op.
    """

    def __init__(
        self, session_factory: Any, registry: Any, redis_client: Any = None,
    ) -> None:
        self._session_factory = session_factory
        self._registry = registry
        # Job-bus Redis handle. Its presence means the lock-aware
        # reconciler is the liveness authority, so this scheduler's
        # coarse mark-failed watchdog stands down (see _tick).
        self._redis = redis_client
        self._running = False

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
        3. If changed: log drift detection, collect the ds_id
        4. After the sweep: signal_source_changed(reason="drift") for each
           collected id, then reconcile any aggstale:v1-marked sources
           (reason="reconcile") — both gated by AGGREGATION_DRIFT_AUTO_REBUILD
        """
        from .models import AggregationDataSourceStateORM, AggregationJobORM
        from .fingerprint import compute_graph_fingerprint, fingerprints_match
        from .service import (
            get_active_service,
            read_global_cadence,
            resolve_rebuild_interval,
        )
        from backend.app.services.graph_cache import (
            clear_source_stale,
            get_source_stale_reason,
            list_stale_sources,
        )

        async with self._session_factory() as session:
            # F9: resolve the persisted global cadence ONCE per tick (cached
            # in-process, so the 60s cadence never hammers the DB). The
            # drift-auto flag and every cooldown pre-check below resolve
            # through it — persisted value when set, env default otherwise.
            cadence = await read_global_cadence(session)
            drift_auto = (
                cadence.drift_auto_rebuild
                if cadence.drift_auto_rebuild is not None
                else _DRIFT_AUTO_REBUILD
            )
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

            # Drifted ds_ids are acted on AFTER this loop completes (see
            # below) — a slow/failing signal must never block the sweep
            # from checking the remaining sources.
            drifted_ids: list[str] = []

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
                        #
                        # I1: a source already carrying a stale marker had its
                        # full invalidation at the first signal; the reconciler
                        # below owns its re-signal cadence (cooldown-aware).
                        # Re-signaling it on the drift path would re-invalidate
                        # every 60s tick — leave it out of drifted_ids so the
                        # reconciler picks it up instead. (Guarded by the flag:
                        # when off, drifted_ids is never consumed, so the marker
                        # lookup would be pointless work.)
                        if drift_auto and await get_source_stale_reason(
                            state.workspace_id, state.data_source_id,
                        ):
                            continue
                        drifted_ids.append(state.data_source_id)
                except (asyncio.TimeoutError, Exception) as e:
                    logger.warning(
                        "Drift check failed for data source %s: %s",
                        state.data_source_id, e,
                    )

            # R1 — act on detected drift + R1b — reconcile marked-stale
            # sources. Both are the backstop for external writers that
            # never call signal_source_changed directly; the signal itself
            # re-runs the change gate and rebuild cooldown, so nothing here
            # duplicates that timing logic. Gated by AGGREGATION_DRIFT_AUTO_
            # REBUILD — off preserves the notify-only sweep above exactly.
            if drift_auto:
                svc = get_active_service()
                if svc is not None:
                    for ds_id in drifted_ids:
                        try:
                            async with self._session_factory() as s2:
                                await svc.signal_source_changed(
                                    ds_id, s2, reason="drift", origin="drift",
                                )
                        except Exception as exc:
                            logger.warning(
                                "drift auto-rebuild signal failed for "
                                "data source %s: %s", ds_id, exc,
                            )

                    # Reconciler: sources a cooldown deferred or a failed
                    # rebuild left marked stale. Dedupe against this tick's
                    # drift signals (already handled above) and bound the
                    # pass so a large backlog can't stampede the job queue.
                    _MAX_STALE_RECONCILE_PER_TICK = 50
                    stale_pairs = await list_stale_sources()
                    to_reconcile = [
                        (ws, ds) for ws, ds in stale_pairs if ds not in drifted_ids
                    ]
                    if len(to_reconcile) > _MAX_STALE_RECONCILE_PER_TICK:
                        logger.info(
                            "stale-marker reconcile: %d marker(s) exceed the "
                            "per-tick cap (%d); processing the first %d, "
                            "remainder picked up next tick",
                            len(to_reconcile), _MAX_STALE_RECONCILE_PER_TICK,
                            _MAX_STALE_RECONCILE_PER_TICK,
                        )
                    for ws, ds in to_reconcile[:_MAX_STALE_RECONCILE_PER_TICK]:
                        try:
                            async with self._session_factory() as s2:
                                # I1: don't re-signal while a rebuild is already
                                # in flight or the cooldown is still open. Load
                                # the state row (fresh session) and defer when:
                                #   * a rebuild is in flight — the state row says
                                #     "pending" for the whole job lifetime (the
                                #     listener's "running" goes to the public
                                #     mirror, not this row; matched here only as
                                #     futureproofing) — its job.completed clears
                                #     the marker + writes the fresh fingerprint, so
                                #     re-signaling now only re-invalidates (gen
                                #     bump + ancestors-cache clear the rebuild
                                #     worker itself consumes) and then hits
                                #     ConflictError, every tick for the whole job
                                #     duration; OR
                                #   * we're inside the rebuild cooldown window; OR
                                #   * H2: the last rebuild attempt FAILED within
                                #     this same cadence window — without this a
                                #     permanently-failing source (e.g. OOMing a
                                #     strained store) gets re-signaled every tick
                                #     forever. The marker is kept either way, so
                                #     the source still surfaces as needs-attention.
                                state = await s2.get(
                                    AggregationDataSourceStateORM, ds,
                                )
                                interval_secs = resolve_rebuild_interval(
                                    getattr(state, "rebuild_min_interval_secs", None),
                                    cadence.rebuild_min_interval_secs,
                                )
                                if state is not None and (
                                    state.aggregation_status in ("pending", "running")
                                    or svc._within_rebuild_cooldown(state, interval_secs)
                                ):
                                    logger.debug(
                                        "stale-marker reconcile: %s in-flight/"
                                        "cooldown — deferring", ds,
                                    )
                                    continue
                                if (
                                    state is not None
                                    and state.aggregation_status == "failed"
                                    and await _recently_failed(s2, state, interval_secs)
                                ):
                                    logger.debug(
                                        "stale-marker reconcile: %s failed "
                                        "recently (< %ds cadence) — backing off",
                                        ds, interval_secs,
                                    )
                                    continue
                                resp = await svc.signal_source_changed(
                                    ds, s2, reason="reconcile", origin="reconcile",
                                )
                            if not resp.changed:
                                # No real change (the marker was stale from
                                # a prior deferral that later reverted, or
                                # never should have fired) — clear it so it
                                # can't ping the reconciler forever.
                                await clear_source_stale(ws, ds)
                        except Exception as exc:
                            logger.warning(
                                "stale-marker reconcile failed for %s/%s: %s",
                                ws, ds, exc,
                            )

            # Stale-job watchdog — catch jobs stuck in 'running' with no
            # checkpoint update (e.g. worker died silently). NO-REDIS
            # FALLBACK ONLY: with a job-bus Redis the lock-aware
            # reconciler owns liveness (exec-lock absent ⇒ auto-RESUME
            # from last_cursor), and the worker's stall watchdog kills
            # wedged-but-locked jobs — this coarse sweep would only turn
            # a resumable crash into a terminal 'failed'.
            if self._redis is not None:
                return
            job_timeout = int(os.getenv("AGGREGATION_JOB_TIMEOUT_SECS", "7200"))
            watchdog_cutoff = datetime.now(tz=timezone.utc) - timedelta(seconds=job_timeout * 2)

            stale_stmt = select(AggregationJobORM).where(
                and_(
                    AggregationJobORM.status == "running",
                    AggregationJobORM.updated_at < watchdog_cutoff.isoformat(),
                    # Purge rows checkpoint via Redis only (their PG row
                    # moves at start/end) — sweeping them here hijacked
                    # every >4h purge to 'failed' mid-flight.
                    AggregationJobORM.trigger_source != "purge",
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
