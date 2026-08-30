"""FalkorDB trace v2 entry points — ``TraceMixin``.

Carved from ``backend/app/providers/falkordb/provider.py``'s
``FalkorDBProvider`` class body as it stood before this split:
``get_trace_lineage`` through ``_expand_aggregated_set`` (lines
68-2092), a single contiguous block — the "Trace v2" and "trace v2
helpers" section-banner comments moved with the methods they head.

This mixin holds the Cypher-native lineage-trace entry points the
canvas and Lens read: the legacy ``get_trace_lineage`` walk,
``trace_at_level`` (per-hop set-based BFS with node-level AGGREGATED
filtering), the degree-exact ``trace_closure``/``trace_closure_coarse``
pair, and ``expand_aggregated``. ``trace_closure``/``trace_closure_coarse``
call into the walk *engine* in ``closure.py`` (``ClosureMixin`` and
``_ClosureWalk``) rather than owning it — that split is the plan's,
kept here rather than folding the engine's helpers into this file.

``tests/test_trace_closure_completeness.py`` and
``tests/test_trace_closure_wire_contract.py`` pin this mixin's contract
byte-for-byte: an excluded seed is still walked *from* (``exclude_urns``
only suppresses re-shipping a node the client already holds, it never
says where the walk may start), every anchor a page reports is complete
in each requested direction, the cursor grammar (``s:<urn>`` inclusive,
a hub page cursor is ``e:<edge id>``, ``e:0`` is never minted), and the
truncation-reason priority (``seed_failed``/``nodes_failed``/
``ancestors_failed``/``timeout`` outrank ``max_nodes``). None of that is
this mixin's to change. See
``docs/superpowers/plans/2026-08-30-pr1-falkordb-decoupling.md`` §2.2
for why this has to be a mixin rather than a delegate/helper object.
"""
import asyncio
import time
from collections import defaultdict
from typing import Any, Dict, List, Optional, Set, Tuple

from backend.app.models.graph import GraphEdge, GraphNode, LineageResult, TraceFocus, TraceResult
from backend.common.models.graph import TraceClosureResult, TraceFrontierNode
from backend.app.providers.falkordb._log import logger
from backend.app.providers.falkordb.rowmap import _edge_from_row, _sanitize_label
from backend.app.providers.falkordb.aggregation import _completed
from backend.app.providers.falkordb.closure import (
    CLOSURE_FRONTIER_PROBE_CAP,
    CLOSURE_QUERY_CAP_SECS,
    CLOSURE_WALK_RESERVE_FRACTION,
    _ClosureWalk,
)


