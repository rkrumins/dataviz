"""Shaping observations into series — the rules a reader actually sees.

Pure functions, no database. Every test here pins a decision about what a
chart is allowed to imply.
"""
import json
from dataclasses import dataclass
from typing import Optional

from backend.app.services import profiling_series as ps


@dataclass(frozen=True)
class Obs:
    data_source_id: str
    bucket: str
    node_count: int = 0
    edge_count: int = 0
    entity_type_counts: str = "{}"
    edge_type_counts: str = "{}"
    node_min: Optional[int] = None
    node_max: Optional[int] = None
    edge_min: Optional[int] = None
    edge_max: Optional[int] = None
    node_delta: Optional[int] = None
    edge_delta: Optional[int] = None


def _o(source, bucket, nodes=0, edges=0, types=None, edge_types=None, **kw):
    return Obs(
        data_source_id=source, bucket=bucket,
        node_count=nodes, edge_count=edges,
        entity_type_counts=json.dumps(types or {}),
        edge_type_counts=json.dumps(edge_types or {}),
        **kw,
    )


# ── metric selection ─────────────────────────────────────────────────


def test_total_draws_entities_and_relationships_as_two_series():
    out = ps.build_series(
        [_o("a", "2026-08-01", nodes=10, edges=5)], metric="total",
    )
    assert [s["key"] for s in out["series"]] == ["nodes", "edges"]
    assert out["totals"]["total"] == [15]


def test_a_single_metric_draws_one_series():
    out = ps.build_series(
        [_o("a", "2026-08-01", nodes=10, edges=5)], metric="edges",
    )
    assert [s["key"] for s in out["series"]] == ["edges"]
    assert out["series"][0]["points"][0]["v"] == 5


def test_an_unknown_metric_falls_back_rather_than_blanking():
    """A bad query param should show you everything, not nothing."""
    out = ps.build_series([_o("a", "2026-08-01", nodes=10)], metric="nonsense")
    assert [s["key"] for s in out["series"]] == ["nodes", "edges"]


# ── carry-forward across sources ─────────────────────────────────────


def test_a_source_that_did_not_report_keeps_its_last_value():
    """Sources are not observed in lockstep. Summing only those that reported
    in a bucket makes the total dip whenever one was quiet — which reads as
    data loss, and is the exact signal this feature must not fake."""
    out = ps.build_series([
        _o("a", "2026-08-01", nodes=100),
        _o("b", "2026-08-01", nodes=50),
        _o("a", "2026-08-02", nodes=110),
        # b was not observed on the 2nd.
    ], metric="nodes")
    assert out["totals"]["nodes"] == [150, 160], "b still counts at 50"


def test_a_source_contributes_nothing_before_its_first_observation():
    """Carrying a value backwards would invent history for a source that did
    not yet exist — the opposite of the problem carry-forward solves."""
    out = ps.build_series([
        _o("a", "2026-08-01", nodes=100),
        _o("a", "2026-08-02", nodes=100),
        _o("b", "2026-08-02", nodes=50),
    ], metric="nodes")
    assert out["totals"]["nodes"] == [100, 150]


# ── breakdowns ───────────────────────────────────────────────────────


def test_a_breakdown_pivots_types_into_their_own_series():
    out = ps.build_series(
        [_o("a", "2026-08-01", nodes=30, types={"Table": 20, "Column": 10})],
        breakdown="entity_type",
    )
    assert {s["key"] for s in out["series"]} == {"Table", "Column"}


def test_relationship_types_break_down_too():
    out = ps.build_series(
        [_o("a", "2026-08-01", edges=7, edge_types={"LINKS": 7})],
        breakdown="edge_type",
    )
    assert [s["key"] for s in out["series"]] == ["LINKS"]
    assert out["metric"] == "edges", "the breakdown implies the measure"


