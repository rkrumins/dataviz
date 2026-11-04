"""A draft that created thousands of entities lists them a page at a time.

A 100k-entity import into a draft put every created node on the first page of each listing it
touched — the top level, a container's children, a type's feed — loading each one's value, so the
canvas asked for 200 roots and got 100,200. The first page now holds at most a page of what the
draft added (in name order); the rest follow main's last page at positions the overlay owns
(``_TAIL_OFFSET`` / ``_TAIL_CURSOR``). These drive the overlay the way the canvas pager does —
follow the server's position until ``hasMore`` is false — and require every item exactly once,
no page holding more than a page of the draft's, and values loaded only for what a page serves.
"""
import asyncio
from typing import List

from backend.app.providers.draft_overlay_provider import _TAIL_OFFSET, DraftOverlayProvider
from backend.common.models.graph import (ChildrenWithEdgesResult, GraphNode, NodePage, NodeQuery,
                                         TopLevelNodesResult)


def _n(urn, name=None, typ="dataPlatform"):
    return GraphNode(urn=urn, entityType=typ, displayName=name or urn)


class Main:
    """Main that pages for real: exact totals and positions, keyset cursors for roots."""

    def __init__(self, children: List[str] = (), roots: List[str] = (), typed: List[str] = ()):
        self.children = sorted(children)
        self.roots = sorted(roots)
        self.typed = sorted(typed)
        self.calls: List[str] = []

    def set_containment_edge_types(self, *a, **k):
        pass

    async def get_children_with_edges(self, parent_urn, *, offset=0, limit=100, cursor=None, **kw):
        self.calls.append(f"children@{offset}")
        assert offset < _TAIL_OFFSET, "an overlay tail position reached the store"
        page = self.children[offset:offset + limit]
        return ChildrenWithEdgesResult(
            children=[_n(u) for u in page], containmentEdges=[], lineageEdges=[],
            totalChildren=len(self.children), hasMore=offset + limit < len(self.children),
            nextCursor=None, nextOffset=offset + len(page))

    async def get_top_level_or_orphan_nodes(self, *, limit=100, cursor=None, **kw):
        assert not (cursor or "").startswith("~overlay"), "an overlay tail cursor reached the store"
        start = self.roots.index(cursor) + 1 if cursor else 0
        page = self.roots[start:start + limit]
        more = start + limit < len(self.roots)
        return TopLevelNodesResult(nodes=[_n(u) for u in page], totalCount=len(self.roots),
                                   hasMore=more, nextCursor=page[-1] if more else None,
                                   rootTypeCount=len(page), orphanCount=0)

    async def get_nodes_page(self, query: NodeQuery) -> NodePage:
        offset, limit = query.offset or 0, query.limit or 100
        assert offset < _TAIL_OFFSET, "an overlay tail position reached the store"
        page = self.typed[offset:offset + limit]
        return NodePage(nodes=[_n(u, typ="Table") for u in page],
                        hasMore=offset + limit < len(self.typed), nextOffset=offset + len(page))

    async def get_nodes(self, query):
        if query.urns:
            return [_n(u) for u in query.urns if u in self.roots or u in self.children]
        self.calls.append(f"nodes@{query.offset}+{query.limit}")
        return [_n(u, typ="Table") for u in self.typed[query.offset:query.offset + query.limit]]

    async def search_nodes(self, query, limit=10, offset=0):
        self.calls.append(f"search@{offset}+{limit}")
        return [_n(u, typ="Table") for u in [t for t in self.typed if query in t][offset:offset + limit]]


class Svc:
    """The draft's patch set: created nodes as lazy skeletons, whose values a read loads."""

    def __init__(self, delta):
        self._delta = delta
        self._version = object()
        self.loaded: List[List[str]] = []       # node values a read loaded, per call
        self.edges_loaded: List[List[str]] = []

    async def overlay_version(self, *, graph_id, branch_id):
        return (self._version,)

    async def branch_overlay_delta(self, *, graph_id, branch_id):
        return self._delta

    async def overlay_payloads(self, *, graph_id, branch_id, entity_ids, kind="node"):
        if kind == "edge":
            self.edges_loaded.append(list(entity_ids))
            return []
        self.loaded.append(list(entity_ids))
        return [{"urn": e.replace("eid:", ""), "entityType": "Table",
                 "displayName": e.replace("eid:", "")} for e in entity_ids]


def _skeleton(urn, typ="Table"):
    return {"urn": urn, "entityId": f"eid:{urn}", "entityType": typ, "displayName": urn,
            "qualifiedName": None, "lazy": True}


def _edge(i, src, tgt):
    return {"id": i, "sourceUrn": src, "targetUrn": tgt, "edgeType": "CONTAINS", "lazy": True}


def _draft(main, *, children=(), roots=()):
    created = [*children, *roots]
    svc = Svc({"nodesUpsert": [_skeleton(u) for u in created], "nodesNew": created,
               "nodesModified": [], "nodesRemove": [],
               "edgesUpsert": [_edge(f"e-{u}", "S", u) for u in children], "edgesRemove": []})
    p = DraftOverlayProvider(main, svc=svc, graph_id="g", branch_id=f"d-{id(svc)}")
    p.set_containment_edge_types(["CONTAINS"])
    return p, svc


def _created(n, prefix="new"):
    return [f"{prefix}{i:04d}" for i in range(n)]


