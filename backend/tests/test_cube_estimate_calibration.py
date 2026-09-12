"""THE ESTIMATE AND THE BUDGET WERE MEASURING DIFFERENT THINGS.

The pre-compute estimate sums, over every raw lineage edge, the product of its
endpoints' ancestor-chain lengths. That counts cells PRODUCED. The graph stores
cells DISTINCT: the write is `MERGE (s)-[r:AGGREGATED {aggKey}]->(t)`, so many
raw edges between the same pair of containers collapse onto one cell and bump
its weight.

The two differ by roughly the mean weight — and aggregation exists to make that
number large. A graph compressing 50:1 estimates fifty times its real size, so
the gate refused graphs for being GOOD at the thing they were doing. A 700k-node
graph estimated at 30M cells and failed in seconds; the truth was nearer 600k.

The fix is not a better formula, because the upper bound is already sound. It is
knowing what to conclude from it:

* If the bound FITS, the real thing fits. That is the one sound inference and it
  stays a fast accept.
* If the bound does NOT fit, that says nothing about a number that can be fifty
  times too high — so an uncalibrated run proceeds, and the exact post-compute
  check refuses if it must, before any write reaches the shard.
* Once a complete run has measured both numbers, the ratio between them is a
  property of the graph's shape, stable run to run, and the estimate can be
  corrected by it.
"""
import pytest

from backend.app.providers.falkordb_materialize import AggregationPipeline


class _Pipeline:
    """The three methods under test, on a bare object.

    Constructing a real pipeline drags in a provider, a graph and a job; the
    arithmetic here depends on none of it.
    """

    def __init__(self, hints=None, upper=None, graph="g"):
        self._capacity_hints = dict(hints or {})
        self._cube_estimate_upper = upper
        self.p = type("P", (), {"_graph_name": graph})()

    _cell_ratio = AggregationPipeline._cell_ratio
    _corrected_estimate = AggregationPipeline._corrected_estimate
    _observed_cell_ratio = AggregationPipeline._observed_cell_ratio


# ── reading a stored ratio ───────────────────────────────────────────────


def test_no_measurement_yet_means_no_correction():
    p = _Pipeline()
    assert p._cell_ratio() is None
    assert p._corrected_estimate(30_000_000, None) == 30_000_000


def test_a_measured_ratio_scales_the_bound():
    """The case from production: 30M produced, ~2% of them distinct."""
    p = _Pipeline({"cell_ratio_observed": 0.02})
    assert p._cell_ratio() == 0.02
    assert p._corrected_estimate(30_000_000, 0.02) == 600_000


@pytest.mark.parametrize("bad", [0.0, -0.5, 1.5, 42, "", None, "nonsense", float("nan")])
def test_a_ratio_outside_its_domain_is_distrusted_not_applied(bad):
    """The bound is sound, so a ratio above 1 means one of the two numbers is
    not what it claims. The answer to that is to stop correcting, not to act
    on it — and an uncorrected run cannot refuse, so this fails open."""
    assert _Pipeline({"cell_ratio_observed": bad})._cell_ratio() is None


def test_a_ratio_of_exactly_one_is_valid():
    """A graph where no two raw edges share a container pair. Nothing
    collapses, so produced equals stored."""
    p = _Pipeline({"cell_ratio_observed": 1.0})
    assert p._cell_ratio() == 1.0
    assert p._corrected_estimate(1000, 1.0) == 1000


def test_a_correction_never_rounds_a_real_cube_away_to_nothing():
    """int() of a small product would floor to zero and read as "this graph
    stores nothing", which is a different lie."""
    assert _Pipeline()._corrected_estimate(10, 0.0001) == 1
    assert _Pipeline()._corrected_estimate(0, 0.02) == 0


# ── learning from a completed run ────────────────────────────────────────


def test_a_complete_run_teaches_the_ratio():
    p = _Pipeline(upper=30_000_000)
    assert p._observed_cell_ratio(600_000) == pytest.approx(0.02, abs=1e-6)


def test_a_run_that_measured_only_one_number_teaches_nothing():
    """No estimate pass ran, or nothing was stored. Half a measurement is
    worse than none: it would be applied to every future run."""
    assert _Pipeline(upper=None)._observed_cell_ratio(600_000) is None
    assert _Pipeline(upper=0)._observed_cell_ratio(600_000) is None
    assert _Pipeline(upper=30_000_000)._observed_cell_ratio(0) is None


def test_a_bound_that_did_not_bound_is_reported_not_stored(caplog):
    """Storing a ratio above 1 would INFLATE the next run's estimate — the
    exact failure this work exists to remove, arriving by the back door."""
    p = _Pipeline(upper=1000)
    with caplog.at_level("WARNING"):
        assert p._observed_cell_ratio(5000) is None
    assert "not bounding" in caplog.text


def test_the_learned_ratio_round_trips_through_the_correction():
    """What a run teaches is what the next run applies. If these drifted, the
    calibration would converge on the wrong number over time."""
    upper, exact = 30_000_000, 600_000
    ratio = _Pipeline(upper=upper)._observed_cell_ratio(exact)
    assert _Pipeline()._corrected_estimate(upper, ratio) == pytest.approx(
        exact, rel=0.01)


# ── the shape of the fix ─────────────────────────────────────────────────


def test_the_correction_only_ever_shrinks_an_estimate():
    """The ratio is bounded at 1, so a correction can never make the estimate
    LARGER than the bound. Calibration can open a gate that was wrongly shut;
    it can never shut one that was rightly open."""
    p = _Pipeline()
    for ratio in (0.001, 0.02, 0.5, 1.0):
        assert p._corrected_estimate(1_000_000, ratio) <= 1_000_000


def test_the_better_a_graph_aggregates_the_more_the_bound_overstated_it():
    """States the bug as a property. The estimate's error IS the compression
    ratio, so the graphs most worth aggregating were the most likely to be
    refused."""
    upper = 30_000_000
    compressing_well = _Pipeline()._corrected_estimate(upper, 0.01)   # 100:1
    compressing_badly = _Pipeline()._corrected_estimate(upper, 0.5)   # 2:1
    assert compressing_well < compressing_badly
    assert compressing_well == 300_000
