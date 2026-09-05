"""
AggregationScheduler — cron-like drift detection for aggregated data.

Runs periodic fingerprint checks for data sources with configured schedules.
When drift is detected, it calls AggregationService.signal_source_changed
(reason="drift") — the change-gated invalidate+rebuild entry point — as a
backstop for external writers that bypass the app's own write paths, unless
③ Act (the persisted cadence's driftAutoRebuild, env fallback
AGGREGATION_DRIFT_AUTO_REBUILD) is off. The same pass reconciles sources
left marked stale (aggstale:v1) by a rebuild the cooldown deferred or a prior
attempt that failed, re-signaling each with reason="reconcile" (a marker
means a rebuild was already requested) — held back by every operator hold
(③ Act off is a fleet-wide stop, see holds.py) and BOUNDED: after a failed
or cancelled job the retries stop at the reconciliation breaker cap and the
source is stamped ``suspended`` until a person resumes it. This is
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

# A job that ended in one of these leaves its stale marker in place, and the
# reconciler retries the source — bounded by the reconciliation breaker (see
# ``_reconcile_stale_markers``). A cancel is a person stopping THAT job, not
# automation; it is retried like a failure, with the same backoff and cap.
_RETRY_AFTER = ("failed", "cancelled")


async def _recently_failed(session: Any, state: Any, interval_secs: int) -> bool:
    """True when ``state``'s most recent aggregation job is 'failed' (or
    'cancelled') and landed within ``interval_secs`` ago (H2 reconciler
    backoff, spec §9b).

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
    if row is None or row[0] not in _RETRY_AFTER or not row[1]:
        return False
    try:
        failed_at = datetime.fromisoformat(row[1])
    except (TypeError, ValueError):
        return False
    if failed_at.tzinfo is None:
        failed_at = failed_at.replace(tzinfo=timezone.utc)
    elapsed = (datetime.now(timezone.utc) - failed_at).total_seconds()
    return elapsed < interval_secs


async def _suspend(session: Any, state: Any, ds: str) -> None:
    """Trip the breaker for a marked source whose automatic retries are used
    up: stamp the sweeper's own ``suspended`` verdict — so the "Needs a
    person" chip, the suspended tile and ``resetBreaker`` all apply unchanged
    — and ring the bell the sweeper rings. The stamp is committed first; the
    notice is best-effort and never fails the tick."""
    state.drift_state = "suspended"
    await session.commit()
    try:
        from backend.app.db.models import WorkspaceDataSourceORM
        from backend.app.db.repositories.notification_repo import (
            notify_reconcile_suspended,
        )

        row = await session.get(WorkspaceDataSourceORM, ds)
        await notify_reconcile_suspended(
            session,
            workspace_id=state.workspace_id,
            data_source_id=ds,
            source_name=getattr(row, "label", None) or ds,
        )
        await session.commit()
    except Exception as exc:
        logger.warning(
            "stale-marker reconcile: suspension notice for %s failed (%s) — "
            "the suspended state itself is committed", ds, exc,
        )


