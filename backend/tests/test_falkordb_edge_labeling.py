"""save_custom_graph must label-qualify the edge endpoint MATCH so it uses the
per-label urn index (Node By Index Scan) instead of an All Node Scan. Endpoint
labels come from the nodes saved in the same call plus the caller-supplied
``endpoint_labels``; an unknown endpoint falls back to a label-less MATCH.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from backend.app.providers.falkordb_provider import FalkorDBProvider
from backend.common.models.graph import GraphEdge, GraphNode


def _provider_capturing_queries():
    """A provider whose infra calls are stubbed; returns (provider, captured_queries)."""
    p = FalkorDBProvider(host="x", port=6379, graph_name="t")
    queries = []

    async def _fake_query(q, params=None):
        queries.append(q)
        class _R:  # minimal result object
            result_set = []
        return _R()

    async def _noop(*a, **k):
        return None

    p._ensure_connected = _noop
    p.ensure_indices = _noop
    p._cache_urn_labels_bulk = _noop
    p._query = _fake_query
    return p, queries


def _edge_queries(queries):
    return [q for q in queries if "MERGE (a)-[r:" in q]


async def test_same_call_nodes_label_qualify_edge_endpoints():
    p, queries = _provider_capturing_queries()
    nodes = [GraphNode(urn="u:a", entityType="Node", displayName="a"),
             GraphNode(urn="u:b", entityType="Node", displayName="b")]
    edges = [GraphEdge(id="e1", sourceUrn="u:a", targetUrn="u:b", edgeType="Has")]
    await p.save_custom_graph(nodes, edges)
    eq = _edge_queries(queries)
    assert len(eq) == 1
    assert "MATCH (a:Node {urn: item.src})" in eq[0]
    assert "MATCH (b:Node {urn: item.tgt})" in eq[0]


async def test_endpoint_labels_param_used_when_nodes_absent():
    p, queries = _provider_capturing_queries()
    # edges-only call (the importer's separate edge pass) with explicit labels
    edges = [GraphEdge(id="e1", sourceUrn="u:r", targetUrn="u:n", edgeType="Has")]
    await p.save_custom_graph([], edges, endpoint_labels={"u:r": "Roots", "u:n": "Node"})
    eq = _edge_queries(queries)
    assert "MATCH (a:Roots {urn: item.src})" in eq[0]
    assert "MATCH (b:Node {urn: item.tgt})" in eq[0]


async def test_unknown_endpoint_falls_back_to_label_less():
    p, queries = _provider_capturing_queries()
    # no nodes, no endpoint_labels → must still emit a (correct) label-less MATCH
    edges = [GraphEdge(id="e1", sourceUrn="u:a", targetUrn="u:b", edgeType="Has")]
    await p.save_custom_graph([], edges)
    eq = _edge_queries(queries)
    assert "MATCH (a {urn: item.src})" in eq[0]
    assert "MATCH (b {urn: item.tgt})" in eq[0]


async def test_partial_labels_qualify_only_known_side():
    p, queries = _provider_capturing_queries()
    edges = [GraphEdge(id="e1", sourceUrn="u:a", targetUrn="u:b", edgeType="Has")]
    await p.save_custom_graph([], edges, endpoint_labels={"u:a": "Roots"})  # only source known
    eq = _edge_queries(queries)
    assert "MATCH (a:Roots {urn: item.src})" in eq[0]
    assert "MATCH (b {urn: item.tgt})" in eq[0]


if __name__ == "__main__":
    import pytest
    raise SystemExit(pytest.main([__file__, "-q"]))
