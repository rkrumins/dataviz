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
    AggregatedEdgeInfo, AggregatedEdgeResult, ChildrenWithEdgesResult, EdgeQuery, EdgeTypeSummary, EntityTypeSummary,
    GraphEdge, GraphNode, GraphSchemaStats, NodeQuery, TagSummary, TopLevelNodesResult,
    TraceClosureResult, TraceFocus, TraceResult,
)


#: Bounds on the derived-rollup containment descent (see
#: ``get_aggregated_edges_between``). A branch is draft-scale, so these are a
#: runaway guard, not a paging scheme — when either bites, the answer is
#: reported ``truncated``/``stale`` rather than quietly returned short.
_DERIVE_HOP_BOUND = 16
_DERIVE_SCOPE_CAP = 20_000

#: Surfaced verbatim as the 501 body, so it is product copy: what
#: happened and that waiting fixes it — no provider names, no internals.
_NO_DEEP_SEARCH = (
    "Search isn't available while the published graph is catching up — "
    "try again in a moment."
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

    # `sort_direction` is accepted for interface parity; the Postgres state
    # reads keep their native (asc) window order, so a desc request re-sorts
    # the returned PAGE in Python. Exact for parents whose children fit one
    # page (the common case on this as-of/audit path); a partially-paged desc
    # window is best-effort.
    @staticmethod
    def _page_resort(nodes: list, sort_direction: str) -> list:
        if sort_direction != "desc":
            return nodes
        return sorted(nodes, key=lambda n: ((n.display_name or ""), n.urn), reverse=True)

    async def get_children_with_edges(
        self, parent_urn: str, edge_types: Optional[List[str]] = None,
        lineage_edge_types: Optional[List[str]] = None, search_query: Optional[str] = None,
        offset: int = 0, limit: int = 100, include_lineage_edges: bool = True,
        sort_property: Optional[str] = "displayName", cursor: Optional[str] = None,
        sort_direction: str = "asc",
    ) -> ChildrenWithEdgesResult:
        d = await self._svc.get_children_with_edges_from_state(
            graph_id=self._gid, branch_id=self._branch, as_of_seq=self._as_of,
            parent_urn=parent_urn, containment_edge_types=edge_types or [],
            lineage_edge_types=lineage_edge_types, include_lineage_edges=include_lineage_edges,
            limit=limit, offset=offset)
        result = ChildrenWithEdgesResult(**d)
        if sort_direction == "desc":
            result.children = self._page_resort(result.children, sort_direction)
        return result

    async def get_children(
        self, parent_urn: str, entity_types: Optional[List[str]] = None,
        edge_types: Optional[List[str]] = None, search_query: Optional[str] = None,
        offset: int = 0, limit: int = 100, sort_property: Optional[str] = "displayName",
        cursor: Optional[str] = None, sort_direction: str = "asc",
    ) -> List[GraphNode]:
        d = await self._svc.get_children_with_edges_from_state(
            graph_id=self._gid, branch_id=self._branch, as_of_seq=self._as_of,
            parent_urn=parent_urn, containment_edge_types=edge_types or [],
            include_lineage_edges=False, limit=limit, offset=offset)
        return self._page_resort([GraphNode(**c) for c in d["children"]], sort_direction)

    async def get_top_level_or_orphan_nodes(
        self, *, root_entity_types: Optional[List[str]] = None,
        entity_types: Optional[List[str]] = None, search_query: Optional[str] = None,
        limit: int = 100, cursor: Optional[str] = None, include_child_count: bool = True,
        sort_direction: str = "asc",
    ) -> TopLevelNodesResult:
        d = await self._svc.top_level_from_state(
            graph_id=self._gid, branch_id=self._branch, as_of_seq=self._as_of,
            containment_edge_types=self._containment_types,
            root_entity_types=root_entity_types, entity_types=entity_types,
            search_query=search_query, limit=limit, cursor=cursor,
            include_child_count=include_child_count)
        result = TopLevelNodesResult(**d)
        if sort_direction == "desc":
            result.nodes = self._page_resort(result.nodes, sort_direction)
        return result

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

    async def trace_closure(
        self, urn: str, upstream_depth: int, downstream_depth: int,
        lineage_edge_types: List[str], containment_edge_types: List[str],
        max_nodes: int, timeout_ms: int,
        seed_urns: Optional[List[str]] = None,
        exclude_urns: Optional[List[str]] = None,
        after_cursor: Optional[str] = None,
        seed_cursor: Optional[str] = None,
    ) -> TraceClosureResult:
        """The closure walk over this branch's state (2026-08-20 — closes the
        501 that made the Lens and the native canvas trace structurally dead
        on every versioned source).

        One bounded, honest walk: a draft is draft-scale, so the whole flow
        ships in one response — no cursors are ever issued (the client's
        walk driver sees empty frontiers and reads the response as
        exhausted), and the ``max_nodes`` cap is said out loud via
        ``truncated``. Containment ancestor chains ship for nesting, exactly
        as the FalkorDB closure does.
        """
        def _empty(reason: Optional[str] = None) -> TraceClosureResult:
            return TraceClosureResult(
                nodes=[], edges=[], containmentEdges=[],
                upstreamUrns=set(), downstreamUrns=set(),
                focus=TraceFocus(urn=urn, level=0, entityType=""),
                effectiveLevel=0, isInherited=False, inheritedFromUrn=None,
                truncated=reason is not None, truncationReason=reason,
                frontierUp=[], frontierDown=[],
                seedTruncated=False, seedCursor=None,
            )

        # This provider never ISSUES cursors — an arriving continuation (a
        # client bug or a cross-provider cache echo) gets a safe empty page
        # rather than an error or a duplicate walk.
        if after_cursor or seed_cursor:
            return _empty()

        ltypes = [t for t in (lineage_edge_types or []) if t]
        ctypes = [t for t in (containment_edge_types or []) if t]
        if not ltypes:
            return _empty()

        chunk = 200
        hop_bound = 16

        async def _edges(*, sources: Optional[List[str]] = None,
                         targets: Optional[List[str]] = None,
                         types: List[str]) -> List[GraphEdge]:
            urns_list = sources if sources is not None else (targets or [])
            out: List[GraphEdge] = []
            for i in range(0, len(urns_list), chunk):
                batch = urns_list[i:i + chunk]
                out.extend(await self.get_edges(EdgeQuery(
                    source_urns=batch if sources is not None else None,
                    target_urns=batch if targets is not None else None,
                    edge_types=types, limit=max(1, max_nodes) * 4,
                )))
            return out

        # ── Seeds: the walk starts at whatever grain carries lineage — the
        # explicit seeds (or the focus) plus their containment descendants.
        seeds = set(seed_urns or [urn])
        seeds.add(urn)
        if ctypes:
            frontier = list(seeds)
            for _ in range(hop_bound):
                if not frontier or len(seeds) >= max_nodes:
                    break
                kids = await _edges(sources=frontier, types=ctypes)
                frontier = [e.target_urn for e in kids if e.target_urn not in seeds]
                seeds.update(frontier)

        # ── Lineage BFS, per-direction depths, capped at max_nodes.
        discovered = set(seeds)
        upstream_urns: set = set()
        downstream_urns: set = set()
        edges_by_id: Dict[str, GraphEdge] = {}
        truncation: Optional[str] = None
        up_frontier, down_frontier = list(seeds), list(seeds)
        for hop in range(1, max(upstream_depth, downstream_depth) + 1):
            if truncation or (not up_frontier and not down_frontier):
                break
            next_up: List[str] = []
            next_down: List[str] = []
            if hop <= upstream_depth and up_frontier:
                for e in await _edges(targets=up_frontier, types=ltypes):
                    edges_by_id[e.id] = e
                    if e.source_urn in discovered:
                        continue
                    if len(discovered) >= max_nodes:
                        truncation = "max_nodes"
                        break
                    discovered.add(e.source_urn)
                    upstream_urns.add(e.source_urn)
                    next_up.append(e.source_urn)
            if not truncation and hop <= downstream_depth and down_frontier:
                for e in await _edges(sources=down_frontier, types=ltypes):
                    edges_by_id[e.id] = e
                    if e.target_urn in discovered:
                        continue
                    if len(discovered) >= max_nodes:
                        truncation = "max_nodes"
                        break
                    discovered.add(e.target_urn)
                    downstream_urns.add(e.target_urn)
                    next_down.append(e.target_urn)
            up_frontier, down_frontier = next_up, next_down

        # Only edges whose BOTH endpoints were kept ship — a capped walk
        # must not carry hops into nodes it never delivered.
        edges = [e for e in edges_by_id.values()
                 if e.source_urn in discovered and e.target_urn in discovered]

        # ── Containment ancestor chains for every participant (nesting).
        containment_by_id: Dict[str, GraphEdge] = {}
        ancestor_urns: set = set()
        if ctypes:
            batch = list(discovered)
            seen_anc = set(discovered)
            for _ in range(hop_bound):
                if not batch:
                    break
                nxt: List[str] = []
                for e in await _edges(targets=batch, types=ctypes):
                    containment_by_id[e.id] = e
                    if e.source_urn not in seen_anc:
                        seen_anc.add(e.source_urn)
                        ancestor_urns.add(e.source_urn)
                        nxt.append(e.source_urn)
                batch = nxt

        # ── Hydrate. `exclude_urns` governs re-SHIPPING only (never where
        # the walk starts); the focus itself always ships.
        excluded = set(exclude_urns or [])
        excluded.discard(urn)
        ship = [u for u in (discovered | ancestor_urns) if u not in excluded]
        nodes: List[GraphNode] = []
        for i in range(0, len(ship), chunk):
            nodes.extend(await self.get_nodes(NodeQuery(urns=ship[i:i + chunk], limit=chunk)))
        focus_type = next((n.entity_type for n in nodes if n.urn == urn), "") or ""

        return TraceClosureResult(
            nodes=nodes,
            edges=edges,
            containmentEdges=list(containment_by_id.values()),
            upstreamUrns=upstream_urns,
            downstreamUrns=downstream_urns,
            focus=TraceFocus(urn=urn, level=0, entityType=focus_type),
            effectiveLevel=0, isInherited=False, inheritedFromUrn=None,
            truncated=truncation is not None,
            truncationReason=truncation,
            frontierUp=[], frontierDown=[],
            seedTruncated=False, seedCursor=None,
        )

    async def expand_aggregated(
        self, source_urn: str, target_urn: str, next_level: Optional[int],
        lineage_edge_types: List[str], containment_edge_types: List[str],
        max_nodes: int, timeout_ms: int, use_raw_edges: bool = False,
        include_containment_edges: bool = False,
        drill_anchor: Optional[str] = None,
    ) -> TraceResult:
        # `drill_anchor` is accepted for contract parity and ignored: a
        # branch state replays raw edges rather than reading AGGREGATED
        # cells, so there is no pair collection to make asymmetric.
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
        """Roll-ups DERIVED from this branch's own committed state.

        This used to return an unconditional empty result, reasoning that ``:AGGREGATED``
        is a published-``main`` FalkorDB artifact a branch has none of, and that the canvas
        "still renders from raw edges". It does not, and cannot: ``get_children_with_edges``
        carries only the lineage BETWEEN a container's children, so this call is the ONLY
        channel by which lineage from OUTSIDE a container reaches the children an expand
        just revealed. Answering ``[]`` drew four dashboards with no wires into them — and,
        because nothing was dropped, nothing said so. That is what a data source whose
        projection watermark had fallen behind (``projected_commit_seq <
        main_head_commit_seq`` routes MAIN reads here too) looked like live.

        A rollup is a pure function of two relations this provider already reads from
        Postgres — containment and raw lineage — so derive it instead of declaring it
        absent: descend containment from the asked-about set, take the raw lineage inside
        that scope, and roll each edge up the cross-product of both endpoints' ancestor
        chains (``common.providers.pair_rules`` — the same rule the FalkorDB pipeline
        materialises and the projector mirrors, so a branch and a fresh main answer alike).
        With a collapsed source and an expanded container that is one cell per visible
        child, plus the coarse container cell the canvas stamps ``isDelegated`` so it does
        not double-draw over them.

        Bounded, and honest about it: the descent stops at ``_DERIVE_HOP_BOUND`` hops and
        ``_DERIVE_SCOPE_CAP`` nodes and then says ``truncated``/``stale`` — never a short
        answer that reads as a complete one, which was the whole defect."""
        from backend.common.providers.pair_rules import ancestor_closure, cube_pairs

        srcs = [u for u in (source_urns or []) if u]
        tgts = [u for u in (target_urns or []) if u] if target_urns else list(srcs)
        # AGGREGATED is the derived layer itself: publishing a draft can commit
        # materialised rollups into the version log, and replaying those as raw
        # lineage would count every flow twice.
        ltypes = [t for t in (lineage_edges or []) if t and t != "AGGREGATED"]
        if not srcs or not tgts or not ltypes:
            return AggregatedEdgeResult(aggregatedEdges=[], totalSourceEdges=0)
        ctypes = [t for t in (containment_edges or []) if t]

        chunk = 200

        async def _out_edges(urns: List[str], types: List[str]) -> List[GraphEdge]:
            out: List[GraphEdge] = []
            for i in range(0, len(urns), chunk):
                out.extend(await self.get_edges(EdgeQuery(
                    source_urns=urns[i:i + chunk], edge_types=types,
                    limit=_DERIVE_SCOPE_CAP)))
            return out

        # ── Containment descent from the asked-about set: the raw lineage that rolls
        # up into a visible pair lives somewhere underneath it.
        parents: Dict[str, List[str]] = {}
        scope = set(srcs) | set(tgts)
        truncated = False
        frontier = list(scope)
        for _ in range(_DERIVE_HOP_BOUND if ctypes else 0):
            if not frontier or truncated:
                break
            nxt: List[str] = []
            for e in await _out_edges(frontier, ctypes):
                # Containment is a DAG — a node can have several parents, and the
                # closure below dedupes on that set.
                ps = parents.setdefault(e.target_urn, [])
                if e.source_urn not in ps:
                    ps.append(e.source_urn)
                if e.target_urn in scope:
                    continue
                if len(scope) >= _DERIVE_SCOPE_CAP:
                    truncated = True
                    break
                scope.add(e.target_urn)
                nxt.append(e.target_urn)
            frontier = nxt

        # ── Roll the raw lineage inside that scope up to the requested pairs.
        asked_src, asked_tgt = set(srcs), set(tgts)
        memo: Dict[str, Dict[str, int]] = {}
        cells: Dict[Any, List[Any]] = {}
        for e in await _out_edges(sorted(scope), ltypes):
            if e.target_urn not in scope:
                continue
            for a, b in cube_pairs(
                ancestor_closure(parents, e.source_urn, memo),
                ancestor_closure(parents, e.target_urn, memo),
                # The raw (s, t) mirror ships when the caller asked about both
                # endpoints, matching the FalkorDB read path
                # (`_synthesize_raw_lineage_pairs`): a cross-container leaf-to-leaf
                # flow reaches the canvas through no other call.
                include_leaf_mirror=True, s=e.source_urn, t=e.target_urn,
            ):
                if a not in asked_src or b not in asked_tgt:
                    continue
                cell = cells.setdefault((a, b), [0, set()])
                cell[0] += 1
                if e.edge_type:
                    cell[1].add(e.edge_type)

        edges = [AggregatedEdgeInfo(
            id=f"agg-{a}-{b}", sourceUrn=a, targetUrn=b, edgeCount=w,
            edgeTypes=sorted(types), confidence=1.0, sourceEdgeIds=[])
            for (a, b), (w, types) in cells.items()]
        edges.sort(key=lambda x: (-x.edge_count, x.source_urn, x.target_urn))
        return AggregatedEdgeResult(
            aggregatedEdges=edges,
            totalSourceEdges=sum(e.edge_count for e in edges),
            truncated=truncated,
            stale=truncated,
            staleReason="derive_scope_cap" if truncated else None,
        )

    async def get_ontology_metadata(self):
        """No ontology surface by design — the engine resolves ontology from the data source
        (shared by main and every branch) and passes edge-type sets into each call. Raising here
        makes ``ContextEngine._resolve_ontology``'s graceful-degradation explicit."""
        raise NotImplementedError("VersionedBranchProvider does not introspect ontology")

    # ---- deep search: no engine to run it, and nothing to delegate to ---- #
    async def deep_search(self, query, *, deadline_ms=None):
        """Advanced search has no implementation over composed branch state.

        The predicate tree compiles to Cypher against the FalkorDB
        projection; this provider reads Postgres graph-version rows and —
        unlike :class:`DraftOverlayProvider` — wraps no graph provider to
        hand the query to. ``NotImplementedError`` is deliberate: the
        route maps it to 501, whereas simply not having the method (the
        state this replaces) surfaced as ``AttributeError`` → 500.

        Only reached while the projection lags a commit — a fresh main,
        and every draft overlaid on one, searches FalkorDB directly."""
        raise NotImplementedError(_NO_DEEP_SEARCH)

    async def deep_search_explain(self, query):
        """Compile-only path — same gap as :meth:`deep_search`."""
        raise NotImplementedError(_NO_DEEP_SEARCH)

    async def deep_search_discover(self, *, sample_per_label: int = 200):
        """Schema discovery — same gap as :meth:`deep_search`."""
        raise NotImplementedError(_NO_DEEP_SEARCH)

    # ---- stats: counts + schema summaries over the composed branch state - #
    async def get_stats(self, bypass_cache: bool = False) -> Dict[str, Any]:
        """Node/edge counts + per-type breakdowns from the composed branch state.

        A branch (or stale-main) is served from Postgres, not FalkorDB — there is no projection to
        scan and no stats cache to bypass, so ``bypass_cache`` is accepted for provider-parity with
        the FalkorDB provider (the insights collector passes it) and ignored. Types are keyed exactly
        as the projector labels them (``_sanitize_label(entityType or "Entity")`` / ``edgeType or
        "REL"``) so the counts are byte-identical to what FalkorDB reports once main projects."""
        from .falkordb_provider import _sanitize_label  # reuse the projector's label sanitiser
        state = await self._svc.materialize_state(
            graph_id=self._gid, branch_id=self._branch, as_of_seq=self._as_of)
        entity_type_counts: Dict[str, int] = {}
        for p in state["nodes"].values():
            lbl = _sanitize_label(p.get("entityType") or "Entity")
            entity_type_counts[lbl] = entity_type_counts.get(lbl, 0) + 1
        edge_type_counts: Dict[str, int] = {}
        for p in state["edges"].values():
            t = _sanitize_label(p.get("edgeType") or "REL")
            edge_type_counts[t] = edge_type_counts.get(t, 0) + 1
        return {
            "nodeCount": len(state["nodes"]),
            "edgeCount": len(state["edges"]),
            "entityTypeCounts": entity_type_counts,
            "edgeTypeCounts": edge_type_counts,
        }

    async def get_schema_stats(self) -> GraphSchemaStats:
        """One composed-state pass → the same ``GraphSchemaStats`` shape FalkorDB builds (per-label
        counts + up-to-3 sample displayNames, per-edge-type counts, tag counts). Serves the insights
        deep facet + graph-schema build for a branch / stale-main, which have no projection to scan."""
        from .falkordb_provider import _sanitize_label
        state = await self._svc.materialize_state(
            graph_id=self._gid, branch_id=self._branch, as_of_seq=self._as_of)
        ent_counts: Dict[str, int] = {}
        ent_samples: Dict[str, List[str]] = {}
        tag_counts: Dict[str, int] = {}
        for p in state["nodes"].values():
            lbl = _sanitize_label(p.get("entityType") or "Entity")
            ent_counts[lbl] = ent_counts.get(lbl, 0) + 1
            name = p.get("displayName")
            if name and len(ent_samples.setdefault(lbl, [])) < 3:
                ent_samples[lbl].append(name)
            tags = p.get("tags")
            if isinstance(tags, list):
                for tag in tags:
                    if tag:
                        tag_counts[tag] = tag_counts.get(tag, 0) + 1
        edge_counts: Dict[str, int] = {}
        for p in state["edges"].values():
            t = _sanitize_label(p.get("edgeType") or "REL")
            edge_counts[t] = edge_counts.get(t, 0) + 1
        return GraphSchemaStats(
            totalNodes=len(state["nodes"]),
            totalEdges=len(state["edges"]),
            entityTypeStats=[
                EntityTypeSummary(id=lbl, name=lbl, count=c, sampleNames=ent_samples.get(lbl, []))
                for lbl, c in ent_counts.items()],
            edgeTypeStats=[EdgeTypeSummary(id=t, name=t, count=c) for t, c in edge_counts.items()],
            tagStats=[TagSummary(tag=t, count=c, entityTypes=["entity"]) for t, c in tag_counts.items()],
        )

    # ---- writes: one audited commit on this branch via apply_ops -------- #
    async def _commit(self, ops: List[dict], message: str) -> Optional[str]:
        if self._as_of is not None:
            raise PermissionError("cannot write to a historical (as-of) view")
        return await self._svc.apply_ops(
            graph_id=self._gid, branch_id=self._branch, ops=ops, actor=self._actor, message=message,
            containment_edge_types=self._containment_types)

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