class AggregationScheduler:
    """Runs periodic change detection checks for data sources with configured schedules.

    Drift detection auto-queues a change-gated rebuild via
    ``AggregationService.signal_source_changed`` (reason="drift") unless
    ③ Act (``driftAutoRebuild``) is off, in which case checks stay
    non-blocking and notify-only. The marker reconciler re-signals
    (reason="reconcile") sources left marked stale by a deferred or failed
    rebuild — a marker means a rebuild was already requested — but it
    honours every operator hold (③ Act off is a fleet-wide stop) and stops
    retrying after the breaker cap, stamping the source ``suspended``.
    Repeat-fire is bounded: a source's status flips out of 'ready' while a job runs
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
           collected id (gated by ③ Act), then reconcile any
           aggstale:v1-marked sources (reason="reconcile"), subject to the
           holds and the breaker (_reconcile_stale_markers)
        """
        from .models import AggregationDataSourceStateORM, AggregationJobORM
        from .fingerprint import compute_graph_fingerprint, fingerprints_match
        from .service import (
            get_active_service, read_global_cadence, resolve_drift_auto_rebuild,
        )
        from backend.app.services.graph_cache import get_source_stale_reason

        async with self._session_factory() as session:
            # F9: resolve the persisted global cadence ONCE per tick (cached
            # in-process, so the 60s cadence never hammers the DB). The
            # drift-auto flag and every cooldown pre-check below resolve
            # through it — persisted value when set, env default otherwise.
            cadence = await read_global_cadence(session)
            # The same resolver the hold consults, so the drift gate here
            # and the fleet-wide stop the holds report can never disagree.
            drift_auto = resolve_drift_auto_rebuild(cadence.drift_auto_rebuild)
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
                        # reconciler picks it up instead. Checked UNCONDITIONALLY
                        # (no longer gated by drift_auto): the reconciler now
                        # runs every tick regardless of the flag, so a marked
                        # source must always be handed to it — otherwise, with
                        # drift_auto off, a source that is both marked AND
                        # drifting this tick would be dropped by the reconciler's
                        # drifted_ids dedup yet never drift-signaled, stranding
                        # its marker.
                        if await get_source_stale_reason(
                            state.workspace_id, state.data_source_id,
                        ):
                            continue
                        drifted_ids.append(state.data_source_id)
                except (asyncio.TimeoutError, Exception) as e:
                    logger.warning(
                        "Drift check failed for data source %s: %s",
                        state.data_source_id, e,
                    )

            # R1 — act on drift-detected changes, GATED by ③ Act (off keeps
            # the historic notify-only sweep). R1b — the marked-stale
            # reconciler runs every tick and decides per source (see
            # _reconcile_stale_markers): it honours every operator hold —
            # ③ Act off is a fleet-wide stop the resolver reports — and the
            # breaker, and keeps the marker whenever it defers. The signal
            # itself re-runs the change gate + rebuild cooldown, so nothing
            # here duplicates that timing logic.
            svc = get_active_service()
            if svc is not None:
                if drift_auto:
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
                await self._reconcile_stale_markers(svc, cadence, drifted_ids)

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

    async def _reconcile_stale_markers(
        self, svc: Any, cadence: Any, drifted_ids: list[str],
    ) -> None:
        """Re-signal sources left marked stale (``aggstale:v1``) by a rebuild a
        cooldown deferred or a prior attempt failed or was cancelled.

        Runs every tick and decides per source. It defers — keeping the
        marker, so the source still surfaces as out of date and is retried
        later — when the rebuild is in flight or in cooldown, when the last
        attempt failed or was cancelled within the cadence window, when an
        operator hold is in force (③ Act off is a fleet-wide stop, reported
        by the same resolver every other gate uses), and once the source is
        ``suspended``. Retries are BOUNDED: each re-signal after a failed or
        cancelled job counts against the reconciliation breaker
        (``reconcile_consecutive_actions``, shared with the sweeper); at the
        cap the source is stamped ``suspended`` and the sweeper's own notice
        fires, and nothing automatic runs until a person resumes it
        (``resetBreaker``) or rebuilds by hand. ``signal_source_changed``
        re-runs the change gate + rebuild cooldown, so nothing here duplicates
        that timing logic. Bounded per tick; dedupes against this tick's
        drift signals.
        """
        from .models import AggregationDataSourceStateORM
        from .service import (
            hold_for_source_row,
            reconcile_policy_from_cadence,
            resolve_rebuild_interval,
        )
        from backend.app.services.graph_cache import (
            clear_source_stale,
            list_stale_sources,
        )

        _MAX_STALE_RECONCILE_PER_TICK = 50
        breaker_cap = reconcile_policy_from_cadence(cadence).breaker_cap
        stale_pairs = await list_stale_sources()
        to_reconcile = [
            (ws, ds) for ws, ds in stale_pairs if ds not in drifted_ids
        ]
        if len(to_reconcile) > _MAX_STALE_RECONCILE_PER_TICK:
            logger.info(
                "stale-marker reconcile: %d marker(s) exceed the per-tick cap "
                "(%d); processing the first %d, remainder picked up next tick",
                len(to_reconcile), _MAX_STALE_RECONCILE_PER_TICK,
                _MAX_STALE_RECONCILE_PER_TICK,
            )
        for ws, ds in to_reconcile[:_MAX_STALE_RECONCILE_PER_TICK]:
            try:
                async with self._session_factory() as s2:
                    # Defer (keep the marker, retry a later tick) when the
                    # rebuild is already in flight ("pending"/"running"), the
                    # rebuild cooldown is still open, or the last attempt FAILED
                    # within this cadence window (H2 backoff — otherwise a
                    # permanently-failing source is re-signaled every tick).
                    state = await s2.get(AggregationDataSourceStateORM, ds)
                    interval_secs = resolve_rebuild_interval(
                        getattr(state, "rebuild_min_interval_secs", None),
                        cadence.rebuild_min_interval_secs,
                    )
                    if state is not None and (
                        state.aggregation_status in ("pending", "running")
                        or svc._within_rebuild_cooldown(state, interval_secs)
                    ):
                        logger.debug(
                            "stale-marker reconcile: %s in-flight/cooldown "
                            "— deferring", ds,
                        )
                        continue
                    # A retry: the last job for this source failed or was
                    # cancelled and the marker is still set. Bounded by the
                    # reconciliation breaker — at the cap the source is
                    # stamped ``suspended`` (once) and waits for a person.
                    retrying = (
                        state is not None
                        and state.aggregation_status in _RETRY_AFTER
                    )
                    if (
                        retrying
                        and (getattr(state, "reconcile_consecutive_actions", 0) or 0)
                        >= breaker_cap
                        and getattr(state, "drift_state", None) != "suspended"
                    ):
                        logger.warning(
                            "stale-marker reconcile: %s failed %d automatic "
                            "retries — suspending until a person resumes it",
                            ds, breaker_cap,
                        )
                        await _suspend(s2, state, ds)
                    if (
                        state is not None
                        and getattr(state, "drift_state", None) == "suspended"
                    ):
                        logger.debug(
                            "stale-marker reconcile: %s suspended (needs a "
                            "person) — deferring", ds,
                        )
                        continue
                    if retrying and await _recently_failed(s2, state, interval_secs):
                        logger.debug(
                            "stale-marker reconcile: %s failed recently "
                            "(< %ds cadence) — backing off", ds, interval_secs,
                        )
                        continue
                    # Operator hold (paused / stopped, at any scope): defer
                    # and KEEP the marker. This loop runs every tick
                    # regardless of every other automation switch, so it was
                    # the one path a pause could never reach — a source
                    # paused while a marker was set was rebuilt within a
                    # minute, every minute. The marker stays because it is
                    # what makes the read path serve the honest "may be out
                    # of date" overlay; clearing it would make a paused
                    # source look fresh. Deferring HERE, rather than letting
                    # signal_source_changed refuse, is also what keeps a
                    # held-and-marked source from emitting an audit event
                    # every minute.
                    # (No row is fine: the resolver reads through it, and
                    # the one thing an absent row inherits — the fleet's
                    # ② Check switch — must hold here too, or the signal
                    # below refuses it instead and audits every minute.)
                    hold = await hold_for_source_row(s2, ds, state, cadence)
                    if hold is not None:
                        logger.debug(
                            "stale-marker reconcile: %s held (%s) — deferring",
                            ds, hold.detail,
                        )
                        continue
                    resp = await svc.signal_source_changed(
                        ds, s2, reason="reconcile", origin="reconcile",
                    )
                    if retrying and getattr(resp, "job_id", None) is not None:
                        # Count the retry the way the sweeper counts an
                        # action: only once a job was actually queued. The
                        # row is re-read because trigger() rolled this
                        # session back and committed, which expired the
                        # instance loaded above.
                        state = await s2.get(AggregationDataSourceStateORM, ds)
                        if state is not None:
                            state.reconcile_consecutive_actions = (
                                (state.reconcile_consecutive_actions or 0) + 1
                            )
                            await s2.commit()
                if not resp.changed:
                    # No real change (marker left by a prior deferral that later
                    # reverted, or that never should have fired) — clear it so
                    # it can't ping the reconciler forever.
                    await clear_source_stale(ws, ds)
            except Exception as exc:
                logger.warning(
                    "stale-marker reconcile failed for %s/%s: %s", ws, ds, exc,
                )
