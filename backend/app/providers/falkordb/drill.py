"""FalkorDB structural-drill helpers and batch node hydration — ``DrillMixin``.

Carved from ``backend/app/providers/falkordb/provider.py``'s
``FalkorDBProvider`` class body as it stood before this split:
``_collect_ancestor_urns`` through ``get_nodes_batch`` (lines 9372-10117),
a single contiguous block.

This mixin holds the trace-at-level "drill" helpers — collecting ancestor
URNs, one-step containment children, and bounded-depth descendant pairs
for a trace's expand/drill actions — plus ``_fetch_containment_edges``
(pair-list-driven containment resolution) and ``get_nodes_batch``, the
bulk URN→node hydration trace v2 and advanced search both call to fill in
a page of results with a live ``childCount``. ``get_nodes_batch`` is
public and stays reachable. See ``docs/superpowers/plans/2026-08-30-pr1-falkordb-decoupling.md`` §2.2 for why this has
to be a mixin rather than a delegate/helper object.
"""
import asyncio
from typing import Any, Dict, List, Optional, Set, Tuple

from backend.app.models.graph import GraphEdge, GraphNode
from backend.app.providers.falkordb._log import logger
from backend.app.providers.falkordb.rowmap import _sanitize_label


class DrillMixin:
    """Structural-drill helpers (ancestor/children/descendant collection,
    containment-edge resolution) and bulk node-batch hydration."""

    async def _collect_ancestor_urns(
        self, urns: List[str], ctypes: List[str],
    ) -> List[str]:
        """Collect ALL containment ancestors of the given URNs.

        Foundational for trace responses: a trace returns lineage URNs at
        whatever level the user picked (e.g. column-level schemaFields), but
        the canvas needs the full ancestor chain (Dataset → Container →
        Domain) to position those URNs in the layered hierarchy. Without
        this, the trace nodes render as orphans or get filtered out by layer
        assignment.

        Reads from the Redis ancestor-chain cache populated by aggregation
        (:func:`_get_ancestor_chain` / :func:`_compute_and_store_ancestors_bulk`).
        On cache miss the bulk helper falls back to a per-URN typed Cypher
        with concurrency 4, then back-fills the cache for future trace
        requests. This replaces the previous single ``UNWIND $urns ...
        <-[c*1..10]-(ancestor)`` query that re-walked containment on every
        trace and was the second-biggest CPU consumer after the BFS itself.

        Raises on hard failure (Redis + Cypher both unavailable) so the
        caller can surface ``truncationReason="ancestors_failed"`` instead
        of silently dropping the containment chain (which produces canvas
        orphans).
        """
        if not urns or not ctypes:
            return []
        try:
            chains = await self._compute_and_store_ancestors_bulk(list(urns))
        except Exception as exc:
            logger.warning(
                "trace_at_level: ancestor collection failed for %d urns: %s",
                len(urns), exc,
            )
            raise

        # ``_compute_and_store_ancestors_bulk`` returns a {urn: chain} map.
        # Flatten + dedupe while preserving first-seen order so any caller
        # that depends on parent-before-grandparent ordering still gets it.
        seen: Set[str] = set()
        out: List[str] = []
        for chain in chains.values():
            for ancestor in chain or []:
                if ancestor and ancestor not in seen:
                    seen.add(ancestor)
                    out.append(ancestor)
        return out

    async def _edge_depth_stamps(
        self, source_urn: str, target_urn: str,
    ) -> Optional[Tuple[int, int]]:
        """The expanded :AGGREGATED edge's own containment-depth stamps
        (sourceDepth, targetDepth), or None when the edge is missing or
        pre-dates the depth-stamp generation — the structural-drill
        dispatch signal."""
        try:
            res = await self._proj_ro_query(
                "MATCH (s)-[r:AGGREGATED]->(t) "
                "WHERE s.urn = $s AND t.urn = $t "
                "AND r.sourceDepth IS NOT NULL AND r.targetDepth IS NOT NULL "
                "RETURN r.sourceDepth, r.targetDepth LIMIT 1",
                params={"s": source_urn, "t": target_urn},
            )
            rows = res.result_set or []
            if rows and rows[0] and rows[0][0] is not None and rows[0][1] is not None:
                return int(rows[0][0]), int(rows[0][1])
        except Exception as exc:
            logger.debug("edge depth-stamp read failed: %s", exc)
        return None

    async def _frontier_depths_from_stamps(
        self, urns: List[str],
    ) -> Dict[str, int]:
        """urn → containment depth, read from any stamped incident
        :AGGREGATED cell (two bounded relation-anchored queries — no
        containment walk). Nodes with no stamped incident cell are
        absent; callers fall back to type/label filters for those."""
        out: Dict[str, int] = {}

        async def _probe(cypher: str, bucket: List[str], key: str) -> list:
            try:
                res = await self._proj_ro_query(
                    cypher, params={"urns": bucket}, op="trace.frontier_depths",
                )
                return res.result_set or []
            except Exception as exc:
                logger.debug("frontier depth-stamp read (%s) failed: %s", key, exc)
                return []

        # Both directions × all label buckets GATHERED — these ran
        # strictly sequentially before (2 round-trips per bucket per hop,
        # each paying full RTT against a remote FalkorDB).
        tasks = []
        for f_label, bucket in await self._label_buckets(urns):
            f_anchor = f"(f:{f_label})" if f_label else "(f)"
            tasks.append(_probe(
                f"MATCH {f_anchor}-[r:AGGREGATED]->() "
                "WHERE f.urn IN $urns AND r.sourceDepth IS NOT NULL "
                "RETURN f.urn, max(r.sourceDepth)", bucket, "out"))
            tasks.append(_probe(
                f"MATCH ()-[r:AGGREGATED]->{f_anchor} "
                "WHERE f.urn IN $urns AND r.targetDepth IS NOT NULL "
                "RETURN f.urn, max(r.targetDepth)", bucket, "in"))
        for rows in await asyncio.gather(*tasks):
            for row in rows:
                if row and row[0] is not None and row[1] is not None:
                    u, d = str(row[0]), int(row[1])
                    if out.get(u, -1) < d:
                        out[u] = d
        return out

    async def _collect_children_pair(
        self,
        source_urn: str,
        target_urn: str,
        ctypes: List[str],
        limit: int,
        drill_anchor: Optional[str] = None,
    ) -> Tuple[List[str], List[str]]:
        """STRUCTURAL drill: DIRECT containment children — one step below
        the expanded pair. Label-agnostic, so self-nesting ontologies
        drill correctly at every depth; on aligned type-structured trees
        the children ARE the next type level, so behavior is unchanged.

        ``drill_anchor`` names the side being OPENED. Only it descends;
        the other contributes itself plus its whole subtree, so anchors
        at very different depths can still meet. Without it both sides
        advance from their own depth (ragged pairs included), which is
        the historical behaviour and correct only for a pair that was
        already aligned.

        Either way a childless side falls back to the anchor itself."""
        if drill_anchor is not None:
            partner = target_urn if drill_anchor == source_urn else source_urn
            depth = max(len(getattr(self, "_entity_type_levels", {}) or {}), 10)
            cypher = (
                # The opened side — one containment step down.
                "MATCH (a {urn: $drill})-[c]->(child) "
                "WHERE type(c) IN $ctypes "
                "WITH DISTINCT child.urn AS urn "
                "LIMIT $limit "
                "RETURN 'd' AS side, collect(urn) AS urns "
                "UNION "
                # The partner — itself...
                "MATCH (b {urn: $partner}) "
                "RETURN 'p' AS side, [b.urn] AS urns "
                "UNION "
                # ...and everything beneath it, at any depth.
                f"MATCH (b {{urn: $partner}})-[c*1..{depth}]->(sub) "
                "WHERE ALL(rel IN c WHERE type(rel) IN $ctypes) "
                "WITH DISTINCT sub.urn AS urn "
                "LIMIT $limit "
                "RETURN 'p' AS side, collect(urn) AS urns"
            )
            result = await self._ro_query(
                cypher,
                params={"drill": drill_anchor, "partner": partner,
                        "ctypes": ctypes, "limit": limit},
                op="trace.children_drill",
                timeout=2.0,
            )
            drilled: List[str] = []
            partner_side: List[str] = []
            for row in (result.result_set or []):
                if not row or len(row) < 2:
                    continue
                urns = [u for u in (row[1] if isinstance(row[1], list) else []) if u]
                if row[0] == 'd':
                    drilled.extend(urns)
                elif row[0] == 'p':
                    partner_side.extend(urns)
            drilled = list(dict.fromkeys(drilled)) or [drill_anchor]
            partner_side = list(dict.fromkeys(partner_side)) or [partner]
            return (drilled, partner_side) if drill_anchor == source_urn else (partner_side, drilled)

        cypher = (
            "MATCH (a {urn: $source})-[c]->(child) "
            "WHERE type(c) IN $ctypes "
            "WITH DISTINCT child.urn AS urn "
            "LIMIT $limit "
            "RETURN 's' AS side, collect(urn) AS urns "
            "UNION "
            "MATCH (b {urn: $target})-[c]->(child) "
            "WHERE type(c) IN $ctypes "
            "WITH DISTINCT child.urn AS urn "
            "LIMIT $limit "
            "RETURN 't' AS side, collect(urn) AS urns"
        )
        result = await self._ro_query(
            cypher,
            params={"source": source_urn, "target": target_urn,
                    "ctypes": ctypes, "limit": limit},
            op="trace.children_pair",
            timeout=2.0,
        )
        s_urns: List[str] = []
        t_urns: List[str] = []
        for row in (result.result_set or []):
            if not row or len(row) < 2:
                continue
            urns = [u for u in (row[1] if isinstance(row[1], list) else []) if u]
            if row[0] == 's':
                s_urns.extend(urns)
            elif row[0] == 't':
                t_urns.extend(urns)
        return (
            list(dict.fromkeys(s_urns)) or [source_urn],
            list(dict.fromkeys(t_urns)) or [target_urn],
        )

    async def _collect_descendants_pair_at_level(
        self,
        source_urn: str,
        target_urn: str,
        target_level: int,
        ctypes: List[str],
        limit: int,
        drill_anchor: Optional[str] = None,
    ) -> Tuple[List[str], List[str]]:
        """Collect descendants of both anchors in a SINGLE Cypher round-trip.

        LEGACY (type-level) path — used only when the expanded edge has
        no depth stamps (``expand_aggregated`` dispatches stamped edges
        to ``_collect_children_pair`` instead). Bounded depth-10
        containment descent; per-anchor row LIMIT applied before
        ``collect()`` so the slice form (which previously tripped
        FalkorDB's "expected List or Null but was Edge" planner error) is
        never used.

        Returns ``(source_urns, target_urns)``. Either side may be empty if
        the anchor's label does not match ``target_level``'s type set.
        """
        # ``drill_anchor`` names the side being OPENED. Only it is
        # level-filtered; the partner contributes itself and its whole
        # subtree. Level-filtering BOTH is what empties the partner side
        # whenever it sits finer than the level asked for — a Table has
        # no descendants at a Domain's next level, so ``t_urns`` came
        # back empty and the expand reported "nothing connects" about
        # lineage that exists.
        if drill_anchor is not None:
            return await self._collect_level_and_subtree(
                drill_anchor,
                target_urn if drill_anchor == source_urn else source_urn,
                target_level, ctypes, limit,
                drilled_is_source=drill_anchor == source_urn,
            )
        types = self._types_at_level(target_level)
        if not types:
            # Nothing declared at that level. Returning empty here made
            # the expand report "nothing connects" about a level the
            # ONTOLOGY could not describe — a statement about our type
            # map, dressed up as a statement about the data. Each anchor
            # stands for itself instead, so the edge query still runs.
            return [source_urn], [target_urn]

        if not ctypes:
            # Empty containment — descendants of each anchor reduce to
            # the anchor itself, but only if its label matches.
            cypher = (
                "MATCH (a {urn: $source}) WHERE labels(a)[0] IN $types "
                "RETURN 's' AS side, [a.urn] AS urns "
                "UNION "
                "MATCH (b {urn: $target}) WHERE labels(b)[0] IN $types "
                "RETURN 't' AS side, [b.urn] AS urns"
            )
            params: Dict[str, Any] = {
                "source": source_urn, "target": target_urn, "types": types,
            }
        else:
            # UNION over per-anchor branches — same `WITH DISTINCT … LIMIT`
            # streaming pattern as the single-anchor helper used to (A1) so
            # the per-side `$limit` applies before ``collect()`` and the
            # path-alias never enters a slice context. One round-trip
            # instead of the prior two.
            #
            # Variable-length bound = max ontology depth (floor 10) so
            # very deep ontologies aren't truncated and shallow ones
            # don't pay for unused depth.
            #
            # NB: anchor-itself + descendants are split into two UNION
            # branches per side because FalkorDB's planner intermittently
            # rejects `[c*0..N]` with "expected List or Null but was Edge"
            # — using `[c*1..N]` (minimum one hop) avoids the zero-length
            # edge case. The anchor itself is matched directly without
            # any traversal. This is the same fix shape used elsewhere
            # in this module (e.g. _find_ancestor_with_lineage at L5142).
            max_depth = max(len(getattr(self, "_entity_type_levels", {}) or {}), 10)
            cypher = (
                # Source — anchor itself
                "MATCH (a {urn: $source}) "
                "WHERE labels(a)[0] IN $types "
                "RETURN 's' AS side, [a.urn] AS urns "
                "UNION "
                # Source — descendants via 1..N containment hops
                f"MATCH (a {{urn: $source}})-[c*1..{max_depth}]->(child) "
                "WHERE ALL(rel IN c WHERE type(rel) IN $ctypes) "
                "  AND labels(child)[0] IN $types "
                "WITH DISTINCT child.urn AS urn "
                "LIMIT $limit "
                "RETURN 's' AS side, collect(urn) AS urns "
                "UNION "
                # Target — anchor itself
                "MATCH (b {urn: $target}) "
                "WHERE labels(b)[0] IN $types "
                "RETURN 't' AS side, [b.urn] AS urns "
                "UNION "
                # Target — descendants via 1..N containment hops
                f"MATCH (b {{urn: $target}})-[c*1..{max_depth}]->(child) "
                "WHERE ALL(rel IN c WHERE type(rel) IN $ctypes) "
                "  AND labels(child)[0] IN $types "
                "WITH DISTINCT child.urn AS urn "
                "LIMIT $limit "
                "RETURN 't' AS side, collect(urn) AS urns"
            )
            params = {
                "source": source_urn, "target": target_urn,
                "ctypes": ctypes, "types": types, "limit": limit,
            }
        try:
            result = await self._ro_query(cypher, params=params, timeout=2.0)
        except Exception as exc:
            logger.warning(
                "trace_at_level: descendant pair collection failed for (%s, %s): %s",
                source_urn, target_urn, exc,
            )
            raise

        # Accumulate per side — the UNION returns 2 rows per side (anchor +
        # descendants) so overwriting would lose half the URNs.
        s_set: Set[str] = set()
        t_set: Set[str] = set()
        for row in (result.result_set or []):
            if not row or len(row) < 2:
                continue
            side = row[0]
            urns = row[1] if isinstance(row[1], list) else []
            urn_list = [u for u in urns if u]
            if side == 's':
                s_set.update(urn_list)
            elif side == 't':
                t_set.update(urn_list)
        # An anchor that matched nothing falls back to ITSELF, mirroring
        # ``_collect_children_pair``. Without this a side could come back
        # empty and short-circuit the whole expand to zero edges — the
        # asymmetry between these two helpers was itself a bug.
        return (list(s_set) or [source_urn], list(t_set) or [target_urn])

    async def _collect_level_and_subtree(
        self,
        drilled_urn: str,
        partner_urn: str,
        target_level: int,
        ctypes: List[str],
        limit: int,
        *,
        drilled_is_source: bool,
    ) -> Tuple[List[str], List[str]]:
        """One side descends to ``target_level``; the other contributes
        itself plus its whole subtree, unfiltered. See the dispatch in
        ``_collect_descendants_pair_at_level`` for why."""
        types = self._types_at_level(target_level)
        max_depth = max(len(getattr(self, "_entity_type_levels", {}) or {}), 10)
        parts = [
            # The opened side — anchor itself when it already sits at the level
            "MATCH (a {urn: $drill}) WHERE labels(a)[0] IN $types "
            "RETURN 'd' AS side, [a.urn] AS urns",
            # ...and its descendants at that level
            f"MATCH (a {{urn: $drill}})-[c*1..{max_depth}]->(child) "
            "WHERE ALL(rel IN c WHERE type(rel) IN $ctypes) "
            "  AND labels(child)[0] IN $types "
            "WITH DISTINCT child.urn AS urn LIMIT $limit "
            "RETURN 'd' AS side, collect(urn) AS urns",
            # The partner — itself
            "MATCH (b {urn: $partner}) RETURN 'p' AS side, [b.urn] AS urns",
            # ...and everything beneath it, at any depth, any label
            f"MATCH (b {{urn: $partner}})-[c*1..{max_depth}]->(sub) "
            "WHERE ALL(rel IN c WHERE type(rel) IN $ctypes) "
            "WITH DISTINCT sub.urn AS urn LIMIT $limit "
            "RETURN 'p' AS side, collect(urn) AS urns",
        ]
        if not types:
            # Nothing declared at that level — the opened side still
            # contributes itself, so the expand degrades to "does this
            # container connect at all" rather than to silence.
            parts = [
                "MATCH (a {urn: $drill}) RETURN 'd' AS side, [a.urn] AS urns",
                *parts[2:],
            ]
        if not ctypes:
            parts = [p for p in parts if "*1.." not in p]
        result = await self._ro_query(
            " UNION ".join(parts),
            params={"drill": drilled_urn, "partner": partner_urn,
                    "ctypes": ctypes, "types": types, "limit": limit},
            op="trace.level_and_subtree",
            timeout=2.0,
        )
        d_set: Set[str] = set()
        p_set: Set[str] = set()
        for row in (result.result_set or []):
            if not row or len(row) < 2:
                continue
            urns = [u for u in (row[1] if isinstance(row[1], list) else []) if u]
            (d_set if row[0] == 'd' else p_set).update(urns)
        drilled = list(d_set) or [drilled_urn]
        partner = list(p_set) or [partner_urn]
        return (drilled, partner) if drilled_is_source else (partner, drilled)

    async def _edges_between_sets(
        self, s_urns: List[str], t_urns: List[str], level: int,
        ltypes: Optional[List[str]], use_raw: bool, limit: int,
    ) -> List[GraphEdge]:
        """Fetch edges between two URN sets — set membership, not Cartesian.

        ``use_raw=True`` reads raw lineage edges (for finest level where
        AGGREGATED == raw). Otherwise reads AGGREGATED.
        """
        if not s_urns or not t_urns:
            return []

        edges = await self._edges_between_sets_once(
            s_urns, t_urns, ltypes, use_raw=use_raw, limit=limit,
        )
        if not edges and not use_raw and ltypes:
            # The AGGREGATED read found nothing between these sets. Under
            # the same-level materialization boundary, leaf-adjacent
            # levels have NO stored cells — and the ``use_raw`` decision
            # upstream compares against the ontology-wide finest level,
            # which misclassifies when the resolved ontology mixes
            # entity families of different depths. Raw lineage is the
            # ground truth at fine grain; falling back costs one indexed
            # query and only ever fires on an empty result.
            edges = await self._edges_between_sets_once(
                s_urns, t_urns, ltypes, use_raw=True, limit=limit,
            )
        return edges

    async def _edges_between_sets_once(
        self, s_urns: List[str], t_urns: List[str],
        ltypes: Optional[List[str]], use_raw: bool, limit: int,
    ) -> List[GraphEdge]:
        # Rewritten away from ``UNWIND $sUrns AS srcUrn MATCH (s {urn:
        # srcUrn})`` because the inner unlabeled MATCH does a node scan
        # PER UNWIND iteration when the unlabeled URN index is absent —
        # exactly the antipattern that took down aggregation. The
        # ``WHERE s.urn IN $sUrns AND t.urn IN $tUrns`` form is ONE
        # scan/seek total, regardless of |sUrns|. See plan Phase 1.5.
        if use_raw:
            # Raw lineage edges by type — caller passes ltypes (lineage types)
            ltypes_eff = ltypes or []
            if not ltypes_eff:
                return []
            cypher = (
                "MATCH (s)-[r]->(t) "
                "WHERE s.urn IN $sUrns AND t.urn IN $tUrns "
                "  AND type(r) IN $ltypes "
                "RETURN s.urn AS sUrn, t.urn AS tUrn, type(r) AS edgeType, "
                "id(r) AS edgeId, properties(r) AS props "
                "LIMIT $limit"
            )
            params = {"sUrns": s_urns, "tUrns": t_urns, "ltypes": ltypes_eff, "limit": limit}
            graph_query = self._ro_query
        else:
            cypher = (
                "MATCH (s)-[r:AGGREGATED]->(t) "
                "WHERE s.urn IN $sUrns AND t.urn IN $tUrns "
                + ("AND any(et IN r.sourceEdgeTypes WHERE et IN $ltypes) " if ltypes else "")
                + "RETURN s.urn AS sUrn, t.urn AS tUrn, 'AGGREGATED' AS edgeType, "
                "id(r) AS edgeId, "
                "{sourceEdgeTypes: r.sourceEdgeTypes, weight: r.weight} AS props "
                "LIMIT $limit"
            )
            params = {"sUrns": s_urns, "tUrns": t_urns, "limit": limit}
            if ltypes:
                params["ltypes"] = ltypes
            graph_query = self._proj_ro_query

        try:
            result = await graph_query(cypher, params=params)
        except Exception as exc:
            logger.warning("expand_aggregated: edge fetch failed: %s", exc)
            return []

        out: List[GraphEdge] = []
        seen_ids: Set[str] = set()
        for row in (result.result_set or []):
            try:
                edge_id = str(row[3]) if row[3] is not None else f"{row[2]}-{row[0]}-{row[1]}"
                if edge_id in seen_ids:
                    continue
                seen_ids.add(edge_id)
                props = row[4] if isinstance(row[4], dict) else {}
                out.append(GraphEdge(
                    id=edge_id,
                    sourceUrn=row[0],
                    targetUrn=row[1],
                    edgeType=str(row[2]),
                    properties=props or {},
                ))
            except Exception:
                continue
        return out

    async def _fetch_containment_edges(
        self, urns: List[str], ctypes: List[str],
        chains: Optional[Dict[str, List[str]]] = None,
        labels: Optional[Dict[str, str]] = None,
    ) -> List[GraphEdge]:
        """Containment edges where both endpoints are in ``urns``.

        ``labels`` (urn → entity label), when the caller has them in hand
        (the closure hydrates every participant, so it always does), anchors
        each pair chunk on the PARENT's label: ``MATCH (s:Label)-[r]->(t)``
        is an index seek, while the unlabeled form scanned the whole graph
        once per chunk — measured ~520 ms per 400 pairs on a 520k-node
        estate, eight chunks per page.

        Pair-list driven: builds the parent→child pairs we expect to exist
        from the cached ancestor chains (already populated by aggregation
        + the earlier :func:`_collect_ancestor_urns` call in
        :func:`trace_at_level`). Then issues ONE rel-typed Cypher to
        resolve the real edge type + id per pair.

        Replaces the previous ``UNWIND $urns ... MATCH (s)-[r]->(t)
        WHERE t.urn IN $urns AND type(r) IN $ctypes`` which scanned every
        outgoing edge from every URN before filtering — quadratic on
        wide trace results and a major contributor to the 8s timeout on
        100k-node graphs.

        Cold-cache fallback uses the same rel-typed alternation pattern
        so it's still faster than the legacy form.
        """
        if not urns or not ctypes:
            return []

        rel_alt = "|".join(_sanitize_label(c) for c in ctypes)
        urn_set = set(urns)

        # Build (parent, child) pair candidates from cached chains —
        # reusing the caller's just-computed map when provided.
        if chains is None:
            try:
                chains = await self._compute_and_store_ancestors_bulk(list(urns))
            except Exception:
                chains = {}

        pairs: Set[tuple] = set()
        for child_urn, chain in (chains or {}).items():
            prev = child_urn
            for ancestor in chain or []:
                if ancestor in urn_set and prev in urn_set:
                    pairs.add((ancestor, prev))
                prev = ancestor

        # Rewritten away from the ``UNWIND … MATCH (s {urn: …})`` form
        # for the same reason as ``_edges_between_sets``: the inner
        # unlabeled MATCH scans per-iteration without an unlabeled URN
        # index. ``WHERE s.urn IN $sUrns AND t.urn IN $tUrns`` runs one
        # scan/seek for the whole batch. The pair-bounded branch
        # post-filters Cartesian results down to the requested pairs.
        if pairs:
            # CHUNKED + NEVER-EMPTY (2026-08-20): one set×set query over a
            # full-walk's ~2,000 pairs on a 1.2M-node graph blew the 2s
            # timeout and the exception path silently returned [] — the
            # trace shipped participants WITHOUT the containment that
            # placement/nesting need ("completely disjointed" on the big
            # estates, while the Lens's small per-click pair sets fit the
            # budget). Pairs now resolve in bounded chunks, and any chunk
            # that still fails SYNTHESIZES its edges straight from the
            # ancestor chains — the chains are the truth; the query only
            # decorates real ids/types onto them.
            out: List[GraphEdge] = []
            CHUNK_PAIRS = 400
            # Bucket by the parent's label when known: one index-anchored
            # query per (label, chunk) instead of one scan per chunk.
            by_label: Dict[str, List[Tuple[str, str]]] = {}
            for pair in sorted(pairs):
                by_label.setdefault((labels or {}).get(pair[0]) or "", []).append(pair)
            chunks: List[Tuple[str, List[Tuple[str, str]]]] = []
            for lbl, lbl_pairs in by_label.items():
                for i in range(0, len(lbl_pairs), CHUNK_PAIRS):
                    chunks.append((lbl, lbl_pairs[i:i + CHUNK_PAIRS]))
            for lbl, chunk in chunks:
                chunk_set: Set[Tuple[str, str]] = set(chunk)
                s_urns = sorted({s for s, _ in chunk})
                t_urns = sorted({t for _, t in chunk})
                sl = _sanitize_label(lbl) if lbl else ""
                s_clause = f":{sl}" if sl else ""
                cypher = (
                    f"MATCH (s{s_clause})-[r:{rel_alt}]->(t) "
                    "WHERE s.urn IN $sUrns AND t.urn IN $tUrns "
                    "RETURN s.urn AS sUrn, t.urn AS tUrn, "
                    "type(r) AS edgeType, id(r) AS edgeId"
                )
                resolved: Set[Tuple[str, str]] = set()
                try:
                    result = await self._ro_query(
                        cypher,
                        params={"sUrns": s_urns, "tUrns": t_urns},
                        timeout=2.0,
                    )
                    for row in (result.result_set or []):
                        if (row[0], row[1]) not in chunk_set:
                            continue
                        resolved.add((row[0], row[1]))
                        out.append(GraphEdge(
                            id=str(row[3]), sourceUrn=row[0], targetUrn=row[1],
                            edgeType=str(row[2]), properties={},
                        ))
                except Exception as exc:
                    logger.warning(
                        "trace: containment pair-fetch chunk failed "
                        "(%d pairs) — synthesizing from chains: %s",
                        len(chunk), exc,
                    )
                for (s, t) in chunk:
                    if (s, t) in resolved:
                        continue
                    out.append(GraphEdge(
                        id=f"containment:{s}>{t}", sourceUrn=s, targetUrn=t,
                        edgeType=ctypes[0], properties={},
                    ))
            return out
        else:
            allowed_pairs = None  # type: ignore[assignment]  # no post-filter
            # Cold-cache fallback. Still rel-typed (avoids the OR-on-type
            # full edge scan of the legacy query).
            cypher = (
                f"MATCH (s)-[r:{rel_alt}]->(t) "
                "WHERE s.urn IN $urns AND t.urn IN $urns "
                "RETURN s.urn AS sUrn, t.urn AS tUrn, "
                "type(r) AS edgeType, id(r) AS edgeId"
            )
            try:
                result = await self._ro_query(
                    cypher, params={"urns": list(urns)}, timeout=2.0,
                )
            except Exception as exc:
                logger.warning(
                    "trace_at_level: containment edge fallback fetch failed: %s",
                    exc,
                )
                return []

        out: List[GraphEdge] = []
        for row in (result.result_set or []):
            # In the pair-bounded branch, the rewritten Cypher returns
            # the Cartesian of (sUrns × tUrns) that have a matching
            # edge — broader than the original ``UNWIND $pairs`` form.
            # Filter back down to the exact requested pairs so the
            # caller sees the same set it would have before the WS1.5
            # rewrite.
            if allowed_pairs is not None and (row[0], row[1]) not in allowed_pairs:
                continue
            try:
                out.append(GraphEdge(
                    id=str(row[3]),
                    sourceUrn=row[0],
                    targetUrn=row[1],
                    edgeType=str(row[2]),
                    properties={},
                ))
            except Exception:
                continue
        return out

    async def get_nodes_batch(self, urns: List[str]) -> List[GraphNode]:
        """Bulk node fetch by URN — used by trace v2 to hydrate nodes after
        BFS AND by advanced search's batched ancestor hydration (W1.1c).

        Uses the longer ``FALKORDB_CHILDREN_QUERY_TIMEOUT_SECS`` (15s
        default) rather than the generic 5s read timeout because a
        single batch may carry hundreds of URNs from a large search
        page; the IN-list scan on a million-node graph is the same
        cost class as the children-fetch this timeout was tuned for.
        """
        if not urns:
            return []
        from backend.app.config.resilience import FALKORDB_CHILDREN_QUERY_TIMEOUT_SECS

        # Per-label urn-index seeks via the warmed urn→label cache; the
        # unlabeled IN-list form survives only for the unresolved-label
        # residue bucket (this build has no label-less URN index — the
        # unlabeled anchor is a full node scan).
        #
        # childCount is COMPUTED here when containment types are configured
        # (2026-08-20): trace-shipped nodes used to rely on the denormalised
        # `childCount` property alone, which import paths don't always stamp
        # — a self-nesting Node⊃Node⊃Node estate then rendered its trace-
        # merged children CHEVRON-LESS (no expand affordance, deeper levels
        # unreachable). Browse computes the count live; the batch hydration
        # every trace path uses must agree with it.
        try:
            _ct_for_count = self._get_containment_edge_types() or []
        except Exception:
            _ct_for_count = []
        ctypes_for_count = [_sanitize_label(t) for t in _ct_for_count if t]
        ct_alt_count = "|".join(ctypes_for_count)

        async def _fetch(label: str, bucket: List[str]) -> list:
            anchor = f"(n:{label})" if label else "(n)"
            if ct_alt_count:
                cy = (
                    f"MATCH {anchor} WHERE n.urn IN $urns "
                    f"OPTIONAL MATCH (n)-[:{ct_alt_count}]->(child) "
                    "RETURN n, count(child) as childCount"
                )
            else:
                cy = f"MATCH {anchor} WHERE n.urn IN $urns RETURN n"
            try:
                res = await self._ro_query(
                    cy,
                    params={"urns": bucket},
                    timeout=FALKORDB_CHILDREN_QUERY_TIMEOUT_SECS,
                    op="nodes.batch",
                )
                return res.result_set or []
            except Exception as exc:
                logger.warning("get_nodes_batch bucket failed: %s", exc)
                return []

        try:
            rows_per_bucket = await asyncio.gather(*[
                _fetch(label, bucket)
                for label, bucket in await self._label_buckets(urns)
            ])
        except Exception as exc:
            logger.warning("get_nodes_batch failed: %s", exc)
            return []
        out: List[GraphNode] = []
        for rows in rows_per_bucket:
            for row in rows:
                child_count = None
                if ct_alt_count and isinstance(row, (list, tuple)) and len(row) >= 2:
                    node = self._extract_node_from_result([row[0]])
                    child_count = row[1]
                else:
                    node = self._extract_node_from_result(row)
                if not node:
                    continue
                if child_count is not None:
                    node.child_count = int(child_count)
                    if node.properties is not None:
                        node.properties['childCount'] = int(child_count)
                out.append(node)
        return out
