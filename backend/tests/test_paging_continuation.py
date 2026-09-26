"""Where the next page starts is the PROVIDER's answer, never the client's count.

A client that pages a container or a type takes `nextOffset` and `hasMore` from
each page. That is lossless only if every provider path answers them in its own
order:

  * the interface defaults (Neo4j, Spanner, …) — exact `hasMore` by probing one
    row past the page, and cross-page sibling lineage without a native query;
  * the draft overlay, which drops and adds rows around the page it read — its
    position and `hasMore` must be MAIN's, and its new rows ride on the first
    page only, or a client counting rows skips rows of main;
  * the branch/as-of provider, which pages its own state by offset.
"""
import asyncio
from typing import List

import pytest
from httpx import AsyncClient

from backend.common.interfaces.provider import GraphDataProvider
from backend.common.models.graph import (
    ChildrenWithEdgesResult, EdgeQuery, GraphEdge, GraphNode, NodePage, NodeQuery,
)
from backend.app.providers.draft_overlay_provider import DraftOverlayProvider
from backend.app.providers.versioned_branch_provider import VersionedBranchProvider


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def _node(urn, t="system"):
    return GraphNode(urn=urn, entityType=t, displayName=urn)


def _edge(eid, s, t, et):
    return GraphEdge(id=eid, sourceUrn=s, targetUrn=t, edgeType=et, confidence=1.0, properties={})


class _MemoryProvider(GraphDataProvider):
    """The interface's DEFAULTS over an in-memory graph — what a provider with no
    native paging or sibling query (Neo4j, Spanner) gets."""

    def __init__(self, nodes: List[GraphNode], edges: List[GraphEdge], ignore_offset=False):
        self.nodes = nodes
        self.edges = edges
        self.ignore_offset = ignore_offset
        self.edge_reads = 0

    async def get_nodes(self, query: NodeQuery):
        rows = [n for n in self.nodes if not query.entity_types or n.entity_type in query.entity_types]
        o = query.offset or 0
        return rows[o: o + (query.limit or 100)]

    async def get_children(self, parent_urn, entity_types=None, edge_types=None, search_query=None,
                           offset=0, limit=100, sort_property="displayName", cursor=None, sort_direction="asc"):
        kids = sorted(e.target_urn for e in self.edges if e.source_urn == parent_urn and e.edge_type == "CONTAINS")
        return [_node(u) for u in kids[offset: offset + limit]]

    async def get_edges(self, query: EdgeQuery):
        self.edge_reads += 1
        rows = [
            e for e in self.edges
            if (not query.source_urns or e.source_urn in query.source_urns)
            and (not query.target_urns or e.target_urn in query.target_urns)
            and (not query.edge_types or e.edge_type in query.edge_types)
        ]
        o = 0 if self.ignore_offset else (query.offset or 0)
        return rows[o: o + (query.limit or 100)]


# Only the methods under test are real; the rest of the interface is irrelevant here.
_MemoryProvider.__abstractmethods__ = frozenset()


# ── interface defaults ───────────────────────────────────────────────────

def test_default_node_page_knows_exactly_whether_more_follow():
    p = _MemoryProvider([_node(f"n{i:02d}") for i in range(10)], [])
    first = _run(p.get_nodes_page(NodeQuery(limit=5)))
    last = _run(p.get_nodes_page(NodeQuery(limit=5, offset=5)))
    assert [n.urn for n in first.nodes] == [f"n{i:02d}" for i in range(5)]
    assert (first.has_more, first.next_offset) == (True, 5)
    # Exactly a full last page: no phantom "more" (a page-full guess would say so).
    assert (last.has_more, last.next_offset) == (False, 10)


