"""Live export — a data source without version control, streamed straight from its graph.

Such a source has no version store to read, so its export reads the graph provider itself, a page
at a time (``scan_nodes`` then ``scan_edges``), into the same rows as a versioned export. The rows
carry no entity ids or base versions (only a version store mints those), so importing the file
matches its entities by URN: a cold copy of the source, restorable into a version-controlled one.
The graph isn't pinned while the export runs: a change made meanwhile may or may not be in it.

Where each node sits (``common.ancestry_columns``) is the provider's own containment chains, read a
thousand nodes at a time as each page goes out (:func:`placer`).
"""
from __future__ import annotations

from typing import Any, AsyncIterator, Awaitable, Callable, Dict, List, Optional, Tuple

from backend.common import ancestry_columns as ancestry
from backend.common.derived_artifacts import derived_edge_total
from backend.common.models.graph import GraphEdge, GraphNode, NodeQuery

from .rowmodel import denormalize_edge, denormalize_node
from .snapshot import PAGE_SIZE

Place = Callable[[List[Dict[str, Any]]], Awaitable[None]]


def _node_record(n: GraphNode) -> Dict[str, Any]:
    # A provider fills an absent field with "" as often as None; either way the row leaves it out.
    payload = {"urn": n.urn, "entityType": n.entity_type, "displayName": n.display_name,
               "qualifiedName": n.qualified_name or None, "description": n.description or None,
               "sourceSystem": n.source_system or None, "layerAssignment": n.layer_assignment or None,
               "tags": n.tags, "properties": n.properties}
    return {"kind": "node", **denormalize_node("", "", payload)}


def _edge_record(e: GraphEdge) -> Dict[str, Any]:
    payload = {"edgeType": e.edge_type, "confidence": e.confidence, "properties": e.properties}
    return {"kind": "edge", **denormalize_edge("", "", payload, source_urn=e.source_urn,
                                               target_urn=e.target_urn)}


def placer(provider) -> Place:
    """What says where each node of a page sits: ``provider.get_ancestor_chains`` (the chains the
    canvas nests by), and one lookup that names the containers not met yet in this export."""
    known: ancestry.Names = {}

    async def lookup(urns: List[str]) -> Dict[str, Tuple[str, str]]:
        nodes = await provider.get_nodes(NodeQuery(urns=urns, limit=len(urns), include_child_count=False))
        return {n.urn: (n.display_name or n.urn, n.entity_type or "") for n in nodes}

    async def place(records: List[Dict[str, Any]]) -> None:
        for r in records:                                # a container is often in the page itself
            if r.get("urn") and len(known) < ancestry.NAMES_MAX:
                known.setdefault(r["urn"], (r.get("displayName") or r["urn"], r.get("entityType") or ""))
        await ancestry.place(records, provider.get_ancestor_chains, lookup, known)

    return place


async def record_pages(provider, page_size: int = PAGE_SIZE,
                       place: Optional[Place] = None) -> AsyncIterator[List[Dict[str, Any]]]:
    """The data source's records, a page at a time: every node, then every edge. ``place``
    (:func:`placer`): each node says where it sits."""
    async for page in provider.scan_nodes(page_size):
        records = [_node_record(n) for n in page]
        if place is not None:
            await place(records)
        yield records
    async for page in provider.scan_edges(page_size):
        yield [_edge_record(e) for e in page]


async def counts(provider) -> Dict[str, Any]:
    """Nodes and edges from the provider's statistics (the platform's own bookkeeping left out):
    a fast estimate, not a count taken while exporting."""
    stats = await provider.get_stats()
    edges = int(stats.get("edgeCount") or 0) - derived_edge_total(stats.get("edgeTypeCounts") or {})
    return {"nodes": int(stats.get("nodeCount") or 0), "edges": max(0, edges), "exact": False}