def test_types_are_ranked_by_peak_not_by_final_value():
    """A type that was large all month and is now zero is the most
    interesting line on the chart. Ranking by the last value drops it into
    'Other' — hiding precisely the disappearance a reader came to find."""
    out = ps.build_series([
        _o("a", "2026-08-01", types={"Vanished": 9_000, "Small": 5}),
        _o("a", "2026-08-02", types={"Small": 5}),
    ], breakdown="entity_type", top=1)
    assert [s["key"] for s in out["series"] if s["kind"] == "type"][0] == "Vanished"


def test_the_tail_folds_into_other_rather_than_a_seventh_colour():
    types = {f"T{i}": 100 - i for i in range(12)}
    out = ps.build_series(
        [_o("a", "2026-08-01", types=types)], breakdown="entity_type", top=3,
    )
    keys = [s["key"] for s in out["series"]]
    assert keys[:3] == ["T0", "T1", "T2"]
    assert keys[-1] == ps.OTHER_KEY
    assert out["series"][-1]["points"][0]["v"] == sum(
        v for k, v in types.items() if k not in {"T0", "T1", "T2"}
    )


def test_other_is_omitted_when_nothing_falls_into_it():
    out = ps.build_series(
        [_o("a", "2026-08-01", types={"Only": 5})],
        breakdown="entity_type", top=8,
    )
    assert ps.OTHER_KEY not in [s["key"] for s in out["series"]]


def test_a_breakdown_still_reports_the_totals_line():
    """A composition chart needs its own total to be readable, and the summary
    must not be a sum of the drawn bands — that silently excludes Other."""
    out = ps.build_series(
        [_o("a", "2026-08-01", nodes=30, types={"Table": 20, "Column": 10})],
        breakdown="entity_type", top=1,
    )
    assert out["totals"]["nodes"] == [30]


# ── extremes ─────────────────────────────────────────────────────────


def test_bucket_extremes_are_summed_across_sources():
    """The band showing an intra-bucket dip has to be a band across the whole
    scope, not one source's."""
    out = ps.build_series([
        _o("a", "2026-08-01", nodes=100, node_min=40, node_max=100),
        _o("b", "2026-08-01", nodes=50, node_min=50, node_max=60),
    ], metric="nodes")
    point = out["series"][0]["points"][0]
    assert point["min"] == 90 and point["max"] == 160


def test_extremes_are_omitted_when_any_source_lacks_them():
    """Half a band is a lie about the other half. Raw observations have no
    intra-bucket range, so a mixed set reports none."""
    out = ps.build_series([
        _o("a", "2026-08-01", nodes=100, node_min=40, node_max=100),
        _o("b", "2026-08-01", nodes=50),
    ], metric="nodes")
    assert "min" not in out["series"][0]["points"][0]


# ── vanished types ───────────────────────────────────────────────────


def test_a_type_that_ends_at_zero_is_reported():
    gone = ps.types_that_vanished([
        _o("a", "2026-08-01", types={"Table": 100, "Column": 40}),
        _o("a", "2026-08-02", types={"Table": 100}),
    ], breakdown="entity_type")
    assert gone == [{"type": "Column", "peak": 40}]


def test_a_type_still_present_is_not_reported():
    gone = ps.types_that_vanished([
        _o("a", "2026-08-01", types={"Table": 100}),
        _o("a", "2026-08-02", types={"Table": 1}),
    ], breakdown="entity_type")
    assert gone == []


def test_a_vanished_derived_label_is_not_reported():
    """`_AggMeta` is the aggregation pipeline's own run stamp — MERGEd per run,
    wiped by projection seeds and purges. Reporting it drove the amber
    "One type has disappeared" banner on every rebuild cycle. Snapshots
    captured before the providers stopped recording it stay readable for the
    retention window, so this has to hold on the READ side."""
    gone = ps.types_that_vanished([
        _o("a", "2026-08-01", types={"Table": 100, "_AggMeta": 1}),
        _o("a", "2026-08-02", types={"Table": 100}),
    ], breakdown="entity_type")
    assert gone == []