def _family():
    kids = [f"P.c{i}" for i in range(6)]
    edges = [_edge(f"k{i}", "P", k, "CONTAINS") for i, k in enumerate(kids)]
    edges += [
        _edge("in-page", "P.c0", "P.c1", "FLOWS_TO"),
        _edge("to-later", "P.c0", "P.c4", "FLOWS_TO"),     # far end on a later page
        _edge("from-later", "P.c5", "P.c1", "FLOWS_TO"),   # arrives INTO the page
        _edge("to-parent", "P.c1", "P", "FLOWS_TO"),
        _edge("to-cousin", "P.c0", "Q.x", "FLOWS_TO"),     # not a child of P
        _edge("elsewhere", "P.c4", "P.c5", "FLOWS_TO"),    # doesn't touch the page
    ]
    edges.append(_edge("kq", "Q", "Q.x", "CONTAINS"))
    return _MemoryProvider([], edges)


def _page(p, **kw):
    return _run(p.get_children_with_edges(
        "P", edge_types=["CONTAINS"], lineage_edge_types=["FLOWS_TO"], limit=2, **kw))


def test_default_children_page_says_where_the_next_starts():
    res = _page(_family(), offset=2)
    assert [c.urn for c in res.children] == ["P.c2", "P.c3"]
    assert res.next_offset == 4


def test_default_siblings_scope_brings_cross_page_lineage():
    res = _page(_family(), lineage_scope="siblings")
    assert {e.id for e in res.lineage_edges} == {"in-page", "to-later", "from-later", "to-parent"}
    assert {e.id for e in res.containment_edges} == {"k0", "k1"}


def test_default_page_scope_is_unchanged():
    res = _page(_family())
    assert {e.id for e in res.lineage_edges} == {"in-page", "to-parent"}


def test_edge_collection_reads_past_one_page_and_never_loops():
    edges = [_edge(f"e{i}", "A", f"B{i}", "FLOWS_TO") for i in range(25)]
    paged = _MemoryProvider([], edges)
    assert len(_run(paged._collect_edges(EdgeQuery(source_urns=["A"]), page_size=10))) == 25
    # An adapter that ignores `offset` hands back page one again: stop, don't spin.
    stuck = _MemoryProvider([], edges, ignore_offset=True)
    got = _run(stuck._collect_edges(EdgeQuery(source_urns=["A"]), page_size=10))
    assert len(got) == 10 and stuck.edge_reads == 2


# ── draft overlay ────────────────────────────────────────────────────────

class _FakeSvc:
    def __init__(self, delta):
        self._delta = delta

    async def branch_overlay_delta(self, *, graph_id, branch_id):
        return self._delta

    async def aggregated_overlay_adjust(self, **kw):
        return {}


def _raw_node(urn, t="system"):
    return {"urn": urn, "entityType": t, "displayName": urn}


def _raw_edge(eid, s, t, et="CONTAINS"):
    return {"id": eid, "sourceUrn": s, "targetUrn": t, "edgeType": et, "confidence": 1.0, "properties": {}}


# The draft deletes a main child that sits on page 2 and creates a new one.
_DELTA = {
    "nodesUpsert": [_raw_node("P.new")], "nodesNew": ["P.new"],
    "nodesRemove": [{"urn": "P.c150"}],
    "edgesUpsert": [_raw_edge("k-new", "P", "P.new")], "edgesRemove": [],
}


class _MainChildren:
    """Main: P has 250 children, paged 100 at a time in main's own order."""

    def set_containment_edge_types(self, ets, from_ontology=False):
        pass

    async def get_children_with_edges(self, parent_urn, offset=0, limit=100, **kw):
        kids = [_node(f"P.c{i:03d}" if i != 150 else "P.c150") for i in range(offset, min(offset + limit, 250))]
        return ChildrenWithEdgesResult(
            children=kids, containmentEdges=[], lineageEdges=[], totalChildren=250,
            hasMore=offset + limit < 250, nextOffset=offset + len(kids))

    async def get_nodes_page(self, query: NodeQuery):
        o = query.offset or 0
        rows = [_node(f"P.c{i:03d}" if i != 150 else "P.c150") for i in range(o, min(o + 100, 250))]
        return NodePage(nodes=rows, hasMore=o + 100 < 250, nextOffset=o + len(rows))


