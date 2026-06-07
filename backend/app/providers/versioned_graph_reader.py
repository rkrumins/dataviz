"""Read-only provider view of one branch in the versioned store (journey Phase G).

The second journey-breaking gap was that the normal graph reads only ever saw ``main`` — a
user could not actually *work* in a draft. This adapts the bounded, branch-aware reads on
:class:`GraphVersioningService` into the slice of the ``GraphDataProvider`` read shape that the
:class:`ContextEngine` read stack already calls (``get_node``/``get_nodes``/``get_edges``/
``search_nodes``/``get_children_with_edges``). Routing a draft is therefore just swapping the
engine's provider: the engine and endpoints are otherwise untouched — main keeps reading from
FalkorDB, a draft (or as-of) reads from here.

Every call is a bounded Postgres query over the shared ``main`` base + the draft's tiny overlay
(never full state, never a per-draft FalkorDB graph). The containment/lineage edge-type sets are
passed in by the engine (resolved from the ontology), so this object needs no ontology access.

Read-only by design: a draft *write* goes through ``apply_ops`` on the branch (the versioned
write path), not this object.
"""
from __future__ import annotations

from typing import List, Optional

from backend.common.models.graph import (
    ChildrenWithEdgesResult, EdgeQuery, GraphEdge, GraphNode, NodeQuery,
    TopLevelNodesResult, TraceResult,
)


class VersionedGraphReader:
    """A ``GraphDataProvider``-shaped read view of ``(graph_id, branch_id[, as_of_seq])``."""

    def __init__(self, svc, *, graph_id: str, branch_id: str, as_of_seq: Optional[int] = None):
        self._svc = svc
        self._gid = graph_id
        self._branch = branch_id
        self._as_of = as_of_seq
        # Containment edge types, pushed in by ContextEngine._resolve_ontology (the same
        # push-down FalkorDB uses) — the structural input for the top-level/orphan read.
        self._containment_types: List[str] = []

    def set_containment_edge_types(self, edge_types, from_ontology: bool = False) -> None:
        self._containment_types = list(edge_types or [])

    @property
    def name(self) -> str:
        suffix = f"@{self._as_of}" if self._as_of is not None else ""
        return f"versioned-reader[{self._gid}:{self._branch}{suffix}]"

    async def get_node(self, urn: str) -> Optional[GraphNode]:
        d = await self._svc.get_node_from_state(
            graph_id=self._gid, branch_id=self._branch, as_of_seq=self._as_of, urn=urn)
        return GraphNode(**d) if d else None

    async def get_nodes(self, query: NodeQuery) -> List[GraphNode]:
        rows = await self._svc.get_nodes_from_state(
            graph_id=self._gid, branch_id=self._branch, as_of_seq=self._as_of,
            urns=query.urns, entity_types=query.entity_types, search_query=query.search_query,
            limit=query.limit or 100, offset=query.offset or 0)
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

    async def get_ontology_metadata(self):
        """The reader has no ontology surface by design — the engine resolves ontology from the
        data source (shared by main and every draft) and passes edge-type sets into each read.
        Raising here makes ``ContextEngine._resolve_ontology``'s graceful-degradation explicit."""
        raise NotImplementedError("VersionedGraphReader does not introspect ontology")
