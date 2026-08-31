"""Reconciliation detectors — pure functions, no I/O.

Decides whether a data source's ``:AGGREGATED`` overlay has fallen out of
step with its raw graph, using ONLY the counts the stats service already
collects into ``public.data_source_stats``. No provider call, no graph
query, no session — everything here takes a plain observation snapshot and
returns a verdict, so the whole decision surface is unit-testable.

The sweeper (``reconcile_sweeper.py``) owns the I/O: it assembles the
snapshots, calls :func:`evaluate`, and dispatches whatever comes back.

Why this exists. An external system that reloads a data source rewrites the
raw nodes/edges with the same URNs but wipes the ``:AGGREGATED`` overlay.
Nothing detected that: ``aggregation_edge_count`` is written once by the
worker on completion and never re-verified, and the drift sweep in
``scheduler.py`` only covers sources with an ``aggregation_schedule`` cron
that nothing in the product ever sets.

Four detectors, first match wins:

    overlay_missing   the overlay was wiped     (the reported bug)
    overlay_shrunk    the overlay shrank while the raw graph did not
    never_aggregated  onboarded but never built (no overlay has ever existed)
    raw_drift         an external system changed the raw node/edge counts

Precondition guards run FIRST and short-circuit to a named skip reason, so
every "we did nothing" outcome is explainable rather than silent.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, Literal, Optional, Tuple

# ── Vocabulary ───────────────────────────────────────────────────────────
# Both tuples are the single source of truth for their vocabulary: the API
# schemas, the frontend labels and the tests all derive from them.

ReconcileReason = Literal[
    "overlay_missing", "overlay_shrunk", "never_aggregated", "raw_drift",
]

REASONS: Tuple[str, ...] = (
    "overlay_missing", "overlay_shrunk", "never_aggregated", "raw_drift",
)

# Every way a source can be passed over. Tallied per sweep so an operator can
# see WHY the fleet produced no findings — "nothing drifted" and "every stats
# row was stale" look identical without this.
SKIP_REASONS: Tuple[str, ...] = (
    "deleted",            # soft-deleted or deactivated data source
    "platform_mastered",  # versioned — the projector owns its rollups,
                          # and is demonstrably keeping up
    "projection_stalled",  # versioned, but the projector is NOT keeping up
    "no_ontology",        # trigger() would raise OntologyResolutionError
    "no_stats",           # the stats service has never profiled it
    "stats_stale",        # counts too old to trust
    "stats_unhealthy",    # stats polling disabled, or erroring
    "in_flight",          # a rebuild is already pending/running
    "already_marked",     # the stale-marker reconciler owns it
    "cooldown",           # inside the rebuild throttle window
    "paused",             # snoozed by an operator until a time
    "failed_backoff",     # last attempt failed inside the cadence window
    "opted_out",          # aggregation_status == 'skipped'
    "disabled",           # auto-reconcile turned off for this source
    "suspended",          # circuit breaker tripped
    "seeded",             # first sight: baseline adopted, nothing acted on
    "in_sync",            # evaluated, nothing wrong
)

# Drift verdict stamped on the state row at every evaluation, and read
# straight off the column by the freshness API. Stored rather than derived so
# the read path stays pure SQL — it must never run detection work.
DRIFT_STATES: Tuple[str, ...] = (
    "inSync", "drifting", "overlayMissing", "neverBuilt",
    "blocked", "unobservable", "suspended", "managed",
    # RED, and worse than ``drifting``. ``drifting`` says the raw graph moved
    # and the rollups need rebuilding; this says the rollups are not being
    # SERVED AT ALL — while the projection watermark trails the published head
    # every main read falls back to the version log, which holds none, so
    # aggregated lineage is missing from the product right now. Deliberately
    # NOT folded onto ``drifting``: that would under-state the problem and
    # point the operator at a rebuild, which is not the fix.
    "projectionStalled",
)

# Reason → the drift state it implies.
_REASON_STATE: Dict[str, str] = {
    "overlay_missing": "overlayMissing",
    "overlay_shrunk": "overlayMissing",
    "never_aggregated": "neverBuilt",
    "raw_drift": "drifting",
}

# Skip reasons that are themselves a verdict worth showing in the UI, rather
# than merely "not evaluated this pass".
_SKIP_STATE: Dict[str, str] = {
    "no_ontology": "blocked",
    "suspended": "suspended",
    "in_sync": "inSync",
    "platform_mastered": "managed",
    "projection_stalled": "projectionStalled",
}


@dataclass(frozen=True)
class Observation:
    """Everything the detectors need about one data source, already read.

    Assembled by the sweeper from four batched queries. Deliberately flat and
    optional-heavy: any field the sweeper could not resolve is ``None``, and a
    guard turns that into a named skip rather than an exception.
    """
    data_source_id: str
    workspace_id: Optional[str] = None
    provider_id: Optional[str] = None

    # ── public.workspace_data_sources ────────────────────────────────
    deleted: bool = False
    ontology_id: Optional[str] = None
    # Mastered by the versioning store (a live ``graphver.graphs`` row), so
    # Postgres is the source of truth and FalkorDB a rebuildable read cache.
    # Resolved by the sweeper; see ``_guard``.
    platform_mastered: bool = False

    # ── graphver.projection_state ⋈ graphver.graphs ────────────────────
    # Only ever populated for a platform-mastered source, and only from a
    # graph that is actually PINNED to a FalkorDB target — an unpinned graph
    # projects nothing by design and must never read as wedged. All None
    # means "not versioned, or nothing is projected here"; the sweeper never
    # reaches evaluation with these unknown for a versioned source, because a
    # health lookup it cannot answer defers the whole pass.
    projection_commits_behind: Optional[int] = None
    projection_last_error: Optional[str] = None
    projection_checked_at: Optional[str] = None
    # A projection pass is running for this graph right now. The watermark
    # legitimately trails the head while one is in flight, so this is the
    # normal state for the seconds after every publish rather than a wedge.
    projection_in_progress: bool = False

    # ── public.data_source_stats (the stats service's output) ─────────
    has_stats: bool = False
    stats_age_secs: Optional[int] = None
    stats_as_of: Optional[str] = None
    node_count: int = 0
    observed_aggregated: int = 0
    observed_raw_fingerprint: Optional[str] = None
    observed_raw_edge_total: int = 0

    # ── public.data_source_polling_configs ────────────────────────────
    stats_polling_enabled: bool = True
    stats_last_status: Optional[str] = None

    # ── aggregation.data_source_state ─────────────────────────────────
    has_state: bool = False
    aggregation_status: Optional[str] = None
    expected_aggregated: int = 0
    stored_raw_fingerprint: Optional[str] = None
    stored_raw_node_count: Optional[int] = None
    stored_raw_edge_count: Optional[int] = None
    consecutive_actions: int = 0

    # ── derived elsewhere (cheap lookups the sweeper already does) ─────
    job_in_flight: bool = False
    has_completed_job: bool = False
    stale_marker: bool = False
    in_cooldown: bool = False
    # Operator snooze. ISO-8601, or None. A HOLD, never a guard: a paused
    # source is still evaluated and still reports its finding, so the cockpit
    # can show what is wrong with something it has been told to leave alone.
    paused_until: Optional[str] = None
    recently_failed: bool = False
    # projection_mode == 'dedicated' ⇒ the overlay lives in ANOTHER graph
    # that get_stats() never scans, so observed_aggregated is meaningless.
    overlay_observable: bool = True
    # Operator Check now / Preview refreshed counts from the live graph —
    # the stats_stale guard must not block a verdict we just observed.
    live_observed: bool = False

    # ── resolved policy ───────────────────────────────────────────────
    reconcile_enabled: bool = True

    @property
    def projection_stalled(self) -> bool:
        """The projector that owns this source's rollups is not current.

        ONE narrow fact: the watermark trails the published head and no pass is
        closing the gap. That is precisely — and only — what every string this
        verdict renders asserts. Main reads fall back to the version log, which
        holds no ``:AGGREGATED`` rows, so aggregated lineage is missing from
        the product right now, and it clears on its own the moment the
        watermark catches up.

        Two readings are deliberately NOT this state, because for neither is
        any of that sentence true:

        * A pass in flight (``projecting``/``rebuilding``). It is working, not
          wedged; the prescribed action ("someone has to look at version
          control for it") is wrong, and a verdict that fires on ordinary
          operation is a verdict operators learn to ignore. The drift
          reconciler and the infrastructure panel already exclude it.
        * A recorded ``last_error`` on a graph that has caught up. A failed
          verify deliberately holds the watermark back, so a projector really
          failing to publish is already behind; what is left over is a stale
          error from a pass that ran weeks ago, which nothing ever clears. Ten
          live graphs sat in that shape permanently. It stays EVIDENCE
          (``projection_last_error``, still on the wire and still in the
          infrastructure panel's not-publishing list), not a verdict.
        """
        if self.projection_in_progress:
            return False
        behind = self.projection_commits_behind
        return behind is not None and behind > 0


@dataclass(frozen=True)
class Policy:
    """Resolved detection knobs for one evaluation."""
    stats_max_age_secs: int = 2700
    shrink_tolerance_pct: int = 10
    breaker_cap: int = 3
    detectors: Optional[Tuple[str, ...]] = None  # None = all enabled

    def allows(self, reason: str) -> bool:
        """``detectors`` unset means every detector is on. An EMPTY tuple
        means every detector is OFF — so this must test ``is None``, never
        truthiness."""
        if self.detectors is None:
            return True
        return reason in self.detectors


# Holds: the condition is real, but we refuse to queue a rebuild. Detectors
# still run so the cockpit has a reason and the counts behind it. Distinct
# from absolute guards (deleted, no stats, …) which cannot evaluate at all.
_HOLD_SKIPS: Tuple[str, ...] = (
    "cooldown", "failed_backoff", "disabled", "suspended", "paused",
)


@dataclass(frozen=True)
class Verdict:
    """The outcome of evaluating one source.

    A clean finding has ``reason`` and no ``skip``. An absolute skip has
    ``skip`` and no ``reason``. A *hold* has both: the drift is real, but
    we refuse to act (cooldown, automation off, breaker).

    ``drift_state`` is ``None`` when this pass did not evaluate the overlay
    (stats stale, no stats, …) — the sweeper must leave the prior stamp alone
    rather than claiming ``inSync``.
    """
    data_source_id: str
    reason: Optional[str] = None
    skip: Optional[str] = None
    seed: bool = False
    drift_state: Optional[str] = "inSync"
    evidence: Dict = field(default_factory=dict)

    @property
    def should_act(self) -> bool:
        return self.reason is not None and self.skip is None


def evaluate(obs: Observation, policy: Policy) -> Verdict:
    """Guards, then detectors in precedence order. First match wins."""
    skip = _guard(obs, policy)
    if skip is not None:
        return Verdict(
            data_source_id=obs.data_source_id,
            skip=skip,
            # Named skip states only — everything else preserves the prior stamp.
            drift_state=_SKIP_STATE.get(skip),
            evidence=(
                _projection_evidence(obs) if skip == "projection_stalled"
                else {}
            ),
        )

    for detector in (
        _overlay_missing, _overlay_shrunk, _never_aggregated, _raw_drift,
    ):
        reason, evidence = detector(obs, policy)
        if reason is None:
            continue
        packed = {**_base_evidence(obs), **evidence}
        if not policy.allows(reason):
            # The condition holds but this detector is switched off. Report
            # the drift state anyway — the UI still shows the truth, we just
            # do not act on it.
            return Verdict(
                data_source_id=obs.data_source_id,
                skip="disabled",
                drift_state=_REASON_STATE[reason],
                evidence=packed,
            )
        hold = _hold(obs, policy)
        if hold is not None:
            return Verdict(
                data_source_id=obs.data_source_id,
                reason=reason,
                skip=hold,
                drift_state=(
                    "suspended" if hold == "suspended"
                    else _REASON_STATE[reason]
                ),
                evidence=packed,
            )
        return Verdict(
            data_source_id=obs.data_source_id,
            reason=reason,
            drift_state=_REASON_STATE[reason],
            evidence=packed,
        )

    # Nothing wrong. A source with no baseline yet still needs one written.
    if obs.stored_raw_fingerprint is None:
        return Verdict(
            data_source_id=obs.data_source_id, skip="seeded", seed=True,
            drift_state=_idle_state(obs),
        )
    return Verdict(
        data_source_id=obs.data_source_id, skip="in_sync",
        drift_state=_idle_state(obs),
    )


# ── Guards ───────────────────────────────────────────────────────────────

def _guard(obs: Observation, policy: Policy) -> Optional[str]:
    """First failing precondition, or None. Order matters: the cheapest and
    most absolute conditions come first, and the ones that mean "someone
    else owns this source" come before the ones that mean "not yet"."""
    if obs.deleted:
        return "deleted"
    if obs.platform_mastered:
        # A versioned source inverts everything below. Postgres is the source
        # of truth and FalkorDB a rebuildable read cache, so when the
        # projection is not fresh the stats scan runs against Postgres — which
        # has no :AGGREGATED rows by construction. ``observed_aggregated`` is
        # then 0 for a perfectly healthy source, and ``overlay_missing`` would
        # fire every sweep. Raw drift is no better: every publish moves the
        # counts, and the projector nudges the stats poll seconds later.
        #
        # Nor is there anything to do. FalkorProjector maintains :AGGREGATED
        # incrementally per committed window from the same pair rules the batch
        # pipeline uses, and hands off to ``agg.trigger()`` via
        # ``on_rollups_stale`` wherever it cannot (full seed, oversized move
        # window, verify-heal reseed) — on all three projector wirings.
        #
        # So this comes SECOND, ahead of every "someone else owns this" guard,
        # because that is exactly what it asserts. Recorded and surfaced as
        # 'managed', never acted on.
        #
        # BUT ONLY WHILE THE PROJECTOR IS ACTUALLY KEEPING UP. That whole
        # justification is a claim about a running subsystem, and for fourteen
        # hours on 2026-08-30 the claim was false: a wedged projection left
        # ``projected_commit_seq`` below ``main_head_commit_seq``, every main
        # read fell back to the version log — which holds no ``:AGGREGATED``
        # rows — and aggregated lineage disappeared from the canvas while this
        # guard kept stamping 'managed', i.e. "someone else owns this and is
        # doing fine". So the claim is now VERIFIED rather than assumed.
        #
        # Still never acted on: a versioned source's recovery is a deliberate
        # operator action on the projector, not a rebuild the sweep can queue.
        # This is report-only, and it is the report that was missing.
        if obs.projection_stalled:
            return "projection_stalled"
        return "platform_mastered"
    if obs.aggregation_status == "skipped":
        return "opted_out"
    if obs.ontology_id is None:
        # Without an ontology every trigger() raises OntologyResolutionError,
        # so acting would just log an error once an hour, forever. Surfaced
        # as 'blocked' in the UI — a genuinely useful signal on its own.
        return "no_ontology"
    if not obs.has_stats and not obs.live_observed:
        return "no_stats"
    if not obs.stats_polling_enabled or obs.stats_last_status == "error":
        # Live observe already proved the graph is reachable — a broken poll
        # config must not block an operator Check now.
        if not obs.live_observed:
            return "stats_unhealthy"
    if (
        not obs.live_observed
        and (
            obs.stats_age_secs is None
            or obs.stats_age_secs > policy.stats_max_age_secs
        )
    ):
        # Acting on stale counts is how a false positive rebuilds a
        # multi-million-node graph. The sweeper nudges the stats poll instead.
        # Operator Check now / Preview refresh counts first (live_observed).
        return "stats_stale"
    if obs.job_in_flight:
        return "in_flight"
    if obs.stale_marker:
        # A marked source already had its invalidation; the stale-marker
        # reconciler in scheduler.py owns its retry cadence. Two mechanisms
        # must never both retry the same rebuild.
        return "already_marked"
    return None


def _hold(obs: Observation, policy: Policy) -> Optional[str]:
    """Post-detector refusal to act. Unlike ``_guard``, these run AFTER the
    detectors so a held source still carries a reason and evidence."""
    if _pause_active(obs.paused_until):
        return "paused"
    if obs.in_cooldown:
        return "cooldown"
    if obs.recently_failed:
        return "failed_backoff"
    if not obs.reconcile_enabled:
        return "disabled"
    if obs.consecutive_actions >= policy.breaker_cap:
        return "suspended"
    return None


def _pause_active(paused_until: Optional[str]) -> bool:
    """True while a snooze is still in force. An unparseable stamp is treated
    as expired: a corrupt value must not pause a source forever."""
    if not paused_until:
        return False
    from datetime import datetime, timezone
    try:
        until = datetime.fromisoformat(paused_until)
    except (TypeError, ValueError):
        return False
    if until.tzinfo is None:
        until = until.replace(tzinfo=timezone.utc)
    return until > datetime.now(timezone.utc)


def _idle_state(obs: Observation) -> str:
    """Drift state for a source we did not find a fault in."""
    if not obs.overlay_observable:
        return "unobservable"
    if not obs.has_completed_job and obs.aggregation_status in (None, "none"):
        return "neverBuilt"
    return "inSync"


# ── Detectors ────────────────────────────────────────────────────────────

def _overlay_missing(obs, policy) -> Tuple[Optional[str], Dict]:
    """The overlay was wiped: it used to have edges, now it has none.

    ``expected_aggregated > 0`` is load-bearing. A containment-only graph
    legitimately materialises a zero-edge cube, and without that clause this
    detector would fire on it every sweep forever.

    Requires an observable overlay — see ``overlay_observable``.
    """
    if not obs.overlay_observable:
        return None, {}
    if obs.aggregation_status != "ready":
        return None, {}
    if obs.expected_aggregated <= 0:
        return None, {}
    if obs.observed_aggregated != 0:
        return None, {}
    return "overlay_missing", {
        "rawChanged": (
            obs.stored_raw_fingerprint is not None
            and obs.stored_raw_fingerprint != obs.observed_raw_fingerprint
        ),
    }


def _overlay_shrunk(obs, policy) -> Tuple[Optional[str], Dict]:
    """The overlay shrank materially while the raw graph did not.

    Gated on the raw fingerprint being UNCHANGED: if the raw data shrank, a
    smaller rollup is the correct answer, not a fault.

    The tolerance is a correctness requirement, not a nicety.
    ``expected_aggregated`` is a job-computed cube total and
    ``observed_aggregated`` a graph count taken at a different instant, so a
    strict ``<`` would fire constantly.
    """
    if not obs.overlay_observable:
        return None, {}
    if obs.aggregation_status != "ready":
        return None, {}
    if obs.expected_aggregated <= 0 or obs.observed_aggregated <= 0:
        return None, {}
    if obs.stored_raw_fingerprint is None:
        return None, {}
    if obs.stored_raw_fingerprint != obs.observed_raw_fingerprint:
        return None, {}
    floor = obs.expected_aggregated * (1 - policy.shrink_tolerance_pct / 100)
    if obs.observed_aggregated >= floor:
        return None, {}
    return "overlay_shrunk", {
        "shrinkTolerancePct": policy.shrink_tolerance_pct,
        "shrinkFloor": int(floor),
    }


def _never_aggregated(obs, policy) -> Tuple[Optional[str], Dict]:
    """Onboarded, has data and an ontology, but no overlay has ever been built.

    Deliberately keyed on ``aggregation_status`` and job history rather than
    the observed count, so it works for a dedicated-projection source whose
    overlay this sweep cannot see.
    """
    if obs.has_completed_job:
        return None, {}
    if obs.aggregation_status not in (None, "none"):
        return None, {}
    if obs.node_count <= 0:
        return None, {}
    return "never_aggregated", {}


def _raw_drift(obs, policy) -> Tuple[Optional[str], Dict]:
    """An external system changed the raw node/edge counts.

    A NULL stored fingerprint is a SEED, never a finding — otherwise the very
    first sweep would classify the entire fleet as drifted and queue a
    fleet-wide rebuild.
    """
    if obs.aggregation_status != "ready":
        return None, {}
    if obs.stored_raw_fingerprint is None:
        return None, {}
    if obs.stored_raw_fingerprint == obs.observed_raw_fingerprint:
        return None, {}
    return "raw_drift", {}


def _projection_evidence(obs: Observation) -> Dict:
    """Why we refused to call a versioned source healthy, in the operator's
    own units. Deliberately NOT merged into ``_base_evidence``: the raw
    node/edge counts a projection-stalled source reports were measured against
    whichever backend happened to answer, and quoting them beside this verdict
    would invite exactly the "so rebuild it" reading this state exists to
    prevent."""
    return {
        "projectionCommitsBehind": obs.projection_commits_behind,
        "projectionLastError": obs.projection_last_error,
        "projectionCheckedAt": obs.projection_checked_at,
    }


def _base_evidence(obs: Observation) -> Dict:
    """The numbers every finding carries, so the audit trail can always
    answer "why did this fire" in the operator's own units."""
    return {
        "expectedAggregatedEdges": obs.expected_aggregated,
        "observedAggregatedEdges": obs.observed_aggregated,
        "rawNodeCountBefore": obs.stored_raw_node_count,
        "rawNodeCountAfter": obs.node_count,
        "rawEdgeCountBefore": obs.stored_raw_edge_count,
        "rawEdgeCountAfter": obs.observed_raw_edge_total,
        "rawFingerprintBefore": obs.stored_raw_fingerprint,
        "rawFingerprintAfter": obs.observed_raw_fingerprint,
        "statsAsOf": obs.stats_as_of,
        "statsAgeSecs": obs.stats_age_secs,
    }
