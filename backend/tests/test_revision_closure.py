"""Lineage closures at a past revision, and the walk they share — no database.

``bounded_closure`` walks a focus's lineage over any reader of edges and nodes: the Postgres
reader's over a branch, and a past revision's over the overlay's own reads, each as it was then. It
keeps the FalkorDB closure's contract without its paging: the next hop past the requested depth is
a ``depth`` frontier entry, what the budget or the deadline stopped is a ``cut`` one that a client
re-roots from (``seedUrns``, holding what it has in ``excludeUrns``), and a dead end is neither.
A walk follows only the ends it asked about, whatever a reader serves besides: the overlay's value
of an edge re-pointed since is served for its ends then, never the ones the store found it by.
"""
import asyncio
import itertools

from backend.app.providers.draft_overlay_provider import DraftOverlayProvider
from backend.app.providers.versioned_branch_provider import bounded_closure
from backend.common.models.graph import EdgeQuery, GraphEdge, GraphNode

L, C = ["FLOWS"], ["CONTAINS"]
_GRAPHS = itertools.count()


def _e(eid, src, tgt, typ="FLOWS"):
    return GraphEdge(id=eid, sourceUrn=src, targetUrn=tgt, edgeType=typ)


class Graph:
    """A reader of one fixed graph, as any store answers: by ends and types."""
    name = "graph"
    manager_cache_key = ("prov", "key")

    def __init__(self, edges, nodes=None, extra=()):
        self.edges = list(edges)
        self.nodes = set(nodes or {u for e in self.edges for u in (e.source_urn, e.target_urn)})
        self.extra = list(extra)                     # served with every edge read, asked or not

    def set_containment_edge_types(self, *a, **k):
        pass

    async def get_edges(self, query: EdgeQuery):
        src, tgt = set(query.source_urns or []), set(query.target_urns or [])
        out = [e for e in self.edges
               if (not src or e.source_urn in src) and (not tgt or e.target_urn in tgt)
               and (not query.edge_types or e.edge_type in query.edge_types)]
        return (out + self.extra)[:query.limit]

    async def get_nodes(self, query):
        return [GraphNode(urn=u, entityType="Column", displayName=u)
                for u in (query.urns or []) if u in self.nodes]


#: T holds c1 and c2. u2 -> u1 -> c1 -> d1 -> d2, and c2 -> e1, a dead end.
FLOW = [_e("k1", "T", "c1", "CONTAINS"), _e("k2", "T", "c2", "CONTAINS"),
        _e("f1", "u2", "u1"), _e("f2", "u1", "c1"), _e("f3", "c1", "d1"), _e("f4", "d1", "d2"),
        _e("f5", "c2", "e1")]


def _walk(reader, urn="T", up=5, down=5, max_nodes=2000, timeout_ms=10_000, **kw):
    return asyncio.run(bounded_closure(reader, urn, up, down, L, C, max_nodes, timeout_ms, **kw))


def _frontier(entries):
    return sorted((f.urn, f.total_count, f.reason) for f in entries)


def test_the_next_hop_past_the_depth_is_offered_and_a_dead_end_is_not():
    r = _walk(Graph(FLOW), up=1, down=1)
    assert {n.urn for n in r.nodes} == {"T", "c1", "c2", "u1", "d1", "e1"}
    assert not r.truncated
    assert _frontier(r.frontier_up) == [("u1", 1, "depth")]
    assert _frontier(r.frontier_down) == [("d1", 1, "depth")]          # e1 has nothing further
    whole = _walk(Graph(FLOW))
    assert {n.urn for n in whole.nodes} == {"T", "c1", "c2", "u1", "u2", "d1", "d2", "e1"}
    assert whole.frontier_up == [] and whole.frontier_down == []


def test_re_rooting_from_what_the_budget_cut_finishes_the_closure():
    graph = Graph(FLOW)
    r = _walk(graph, max_nodes=2)
    assert r.truncated and r.truncation_reason == "max_nodes"
    held = {n.urn for n in r.nodes}
    edges = {e.id for e in r.edges}
    cut = [f.urn for f in [*r.frontier_up, *r.frontier_down] if f.reason == "cut"]
    for _ in range(10):                             # a client completing it hands-free
        if not cut:
            break
        more = _walk(graph, max_nodes=2, seed_urns=cut, exclude_urns=sorted(held))
        # What the client holds is not shipped again, save where the walk started and the focus.
        assert not ({n.urn for n in more.nodes} - set(cut) - {"T"}) & held
        held |= {n.urn for n in more.nodes}
        edges |= {e.id for e in more.edges}
        cut = [f.urn for f in [*more.frontier_up, *more.frontier_down] if f.reason == "cut"]
    assert not cut
    assert held == {"T", "c1", "c2", "u1", "u2", "d1", "d2", "e1"}
    assert edges == {"f1", "f2", "f3", "f4", "f5"}


