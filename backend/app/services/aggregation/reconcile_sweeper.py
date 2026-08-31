"""ReconciliationSweeper — the scheduled drift / overlay-integrity sweep.

Detects data sources whose ``:AGGREGATED`` overlay has fallen out of step
with their raw graph and queues a rebuild. Auto ticks use ONLY the counts
the stats service already collects — no graph call. Operator Check now /
Preview refresh those counts from the live graph (via the aggregation
service's provider registry) before evaluating, then never hold a DB
session across that network call.

Not to be confused with two neighbours that also say "reconcile":

  * ``reconciler.py`` is the stuck-JOB reconciler (dead-worker liveness).
  * ``scheduler._reconcile_stale_markers`` re-signals sources already
    carrying a Redis stale marker. This sweeper defers to it: any marked
    source is skipped, so the two never both retry one rebuild.

The pass is deliberately two-phase, because the advisory lock is
transaction-scoped and ``engine.py`` forbids holding a session across an
outbound network call:

  Phase A — lock held, pure SQL, no network. Read candidates, evaluate,
            write ``last_reconcile_checked_at`` / seeded baselines / the run
            header, commit (releasing the lock). Emits an action list.
            Operator modes insert a live-count refresh between two short
            locked sections so the network call never sits under the lock.
  Phase B — no lock. Dispatch each action on its own short session, then
            record outcomes.

The ``last_reconcile_checked_at`` write inside Phase A *is* the cross-replica
mutual exclusion: a replica that loses the race finds no due candidates.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, List, Optional

from sqlalchemy import func, select, text

from .reconcile import Observation, Verdict, evaluate

logger = logging.getLogger(__name__)


# How often the loop wakes. Deliberately NOT the check interval: the tick is
# cheap (one bounded query that returns nothing when nothing is due), and
# per-SOURCE due-ness honours the configurable interval. Waking every 60s
# means a cadence change takes effect within a minute — matching what the
# settings dialog promises — and sources stagger instead of all firing at the
# top of the hour.
_SWEEP_TICK_SECS = 60.0

# SQL LIMIT on one pass. Bounds the read regardless of fleet size; the
# remainder is picked up next tick (ordering is oldest-checked-first, so
# nothing starves).
_SCAN_CAP = 200

# Operator Check now may live-refresh this many sources at once.
_LIVE_OBS_CONCURRENCY = 8
_LIVE_OBS_TIMEOUT_S = 5.0
# Whole-pass ceiling for an operator's Check now / Preview: a 200-source
# fleet of slow graphs must not hold the HTTP request for minutes. Sources
# not reached in time evaluate from their stored counts (named skip paths).
_LIVE_OBS_TOTAL_BUDGET_S = 30.0

# Cold-start guard, separate from the general action cap. A fresh install
# with 200 never-aggregated sources drains at one first build per sweep
# rather than queueing 200 full builds at once.
_FIRST_BUILD_CAP = 1

# Per-pass cap on stats-poll nudges for sources whose counts are too stale
# to trust. Best-effort; the next sweep sees fresh numbers.
_NUDGE_CAP = 25

# Floor on the SQL-side due-ness cutoff. The query is deliberately permissive
# (it cannot know each source's override) and Python filters exactly.
_MIN_CHECK_INTERVAL_SECS = 300

_RUN_RETENTION_DAYS = 30

# Ceiling on the fleet-wide stale-marker SCAN. Mirrors the scheduler's
# SCHEDULER_DRIFT_CHECK_TIMEOUT convention: a slow or unreachable dependency
# must not be able to stall the sweep.
_STALE_SCAN_TIMEOUT_S = float(
    __import__("os").getenv("AGGREGATION_RECONCILE_SCAN_TIMEOUT", "3")
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class _Action:
    """One dispatch decided in Phase A, carried out in Phase B."""
    data_source_id: str
    workspace_id: Optional[str]
    reason: str
    evidence: Dict
    first_build: bool
    # Display fields, carried only so the dry-run preview / run detail can
    # list findings a person recognises. Never used for a decision.
    name: Optional[str] = None
    provider_id: Optional[str] = None
    provider_name: Optional[str] = None
    skip: Optional[str] = None
    acted: bool = False
    # Baseline to adopt AFTER a successful Phase B dispatch — never in
    # Phase A, or a CP crash between commit and dispatch leaves the source
    # in rebuild cooldown with no job.
    adopt_raw_fingerprint: Optional[str] = None
    adopt_node_count: int = 0
    adopt_edge_count: int = 0
    # The counts digest this pass evaluated, stamped with the same timing as
    # the baseline above so a dispatched source stops re-opening on numbers
    # we have already acted on.
    adopt_counts_digest: Optional[str] = None


# Skips that mean "we looked and we are done with this source until the
# next interval / stats change". Only these adopt last_seen_counts_digest:
# stamping a hold's digest would silence the tripwire on numbers nobody has
# acted on. Every evaluated source still advances last_reconcile_checked_at
# — it is the fairness clock for the oldest-first scan window; a hold that
# froze it pinned itself to the head of the window and, past _SCAN_CAP held
# sources, starved the rest of the fleet out of the sweep entirely.
_TERMINAL_SKIPS = frozenset({"in_sync", "platform_mastered"})

# Unresolved findings stay due every tick until an action or in_sync —
# this clause, not a frozen checked_at stamp, is what keeps a held or
# deferred finding due while the fairness clock advances.
# ``projectionStalled`` belongs here even though the sweep will never act on
# it: the condition means aggregated lineage is missing from the product
# RIGHT NOW, so it must be re-looked-at every tick — both so it is noticed
# within a minute instead of an hour, and so it CLEARS within a minute of
# the projector catching up. It costs one row of the batched read; the
# fairness clock still advances on every pass, so it rotates through the
# oldest-first window rather than camping in it.
_UNRESOLVED_DRIFT = frozenset({
    "drifting", "overlayMissing", "neverBuilt", "projectionStalled",
})


def _projection_ctx(health) -> Dict:
    """Flatten one :class:`ProjectorHealth` into the observation's fields.

    An unpinned graph yields all-None: nothing is projected into FalkorDB for
    it, so reads coming from Postgres are the plan, not a wedge. Mirrors the
    same rule the ``PROJECTION_STALE`` finding uses, so the two surfaces can
    never disagree about the same graph.
    """
    if health is None or not health.falkor_graph_pinned:
        return {}
    return {
        "projection_commits_behind": health.commits_behind,
        "projection_last_error": health.last_error,
        "projection_checked_at": health.checked_at,
    }


def _is_terminal_skip(verdict: Verdict) -> bool:
    if verdict.seed:
        return True
    return verdict.skip in _TERMINAL_SKIPS and verdict.reason is None


def _unresolved_finding_open(state) -> bool:
    """True when drift is still open and we have not yet acted on it.

    After a successful Phase B finalize, ``last_reconciled_at`` is at least
    as new as ``last_finding_at``, so the source is not kept due solely by
    the drifting stamp (the rebuild job / interval owns the next look).
    """
    if getattr(state, "drift_state", None) not in _UNRESOLVED_DRIFT:
        return False
    last_recon = _parse_iso(getattr(state, "last_reconciled_at", None))
    if last_recon is None:
        return True
    last_finding = _parse_iso(getattr(state, "last_finding_at", None))
    if last_finding is None:
        return True
    return last_finding > last_recon


@dataclass
class SweepResult:
    """What one pass observed and did. Persisted as a ``reconcile_runs`` row
    and returned to the on-demand API."""
    run_id: str
    mode: str = "auto"
    scanned: int = 0
    skipped: int = 0
    seeded: int = 0
    findings: int = 0
    actions: int = 0
    errors: int = 0
    by_reason: Dict[str, int] = field(default_factory=dict)
    by_skip: Dict[str, int] = field(default_factory=dict)
    # Populated on preview runs so the UI can show what WOULD be reconciled.
    pending: List[_Action] = field(default_factory=list)
    # Compact per-finding rows persisted on the run (acted and held).
    finding_rows: List[Dict] = field(default_factory=list)
    started_at: Optional[str] = None
    finished_at: Optional[str] = None

    def detail_json(self) -> str:
        findings = self.finding_rows[:_SCAN_CAP]
        return json.dumps({
            "byReason": self.by_reason,
            "bySkip": self.by_skip,
            "findings": findings,
            # Kept so anything still reading the original sample of ids
            # does not go blank after this revision.
            "sample": [f.get("dataSourceId") for f in findings[:20]],
        })


class ReconciliationSweeper:
    """Owns the I/O around the pure detectors in ``reconcile.py``.

    ``service_getter`` is a callable returning the wired ``AggregationService``
    (or ``None`` before startup completes), matching how the scheduler reaches
    it — the sweeper must not capture a service that does not exist yet.
    """

    def __init__(
        self,
        session_factory: Callable[[], Any],
        service_getter: Optional[Callable[[], Any]] = None,
    ) -> None:
        self._session_factory = session_factory
        if service_getter is None:
            from .service import get_active_service
            service_getter = get_active_service
        self._service_getter = service_getter
        self._running = False

    # ── Loop ─────────────────────────────────────────────────────────

    async def start(self, shutdown: Optional[asyncio.Event] = None) -> None:
        self._running = True
        logger.info(
            "Reconciliation sweeper started (tick=%ds, scan_cap=%d)",
            int(_SWEEP_TICK_SECS), _SCAN_CAP,
        )
        while self._running and not (shutdown and shutdown.is_set()):
            try:
                result = await self.sweep()
                if result and (result.findings or result.actions):
                    logger.info(
                        "reconcile sweep %s: scanned=%d findings=%d actions=%d "
                        "seeded=%d skipped=%d errors=%d",
                        result.run_id, result.scanned, result.findings,
                        result.actions, result.seeded, result.skipped,
                        result.errors,
                    )
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                # A failed pass must never kill the loop.
                logger.error(
                    "reconcile sweep failed: %s", exc, exc_info=True,
                )
            if shutdown is not None:
                with contextlib.suppress(asyncio.TimeoutError):
                    await asyncio.wait_for(
                        shutdown.wait(), timeout=_SWEEP_TICK_SECS,
                    )
                    return
            else:
                await asyncio.sleep(_SWEEP_TICK_SECS)

    async def stop(self) -> None:
        self._running = False

    # ── One pass ─────────────────────────────────────────────────────

    async def sweep(
        self,
        *,
        dry_run: bool = False,
        data_source_ids: Optional[List[str]] = None,
        mode: str = "auto",
        actor: Optional[str] = None,
        record: bool = True,
    ) -> Optional[SweepResult]:
        """Run one pass. ``dry_run`` evaluates and records but acts on nothing
        — that is what the preview endpoint uses to show blast radius before
        automation is switched on.

        Returns ``None`` when another replica holds the sweep lock.
        """
        result = SweepResult(run_id=f"rcn_{uuid.uuid4().hex[:12]}", mode=mode)
        started = _now_iso()

        phase_a = await self._phase_a(result, data_source_ids, dry_run)
        if phase_a is None:
            # A lock held by another replica leaves no trace; a recorded
            # deferral (errors set by _phase_a) must reach the ledger.
            if result.errors and record:
                result.started_at = started
                result.finished_at = _now_iso()
                await self._record_run(result, actor)
            return None
        actions, nudges = phase_a

        for ds_id, ws_id in nudges:
            await self._nudge_stats(ds_id, ws_id)

        if not dry_run:
            await self._phase_b(actions, result, mode, actor)
        else:
            result.pending = actions

        result.started_at = started
        result.finished_at = _now_iso()
        if record:
            await self._record_run(result, actor)
        return result

    # ── Phase A: locked, pure SQL ────────────────────────────────────

    async def _phase_a(self, result, data_source_ids, dry_run):
        """Returns ``(actions, nudges)``, or ``None`` if the sweep did not run
        — the lock is held by another replica, or the versioned-source lookup
        below is cold and unavailable."""
        from backend.app.services.versioned_sources import (
            ProjectorHealthUnavailable,
            VersionedLookupUnavailable,
            projector_health,
            versioned_data_source_ids,
        )

        from .models import AggregationDataSourceStateORM
        from .service import (
            read_global_cadence,
            reconcile_policy_from_cadence,
            resolve_rebuild_interval,
            resolve_reconcile_enabled,
            resolve_reconcile_interval,
        )

        actions: List[_Action] = []
        nudges: List[tuple] = []
        suspend_notices: List[dict] = []

        # Resolved BEFORE the lock is claimed. The graphver store sits behind
        # its own engine and possibly its own database, and the advisory lock
        # is transaction-scoped — it must not span a second store.
        #
        # Deferring on a cold failure is deliberate. Both fail-open answers are
        # wrong: assuming nothing is versioned loses the guard and lets a
        # structural false positive rebuild graphs that may not exist, while
        # assuming everything is versioned silently stops reconciling the
        # fleet. The next tick is 60s away against an hourly check interval, so
        # waiting costs nothing.
        try:
            versioned = await versioned_data_source_ids()
        except VersionedLookupUnavailable as exc:
            logger.warning(
                "reconcile sweep deferred: cannot determine which data "
                "sources are versioned (%s) — retrying on the next tick", exc,
            )
            # Mark the deferral on the result so sweep() records it: with no
            # run row at all, a persistent graphver outage looks like
            # "sweeps stopped" only after 3x the check interval — hours of
            # silence for a subsystem that is effectively down right now.
            result.errors = 1
            result.by_skip["versioned_lookup_unavailable"] = 1
            return None

        # And whether that mastering is currently WORKING. Same store, same
        # pre-lock placement, same deferral discipline — and for the same
        # reason, only sharper: the one answer we must never invent here is
        # "the fleet's projectors are fine". Assuming that is what let a wedged
        # projection read as 'managed' for fourteen hours.
        try:
            health = await projector_health()
        except ProjectorHealthUnavailable as exc:
            logger.warning(
                "reconcile sweep deferred: cannot read projection health for "
                "the versioned fleet (%s) — retrying on the next tick", exc,
            )
            result.errors = 1
            result.by_skip["projector_health_unavailable"] = 1
            return None

        async with self._session_factory() as session:
            if not await self._claim_lock(session):
                return None

            cadence = await read_global_cadence(session)
            policy = reconcile_policy_from_cadence(cadence)
            global_enabled = getattr(cadence, "reconcile_enabled", None)
            global_interval = getattr(
                cadence, "reconcile_check_interval_secs", None,
            )
            max_actions = getattr(cadence, "reconcile_max_actions_per_run", None)
            if max_actions is None:
                from .service import AGGREGATION_RECONCILE_MAX_ACTIONS
                max_actions = AGGREGATION_RECONCILE_MAX_ACTIONS

            # Check now / Preview are operator-initiated full-fleet passes.
            # Auto ticks stay cadence-gated so they do not re-scan the whole
            # set every minute.
            full_scan = result.mode in ("manual", "preview")
            states = await self._candidates(
                session, data_source_ids, global_interval,
                full_scan=full_scan,
            )
            if not states:
                return actions, nudges

            ds_ids = [s.data_source_id for s in states]
            ctx = await self._batch_context(session, ds_ids, versioned, health)
            # Drop the lock before any live graph call. Operator modes refresh
            # counts; auto ticks evaluate against the SQL snapshot alone.
            await session.commit()

        if full_scan:
            live_targets = [
                (s.data_source_id, s.workspace_id)
                for s in states
                if not ctx.get(s.data_source_id, {}).get("platform_mastered")
                and not ctx.get(s.data_source_id, {}).get("deleted")
            ]
            await self._live_observe_counts(ctx, live_targets)

        async with self._session_factory() as session:
            if not await self._claim_lock(session):
                return None

            # Re-load state rows under the new lock — the previous instances
            # were bound to the committed session above.
            states = (await session.execute(
                select(AggregationDataSourceStateORM).where(
                    AggregationDataSourceStateORM.data_source_id.in_(ds_ids)
                )
            )).scalars().all()
            by_id = {s.data_source_id: s for s in states}
            # Preserve the original oldest-checked-first order.
            states = [by_id[i] for i in ds_ids if i in by_id]

            first_builds = 0
            for state in states:
                ctx_row = ctx.get(state.data_source_id, {})
                obs = self._observe(
                    state, ctx, policy,
                    reconcile_enabled=resolve_reconcile_enabled(
                        state.reconcile_enabled, global_enabled,
                    ),
                    rebuild_interval=resolve_rebuild_interval(
                        state.rebuild_min_interval_secs,
                        cadence.rebuild_min_interval_secs,
                    ),
                )
                # Per-source due-ness: the SQL cutoff is permissive because it
                # cannot know each source's override, so the exact check is
                # here. A not-yet-due source is left untouched (no checked_at
                # write) and reappears on a later tick. Manual / preview and
                # explicit ids skip this — the operator asked for a verdict.
                interval = resolve_reconcile_interval(
                    state.reconcile_check_interval_secs, global_interval,
                )
                if (
                    data_source_ids is None
                    and not full_scan
                    and not self._is_due(
                        state, interval,
                        counts_digest=ctx_row.get("counts_digest"),
                    )
                ):
                    continue

                result.scanned += 1
                verdict = evaluate(obs, policy)
                now = _now_iso()
                prev_drift = state.drift_state
                # Unevaluated skips leave drift_state None — keep the prior stamp.
                if verdict.drift_state is not None:
                    state.drift_state = verdict.drift_state
                if (
                    not dry_run
                    and verdict.skip == "suspended"
                    and prev_drift != "suspended"
                ):
                    suspend_notices.append({
                        "workspace_id": state.workspace_id,
                        "data_source_id": state.data_source_id,
                        "source_name": (
                            ctx_row.get("name") or state.data_source_id
                        ),
                    })

                if verdict.reason:
                    state.last_finding_at = now
                    state.last_finding_reason = verdict.reason
                    try:
                        state.last_finding_evidence = json.dumps(
                            verdict.evidence or {},
                        )
                    except (TypeError, ValueError):
                        state.last_finding_evidence = None
                    result.findings += 1
                    result.by_reason[verdict.reason] = (
                        result.by_reason.get(verdict.reason, 0) + 1
                    )
                elif verdict.skip == "in_sync":
                    state.last_finding_at = None
                    state.last_finding_reason = None
                    state.last_finding_evidence = None

                if not verdict.should_act:
                    result.skipped += 1
                    result.by_skip[verdict.skip] = (
                        result.by_skip.get(verdict.skip, 0) + 1
                    )
                    if verdict.seed:
                        result.seeded += 1
                        self._adopt(state, obs)
                    elif verdict.skip == "in_sync":
                        # A clean pass clears the breaker: whatever was wrong
                        # is fixed, so the next real finding starts fresh.
                        state.reconcile_consecutive_actions = 0
                        self._adopt(state, obs)
                    elif verdict.skip == "platform_mastered":
                        # Never acted on, but keep the baseline moving with the
                        # source so that one later taken back out of versioning
                        # does not read as drifted on its first sweep after.
                        self._adopt(state, obs)
                    elif verdict.skip == "projection_stalled":
                        # DELIBERATELY NO ADOPT. The baseline is only moved
                        # when we believe the numbers: while the projection is
                        # behind, the stats scan is measuring whichever backend
                        # happened to answer, and freezing a wedged reading as
                        # "the new normal" is how the fault gets forgotten. The
                        # last known-good baseline stands until the projector
                        # is current again and the 'managed' branch above
                        # resumes advancing it.
                        #
                        # And DELIBERATELY NO DISPATCH: recovery is an operator
                        # action on the projector. An automatic retry against a
                        # deterministically-failing verify is what burned CPU
                        # for fourteen hours without recovering anything.
                        logger.warning(
                            "reconcile sweep: %s is versioned but its "
                            "projection is not current (%s commit(s) behind%s)"
                            " — rolled-up connections are not being served",
                            state.data_source_id,
                            obs.projection_commits_behind,
                            f", last error: {obs.projection_last_error}"
                            if obs.projection_last_error else "",
                        )
                    elif verdict.skip in ("stats_stale", "stats_unhealthy"):
                        if len(nudges) < _NUDGE_CAP:
                            nudges.append((state.data_source_id, state.workspace_id))
                    # Every evaluated source advances the fairness clock —
                    # a frozen stamp pinned holds to the head of the oldest-
                    # first window until, past _SCAN_CAP of them, nothing
                    # else was ever scanned. A hold stays due through the
                    # unresolved-drift clause, not through this stamp.
                    if _is_terminal_skip(verdict):
                        state.last_reconcile_checked_at = now
                        # Record the numbers we just accepted, so an
                        # identical re-probe is free. Terminal-only: a hold's
                        # digest stays unstamped so the tripwire keeps firing
                        # on numbers nobody has acted on.
                        state.last_seen_counts_digest = ctx_row.get(
                            "counts_digest"
                        )
                    elif not dry_run:
                        state.last_reconcile_checked_at = now
                    if verdict.reason:
                        result.finding_rows.append(_finding_row(
                            state, ctx_row, verdict, acted=False,
                        ))
                    continue

                # A cap deferral advances the fairness clock too — the
                # finding stays open (and due) through the unresolved-drift
                # clause. A dry run lists without stamping anything.
                if dry_run or len(actions) >= max_actions:
                    if not dry_run and len(actions) >= max_actions:
                        state.last_reconcile_checked_at = now
                        logger.info(
                            "reconcile sweep: action cap (%d) reached — %s "
                            "deferred to the next sweep",
                            max_actions, state.data_source_id,
                        )
                    if dry_run:
                        actions.append(_action_from(
                            state, ctx_row, verdict, obs, acted=False,
                        ))
                    result.finding_rows.append(_finding_row(
                        state, ctx_row, verdict, acted=False,
                    ))
                    continue

                first_build = verdict.reason == "never_aggregated"
                if first_build:
                    if first_builds >= _FIRST_BUILD_CAP:
                        # Same fairness stamp as the action cap above: a
                        # >200-source backlog of never-built sources drained
                        # at 1/tick must rotate through the window, not camp
                        # in it.
                        state.last_reconcile_checked_at = now
                        result.finding_rows.append(_finding_row(
                            state, ctx_row, verdict, acted=False,
                            skip="cap",
                        ))
                        continue
                    first_builds += 1

                actions.append(_action_from(
                    state, ctx_row, verdict, obs, acted=True,
                ))
                # Adopt / last_reconciled / breaker / last_checked happen in
                # Phase B after a successful dispatch — not here.
                result.finding_rows.append(_finding_row(
                    state, ctx_row, verdict, acted=True,
                ))

            await session.commit()  # releases the advisory lock

            # Notifications AFTER the lock-releasing commit. They are
            # best-effort fan-out over other domains' tables; inside the
            # locked transaction a repo failure rolled back — or, on
            # Postgres, poisoned — every state write of the pass.
            if suspend_notices:
                from backend.app.db.repositories.notification_repo import (
                    notify_reconcile_suspended,
                )
                try:
                    for notice in suspend_notices:
                        await notify_reconcile_suspended(session, **notice)
                    await session.commit()
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    logger.warning(
                        "reconcile sweep: suspension notification failed "
                        "(%s) — the suspended state itself is committed",
                        exc,
                    )
        return actions, nudges

    async def _live_observe_counts(
        self, ctx: Dict[str, Dict], targets: List[tuple],
    ) -> None:
        """Refresh ctx counts from the live graph for an operator pass.

        Prefers ``provider.get_counts_fast`` (constant-time counter reads)
        and falls back to ``provider.get_stats`` (two full scans) only when
        the counters cannot describe the graph; never ``get_schema_stats``.
        The whole pass carries a total budget. Failures leave the SQL
        snapshot in place so evaluate still has a named skip path. No DB
        session is held across the graph call.
        """
        if not targets:
            return
        svc = self._service_getter()
        registry = getattr(svc, "_registry", None) if svc else None
        if registry is None:
            return

        from .fingerprint import raw_fingerprint_from_counts

        sem = asyncio.Semaphore(_LIVE_OBS_CONCURRENCY)

        failures = 0

        async def _one(ds_id: str, workspace_id: Optional[str]) -> None:
            nonlocal failures
            if not workspace_id:
                return
            async with sem:
                try:
                    async with self._session_factory() as session:
                        provider = await asyncio.wait_for(
                            registry.get_provider_for_workspace(
                                workspace_id, session, data_source_id=ds_id,
                            ),
                            timeout=_LIVE_OBS_TIMEOUT_S,
                        )
                    # Constant-time counters first — same payload shape as
                    # get_stats; None means the counters cannot describe
                    # this graph (multi-label), and only then is the
                    # two-full-scan read worth paying.
                    raw = None
                    fast = getattr(provider, "get_counts_fast", None)
                    if fast is not None:
                        raw = await asyncio.wait_for(
                            fast(), timeout=_LIVE_OBS_TIMEOUT_S,
                        )
                    if raw is None:
                        try:
                            raw = await asyncio.wait_for(
                                provider.get_stats(bypass_cache=True),
                                timeout=_LIVE_OBS_TIMEOUT_S,
                            )
                        except TypeError:
                            raw = await asyncio.wait_for(
                                provider.get_stats(),
                                timeout=_LIVE_OBS_TIMEOUT_S,
                            )
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    failures += 1
                    logger.debug(
                        "reconcile sweep: live observe failed for %s: %s",
                        ds_id, exc,
                    )
                    return

                entity = raw.get("entityTypeCounts") or {}
                edges = raw.get("edgeTypeCounts") or {}
                fp, observed_agg, raw_edges = raw_fingerprint_from_counts(
                    entity, edges,
                )
                node_count = int(raw.get("nodeCount") or 0)
                edge_count = int(raw.get("edgeCount") or 0)
                entry = ctx.setdefault(ds_id, {})
                entry.update(
                    has_stats=True,
                    stats_age_secs=0,
                    stats_as_of=_now_iso(),
                    stats_updated=datetime.now(timezone.utc),
                    node_count=node_count,
                    observed_aggregated=observed_agg,
                    observed_raw_fingerprint=fp,
                    observed_raw_edge_total=raw_edges,
                    live_observed=True,
                )
                # Persist so Check now and the idle poll share one row.
                # Failure leaves the in-memory observation (evaluate still runs).
                try:
                    from backend.app.db.repositories.stats_repo import (
                        upsert_data_source_stats_counts,
                    )
                    async with self._session_factory() as session:
                        await upsert_data_source_stats_counts(
                            session,
                            ds_id=ds_id,
                            node_count=node_count,
                            edge_count=edge_count,
                            entity_type_counts=json.dumps(entity),
                            edge_type_counts=json.dumps(edges),
                            lane="sweep",
                        )
                        await session.commit()
                except Exception as exc:
                    logger.debug(
                        "reconcile sweep: live observe persist failed for %s: %s",
                        ds_id, exc,
                    )

        try:
            await asyncio.wait_for(
                asyncio.gather(*[
                    _one(ds_id, ws_id) for ds_id, ws_id in targets
                ]),
                timeout=_LIVE_OBS_TOTAL_BUDGET_S,
            )
        except asyncio.TimeoutError:
            refreshed = sum(
                1 for e in ctx.values() if e.get("live_observed")
            )
            logger.warning(
                "reconcile sweep: live observe budget exhausted — %d of %d "
                "refreshed; the rest evaluate from stored counts",
                refreshed, len(targets),
            )
        if failures:
            logger.warning(
                "reconcile sweep: live observe failed for %d of %d source(s)"
                " — they evaluate from stored counts (details at debug)",
                failures, len(targets),
            )

    async def _claim_lock(self, session) -> bool:
        """Transaction-scoped advisory lock, distinct from the stuck-job
        reconciler's so the two sweeps never block each other. A non-Postgres
        backend (unit fakes, SQLite) simply proceeds — single-instance
        semantics. On Postgres an error fails CLOSED: skipping one 60s tick
        is strictly cheaper than two replicas acting on the same sources.
        (The residual Phase-A/Phase-B window across replicas is collapsed by
        the trigger idempotency keys — a duplicate dispatch lands as a
        ConflictError no-op in Phase B.)"""
        dialect = getattr(getattr(session, "bind", None), "dialect", None)
        if getattr(dialect, "name", None) != "postgresql":
            return True
        try:
            got = (await session.execute(text(
                "SELECT pg_try_advisory_xact_lock("
                "hashtextextended('agg:reconcile-sweep', 0))"
            ))).scalar()
            return got not in (False, 0)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning(
                "reconcile sweep: could not claim the sweep lock (%s) — "
                "skipping this tick", exc,
            )
            return False

    async def _candidates(
        self, session, data_source_ids, global_interval, *, full_scan=False,
    ):
        """Bounded, oldest-checked-first. Explicit ids and operator
        manual/preview passes bypass due-ness; auto ticks do not.

        Auto also loads sources whose COUNTS have moved since the last
        verdict — a probe or counts poll that finds real change must not wait
        for the check interval before evaluate runs, and one that finds
        nothing must not cost anything at all.
        """
        from backend.app.db.models import DataSourceStatsORM
        from .models import AggregationDataSourceStateORM as S

        stmt = select(S)
        if data_source_ids:
            stmt = stmt.where(S.data_source_id.in_(data_source_ids))
        elif full_scan:
            stmt = stmt.order_by(
                S.last_reconcile_checked_at.asc().nullsfirst()
            ).limit(_SCAN_CAP)
        else:
            interval = min(
                global_interval or _MIN_CHECK_INTERVAL_SECS,
                _MIN_CHECK_INTERVAL_SECS,
            )
            # A per-source override faster than the clamp above was never
            # loaded by the timestamp clause — the exact bug the probe
            # lane's _fastest_override exists for. One scalar MIN keeps the
            # cutoff a SUPERSET of every override; _is_due stays the exact
            # per-source test.
            fastest = (await session.execute(
                select(func.min(S.reconcile_check_interval_secs))
            )).scalar()
            if fastest is not None:
                interval = min(interval, int(fastest))
            cutoff = (
                datetime.now(timezone.utc) - timedelta(seconds=interval)
            ).isoformat()
            stmt = (
                select(S)
                .outerjoin(
                    DataSourceStatsORM,
                    DataSourceStatsORM.data_source_id == S.data_source_id,
                )
                .where(
                    (S.last_reconcile_checked_at.is_(None))
                    | (S.last_reconcile_checked_at < cutoff)
                    | (
                        # The tripwire: the counts moved since we last looked.
                        #
                        # Content, not timestamps. ``data_source_stats
                        # .updated_at`` carries ``onupdate``, so the older
                        # "stats row is newer than the last verdict" test fired
                        # on ANY write to that row — including a probe that
                        # re-read identical numbers. At a 60s probe cadence
                        # that is the whole fleet, every tick, forever.
                        #
                        # The NULL guard is load-bearing: IS DISTINCT FROM
                        # treats a never-written NULL as different from any
                        # stored value, which would pin the source permanently
                        # due instead of never due.
                        DataSourceStatsORM.counts_digest.isnot(None)
                        & DataSourceStatsORM.counts_digest.is_distinct_from(
                            S.last_seen_counts_digest
                        )
                    )
                    | (
                        # No digest yet — a source the probe has not reached,
                        # or a row written by a producer that predates the
                        # column. Fall back to the timestamp test so those keep
                        # exactly their previous behaviour. Being permissive
                        # here is safe and being absent is not: this query must
                        # stay a SUPERSET of what ``_is_due`` accepts, or a
                        # source it would have acted on is never even loaded.
                        DataSourceStatsORM.counts_digest.is_(None)
                        & DataSourceStatsORM.updated_at.isnot(None)
                        & S.last_reconcile_checked_at.isnot(None)
                        & (
                            DataSourceStatsORM.updated_at
                            > S.last_reconcile_checked_at
                        )
                    )
                    | (
                        S.drift_state.in_(tuple(_UNRESOLVED_DRIFT))
                        & (
                            S.last_reconciled_at.is_(None)
                            | (
                                S.last_finding_at.isnot(None)
                                & (S.last_finding_at > S.last_reconciled_at)
                            )
                        )
                    )
                )
                .order_by(S.last_reconcile_checked_at.asc().nullsfirst())
                .limit(_SCAN_CAP)
            )
        return list((await session.execute(stmt)).scalars().all())

    async def _batch_context(
        self, session, ds_ids, versioned, health=None,
    ) -> Dict[str, Dict]:
        """Four batched reads, joined in memory.

        Batched rather than one wide JOIN because these tables live in three
        different domains (``DOMAIN_OWNERSHIP.md``) — the same shape
        ``_rebuild_override_map`` uses.

        ``versioned`` is the set of platform-mastered data source ids and
        ``health`` the per-data-source projection watermark, both resolved by
        the caller before the lock (see :meth:`_phase_a`).
        """
        from backend.app.db.models import (
            DataSourcePollingConfigORM,
            DataSourceStatsORM,
            ProviderORM,
            WorkspaceDataSourceORM,
        )
        from .fingerprint import (
            counts_digest_from_counts, raw_fingerprint_from_counts,
        )
        from .models import AggregationJobORM

        out: Dict[str, Dict] = {d: {} for d in ds_ids}

        # 1. The data source itself (deleted? which ontology? projection?).
        rows = (await session.execute(
            select(  # noqa: cross-domain (reconcile sweep: read-only batched context for ≤_SCAN_CAP sources; provider NAME labels findings)
                WorkspaceDataSourceORM.id,
                WorkspaceDataSourceORM.deleted_at,
                WorkspaceDataSourceORM.is_active,
                WorkspaceDataSourceORM.ontology_id,
                WorkspaceDataSourceORM.provider_id,
                WorkspaceDataSourceORM.projection_mode,
                WorkspaceDataSourceORM.label,
                ProviderORM.name,
            ).select_from(WorkspaceDataSourceORM)
            .outerjoin(
                ProviderORM,
                ProviderORM.id == WorkspaceDataSourceORM.provider_id,
            )
            .where(WorkspaceDataSourceORM.id.in_(ds_ids))
        )).all()
        seen = set()
        for (
            ds_id, deleted_at, is_active, ontology_id, provider_id, proj,
            label, provider_name,
        ) in rows:
            seen.add(ds_id)
            out[ds_id].update(
                deleted=bool(deleted_at) or is_active is False,
                ontology_id=ontology_id,
                provider_id=provider_id,
                provider_name=provider_name,
                name=label,
                # Versioned: Postgres masters the graph and FalkorDB is a
                # rebuildable read cache, so every count-based signal here is
                # measuring the wrong backend half the time. See
                # reconcile._guard.
                platform_mastered=ds_id in versioned,
                # …and whether that projector is currently keeping up. Only
                # carried for a source the health read actually covers; an
                # unpinned or never-projected graph reports current, because
                # nothing is projected there BY DESIGN.
                **_projection_ctx((health or {}).get(ds_id)),
                # A dedicated projection writes AGGREGATED to ANOTHER graph,
                # which get_stats() never scans — so the observed count is
                # permanently 0 and means nothing. See reconcile._overlay_missing.
                overlay_observable=(proj or "in_source") != "dedicated",
            )
        for ds_id in ds_ids:
            if ds_id not in seen:
                # A state row with no live data source: treat as deleted.
                out[ds_id]["deleted"] = True

        # 2. The stats service's output — the whole evidence base.
        now = datetime.now(timezone.utc)
        stat_rows = (await session.execute(
            select(DataSourceStatsORM).where(
                DataSourceStatsORM.data_source_id.in_(ds_ids)
            )
        )).scalars().all()
        for row in stat_rows:
            try:
                entity_counts = json.loads(row.entity_type_counts or "{}")
                edge_counts = json.loads(row.edge_type_counts or "{}")
            except (TypeError, ValueError):
                entity_counts, edge_counts = {}, {}
            fp, observed_agg, raw_edges = raw_fingerprint_from_counts(
                entity_counts, edge_counts,
            )
            age = None
            updated = _parse_iso(row.updated_at)
            if updated is not None:
                age = max(0, int((now - updated).total_seconds()))
            out[row.data_source_id].update(
                has_stats=True,
                stats_age_secs=age,
                stats_as_of=row.updated_at,
                stats_updated=updated,
                node_count=int(row.node_count or 0),
                observed_aggregated=observed_agg,
                observed_raw_fingerprint=fp,
                observed_raw_edge_total=raw_edges,
                # Carried so the pass can stamp what it evaluated; see
                # ``_is_due`` / ``_candidates``. Falls back to deriving the
                # digest from the counts themselves, so a row written by a
                # producer that predates the column still converges instead of
                # looking permanently unmoved.
                counts_digest=(
                    row.counts_digest
                    or counts_digest_from_counts(entity_counts, edge_counts)
                ),
            )

        # 3. Is the stats poll itself healthy?
        poll_rows = (await session.execute(
            select(
                DataSourcePollingConfigORM.data_source_id,
                DataSourcePollingConfigORM.is_enabled,
                DataSourcePollingConfigORM.last_status,
            ).where(DataSourcePollingConfigORM.data_source_id.in_(ds_ids))
        )).all()
        for ds_id, enabled, last_status in poll_rows:
            out[ds_id].update(
                stats_polling_enabled=bool(enabled),
                stats_last_status=last_status,
            )

        # 4. Job history, in ONE query: in-flight rebuilds, whether one ever
        # completed, and when the most recent attempt failed. The last of
        # those is the failure backoff — computed from the batched rows rather
        # than ``scheduler._recently_failed``, which issues a query per source
        # and would mean 200 round-trips on a full scan.
        job_rows = (await session.execute(
            select(
                AggregationJobORM.data_source_id,
                AggregationJobORM.status,
                AggregationJobORM.updated_at,
            )
            .where(AggregationJobORM.data_source_id.in_(ds_ids))
            # NULLS LAST: a freshly-created (pending) job has updated_at=NULL,
            # which Postgres ranks FIRST on DESC and SQLite ranks last — pin
            # both to "latest updated row wins, never a NULL".
            .order_by(AggregationJobORM.updated_at.desc().nullslast())
        )).all()
        latest_seen: set = set()
        for ds_id, status, updated_at in job_rows:
            entry = out.setdefault(ds_id, {})
            if status in ("pending", "running"):
                entry["job_in_flight"] = True
            if status == "completed":
                entry["has_completed_job"] = True
            if ds_id not in latest_seen:
                latest_seen.add(ds_id)
                if status == "failed":
                    entry["last_failed_at"] = _parse_iso(updated_at)

        # 5. Stale markers — ONE bounded Redis SCAN for the whole fleet. A
        # marked source already had its invalidation and belongs to
        # ``scheduler._reconcile_stale_markers``; two mechanisms must never
        # both retry one rebuild.
        #
        # Time-boxed on purpose. An unreachable Redis takes seconds to fail
        # its connect, and a large keyspace makes the SCAN itself unbounded —
        # either would stall every sweep. Both degrade to "not marked", which
        # is the same direction every other read of this marker fails in: the
        # worst case is that the marker reconciler and this sweep both act on
        # one source, which the idempotency key collapses anyway.
        try:
            from backend.app.services.graph_cache import list_stale_sources
            marked = await asyncio.wait_for(
                list_stale_sources(), timeout=_STALE_SCAN_TIMEOUT_S,
            )
            for _ws, marked_ds in marked:
                if marked_ds in out:
                    out[marked_ds]["stale_marker"] = True
        except asyncio.CancelledError:
            raise
        except (asyncio.TimeoutError, Exception) as exc:
            logger.debug("reconcile sweep: stale-marker scan skipped: %s", exc)

        return out

    def _observe(
        self, state, ctx, policy, *, reconcile_enabled, rebuild_interval,
    ) -> Observation:
        c = ctx.get(state.data_source_id, {})
        stats_updated = c.get("stats_updated")
        last_agg = _parse_iso(state.last_aggregated_at)
        # A source rebuilt more recently than the stats row was written still
        # reports its PRE-rebuild AGGREGATED count. Acting on that re-fires the
        # same finding forever — so treat it as stale, not as evidence.
        if (
            stats_updated is not None and last_agg is not None
            and stats_updated < last_agg
        ):
            stats_age = None
        else:
            stats_age = c.get("stats_age_secs")

        # The rebuild throttle, evaluated against the SAME resolved window the
        # signal's own cooldown gate uses — so the sweep never queues work the
        # signal would immediately defer.
        in_cooldown = _within_cooldown(last_agg, rebuild_interval)
        # Failure backoff: a permanently-failing source must not be re-signaled
        # every sweep.
        failed_at = c.get("last_failed_at")
        recently_failed = (
            failed_at is not None
            and rebuild_interval > 0
            and (datetime.now(timezone.utc) - failed_at).total_seconds()
            < rebuild_interval
        )

        return Observation(
            data_source_id=state.data_source_id,
            workspace_id=state.workspace_id,
            provider_id=c.get("provider_id"),
            deleted=c.get("deleted", False),
            ontology_id=c.get("ontology_id"),
            platform_mastered=c.get("platform_mastered", False),
            projection_commits_behind=c.get("projection_commits_behind"),
            projection_last_error=c.get("projection_last_error"),
            projection_checked_at=c.get("projection_checked_at"),
            has_stats=c.get("has_stats", False),
            stats_age_secs=stats_age,
            stats_as_of=c.get("stats_as_of"),
            node_count=c.get("node_count", 0),
            observed_aggregated=c.get("observed_aggregated", 0),
            observed_raw_fingerprint=c.get("observed_raw_fingerprint"),
            observed_raw_edge_total=c.get("observed_raw_edge_total", 0),
            stats_polling_enabled=c.get("stats_polling_enabled", True),
            stats_last_status=c.get("stats_last_status"),
            has_state=True,
            aggregation_status=state.aggregation_status,
            expected_aggregated=int(state.aggregation_edge_count or 0),
            stored_raw_fingerprint=state.raw_fingerprint,
            stored_raw_node_count=state.raw_node_count,
            stored_raw_edge_count=state.raw_edge_count,
            consecutive_actions=int(state.reconcile_consecutive_actions or 0),
            job_in_flight=c.get("job_in_flight", False),
            has_completed_job=c.get("has_completed_job", False),
            stale_marker=c.get("stale_marker", False),
            in_cooldown=in_cooldown,
            paused_until=state.paused_until,
            recently_failed=recently_failed,
            overlay_observable=c.get("overlay_observable", True),
            live_observed=bool(c.get("live_observed")),
            reconcile_enabled=reconcile_enabled,
        )

    @staticmethod
    def _is_due(state, interval_secs: int, *, counts_digest=None) -> bool:
        """Due when the check interval elapsed, the counts moved since the
        last verdict, or an unresolved finding is still open.

        Mirrors the SQL in :meth:`_candidates` — the two must agree, or a
        source the query selected gets silently dropped here (or vice versa).
        Both compare digests rather than timestamps so that a probe finding
        identical numbers is free; see the note in ``_candidates``.
        """
        if interval_secs <= 0:
            return True
        if _unresolved_finding_open(state):
            return True
        if (
            counts_digest is not None
            and counts_digest != state.last_seen_counts_digest
        ):
            return True
        last = _parse_iso(state.last_reconcile_checked_at)
        if last is None:
            return True
        elapsed = (datetime.now(timezone.utc) - last).total_seconds()
        return elapsed >= interval_secs

    @staticmethod
    def _adopt(state, obs: Observation) -> None:
        """Write the observed shape as the new baseline."""
        if obs.observed_raw_fingerprint is None:
            return
        state.raw_fingerprint = obs.observed_raw_fingerprint
        state.raw_node_count = obs.node_count
        state.raw_edge_count = obs.observed_raw_edge_total

    # ── Phase B: unlocked dispatch ───────────────────────────────────

    async def _phase_b(self, actions, result, mode, actor) -> None:
        svc = self._service_getter()
        if svc is None:
            logger.warning(
                "reconcile sweep: no active aggregation service — %d action(s) "
                "deferred to the next sweep", len(actions),
            )
            result.errors += len(actions)
            return

        for action in actions:
            try:
                async with self._session_factory() as session:
                    if action.first_build:
                        await self._dispatch_first_build(
                            svc, session, action, actor, result.run_id,
                        )
                        deferred = False
                        queued = True
                    else:
                        resp = await svc.signal_source_changed(
                            action.data_source_id, session,
                            reason=action.reason,
                            origin="reconcile-sweep",
                            actor=actor or "internal",
                            audit_reason=action.reason,
                            evidence=action.evidence,
                            # Without this the job it queues is stamped "api"
                            # and reads in Job History as a person clicking
                            # Rebuild — indistinguishable from a manual one.
                            trigger_source="reconcile",
                            run_id=result.run_id,
                        )
                        deferred = bool(
                            resp is not None and getattr(resp, "deferred", False)
                        )
                        # A response without a job id is a no-op (unchanged
                        # gate, trigger conflict, resolution failure, not
                        # applicable). None still reads as queued — the unit
                        # fakes return None.
                        queued = (
                            resp is None
                            or getattr(resp, "job_id", None) is not None
                        )
                    if deferred:
                        # Cooldown raced the hold — leave last_checked alone
                        # so the next tick retries once the window opens.
                        logger.info(
                            "reconcile sweep: dispatch deferred for %s — "
                            "staying due",
                            action.data_source_id,
                        )
                        continue
                    if not queued:
                        # Nothing was queued, so nothing may adopt the drifted
                        # fingerprint as the new baseline, advance the breaker,
                        # or count as an action. The source stays due; the
                        # retry converges (an unchanged gate resolves once the
                        # probe refreshes counts, a conflict becomes the
                        # in_flight guard, a resolution failure a guard skip).
                        logger.info(
                            "reconcile sweep: signal queued no job for %s "
                            "(%s) — leaving it due, not counting an action",
                            action.data_source_id, action.reason,
                        )
                        continue
                    await self._finalize_action(session, action, mode)
                    await session.commit()
                result.actions += 1
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                result.errors += 1
                logger.warning(
                    "reconcile sweep: dispatch failed for %s (%s): %s",
                    action.data_source_id, action.reason, exc,
                )

    async def _finalize_action(self, session, action: _Action, mode: str) -> None:
        """Adopt baseline + stamp last_checked after a successful dispatch.

        Kept out of Phase A so a CP crash between evaluate and dispatch cannot
        put the source into rebuild cooldown with no job queued.
        """
        from .models import AggregationDataSourceStateORM

        state = await session.get(
            AggregationDataSourceStateORM, action.data_source_id,
        )
        if state is None:
            return
        now = _now_iso()
        if action.adopt_raw_fingerprint is not None:
            state.raw_fingerprint = action.adopt_raw_fingerprint
            state.raw_node_count = action.adopt_node_count
            state.raw_edge_count = action.adopt_edge_count
        state.last_reconciled_at = now
        state.last_reconcile_reason = action.reason
        state.last_reconcile_mode = "manual" if mode == "manual" else "auto"
        state.reconcile_consecutive_actions = (
            state.reconcile_consecutive_actions or 0
        ) + 1
        state.last_reconcile_checked_at = now
        if action.adopt_counts_digest is not None:
            state.last_seen_counts_digest = action.adopt_counts_digest

    async def _dispatch_first_build(self, svc, session, action, actor, run_id) -> None:
        """Queue the very first aggregation for an onboarded source.

        Deliberately NOT via ``signal_source_changed``: that path treats a
        ``none`` status as not-applicable by design, so it would be a no-op
        here. ``trigger`` applies the stored global tuning defaults, so this
        job inherits the configuration that covers every graph size with no
        extra plumbing.
        """
        from .schemas import AggregationTriggerRequest
        from backend.app.db.repositories.refresh_events_repo import (
            emit_refresh_event,
        )

        fp = action.evidence.get("rawFingerprintAfter") or "new"
        job = await svc.trigger(
            action.data_source_id,
            AggregationTriggerRequest(
                idempotency_key=(
                    f"reconcile:first:{action.data_source_id}:{fp}"
                ),
            ),
            # "reconcile", not "schedule": the latter means the cron-driven
            # AggregationScheduler, and a first build queued here is the same
            # subsystem as the other three detectors. All four report as one
            # thing in Job History.
            "reconcile",
            session,
        )
        await emit_refresh_event(
            self._session_factory,
            workspace_id=action.workspace_id,
            data_source_id=action.data_source_id,
            origin="reconcile-sweep",
            actor=actor or "internal",
            scope="rollups",
            gate="changed",
            actions={"job_id": job.id, "first_build": True},
            outcome="accepted",
            reason=action.reason,
            evidence=action.evidence,
            job_id=job.id,
            run_id=run_id,
        )

    async def _nudge_stats(self, ds_id, workspace_id) -> None:
        """Get fresh numbers for a source whose counts were too stale to act on.

        A PROBE, not a stats poll. Both refresh the counts this sweep needs,
        but the probe reads FalkorDB's counters (~1ms, priority lane) while the
        poll runs two full scans and is throttled to one enqueue per source per
        minute — on a large graph that difference is the whole reason a stale
        source used to sit unresolved for the better part of an hour.

        The poll still follows, because it owns the deep facet and the polling
        lifecycle; it is simply no longer what the next sweep waits on.
        Best-effort throughout: losing a nudge costs one more tick, never
        correctness — the per-source interval remains the backstop.
        """
        if not workspace_id:
            return
        try:
            from backend.insights_service.enqueue import (
                enqueue_probe_job_safe, mark_stats_changed,
            )
            await enqueue_probe_job_safe(ds_id, workspace_id, priority=True)
            await mark_stats_changed(ds_id, workspace_id)
        except Exception as exc:
            logger.debug("reconcile sweep: stats nudge failed for %s: %s", ds_id, exc)

    # ── Run record ───────────────────────────────────────────────────

    async def _record_run(self, result: SweepResult, actor) -> None:
        """Persist the pass, and trim old ones. Never raises: losing a run
        record must not fail the sweep it describes.

        An idle auto tick (nothing scanned, found, seeded or done) advances
        the previous idle row in place instead of inserting — one row per
        idle stretch, not 1,440 near-empty rows a day drowning the ledger.
        The row's stamps still move every tick, so liveness reads keep
        working at any interval. Manual and preview passes always insert.
        """
        from .models import ReconcileRunORM

        idle = (
            result.mode == "auto"
            and result.scanned == 0
            and result.findings == 0
            and result.actions == 0
            and result.seeded == 0
        )
        try:
            async with self._session_factory() as session:
                if idle:
                    prev = (await session.execute(
                        select(ReconcileRunORM)
                        .order_by(ReconcileRunORM.started_at.desc())
                        .limit(1)
                    )).scalars().first()
                    if (
                        prev is not None
                        and prev.mode == "auto"
                        and (prev.scanned or 0) == 0
                        and (prev.findings or 0) == 0
                        and (prev.actions or 0) == 0
                        and (prev.seeded or 0) == 0
                        and (prev.errors or 0) == result.errors
                    ):
                        prev.started_at = result.started_at or _now_iso()
                        prev.finished_at = result.finished_at or _now_iso()
                        prev.detail = result.detail_json()
                        await session.commit()
                        return
                session.add(ReconcileRunORM(
                    id=result.run_id,
                    started_at=result.started_at or _now_iso(),
                    finished_at=result.finished_at or _now_iso(),
                    mode=result.mode,
                    actor=actor,
                    scanned=result.scanned,
                    skipped=result.skipped,
                    seeded=result.seeded,
                    findings=result.findings,
                    actions=result.actions,
                    errors=result.errors,
                    detail=result.detail_json(),
                ))
                cutoff = (
                    datetime.now(timezone.utc)
                    - timedelta(days=_RUN_RETENTION_DAYS)
                ).isoformat()
                await session.execute(
                    ReconcileRunORM.__table__.delete().where(
                        ReconcileRunORM.started_at < cutoff
                    )
                )
                await session.commit()
        except Exception as exc:
            logger.warning("reconcile sweep: run record failed: %s", exc)


def _action_from(state, ctx_row, verdict, obs, *, acted: bool) -> _Action:
    return _Action(
        data_source_id=state.data_source_id,
        workspace_id=state.workspace_id,
        reason=verdict.reason,
        evidence=verdict.evidence,
        first_build=verdict.reason == "never_aggregated",
        name=ctx_row.get("name"),
        provider_id=ctx_row.get("provider_id"),
        provider_name=ctx_row.get("provider_name"),
        skip=verdict.skip,
        acted=acted,
        adopt_raw_fingerprint=obs.observed_raw_fingerprint,
        adopt_node_count=obs.node_count,
        adopt_edge_count=obs.observed_raw_edge_total,
        adopt_counts_digest=ctx_row.get("counts_digest"),
    )


def _finding_row(state, ctx_row, verdict, *, acted: bool, skip=None) -> Dict:
    return {
        "dataSourceId": state.data_source_id,
        "name": ctx_row.get("name"),
        "workspaceId": state.workspace_id,
        "providerId": ctx_row.get("provider_id"),
        "providerName": ctx_row.get("provider_name"),
        "reason": verdict.reason,
        "acted": acted,
        "skip": skip if skip is not None else verdict.skip,
        "evidence": verdict.evidence or {},
    }


def _within_cooldown(
    last_aggregated: Optional[datetime], interval_secs: int,
) -> bool:
    """Mirror of ``AggregationService._within_rebuild_cooldown``, taking the
    already-parsed timestamp. Kept as a plain function so Phase A can evaluate
    it over a batch without a service handle."""
    if interval_secs <= 0 or last_aggregated is None:
        return False
    elapsed = (datetime.now(timezone.utc) - last_aggregated).total_seconds()
    return elapsed < interval_secs


def _parse_iso(ts: Optional[str]) -> Optional[datetime]:
    """Tolerant ISO parse; assumes UTC when naive. ``None`` on bad input so a
    single malformed timestamp never breaks a fleet sweep."""
    if not ts:
        return None
    try:
        dt = datetime.fromisoformat(ts)
    except (TypeError, ValueError):
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


async def run_reconcile_sweeper(
    session_factory: Callable[[], Any],
    shutdown: asyncio.Event,
    service_getter: Optional[Callable[[], Any]] = None,
) -> None:
    """Entrypoint for the background task, mirroring ``run_reconciler``."""
    sweeper = ReconciliationSweeper(session_factory, service_getter)
    await sweeper.start(shutdown)
