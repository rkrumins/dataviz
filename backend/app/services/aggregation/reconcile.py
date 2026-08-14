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
    "no_ontology",        # trigger() would raise OntologyResolutionError
    "no_stats",           # the stats service has never profiled it
    "stats_stale",        # counts too old to trust
    "stats_unhealthy",    # stats polling disabled, or erroring
    "in_flight",          # a rebuild is already pending/running
    "already_marked",     # the stale-marker reconciler owns it
    "cooldown",           # inside the rebuild throttle window
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
    "blocked", "unobservable", "suspended",
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
    recently_failed: bool = False
    # projection_mode == 'dedicated' ⇒ the overlay lives in ANOTHER graph
    # that get_stats() never scans, so observed_aggregated is meaningless.
    overlay_observable: bool = True

    # ── resolved policy ───────────────────────────────────────────────
    reconcile_enabled: bool = True


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


@dataclass(frozen=True)
class Verdict:
    """The outcome of evaluating one source.

    Exactly one of ``reason`` / ``skip`` is set. ``seed`` marks the
    first-sight case: the sweeper writes the baseline and acts on nothing.
    """
    data_source_id: str
    reason: Optional[str] = None
    skip: Optional[str] = None
    seed: bool = False
    drift_state: str = "inSync"
    evidence: Dict = field(default_factory=dict)

    @property
    def should_act(self) -> bool:
        return self.reason is not None


def evaluate(obs: Observation, policy: Policy) -> Verdict:
    """Guards, then detectors in precedence order. First match wins."""
    skip = _guard(obs, policy)
    if skip is not None:
        return Verdict(
            data_source_id=obs.data_source_id,
            skip=skip,
            drift_state=_SKIP_STATE.get(skip, _idle_state(obs)),
        )

    for detector in (
        _overlay_missing, _overlay_shrunk, _never_aggregated, _raw_drift,
    ):
        reason, evidence = detector(obs, policy)
        if reason is None:
            continue
        if not policy.allows(reason):
            # The condition holds but this detector is switched off. Report
            # the drift state anyway — the UI still shows the truth, we just
            # do not act on it.
            return Verdict(
                data_source_id=obs.data_source_id,
                skip="disabled",
                drift_state=_REASON_STATE[reason],
                evidence=evidence,
            )
        return Verdict(
            data_source_id=obs.data_source_id,
            reason=reason,
            drift_state=_REASON_STATE[reason],
            evidence={**_base_evidence(obs), **evidence},
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
    if obs.aggregation_status == "skipped":
        return "opted_out"
    if obs.ontology_id is None:
        # Without an ontology every trigger() raises OntologyResolutionError,
        # so acting would just log an error once an hour, forever. Surfaced
        # as 'blocked' in the UI — a genuinely useful signal on its own.
        return "no_ontology"
    if not obs.has_stats:
        return "no_stats"
    if not obs.stats_polling_enabled or obs.stats_last_status == "error":
        return "stats_unhealthy"
    if (
        obs.stats_age_secs is None
        or obs.stats_age_secs > policy.stats_max_age_secs
    ):
        # Acting on stale counts is how a false positive rebuilds a
        # multi-million-node graph. The sweeper nudges the stats poll instead.
        return "stats_stale"
    if obs.job_in_flight:
        return "in_flight"
    if obs.stale_marker:
        # A marked source already had its invalidation; the stale-marker
        # reconciler in scheduler.py owns its retry cadence. Two mechanisms
        # must never both retry the same rebuild.
        return "already_marked"
    if obs.in_cooldown:
        return "cooldown"
    if obs.recently_failed:
        return "failed_backoff"
    if not obs.reconcile_enabled:
        return "disabled"
    if obs.consecutive_actions >= policy.breaker_cap:
        # The breaker: something about this source makes the finding
        # un-clearable, and we have already rebuilt it breaker_cap times.
        # Stop, and surface it as needing a human.
        return "suspended"
    return None


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
