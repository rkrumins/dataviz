"""FalkorDB single-hop lineage traversal — ``SimpleLineageMixin``.

Carved from ``backend/app/providers/falkordb/provider.py``'s
``FalkorDBProvider`` class body as it stood before this split:
``_traverse_lineage`` through ``get_full_lineage`` (lines 1115-1233), a
single contiguous block.

This mixin walks upstream/downstream edges one call at a time
(``get_upstream``, ``get_downstream``, ``get_full_lineage``, all built on
the shared ``_traverse_lineage`` helper) — the simple counterpart to the
trace/closure machinery elsewhere in the provider. See carve-protocol.md
in ``.superpowers/sdd/2026-08-30-pr1-falkordb-decoupling/`` for why this
has to be a mixin rather than a delegate/helper object.
"""
from typing import Any, Dict, List, Optional, Set

from backend.app.models.graph import EdgeQuery, LineageResult, NodeQuery


class SimpleLineageMixin:
    """Single-hop upstream/downstream lineage traversal."""

    async def _traverse_lineage(
        self,
        start_urn: str,
        direction: str,
        depth: int,
        descendant_types: Optional[List[str]] = None,
    ) -> Set[str]:
        """Single-query lineage traversal using bounded variable-length Cypher paths.

        Uses *1..{depth} (literal bound) instead of unbounded *1.. so the
        query planner can prune early. Entity-type filtering is pushed into
        Cypher via labels(neighbor)[0] rather than fetching all nodes to
        filter in Python.
        """
        await self._ensure_connected()
        containment = list(self._get_containment_edge_types())
        safe_depth = max(1, min(int(depth), 20))  # Clamp to sane range
        params: Dict[str, Any] = {
            "startUrn": start_urn,
            "containmentTypes": containment,
        }

        # Entity-type filter pushed into Cypher
        type_clause = ""
        if descendant_types:
            allowed = [t.value if hasattr(t, "value") else str(t) for t in descendant_types]
            params["allowedTypes"] = allowed
            type_clause = "AND labels(neighbor)[0] IN $allowedTypes "

        if direction == "upstream":
            cypher = (
                f"MATCH (start) WHERE start.urn = $startUrn "
                f"MATCH path = (neighbor)-[*1..{safe_depth}]->(start) "
                f"WHERE ALL(r IN relationships(path) WHERE NOT type(r) IN $containmentTypes) "
                f"{type_clause}"
                f"RETURN DISTINCT neighbor.urn AS urn"
            )
        else:
            cypher = (
                f"MATCH (start) WHERE start.urn = $startUrn "
                f"MATCH path = (start)-[*1..{safe_depth}]->(neighbor) "
                f"WHERE ALL(r IN relationships(path) WHERE NOT type(r) IN $containmentTypes) "
                f"{type_clause}"
                f"RETURN DISTINCT neighbor.urn AS urn"
            )

        result = await self._ro_query(cypher, params=params)
        return {
            row[0] for row in (result.result_set or [])
            if row[0] and row[0] != start_urn
        }

    async def get_upstream(
        self,
        urn: str,
        depth: int,
        include_column_lineage: bool = False,
        descendant_types: Optional[List[str]] = None,
    ) -> LineageResult:
        upstream_urns = await self._traverse_lineage(urn, "upstream", depth, descendant_types)
        all_urns = upstream_urns | {urn}
        nodes = await self.get_nodes(NodeQuery(urns=list(all_urns), limit=len(all_urns), include_child_count=False))
        node_ids = {n.urn for n in nodes}
        edges = await self.get_edges(EdgeQuery(any_urns=list(all_urns), limit=len(all_urns) * 10))
        edges = [e for e in edges if e.source_urn in node_ids and e.target_urn in node_ids]
        return LineageResult(
            nodes=nodes,
            edges=edges,
            upstreamUrns=upstream_urns,
            downstreamUrns=set(),
            totalCount=len(nodes),
            hasMore=False,
        )

    async def get_downstream(
        self,
        urn: str,
        depth: int,
        include_column_lineage: bool = False,
        descendant_types: Optional[List[str]] = None,
    ) -> LineageResult:
        downstream_urns = await self._traverse_lineage(urn, "downstream", depth, descendant_types)
        all_urns = downstream_urns | {urn}
        nodes = await self.get_nodes(NodeQuery(urns=list(all_urns), limit=len(all_urns), include_child_count=False))
        node_ids = {n.urn for n in nodes}
        edges = await self.get_edges(EdgeQuery(any_urns=list(all_urns), limit=len(all_urns) * 10))
        edges = [e for e in edges if e.source_urn in node_ids and e.target_urn in node_ids]
        return LineageResult(
            nodes=nodes,
            edges=edges,
            upstreamUrns=set(),
            downstreamUrns=downstream_urns,
            totalCount=len(nodes),
            hasMore=False,
        )

    async def get_full_lineage(
        self,
        urn: str,
        upstream_depth: int,
        downstream_depth: int,
        include_column_lineage: bool = False,
        descendant_types: Optional[List[str]] = None,
    ) -> LineageResult:
        up = await self._traverse_lineage(urn, "upstream", upstream_depth, descendant_types)
        down = await self._traverse_lineage(urn, "downstream", downstream_depth, descendant_types)
        all_urns = up | down | {urn}
        nodes = await self.get_nodes(NodeQuery(urns=list(all_urns), limit=len(all_urns), include_child_count=False))
        node_ids = {n.urn for n in nodes}
        edges = await self.get_edges(EdgeQuery(any_urns=list(all_urns), limit=len(all_urns) * 10))
        edges = [e for e in edges if e.source_urn in node_ids and e.target_urn in node_ids]
        return LineageResult(
            nodes=nodes,
            edges=edges,
            upstreamUrns=up,
            downstreamUrns=down,
            totalCount=len(nodes),
            hasMore=False,
        )
