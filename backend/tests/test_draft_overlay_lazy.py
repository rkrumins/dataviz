"""A draft's overlay is indexed from skeletons, and a read loads only what it serves (no infra).

``branch_overlay_delta`` names what a draft created or changed by what its version rows say —
``lazy`` entries: a node's urn, type and names; an edge's type and ends — never by payload, so the
overlay of a draft of any size is built without reading one. Listings, matches and searches run on
those fields; a read loads the values of exactly the nodes and edges it is about to serve
(``overlay_payloads``, ``kind='edge'`` for edges), and the index itself is built off the event
loop. Pinned here against a stub main and a stub service that counts what is loaded.
"""
import asyncio

from backend.common.models.graph import (
    AggregatedEdgeResult, ChildrenWithEdgesResult, EdgeQuery, GraphNode, NodeQuery,
    TopLevelNodesResult, TraceFocus, TraceResult,
)
from backend.app.providers import draft_overlay_provider
from backend.app.providers.draft_overlay_provider import DraftOverlayProvider


class Main:
    """Main: one schema P with a child P.a, and a top level of P alone."""
    name = "stub-main"

    def set_containment_edge_types(self, *a, **k):
        pass

    async def get_node(self, urn):
        return {"P": GraphNode(urn="P", entityType="Schema", displayName="P", childCount=1),
                "P.a": GraphNode(urn="P.a", entityType="Table", displayName="a")}.get(urn)

    async def get_nodes(self, query):
        return []

    async def search_nodes(self, query, limit=10, offset=0):
        return []

    async def get_edges(self, query):
        return []

    async def get_children_with_edges(self, parent_urn, *, offset=0, limit=100, cursor=None, **kw):
        kids = [GraphNode(urn="P.a", entityType="Table", displayName="a")] if parent_urn == "P" else []
        return ChildrenWithEdgesResult(children=kids[offset:offset + limit], containmentEdges=[],
                                       lineageEdges=[], totalChildren=len(kids),
                                       hasMore=offset + limit < len(kids), nextCursor=None,
                                       nextOffset=offset + len(kids[offset:offset + limit]))

    async def get_top_level_or_orphan_nodes(self, *, cursor=None, **kw):
        return TopLevelNodesResult(nodes=[] if cursor else [GraphNode(urn="P", entityType="Schema",
                                                                      displayName="P", childCount=1)],
                                   totalCount=1, hasMore=False, nextCursor=None, rootTypeCount=1,
                                   orphanCount=0)

    async def get_aggregated_edges_between(self, *a, **kw):
        return AggregatedEdgeResult(aggregatedEdges=[], totalSourceEdges=0, truncated=False)

    async def trace_at_level(self, urn, *a, **kw):
        nodes = [GraphNode(urn=u, entityType="Table", displayName=u) for u in ("N0", "N1", "N2")]
        return TraceResult(nodes=nodes, edges=[], focus=TraceFocus(urn=urn, level=0, entityType="Table"),
                           effectiveLevel=0)

    async def get_node_degrees(self, urns, edge_types=None, *, include_rollups=False):
        return {u: {"in": 0, "out": 0} for u in urns if u in ("P", "P.a")}


def _skeleton(i, typ="Table"):
    return {"urn": f"N{i}", "entityId": f"e{i}", "entityType": typ, "displayName": f"node {i}",
            "qualifiedName": f"q.{i}", "lazy": True}


def _value(i, typ="Table"):
    return {"urn": f"N{i}", "entityId": f"e{i}", "entityType": typ, "displayName": f"node {i}",
            "qualifiedName": f"q.{i}", "properties": {"full": i}, "version": f"h{i}"}


def _edge(eid, s, t, typ, lazy=True):
    return {"id": eid, "sourceUrn": s, "targetUrn": t, "edgeType": typ, **({"lazy": True} if lazy else {})}


def _edge_value(eid, s, t, typ):
    return {"id": eid, "sourceUrn": s, "targetUrn": t, "edgeType": typ, "confidence": 0.7,
            "properties": {"full": eid}, "version": f"h{eid}"}


# The draft created 30 nodes: 20 under P (contained), 10 at the top level (5 of them Views); lineage
# N0 -> N1, N1 -> N2; and it changed main's P.a.
N = 30
DELTA = {
    "nodesUpsert": [_skeleton(i, "View" if i >= 25 else "Table") for i in range(N)],
    "nodesNew": [f"N{i}" for i in range(N)],
    "nodesModified": [{"urn": "P.a", "entityId": "pa"}],
    "nodesRemove": [],
    "edgesUpsert": ([_edge(f"c{i}", "P", f"N{i}", "CONTAINS") for i in range(20)]
                    + [_edge("l01", "N0", "N1", "LINEAGE"), _edge("l12", "N1", "N2", "LINEAGE")]),
    "edgesRemove": [],
}
VALUES = {**{f"e{i}": _value(i, "View" if i >= 25 else "Table") for i in range(N)},
          "pa": {"urn": "P.a", "entityId": "pa", "entityType": "Table", "displayName": "a v2"}}
EDGES = {e["id"]: _edge_value(e["id"], e["sourceUrn"], e["targetUrn"], e["edgeType"])
         for e in DELTA["edgesUpsert"]}


