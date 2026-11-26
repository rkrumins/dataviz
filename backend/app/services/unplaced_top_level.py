"""The top-level entities of some types that a view does not place.

A view's health check asks this once per load (``POST /nodes/top-level/unplaced``): the canvas
sends the types the view is about and the urns it places of them, and learns how many top-level
entities of those types it leaves out, by type, and the first of them by name.

Read through the reader's own top-level read — label-indexed and keyset-paged on every provider,
and the draft's own on a branch — page by page to the end of the set, and no further than a
ceiling: a source with more top-level entities than that answers a lower bound, and says so.
"""
from __future__ import annotations

from typing import Awaitable, Callable, Collection, Dict, List, Optional, Set

from backend.common.models.graph import GraphNode, TopLevelNodesResult, UnplacedTopLevelResult

#: Rows asked for per page of the provider's top-level read (its own maximum).
PAGE_SIZE = 1000
#: Top-level entities read at most, before the counts become a lower bound.
SCAN_CEILING = 20_000

ReadPage = Callable[[Optional[str], int], Awaitable[TopLevelNodesResult]]


async def unplaced_top_level(
    read_page: ReadPage,
    *,
    placed: Collection[str],
    limit: int,
    page_size: int = PAGE_SIZE,
    ceiling: int = SCAN_CEILING,
) -> UnplacedTopLevelResult:
    """``read_page(cursor, size)`` is one page of the top-level set, in name order. Every one not
    in ``placed`` is counted under its type; the first ``limit`` of them are returned."""
    placed_set = set(placed)
    seen: Set[str] = set()
    nodes: List[GraphNode] = []
    by_type: Dict[str, int] = {}
    read = 0
    cursor: Optional[str] = None
    while True:
        page = await read_page(cursor, page_size)
        read += len(page.nodes)
        for node in page.nodes:
            if node.urn in seen:
                continue
            seen.add(node.urn)
            if node.urn in placed_set:
                continue
            by_type[node.entity_type] = by_type.get(node.entity_type, 0) + 1
            if len(nodes) < limit:
                nodes.append(node)
        complete = not page.has_more or not page.next_cursor
        if complete or read >= ceiling:
            break
        cursor = page.next_cursor
    return UnplacedTopLevelResult(
        nodes=nodes, byType=by_type, totalCount=sum(by_type.values()), complete=complete,
    )
