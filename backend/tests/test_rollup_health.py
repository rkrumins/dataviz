"""One reading of a graph's rollup health, shared by the projector and "Check sync".

The projector moves rollups by delta only when they are exactly what the raw edges imply;
otherwise it hands them to the aggregation job. "Check sync" reports the same verdict, so the
Data health panel can say "rebuild" for exactly the graphs a rebuild would repair.
"""
from backend.app.services.versioning.reconcile import RollupHealth


def _h(aggregated=0, stubs=0, baseline=False, maintained=False, interrupted=False):
    return RollupHealth(aggregated=aggregated, stubs=stubs, baseline=baseline,
                        maintained=maintained, reconcile_interrupted=interrupted)


def test_rollups_an_aggregation_run_derived_are_trusted_and_ok():
    h = _h(aggregated=10, baseline=True, maintained=True)
    assert h.trusted(lineage_edges=5) and h.status == "ok"


def test_stub_rollups_are_never_trusted():
    # The 2026-09-22 graph: 2,692 weightless rows replayed from an old import.
    h = _h(aggregated=2692, stubs=2692)
    assert not h.trusted(lineage_edges=369) and h.status == "untrusted"


def test_an_interrupted_reconcile_is_not_trusted_even_when_stamped():
    h = _h(aggregated=10, baseline=True, interrupted=True)
    assert not h.trusted(lineage_edges=5) and h.status == "untrusted"


def test_lineage_with_no_rollups_ever_written_is_missing():
    h = _h()
    assert not h.trusted(lineage_edges=3) and h.status == "missing"


def test_an_empty_graph_is_trivially_consistent():
    assert _h().trusted(lineage_edges=0)


def test_rollups_only_ever_moved_by_delta_are_not_a_baseline():
    # A first seed / eviction-restore / a graph no run ever covered: the batch job derives
    # them (and stamps _AggMeta) rather than trusting a partial set.
    h = _h(aggregated=40, maintained=True)
    assert not h.trusted(lineage_edges=40) and h.status == "ok"
