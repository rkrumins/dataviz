"""Cypher-shape guards (WS2): hot read paths must emit index-seekable,
type-pruned queries. This FalkorDB build has no label-less URN index, so an
unlabeled `urn` anchor is a FULL node scan (measured 310ms/2M nodes), and a
`type(r) IN $x` post-filter visits every edge class on hub nodes.

A recording fake captures every Cypher string the provider issues; the tests
assert the SHAPES — label-qualified anchors (via the warmed urn→label cache,
with the unlabeled residue bucket still exercised) and pattern alternations
instead of type() post-filters.
"""
import asyncio
import re

import pytest

from backend.app.providers.falkordb_provider import FalkorDBProvider
from backend.common.models.graph import EdgeQuery


class _FakeResult:
    def __init__(self, rows=None):
        self.result_set = rows or []


def _make_provider(label_map=None):
    """Provider with a recording _ro_query and a stubbed label cache."""
    p = FalkorDBProvider(host="x", graph_name="shapes-test")

    async def _noop():
        return None

    p._ensure_connected = _noop
    p.recorded = []

    async def _ro(cypher, params=None, timeout=None, op=None):
        p.recorded.append(cypher)
        return _FakeResult()

    p._ro_query = _ro
    p._proj_ro_query = _ro

    labels = dict(label_map or {})

    async def _cached_label(urn):
        return labels.get(urn)

    async def _buckets(urns):
        by = {}
        for u in dict.fromkeys(u for u in urns if u):
            by.setdefault(labels.get(u) or "", []).append(u)
        return sorted(by.items())

    p._get_cached_label = _cached_label
    p._label_buckets = _buckets
    p.set_containment_edge_types(["HAS"], from_ontology=True)
    p.set_resolved_edge_metadata({"FLOWS_TO": {}}, ["FLOWS_TO"])
    return p


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


UNLABELED_URN_ANCHOR = re.compile(
    r"MATCH \((?:[a-z]+)\)(?:-|\s*WHERE\s+[a-z]+\.urn)"  # bare (x) followed by urn use
)


def test_children_page_is_label_seeked_and_type_pruned():
    p = _make_provider({"urn:parent": "Node"})
    _run(p.get_children_with_edges("urn:parent", limit=20))
    q1 = p.recorded[0]
    assert "(p:Node)" in q1, q1
    assert "[r:HAS]" in q1 and "[rc:HAS]" in q1
    assert "type(rc) IN" not in q1 and "type(r) IN" not in q1


def test_children_parent_residue_keeps_unlabeled_anchor():
    p = _make_provider({})  # label unknown → residue path must still work
    _run(p.get_children_with_edges("urn:parent", limit=20))
    q1 = p.recorded[0]
    assert "(p)-[r:HAS]->" in q1


def test_children_lineage_is_typed_and_bucketed():
    p = _make_provider({"urn:parent": "Roots", "urn:c1": "Node", "urn:c2": "Node"})

    async def _ro(cypher, params=None, timeout=None, op=None):
        p.recorded.append(cypher)
        if op == "children.page":
            return _FakeResult([
                [{"urn": "urn:c1", "displayName": "c1"}, 0, "urn:parent", "HAS", {}],
                [{"urn": "urn:c2", "displayName": "c2"}, 0, "urn:parent", "HAS", {}],
            ])
        return _FakeResult()

    p._ro_query = _ro

    def _extract(raw):
        from backend.common.models.graph import GraphNode
        return GraphNode(urn=raw["urn"], displayName=raw["displayName"], entityType="Node")

    p._extract_node_from_result = _extract
    _run(p.get_children_with_edges("urn:parent", limit=20))
    lineage = [q for q in p.recorded if "[lr:" in q or "[lr]" in q]
    assert lineage, p.recorded
    for q in lineage:
        assert "[lr:FLOWS_TO]" in q, q  # resolved lineage set → typed alternation
        assert "NOT type(lr)" not in q
    assert any("(a:Node)" in q or "(a:Roots)" in q for q in lineage)


def test_get_edges_between_is_bucketed_typed_and_seeked():
    p = _make_provider({"urn:a": "Node", "urn:b": "Node", "urn:x": "Roots"})
    _run(p.get_edges(EdgeQuery(
        sourceUrns=["urn:a", "urn:b", "urn:x"],
        targetUrns=["urn:a", "urn:b", "urn:x"],
        edgeTypes=["FLOWS_TO"], limit=1000,
    )))
    assert p.recorded, "no queries issued"
    for q in p.recorded:
        assert "[r:FLOWS_TO]" in q, q
        assert "type(r) IN" not in q
    assert any("(a:Node)" in q for q in p.recorded)
    assert any("(a:Roots)" in q for q in p.recorded)


def test_get_edges_offset_falls_back_to_single_query():
    p = _make_provider({"urn:a": "Node"})
    _run(p.get_edges(EdgeQuery(sourceUrns=["urn:a"], offset=50, limit=10)))
    assert len(p.recorded) == 1
    assert "SKIP $skip" in p.recorded[0]


def test_nodes_batch_is_bucketed():
    p = _make_provider({"urn:a": "Node", "urn:b": "Roots"})
    _run(p.get_nodes_batch(["urn:a", "urn:b", "urn:unknown"]))
    anchors = sorted(q.split(" WHERE")[0] for q in p.recorded)
    assert any("(n:Node)" in a for a in anchors)
    assert any("(n:Roots)" in a for a in anchors)
    assert any("MATCH (n) " in a or a.endswith("(n)") for a in anchors)  # residue bucket


def test_root_anchor_walk_is_typed_and_seeked():
    p = _make_provider({"urn:f": "Node"})
    _run(p._resolve_root_anchor("urn:f", ["HAS"]))
    q = p.recorded[0]
    assert "(focus:Node {urn: $urn})" in q
    assert "[c:HAS*1.." in q
    assert "ALL(rel IN c" not in q


def test_top_level_orders_without_tostring():
    p = _make_provider({})
    _run(p.get_top_level_or_orphan_nodes(
        root_entity_types=["Roots"], entity_types=["Roots", "Node"], limit=10,
    ))
    page = p.recorded[0]
    assert "ORDER BY n.displayName ASC" in page
    assert "toString(n.displayName) ASC" not in page
    assert "MATCH (n:Roots)" in page and "MATCH (n:Node)" in page  # label union