def test_a_real_type_is_still_reported_alongside_a_derived_one():
    gone = ps.types_that_vanished([
        _o("a", "2026-08-01", types={"Table": 100, "Column": 40, "_AggMeta": 1}),
        _o("a", "2026-08-02", types={"Table": 100}),
    ], breakdown="entity_type")
    assert gone == [{"type": "Column", "peak": 40}]


def test_a_customer_underscore_label_is_still_reported():
    """Explicit list, not a "_" prefix rule."""
    gone = ps.types_that_vanished([
        _o("a", "2026-08-01", types={"Table": 100, "_internal": 7}),
        _o("a", "2026-08-02", types={"Table": 100}),
    ], breakdown="entity_type")
    assert gone == [{"type": "_internal", "peak": 7}]


def test_a_vanished_aggregated_edge_type_is_not_reported():
    """A purge drops every AGGREGATED edge by design — the platform rebuilding
    its own overlay, not the source losing relationships."""
    gone = ps.types_that_vanished([
        _o("a", "2026-08-01", edge_types={"LINKS": 40, "AGGREGATED": 5000}),
        _o("a", "2026-08-02", edge_types={"LINKS": 40}),
    ], breakdown="edge_type")
    assert gone == []


def test_derived_labels_are_kept_out_of_the_drawn_series():
    """Not just the banner: the type ledger and the chart read the same
    counts, and `_AggMeta` ranked by PEAK would sit near the top of both."""
    out = ps.build_series(
        [_o("a", "2026-08-01", nodes=101, types={"Table": 100, "_AggMeta": 1})],
        metric="nodes", breakdown="entity_type",
    )
    assert [s["key"] for s in out["series"]] == ["Table"]


def test_an_empty_window_produces_an_empty_payload_not_an_error():
    out = ps.build_series([], metric="total")
    assert out == {"buckets": [], "series": [], "totals": {}}


# ── the overlay, shown rather than stripped ──────────────────────────


def test_the_overlay_is_its_own_measure():
    """`:AGGREGATED` is the platform's own rollup. It must not rank among a
    customer's relationship types — and stripping it was only ever half an
    answer, because its volume is a real operational number and "did the
    overlay drop, and has it come back" is the question people open this page
    to ask."""
    out = ps.build_series(
        [_o("a", "2026-08-01", edges=3_500_000,
            edge_types={"LINKS": 1_500_000, "AGGREGATED": 2_000_000})],
        metric="aggregated",
    )
    assert [s["key"] for s in out["series"]] == ["aggregated"]
    assert out["series"][0]["label"] == "Aggregated"
    assert out["series"][0]["points"][0]["v"] == 2_000_000


def test_the_headline_relationship_number_does_not_move():
    """The tile keeps meaning what it meant. The overlay rides ALONGSIDE it —
    a number that changed meaning silently is worse than one that was missing."""
    obs = [_o("a", "2026-08-01", nodes=10, edges=3_500_000,
              edge_types={"LINKS": 1_500_000, "AGGREGATED": 2_000_000})]
    for metric in ("total", "nodes", "edges", "aggregated"):
        out = ps.build_series(obs, metric=metric)
        assert out["totals"]["edges"] == [3_500_000]
        assert out["totals"]["aggregated"] == [2_000_000]
        assert out["totals"]["edges"][0] >= out["totals"]["aggregated"][0]


def test_the_overlay_total_rides_every_payload_including_a_breakdown():
    """The tile sub-line and the type-ledger row read `totals.aggregated` off
    a payload they already fetch — no second request, whatever is drawn."""
    obs = [_o("a", "2026-08-01", edges=100,
              edge_types={"LINKS": 60, "AGGREGATED": 40})]
    for breakdown in ("none", "entity_type", "edge_type"):
        out = ps.build_series(obs, metric="total", breakdown=breakdown)
        assert out["totals"]["aggregated"] == [40], breakdown


