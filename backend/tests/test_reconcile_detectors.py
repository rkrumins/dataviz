"""Unit tests for the reconciliation detectors and their preconditions.

Everything here is pure: :func:`evaluate` takes an ``Observation`` and a
``Policy`` and returns a ``Verdict``. No DB, no Redis, no provider.

The regressions these lock down are the ones that would each have been a
production incident:

  * a dedicated-projection source reading as a permanently-wiped overlay
    (its :AGGREGATED edges live in a graph ``get_stats()`` never scans),
  * the first sweep classifying an entire fleet as drifted,
  * a containment-only graph, whose cube is legitimately empty, rebuilding
    itself once an hour forever,
  * ``detectors=[]`` being read as "unset" instead of "all off".
"""
import pytest

from backend.app.services.aggregation.fingerprint import (
    fingerprint_from_stats,
    raw_fingerprint_from_counts,
)
from backend.app.services.aggregation.reconcile import (
    DRIFT_STATES,
    REASONS,
    SKIP_REASONS,
    Observation,
    Policy,
    evaluate,
)


# ── Builders ────────────────────────────────────────────────────────────
# A healthy, freshly-profiled, ready source that trips no detector. Each
# test perturbs exactly the fields it is about, so a failure names its cause.

def _obs(**over) -> Observation:
    base = dict(
        data_source_id="ds_1",
        workspace_id="ws_1",
        ontology_id="bp_1",
        has_stats=True,
        stats_age_secs=60,
        stats_as_of="2026-08-14T10:00:00+00:00",
        node_count=1_000,
        observed_aggregated=500,
        observed_raw_fingerprint="fp_same",
        observed_raw_edge_total=2_000,
        has_state=True,
        aggregation_status="ready",
        expected_aggregated=500,
        stored_raw_fingerprint="fp_same",
        stored_raw_node_count=1_000,
        stored_raw_edge_count=2_000,
        has_completed_job=True,
    )
    base.update(over)
    return Observation(**base)


POLICY = Policy()


# ── The healthy baseline ────────────────────────────────────────────────

def test_healthy_source_is_in_sync():
    v = evaluate(_obs(), POLICY)
    assert v.reason is None
    assert v.skip == "in_sync"
    assert v.drift_state == "inSync"


# ── D1 overlay_missing ──────────────────────────────────────────────────

def test_overlay_missing_fires_when_edges_wiped():
    v = evaluate(_obs(observed_aggregated=0), POLICY)
    assert v.reason == "overlay_missing"
    assert v.drift_state == "overlayMissing"
    assert v.should_act
    assert v.evidence["expectedAggregatedEdges"] == 500
    assert v.evidence["observedAggregatedEdges"] == 0


def test_overlay_missing_does_not_fire_on_legitimately_empty_cube():
    """A containment-only graph materialises zero AGGREGATED edges. Without
    the ``expected > 0`` clause this source rebuilds forever."""
    v = evaluate(_obs(observed_aggregated=0, expected_aggregated=0), POLICY)
    assert v.reason is None


def test_overlay_missing_does_not_fire_when_not_ready():
    v = evaluate(
        _obs(observed_aggregated=0, aggregation_status="failed"), POLICY,
    )
    assert v.reason is None


def test_overlay_missing_records_whether_raw_also_changed():
    v = evaluate(
        _obs(observed_aggregated=0, observed_raw_fingerprint="fp_new"), POLICY,
    )
    assert v.reason == "overlay_missing"
    assert v.evidence["rawChanged"] is True


# ── The dedicated-projection blind spot ─────────────────────────────────

def test_dedicated_projection_never_reports_a_wiped_overlay():
    """``get_stats()`` scans the SOURCE graph only. For a dedicated
    projection the overlay lives in another graph, so observed_aggregated is
    permanently 0 — and dedicated projection is used for the LARGEST graphs.
    Firing here would rebuild them hourly, forever."""
    v = evaluate(
        _obs(observed_aggregated=0, overlay_observable=False), POLICY,
    )
    assert v.reason is None
    assert v.drift_state == "unobservable"


def test_dedicated_projection_still_detects_raw_drift():
    """Raw drift excludes AGGREGATED entirely, so it stays valid when the
    overlay is unobservable."""
    v = evaluate(
        _obs(observed_raw_fingerprint="fp_new", overlay_observable=False),
        POLICY,
    )
    assert v.reason == "raw_drift"


def test_dedicated_projection_still_detects_never_aggregated():
    v = evaluate(
        _obs(
            aggregation_status=None, has_completed_job=False,
            expected_aggregated=0, observed_aggregated=0,
            overlay_observable=False, stored_raw_fingerprint=None,
        ),
        POLICY,
    )
    assert v.reason == "never_aggregated"


# ── D2 overlay_shrunk ───────────────────────────────────────────────────