class TraceMixin:
    """Trace v2 entry points: the legacy lineage walk, per-hop BFS
    (``trace_at_level``), the degree-exact closure-walk entry points
    (``trace_closure`` / ``trace_closure_coarse``), and AGGREGATED
    expansion (``expand_aggregated``)."""

    async def get_trace_lineage(
        self,
        urn: str,
        direction: str,
        depth: int,
        containment_edges: List[str],
        lineage_edges: List[str],
    ) -> LineageResult:
        """
        Execute a targeted lineage trace using dynamic edge lists.
        1. Start at target URN.
        2. Traverse DOWN containment to find children (if any).
        3. Traverse ACROSS lineage edges (upstream/downstream).
        4. Traverse UP containment to find structural context.
        """
        await self._ensure_connected()
        
        # Per-source alignment (Task E): render the source's observed spellings so a
        # case-variant graph isn't missed by the case-sensitive patterns below.
        safe_containment = [_sanitize_label(t) for t in self._alias_rel_types(containment_edges)]
        safe_lineage = [_sanitize_label(t) for t in self._alias_rel_types(lineage_edges)]
        
        # If no lineage edges defined, return just the node
        if not safe_lineage:
            node = await self.get_node(urn)
            return LineageResult(
                nodes=[node] if node else [],
                edges=[],
                upstreamUrns=set(), 
                downstreamUrns=set(),
                totalCount=1 if node else 0,
                hasMore=False
            )

        # 1. Expand Scope: Target + Children
        # Find children using containment edges
        start_urns = {urn}
        if safe_containment:
            # Get children (depth 1 for now, or use *1.. if needed)
            cypher_kids = (
                f"MATCH (p)-[r]->(c) "
                f"WHERE p.urn = $urn AND type(r) IN $containment "
                f"RETURN c.urn"
            )
            res_kids = await self._ro_query(
                cypher_kids, 
                params={"urn": urn, "containment": safe_containment}
            )
            for row in (res_kids.result_set or []):
                start_urns.add(row[0])
        
        # 2. Trace Lineage
        collected_nodes: Dict[str, GraphNode] = {}
        collected_edges: Dict[str, GraphEdge] = {}
        
        upstream_urns = set()
        downstream_urns = set()
        
        if not start_urns:
             return LineageResult(nodes=[], edges=[], upstreamUrns=set(), downstreamUrns=set(), totalCount=0, hasMore=False)

        # Batched BFS: 1 Cypher query per depth level instead of 1 per node.
        # Each iteration processes the entire frontier at once.
        visited_lineage = set(start_urns)
        current_frontier = list(start_urns)

        for current_depth in range(depth):
            if not current_frontier:
                break

            next_frontier_upstream: List[str] = []
            next_frontier_downstream: List[str] = []

            # Build direction-specific batch queries
            dir_queries = []
            if direction in ["upstream", "both"]:
                # Find all nodes that flow INTO the current frontier
                cypher_up = (
                    "MATCH (src)-[r]->(tgt) "
                    "WHERE tgt.urn IN $frontier AND type(r) IN $lineage "
                    "RETURN src, r, tgt"
                )
                dir_queries.append(("upstream", cypher_up))
            if direction in ["downstream", "both"]:
                # Find all nodes that flow OUT of the current frontier
                cypher_down = (
                    "MATCH (src)-[r]->(tgt) "
                    "WHERE src.urn IN $frontier AND type(r) IN $lineage "
                    "RETURN src, r, tgt"
                )
                dir_queries.append(("downstream", cypher_down))

            for dir_label, cypher_q in dir_queries:
                res = await self._ro_query(
                    cypher_q,
                    params={"frontier": current_frontier, "lineage": safe_lineage}
                )

                for row in (res.result_set or []):
                    src_node_obj = self._extract_node_from_result(row[0])
                    edge_obj_raw = row[1]
                    tgt_node_obj = self._extract_node_from_result(row[2])

                    if not src_node_obj or not tgt_node_obj:
                        continue

                    r_type = getattr(edge_obj_raw, "relation", None) or getattr(edge_obj_raw, "type", None) or "UNKNOWN"
                    r_props = getattr(edge_obj_raw, "properties", {})

                    edge = _edge_from_row(src_node_obj.urn, tgt_node_obj.urn, r_type, r_props)

                    if edge.id not in collected_edges:
                        collected_edges[edge.id] = edge
                        collected_nodes[src_node_obj.urn] = src_node_obj
                        collected_nodes[tgt_node_obj.urn] = tgt_node_obj

                        if dir_label == "upstream":
                            neighbor = src_node_obj
                            if neighbor.urn not in visited_lineage:
                                visited_lineage.add(neighbor.urn)
                                upstream_urns.add(neighbor.urn)
                                next_frontier_upstream.append(neighbor.urn)
                        else:
                            neighbor = tgt_node_obj
                            if neighbor.urn not in visited_lineage:
                                visited_lineage.add(neighbor.urn)
                                downstream_urns.add(neighbor.urn)
                                next_frontier_downstream.append(neighbor.urn)

            # Merge frontiers for next depth level
            current_frontier = next_frontier_upstream + next_frontier_downstream

        # 3. Structural Context (Traverse UP)
        # For all collected nodes, find their parents/containers
        all_lineage_urns = list(collected_nodes.keys())
        if all_lineage_urns and safe_containment:
             # Find parents recursively or just immediate? 
             # Usually tracing up to Root is good. keyspace -> table -> column
             
             # Cypher to find ancestors:
             # MATCH (child)<-[r*1..5]-(parent) WHERE child.urn IN $urns AND type(r) IN $containment RETURN parent, r
             # Note: variable length relationship with type filter might be syntax sensitive in FalkorDB
             # MATCH (child)<-[r*1..5]-(parent) ...
             # We can just fetch all ancestors.
             
             # We can process in batches if many nodes
             batch_urns = all_lineage_urns # optimize if huge
             
             # We assume containment is child<-parent (parent IS SOURCE of CONTAINS edge)
             # So we match (parent)-[:CONTAINS]->(child)
             
             cypher_structure = (
                 f"MATCH (parent)-[r]->(child) "
                 f"WHERE child.urn IN $urns AND type(r) IN $containment "
                 f"RETURN parent, r, child"
             )
             
             # We might need to iterate this to go up multiple levels?
             # Or use *1..5
             # Let's try to get full hierarchy for the visible nodes.
             
             # For simpler implementation: Use a loop to climb up.
             # Or rely on get_ancestors if it wasn't one-by-one.
             
             # Let's do a single pass for immediate parents, then loop?
             # Actually, simpler: Just fetch all ancestors for these nodes.
             
             # Batched ancestor fetch — climb containment levels
             current_level_urns = all_lineage_urns
             seen_parents: Set[str] = set(collected_nodes.keys())
             for _ in range(5):  # up to 5 containment levels
                 if not current_level_urns:
                     break

                 res_struct = await self._ro_query(
                     cypher_structure,
                     params={"urns": current_level_urns, "containment": safe_containment}
                 )

                 next_level_urns = []

                 for row in (res_struct.result_set or []):
                     parent = self._extract_node_from_result(row[0])
                     r_raw = row[1]
                     child = self._extract_node_from_result(row[2])

                     if parent and child:
                         collected_nodes[child.urn] = child

                         r_type = getattr(r_raw, "relation", None) or getattr(r_raw, "type", None) or "UNKNOWN"
                         r_props = getattr(r_raw, "properties", {})

                         edge = _edge_from_row(parent.urn, child.urn, r_type, r_props)
                         collected_edges[edge.id] = edge

                         # Only add parent to next level if we haven't seen it before
                         if parent.urn not in seen_parents:
                             seen_parents.add(parent.urn)
                             collected_nodes[parent.urn] = parent
                             next_level_urns.append(parent.urn)

                 if not next_level_urns:
                     break
                 current_level_urns = next_level_urns

        # Ensure original urn is in collected nodes
        if urn not in collected_nodes:
            start_node = await self.get_node(urn)
            if start_node:
                collected_nodes[urn] = start_node

        return LineageResult(
            nodes=list(collected_nodes.values()),
            edges=list(collected_edges.values()),
            upstreamUrns=upstream_urns,
            downstreamUrns=downstream_urns,
            totalCount=len(collected_nodes),
            hasMore=False
        )

    # ------------------------------------------------------------------ #
    # Trace v2 — Cypher-native, ontology-aware lineage                    #
    #                                                                     #
    # Filters AGGREGATED edges by node-level (s.level/t.level) at the    #
    # database layer. Per-hop set-based BFS orchestrated in Python — the  #
    # hot path is a single UNWIND $frontier MATCH per hop, capped by     #
    # LIMIT. Cost is proportional to result size, not graph size.        #
    #                                                                     #
    # Assumes ``in_source`` projection mode (the default): AGGREGATED    #
    # edges and source nodes live in the same graph, so the level filter #
    # can join on s.level/t.level. ``dedicated`` mode requires the       #
    # materializer to project node levels onto shadow nodes — out of     #
    # scope here.                                                         #
    # ------------------------------------------------------------------ #

    async def trace_at_level(
        self,
        urn: str,
        level: int,
        upstream_depth: int,
        downstream_depth: int,
        lineage_edge_types: List[str],
        containment_edge_types: List[str],
        max_nodes: int,
        timeout_ms: int,
        include_containment_edges: bool = False,
        include_inherited_lineage: bool = True,
    ) -> TraceResult:
        await self._ensure_connected()
        deadline = time.monotonic() + (timeout_ms / 1000.0)

        # Normalize edge type lists to UPPERCASE — matches what type(r) returns
        # in FalkorDB and what set_containment_edge_types stores internally.
        ctypes = [t.upper() for t in (containment_edge_types or [])]
        ltypes = [t.upper() for t in (lineage_edge_types or [])] if lineage_edge_types else None
        # Per-source alignment (Task E): translate the uppercased declared types to THIS
        # graph's observed spellings so the case-sensitive :TYPE / type(r) IN patterns below
        # match a differently-cased graph. Identity for governed/canonical graphs.
        ctypes = self._alias_rel_types(ctypes)
        ltypes = self._alias_rel_types(ltypes) if ltypes else ltypes

        # Focus node — needed for the response shape regardless of trace
        # outcome. Wave 1: the root-anchor walk is independent of the focus
        # payload, so run it CONCURRENTLY (optimistic — discarded when the
        # focus's level turns out unknown). The anchor phase used to be 5-7
        # strictly sequential round-trips; against a remote FalkorDB each
        # paid full RTT.
        root_anchor_task = None
        if level == 0 and ctypes:
            root_anchor_task = asyncio.ensure_future(
                self._resolve_root_anchor(urn, ctypes))
        try:
            focus_node = await self.get_node(urn)
        except Exception:
            if root_anchor_task is not None:
                root_anchor_task.cancel()
            raise
        focus_level = self._get_node_level(focus_node.entity_type) if focus_node else level
        focus_entity_type = str(focus_node.entity_type) if focus_node else "unknown"

        # Cold-start / drift observability: the probe at
        # _check_levels_backfilled logs once per digest when stamps are
        # missing or stale. We do NOT re-log here per trace — the probe's
        # one-time log is enough and per-request logging spams when many
        # traces run against the same provider.
        #
        # The trace path itself stays correct in either state: stamped
        # edges take the level-pair fast path; unstamped (or -1-stamped)
        # edges fall back to the label-scan path inside
        # _expand_aggregated_set.

        # 1. Resolve anchor at the requested level (climb containment if needed).
        #
        #    Skeleton-first (level=0) branches:
        #      (a) focus_level known + ctypes present → try root anchor.
        #          If found at level 0, anchor there. If found at level>0
        #          (orphan), anchor there and report fallbackLevel. If
        #          resolution fails, fall through to legacy resolver.
        #      (b) focus_level unknown (ontology doesn't declare a level
        #          for the focus's entity type, e.g. a generator-declared
        #          "layer") →
        #          skip root-anchor entirely. Anchor at the focus itself
        #          and signal effective_level=-1 so _expand_aggregated_set
        #          uses the peer-label fallback (same-label neighbours
        #          only). This is what stops layer→layer trace from
        #          spilling into attributes.
        fallback_level: Optional[int] = None
        effective_level = level
        if root_anchor_task is not None and (focus_level is None):
            # Optimistic wave-1 walk not needed on this branch.
            root_anchor_task.cancel()
        if level == 0 and ctypes and focus_level is not None:
            root_urn, root_level = await root_anchor_task
            if root_level == 0:
                anchor_urn = root_urn
            elif root_level > 0:
                anchor_urn = root_urn
                effective_level = root_level
                fallback_level = root_level
            else:
                anchor_urn = await self._resolve_anchor_at_level(urn, level, ctypes)
                if anchor_urn == urn and focus_level != 0:
                    effective_level = focus_level
                    fallback_level = focus_level
        elif level == 0 and focus_level is None:
            # Ontology has no declared level for the focus's entity type.
            # Anchor at the focus and rely on peer-label rollup downstream.
            anchor_urn = urn
            effective_level = -1
            fallback_level = -1
        else:
            anchor_urn = await self._resolve_anchor_at_level(urn, level, ctypes)

        # 2. Inherited-lineage fallback. Wave 2: the has-lineage existence
        # probe and the anchor node fetch are independent — gather them.
        is_inherited = False
        inherited_from = None
        if include_inherited_lineage:
            has_lineage, anchor_node = await asyncio.gather(
                self._has_aggregated_at_level(anchor_urn, effective_level, ltypes),
                self.get_node(anchor_urn) if anchor_urn != urn
                else _completed(focus_node),
            )
            if not has_lineage:
                parent = await self._find_ancestor_with_lineage(
                    anchor_urn, effective_level, ctypes, ltypes)
                if parent and parent != anchor_urn:
                    inherited_from = anchor_urn
                    anchor_urn = parent
                    is_inherited = True
                    anchor_node = await self.get_node(anchor_urn)
        else:
            anchor_node = (
                focus_node if anchor_urn == urn
                else await self.get_node(anchor_urn)
            )

        # 3. Seed BFS state
        nodes_by_urn: Dict[str, GraphNode] = {}
        if anchor_node:
            nodes_by_urn[anchor_urn] = anchor_node
        edges_by_id: Dict[str, GraphEdge] = {}
        upstream_urns: Set[str] = set()
        downstream_urns: Set[str] = set()
        visited: Set[str] = {anchor_urn}
        up_frontier: Set[str] = {anchor_urn} if upstream_depth > 0 else set()
        down_frontier: Set[str] = {anchor_urn} if downstream_depth > 0 else set()
        truncation_reason: Optional[str] = None
        # Per-source-URN contribution counts. After BFS, any source that hit
        # TRACE_DEGREE_CAP is a mega-node candidate — emitted in meta.megaNodes
        # so the UI can render a "+N more" chip and offer targeted re-expand.
        per_source_count: Dict[str, int] = {}

        # 4. Per-hop set-based expansion
        max_depth = max(upstream_depth, downstream_depth)
        for hop in range(max_depth):
            remaining_secs = deadline - time.monotonic()
            if remaining_secs <= 0:
                truncation_reason = "timeout"
                break
            if len(nodes_by_urn) >= max_nodes:
                truncation_reason = "max_nodes"
                break
            budget = max_nodes - len(nodes_by_urn)

            # Build frontier→label maps from already-fetched nodes. New
            # frontier members were hydrated by the previous hop's
            # `rec.get("node")` payload, so their entity_type is known
            # without an extra round-trip.
            up_labels = {
                u: _sanitize_label(str(nodes_by_urn[u].entity_type))
                for u in up_frontier if u in nodes_by_urn
            }
            down_labels = {
                u: _sanitize_label(str(nodes_by_urn[u].entity_type))
                for u in down_frontier if u in nodes_by_urn
            }

            # Per-hop wall-clock budget. Up to two directions run in
            # parallel, each issuing 1-2 sub-queries — splitting the
            # remaining budget across them lets a slow hop fail fast
            # rather than starving subsequent hops.
            hop_timeout_secs = max(0.6, min(1.5, remaining_secs / 2))

            tasks = []
            if hop < upstream_depth and up_frontier:
                tasks.append(("up", self._expand_aggregated_set(
                    list(up_frontier), up_labels, "incoming",
                    effective_level, ltypes, budget, hop_timeout_secs,
                    default_peer_label=focus_entity_type,
                )))
            if hop < downstream_depth and down_frontier:
                tasks.append(("down", self._expand_aggregated_set(
                    list(down_frontier), down_labels, "outgoing",
                    effective_level, ltypes, budget, hop_timeout_secs,
                    default_peer_label=focus_entity_type,
                )))
            if not tasks:
                break

            results = await asyncio.gather(
                *(t[1] for t in tasks), return_exceptions=True
            )

            new_up: Set[str] = set()
            new_down: Set[str] = set()
            for (direction, _), recs in zip(tasks, results):
                if isinstance(recs, Exception):
                    logger.warning("trace_at_level expand (%s) failed: %s", direction, recs)
                    continue
                for rec in recs:
                    edge_id = rec["edgeId"]
                    if edge_id not in edges_by_id:
                        # Use the actual relationship type — AGGREGATED for
                        # rolled-up lineage, or the raw lineage type
                        # (TRANSFORMS, FLOWS_TO, …) when tracing at fine-
                        # grained levels where lineage is not pre-aggregated.
                        actual_type = rec.get("edgeType") or "AGGREGATED"
                        edges_by_id[edge_id] = GraphEdge(
                            id=edge_id,
                            sourceUrn=rec["sourceUrn"],
                            targetUrn=rec["targetUrn"],
                            edgeType=actual_type,
                            properties={
                                "sourceEdgeTypes": rec.get("edgeTypes") or [actual_type],
                                "weight": rec.get("weight") or 1,
                            },
                        )
                        # Track aggregated edges per anchor (the frontier-side
                        # URN). Direction-aware: for upstream BFS the anchor
                        # is the target; for downstream it's the source.
                        if actual_type == "AGGREGATED":
                            anchor_for_count = (
                                rec["targetUrn"] if direction == "up"
                                else rec["sourceUrn"]
                            )
                            per_source_count[anchor_for_count] = (
                                per_source_count.get(anchor_for_count, 0) + 1
                            )
                    new_node = rec.get("node")
                    if new_node and new_node.urn not in nodes_by_urn:
                        nodes_by_urn[new_node.urn] = new_node
                    other_urn = rec["sourceUrn"] if direction == "up" else rec["targetUrn"]
                    if other_urn not in visited:
                        visited.add(other_urn)
                        if direction == "up":
                            new_up.add(other_urn)
                            upstream_urns.add(other_urn)
                        else:
                            new_down.add(other_urn)
                            downstream_urns.add(other_urn)

            up_frontier = new_up
            down_frontier = new_down
            if not up_frontier and not down_frontier:
                break

        # SAFETY NET: if skeleton-first (level=0) yielded zero lineage edges,
        # retry at the focus's own level (legacy "auto" peer-rollup). Two
        # paths trigger this:
        #   (a) focus_level known → retry at that int level
        #   (b) focus_level None (ontology missing the focus's level) →
        #       retry with level=-1 (sentinel meaning "no level filter,
        #       use peer-label fallback in _expand_aggregated_set")
        # The frontend safety-net memo: never return empty when the wire
        # had lineage to give. One retry; no recursion.
        remaining_after_bfs = deadline - time.monotonic()
        needs_retry = (
            not edges_by_id
            and level == 0
            and effective_level == 0
            and not is_inherited  # don't retry if inherited-fallback already moved us
            and (
                (focus_level is not None and focus_level != 0)
                or focus_level is None
            )
        )
        if needs_retry and remaining_after_bfs < 0.4 * (timeout_ms / 1000.0):
            # The retry re-runs the WHOLE BFS — without a floor it could
            # consume the tail of the budget and starve hydration, turning
            # a truncated-but-usable answer into a 504. Skip and report.
            logger.info(
                "trace: skipping focus-level retry for %s — only %.1fs of "
                "%.1fs budget left (<40%%)", urn, remaining_after_bfs,
                timeout_ms / 1000.0,
            )
            truncation_reason = truncation_reason or "timeout"
            needs_retry = False
        if needs_retry:
            retry_level = focus_level if focus_level is not None else -1
            logger.info(
                "trace: level=0 yielded no lineage for %s (focus_level=%s) — "
                "retrying at level=%s (peer-rollup)", urn, focus_level, retry_level,
            )
            effective_level = retry_level
            fallback_level = retry_level
            # Re-anchor at focus URN itself for peer rollup at focus level
            anchor_urn = urn
            anchor_node = focus_node
            if anchor_node:
                nodes_by_urn = {anchor_urn: anchor_node}
            else:
                nodes_by_urn = {}
            edges_by_id = {}
            upstream_urns = set()
            downstream_urns = set()
            visited = {anchor_urn}
            up_frontier = {anchor_urn} if upstream_depth > 0 else set()
            down_frontier = {anchor_urn} if downstream_depth > 0 else set()
            per_source_count = {}

            # Single retry pass — same loop body, but bounded (depth
            # additionally capped: a fine-level retry over a deep graph
            # multiplies per-hop waves against the leftover budget).
            for hop in range(min(max_depth, 5)):
                remaining_secs = deadline - time.monotonic()
                if remaining_secs <= 0:
                    truncation_reason = "timeout"
                    break
                if len(nodes_by_urn) >= max_nodes:
                    truncation_reason = "max_nodes"
                    break
                budget = max_nodes - len(nodes_by_urn)
                up_labels = {
                    u: _sanitize_label(str(nodes_by_urn[u].entity_type))
                    for u in up_frontier if u in nodes_by_urn
                }
                down_labels = {
                    u: _sanitize_label(str(nodes_by_urn[u].entity_type))
                    for u in down_frontier if u in nodes_by_urn
                }
                hop_timeout_secs = max(0.6, min(1.5, remaining_secs / 2))
                tasks = []
                if hop < upstream_depth and up_frontier:
                    tasks.append(("up", self._expand_aggregated_set(
                        list(up_frontier), up_labels, "incoming",
                        effective_level, ltypes, budget, hop_timeout_secs,
                        default_peer_label=focus_entity_type,
                    )))
                if hop < downstream_depth and down_frontier:
                    tasks.append(("down", self._expand_aggregated_set(
                        list(down_frontier), down_labels, "outgoing",
                        effective_level, ltypes, budget, hop_timeout_secs,
                        default_peer_label=focus_entity_type,
                    )))
                if not tasks:
                    break
                results = await asyncio.gather(*(t[1] for t in tasks), return_exceptions=True)
                new_up: Set[str] = set()
                new_down: Set[str] = set()
                for (direction, _), recs in zip(tasks, results):
                    if isinstance(recs, Exception):
                        logger.warning("trace_at_level retry expand (%s) failed: %s", direction, recs)
                        continue
                    for rec in recs:
                        edge_id = rec["edgeId"]
                        if edge_id not in edges_by_id:
                            actual_type = rec.get("edgeType") or "AGGREGATED"
                            edges_by_id[edge_id] = GraphEdge(
                                id=edge_id,
                                sourceUrn=rec["sourceUrn"],
                                targetUrn=rec["targetUrn"],
                                edgeType=actual_type,
                                properties={
                                    "sourceEdgeTypes": rec.get("edgeTypes") or [actual_type],
                                    "weight": rec.get("weight") or 1,
                                },
                            )
                        new_node = rec.get("node")
                        if new_node and new_node.urn not in nodes_by_urn:
                            nodes_by_urn[new_node.urn] = new_node
                        other_urn = rec["sourceUrn"] if direction == "up" else rec["targetUrn"]
                        if other_urn not in visited:
                            visited.add(other_urn)
                            if direction == "up":
                                new_up.add(other_urn)
                                upstream_urns.add(other_urn)
                            else:
                                new_down.add(other_urn)
                                downstream_urns.add(other_urn)
                up_frontier = new_up
                down_frontier = new_down
                if not up_frontier and not down_frontier:
                    break

        # 5. ALWAYS hydrate the containment chain. A trace returns lineage URNs
        # at whatever level was requested (peer-level by default, finer levels
        # via expand). For the canvas to position those URNs in the layered
        # hierarchy it needs every containment ancestor (Dataset → Container →
        # Domain) AND the parent-child edges linking them. Without this the
        # frontend treats trace nodes as orphans, layer assignment can't place
        # them, and the user sees nothing — which is exactly the schemaField
        # trace bug. The `include_containment_edges` flag is intentionally
        # ignored here: hierarchy context is non-optional for trace responses.
        containment_edges_list: List[GraphEdge] = []
        if ctypes and nodes_by_urn and (deadline - time.monotonic()) < 2.0:
            # Not enough budget left to hydrate ancestors safely — return
            # the lineage skeleton as a truncated 200 (the FE tolerates a
            # missing chain via the ancestors_failed path) instead of
            # racing the middleware 504.
            truncation_reason = truncation_reason or "ancestors_failed"
        elif ctypes and nodes_by_urn:
            chains: Dict[str, List[str]] = {}
            try:
                chains = await self._compute_and_store_ancestors_bulk(
                    list(nodes_by_urn.keys()),
                )
            except Exception:
                # Lineage was already collected; surface the partial result
                # via truncationReason so the frontend safety-net renders
                # the lineage without the (now-missing) ancestor chain.
                truncation_reason = truncation_reason or "ancestors_failed"
            seen_anc: Set[str] = set()
            ancestor_urns: List[str] = []
            for chain in chains.values():
                for ancestor in chain or []:
                    if ancestor and ancestor not in seen_anc:
                        seen_anc.add(ancestor)
                        ancestor_urns.append(ancestor)
            new_ancestors = [u for u in ancestor_urns if u not in nodes_by_urn]
            if new_ancestors:
                ancestor_nodes = await self.get_nodes_batch(new_ancestors)
                for n in ancestor_nodes:
                    if n:
                        nodes_by_urn[n.urn] = n
            # Containment edges between every returned node — both lineage
            # participants and their hydrated ancestors. The chains just
            # computed are passed through so the pair derivation doesn't
            # re-fetch them (one Redis wave saved per trace).
            if len(nodes_by_urn) > 1:
                containment_edges_list = await self._fetch_containment_edges(
                    list(nodes_by_urn.keys()), ctypes, chains=chains,
                )

        # Mega-node detection: any anchor whose AGGREGATED contribution
        # exceeded the per-source degree cap is reported back to the
        # engine via a private attribute. Used by ContextEngine to fill
        # TraceMeta.megaNodes — the UI renders a "+N more" chip and
        # offers a targeted re-expand.
        mega_nodes_dicts: List[Dict[str, Any]] = []
        for source_urn, count in per_source_count.items():
            if count >= self.TRACE_DEGREE_CAP:
                direction_hint = (
                    "downstream" if source_urn in downstream_urns or source_urn == anchor_urn
                    else "upstream"
                )
                mega_nodes_dicts.append({
                    "urn": source_urn,
                    "shown": count,
                    "total": count,  # actual total unknown without extra round-trip
                    "direction": direction_hint,
                })
                if truncation_reason is None:
                    truncation_reason = "degree_cap"

        result = TraceResult(
            nodes=list(nodes_by_urn.values()),
            edges=list(edges_by_id.values()),
            containmentEdges=containment_edges_list,
            upstreamUrns=upstream_urns,
            downstreamUrns=downstream_urns,
            focus=TraceFocus(
                urn=urn,
                level=focus_level if focus_level is not None else level,
                entityType=focus_entity_type,
            ),
            effectiveLevel=effective_level,
            isInherited=is_inherited,
            inheritedFromUrn=inherited_from,
            truncated=(truncation_reason is not None),
            truncationReason=truncation_reason,
        )
        # Stash extras outside the pydantic schema for the engine to read.
        # `object.__setattr__` bypasses pydantic's __setattr__ guard so we
        # don't have to widen the public model just for transport.
        if mega_nodes_dicts:
            object.__setattr__(result, "_mega_nodes", mega_nodes_dicts)
        if fallback_level is not None:
            object.__setattr__(result, "_fallback_level", fallback_level)
        return result

    async def trace_closure(
        self,
        urn: str,
        upstream_depth: int,
        downstream_depth: int,
        lineage_edge_types: List[str],
        containment_edge_types: List[str],
        max_nodes: int,
        timeout_ms: int,
        seed_urns: Optional[List[str]] = None,
        exclude_urns: Optional[List[str]] = None,
        after_cursor: Optional[str] = None,
        seed_cursor: Optional[str] = None,
    ) -> TraceClosureResult:
        """Focus-scoped, regime-independent lineage closure — ONE step of a walk.

        Walks RAW lineage edges outward from the focus (upstream + downstream)
        as a bounded per-hop frontier BFS (``_expand_raw_lineage_set``),
        gathering exactly the leaves that participate in THIS focus's lineage —
        not its container's. Depends on NO ``:AGGREGATED`` cells, so it is
        correct at the finest grain even in boundary regime where leaf rollups
        are never materialised (the "trace disappears at the attribute level"
        bug). Always hydrates the containment ancestor chain so the canvas can
        nest the participants — containment is used to PLACE nodes, never as a
        lineage hop.

        Bounded like ``trace_at_level``: the engine deadline (< the middleware
        tier) makes it truncate to a 200 with a ``truncationReason`` rather than
        race a 504; ``max_nodes`` caps the working set. Python is a frontier
        cursor + a visited set (cycle-safe on any cyclic graph); every
        set-shaped step is one label-qualified index-seeking Cypher.

        The walk is SERVER-DRIVEN one step at a time — the client keeps the
        graph it has accumulated and asks for the next step — so three
        parameters describe where it already is:

        ``seed_urns``    start the hops from these known lineage participants
                         instead of deriving a seed from the focus. A walk
                         CONTINUATION: the client is expanding a frontier node,
                         not re-anchoring on the focus.
        ``exclude_urns`` nodes the client already holds. They are never
                         re-shipped in ``nodes``, but an EDGE into one still
                         is — that seam edge is what stitches this step onto
                         the graph the client already has. It says nothing
                         about where the walk may START: a node named in
                         ``seed_urns`` is walked from (and hydrated with the
                         rest of the working set) whether or not it is also
                         excluded, which is the only shape a real client
                         ever sends.
        ``after_cursor`` page ONE node's adjacency in ONE direction instead of
                         walking: the fallback for a hub with more lineage than
                         a hop can carry. ``e:<edge id>`` names the NEXT id to
                         consider, so ``e:0`` is from the start.

        THE WALK IS DEGREE-EXACT (see ``_walk_anchors``). Anchors — the focus
        or its lineage-bearing descendants, in urn order — are walked in the
        longest prefix whose ``node + degree`` estimate fits the remaining
        budget, so every anchor a page ships is COMPLETE in each requested
        direction, ``len(discovered)`` never exceeds ``max_nodes``, and a page
        is a pure function of (graph, request). What did not fit:

        * a descendant the page could not afford is the next page's first
          anchor: ``seedCursor = "s:<urn>"`` (INCLUSIVE — the next anchor to
          consider), legal with ``seed_urns`` too;
        * an explicit seed or a hop>=2 ring member that did not fit is a
          CURSOR-LESS frontier entry with ``reason == "cut"`` — re-root it via
          ``seed_urns`` (batchable, hundreds per request);
        * a hub no page can hold is paged by edge id and carries a REAL
          ``e:<next id>`` cursor; ``e:0`` is never minted.

        ``frontierUp``/``frontierDown`` name the boundary nodes the walk did NOT
        finish, carrying the full-graph degree in that direction when it is
        known, so the canvas can offer "+N more" instead of presenting a
        bounded closure as the whole truth, and ``reason`` saying whether the
        BUDGET stopped there (``cut`` — a one-hop client completes it hands-
        free) or the requested DEPTH did (``depth`` — the next hop, a pill). A
        boundary node whose adjacency is already fully on screen is NOT
        frontier: it is an honest dead end. Nothing is lost silently: a failed
        query files its anchors as cut under ``truncationReason == "timeout"``,
        a failed enumeration is ``seed_failed``, missing hydration is
        ``nodes_failed`` (its dangling edges dropped), and any failure outranks
        ``max_nodes`` in the reported reason.
        """
        await self._ensure_connected()
        deadline = time.monotonic() + (timeout_ms / 1000.0)

        # Normalize + per-graph case-align the declared rel-type sets (the
        # case-sensitive [:TYPE] / type(r) patterns need the graph's spelling).
        ltypes = [t.upper() for t in (lineage_edge_types or [])]
        ctypes = [t.upper() for t in (containment_edge_types or [])]
        ltypes = self._alias_rel_types(ltypes) if ltypes else ltypes
        ctypes = self._alias_rel_types(ctypes) if ctypes else ctypes

        try:
            focus_node = await self.get_node(urn)
        except Exception:
            focus_node = None
        focus_level = self._get_node_level(focus_node.entity_type) if focus_node else None
        focus_entity_type = str(focus_node.entity_type) if focus_node else "unknown"
        focus_label = focus_entity_type if focus_node else ""

        excluded: Set[str] = set(exclude_urns or [])
        seed_truncated = False

        # ---- the walk state --------------------------------------------
        # Every walk query is bounded by the REQUEST deadline minus a reserve
        # for hydration/containment, capped per query — not clamped to a flat
        # 1.5 s, which on wide estates timed out silently and shipped pages
        # that claimed to be complete.
        walk_deadline = deadline - min(10.0, CLOSURE_WALK_RESERVE_FRACTION * (timeout_ms / 1000.0))
        st = _ClosureWalk(
            ltypes=ltypes, max_nodes=max_nodes, deadline=deadline, walk_deadline=walk_deadline,
            excluded=excluded, visited=set(excluded), discovered=set(),
        )
        # Depth boundary: rings still growing when the requested depth ended.
        depth_up: Dict[str, None] = {}
        depth_down: Dict[str, None] = {}
        next_seed_after: Optional[str] = None
        seed_after = (
            seed_cursor[2:]
            if seed_cursor and seed_cursor.startswith("s:") and len(seed_cursor) > 2
            else None
        )

        if after_cursor is not None:
            # ---- paging shape: one node, one direction, one page ----------
            # No seed walk and no BFS: the client is draining a single hub it
            # already has, so re-walking would re-ship everything around it.
            try:
                after_id = int(after_cursor[2:])
            except (TypeError, ValueError):
                # The endpoint guarantees ^e:\d+$; if something else arrives,
                # refuse rather than silently page from the start (which would
                # re-ship a page the client already holds).
                raise ValueError("invalid cursor")
            up = int(upstream_depth) > 0
            side = "up" if up else "down"
            anchor_label = await self._get_cached_label(urn) or focus_label
            st.discovered.add(urn)
            st.visited.add(urn)
            st.labels[urn] = anchor_label
            rows, last_edge_id = await self._page_raw_lineage_single(
                urn, anchor_label, "incoming" if up else "outgoing", ltypes,
                after_id, max_nodes, st.query_timeout(),
            )
            if rows is None:
                # The page could not be read: say so, and hand the SAME cursor
                # back so the client resumes exactly where it was.
                st.reasons.append("timeout")
                (st.cut_up if up else st.cut_down)[urn] = None
                st.paged[(urn, side)] = after_cursor
            else:
                # The anchor and the client's known set are "already visited":
                # their edges still ship (the seam), the nodes are not
                # re-shipped and not re-attributed to a direction the client
                # already filed them under.
                for rec in rows:
                    st.record_edge(rec)
                    other = rec.get("otherUrn")
                    if not other or other in st.visited:
                        continue
                    st.visited.add(other)
                    st.discovered.add(other)
                    st.labels[other] = rec.get("otherLabel") or ""
                    (st.upstream_urns if up else st.downstream_urns).add(other)
                    # A partner arrives here UNWALKED — the page read the
                    # ANCHOR's adjacency, never this node's — so it is filed
                    # like a ring the last allowed hop discovered: a depth
                    # candidate, probed below and kept only if it has more
                    # than the client can see.
                    (depth_up if up else depth_down)[other] = None
                if len(rows) >= max_nodes:
                    # A FULL page means there is more of this node's adjacency;
                    # the cursor names the NEXT id to consider.
                    (st.cut_up if up else st.cut_down)[urn] = None
                    if last_edge_id is not None:
                        st.paged[(urn, side)] = f"e:{last_edge_id + 1}"
                    st.reasons.append("max_nodes")
        else:
            # ---- seed: enumerate the anchors, then walk hop 1 exactly ----
            # A SEED IS AN INSTRUCTION, NOT A CANDIDATE. ``exclude_urns``
            # says what must not be re-SHIPPED; it never says where the walk
            # may START (a client's seeds are by construction nodes it already
            # holds). And a seed that stands for finer things resolves to
            # them: lineage lives at the leaves, a table carries none of its
            # own, so ``seedUrns:[table]`` walks the table's columns — paged
            # by keyset exactly like a focus-anchored seed.
            up_active = int(upstream_depth) > 0
            down_active = int(downstream_depth) > 0
            roots: List[Tuple[str, str]] = []
            desc: List[Tuple[str, str]] = []
            enum_failed = False
            if seed_urns:
                wanted = sorted(dict.fromkeys(seed_urns))
                labels = await self._resolve_urn_labels_bulk(wanted) if wanted else {}
                roots = [(u, labels.get(u) or "") for u in wanted]
                desc, enum_failed = await self._descendant_lineage_seed(
                    wanted, labels, ltypes, ctypes, max_nodes + 1, st.query_timeout(),
                    after_urn=seed_after,
                )
                if seed_after:
                    # A continuation of a seed list's descendants: the named
                    # seeds were walked on page one. They stay pre-visited
                    # (a seam edge into one still ships) but are not
                    # re-walked and not re-shipped.
                    for u, lbl in roots:
                        st.visited.add(u)
                        st.labels.setdefault(u, lbl)
                    roots = []
            else:
                anchors, enum_failed = await self._collect_lineage_seed(
                    urn, focus_label, ltypes, ctypes, max_nodes + 1, st.query_timeout(),
                    after_urn=seed_after,
                )
                roots = [a for a in anchors if a[0] == urn]
                desc = [a for a in anchors if a[0] != urn]
            if enum_failed:
                st.reasons.append("seed_failed")

            # The request urn and the named seeds are always shipped (the
            # client holds them; a frontier entry on one must be stampable).
            st.discovered.add(urn)
            st.visited.add(urn)
            st.labels.setdefault(urn, focus_label)
            for u, lbl in roots:
                st.discovered.add(u)
                st.visited.add(u)
                st.labels.setdefault(u, lbl)

            def _room() -> int:
                return max_nodes - len(st.discovered)

            if roots and (up_active or down_active):
                i_roots = await self._walk_anchors(
                    roots, st, up=up_active, down=down_active, budget=_room(),
                    keyset=False, first_of_page=True,
                )
                self._file_cut(st, roots[i_roots:], up=up_active, down=down_active)
            j = len(desc)
            if desc and (up_active or down_active):
                j = await self._walk_anchors(
                    desc, st, up=up_active, down=down_active, budget=_room(),
                    keyset=True, first_of_page=(st.progress == 0),
                )
            if j < len(desc) and (st.progress > 0 or "timeout" not in st.reasons):
                # Inclusive-next: the first anchor this page did not walk.
                # A page that made NO progress because its first read failed
                # ships no cursor — a cursor there would loop the client.
                next_seed_after = desc[j][0]
                if "max_nodes" not in st.reasons:
                    st.reasons.append("max_nodes")
            seed_truncated = next_seed_after is not None

            # ---- deeper hops: rings, fair shares between directions -------
            max_hops = max(int(upstream_depth), int(downstream_depth))
            ring_up = sorted(st.ring_up)
            ring_down = sorted(st.ring_down)
            st.ring_up, st.ring_down = [], []
            hop = 1
            while (ring_up or ring_down) and hop < max_hops:
                hop += 1
                active_up = bool(ring_up) and hop <= int(upstream_depth)
                active_down = bool(ring_down) and hop <= int(downstream_depth)
                if ring_up and not active_up:
                    # Ran out of DEPTH, not of graph (asymmetric depths): this
                    # ring is the upstream boundary.
                    depth_up.update(dict.fromkeys(u for u, _ in ring_up))
                    ring_up = []
                if ring_down and not active_down:
                    depth_down.update(dict.fromkeys(u for u, _ in ring_down))
                    ring_down = []
                if not (active_up or active_down):
                    break
                room = _room()
                if room <= 0 or time.monotonic() >= st.walk_deadline:
                    if time.monotonic() >= st.walk_deadline:
                        st.reasons.append("timeout")
                    self._file_cut(st, ring_up, up=True, down=False)
                    self._file_cut(st, ring_down, up=False, down=True)
                    ring_up, ring_down = [], []
                    break
                if active_up and active_down:
                    # Up takes the ceiling of half the room, down takes its
                    # half plus whatever up left, then up gets the rest.
                    share_up = room - room // 2
                    i_up = await self._walk_anchors(
                        ring_up, st, up=True, down=False, budget=share_up,
                        keyset=False, first_of_page=False,
                    )
                    i_down = await self._walk_anchors(
                        ring_down, st, up=False, down=True, budget=_room(),
                        keyset=False, first_of_page=False,
                    )
                    if i_up < len(ring_up) and _room() > 0:
                        i_up += await self._walk_anchors(
                            ring_up[i_up:], st, up=True, down=False, budget=_room(),
                            keyset=False, first_of_page=False,
                        )
                elif active_up:
                    i_up = await self._walk_anchors(
                        ring_up, st, up=True, down=False, budget=room,
                        keyset=False, first_of_page=False,
                    )
                    i_down = 0
                else:
                    i_down = await self._walk_anchors(
                        ring_down, st, up=False, down=True, budget=room,
                        keyset=False, first_of_page=False,
                    )
                    i_up = 0
                self._file_cut(st, ring_up[i_up:], up=True, down=False)
                self._file_cut(st, ring_down[i_down:], up=False, down=True)
                ring_up = sorted(st.ring_up)
                ring_down = sorted(st.ring_down)
                st.ring_up, st.ring_down = [], []
            # Depth exhaustion: the rings still growing when the last allowed
            # hop finished. A ring that simply DRAINED is empty here — a dead
            # end, never a frontier.
            depth_up.update(dict.fromkeys(u for u, _ in ring_up))
            depth_down.update(dict.fromkeys(u for u, _ in ring_down))

        edges_by_id = st.edges_by_id
        upstream_urns = st.upstream_urns
        downstream_urns = st.downstream_urns
        discovered = st.discovered
        cut_up, cut_down = st.cut_up, st.cut_down

        # ---- frontier: what the walk did not finish, and how much is left --
        # Sorted by urn (deterministic), paged anchors first in the probe.
        candidates_up = sorted(dict.fromkeys([*depth_up, *cut_up]))
        candidates_down = sorted(dict.fromkeys([*depth_down, *cut_down]))
        frontier_up: List[TraceFrontierNode] = []
        frontier_down: List[TraceFrontierNode] = []
        if candidates_up or candidates_down:
            def _probe_slice(candidates: List[str], side: str) -> List[str]:
                # Anchors with a cursor the client is draining go first, so a
                # budget's worth of partners cannot push them past the cap.
                paged = [u for u in candidates if (u, side) in st.paged]
                rest = [u for u in candidates if (u, side) not in st.paged]
                # The walk already knows the degrees of what it probed; only
                # the rest needs the end-of-walk wave.
                return [*paged, *rest][:CLOSURE_FRONTIER_PROBE_CAP]

            probe_up = [u for u in _probe_slice(candidates_up, "up") if u not in st.degrees]
            probe_down = [u for u in _probe_slice(candidates_down, "down") if u not in st.degrees]
            degrees: Dict[str, Dict[str, int]] = {}
            if (probe_up or probe_down):
                if (deadline - time.monotonic()) < 1.5:
                    # Not enough budget for the probe wave. The frontier still
                    # ships — unknown counts, not invented ones.
                    probe_up, probe_down = [], []
                else:
                    try:
                        degrees = await self.get_node_degrees(
                            list(dict.fromkeys([*probe_up, *probe_down])), ltypes,
                        )
                    except Exception as exc:
                        logger.warning("trace_closure: frontier probe failed: %s", exc)

            shown_in: Dict[str, int] = defaultdict(int)
            shown_out: Dict[str, int] = defaultdict(int)
            for edge in edges_by_id.values():
                shown_out[edge.source_urn] += 1
                shown_in[edge.target_urn] += 1

            def _frontier(
                candidates: List[str], probed: Set[str], key: str, side: str,
                shown: Dict[str, int], cut: Dict[str, None],
            ) -> List[TraceFrontierNode]:
                out: List[TraceFrontierNode] = []
                for u in candidates:
                    if u in st.degrees:
                        total: Optional[int] = st.degrees[u][0 if key == "in" else 1]
                    elif u in probed:
                        total = (degrees.get(u) or {}).get(key)
                    else:
                        total = None
                    reason = "cut" if u in cut else "depth"
                    cursor = st.paged.get((u, side))
                    if cursor is not None:
                        # A paged hub always ships — the cursor, not the count,
                        # is the affordance.
                        out.append(TraceFrontierNode(
                            urn=u, totalCount=total, nextCursor=cursor, reason=reason,
                        ))
                        continue
                    if total is None:
                        # Unprobed, probe failed, or the degree bucket failed —
                        # absence is UNKNOWN, never zero.
                        out.append(TraceFrontierNode(urn=u, reason=reason))
                    elif total > shown.get(u, 0):
                        out.append(TraceFrontierNode(urn=u, totalCount=total, reason=reason))
                    # else: everything this node has is already on screen.
                return out

            frontier_up = _frontier(candidates_up, set(probe_up), "in", "up", shown_in, cut_up)
            frontier_down = _frontier(candidates_down, set(probe_down), "out", "down", shown_out, cut_down)

        # Hydrate participant nodes, then their containment ancestor chains, so
        # the canvas can nest the closure. Guarded: on failure surface a
        # truncated-200 with the reason rather than dropping the lineage.
        nodes_by_urn: Dict[str, GraphNode] = {}
        try:
            hydrated = await self.get_nodes_batch(list(discovered))
            nodes_by_urn = {n.urn: n for n in hydrated if n}
        except Exception:
            st.reasons.append("nodes_failed")
        missing = [u for u in discovered if u not in nodes_by_urn]
        if missing:
            # HYDRATION HONESTY: a node the walk discovered but the provider
            # did not return is a failed page, not a smaller one — and an
            # edge into it would draw into nothing, so the edge goes too.
            st.reasons.append("nodes_failed")
            keep = set(nodes_by_urn) | excluded | {urn}
            edges_by_id = {
                eid: e for eid, e in edges_by_id.items()
                if e.source_urn in keep and e.target_urn in keep
            }

        # CONTAINMENT ALWAYS SHIPS (2026-08-21): this step used to short-
        # circuit into `ancestors_failed` whenever the walk had spent the
        # request deadline down to its last 2s — a BUDGET verdict dressed up
        # as a provider failure. At scale the walk ALWAYS spends that budget,
        # so the closure shipped its participants with containmentEdges=[]:
        # the canvas received thousands of rootless entities, nested nothing
        # and drew no chevrons. The step now always runs — the pair-fetch is
        # chunked with its own per-chunk timeout and synthesizes edges from
        # the ancestor chains when a chunk fails, so the chain is never
        # silently empty. `ancestors_failed` now means what it says: the
        # provider actually failed.
        containment_edges_list: List[GraphEdge] = []
        if ctypes and nodes_by_urn:
            try:
                chains = await self._compute_and_store_ancestors_bulk(
                    list(nodes_by_urn.keys()),
                )
                seen_anc: Set[str] = set()
                ancestor_urns: List[str] = []
                for chain in chains.values():
                    for ancestor in chain or []:
                        if ancestor and ancestor not in seen_anc:
                            seen_anc.add(ancestor)
                            ancestor_urns.append(ancestor)
                new_ancestors = [u for u in ancestor_urns if u not in nodes_by_urn]
                if new_ancestors:
                    ancestor_nodes = await self.get_nodes_batch(new_ancestors)
                    for n in ancestor_nodes:
                        if n:
                            nodes_by_urn[n.urn] = n
                if len(nodes_by_urn) > 1:
                    containment_edges_list = await self._fetch_containment_edges(
                        list(nodes_by_urn.keys()), ctypes, chains=chains,
                        labels={u: str(n.entity_type) for u, n in nodes_by_urn.items() if n.entity_type},
                    )
            except Exception:
                st.reasons.append("ancestors_failed")

        # The most severe reason wins: a FAILURE outranks a budget cut, so a
        # page that is both is never cached as a complete-by-contract page.
        truncation_reason: Optional[str] = None
        for candidate in ("timeout", "seed_failed", "nodes_failed", "ancestors_failed"):
            if candidate in st.reasons:
                truncation_reason = candidate
                break
        if truncation_reason is None and ("max_nodes" in st.reasons or seed_truncated):
            truncation_reason = "max_nodes"

        return TraceClosureResult(
            nodes=list(nodes_by_urn.values()),
            edges=list(edges_by_id.values()),
            containmentEdges=containment_edges_list,
            upstreamUrns=upstream_urns,
            downstreamUrns=downstream_urns,
            focus=TraceFocus(
                urn=urn,
                level=focus_level if focus_level is not None else 0,
                entityType=focus_entity_type,
            ),
            effectiveLevel=focus_level if focus_level is not None else 0,
            isInherited=False,
            inheritedFromUrn=None,
            truncated=(truncation_reason is not None),
            truncationReason=truncation_reason,
            frontierUp=frontier_up,
            frontierDown=frontier_down,
            seedTruncated=seed_truncated,
            seedCursor=(f"s:{next_seed_after}" if next_seed_after else None),
        )

    async def trace_closure_coarse(
        self,
        urn: str,
        direction: str,
        aggregated_edge_type: str,
        containment_edge_types: List[str],
        max_cells: int,
        timeout_ms: int,
    ) -> TraceClosureResult:
        """The COARSE first paint (Part G, 2026-08-21): every ``:AGGREGATED``
        rollup cell INCIDENT to the focus, both directions, one shot.

        A cell is "which container feeds / consumes this one, and how many
        flows" — the picture the browse canvas reads, answered from an
        index seek in milliseconds. The fine walk (``trace_closure``) takes
        seconds on a wide table because it enumerates and hydrates the
        table's own columns; this ships the partner containers first so
        the board has a picture while the raw pages land behind it.

        What it deliberately does NOT do: filter by depth or label (every
        incident cell ships — which endpoints are cards is the client's
        inner-first accounting, so a ``Node ⊃ Node ⊃ Node`` estate with
        partners at different depths needs no special case here), walk
        past hop 1 (rollup transitivity is not leaf transitivity), or
        claim to be the truth (cells are derived and can lag; raw evidence
        replaces them pair by pair on the client).

        Honesty is the fine walk's: a failed read is ``timeout`` (never an
        unflagged empty page), a partner that does not hydrate drops its
        cell and files ``nodes_failed``, the ancestor chain and containment
        always ship (the ``TraceResult`` invariant), and a page cut at
        ``max_cells`` says ``max_nodes`` with the heaviest cells kept.
        """
        await self._ensure_connected()
        deadline = time.monotonic() + max(0.6, timeout_ms / 1000.0)
        reasons: List[str] = []

        focus_node = await self.get_node(urn)
        focus_level = self._get_node_level(focus_node.entity_type) if focus_node else None
        focus_entity_type = str(focus_node.entity_type) if focus_node else "unknown"
        focus_label = (await self._get_cached_label(urn)) or (focus_entity_type if focus_node else "")
        anchor = f"(f:{_sanitize_label(focus_label)} {{urn: $urn}})" if focus_label else "(f {urn: $urn})"

        agg_types = self._alias_rel_types([aggregated_edge_type]) or [aggregated_edge_type]
        agg = _sanitize_label(agg_types[0])
        ctypes = self._alias_rel_types(list(containment_edge_types or []))
        cap = max(1, int(max_cells))

        # One query per direction, heaviest first, one row past the cap so a
        # cut is known rather than inferred. The arrow is in the pattern
        # text (``-[r:…]->`` / ``<-[r:…]-``) — the shape the tests fake.
        def _query(incoming: bool) -> str:
            pattern = f"{anchor}<-[r:{agg}]-(p)" if incoming else f"{anchor}-[r:{agg}]->(p)"
            return (
                f"MATCH {pattern} "
                "RETURN p.urn AS partner, labels(p)[0] AS label, coalesce(r.weight, 0) AS weight, "
                "r.sourceDepth AS sd, r.targetDepth AS td, r.latestUpdate AS lu, r.sourceEdgeTypes AS types "
                "ORDER BY weight DESC, partner LIMIT $cap"
            )

        edges_by_id: Dict[str, GraphEdge] = {}
        upstream_urns: Set[str] = set()
        downstream_urns: Set[str] = set()
        partners: Set[str] = set()
        for incoming in (True, False):
            if incoming and direction == "downstream":
                continue
            if not incoming and direction == "upstream":
                continue
            remaining = deadline - time.monotonic()
            try:
                res = await self._ro_query(
                    _query(incoming),
                    {"urn": urn, "cap": cap + 1},
                    timeout=max(0.6, min(CLOSURE_QUERY_CAP_SECS, remaining)),
                    op="trace.closure_coarse",
                )
                rows = list(res.result_set or [])
            except Exception:
                reasons.append("timeout")
                continue
            if len(rows) > cap:
                rows = rows[:cap]
                reasons.append("max_nodes")
            for row in rows:
                partner, _label, weight, sd, td, lu, types = (list(row) + [None] * 7)[:7]
                if not partner or partner == urn:
                    continue
                src, tgt = (partner, urn) if incoming else (urn, partner)
                eid = f"agg:{src}>{tgt}"
                edges_by_id[eid] = GraphEdge(
                    id=eid,
                    sourceUrn=src,
                    targetUrn=tgt,
                    edgeType=agg_types[0],
                    properties={
                        "weight": weight if isinstance(weight, (int, float)) else 0,
                        "sourceDepth": sd,
                        "targetDepth": td,
                        "latestUpdate": lu,
                        "sourceEdgeTypes": list(types) if isinstance(types, (list, tuple)) else [],
                    },
                )
                partners.add(partner)
                (upstream_urns if incoming else downstream_urns).add(partner)

        # ── the fine walk's own tail: hydrate, honesty, chains, containment ──
        discovered = {urn, *partners}
        nodes_by_urn: Dict[str, GraphNode] = {}
        try:
            hydrated = await self.get_nodes_batch(list(discovered))
            nodes_by_urn = {n.urn: n for n in hydrated if n}
        except Exception:
            reasons.append("nodes_failed")
        if focus_node and urn not in nodes_by_urn:
            nodes_by_urn[urn] = focus_node
        missing = [u for u in discovered if u not in nodes_by_urn]
        if missing:
            reasons.append("nodes_failed")
            keep = set(nodes_by_urn)
            edges_by_id = {
                eid: e for eid, e in edges_by_id.items()
                if e.source_urn in keep and e.target_urn in keep
            }
            upstream_urns &= keep
            downstream_urns &= keep

        containment_edges_list: List[GraphEdge] = []
        if ctypes and nodes_by_urn:
            try:
                chains = await self._compute_and_store_ancestors_bulk(list(nodes_by_urn.keys()))
                seen_anc: Set[str] = set()
                ancestor_urns: List[str] = []
                for chain in chains.values():
                    for ancestor in chain or []:
                        if ancestor and ancestor not in seen_anc:
                            seen_anc.add(ancestor)
                            ancestor_urns.append(ancestor)
                new_ancestors = [u for u in ancestor_urns if u not in nodes_by_urn]
                if new_ancestors:
                    for n in await self.get_nodes_batch(new_ancestors):
                        if n:
                            nodes_by_urn[n.urn] = n
                if len(nodes_by_urn) > 1:
                    containment_edges_list = await self._fetch_containment_edges(
                        list(nodes_by_urn.keys()), ctypes, chains=chains,
                        labels={u: str(n.entity_type) for u, n in nodes_by_urn.items() if n.entity_type},
                    )
            except Exception:
                reasons.append("ancestors_failed")

        truncation_reason: Optional[str] = None
        for candidate in ("timeout", "nodes_failed", "ancestors_failed", "max_nodes"):
            if candidate in reasons:
                truncation_reason = candidate
                break

        return TraceClosureResult(
            nodes=list(nodes_by_urn.values()),
            edges=list(edges_by_id.values()),
            containmentEdges=containment_edges_list,
            upstreamUrns=upstream_urns,
            downstreamUrns=downstream_urns,
            focus=TraceFocus(
                urn=urn,
                level=focus_level if focus_level is not None else 0,
                entityType=focus_entity_type,
            ),
            effectiveLevel=focus_level if focus_level is not None else 0,
            isInherited=False,
            inheritedFromUrn=None,
            truncated=(truncation_reason is not None),
            truncationReason=truncation_reason,
            frontierUp=[],
            frontierDown=[],
            seedTruncated=False,
            seedCursor=None,
        )

    async def expand_aggregated(
        self,
        source_urn: str,
        target_urn: str,
        next_level: Optional[int],
        lineage_edge_types: List[str],
        containment_edge_types: List[str],
        max_nodes: int,
        timeout_ms: int,
        use_raw_edges: bool = False,
        include_containment_edges: bool = False,
        drill_anchor: Optional[str] = None,
    ) -> TraceResult:
        await self._ensure_connected()
        deadline = time.monotonic() + (timeout_ms / 1000.0)
        ctypes = [t.upper() for t in (containment_edge_types or [])]
        ltypes = [t.upper() for t in (lineage_edge_types or [])] if lineage_edge_types else None
        # Per-source alignment (Task E): translate the uppercased declared types to THIS
        # graph's observed spellings so the case-sensitive :TYPE / type(r) IN patterns below
        # match a differently-cased graph. Identity for governed/canonical graphs.
        ctypes = self._alias_rel_types(ctypes)
        ltypes = self._alias_rel_types(ltypes) if ltypes else ltypes

        # STRUCTURAL dispatch: when the expanded edge carries containment
        # depth stamps, the drill is one containment step below the pair —
        # each anchor's direct children, label-agnostic (self-nesting
        # ontologies drill at every depth; the caller's type-level
        # ``use_raw`` heuristic is ignored because it misclassifies on
        # degenerate level maps — the agg-first + empty→raw fallback in
        # _edges_between_sets already covers the finest grain). Edges
        # without stamps (pre-depth generations) keep the legacy
        # type-level descent.
        structural = False
        if ctypes:
            structural = (
                await self._edge_depth_stamps(source_urn, target_urn)
            ) is not None
        # No level to descend to is itself a request for the structural
        # drill. A caller that cannot name a level is not confused — a
        # type appearing at two containment depths (``Container`` inside
        # ``Container``) has no single ``hierarchy.level``, so there is
        # no number it could honestly send.
        if next_level is None:
            structural = True

        # Which anchor is being OPENED. Only that side descends; the
        # other contributes itself and everything beneath it.
        #
        # Stepping both sides in lockstep is why opening a Data Domain
        # against a Table five levels below returned nothing: the level
        # path filtered the Table side to types at the domain's next
        # level (it has none), and the structural path walked the Table
        # down to its columns. Either way the two sets could never meet,
        # and the caller was told "nothing here connects" about lineage
        # that plainly exists. The partner is the question, not another
        # thing to descend.
        if drill_anchor is not None and drill_anchor not in (source_urn, target_urn):
            drill_anchor = None

        # Single-query pair fetch: source + target descendants in one
        # UNION'd Cypher round-trip. Saves one planner pass and frees a
        # pool slot for the duration. Surfaces the (now-single) failure
        # mode via truncationReason rather than aborting the expand.
        truncation_reason: Optional[str] = None
        try:
            if structural:
                s_urns, t_urns = await self._collect_children_pair(
                    source_urn, target_urn, ctypes, max_nodes,
                    drill_anchor=drill_anchor,
                )
            else:
                s_urns, t_urns = await self._collect_descendants_pair_at_level(
                    source_urn, target_urn, next_level, ctypes, max_nodes,
                    drill_anchor=drill_anchor,
                )
        except Exception:
            s_urns, t_urns = [], []
            truncation_reason = "descendants_failed"

        if time.monotonic() > deadline:
            truncation_reason = truncation_reason or "timeout"

        # Step 3: edges between the two URN sets — set membership, not Cartesian
        edges: List[GraphEdge] = []
        node_urns_in_edges: Set[str] = set()
        if s_urns and t_urns and not truncation_reason:
            edges = await self._edges_between_sets(
                s_urns, t_urns, next_level, ltypes,
                use_raw=use_raw_edges and not structural, limit=max_nodes,
            )
            for e in edges:
                node_urns_in_edges.add(e.source_urn)
                node_urns_in_edges.add(e.target_urn)

        # Hydrate nodes for every URN that appears in the result
        all_urns = (set(s_urns) | set(t_urns)) & node_urns_in_edges if edges else (set(s_urns) | set(t_urns))
        # Cap to max_nodes — favour nodes that participate in edges
        if len(all_urns) > max_nodes:
            in_edges = list(node_urns_in_edges)[:max_nodes]
            all_urns = set(in_edges)
            truncation_reason = truncation_reason or "max_nodes"

        nodes = await self.get_nodes_batch(list(all_urns)) if all_urns else []
        nodes_by_urn = {n.urn: n for n in nodes if n}

        # Always hydrate containment ancestors + edges so the drilled-into
        # nodes can be positioned in the canvas hierarchy. See trace_at_level
        # for the rationale — the `include_containment_edges` flag is
        # intentionally ignored because hierarchy context is non-optional.
        containment_edges_list: List[GraphEdge] = []
        if ctypes and nodes_by_urn:
            try:
                ancestor_urns = await self._collect_ancestor_urns(
                    list(nodes_by_urn.keys()), ctypes,
                )
            except Exception:
                ancestor_urns = []
                truncation_reason = truncation_reason or "ancestors_failed"
            new_ancestors = [u for u in ancestor_urns if u not in nodes_by_urn]
            if new_ancestors:
                ancestor_nodes = await self.get_nodes_batch(new_ancestors)
                for n in ancestor_nodes:
                    if n:
                        nodes_by_urn[n.urn] = n
            if len(nodes_by_urn) > 1:
                containment_edges_list = await self._fetch_containment_edges(
                    list(nodes_by_urn.keys()), ctypes,
                )

        # Focus node for response — use the source anchor of the drill
        anchor_node = nodes_by_urn.get(source_urn)
        if anchor_node is None:
            anchor_node = await self.get_node(source_urn)
        focus_level_actual = (
            self._get_node_level(anchor_node.entity_type) if anchor_node else next_level
        )
        # The response model wants a concrete level. A structural drill
        # has none to report — the caller could not name one, which is
        # the whole reason it asked structurally — so fall back to the
        # anchor's own resolved level and finally to 0 rather than
        # failing validation on a `None` nobody asked to be meaningful.
        reported_level = focus_level_actual if focus_level_actual is not None else next_level
        if reported_level is None:
            reported_level = 0

        return TraceResult(
            nodes=list(nodes_by_urn.values()),
            edges=edges,
            containmentEdges=containment_edges_list,
            upstreamUrns=set(),
            downstreamUrns=set(),
            focus=TraceFocus(
                urn=source_urn,
                level=reported_level,
                entityType=str(anchor_node.entity_type) if anchor_node else "unknown",
            ),
            effectiveLevel=next_level if next_level is not None else reported_level,
            isInherited=False,
            inheritedFromUrn=None,
            truncated=(truncation_reason is not None),
            truncationReason=truncation_reason,
        )

    # ---- trace v2 helpers ---------------------------------------------------

    async def _resolve_anchor_at_level(
        self, urn: str, level: int, ctypes: List[str],
    ) -> str:
        """Walk UP containment from ``urn`` to find the nearest ancestor whose
        entity type sits at ``level``. Returns ``urn`` itself when it's already
        at the target level or no qualifying ancestor exists.

        Cache-first: reads the ancestor chain from the Redis cache populated
        by aggregation (:func:`_get_ancestor_chain`) and resolves each
        ancestor's level via the in-process entity-type → level map. The
        URN → label cache (:func:`_get_cached_label`) typically already
        holds labels for chain URNs as a side effect of materialization /
        prior :func:`get_node` calls; any gaps are filled with a single
        batch ``WHERE n.urn IN $urns RETURN n.urn, labels(n)[0]`` round-
        trip (no variable-length walk, no path sort).

        Falls back to the legacy variable-length Cypher only when the
        cache produces no chain AND the focus is not already at the
        requested level — preserves correctness on cold graphs while the
        common case becomes a Redis HGET + a small Python loop.
        """
        if not ctypes:
            return urn
        entity_levels: Dict[str, int] = getattr(self, "_entity_type_levels", None) or {}

        # Step 1: is the focus itself at the target level?
        focus_label = await self._get_cached_label(urn)
        if focus_label and entity_levels.get(focus_label) == level:
            return urn

        # Step 2: walk the cached ancestor chain.
        try:
            chain = await self._get_ancestor_chain(urn)
        except Exception:
            chain = []

        if chain and entity_levels:
            # Resolve labels for chain URNs (cache + one batch top-up).
            labels: Dict[str, Optional[str]] = {}
            missing: List[str] = []
            for u in chain:
                cached = await self._get_cached_label(u)
                labels[u] = cached
                if not cached:
                    missing.append(u)
            if missing:
                try:
                    # _resolve_urn_labels_bulk bootstraps cache misses via
                    # per-observed-label index seeks (never an unlabeled
                    # full scan) and writes the cache back itself.
                    resolved_labels = await self._resolve_urn_labels_bulk(missing)
                    for u, lbl in resolved_labels.items():
                        if lbl:
                            labels[u] = lbl
                except Exception as exc:
                    logger.warning(
                        "trace_at_level: anchor label batch fetch failed: %s", exc,
                    )

            for ancestor_urn in chain:
                lbl = labels.get(ancestor_urn)
                if lbl and entity_levels.get(lbl) == level:
                    return ancestor_urn
            # Chain authoritatively walked to root without a match.
            return urn

        # Step 3: cold-cache fallback. Bound the variable-length walk by
        # max-known hierarchy depth (or 10 when the level map is empty)
        # and cap the Cypher with a tight ``:timeout`` so a slow planner
        # cannot consume the trace deadline here.
        types = self._types_at_level(level)
        if not types:
            return urn
        max_depth = max(len(entity_levels), 10) if entity_levels else 10
        # NB: path-uniqueness predicate was attempted here but removed —
        # FalkorDB's planner doesn't always accept nested list-comprehension
        # `size(...)` inside path-bound ALL(), and the legacy form was
        # already cycle-safe via bounded max_depth + try/except. Cycle
        # protection for the new skeleton-first path lives in
        # _resolve_root_anchor (which itself falls back on failure).
        anchor_label = await self._get_cached_label(urn)
        f_anchor = (
            f"(focus:{_sanitize_label(anchor_label)} {{urn: $urn}})"
            if anchor_label else "(focus {urn: $urn})"
        )
        c_alt = "|".join(_sanitize_label(t) for t in ctypes if t)
        cypher = (
            f"MATCH {f_anchor} "
            f"OPTIONAL MATCH path = (focus)<-[c:{c_alt}*0..{max_depth}]-(anc) "
            "WHERE labels(anc)[0] IN $types "
            "RETURN coalesce(anc.urn, focus.urn) AS anchorUrn "
            "ORDER BY length(path) ASC LIMIT 1"
        )
        try:
            result = await self._ro_query(
                cypher, params={"urn": urn, "types": types},
                timeout=1.5, op="trace.anchor_at_level",
            )
            rows = result.result_set or []
            if rows and rows[0]:
                return rows[0][0] or urn
        except Exception as exc:
            logger.warning("trace_at_level: anchor resolution fallback failed for %s: %s", urn, exc)
        return urn

    async def _has_aggregated_at_level(
        self, anchor_urn: str, level: int, ltypes: Optional[List[str]] = None,
    ) -> bool:
        """True iff the anchor has AT LEAST ONE lineage edge to a peer at
        the given level. Counts both AGGREGATED rollups AND raw lineage edges
        of any type listed in ``ltypes`` — without this, fine-grained focuses
        whose lineage is expressed as TRANSFORMS / FLOWS_TO / etc. would be
        misclassified as "no lineage", triggering the inherited-lineage
        fallback to climb to a coarser ancestor.
        """
        types = self._types_at_level(level)
        if not types:
            # If we can't tell which entity types belong to this level, assume
            # the focus has direct lineage so the inherited-lineage fallback
            # doesn't fire — that fallback only makes sense with type info.
            return True

        # Relationship types as a pattern ALTERNATION (AGGREGATED plus any
        # raw lineage types) so the existence probe never expands other
        # edge classes on hub anchors; the anchor itself is label-qualified
        # via the urn→label cache (urn-index seek, not an All-Node-Scan).
        rel_parts: List[str] = ["AGGREGATED"]
        if ltypes:
            rel_parts.extend(_sanitize_label(t) for t in ltypes if t)
        rel_alt = "|".join(dict.fromkeys(rel_parts))
        a_label = await self._get_cached_label(anchor_urn)
        a_anchor = (
            f"(a:{_sanitize_label(a_label)} {{urn: $anchor}})"
            if a_label else "(a {urn: $anchor})"
        )

        cypher = (
            f"MATCH {a_anchor}-[r:{rel_alt}]-(peer) "
            "WHERE labels(peer)[0] IN $types "
            "RETURN 1 LIMIT 1"
        )
        params: Dict[str, Any] = {"anchor": anchor_urn, "types": types}
        try:
            # Tight ``:timeout`` — this is an existence check on the
            # trace hot path; if FalkorDB can't decide in ~1s the
            # planner is doing something wrong and we'd rather
            # fail-open (skip the inherited-lineage fallback) than
            # block the whole trace.
            result = await self._proj_ro_query(cypher, params=params, timeout=1.0, op="trace.has_lineage")
            return bool(result.result_set)
        except Exception as exc:
            logger.warning("trace_at_level: has-lineage check failed for %s: %s", anchor_urn, exc)
            return True  # fail-open: skip the inherited-lineage fallback

    async def _find_ancestor_with_lineage(
        self, anchor_urn: str, level: int, ctypes: List[str],
        ltypes: Optional[List[str]] = None,
    ) -> Optional[str]:
        """Find the nearest ancestor of ``anchor_urn`` that (a) is at the
        target ``level`` and (b) has at least one lineage edge there.

        Folds the previous "fetch 5 candidates + 1-5 ``_has_aggregated_at_level``
        round-trips" pattern into a single Cypher: the inner pattern
        predicate ``(parent)-[:AGGREGATED|...]-()`` filters candidates by
        edge existence directly in the planner, returning only the
        nearest ancestor that qualifies.

        The pattern predicate doesn't constrain the peer's level — a node
        that has AGGREGATED edges is overwhelmingly to peers at the same
        level (the materialiser pairs ancestors level-for-level), and a
        false positive just means the subsequent BFS finds an empty set
        for that anchor, which is cheaper than 5 extra existence
        checks per trace.
        """
        if not ctypes:
            return None
        types = self._types_at_level(level)
        if not types:
            return None

        # Relationship-type alternation: AGGREGATED rollup plus any raw
        # lineage types the caller declared. Sanitized to keep the
        # dynamic pattern injection-safe.
        rel_parts: List[str] = ["AGGREGATED"]
        if ltypes:
            rel_parts.extend(_sanitize_label(t) for t in ltypes)
        rel_alt = "|".join(rel_parts)

        max_depth = max(len(getattr(self, "_entity_type_levels", {}) or {}), 10)

        # NB: path-uniqueness predicate removed — legacy form, bounded by
        # max_depth + try/except. See note in _resolve_anchor_at_level.
        # Anchor label-qualified (urn-index seek) and containment walk
        # expressed as a typed alternation so non-containment edges are
        # never expanded.
        c_alt = "|".join(_sanitize_label(t) for t in ctypes if t)
        a_label = await self._get_cached_label(anchor_urn)
        a_anchor = (
            f"(a:{_sanitize_label(a_label)} {{urn: $anchor}})"
            if a_label else "(a {urn: $anchor})"
        )
        cypher = (
            f"MATCH {a_anchor}"
            f"<-[c:{c_alt}*1..{max_depth}]-(parent) "
            "WHERE labels(parent)[0] IN $types "
            "WITH parent, length(c) AS depth "
            "ORDER BY depth ASC LIMIT 5 "
            f"WITH parent, depth WHERE (parent)-[:{rel_alt}]-() "
            "RETURN parent.urn AS urn "
            "ORDER BY depth ASC LIMIT 1"
        )
        params = {"anchor": anchor_urn, "types": types}
        try:
            result = await self._ro_query(cypher, params=params, timeout=1.5, op="trace.ancestor_with_lineage")
            rows = result.result_set or []
            if rows and rows[0] and rows[0][0]:
                return rows[0][0]
        except Exception as exc:
            logger.warning(
                "trace_at_level: find-ancestor-with-lineage failed for %s: %s",
                anchor_urn, exc,
            )
        return None

    async def _expand_aggregated_set(
        self,
        frontier: List[str],
        frontier_labels: Dict[str, str],
        direction: str,
        level: int,
        ltypes: Optional[List[str]],
        limit: int,
        timeout_secs: float,
        default_peer_label: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """Per-hop expansion. Direction: 'incoming' (BFS upstream) or 'outgoing'
        (BFS downstream). Returns a list of dicts shaped for the BFS loop:
        {sourceUrn, targetUrn, edgeId, edgeType, edgeTypes, weight, node}.

        ``frontier_labels`` maps each URN to its entity-type label so each
        per-label sub-query can use the per-label ``(:Label).urn`` index for
        an index-seek instead of a full-graph property scan. URNs without a
        known label fall back to a label-less pattern (still correct, just
        slower).

        ``default_peer_label`` is the focus's sanitized entity-type label,
        used as the neighbour filter when no level-set and no per-bucket
        label can constrain the expansion. Without this, the query would
        walk to ANY neighbour and a Layer-focused trace would over-fetch
        into Attribute children (the original layered-lineage bug). Pass the
        focus's entity_type so peer-rollup always has a fallback.

        Sub-queries per label bucket per direction:

        * AGGREGATED rollup — rel-typed pattern ``[r:AGGREGATED]`` filtered
          by ``r.sourceLevel`` / ``r.targetLevel`` (the level-pair fast
          path stamped by the materialiser + backfilled by
          ``backfill_aggregated_levels.py``). When the level map is
          missing or the AGGREGATED edge-property index hasn't been
          created, falls back to ``labels(other)[0] IN $types`` — the
          legacy neighbour-label scan.
        * Raw lineage — rel-type alternation ``[r:LTYPE1|LTYPE2|...]`` when
          ``ltypes`` is set, so fine-grained traces (schemaField /
          column) still walk TRANSFORMS / FLOWS_TO etc. Raw edges are
          not level-stamped, so this branch keeps the label filter.

        Each sub-query carries a Cypher ``:timeout`` capped at
        ``timeout_secs`` so a single bad sub-query cannot consume the
        whole BFS budget — FalkorDB cancels it server-side and the BFS
        loop logs and moves on with what it already has.
        """
        if not frontier or limit <= 0:
            return []

        types = self._types_at_level(level)
        # When the entity-type level map is available, prefer the
        # level-pair filter on AGGREGATED edges. The materialiser stamps
        # ``r.sourceLevel``/``r.targetLevel`` on new edges; legacy edges
        # are covered by ``backfill_aggregated_levels.py``.
        entity_levels: Dict[str, int] = getattr(self, "_entity_type_levels", None) or {}
        use_level_filter = bool(entity_levels) and level >= 0

        # STRUCTURAL peer rollup: when the stored cells carry containment
        # depth stamps, each frontier node's peers are the cells at ITS
        # OWN depth — `r.sourceDepth = r.targetDepth = depth(f)`. The
        # type-level filter is degenerate on self-nesting ontologies
        # (every container shares one type level, so it mixes every
        # granularity into one wave); depth buckets are exact on any
        # shape. Frontier nodes without a resolvable depth (no stamped
        # incident cell — e.g. leaves in boundary regime) keep the legacy
        # type/label filters.
        depth_by_urn: Dict[str, int] = {}
        try:
            meta = await self._aggregation_run_meta()
            if meta.stamp_version >= 2:
                depth_by_urn = await self._frontier_depths_from_stamps(frontier)
        except Exception as exc:
            logger.debug("frontier depth resolution failed: %s", exc)

        # Group frontier URNs by (entity-type label, stamped depth) so
        # each sub-query uses the per-label ``urn`` index AND the exact
        # depth cell filter. URNs without a known label go into the ""
        # bucket and use a label-less fallback pattern.
        by_label: Dict[Tuple[str, Optional[int]], List[str]] = {}
        for urn in frontier:
            lbl = frontier_labels.get(urn) or ""
            by_label.setdefault((lbl, depth_by_urn.get(urn)), []).append(urn)

        # Direction shapes: ``f`` is the frontier-side variable, ``other`` is
        # the neighbour we're expanding into. Edge orientation in the returned
        # record is always (sourceUrn -> targetUrn).
        if direction == "incoming":
            arrow_template = "<-[r{rel}]-"
            source_var, target_var = "other", "f"
        else:
            arrow_template = "-[r{rel}]->"
            source_var, target_var = "f", "other"

        def _build(rel_clause: str, *, where_parts: List[str], order_by_weight: bool) -> str:
            # WS1.5: Replace ``UNWIND $frontier AS u MATCH (f {urn:u})``
            # with ``MATCH (f) WHERE f.urn IN $frontier`` so the empty-
            # label bucket (URNs whose entity_type wasn't in
            # ``frontier_labels``) doesn't degenerate into N unlabeled
            # node scans. When F_LABEL substitutes to a real label, the
            # ``:Label(urn)`` index still drives the seek via the IN
            # predicate; when F_LABEL is empty, this still pays exactly
            # one scan rather than N.
            extended = ["f.urn IN $frontier"] + where_parts
            where = "WHERE " + " AND ".join(extended) + " "
            # For AGGREGATED edges, ORDER BY r.weight DESC ensures the
            # per-source LIMIT keeps the highest-confidence edges first
            # (top-N by edge count). Without it, a super-hub Domain would
            # truncate arbitrarily. Raw lineage edges don't have weight,
            # so we skip the ORDER BY in that branch.
            order = "ORDER BY weight DESC " if order_by_weight else ""
            return (
                f"MATCH (f{{F_LABEL}}){arrow_template.format(rel=rel_clause)}(other) "
                + where
                + f"WITH {source_var}.urn AS sourceUrn, {target_var}.urn AS targetUrn, "
                "id(r) AS edgeId, type(r) AS edgeType, "
                "COALESCE(r.sourceEdgeTypes, [type(r)]) AS edgeTypes, "
                "COALESCE(r.weight, 1) AS weight, other AS otherNode "
                + order
                + "RETURN sourceUrn, targetUrn, edgeId, edgeType, edgeTypes, weight, otherNode "
                "LIMIT $limit"
            )

        # Per-query timeout. The wrapper subtracts 500ms for the DB-side
        # cancel; clamp the floor at 0.6s so a tight remaining-budget still
        # gives FalkorDB a useful slice (~100ms).
        per_query_timeout = max(0.6, min(1.5, timeout_secs))

        # Sanitize the focus's entity-type once — used as the fallback
        # neighbour filter when a frontier bucket has no per-URN label
        # (because get_node returned None, entity_type wasn't populated,
        # or labels(n)[0] didn't match the upsert convention).
        sanitized_default_peer = (
            _sanitize_label(default_peer_label) if default_peer_label else ""
        )

        queries: List[tuple[str, Dict[str, Any]]] = []
        for (f_label, f_depth), urns in by_label.items():
            sanitized_self_label = _sanitize_label(f_label) if f_label else ""
            label_clause = f":{sanitized_self_label}" if sanitized_self_label else ""

            # Peer-rollup neighbour filter. Order of preference:
            #   1. Per-bucket frontier label (sanitized_self_label)
            #   2. Caller-supplied default (focus entity_type)
            # If NEITHER is set (and no depth bucket constrains the
            # cells), refuse to emit an unconstrained query — the legacy
            # "no filter at all" path is the over-fetch bug that pulled
            # Attributes into a Layer trace.
            effective_peer_label = sanitized_self_label or sanitized_default_peer
            peer_filter_clause: Optional[str] = None
            if effective_peer_label:
                peer_filter_clause = f"labels(other)[0] = '{effective_peer_label}'"
            elif f_depth is None:
                logger.warning(
                    "trace expand: no peer label for bucket=%r and no default — "
                    "skipping sub-query to avoid unconstrained over-fetch",
                    f_label,
                )
                # Skip this bucket entirely. Better to return zero edges
                # than to return every neighbour in the graph.
                continue

            # AGGREGATED branch. The DEPTH-pair filter is the primary
            # when this bucket's frontier depth is stamped (exact on any
            # graph shape); else the type-level fast path; else label
            # scan or peer fallback.
            agg_where: List[str] = []
            if f_depth is not None:
                agg_where.append(
                    "r.sourceDepth = $fDepth AND r.targetDepth = $fDepth"
                )
            elif use_level_filter:
                agg_where.append("r.sourceLevel = $level AND r.targetLevel = $level")
            elif types:
                agg_where.append("labels(other)[0] IN $types")
            elif peer_filter_clause:
                agg_where.append(peer_filter_clause)
            if ltypes:
                agg_where.append(
                    "(r.sourceEdgeTypes IS NULL "
                    "OR any(et IN r.sourceEdgeTypes WHERE et IN $ltypes))"
                )
            agg_cypher = _build(
                ":AGGREGATED", where_parts=agg_where, order_by_weight=True,
            ).replace("{F_LABEL}", label_clause)
            agg_params: Dict[str, Any] = {"frontier": urns, "limit": limit}
            if f_depth is not None:
                agg_params["fDepth"] = f_depth
            elif use_level_filter:
                agg_params["level"] = level
            elif types:
                agg_params["types"] = types
            if ltypes:
                agg_params["ltypes"] = ltypes
            queries.append((agg_cypher, agg_params))

            # Raw-lineage branch (only when ltypes provided). Raw edges
            # don't carry level/depth props, so this branch uses the
            # type-set filter, or peer-label fallback when types is
            # empty; a depth-only bucket with neither constraint skips
            # raw rather than over-fetch.
            if ltypes and (types or peer_filter_clause):
                rel_alt = "|".join(_sanitize_label(t) for t in ltypes)
                raw_where: List[str] = []
                if types:
                    raw_where.append("labels(other)[0] IN $types")
                elif peer_filter_clause:
                    raw_where.append(peer_filter_clause)
                raw_cypher = _build(
                    f":{rel_alt}", where_parts=raw_where, order_by_weight=False,
                ).replace("{F_LABEL}", label_clause)
                raw_params: Dict[str, Any] = {"frontier": urns, "limit": limit}
                if types:
                    raw_params["types"] = types
                queries.append((raw_cypher, raw_params))

        if not queries:
            return []

        async def _run(c: str, p: Dict[str, Any]):
            try:
                return await self._proj_ro_query(
                    c, params=p, timeout=per_query_timeout, op="trace.expand",
                )
            except Exception as exc:
                logger.warning(
                    "trace_at_level: expand sub-query (%s) failed: %s",
                    direction, exc,
                )
                return None

        results = await asyncio.gather(*(_run(c, p) for c, p in queries))

        out: List[Dict[str, Any]] = []
        seen_edge_ids: Set[str] = set()
        for result in results:
            if result is None:
                continue
            for row in (result.result_set or []):
                try:
                    edge_type = str(row[3]) if row[3] is not None else "AGGREGATED"
                    eid = str(row[2]) if row[2] is not None else (
                        f"{edge_type.lower()}-{row[0]}-{row[1]}"
                    )
                    # Dedupe across the AGGREGATED + raw-lineage sub-queries:
                    # a raw lineage edge might also appear in the AGGREGATED
                    # rollup (sourceEdgeTypes contains its type). Keep first.
                    if eid in seen_edge_ids:
                        continue
                    seen_edge_ids.add(eid)
                    rec = {
                        "sourceUrn": row[0],
                        "targetUrn": row[1],
                        "edgeId": eid,
                        "edgeType": edge_type,
                        "edgeTypes": row[4] if isinstance(row[4], list) else (
                            [row[4]] if row[4] else [edge_type]
                        ),
                        "weight": int(row[5]) if row[5] is not None else 1,
                        "node": self._extract_node_from_result([row[6]]) if row[6] is not None else None,
                    }
                    out.append(rec)
                    if len(out) >= limit:
                        return out
                except Exception:
                    continue
        return out
