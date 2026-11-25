"""Provider-direct edge writers preserve confidence + properties faithfully.

The versioned rebuild round-trip is only as faithful as the writers that seed it. Two
provider-direct writers dropped edge attributes:

* ``create_edge`` wrote ``r.confidence = edge.confidence or 1.0`` — and because ``0.0 or 1.0 == 1.0``
  a legitimate 0.0-confidence edge (and a ``None``) was silently rewritten to 1.0, fabricating a
  value a later bootstrap would treat as real.
* ``create_node``'s containment edge set only ``r.id`` / ``r.confidence`` — ``r.properties`` was
  never written, so a containment edge created with properties lost them until the next rebuild.

These pin the fix: confidence passes through RAW (0.0 and None survive) and properties are always
written, matching ``save_custom_graph`` / the projector reseed.
"""
import asyncio
import json
from types import SimpleNamespace

import pytest

from backend.app.providers.falkordb_provider import FalkorDBProvider, _edge_from_row
from backend.common.models.graph import GraphEdge, GraphNode


def _run(coro):
    return asyncio.run(coro)


def _provider():
    """A FalkorDBProvider whose writes are captured as (cypher, params) — no infra."""
    p = FalkorDBProvider(host="x", graph_name="g")
    p.calls = []

    async def noop(*a, **k):
        return None

    async def ro_query(cypher, params=None, **kw):
        # Empty vocabulary probe → casing is written as-given (irrelevant to these assertions).
        return SimpleNamespace(result_set=[])

    async def query(cypher, params=None, **kw):
        p.calls.append((cypher, params or {}))
        return SimpleNamespace(result_set=[])

    p._ensure_connected = noop
    p._ro_query = ro_query
    p._query = query
    p._cache_urn_label = noop
    p._redis = None
    return p


def _edge_query(p):
    """The single MERGE-and-SET edge write among the captured calls."""
    return next((c, params) for c, params in p.calls if "MERGE (a)-[r:" in c)


def test_create_edge_preserves_zero_confidence():
    p = _provider()
    ok = _run(p.create_edge(GraphEdge(id="e1", sourceUrn="a", targetUrn="b",
                                      edgeType="FLOWS_TO", confidence=0.0)))
    assert ok
    _cypher, params = _edge_query(p)
    assert params["conf"] == 0.0, params            # NOT rewritten to 1.0


def test_create_edge_preserves_none_confidence():
    p = _provider()
    _run(p.create_edge(GraphEdge(id="e1", sourceUrn="a", targetUrn="b", edgeType="FLOWS_TO")))
    _cypher, params = _edge_query(p)
    assert params["conf"] is None, params           # NOT rewritten to 1.0


def test_create_edge_writes_confidence_and_properties():
    p = _provider()
    _run(p.create_edge(GraphEdge(id="e1", sourceUrn="a", targetUrn="b", edgeType="FLOWS_TO",
                                 confidence=0.7, properties={"sql": "select 1", "n": 3})))
    cypher, params = _edge_query(p)
    assert params["conf"] == 0.7
    assert json.loads(params["props"]) == {"sql": "select 1", "n": 3}
    assert "r.properties = $props" in cypher


def test_create_node_containment_edge_writes_properties():
    p = _provider()
    ok = _run(p.create_node(
        GraphNode(urn="u3", entityType="Table", displayName="u3"),
        containment_edge=GraphEdge(id="c1", sourceUrn="parent", targetUrn="u3",
                                   edgeType="CONTAINS", confidence=0.9,
                                   properties={"origin": "manual"}),
    ))
    assert ok
    cypher, params = _edge_query(p)                  # the containment edge write
    assert "r.properties = $props" in cypher, cypher
    assert json.loads(params["props"]) == {"origin": "manual"}
    assert params["conf"] == 0.9                     # confidence still passes through raw


# ── reading a relationship the platform did not write ─────────────────────────────────────────
#
# A graph built by another tool keeps a relationship's properties ON the relationship
# (``r.weight = 3``), not in the platform's one ``r.properties`` JSON string. The reader is what
# both the canvas and the "enable version control" copy go through, so every such property must
# come back as one of the edge's properties.


#: Ten properties of a customer's relationship, as ``properties(r)`` returns them.
CUSTOMER_EDGE = {
    "my prop": "val1", "MyProp": "a", "MySpecialProp": "b", "MyLogicalProp": True,
    "weight": 3, "score": 0.7, "naïve ü": "x", "dotted.key": "y", "tags list": ["a", "b"],
    "since": "2024-01-01",
}


def test_a_customers_relationship_reads_with_all_its_native_properties():
    e = _edge_from_row("urn:a", "urn:b", "FLOWS_TO", dict(CUSTOMER_EDGE))
    assert e.properties == CUSTOMER_EDGE
    assert e.id == "urn:a|FLOWS_TO|urn:b" and e.confidence is None


def test_a_platform_written_relationship_reads_exactly_as_before():
    """Only the envelope and the bag: what every platform writer stores. Byte-identical, so the
    content hashes of graphs already enabled do not change."""
    e = _edge_from_row("urn:a", "urn:b", "FLOWS_TO",
                       {"id": "e1", "confidence": 0.9, "properties": '{"sql": "select 1"}'})
    assert (e.id, e.confidence, e.properties) == ("e1", 0.9, {"sql": "select 1"})
    bare = _edge_from_row("urn:a", "urn:b", "CONTAINS", {"id": "c1"})
    assert (bare.id, bare.confidence, bare.properties) == ("c1", None, {})


def test_the_bag_wins_a_name_both_hold_on_a_relationship_the_projector_never_wrote():
    e = _edge_from_row("urn:a", "urn:b", "T", {"owner": "native", "only": 1,
                                               "properties": '{"owner": "bag"}'})
    assert e.properties == {"owner": "bag", "only": 1}


def test_a_projected_relationship_reads_from_its_bag_alone():
    """The projector writes the bag (and ``gvHash``) and never removes a native key: a property
    deleted in history must not come back from a stale native copy."""
    e = _edge_from_row("urn:a", "urn:b", "T", {"id": "e1", "gvHash": 42, "stale": "gone",
                                               "properties": '{"kept": 1}'})
    assert e.properties == {"kept": 1}


@pytest.mark.parametrize("rel", ["AGGREGATED", "aggregated"])
def test_a_rollup_never_shows_its_attributes_as_properties(rel):
    e = _edge_from_row("urn:a", "urn:b", rel, {"weight": 4, "aggKey": "a|b", "sourceEdgeTypes": ["X"],
                                               "latestUpdate": 1})
    assert e.properties == {}


@pytest.mark.parametrize("props, want_id, want_conf, want_props", [
    ({"id": 42}, "42", None, {}),
    ({"confidence": "high"}, "urn:a|T|urn:b", None, {"confidence": "high"}),
    ({"confidence": True}, "urn:a|T|urn:b", None, {"confidence": True}),
    ({"confidence": 1}, "urn:a|T|urn:b", 1.0, {}),
    ({"properties": "free text"}, "urn:a|T|urn:b", None, {"properties": "free text"}),
    ({"properties": "[1, 2]"}, "urn:a|T|urn:b", None, {"properties": "[1, 2]"}),
])
def test_source_values_never_break_the_read(props, want_id, want_conf, want_props):
    e = _edge_from_row("urn:a", "urn:b", "T", props)
    assert (e.id, e.confidence, e.properties) == (want_id, want_conf, want_props)