def test_a_walk_past_its_deadline_says_so_and_cuts_where_it_stood():
    r = _walk(Graph(FLOW), timeout_ms=0)
    assert r.truncated and r.truncation_reason == "timeout"
    assert {f.urn for f in r.frontier_up} == {"c1"}             # lineage that way, unread
    assert {f.urn for f in r.frontier_down} == {"c1", "c2"}
    assert all(f.reason == "cut" for f in [*r.frontier_up, *r.frontier_down])


def test_a_walk_follows_only_the_ends_it_asked_about():
    stray = _e("s1", "zz", "yy")                    # served with every read, of other ends
    r = _walk(Graph(FLOW, extra=[stray]))
    assert "s1" not in {e.id for e in r.edges}
    assert not {"zz", "yy"} & {n.urn for n in r.nodes}


# ── At a past revision ─────────────────────────────────────────────────────────────────────────

#: main now: since the revision it re-pointed f3 from d1 to x, drew f9 (c1 -> n1, n1 made since)
#: and deleted f8 (c1 -> g1).
NOW = [_e("k1", "T", "c1", "CONTAINS"), _e("f2", "u1", "c1"), _e("f3", "c1", "x"),
       _e("f9", "c1", "n1"), _e("f4", "d1", "d2")]
#: main then.
THEN = {"f3": {"id": "f3", "sourceUrn": "c1", "targetUrn": "d1", "edgeType": "FLOWS"},
        "f8": {"id": "f8", "sourceUrn": "c1", "targetUrn": "g1", "edgeType": "FLOWS"}}
PATCH = {"nodesUpsert": [], "nodesNew": [], "nodesModified": [],
         "nodesRemove": [{"entityId": "en1", "urn": "n1"}],
         "edgesUpsert": [{"id": "f8", "sourceUrn": "c1", "targetUrn": "g1", "edgeType": "FLOWS",
                          "lazy": True},
                         {"id": "f3", "sourceUrn": "c1", "targetUrn": "d1", "edgeType": "FLOWS",
                          "lazy": True,
                          "was": {"sourceUrn": "c1", "targetUrn": "x", "edgeType": "FLOWS"}}],
         "edgesRemove": [{"id": "f9", "sourceUrn": "c1", "targetUrn": "n1", "edgeType": "FLOWS"}]}


class Svc:
    async def revision_overlay_delta(self, *, graph_id, as_of_seq, head_seq, extend=None):
        return {**PATCH, "since": {"asOf": as_of_seq, "head": head_seq}}

    async def overlay_payloads(self, *, graph_id, branch_id, entity_ids, kind="node",
                               as_of_seq=None):
        return [{**THEN[e], "properties": {}} for e in entity_ids if e in THEN] if kind == "edge" else []


def _revision():
    p = DraftOverlayProvider(Graph(NOW, nodes={"T", "c1", "u1", "x", "n1", "d1", "d2", "g1"}),
                             svc=Svc(), graph_id=f"closure{next(_GRAPHS)}", branch_id="main",
                             as_of_seq=3, version=("rev", 3, 9), read_ns="rev3@9")
    p.set_containment_edge_types(C)
    return p


def test_a_closure_at_a_revision_walks_the_graph_as_it_was():
    r = asyncio.run(_revision().trace_closure("T", 5, 5, L, C, 2000, 10_000))
    assert {n.urn for n in r.nodes} == {"T", "c1", "u1", "d1", "d2", "g1"}
    assert sorted((e.id, e.source_urn, e.target_urn) for e in r.edges) == [
        ("f2", "u1", "c1"), ("f3", "c1", "d1"), ("f4", "d1", "d2"), ("f8", "c1", "g1")]
    assert r.upstream_urns == {"u1"} and r.downstream_urns == {"d1", "d2", "g1"}
    assert not r.truncated


def test_an_edge_re_pointed_since_is_served_for_its_ends_then():
    p = _revision()

    async def ids(**kw):
        return sorted(e.id for e in await p.get_edges(EdgeQuery(edge_types=L, **kw)))

    async def run():
        assert await ids(target_urns=["x"]) == []                  # it pointed at d1 then
        assert await ids(target_urns=["d1"]) == ["f3"]
        assert await ids(source_urns=["c1"]) == ["f3", "f8"]       # f9 was drawn since

    asyncio.run(run())