def test_a_containers_new_children_come_a_page_at_a_time_each_once():
    main = Main(children=["m0", "m1", "m2"])
    p, svc = _draft(main, children=_created(250))

    async def run():
        seen, pages, offset = [], [], 0
        for _ in range(20):
            r = await p.get_children_with_edges("S", offset=offset, limit=100)
            pages.append([c.urn for c in r.children])
            seen += pages[-1]
            assert r.total_children == 253
            # Containment edges travel with the children a page serves, not all at once.
            assert {e.target_urn for e in r.containment_edges} <= set(pages[-1])
            if not r.has_more or r.next_offset <= offset:
                return seen, pages
            offset = r.next_offset
        raise AssertionError("paging never ended")

    seen, pages = asyncio.run(run())
    assert sorted(seen) == sorted(["m0", "m1", "m2", *_created(250)]) and len(seen) == 253
    assert all(sum(u.startswith("new") for u in page) <= 100 for page in pages)
    # Values were loaded for what each page served, never for all 250 at once.
    assert max(len(ids) for ids in svc.loaded) <= 100
    assert sum(len(ids) for ids in svc.loaded) == 250
    # ...and their containment links with them.
    assert max(len(ids) for ids in svc.edges_loaded) <= 100
    assert sum(len(ids) for ids in svc.edges_loaded) == 250


def test_new_children_are_in_name_order_and_main_keeps_its_positions():
    main = Main(children=[f"m{i}" for i in range(150)])
    p, _svc = _draft(main, children=["zeta", "alpha", "mu"])

    async def run():
        first = await p.get_children_with_edges("S", offset=0, limit=100)
        second = await p.get_children_with_edges("S", offset=first.next_offset, limit=100)
        return first, second

    first, second = asyncio.run(run())
    assert [c.urn for c in first.children][-3:] == ["alpha", "mu", "zeta"]
    assert first.next_offset == 100                       # main's position, untouched by the draft's
    assert len(second.children) == 50 and not second.has_more


def test_new_roots_page_by_cursor_into_the_overlays_tail():
    main = Main(roots=["A", "B", "C"])
    p, _svc = _draft(main, roots=_created(230, "root"))

    async def run():
        seen, cursor, pages = [], None, 0
        while True:
            r = await p.get_top_level_or_orphan_nodes(limit=100, cursor=cursor)
            seen += [n.urn for n in r.nodes]
            pages += 1
            assert sum(n.urn.startswith("root") for n in r.nodes) <= 100
            if not r.has_more:
                return seen, pages
            assert r.next_cursor and r.next_cursor != cursor
            cursor = r.next_cursor

    seen, pages = asyncio.run(run())
    assert sorted(seen) == sorted(["A", "B", "C", *_created(230, "root")]) and len(seen) == 233
    assert pages == 3


def test_a_types_feed_pages_its_new_nodes_by_offset():
    main = Main(typed=[f"t{i:03d}" for i in range(120)])
    p, _svc = _draft(main, roots=_created(260))

    async def run():
        seen, offset = [], 0
        for _ in range(20):
            page = await p.get_nodes_page(NodeQuery(entityTypes=["Table"], offset=offset, limit=100))
            seen += [n.urn for n in page.nodes]
            assert sum(n.urn.startswith("new") for n in page.nodes) <= 100
            if not page.has_more or page.next_offset <= offset:   # the canvas's feedAfter rule
                return seen
            offset = page.next_offset
        raise AssertionError("paging never ended")

    seen = asyncio.run(run())
    assert sorted(seen) == sorted([*(f"t{i:03d}" for i in range(120)), *_created(260)])
    assert len(seen) == 380


def test_a_lookup_by_urn_reads_only_the_urns_it_names():
    """Hydration asks for created nodes 100 urns at a time. Each batch used to test every node the
    draft holds against a set of the batch built again for each node."""
    main = Main(roots=[])
    p, _svc = _draft(main, roots=_created(5000))

    class NoScan(dict):
        def items(self):
            raise AssertionError("a lookup by urn scanned the whole patch set")

    async def run():
        d = await p._delta_()
        d.node_index = NoScan(d.node_index)
        return await p.get_nodes(NodeQuery(urns=["new0007", "new4999", "missing"], limit=100))

    assert sorted(n.urn for n in asyncio.run(run())) == ["new0007", "new4999"]


def test_a_listing_pages_the_drafts_new_nodes_then_mains_each_once():
    """A listing (no urns) is one order — the draft's new nodes, then main's rows — and each page a
    slice of it. The new nodes were served on the first page only, so a listing never reached past
    its first ``limit`` of them; main's rows now come at offsets moved by how many there are."""
    main = Main(typed=[f"main{i:03d}" for i in range(70)])
    p, _svc = _draft(main, roots=_created(120))

    async def run():
        pages, offset = [], 0
        while True:
            page = await p.get_nodes(NodeQuery(entityTypes=["Table"], offset=offset, limit=50))
            if not page:
                return pages
            pages.append([n.urn for n in page])
            offset += 50

    pages = asyncio.run(run())
    assert [u for page in pages for u in page] == _created(120) + [f"main{i:03d}" for i in range(70)]
    assert [len(page) for page in pages] == [50, 50, 50, 40]
    assert main.calls == ["nodes@0+30", "nodes@30+50", "nodes@80+50"], "main read only where a page reaches it"


def test_search_pages_the_drafts_new_matches_then_mains():
    main = Main(typed=["newmain1", "newmain2"])
    p, _svc = _draft(main, roots=_created(15))

    async def run():
        return [[n.urn for n in await p.search_nodes("new", limit=10, offset=o)] for o in (0, 10, 20)]

    first, second, third = asyncio.run(run())
    assert first == _created(10)
    assert second == _created(15)[10:] + ["newmain1", "newmain2"]
    assert third == []
    assert main.calls == ["search@0+5", "search@5+10"]
