"""Live export — a data source without version control, streamed straight from its graph.

Such a source has no version store to read, so its export reads the graph provider itself, a page
at a time (``scan_nodes`` then ``scan_edges``), into the same rows as a versioned export. The rows
carry no entity ids or base versions (only a version store mints those), so importing the file
matches its entities by URN: a cold copy of the source, restorable into a version-controlled one.
The graph isn't pinned while the export runs: a change made meanwhile may or may not be in it.
"""
from __future__ import annotations

from typing import Any, AsyncIterator, Dict, List

from backend.common.derived_artifacts import derived_edge_total
from backend.common.models.graph import GraphEdge, GraphNode

from .rowmodel import denormalize_edge, denormalize_node
from .snapshot import PAGE_SIZE


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


async def record_pages(provider, page_size: int = PAGE_SIZE) -> AsyncIterator[List[Dict[str, Any]]]:
    """The data source's records, a page at a time: every node, then every edge."""
    async for page in provider.scan_nodes(page_size):
        yield [_node_record(n) for n in page]
    async for page in provider.scan_edges(page_size):
        yield [_edge_record(e) for e in page]


async def counts(provider) -> Dict[str, Any]:
    """Nodes and edges from the provider's statistics (the platform's own bookkeeping left out):
    a fast estimate, not a count taken while exporting."""
    stats = await provider.get_stats()
    edges = int(stats.get("edgeCount") or 0) - derived_edge_total(stats.get("edgeTypeCounts") or {})
    return {"nodes": int(stats.get("nodeCount") or 0), "edges": max(0, edges), "exact": False}
