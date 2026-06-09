"""A branch of the versioned store, exposed as one ordinary ``GraphDataProvider``.

The journey-breaking gap was that the normal graph endpoints only ever saw ``main`` — a user
could view, but not actually *work in*, a draft. This makes a single branch a first-class graph
provider: the same ``ContextEngine`` and the same ``/graph`` endpoints serve it, gated only by
``branchId``. Reads compose the shared ``main`` base + the branch's overlay; writes are recorded
as audited commits on the branch via ``apply_ops``. Nothing about the read/write *stack* changes
for a draft — only which provider the engine resolves. ``main`` keeps using FalkorDB (the fast
projection); a branch (and as-of reads) use this, bounded Postgres, never a per-draft FalkorDB
graph.

So the full draft journey — open it, view it, edit it through ``/nodes/create`` / ``/edges`` /
``/save``, read your writes — is the normal graph API with ``branchId`` set, not a separate
versioning surface. Containment/lineage edge-type sets are passed in by the engine (resolved from
the data source's ontology, shared by every branch), so this object needs no ontology access.

Writes translate the provider's node/edge models into versioning ops and commit them to this
branch; reads then see them composed over the base. An as-of view is a historical snapshot and is
therefore read-only.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from backend.common.models.graph import (
    AggregatedEdgeResult, ChildrenWithEdgesResult, EdgeQuery, GraphEdge, GraphNode, NodeQuery,
    TopLevelNodesResult, TraceResult,
)


def _node_payload(node: GraphNode) -> dict:
    return node.model_dump(by_alias=True, exclude_none=True)


def _edge_payload(edge: GraphEdge) -> dict:
    p: Dict[str, Any] = {"edgeType": edge.edge_type,
                         "sourceEntityId": edge.source_urn, "targetEntityId": edge.target_urn}
    if edge.confidence is not None:
        p["confidence"] = edge.confidence
    if edge.properties:
        p["properties"] = edge.properties
    return p


class VersionedBranchProvider:
    """A ``GraphDataProvider`` over one ``(graph_id, branch_id[, as_of_seq])`` — reads compose
    base + overlay, writes commit to the branch via ``apply_ops`` (as-of views are read-only)."""

    def __init__(self, svc, *, graph_id: str, branch_id: str,
                 actor: Optional[str] = None, as_of_seq: Optional[int] = None):
        self._svc = svc
        self._gid = graph_id
        self._branch = branch_id
        self._actor = actor or "system"
        self._as_of = as_of_seq
        # Containment edge types, pushed in by ContextEngine._resolve_ontology (the same
        # push-down FalkorDB uses) — the structural input for the top-level/orphan read.
        self._containment_types: List[str] = []

    def set_containment_edge_types(self, edge_types, from_ontology: bool = False) -> None:
        self._containment_types = list(edge_types or [])

    @property
    def name(self) -> str:
        suffix = f"@{self._as_of}" if self._as_of is not None else ""
        return f"versioned-branch[{self._gid}:{self._branch}{suffix}]"

    # ---- reads: bounded Postgres over base + overlay -------------------- #
    async def get_node(self, urn: str) -> Optional[GraphNode]:
        d = await self._svc.get_node_from_state(
            graph_id=self._gid, branch_id=self._branch, as_of_seq=self._as_of, urn=urn,
            containment_edge_types=self._containment_types)
        return GraphNode(**d) if d else None

    async def get_nodes(self, query: NodeQuery) -> List[GraphNode]:
        # Pass the (engine-resolved) containment types so the draft read computes childCount,
        # exactly as FalkorDB does for main — without it, draft nodes lose their expand chevron.
        rows = await self._svc.get_nodes_from_state(
            graph_id=self._gid, branch_id=self._branch, as_of_seq=self._as_of,
            urns=query.urns, entity_types=query.entity_types, search_query=query.search_query,
            limit=query.limit or 100, offset=query.offset or 0,
            containment_edge_types=self._containment_types,
            include_child_count=getattr(query, "include_child_count", True))
        return [GraphNode(**d) for d in rows]

    async def search_nodes(self, query: str, limit: int = 10, offset: int = 0) -> List[GraphNode]:
        rows = await self._svc.search_from_state(
            graph_id=self._gid, branch_id=self._branch, as_of_seq=self._as_of,
            query=query, limit=limit)
        return [GraphNode(**d) for d in rows]

    async def get_edges(self, query: EdgeQuery) -> List[GraphEdge]:
        rows = await self._svc.get_edges_from_state(
            graph_id=self._gid, branch_id=self._branch, as_of_seq=self._as_of,
            source_urns=query.source_urns, target_urns=query.target_urns,
            any_urns=query.any_urns, edge_types=query.edge_types,
            min_confidence=query.min_confidence,
            limit=query.limit or 100, offset=query.offset or 0)
        return [GraphEdge(**d) for d in rows]

    async def get_children_with_edges(
        self, parent_urn: str, edge_types: Optional[List[str]] = None,
        lineage_edge_types: Optional[List[str]] = None, search_query: Optional[str] = None,
        offset: int = 0, limit: int = 100, include_lineage_edges: bool = True,
        sort_property: Optional[str] = "displayName", cursor: Optional[str] = None,
    ) -> ChildrenWithEdgesResult:
        d = await self._svc.get_children_with_edges_from_state(
            graph_id=self._gid, branch_id=self._branch, as_of_seq=self._as_of,
            parent_urn=parent_urn, containment_edge_types=edge_types or [],
            lineage_edge_types=lineage_edge_types, include_lineage_edges=include_lineage_edges,
            limit=limit, offset=offset)
        return ChildrenWithEdgesResult(**d)

    async def get_children(
        self, parent_urn: str, entity_types: Optional[List[str]] = None,
        edge_types: Optional[List[str]] = None, search_query: Optional[str] = None,
        offset: int = 0, limit: int = 100, sort_property: Optional[str] = "displayName",
        cursor: Optional[str] = None,
    ) -> List[GraphNode]:
        d = await self._svc.get_children_with_edges_from_state(
            graph_id=self._gid, branch_id=self._branch, as_of_seq=self._as_of,
            parent_urn=parent_urn, containment_edge_types=edge_types or [],
            include_lineage_edges=False, limit=limit, offset=offset)
        return [GraphNode(**c) for c in d["children"]]

    async def get_top_level_or_orphan_nodes(
        self, *, root_entity_types: Optional[List[str]] = None,
        entity_types: Optional[List[str]] = None, search_query: Optional[str] = None,
        limit: int = 100, cursor: Optional[str] = None, include_child_count: bool = True,
    ) -> TopLevelNodesResult:
        d = await self._svc.top_level_from_state(
            graph_id=self._gid, branch_id=self._branch, as_of_seq=self._as_of,
            containment_edge_types=self._containment_types,
            root_entity_types=root_entity_types, entity_types=entity_types,
            search_query=search_query, limit=limit, cursor=cursor,
            include_child_count=include_child_count)
        return TopLevelNodesResult(**d)

    async def trace_at_level(
        self, urn: str, level: int, upstream_depth: int, downstream_depth: int,
        lineage_edge_types: List[str], containment_edge_types: List[str],
        max_nodes: int, timeout_ms: int, include_containment_edges: bool = False,
        include_inherited_lineage: bool = True,
    ) -> TraceResult:
        d = await self._svc.trace_from_state(
            graph_id=self._gid, branch_id=self._branch, as_of_seq=self._as_of,
            urn=urn, level=level, upstream_depth=upstream_depth, downstream_depth=downstream_depth,
            lineage_edge_types=lineage_edge_types, containment_edge_types=containment_edge_types,
            max_nodes=max_nodes, include_containment_edges=include_containment_edges)
        return TraceResult(**d)

    async def expand_aggregated(
        self, source_urn: str, target_urn: str, next_level: int,
        lineage_edge_types: List[str], containment_edge_types: List[str],
        max_nodes: int, timeout_ms: int, use_raw_edges: bool = False,
        include_containment_edges: bool = False,
    ) -> TraceResult:
        d = await self._svc.expand_from_state(
            graph_id=self._gid, branch_id=self._branch, as_of_seq=self._as_of,
            source_urn=source_urn, target_urn=target_urn, next_level=next_level,
            lineage_edge_types=lineage_edge_types, containment_edge_types=containment_edge_types,
            max_nodes=max_nodes, include_containment_edges=include_containment_edges)
        return TraceResult(**d)

    async def get_aggregated_edges_between(
        self, source_urns: List[str], target_urns: Optional[List[str]],
        granularity: Any, containment_edges: List[str], lineage_edges: List[str],
        *, timeout: Optional[float] = None,
    ) -> AggregatedEdgeResult:
        """AGGREGATED rollups are a published-``main`` projection (FalkorDB) concept — a draft
        branch has none materialised. Return an empty result, exactly as the FalkorDB provider
        does before a backfill; the engine finds no ``materialize_*`` hook on this provider and
        degrades gracefully (no rollups), so the draft canvas still renders from raw edges."""
        return AggregatedEdgeResult(aggregated_edges=[], total_source_edges=0)

    async def get_ontology_metadata(self):
        """No ontology surface by design — the engine resolves ontology from the data source
        (shared by main and every branch) and passes edge-type sets into each call. Raising here
        makes ``ContextEngine._resolve_ontology``'s graceful-degradation explicit."""
        raise NotImplementedError("VersionedBranchProvider does not introspect ontology")

    # ---- writes: one audited commit on this branch via apply_ops -------- #
    async def _commit(self, ops: List[dict], message: str) -> Optional[str]:
        if self._as_of is not None:
            raise PermissionError("cannot write to a historical (as-of) view")
        return await self._svc.apply_ops(
            graph_id=self._gid, branch_id=self._branch, ops=ops, actor=self._actor, message=message)

    async def create_node(self, node: GraphNode, containment_edge: Optional[GraphEdge] = None) -> bool:
        ops = [{"op": "create", "entity_kind": "node", "entity_id": node.urn,
                "payload": _node_payload(node)}]
        if containment_edge is not None:
            ops.append({"op": "create", "entity_kind": "edge", "entity_id": containment_edge.id,
                        "payload": _edge_payload(containment_edge)})
        await self._commit(ops, f"create node {node.urn}")
        return True

    async def create_edge(self, edge: GraphEdge) -> bool:
        await self._commit([{"op": "create", "entity_kind": "edge", "entity_id": edge.id,
                             "payload": _edge_payload(edge)}], f"create edge {edge.id}")
        return True

    async def update_edge(self, edge_id: str, properties: Dict[str, Any]) -> Optional[GraphEdge]:
        cur = await self._svc.entity_value(
            graph_id=self._gid, entity_id=edge_id, branch_id=self._branch)
        if cur is None:
            return None
        payload = {**cur, "properties": {**(cur.get("properties") or {}), **(properties or {})}}
        await self._commit([{"op": "update", "entity_kind": "edge", "entity_id": edge_id,
                             "payload": payload}], f"update edge {edge_id}")
        return GraphEdge(
            id=edge_id,
            sourceUrn=payload.get("sourceEntityId") or payload.get("source_entity_id") or "",
            targetUrn=payload.get("targetEntityId") or payload.get("target_entity_id") or "",
            edgeType=payload.get("edgeType"),
            confidence=payload.get("confidence"),
            properties=payload.get("properties") or {})

    async def delete_edge(self, edge_id: str) -> bool:
        cur = await self._svc.entity_value(
            graph_id=self._gid, entity_id=edge_id, branch_id=self._branch)
        if cur is None:
            return False
        await self._commit([{"op": "delete", "entity_kind": "edge", "entity_id": edge_id,
                             "payload": None}], f"delete edge {edge_id}")
        return True

    async def save_custom_graph(self, nodes: List[GraphNode], edges: List[GraphEdge]) -> bool:
        ops = [{"op": "create", "entity_kind": "node", "entity_id": n.urn,
                "payload": _node_payload(n)} for n in nodes]
        ops += [{"op": "create", "entity_kind": "edge", "entity_id": e.id,
                 "payload": _edge_payload(e)} for e in edges]
        await self._commit(ops, "save custom graph")
        return True