def test_a_drop_and_a_recovery_are_both_visible():
    """The shape a rebuild draws: the overlay goes and comes back while the
    source's own relationships never move. Before this the chart showed one
    flat line and the dip was invisible."""
    out = ps.build_series([
        _o("a", "2026-08-01", edges=3_500_000,
           edge_types={"LINKS": 1_500_000, "AGGREGATED": 2_000_000}),
        # Purged: the key is ABSENT, not zero — the provider drops zero-count
        # buckets rather than reporting them.
        _o("a", "2026-08-02", edges=1_500_000, edge_types={"LINKS": 1_500_000}),
        _o("a", "2026-08-03", edges=3_600_000,
           edge_types={"LINKS": 1_500_000, "AGGREGATED": 2_100_000}),
    ], metric="aggregated")
    assert [p["v"] for p in out["series"][0]["points"]] == [
        2_000_000, 0, 2_100_000,
    ]


def test_the_overlay_series_carries_no_confidence_band():
    """The rollup tiers keep edge_min/edge_max for the TOTAL only — there are
    no per-type extremes anywhere. Borrowing the total's would draw a band
    that does not contain its own line."""
    obs = [_o("a", "2026-08-01", edges=100, edge_min=50, edge_max=150,
              edge_types={"LINKS": 60, "AGGREGATED": 40})]
    overlay = ps.build_series(obs, metric="aggregated")["series"][0]["points"][0]
    assert "min" not in overlay and "max" not in overlay
    # ...while the measure that DOES have extremes still carries them.
    edges = ps.build_series(obs, metric="edges")["series"][0]["points"][0]
    assert edges["min"] == 50 and edges["max"] == 150


def test_the_overlay_is_counted_case_insensitively():
    """The type reaches us through ``type(r)`` from scans of graphs an
    external system may have loaded."""
    out = ps.build_series(
        [_o("a", "2026-08-01", edges=10, edge_types={"aggregated": 7, "L": 3})],
        metric="aggregated",
    )
    assert out["series"][0]["points"][0]["v"] == 7


def test_the_overlay_never_ranks_among_the_customers_types():
    """Showing it as a measure must not put it back into the breakdown, the
    vanished-type banner, or the type ledger's ranking."""
    obs = [
        _o("a", "2026-08-01", edges=100,
           edge_types={"LINKS": 60, "AGGREGATED": 40}),
        _o("a", "2026-08-02", edges=60, edge_types={"LINKS": 60}),
    ]
    drawn = ps.build_series(obs, metric="edges", breakdown="edge_type")
    assert [s["key"] for s in drawn["series"]] == ["LINKS"]
    assert ps.types_that_vanished(obs, breakdown="edge_type") == []


def test_a_silent_source_carries_its_overlay_forward_rather_than_to_zero():
    """Carry-forward is what stops a gap in observation reading as a purge."""
    out = ps.build_series([
        _o("a", "2026-08-01", edges=100, edge_types={"AGGREGATED": 40}),
        _o("b", "2026-08-01", edges=10, edge_types={"AGGREGATED": 5}),
        _o("b", "2026-08-02", edges=10, edge_types={"AGGREGATED": 5}),
    ], metric="aggregated")
    # 'a' said nothing in the second bucket; its 40 is still counted.
    assert [p["v"] for p in out["series"][0]["points"]] == [45, 45]


def test_the_resolved_measure_is_reported_not_the_one_asked_for():
    """A client running ahead of its backend asks for a measure the backend
    does not know; build_series falls back to total. Echoing the raw param
    would tell it that it got what it asked for."""
    out = ps.build_series(
        [_o("a", "2026-08-01", nodes=1, edges=1)], metric="not-a-measure",
    )
    assert out["metric"] == "total"
    assert ps.build_series(
        [_o("a", "2026-08-01", edges=1, edge_types={"AGGREGATED": 1})],
        metric="aggregated",
    )["metric"] == "aggregated"
