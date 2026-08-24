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


def test_an_empty_window_produces_an_empty_payload_not_an_error():
    out = ps.build_series([], metric="total")
    assert out == {"buckets": [], "series": [], "totals": {}}
