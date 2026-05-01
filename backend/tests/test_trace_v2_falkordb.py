"""
Unit tests for the FalkorDB provider trace v2 implementation.

These tests focus on the Python wrapper logic — Cypher parameterization,
result-row plumbing, regime selection — without spinning up a real FalkorDB.
Integration tests (with a live FalkorDB) live in test_falkordb_provider.py.

Plan §1.4 (Regime A/B/C) and §3.2 (drill-down delta).
"""

import inspect
from typing import List
from unittest.mock import MagicMock

import pytest

from backend.app.providers.falkordb_provider import FalkorDBProvider
from backend.common.models.graph import (
    GraphNode,
    ProviderTraceResult,
    TraceEdge,
    TraceRegime,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _node(urn: str, entity_type: str = "domain", display_name: str = "n") -> GraphNode:
    return GraphNode(
        urn=urn,
        entityType=entity_type,
        displayName=display_name,
    )


def _make_provider() -> FalkorDBProvider:
    """Build a provider without touching the network."""
    p = FalkorDBProvider(host="localhost", port=6379, graph_name="test_trace_v2")
    # Skip _ensure_connected by short-circuiting it.
    p._graph = MagicMock()
    p._proj_graph = None
    p._redis = MagicMock()
    p._redis_available = True
    return p


def _fake_query_result(rows: List[list]):
    res = MagicMock()
    res.result_set = rows
    return res


def _fake_node_record(urn: str, entity_type: str = "domain", display_name: str = "n"):
    """Mimic the FalkorDB driver's Node record shape used by
    _extract_node_from_result (object with `.properties` and `.labels`)."""
    rec = MagicMock()
    rec.properties = {
        "urn": urn,
        "displayName": display_name,
        "entityType": entity_type,
    }
    rec.labels = [entity_type]
    return rec


def _fake_rel(weight: int, source_edge_types: List[str]):
    rel = MagicMock()
    rel.properties = {
        "weight": weight,
        "sourceEdgeTypes": source_edge_types,
    }
    rel.relation = "AGGREGATED"
    rel.type = "AGGREGATED"
    return rel


# ---------------------------------------------------------------------------
# Method-existence + signature checks
# ---------------------------------------------------------------------------

def test_get_trace_v2_method_exists():
    assert hasattr(FalkorDBProvider, "get_trace_v2")
    sig = inspect.signature(FalkorDBProvider.get_trace_v2)
    expected = {
        "self",
        "focus_urn",
        "direction",
        "upstream_depth",
        "downstream_depth",
        "target_level",
        "expanded_urns",
        "containment_edge_types",
        "lineage_edge_types",
        "entity_level_index",
        "prefer_materialized",
        "limit",
        "cursor",
    }
    assert set(sig.parameters.keys()) == expected


def test_get_trace_delta_v2_method_exists():
    assert hasattr(FalkorDBProvider, "get_trace_delta_v2")
    sig = inspect.signature(FalkorDBProvider.get_trace_delta_v2)
    expected = {
        "self",
        "session_focus_urn",
        "session_target_level",
        "expand_urn",
        "new_target_level",
        "containment_edge_types",
        "lineage_edge_types",
        "entity_level_index",
        "limit",
    }
    assert set(sig.parameters.keys()) == expected


# ---------------------------------------------------------------------------
# ProviderTraceResult construction smoke test
# ---------------------------------------------------------------------------

def test_provider_trace_result_smoke():
    edge = TraceEdge(
        id="a|AGGREGATED|b",
        sourceUrn="a", targetUrn="b",
        edgeType="AGGREGATED",
        isAggregated=True, weight=3,
        sourceEdgeTypes=["PRODUCES"],
        underlyingPairs=3, source="materialized",
    )
    result = ProviderTraceResult(
        focusUrn="a", focusLevel=0, targetLevel=0,
        nodes=[_node("a"), _node("b")],
        edges=[edge],
        upstreamUrns=["b"],
        downstreamUrns=[],
        regime=TraceRegime.MATERIALIZED,
        materializedHitRate=1.0,
    )
    assert result.focus_urn == "a"
    assert result.regime == TraceRegime.MATERIALIZED
    assert result.edges[0].is_aggregated is True
    assert result.edges[0].source == "materialized"


# ---------------------------------------------------------------------------
# Helper-method behavior
# ---------------------------------------------------------------------------

def test_entity_types_at_or_below():
    idx = {"domain": 0, "platform": 1, "dataset": 2, "column": 3}
    out = FalkorDBProvider._entity_types_at_or_below(idx, 1)
    assert set(out) == {"domain", "platform"}


def test_entity_types_at_level():
    idx = {"domain": 0, "platform": 1, "dataset": 2, "column": 3}
    out = FalkorDBProvider._entity_types_at_level(idx, 2)
    assert out == ["dataset"]


def test_build_trace_edge_materialized():
    p = _make_provider()
    e = p._build_trace_edge(
        source_urn="s", target_urn="t",
        edge_type="PRODUCES",
        weight=5,
        source_edge_types=["PRODUCES", "CONSUMES"],
        is_aggregated=True, is_containment=False,
        source="materialized",
    )
    assert e.id == "s|PRODUCES|t"
    assert e.weight == 5
    assert e.source == "materialized"
    assert e.is_aggregated is True
    assert e.is_containment is False
    assert e.source_edge_types == ["PRODUCES", "CONSUMES"]


def test_build_trace_edge_containment():
    p = _make_provider()
    e = p._build_trace_edge(
        source_urn="parent", target_urn="child",
        edge_type="CONTAINS",
        weight=1,
        source_edge_types=["CONTAINS"],
        is_aggregated=False, is_containment=True,
        source="materialized",
    )
    assert e.is_containment is True
    assert e.is_aggregated is False
    assert e.weight == 1


# ---------------------------------------------------------------------------
# Regime A — materialized fast path
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_get_trace_v2_regime_a_uses_materialized(monkeypatch):
    """Happy path: focus has materialized [:AGGREGATED] edges; the provider
    runs the single-hop Cypher and returns Regime A result."""
    p = _make_provider()

    # Connection is already faked.
    async def _noop_ensure():
        return None
    monkeypatch.setattr(p, "_ensure_connected", _noop_ensure)

    focus = _node("urn:domain:a", entity_type="domain", display_name="A")

    async def _get_node(urn):
        return focus if urn == "urn:domain:a" else _node(urn, "domain", urn)
    monkeypatch.setattr(p, "get_node", _get_node)

    async def _has_agg(urn):
        return True
    monkeypatch.setattr(p, "_has_aggregated_for_focus", _has_agg)

    # Capture the cypher + params passed to _proj_ro_query.
    captured: dict = {}

    async def _fake_proj_ro_query(cypher, params=None, *, timeout=None):
        captured["cypher"] = cypher
        captured["params"] = params
        # Return one upstream and one downstream row.
        return _fake_query_result([
            [_fake_node_record("urn:domain:b", "domain", "B"),
             _fake_rel(2, ["PRODUCES"]),
             "upstream", 0],
            [_fake_node_record("urn:domain:c", "domain", "C"),
             _fake_rel(4, ["CONSUMES", "DERIVES"]),
             "downstream", 3],
        ])
    monkeypatch.setattr(p, "_proj_ro_query", _fake_proj_ro_query)

    async def _ro_query(cypher, params=None, *, timeout=None):
        # No containment rows in this test.
        return _fake_query_result([])
    monkeypatch.setattr(p, "_ro_query", _ro_query)

    result = await p.get_trace_v2(
        focus_urn="urn:domain:a",
        direction="both",
        upstream_depth=5,
        downstream_depth=5,
        target_level=0,
        expanded_urns=[],
        containment_edge_types=["CONTAINS"],
        lineage_edge_types=["PRODUCES", "CONSUMES", "DERIVES"],
        entity_level_index={"domain": 0, "platform": 1},
        prefer_materialized=True,
        limit=2000,
        cursor=None,
    )

    # Regime + hit rate
    assert result.regime == TraceRegime.MATERIALIZED
    assert result.materialized_hit_rate == 1.0

    # Single Cypher round-trip with parameterized inputs (no f-string injection)
    assert "MATCH (focus {urn: $focusUrn})" in captured["cypher"]
    assert "$allowedLabels" in captured["cypher"]
    assert "$nextLevelLabels" in captured["cypher"]
    assert captured["params"]["focusUrn"] == "urn:domain:a"
    assert captured["params"]["limit"] == 2000

    # Focus + 2 neighbors in nodes
    urns = {n.urn for n in result.nodes}
    assert urns == {"urn:domain:a", "urn:domain:b", "urn:domain:c"}

    # 2 lineage edges. Upstream edge: b -> a. Downstream edge: a -> c.
    lineage_edges = [e for e in result.edges if not e.is_containment]
    assert len(lineage_edges) == 2
    by_pair = {(e.source_urn, e.target_urn): e for e in lineage_edges}
    assert ("urn:domain:b", "urn:domain:a") in by_pair
    assert ("urn:domain:a", "urn:domain:c") in by_pair

    up_edge = by_pair[("urn:domain:b", "urn:domain:a")]
    assert up_edge.is_aggregated is True
    assert up_edge.weight == 2
    assert up_edge.source_edge_types == ["PRODUCES"]
    assert up_edge.source == "materialized"

    down_edge = by_pair[("urn:domain:a", "urn:domain:c")]
    assert down_edge.weight == 4

    # upstream/downstream URN buckets
    assert "urn:domain:b" in result.upstream_urns
    assert "urn:domain:c" in result.downstream_urns

    # Expandable: c has aggregatedChildCount=3, b has 0.
    assert result.expandable_urns == ["urn:domain:c"]
    assert result.aggregated_child_count == {"urn:domain:c": 3}


@pytest.mark.asyncio
async def test_get_trace_v2_demotes_to_runtime_when_no_materialized(monkeypatch):
    """Per-focus demotion check (Regime C → B): when has_agg is False the
    provider falls back to the runtime projection path without running the
    materialized Cypher."""
    p = _make_provider()

    async def _noop_ensure():
        return None
    monkeypatch.setattr(p, "_ensure_connected", _noop_ensure)

    focus = _node("urn:domain:a", entity_type="domain")

    async def _get_node(urn):
        return focus if urn == "urn:domain:a" else _node(urn, "domain")
    monkeypatch.setattr(p, "get_node", _get_node)

    async def _has_agg(urn):
        return False
    monkeypatch.setattr(p, "_has_aggregated_for_focus", _has_agg)

    proj_calls = {"count": 0}

    async def _proj_ro_query(cypher, params=None, *, timeout=None):
        proj_calls["count"] += 1
        return _fake_query_result([])
    monkeypatch.setattr(p, "_proj_ro_query", _proj_ro_query)

    # Runtime path issues source-graph queries; return empty so we exit fast.
    async def _ro_query(cypher, params=None, *, timeout=None):
        return _fake_query_result([])
    monkeypatch.setattr(p, "_ro_query", _ro_query)

    result = await p.get_trace_v2(
        focus_urn="urn:domain:a",
        direction="both",
        upstream_depth=2,
        downstream_depth=2,
        target_level=0,
        expanded_urns=[],
        containment_edge_types=["CONTAINS"],
        lineage_edge_types=["PRODUCES"],
        entity_level_index={"domain": 0},
        prefer_materialized=True,
        limit=100,
        cursor=None,
    )

    assert result.regime == TraceRegime.RUNTIME
    assert result.materialized_hit_rate == 0.0
    assert "materialization_missing" in result.warnings
    # Materialized Cypher was NOT executed against the projection graph.
    assert proj_calls["count"] == 0


@pytest.mark.asyncio
async def test_get_trace_v2_returns_focus_only_when_node_missing(monkeypatch):
    p = _make_provider()

    async def _noop_ensure():
        return None
    monkeypatch.setattr(p, "_ensure_connected", _noop_ensure)

    async def _get_node(urn):
        return None
    monkeypatch.setattr(p, "get_node", _get_node)

    result = await p.get_trace_v2(
        focus_urn="urn:missing",
        direction="both",
        upstream_depth=5, downstream_depth=5,
        target_level=0,
        expanded_urns=[],
        containment_edge_types=[],
        lineage_edge_types=[],
        entity_level_index={"domain": 0},
        prefer_materialized=True,
        limit=100, cursor=None,
    )

    assert result.nodes == []
    assert result.edges == []
    assert "focus_not_found" in result.warnings


# ---------------------------------------------------------------------------
# Drill-down delta
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_get_trace_delta_v2_runs_parameterized_cypher(monkeypatch):
    p = _make_provider()

    async def _noop_ensure():
        return None
    monkeypatch.setattr(p, "_ensure_connected", _noop_ensure)

    async def _get_node(urn):
        return _node(urn, entity_type="platform", display_name=urn)
    monkeypatch.setattr(p, "get_node", _get_node)

    captured: dict = {}

    async def _proj_ro_query(cypher, params=None, *, timeout=None):
        captured["cypher"] = cypher
        captured["params"] = params
        return _fake_query_result([
            [_fake_node_record("urn:platform:a", "platform", "A"),
             _fake_node_record("urn:domain:b", "domain", "B"),
             _fake_rel(7, ["PRODUCES"]),
             "downstream"],
        ])
    monkeypatch.setattr(p, "_proj_ro_query", _proj_ro_query)

    async def _ro_query(cypher, params=None, *, timeout=None):
        return _fake_query_result([])
    monkeypatch.setattr(p, "_ro_query", _ro_query)

    result = await p.get_trace_delta_v2(
        session_focus_urn="urn:domain:focus",
        session_target_level=0,
        expand_urn="urn:domain:b",
        new_target_level=1,
        containment_edge_types=["CONTAINS"],
        lineage_edge_types=["PRODUCES"],
        entity_level_index={"domain": 0, "platform": 1},
        limit=500,
    )

    assert result.focus_urn == "urn:domain:b"
    assert result.target_level == 1
    assert "$expandUrn" in captured["cypher"]
    assert "$newLevelLabels" in captured["cypher"]
    assert captured["params"]["expandUrn"] == "urn:domain:b"
    assert captured["params"]["newLevelLabels"] == ["platform"]
    # session-or-above labels: hierarchy.level <= session_target_level (0)
    # → domain only.
    assert set(captured["params"]["sessionLabels"]) == {"domain"}

    lineage = [e for e in result.edges if not e.is_containment]
    assert len(lineage) == 1
    assert lineage[0].source_urn == "urn:platform:a"
    assert lineage[0].target_urn == "urn:domain:b"
    assert lineage[0].weight == 7
    assert lineage[0].is_aggregated is True
    assert result.regime == TraceRegime.MATERIALIZED