def _overlay():
    p = DraftOverlayProvider(_MainChildren(), svc=_FakeSvc(_DELTA), graph_id="g", branch_id="d")
    p.set_containment_edge_types(["CONTAINS"])
    return p


def test_overlay_children_keep_mains_position_when_the_draft_deletes_a_row():
    res = _run(_overlay().get_children_with_edges("P", offset=100, limit=100))
    assert "P.c150" not in {c.urn for c in res.children}
    assert len(res.children) == 99
    # 99 rows came back, but main's next page still starts at 200 and follows.
    assert (res.next_offset, res.has_more) == (200, True)


def test_overlay_new_children_ride_on_the_first_page_only():
    first = _run(_overlay().get_children_with_edges("P", offset=0, limit=100))
    later = _run(_overlay().get_children_with_edges("P", offset=100, limit=100))
    assert "P.new" in {c.urn for c in first.children}
    assert first.next_offset == 100          # the new row doesn't move main's position
    assert "P.new" not in {c.urn for c in later.children}


def test_overlay_keeps_a_degraded_base_page_marked():
    class _Degraded(_MainChildren):
        async def get_children_with_edges(self, parent_urn, offset=0, limit=100, **kw):
            res = await super().get_children_with_edges(parent_urn, offset=offset, limit=limit, **kw)
            res.degraded_detail = "lineage incomplete: 1 lineage query failed (TimeoutError)"
            return res

    p = DraftOverlayProvider(_Degraded(), svc=_FakeSvc(_DELTA), graph_id="g", branch_id="d")
    p.set_containment_edge_types(["CONTAINS"])
    res = _run(p.get_children_with_edges("P", offset=0, limit=100))
    assert res.degraded_detail and "lineage" in res.degraded_detail


def test_overlay_type_page_keeps_mains_position():
    first = _run(_overlay().get_nodes_page(NodeQuery(entityTypes=["system"], limit=100)))
    second = _run(_overlay().get_nodes_page(NodeQuery(entityTypes=["system"], limit=100, offset=100)))
    assert "P.new" in {n.urn for n in first.nodes} and first.next_offset == 100
    assert "P.new" not in {n.urn for n in second.nodes}
    assert "P.c150" not in {n.urn for n in second.nodes}
    assert (second.has_more, second.next_offset) == (True, 200)


# ── branch / as-of provider ──────────────────────────────────────────────

class _StateSvc:
    def __init__(self, n):
        self.n = n
        self.asked = None

    async def get_nodes_from_state(self, *, limit, offset, **kw):
        self.asked = (limit, offset)
        return [_raw_node(f"s{i:03d}") for i in range(offset, min(offset + limit, self.n))]


def test_branch_type_page_probes_one_row_past_the_page():
    svc = _StateSvc(300)
    p = VersionedBranchProvider(svc=svc, graph_id="g", branch_id="b")
    page = _run(p.get_nodes_page(NodeQuery(entityTypes=["system"], limit=100, offset=200)))
    assert svc.asked == (101, 200)
    assert (len(page.nodes), page.has_more, page.next_offset) == (100, False, 300)


# ── endpoint ─────────────────────────────────────────────────────────────

class _PageEngine:
    def __init__(self):
        self.queries = []
        self.provider = None

    async def get_nodes_page(self, query):
        self.queries.append(query)
        return NodePage(nodes=[_node("a")], hasMore=True, nextOffset=query.offset + 1)


@pytest.fixture
async def page_client(test_client: AsyncClient):
    from backend.app.main import app
    from backend.app.api.v1.endpoints.graph import get_context_engine

    engine = _PageEngine()

    async def _override():
        return engine

    app.dependency_overrides[get_context_engine] = _override
    yield test_client, engine
    app.dependency_overrides.pop(get_context_engine, None)


async def test_nodes_page_endpoint_returns_the_position(page_client):
    client, engine = page_client
    resp = await client.post("/api/v1/test-ws/graph/nodes/page",
                             json={"query": {"entityTypes": ["system"], "limit": 1, "offset": 7}})
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"nodes": [resp.json()["nodes"][0]], "hasMore": True, "nextOffset": 8}
    assert engine.queries[-1].entity_types == ["system"]


