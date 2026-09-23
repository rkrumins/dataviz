"""A draft's listings page exactly like main's, plus the draft — nothing skipped, nothing repeated.

Reported 2026-09-22: adding a child in a draft made an existing sibling vanish, a second added
child made another vanish, and "Load N more" never loaded anything. The overlay served the new
child on every page, counted it into the position (skipping a row of main per added child) and
reported the page length as the total. These tests drive the overlay the way the canvas pager
does — follow ``nextOffset`` / ``nextCursor`` until ``hasMore`` is false — and require the union
of pages to be exactly main's listing with the draft applied, each item once.
"""
import asyncio
from typing import List

from backend.app.providers.draft_overlay_provider import DraftOverlayProvider
from backend.common.models.graph import ChildrenWithEdgesResult, GraphNode, TopLevelNodesResult


def _n(urn, name=None, **kw):
    return GraphNode(urn=urn, entityType="dataPlatform", displayName=name or urn, **kw)


class PagingMain:
    """Main that pages for real: exact totals and positions, keyset cursors for roots."""

    def __init__(self, children: List[str], roots: List[str]):
        self.children = sorted(children)
        self.roots = sorted(roots)

    def set_containment_edge_types(self, *a, **k):
        pass

    async def get_children_with_edges(self, parent_urn, *, offset=0, limit=100, cursor=None, **kw):
        page = self.children[offset:offset + limit]
        return ChildrenWithEdgesResult(
            children=[_n(u) for u in page], containmentEdges=[], lineageEdges=[],
            totalChildren=len(self.children), hasMore=offset + limit < len(self.children),
            nextCursor=None, nextOffset=offset + len(page))

    async def get_top_level_or_orphan_nodes(self, *, limit=100, cursor=None, **kw):
        start = self.roots.index(cursor) + 1 if cursor else 0
        page = self.roots[start:start + limit]
        more = start + limit < len(self.roots)
        return TopLevelNodesResult(nodes=[_n(u) for u in page], totalCount=len(self.roots),
                                   hasMore=more, nextCursor=page[-1] if more else None,
                                   rootTypeCount=len(page), orphanCount=0)


class FakeSvc:
    def __init__(self, delta):
        self._delta = delta

    async def branch_overlay_delta(self, *, graph_id, branch_id):
        return self._delta


def _edge(i, src, tgt):
    return {"id": i, "sourceUrn": src, "targetUrn": tgt, "edgeType": "CONTAINS",
            "confidence": 1.0, "properties": {}}


def _draft(main, *, add_children=(), remove_children=(), add_roots=()):
    delta = {
        "nodesUpsert": [{"urn": u, "entityType": "app", "displayName": u}
                        for u in (*add_children, *add_roots)],
        "nodesNew": [*add_children, *add_roots],
        "nodesRemove": [{"urn": u} for u in remove_children],
        "edgesUpsert": [_edge(f"e-{u}", "S", u) for u in add_children],
        "edgesRemove": [_edge(f"r-{u}", "S", u) for u in remove_children],
    }
    p = DraftOverlayProvider(main, svc=FakeSvc(delta), graph_id="g", branch_id="d")
    p.set_containment_edge_types(["CONTAINS"])
    return p


def _page_children(p, limit):
    """The canvas pager: follow the server's position until it says there is no more."""
    async def run():
        seen, offset, total = [], 0, None
        for _ in range(20):
            r = await p.get_children_with_edges("S", offset=offset, limit=limit)
            seen += [c.urn for c in r.children]
            total = r.total_children
            if not r.has_more or r.next_offset <= offset:
                return seen, total
            offset = r.next_offset
        raise AssertionError("paging never ended")
    return asyncio.run(run())


def test_an_added_child_hides_no_sibling_and_paging_ends():
    seen, total = _page_children(_draft(PagingMain(["r0", "r1", "r2"], []), add_children=["111"]), 2)
    assert sorted(seen) == ["111", "r0", "r1", "r2"] and len(seen) == 4
    assert total == 4


def test_two_added_children_hide_nothing():
    seen, total = _page_children(
        _draft(PagingMain(["r0", "r1"], []), add_children=["111", "222"]), 2)
    assert sorted(seen) == ["111", "222", "r0", "r1"] and len(seen) == 4
    assert total == 4


def test_a_removed_child_neither_ends_paging_early_nor_repeats():
    seen, total = _page_children(_draft(PagingMain(["r0", "r1", "r2"], []), remove_children=["r1"]), 1)
    assert seen == ["r0", "r2"]
    assert total == 2


def test_a_draft_root_appears_once_across_cursor_pages_with_the_right_total():
    p = _draft(PagingMain([], ["A", "B", "C"]), add_roots=["N"])

    async def run():
        first = await p.get_top_level_or_orphan_nodes(limit=2)
        second = await p.get_top_level_or_orphan_nodes(limit=2, cursor=first.next_cursor)
        return first, second
    first, second = asyncio.run(run())
    assert [n.urn for n in first.nodes] == ["A", "B", "N"]
    assert [n.urn for n in second.nodes] == ["C"], "a new root must not repeat on later pages"
    assert first.total_count == 4 and second.total_count == 4