class Svc:
    def __init__(self):
        self.version = (object(),)                    # its own draft: no delta shared with another
        self.loads, self.edge_loads = [], []

    async def overlay_version(self, *, graph_id, branch_id):
        return self.version

    async def branch_overlay_delta(self, *, graph_id, branch_id):
        return DELTA

    async def overlay_payloads(self, *, graph_id, branch_id, entity_ids, kind="node"):
        if kind == "edge":
            self.edge_loads.append(sorted(entity_ids))
            return [EDGES[e] for e in entity_ids if e in EDGES]
        self.loads.append(sorted(entity_ids))
        return [VALUES[e] for e in entity_ids if e in VALUES]

    async def aggregated_overlay_adjust(self, **kw):
        return {}


def _prov(svc):
    p = DraftOverlayProvider(Main(), svc=svc, graph_id="g", branch_id="d")
    p.set_containment_edge_types(["CONTAINS"])
    return p


def _loaded(svc):
    return sorted(e for batch in svc.loads for e in batch)


def test_a_listing_matches_on_skeletons_and_loads_only_what_it_serves():
    async def run():
        svc = Svc()
        views = await _prov(svc).get_nodes(NodeQuery(entityTypes=["View"]))
        assert sorted(n.urn for n in views) == [f"N{i}" for i in range(25, 30)]
        assert all(n.properties == {"full": int(n.urn[1:])} for n in views), "the draft's values"
        assert _loaded(svc) == [f"e{i}" for i in range(25, 30)], "only the five it served"

        svc = Svc()
        found = await _prov(svc).search_nodes("node 7")
        assert [n.urn for n in found] == ["N7"] and found[0].properties == {"full": 7}
        assert _loaded(svc) == ["e7"]

        svc = Svc()
        assert (await _prov(svc).get_node("N3")).properties == {"full": 3}
        assert _loaded(svc) == ["e3"]
        assert svc.edge_loads == []
    asyncio.run(run())


def test_children_load_on_the_page_that_serves_them_and_count_on_the_others():
    async def run():
        svc = Svc()
        p = _prov(svc)
        first = await p.get_children_with_edges("P", edge_types=["CONTAINS"], offset=0, limit=100)
        assert sorted(c.urn for c in first.children) == sorted(["P.a"] + [f"N{i}" for i in range(20)])
        assert first.total_children == 21
        assert {c.urn: c.display_name for c in first.children}["P.a"] == "a v2"
        assert all(c.properties.get("full") == int(c.urn[1:]) for c in first.children if c.urn != "P.a")
        assert _loaded(svc) == sorted(["pa"] + [f"e{i}" for i in range(20)])
        # its containment edges, served with it, carry the draft's values
        assert {e.id: e.properties for e in first.containment_edges} == \
            {f"c{i}": {"full": f"c{i}"} for i in range(20)}
        # ... and so do the lineage edges between them, served as the page's lineage
        assert sorted(e.id for e in first.lineage_edges) == ["l01", "l12"]
        assert all(e.properties == {"full": e.id} for e in first.lineage_edges)
        assert svc.edge_loads == [sorted(f"c{i}" for i in range(20)), ["l01", "l12"]]

        svc = Svc()
        later = await _prov(svc).get_children_with_edges("P", edge_types=["CONTAINS"], offset=1, limit=100)
        assert later.children == [] and later.total_children == 21, later
        assert _loaded(svc) == [], "a later page serves none of them: nothing loaded"

        svc = Svc()
        top = await _prov(svc).get_top_level_or_orphan_nodes()
        assert sorted(n.urn for n in top.nodes) == sorted(["P"] + [f"N{i}" for i in range(20, 30)])
        assert _loaded(svc) == sorted(f"e{i}" for i in range(20, 30))
        svc = Svc()
        later = await _prov(svc).get_top_level_or_orphan_nodes(cursor="P")
        assert later.nodes == [] and _loaded(svc) == []
    asyncio.run(run())


def test_edges_load_only_for_the_response_that_serves_them():
    async def run():
        svc = Svc()
        p = _prov(svc)
        edges = await p.get_edges(EdgeQuery(sourceUrns=["N1"]))
        assert [(e.id, e.properties, e.confidence) for e in edges] == [("l12", {"full": "l12"}, 0.7)]
        assert svc.edge_loads == [["l12"]] and svc.loads == []

        # A broad query loads at most its limit of the draft's own 22 edges, not all of them.
        broad = Svc()
        assert len(await _prov(broad).get_edges(EdgeQuery(limit=3))) == 3
        assert sum(len(ids) for ids in broad.edge_loads) == 3

        trace = await p.trace_at_level("N1", 0, 1, 1, ["LINEAGE"], ["CONTAINS"], 100, 1000)
        assert sorted((e.id, e.properties["full"]) for e in trace.edges) == [("l01", "l01"), ("l12", "l12")]
        assert svc.edge_loads == [["l12"], ["l01"]], "l12 was loaded for this request already"

        # Counting reads use the skeletons alone.
        svc = Svc()
        p = _prov(svc)
        await p.get_node_degrees(["N0", "N1", "P"], ["LINEAGE"])
        await p.get_aggregated_edges_between(["P"], ["P"], None, ["CONTAINS"], ["LINEAGE"])
        assert svc.loads == [] and svc.edge_loads == []
    asyncio.run(run())


def test_the_index_is_built_off_the_event_loop_and_shared(monkeypatch):
    built = []
    real = asyncio.to_thread

    async def to_thread(fn, *a, **k):
        built.append(fn)
        return await real(fn, *a, **k)

    monkeypatch.setattr(draft_overlay_provider.asyncio, "to_thread", to_thread)

    async def run():
        svc = Svc()
        await asyncio.gather(*(_prov(svc).get_node("N1") for _ in range(4)))
        await _prov(svc).get_node("N2")
        assert built == [draft_overlay_provider._OverlayDelta], built
    asyncio.run(run())
