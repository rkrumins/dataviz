"""Draft = main ⊕ sparse delta — a read-overlay so a no-change draft reads *identically* to main.

The journey invariant: opening a draft off main must change **nothing** — every node and every edge,
including the materialised aggregated-lineage rollups — until the draft actually edits something; then
only the entities it added / removed / changed may differ. The old draft provider composed the WHOLE
state from Postgres, which lacks the aggregated rollups main's FalkorDB has, so a no-change draft lost
all rolled-up lineage.

This provider instead **reuses main's reads** (whatever serves main — live FalkorDB when fresh, else
the Postgres main reader) and overlays only the draft's bounded patch set
(:meth:`GraphVersioningService.branch_overlay_delta`). For a no-change draft the patch set is empty and
every read is a pure pass-through → the draft IS main, by construction. Cost is ``O(main_read + delta)``
— never a per-draft FalkorDB graph and never a full re-derivation. Writes commit to the draft via the
ordinary branch path (reused from :class:`VersionedBranchProvider`).
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from backend.common.models.graph import (
    AggregatedEdgeInfo, AggregatedEdgeResult, ChildrenWithEdgesResult, EdgeQuery, GraphEdge,
    GraphNode, NodeQuery, TopLevelNodesResult, TraceResult,
)
from .versioned_branch_provider import VersionedBranchProvider


class _OverlayDelta:
    """Indexed, reader-shaped view of a draft's patch set vs its main base."""

    def __init__(self, raw: Dict[str, Any], containment_types: List[str]):
        cset = {t.upper() for t in (containment_types or [])}
        self.node_upsert: Dict[str, GraphNode] = {}
        self.node_remove: set = set()
        self.edge_upsert: Dict[str, GraphEdge] = {}
        self.edge_remove: Dict[str, GraphEdge] = {}
        self.lineage_added: List[GraphEdge] = []
        self.lineage_removed: List[GraphEdge] = []
        # parent urn -> net containment-child delta (drives childCount + children overlay)
        self.child_count_delta: Dict[str, int] = {}
        self.cont_added: List[GraphEdge] = []
        self.cont_removed: List[GraphEdge] = []

        for d in raw.get("nodesUpsert", []):
            n = GraphNode(**d)
            self.node_upsert[n.urn] = n
        for d in raw.get("nodesRemove", []):
            self.node_remove.add(d["urn"])
        for d in raw.get("edgesUpsert", []):
            e = GraphEdge(**d)
            self.edge_upsert[e.id] = e
            if (e.edge_type or "").upper() in cset:
                self.cont_added.append(e)
                self.child_count_delta[e.source_urn] = self.child_count_delta.get(e.source_urn, 0) + 1
            else:
                self.lineage_added.append(e)
        for d in raw.get("edgesRemove", []):
            e = GraphEdge(**d)
            self.edge_remove[e.id] = e
            if (e.edge_type or "").upper() in cset:
                self.cont_removed.append(e)
                self.child_count_delta[e.source_urn] = self.child_count_delta.get(e.source_urn, 0) - 1
            else:
                self.lineage_removed.append(e)

    @property
    def empty(self) -> bool:
        return not (self.node_upsert or self.node_remove or self.edge_upsert or self.edge_remove)

    @property
    def lineage_changed(self) -> bool:
        return bool(self.lineage_added or self.lineage_removed)

    def with_child_count(self, node: GraphNode) -> GraphNode:
        """Adjust a base/upserted node's childCount by the draft's containment delta under it."""
        adj = self.child_count_delta.get(node.urn)
        if not adj:
            return node
        return node.model_copy(update={"child_count": max(0, (node.child_count or 0) + adj)})


