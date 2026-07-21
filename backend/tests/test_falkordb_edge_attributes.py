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

from backend.app.providers.falkordb_provider import FalkorDBProvider
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