def test_overlay_shrunk_respects_the_tolerance_band():
    """9% down is noise; 11% down is a finding."""
    assert evaluate(_obs(observed_aggregated=455), POLICY).reason is None
    assert (
        evaluate(_obs(observed_aggregated=440), POLICY).reason
        == "overlay_shrunk"
    )


def test_overlay_shrunk_suppressed_when_raw_data_changed():
    """A real raw shrink legitimately shrinks the cube — not a fault."""
    v = evaluate(
        _obs(observed_aggregated=100, observed_raw_fingerprint="fp_new"),
        POLICY,
    )
    assert v.reason == "raw_drift"  # falls through to D4, not D2


# ── D3 never_aggregated ─────────────────────────────────────────────────

def _never_built(**over) -> Observation:
    base = dict(
        aggregation_status=None, has_state=False, has_completed_job=False,
        expected_aggregated=0, observed_aggregated=0,
        stored_raw_fingerprint=None,
    )
    base.update(over)
    return _obs(**base)


def test_never_aggregated_fires_for_an_onboarded_unbuilt_source():
    v = evaluate(_never_built(), POLICY)
    assert v.reason == "never_aggregated"
    assert v.drift_state == "neverBuilt"


def test_never_aggregated_requires_an_ontology():
    v = evaluate(_never_built(ontology_id=None), POLICY)
    assert v.reason is None
    assert v.skip == "no_ontology"
    assert v.drift_state == "blocked"


def test_never_aggregated_requires_nodes():
    assert evaluate(_never_built(node_count=0), POLICY).reason is None


def test_never_aggregated_does_not_fire_after_a_completed_job():
    assert evaluate(_never_built(has_completed_job=True), POLICY).reason is None


# ── D4 raw_drift ────────────────────────────────────────────────────────

def test_raw_drift_fires_on_a_changed_fingerprint():
    v = evaluate(
        _obs(
            observed_raw_fingerprint="fp_new",
            observed_raw_edge_total=9_000, node_count=4_000,
        ),
        POLICY,
    )
    assert v.reason == "raw_drift"
    assert v.drift_state == "drifting"
    assert v.evidence["rawNodeCountBefore"] == 1_000
    assert v.evidence["rawNodeCountAfter"] == 4_000
    assert v.evidence["rawEdgeCountBefore"] == 2_000
    assert v.evidence["rawEdgeCountAfter"] == 9_000


def test_null_baseline_seeds_and_never_acts():
    """The fleet-wide-storm regression: on first sight there is no baseline,
    so every source would otherwise look drifted."""
    v = evaluate(
        _obs(stored_raw_fingerprint=None, observed_raw_fingerprint="fp_x"),
        POLICY,
    )
    assert v.reason is None
    assert v.seed is True
    assert v.skip == "seeded"


# ── Precedence ──────────────────────────────────────────────────────────

def test_overlay_missing_outranks_raw_drift():
    v = evaluate(
        _obs(observed_aggregated=0, observed_raw_fingerprint="fp_new"), POLICY,
    )
    assert v.reason == "overlay_missing"


# ── Guards ──────────────────────────────────────────────────────────────

@pytest.mark.parametrize("over,expected", [
    ({"deleted": True}, "deleted"),
    ({"aggregation_status": "skipped"}, "opted_out"),
    ({"ontology_id": None}, "no_ontology"),
    ({"has_stats": False}, "no_stats"),
    ({"stats_polling_enabled": False}, "stats_unhealthy"),
    ({"stats_last_status": "error"}, "stats_unhealthy"),
    ({"stats_age_secs": 99_999}, "stats_stale"),
    ({"stats_age_secs": None}, "stats_stale"),
    ({"job_in_flight": True}, "in_flight"),
    ({"stale_marker": True}, "already_marked"),
    ({"in_cooldown": True}, "cooldown"),
    ({"recently_failed": True}, "failed_backoff"),
    ({"reconcile_enabled": False}, "disabled"),
    ({"consecutive_actions": 3}, "suspended"),
])
def test_each_guard_short_circuits_with_its_own_reason(over, expected):
    """Every guard fires on a source that would OTHERWISE be a finding, so
    the test proves the guard suppressed it rather than nothing being wrong."""
    v = evaluate(_obs(observed_aggregated=0, **over), POLICY)
    assert v.skip == expected
    assert v.reason is None


def test_stale_stats_never_trigger_a_rebuild():
    """Acting on stale counts is how a false positive rebuilds a
    multi-million-node graph."""
    v = evaluate(_obs(observed_aggregated=0, stats_age_secs=3_600), POLICY)
    assert v.skip == "stats_stale"


def test_a_marked_source_is_left_to_the_stale_marker_reconciler():
    v = evaluate(_obs(observed_aggregated=0, stale_marker=True), POLICY)
    assert v.skip == "already_marked"


# ── Detector toggles ────────────────────────────────────────────────────

def test_a_disabled_detector_still_reports_the_drift_state():
    """Turning a detector off stops us ACTING, not seeing — the cockpit must
    stay honest about drift even where automation is off."""
    policy = Policy(detectors=("raw_drift",))
    v = evaluate(_obs(observed_aggregated=0), policy)
    assert v.reason is None
    assert v.skip == "disabled"
    assert v.drift_state == "overlayMissing"