class DraftOverlayProvider:
    """A ``GraphDataProvider`` for a live draft: reads = ``base`` (main) ⊕ the draft's sparse delta,
    writes = a commit on the draft. Empty delta ⇒ every read is a pure pass-through to ``base``."""

    def __init__(self, base, *, svc, graph_id: str, branch_id: str, actor: Optional[str] = None):
        self._base = base
        self._svc = svc
        self._gid = graph_id
        self._branch = branch_id
        self._actor = actor or "system"
        self._containment_types: List[str] = []
        self._delta: Optional[_OverlayDelta] = None
        # Writes (and as-of-free branch ops) reuse the ordinary branch provider — no duplication.
        self._writer = VersionedBranchProvider(svc, graph_id=graph_id, branch_id=branch_id, actor=self._actor)

    # ---- lifecycle ----------------------------------------------------- #
    def set_containment_edge_types(self, edge_types, from_ontology: bool = False) -> None:
        self._containment_types = list(edge_types or [])
        self._delta = None                                   # re-classify edges on next read
        self._writer.set_containment_edge_types(edge_types, from_ontology)
        setter = getattr(self._base, "set_containment_edge_types", None)
        if callable(setter):
            setter(edge_types, from_ontology)

    @property
    def name(self) -> str:
        return f"draft-overlay[{self._gid}:{self._branch}] over {getattr(self._base, 'name', '?')}"

    async def get_ontology_metadata(self):
        # Like VersionedBranchProvider: the engine resolves ontology from the data source and pushes
        # edge-type sets in; there is no per-branch ontology surface.
        raise NotImplementedError("DraftOverlayProvider does not introspect ontology")

    async def _delta_(self) -> _OverlayDelta:
        if self._delta is None:
            raw = await self._svc.branch_overlay_delta(graph_id=self._gid, branch_id=self._branch)
            self._delta = _OverlayDelta(raw, self._containment_types)
        return self._delta

    @staticmethod
    def _matches(node: GraphNode, query: NodeQuery) -> bool:
        if query.urns and node.urn not in set(query.urns):
            return False
        if query.entity_types and node.entity_type not in set(query.entity_types):
            return False
        if query.search_query and query.search_query.lower() not in (node.display_name or "").lower():
            return False
        return True

    # ---- reads: base ⊕ delta ------------------------------------------- #
    async def get_node(self, urn: str) -> Optional[GraphNode]:
        d = await self._delta_()
        if urn in d.node_remove:
            return None
        if urn in d.node_upsert:
            return d.with_child_count(d.node_upsert[urn])
        node = await self._base.get_node(urn)
        return d.with_child_count(node) if node else None

    async def get_nodes(self, query: NodeQuery) -> List[GraphNode]:
        base = await self._base.get_nodes(query)
        d = await self._delta_()
        if d.empty:
            return base
        seen: set = set()
        out: List[GraphNode] = []
        for n in base:
            if n.urn in d.node_remove:
                continue
            n = d.node_upsert.get(n.urn, n)                  # replace modified with the draft's value
            out.append(d.with_child_count(n))
            seen.add(n.urn)
        for urn, n in d.node_upsert.items():                 # draft-new nodes matching the query
            if urn not in seen and self._matches(n, query):
                out.append(d.with_child_count(n))
        return out

    async def search_nodes(self, query: str, limit: int = 10, offset: int = 0) -> List[GraphNode]:
        base = await self._base.search_nodes(query, limit=limit, offset=offset)
        d = await self._delta_()
        if d.empty:
            return base
        q = (query or "").lower()
        out = [d.node_upsert.get(n.urn, n) for n in base if n.urn not in d.node_remove]
        seen = {n.urn for n in out}
        for urn, n in d.node_upsert.items():
            if urn not in seen and q in (n.display_name or "").lower():
                out.append(n)
        return out

    async def get_edges(self, query: EdgeQuery) -> List[GraphEdge]:
        base = await self._base.get_edges(query)
        d = await self._delta_()
        if d.empty:
            return base
        out = [d.edge_upsert.get(e.id, e) for e in base if e.id not in d.edge_remove]
        seen = {e.id for e in out}
        src = set(query.source_urns or [])
        tgt = set(query.target_urns or [])
        anyu = set(query.any_urns or [])
        ets = set(query.edge_types or [])
        for eid, e in d.edge_upsert.items():
            if eid in seen:
                continue
            if src and e.source_urn not in src:
                continue
            if tgt and e.target_urn not in tgt:
                continue
            if anyu and not (e.source_urn in anyu or e.target_urn in anyu):
                continue
            if ets and e.edge_type not in ets:
                continue
            out.append(e)
        return out

    async def get_children_with_edges(
        self, parent_urn: str, edge_types: Optional[List[str]] = None,
        lineage_edge_types: Optional[List[str]] = None, search_query: Optional[str] = None,
        offset: int = 0, limit: int = 100, include_lineage_edges: bool = True,
        sort_property: Optional[str] = "displayName", cursor: Optional[str] = None,
    ) -> ChildrenWithEdgesResult:
        base = await self._base.get_children_with_edges(
            parent_urn, edge_types=edge_types, lineage_edge_types=lineage_edge_types,
            search_query=search_query, offset=offset, limit=limit,
            include_lineage_edges=include_lineage_edges, sort_property=sort_property, cursor=cursor)
        d = await self._delta_()
        if d.empty:
            return base
        # children: drop removed, replace modified, add the draft's new children of THIS parent
        children = [d.node_upsert.get(c.urn, c) for c in base.children if c.urn not in d.node_remove]
        present = {c.urn for c in children}
        for e in d.cont_added:
            if e.source_urn == parent_urn and e.target_urn in d.node_upsert and e.target_urn not in present:
                children.append(d.node_upsert[e.target_urn])
                present.add(e.target_urn)
        children = [d.with_child_count(c) for c in children]
        # containment edges under this parent
        cont = [e for e in base.containment_edges if e.id not in d.edge_remove]
        cont += [e for e in d.cont_added if e.source_urn == parent_urn]
        # lineage edges among the (now overlaid) visible child scope
        lineage = base.lineage_edges
        if include_lineage_edges:
            lineage = [d.edge_upsert.get(e.id, e) for e in lineage if e.id not in d.edge_remove]
            seen = {e.id for e in lineage}
            scope = present | {parent_urn}
            for e in d.lineage_added:
                if e.id not in seen and e.source_urn in scope and e.target_urn in scope:
                    lineage.append(e)
        return ChildrenWithEdgesResult(
            children=children, containmentEdges=cont, lineageEdges=lineage,
            totalChildren=len(children), hasMore=base.has_more, nextCursor=base.next_cursor)

    async def get_children(
        self, parent_urn: str, entity_types: Optional[List[str]] = None,
        edge_types: Optional[List[str]] = None, search_query: Optional[str] = None,
        offset: int = 0, limit: int = 100, sort_property: Optional[str] = "displayName",
        cursor: Optional[str] = None,
    ) -> List[GraphNode]:
        res = await self.get_children_with_edges(
            parent_urn, edge_types=edge_types, include_lineage_edges=False,
            offset=offset, limit=limit, sort_property=sort_property, cursor=cursor)
        return res.children

    async def get_top_level_or_orphan_nodes(
        self, *, root_entity_types: Optional[List[str]] = None,
        entity_types: Optional[List[str]] = None, search_query: Optional[str] = None,
        limit: int = 100, cursor: Optional[str] = None, include_child_count: bool = True,
    ) -> TopLevelNodesResult:
        base = await self._base.get_top_level_or_orphan_nodes(
            root_entity_types=root_entity_types, entity_types=entity_types,
            search_query=search_query, limit=limit, cursor=cursor, include_child_count=include_child_count)
        d = await self._delta_()
        if d.empty:
            return base
        # A draft-new node is top-level iff nothing (base or draft) contains it. We can only see the
        # draft's containment here, so treat a new node as a root when no draft containment targets it.
        has_parent = {e.target_urn for e in d.cont_added}
        nodes = [d.node_upsert.get(n.urn, n) for n in base.nodes if n.urn not in d.node_remove]
        present = {n.urn for n in nodes}
        et = set(entity_types or [])
        for urn, n in d.node_upsert.items():
            if urn in present or urn in has_parent:
                continue
            if et and n.entity_type not in et:
                continue
            nodes.append(n)
        nodes = [d.with_child_count(n) for n in nodes]
        return base.model_copy(update={"nodes": nodes, "total_count": len(nodes)})

    async def get_aggregated_edges_between(
        self, source_urns: List[str], target_urns: Optional[List[str]],
        granularity: Any, containment_edges: List[str], lineage_edges: List[str],
        *, timeout: Optional[float] = None,
    ) -> AggregatedEdgeResult:
        base = await self._base.get_aggregated_edges_between(
            source_urns, target_urns, granularity, containment_edges, lineage_edges, timeout=timeout)
        d = await self._delta_()
        if not d.lineage_changed:
            return base                                      # no lineage delta ⇒ main's rollups verbatim
        delta = ([(e.source_urn, e.target_urn, e.edge_type, +1) for e in d.lineage_added]
                 + [(e.source_urn, e.target_urn, e.edge_type, -1) for e in d.lineage_removed])
        adjust = await self._svc.aggregated_overlay_adjust(
            graph_id=self._gid, branch_id=self._branch, source_urns=source_urns,
            target_urns=target_urns, lineage_delta=delta, containment_edge_types=containment_edges)
        by_pair = {(e.source_urn, e.target_urn): e for e in base.aggregated_edges}
        for (su, tu), adj in adjust.items():
            cur = by_pair.get((su, tu))
            w = int(adj["weight"])
            types = adj["types"]
            if cur is None:
                if w > 0:
                    by_pair[(su, tu)] = AggregatedEdgeInfo(
                        id=f"agg-{su}-{tu}", sourceUrn=su, targetUrn=tu, edgeCount=w,
                        edgeTypes=sorted(t for t in types if t), confidence=1.0, sourceEdgeIds=[])
            else:
                new_count = (cur.edge_count or 0) + w
                if new_count <= 0:
                    del by_pair[(su, tu)]
                else:
                    by_pair[(su, tu)] = cur.model_copy(update={
                        "edge_count": new_count,
                        "edge_types": sorted(set(cur.edge_types) | {t for t in types if t})})
        edges = sorted(by_pair.values(), key=lambda e: e.edge_count, reverse=True)
        return AggregatedEdgeResult(
            aggregatedEdges=edges, totalSourceEdges=sum(e.edge_count for e in edges),
            truncated=base.truncated, lastMaterializedAt=base.last_materialized_at)

    async def trace_at_level(
        self, urn: str, level: int, upstream_depth: int, downstream_depth: int,
        lineage_edge_types: List[str], containment_edge_types: List[str],
        max_nodes: int, timeout_ms: int, include_containment_edges: bool = False,
        include_inherited_lineage: bool = True,
    ) -> TraceResult:
        base = await self._base.trace_at_level(
            urn, level, upstream_depth, downstream_depth, lineage_edge_types, containment_edge_types,
            max_nodes, timeout_ms, include_containment_edges=include_containment_edges,
            include_inherited_lineage=include_inherited_lineage)
        return await self._overlay_trace(base)

    async def expand_aggregated(
        self, source_urn: str, target_urn: str, next_level: int,
        lineage_edge_types: List[str], containment_edge_types: List[str],
        max_nodes: int, timeout_ms: int, use_raw_edges: bool = False,
        include_containment_edges: bool = False,
    ) -> TraceResult:
        base = await self._base.expand_aggregated(
            source_urn, target_urn, next_level, lineage_edge_types, containment_edge_types,
            max_nodes, timeout_ms, use_raw_edges=use_raw_edges,
            include_containment_edges=include_containment_edges)
        return await self._overlay_trace(base)

    async def _overlay_trace(self, base: TraceResult) -> TraceResult:
        """Patch a base trace with the draft's lineage delta, bounded to the trace's node scope."""
        d = await self._delta_()
        if not d.lineage_changed and not d.node_remove:
            return base
        scope = {n.urn for n in base.nodes}
        edges = [e for e in base.edges if e.id not in d.edge_remove]
        seen = {e.id for e in edges}
        for e in d.lineage_added:
            if e.id not in seen and e.source_urn in scope and e.target_urn in scope:
                edges.append(e)
        return base.model_copy(update={"edges": edges})

    # ---- writes: commit to the draft (reused from the branch provider) -- #
    async def create_node(self, node: GraphNode, containment_edge: Optional[GraphEdge] = None) -> bool:
        self._delta = None
        return await self._writer.create_node(node, containment_edge)

    async def create_edge(self, edge: GraphEdge) -> bool:
        self._delta = None
        return await self._writer.create_edge(edge)

    async def update_edge(self, edge_id: str, properties: Dict[str, Any]) -> Optional[GraphEdge]:
        self._delta = None
        return await self._writer.update_edge(edge_id, properties)

    async def delete_edge(self, edge_id: str) -> bool:
        self._delta = None
        return await self._writer.delete_edge(edge_id)

    async def save_custom_graph(self, nodes: List[GraphNode], edges: List[GraphEdge]) -> bool:
        self._delta = None
        return await self._writer.save_custom_graph(nodes, edges)