@pytest.mark.parametrize("query", [
    {"urns": ["urn:a"], "limit": 1},
    {"entityTypes": ["system"], "nameFilter": {"text": "x"}},
    {"entityTypes": ["system"], "propertyFilters": [{"field": "a", "operator": "exists"}]},
    {"limit": 5},
])
async def test_nodes_page_endpoint_refuses_what_it_cannot_page(page_client, query):
    # Filters run AFTER the database's SKIP/LIMIT, so a filtered page's length
    # says nothing about what follows; a URN lookup is not a feed.
    client, engine = page_client
    resp = await client.post("/api/v1/test-ws/graph/nodes/page", json={"query": query})
    assert resp.status_code == 422, resp.text
    assert engine.queries == []


# ── adapters paged by position ───────────────────────────────────────────

def test_default_siblings_scope_keeps_the_callers_spelling_of_containment():
    # An adapter that compares relationship types exactly (Neo4j, Spanner) found
    # no children under an upper-cased name: every cross-page edge was dropped.
    kids = [f"P.c{i}" for i in range(4)]
    edges = [_edge(f"k{i}", "P", k, "HasChild") for i, k in enumerate(kids)]
    edges.append(_edge("to-later", "P.c0", "P.c3", "FLOWS_TO"))

    class _Exact(_MemoryProvider):
        async def get_children(self, parent_urn, entity_types=None, edge_types=None, search_query=None,
                               offset=0, limit=100, sort_property="displayName", cursor=None, sort_direction="asc"):
            got = sorted(e.target_urn for e in self.edges if e.source_urn == parent_urn and e.edge_type == "HasChild")
            return [_node(u) for u in got[offset: offset + limit]]

    res = _run(_Exact([], edges).get_children_with_edges(
        "P", edge_types=["HasChild"], lineage_edge_types=["FLOWS_TO"], limit=2, lineage_scope="siblings"))
    assert {e.id for e in res.lineage_edges} == {"to-later"}


def test_spanner_children_page_by_position_in_a_total_order():
    # Spanner's children query knew only a name cursor: paged by position, every
    # page was page 1.
    from unittest.mock import MagicMock
    from backend.graph.adapters.spanner_provider import SpannerProvider

    p = SpannerProvider(project_id="p", instance_id="i", database_id="d", graph_name="G", use_emulator=False)
    p._client, p._instance, p._database = object(), object(), MagicMock()
    p._connected = p._schema_bootstrapped = p._has_property_graph = True
    seen = []

    async def _execute(gql, **kw):
        seen.append(gql)
        return []

    p._execute_query = _execute
    p.set_containment_edge_types(["CONTAINS"], from_ontology=True)
    _run(p.get_children("urn:p", offset=200, limit=100))
    assert "OFFSET 200" in seen[-1]
    assert "child.urn" in seen[-1].split("ORDER BY", 1)[1]
    _run(p.get_children("urn:p", offset=200, limit=100, cursor="after"))
    assert "OFFSET 0" in seen[-1]                      # a cursor still pages by cursor


def test_neo4j_type_page_orders_totally_and_keeps_row_order():
    # No ORDER BY meant no stable position; count() after LIMIT reorders the
    # page, so trimming the probe row dropped an arbitrary one.
    from backend.graph.adapters.neo4j_provider import Neo4jProvider

    p = Neo4jProvider(uri="bolt://x")
    seen = []

    async def _read(cypher, params=None):
        seen.append(cypher)
        return []

    p._run_read = _read
    p.set_containment_edge_types(["CONTAINS"])
    _run(p.get_nodes(NodeQuery(entityTypes=["t"], limit=200, offset=400)))
    cypher = seen[-1]
    assert "ORDER BY" in cypher and cypher.index("ORDER BY") < cypher.index("SKIP")
    assert "count(" not in cypher