def test_empty_detector_tuple_means_all_off_not_unset():
    """``detectors=[]`` is a real configuration, not a missing one. A
    truthiness check here would silently re-enable everything."""
    v = evaluate(_obs(observed_aggregated=0), Policy(detectors=()))
    assert v.reason is None
    assert v.skip == "disabled"


def test_unset_detectors_means_all_enabled():
    assert evaluate(_obs(observed_aggregated=0), Policy()).reason == "overlay_missing"


# ── The raw fingerprint itself ──────────────────────────────────────────

def test_raw_fingerprint_excludes_aggregated_case_insensitively():
    a, agg_a, edges_a = raw_fingerprint_from_counts(
        {"Table": 10}, {"FLOWS_TO": 5, "AGGREGATED": 900},
    )
    b, agg_b, edges_b = raw_fingerprint_from_counts(
        {"Table": 10}, {"FLOWS_TO": 5, "aggregated": 900},
    )
    assert a == b
    assert agg_a == agg_b == 900
    assert edges_a == edges_b == 5


def test_raw_fingerprint_is_invariant_across_a_rebuild():
    """THE core invariant. A rebuild changes only the AGGREGATED count, so
    the baseline it is compared against must not move — otherwise every
    successful rebuild looks like fresh drift and re-triggers itself."""
    before, _, _ = raw_fingerprint_from_counts(
        {"Table": 10}, {"FLOWS_TO": 5, "AGGREGATED": 0},
    )
    after, _, _ = raw_fingerprint_from_counts(
        {"Table": 10}, {"FLOWS_TO": 5, "AGGREGATED": 1_204_318},
    )
    assert before == after


def test_raw_fingerprint_moves_when_raw_counts_move():
    a, _, _ = raw_fingerprint_from_counts({"Table": 10}, {"FLOWS_TO": 5})
    b, _, _ = raw_fingerprint_from_counts({"Table": 11}, {"FLOWS_TO": 5})
    c, _, _ = raw_fingerprint_from_counts({"Table": 10}, {"FLOWS_TO": 6})
    assert a != b and a != c


def test_raw_fingerprint_is_a_separate_namespace_from_the_schema_digest():
    """Reusing ``fingerprint_from_stats`` as the drift baseline is the bug
    this separation exists to prevent — it includes AGGREGATED."""
    class _S:
        entity_type_stats = [type("E", (), {"id": "Table", "count": 10})()]
        edge_type_stats = [type("E", (), {"id": "FLOWS_TO", "count": 5})()]

    raw, _, _ = raw_fingerprint_from_counts({"Table": 10}, {"FLOWS_TO": 5})
    assert raw != fingerprint_from_stats(_S())


# ── The vocabularies the UI mirrors ─────────────────────────────────────


@pytest.mark.parametrize("over", [
    {},                                                   # in sync
    {"observed_aggregated": 0},                           # overlay_missing
    {"observed_aggregated": 440},                         # overlay_shrunk
    {"observed_raw_fingerprint": "fp_new"},               # raw_drift
    {"deleted": True},
    {"ontology_id": None},
    {"has_stats": False},
    {"stats_age_secs": 99_999},
    {"job_in_flight": True},
    {"stale_marker": True},
    {"in_cooldown": True},
    {"recently_failed": True},
    {"reconcile_enabled": False},
    {"consecutive_actions": 5},
    {"overlay_observable": False, "observed_aggregated": 0},
    {"stored_raw_fingerprint": None},                     # seeded
])
def test_every_verdict_uses_the_published_vocabulary(over):
    """``REASONS``, ``SKIP_REASONS`` and ``DRIFT_STATES`` are what the frontend
    mirrors — its labels, its facet predicate and its badge specs are all keyed
    off them. A verdict outside those sets would render as a blank badge or an
    uncounted row, so nothing may invent a value."""
    v = evaluate(_obs(**over), POLICY)
    assert v.reason is None or v.reason in REASONS
    assert v.skip is None or v.skip in SKIP_REASONS
    assert v.drift_state in DRIFT_STATES


def test_a_verdict_is_either_a_finding_or_a_skip_never_both():
    for over in ({}, {"observed_aggregated": 0}, {"deleted": True}):
        v = evaluate(_obs(**over), POLICY)
        assert (v.reason is None) != (v.skip is None)
        assert v.should_act == (v.reason is not None)


def test_unparseable_counts_degrade_to_zero_rather_than_raising():
    fp, agg, edges = raw_fingerprint_from_counts(
        {"Table": "oops"}, {"FLOWS_TO": None, "AGGREGATED": "x"},
    )
    assert fp and agg == 0 and edges == 0


def test_missing_counts_are_tolerated():
    fp, agg, edges = raw_fingerprint_from_counts(None, None)
    assert fp and agg == 0 and edges == 0
