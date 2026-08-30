"""
FalkorDB graph provider - persists graph data in FalkorDB and loads it via the application.
Implements GraphDataProvider interface using FalkorDB async client and Cypher queries.
"""

import asyncio
import json
import os
import time
from collections import defaultdict, deque
from typing import Awaitable, Callable, List, Optional, Dict, Any, Set, Tuple

from backend.app.models.graph import (
    GraphNode, GraphEdge, NodeQuery,
    GraphSchemaStats,
    EntityTypeSummary, EdgeTypeSummary, TagSummary,
    OntologyMetadata, EdgeTypeMetadata, EntityTypeHierarchy,
    AggregatedEdgeResult, AggregatedEdgeInfo,
)
from backend.app.providers.base import GraphDataProvider
from backend.common.interfaces.provider import ProviderConfigurationError

from backend.app.providers.falkordb._log import logger

from backend.app.providers.falkordb.aggregation import AggregationMixin
from backend.app.providers.falkordb.rowmap import (
    _sanitize_label,
    _compute_searchable_text,
    _split_user_properties,
    _edge_from_row,
)
from backend.app.providers.falkordb.cursors import (
    _decode_keyset_cursor,
    _validate_sort_direction,
    _keyset_sort,
)
from backend.app.providers.falkordb.trace import TraceMixin
from backend.app.providers.falkordb.closure import ClosureMixin
from backend.app.providers.falkordb.errors import (
    _is_transient_connection_error,
    _is_loading_error,
)
from backend.app.providers.falkordb.connection import ConnectionMixin
from backend.app.providers.falkordb.schema import SchemaMixin
from backend.app.providers.falkordb.ontology import OntologyMixin
from backend.app.providers.falkordb.caches import CacheMixin
from backend.app.providers.falkordb.ancestors import AncestorMixin
from backend.app.providers.falkordb.reads import ReadMixin
from backend.app.providers.falkordb.browse import BrowseMixin
from backend.app.providers.falkordb.lineage_simple import SimpleLineageMixin


class FalkorDBProvider(ConnectionMixin, SchemaMixin, OntologyMixin, CacheMixin, AncestorMixin, ReadMixin, BrowseMixin, SimpleLineageMixin, AggregationMixin, TraceMixin, ClosureMixin, GraphDataProvider):
    """
    Graph data provider backed by FalkorDB.
    Schema: nodes have label = entityType, properties include urn, displayName, etc.
    Edges use relationship type = edgeType (CONTAINS, PRODUCES, etc.).
    """

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

    # Schema-level caches are persisted in Postgres by the stats service;
    # this in-memory Redis layer is just a short-term memoization for
    # repeated calls within a polling interval. Default 300s (5 min) —
    # matches the stats service poll interval. Set to 0 to disable.
    _SCHEMA_CACHE_TTL = int(os.getenv("FALKORDB_SCHEMA_CACHE_TTL", "300"))

    async def get_stats(self, bypass_cache: bool = False) -> Dict[str, Any]:
        """Node/edge counts + per-type breakdowns (two grouped scans).

        ``bypass_cache=True`` skips the Redis cache READ but still
        writes-through on success — for refresh paths (the insights
        counts poll) that must never persist pre-aged cached counts as
        fresh, while still priming the cache for other callers.
        """
        await self._ensure_connected()

        # Check Redis cache (best-effort; Postgres is the source of truth)
        cache_key = f"{self._cache_ns}:stats_cache"
        if self._SCHEMA_CACHE_TTL > 0 and not bypass_cache:
            try:
                cached = await self._redis.get(cache_key)
                if cached:
                    return json.loads(cached)
            except Exception:
                pass

        # Empty / never-created graphs raise "Invalid graph operation on
        # empty key" on GRAPH.RO_QUERY — a valid 0-node / 0-edge state, not
        # an outage. Tolerate it so discovery reports the asset as empty
        # rather than the whole provider as down.
        entity_type_counts: Dict[str, Any] = {}
        node_count = 0
        edge_type_counts: Dict[str, Any] = {}
        edge_count = 0
        # The node/edge count scans are O(nodes)+O(edges) — on a million-edge
        # graph they exceed the 5s read default and the stats refresh fails
        # (then the asset shows stale). Give them a dedicated, generous
        # timeout so a cache-miss scan can complete and warm {graph}:stats_cache.
        _stats_q_timeout = float(os.getenv("FALKORDB_STATS_QUERY_TIMEOUT_SECS", "30"))
        try:
            # Optimize: Combine node counting with type aggregation
            type_res = await self._ro_query(
                "MATCH (n) RETURN labels(n)[0] AS lbl, count(*) AS c",
                timeout=_stats_q_timeout,
            )
            for row in (type_res.result_set or []):
                lbl = row[0] or "unknown"
                cnt = row[1]
                entity_type_counts[lbl] = cnt
                node_count += cnt

            # Optimize: Combine edge counting with type aggregation
            edge_type_res = await self._ro_query(
                "MATCH ()-[r]->() RETURN type(r) AS t, count(*) AS c",
                timeout=_stats_q_timeout,
            )
            for row in (edge_type_res.result_set or []):
                t = row[0] or "UNKNOWN"
                cnt = row[1]
                edge_type_counts[t] = cnt
                edge_count += cnt
        except Exception as exc:
            if not await self._is_verified_missing_graph(exc):
                raise
            logger.info(
                "get_stats on %s: graph key does not exist yet (empty graph) "
                "— returning zero stats.", self._graph_name,
            )
            entity_type_counts, node_count = {}, 0
            edge_type_counts, edge_count = {}, 0

        result = {
            "nodeCount": node_count,
            "edgeCount": edge_count,
            "entityTypeCounts": entity_type_counts,
            "edgeTypeCounts": edge_type_counts,
        }

        if self._SCHEMA_CACHE_TTL > 0:
            try:
                await self._redis.setex(cache_key, self._SCHEMA_CACHE_TTL, json.dumps(result))
            except Exception:
                pass

        return result

    async def get_counts_fast(self) -> Optional[Dict[str, Any]]:
        """Same payload as :meth:`get_stats`, without scanning the graph.

        FalkorDB's ``reduce_count`` optimization answers ``count()`` over an
        unfiltered pattern from the label/relation matrix counters — the plan
        is ``Results / Project`` with no scan operator at all. Projecting
        ``labels(n)[0]`` or ``type(r)`` alongside the count is what loses it,
        which is exactly what ``get_stats`` does and why its two queries cost
        ~514ms on a 500k-node / 850k-edge graph where this costs ~1.3ms.

        So the per-type breakdown comes from the schema catalogue
        (``db.labels()`` / ``db.relationshipTypes()``, both O(#types)) plus one
        constant-time count each. **Never add a projection to these queries.**

        Cost is ``4 + labels + types`` round trips and is therefore constant in
        the SIZE of the graph but linear in the size of its SCHEMA — the exact
        inverse of ``get_stats``. On a small graph with a wide schema the two
        converge; the win is on the large graphs that forced the 900s poll
        interval in the first place.

        Returns ``None`` — not an error — when the counts cannot be trusted,
        so the caller falls back to :meth:`get_stats`. That happens when the
        label counts sum ABOVE the node total, which means multi-label nodes:
        per-label counting then double-counts relative to ``labels(n)[0]``
        semantics. Our own writers are single-label by construction
        (``MERGE (n:{label} {urn: …})``) but an external loader need not be.
        """
        await self._ensure_connected()

        async def _count(cypher: str) -> int:
            res = await self._ro_query_tolerant(cypher, op="probe.count")
            rows = res.result_set or []
            return int(rows[0][0] or 0) if rows and rows[0] else 0

        async def _catalogue(cypher: str) -> List[str]:
            res = await self._ro_query_tolerant(cypher, op="probe.catalogue")
            return [row[0] for row in (res.result_set or []) if row and row[0]]

        labels = await _catalogue(
            "CALL db.labels() YIELD label RETURN label"
        )
        rel_types = await _catalogue(
            "CALL db.relationshipTypes() YIELD relationshipType "
            "RETURN relationshipType"
        )
        node_count = await _count("MATCH (n) RETURN count(n)")
        edge_count = await _count("MATCH ()-[r]->() RETURN count(r)")

        # Zero-count buckets are DROPPED, not reported. The catalogue keeps
        # listing a label/type after its last row is deleted, where get_stats
        # simply returns no row for it — and a {"Ghost": 0} key hashes
        # differently from an absent one, so keeping it would read as drift on
        # the first probe of every graph that ever deleted a type.
        entity_type_counts: Dict[str, Any] = {}
        for label in labels:
            safe = str(label).replace("`", "")
            count = await _count(f"MATCH (n:`{safe}`) RETURN count(n)")
            if count:
                entity_type_counts[label] = count

        edge_type_counts: Dict[str, Any] = {}
        for rel_type in rel_types:
            safe = str(rel_type).replace("`", "")
            count = await _count(f"MATCH ()-[r:`{safe}`]->() RETURN count(r)")
            if count:
                edge_type_counts[rel_type] = count

        label_sum = sum(entity_type_counts.values())
        if label_sum > node_count:
            logger.info(
                "get_counts_fast on %s: label counts sum to %d over %d nodes "
                "(multi-label graph) — deferring to the full scan",
                self._graph_name, label_sum, node_count,
            )
            return None
        if label_sum < node_count:
            # Unlabelled nodes: invisible to per-label counts, and get_stats
            # buckets them under `labels(n)[0] or "unknown"`. Deriving the
            # remainder reproduces that bucket exactly.
            entity_type_counts["unknown"] = node_count - label_sum

        # An edge carries exactly one type, so unlike nodes there is no honest
        # remainder to attribute. A disagreement means the catalogue is not
        # describing this graph; refuse rather than report a wrong shape.
        if sum(edge_type_counts.values()) != edge_count:
            logger.info(
                "get_counts_fast on %s: edge-type counts sum to %d over %d "
                "edges — deferring to the full scan",
                self._graph_name, sum(edge_type_counts.values()), edge_count,
            )
            return None

        result = {
            "nodeCount": node_count,
            "edgeCount": edge_count,
            "entityTypeCounts": entity_type_counts,
            "edgeTypeCounts": edge_type_counts,
        }
        # Same payload get_stats would have produced, so priming its cache
        # keeps the two from disagreeing for the TTL.
        await self.prime_stats_cache(result)
        return result

    async def prime_stats_cache(self, stats: Dict[str, Any]) -> None:
        """Write-through prime of the ``{graph}:stats_cache`` Redis key.

        Called by the insights collector after a poll derives fresh
        counts (from ``get_schema_stats``), so subsequent ``get_stats``
        callers — per-asset discovery, web-tier data-source stats —
        serve poll-fresh values instead of re-scanning. Best-effort.
        """
        if self._SCHEMA_CACHE_TTL <= 0:
            return
        await self._ensure_connected()
        try:
            await self._redis.setex(
                f"{self._cache_ns}:stats_cache",
                self._SCHEMA_CACHE_TTL,
                json.dumps(stats),
            )
        except Exception:
            pass

    async def get_schema_stats(self) -> GraphSchemaStats:
        await self._ensure_connected()
        
        entity_stats = []
        total_nodes = 0
        edge_stats = []
        total_edges = 0
        # Empty / never-created graph → valid empty schema, not an outage.
        _stats_q_timeout = float(os.getenv("FALKORDB_STATS_QUERY_TIMEOUT_SECS", "30"))
        try:
            # Single query: counts + samples per label using collect() with slicing
            type_res = await self._ro_query(
                "MATCH (n) "
                "WITH labels(n)[0] AS lbl, n.displayName AS name "
                "WITH lbl, count(*) AS c, collect(name)[0..3] AS samples "
                "RETURN lbl, c, samples",
                timeout=_stats_q_timeout,
            )
            for row in (type_res.result_set or []):
                lbl = row[0] or "unknown"
                if str(lbl).startswith("_"):
                    # System-internal labels (_AggMeta run metadata,
                    # _Projection scaffolding) — not user entity types;
                    # surfacing them puts phantom types in the ontology
                    # wizard.
                    continue
                cnt = row[1]
                samples = [s for s in (row[2] or []) if s]
                total_nodes += cnt
                entity_stats.append(EntityTypeSummary(id=lbl, name=lbl, count=cnt, sampleNames=samples))

            edge_type_res = await self._ro_query(
                "MATCH ()-[r]->() RETURN type(r) AS t, count(*) AS c",
                timeout=_stats_q_timeout,
            )
            for row in (edge_type_res.result_set or []):
                t = row[0] or "UNKNOWN"
                cnt = row[1]
                edge_stats.append(EdgeTypeSummary(id=t, name=t, count=cnt))
                total_edges += cnt
        except Exception as exc:
            if not await self._is_verified_missing_graph(exc):
                raise
            logger.info(
                "get_schema_stats on %s: graph key does not exist yet "
                "(empty graph) — returning empty schema.", self._graph_name,
            )
            return GraphSchemaStats(
                totalNodes=0, totalEdges=0,
                entityTypeStats=[], edgeTypeStats=[], tagStats=[],
            )

        # Tag stats — a full node scan like the two above; give it the
        # same generous stats budget (it previously ran on the default
        # connection timeout and was the silent killer on large graphs).
        try:
            tag_res = await self._ro_query(
                "MATCH (n) WHERE n.tags IS NOT NULL AND n.tags <> '[]' RETURN n.tags",
                timeout=_stats_q_timeout,
            )
            tag_counts: Dict[str, int] = {}
            tag_types: Dict[str, Set[str]] = {}
            for row in (tag_res.result_set or []):
                tags_raw = row[0]
                try:
                    tags = json.loads(tags_raw) if isinstance(tags_raw, str) else (tags_raw or [])
                except Exception:
                    continue
                for tag in tags:
                    tag_counts[tag] = tag_counts.get(tag, 0) + 1
                    if tag not in tag_types:
                        tag_types[tag] = set()
                    tag_types[tag].add("entity")
            tag_stats = [TagSummary(tag=t, count=c, entityTypes=list(tag_types.get(t, {"entity"}))) for t, c in tag_counts.items()]
        except Exception as e:
            logger.warning(f"Failed to fetch tag stats: {e}")
            tag_stats = []

        return GraphSchemaStats(
            totalNodes=total_nodes,
            totalEdges=total_edges,
            entityTypeStats=entity_stats,
            edgeTypeStats=edge_stats,
            tagStats=tag_stats,
        )

    async def get_ontology_metadata(self) -> OntologyMetadata:
        """
        Build ontology metadata including containment and lineage roles.
        Optimized to use Cypher aggregations instead of full scans.
        Cached in Redis with 60s TTL — ontology rarely changes.
        """
        await self._ensure_connected()

        cache_key = f"{self._cache_ns}:ontology_cache"
        if self._SCHEMA_CACHE_TTL > 0:
            try:
                cached = await self._redis.get(cache_key)
                if cached:
                    cached_meta = OntologyMetadata(**json.loads(cached))
                    # Keep the sync case-fold floor (_alias_rel_types) warm even
                    # on a cache hit: the metadata's edge-type keys ARE the
                    # observed physical spellings, so trace/top-level resolve
                    # declared→physical correctly without re-probing the graph.
                    self._observed_rel_types = set(cached_meta.edge_type_metadata or {})
                    return cached_meta
            except Exception:
                pass

        # Introspection must NOT depend on containment having been injected.
        # ``_resolve_ontology`` calls this method BEFORE ``_inject_resolved`` on a
        # fresh provider, and ``_get_containment_edge_types`` raises when the set
        # isn't configured yet. Letting that raise here aborts the whole
        # introspection (observed vocabulary discovery below), which leaves the
        # per-source case-alias map empty on the FIRST resolve — so declared
        # UPPER_SNAKE types get injected verbatim into case-sensitive Cypher and
        # match nothing (a flat hierarchy on a freshly-onboarded data source).
        # Containment here is only a classification hint for the observed types;
        # treat "not configured yet" as empty and let the rest run.
        try:
            containment = list(self._get_containment_edge_types())
        except ProviderConfigurationError:
            containment = []
        containment_upper = {t.upper() for t in containment}
        
        # 1. Determine Lineage Types
        # db.relationshipTypes() reads the graph schema catalog — O(#types),
        # no edge scan. The DISTINCT type(r) scan (O(#edges): ~1s per million
        # edges, and this runs on every ontology-cache miss) remains only as
        # a fallback for engines without the procedure. The catalog can list
        # types whose last edge was deleted — harmless here: downstream
        # classification treats the list as "observed vocabulary" and a
        # stale entry simply classifies an absent type.
        all_types: List[str] = []
        try:
            type_res = await self._ro_query_tolerant(
                "CALL db.relationshipTypes() YIELD relationshipType "
                "RETURN relationshipType",
                op="ontology.reltypes",
            )
            all_types = [row[0] for row in (type_res.result_set or []) if row and row[0]]
        except Exception as exc:
            logger.debug("db.relationshipTypes() unavailable (%s) — falling back to edge scan", exc)
        if not all_types:
            type_res = await self._ro_query_tolerant(
                "MATCH ()-[r]->() RETURN DISTINCT type(r)", op="ontology.edge_scan",
            )
            all_types = [row[0] for row in (type_res.result_set or [])]

        # Feed the sync case-fold floor (_alias_rel_types) the observed
        # vocabulary discovered here (catalog ∪ edge-scan fallback), so every
        # read-path consumer resolves declared→physical case variants without
        # depending on the injected per-source alias map being non-empty.
        self._observed_rel_types = {str(t) for t in all_types if t}

        # Use ontology-resolved edge metadata if available, otherwise fall back to heuristics
        resolved_meta = getattr(self, "_resolved_edge_metadata", None)
        resolved_lineage = getattr(self, "_resolved_lineage_types", None)

        if resolved_meta is not None and resolved_lineage is not None:
            # Ontology-driven classification
            lineage_types = [t for t in all_types if t.upper() in resolved_lineage]
        else:
            # Heuristic fallback (pre-ontology or no ontology)
            config_lineage = os.getenv("LINEAGE_EDGE_TYPES", "").strip()
            if config_lineage:
                lineage_types = [t.strip() for t in config_lineage.split(",") if t.strip()]
            else:
                config_metadata = os.getenv("METADATA_EDGE_TYPES", "").strip()
                metadata_types = {t.strip().upper() for t in config_metadata.split(",") if t.strip()} if config_metadata else set()
                lineage_types = []
                for t in all_types:
                    if t.upper() not in containment_upper and t.upper() not in metadata_types and t.upper() != "AGGREGATED":
                        lineage_types.append(t)

        lineage_upper = {t.upper() for t in lineage_types}

        # 2. Build Edge Metadata
        edge_type_metadata: Dict[str, EdgeTypeMetadata] = {}
        for et in all_types:
            et_upper = et.upper()
            is_containment = et_upper in containment_upper
            is_lineage = et_upper in lineage_upper

            # Prefer resolved ontology metadata for direction/category
            if resolved_meta and et_upper in resolved_meta:
                meta = resolved_meta[et_upper]
                direction = meta.get("direction", "bidirectional") if isinstance(meta, dict) else getattr(meta, "direction", "bidirectional")
                category = meta.get("category", "association") if isinstance(meta, dict) else getattr(meta, "category", "association")
            elif is_containment:
                category = "structural"
                direction = "parent-to-child"
            elif is_lineage:
                category = "flow"
                direction = "source-to-target"
            else:
                category = "association"
                direction = "bidirectional"

            edge_type_metadata[et] = EdgeTypeMetadata(
                isContainment=is_containment,
                isLineage=is_lineage,
                direction=direction,
                category=category,
                description=f"{category} relationship: {et}",
            )

        # 3. Build Entity Hierarchy
        # Query containment relationships directly
        hierarchy_cypher = (
            "MATCH (p)-[r]->(c) "
            "WHERE type(r) IN $containment "
            "RETURN DISTINCT labels(p)[0], labels(c)[0], type(r)"
        )
        hierarchy_res = await self._ro_query_tolerant(
            hierarchy_cypher,
            params={"containment": containment}
        )
        
        entity_type_hierarchy: Dict[str, EntityTypeHierarchy] = {}
        found_parent_types = set()
        found_child_types = set()
        
        for row in (hierarchy_res.result_set or []):
            p_type, c_type, r_type = row[0], row[1], row[2]
            if not p_type or not c_type: continue
            
            # Normalize for direction
            meta = edge_type_metadata.get(r_type)
            if meta and meta.direction == "child-to-parent":
                parent_t, child_t = c_type, p_type
            else:
                parent_t, child_t = p_type, c_type
                
            if parent_t not in entity_type_hierarchy:
                entity_type_hierarchy[parent_t] = EntityTypeHierarchy(canContain=[], canBeContainedBy=[])
            if child_t not in entity_type_hierarchy:
                entity_type_hierarchy[child_t] = EntityTypeHierarchy(canContain=[], canBeContainedBy=[])
                
            if child_t not in entity_type_hierarchy[parent_t].can_contain:
                entity_type_hierarchy[parent_t].can_contain.append(child_t)
            if parent_t not in entity_type_hierarchy[child_t].can_be_contained_by:
                entity_type_hierarchy[child_t].can_be_contained_by.append(parent_t)
                
            found_parent_types.add(parent_t)
            found_child_types.add(child_t)

        root_entity_types = list(found_parent_types - found_child_types)

        result = OntologyMetadata(
            containmentEdgeTypes=containment,
            lineageEdgeTypes=lineage_types,
            edgeTypeMetadata=edge_type_metadata,
            entityTypeHierarchy=entity_type_hierarchy,
            rootEntityTypes=root_entity_types,
        )

        if self._SCHEMA_CACHE_TTL > 0:
            try:
                await self._redis.setex(cache_key, self._SCHEMA_CACHE_TTL, result.model_dump_json())
            except Exception:
                pass

        return result

    async def get_node_degrees(
        self, urns: List[str], edge_types: Optional[List[str]] = None,
    ) -> Dict[str, Dict[str, int]]:
        """TOTAL lineage degree (in/out) per URN over the FULL graph.

        The canvas subtracts its loaded (internal) degree from these
        totals to derive how much lineage lies OUTSIDE the current
        view's scope — the "no lineage" vs "lineage outside this view"
        distinction for curated subset views. Per-node adjacency
        aggregates (never a set-membership XOR over all edges), with
        label-bucketed URN seeks so no bucket falls back to a full node
        scan.

        Semantics: a URN ABSENT from the result is UNKNOWN (its bucket's
        query failed) — callers must not treat absence as zero. URNs in
        a successfully-queried bucket that simply have no edges are
        explicitly zero-filled.
        """
        out: Dict[str, Dict[str, int]] = {}
        if not urns:
            return out
        await self._ensure_connected()
        rel_alt = "|".join(_sanitize_label(t) for t in (edge_types or []) if t)
        rel_frag = f":{rel_alt}" if rel_alt else ""
        for label, bucket_urns in await self._label_buckets(urns):
            lbl_frag = f":{label}" if label else ""
            bucket_ok = True
            counts: Dict[str, Dict[str, int]] = {}
            for direction, pattern in (
                ("out", f"(n{lbl_frag})-[r{rel_frag}]->()"),
                ("in", f"(n{lbl_frag})<-[r{rel_frag}]-()"),
            ):
                cypher = (
                    f"MATCH {pattern} WHERE n.urn IN $urns "
                    "RETURN n.urn AS urn, count(r) AS c"
                )
                try:
                    result = await self._ro_query(
                        cypher, params={"urns": bucket_urns}, timeout=2.0,
                        op="node_degrees",
                    )
                except Exception as exc:
                    logger.warning(
                        "get_node_degrees %s failed (%d urns, label=%r): %s",
                        direction, len(bucket_urns), label, exc,
                    )
                    bucket_ok = False
                    break
                for row in (result.result_set or []):
                    counts.setdefault(str(row[0]), {"in": 0, "out": 0})[direction] = int(row[1] or 0)
            if not bucket_ok:
                continue  # absent = unknown, never zero
            for urn in bucket_urns:
                out[urn] = counts.get(urn, {"in": 0, "out": 0})
        return out

    async def get_distinct_values(self, property_name: str) -> List[Any]:
        await self._ensure_connected()
        if property_name in ("entityType", "entitytype"):
            res = await self._ro_query("MATCH (n) RETURN DISTINCT labels(n)[0] AS lbl")
            return [row[0] for row in (res.result_set or []) if row[0]]
        if property_name == "tags":
            res = await self._ro_query("MATCH (n) RETURN n.tags")
            seen = set()
            for row in (res.result_set or []):
                raw = row[0]
                try:
                    tags = json.loads(raw) if isinstance(raw, str) else (raw or [])
                    for t in tags:
                        seen.add(t)
                except Exception:
                    pass
            return list(seen)
        safe_prop = "".join(c for c in property_name if c.isalnum() or c == "_") or "urn"
        try:
            res = await self._ro_query(
                f"MATCH (n) WHERE n.{safe_prop} IS NOT NULL RETURN DISTINCT n.{safe_prop} AS v LIMIT 100"
            )
            return [row[0] for row in (res.result_set or [])]
        except Exception:
            return []

    async def get_ancestors(self, urn: str, limit: int = 100, offset: int = 0) -> List[GraphNode]:
        """Get ancestors using pre-computed Redis chain (2 calls: 1 Redis + 1 Cypher)."""
        await self._ensure_connected()
        chain = await self._get_ancestor_chain(urn)
        chain = chain[offset : offset + limit]
        if not chain:
            return []
        nodes = await self.get_nodes(NodeQuery(urns=chain, limit=len(chain), include_child_count=False))
        # Preserve containment order (parent → grandparent → ...)
        urn_to_node = {n.urn: n for n in nodes}
        return [urn_to_node[u] for u in chain if u in urn_to_node]

    async def get_descendants(
        self,
        urn: str,
        depth: int = 5,
        entity_types: Optional[List[str]] = None,
        limit: int = 100,
        offset: int = 0,
    ) -> List[GraphNode]:
        """Single Cypher query to fetch descendants instead of per-node BFS."""
        await self._ensure_connected()
        containment = list(self._get_containment_edge_types())
        if not containment:
            # No containment types — flat graph, no descendants
            return []
        containment_cypher = "|".join([_sanitize_label(t) for t in containment])

        conditions = ["root.urn = $urn"]
        params: Dict[str, Any] = {"urn": urn, "skip": offset, "lim": limit}

        if entity_types:
            types = [t.value if hasattr(t, "value") else str(t) for t in entity_types]
            params["entityTypes"] = types
            conditions.append("labels(desc)[0] IN $entityTypes")

        where = " AND ".join(conditions)
        cypher = (
            f"MATCH (root)-[:{containment_cypher}*1..{depth}]->(desc) "
            f"WHERE {where} "
            f"RETURN DISTINCT desc "
            f"SKIP $skip LIMIT $lim"
        )

        result = await self._ro_query(cypher, params=params)
        nodes = []
        for row in (result.result_set or []):
            n = self._extract_node_from_result(row)
            if n:
                nodes.append(n)
        return nodes

    async def get_nodes_by_tag(self, tag: str, limit: int = 100, offset: int = 0) -> List[GraphNode]:
        await self._ensure_connected()
        tag_pattern = json.dumps(tag)
        result = await self._ro_query(
            "MATCH (n) WHERE n.tags IS NOT NULL AND n.tags CONTAINS $tag RETURN n SKIP $skip LIMIT $limit",
            params={"tag": tag_pattern, "skip": offset, "limit": limit},
        )
        nodes = []
        for row in (result.result_set or []):
            n = self._extract_node_from_result(row)
            if n and tag in (n.tags or []):
                nodes.append(n)
        return nodes

    async def get_nodes_by_layer(
        self, layer_id: str, limit: int = 100, offset: int = 0,
        sort_direction: str = "asc", cursor: Optional[str] = None,
    ) -> List[GraphNode]:
        """Nodes with `layerAssignment = layer_id`, ordered by (displayName, urn)
        in `sort_direction`, with keyset-cursor pagination (offset fallback).

        Label-anchored UNION over the indexed label set (same pattern as
        `get_top_level_or_orphan_nodes`) so the label-scoped `layerAssignment`
        index serves the filter — a bare `MATCH (n)` cannot use label-scoped
        indexes and full-scans. Falls back to the bare match when no ontology
        vocabulary has been applied (pre-ontology graphs); a case-drifted
        physical label outside the vocabulary is, by construction, not in the
        union (mirrors the top-level path's coverage tradeoff).
        """
        await self._ensure_connected()
        sort_direction = _validate_sort_direction(sort_direction)
        from backend.app.providers.index_policy import indexed_labels

        params: Dict[str, Any] = {"lid": layer_id, "limit": int(limit)}
        cmp = "<" if sort_direction == "desc" else ">"
        dir_kw = "DESC" if sort_direction == "desc" else "ASC"

        filters = ["n.layerAssignment = $lid"]
        skip_clause = ""
        if cursor:
            cursor_name, cursor_urn = _decode_keyset_cursor(str(cursor), sort_direction)
            params["cursorName"] = cursor_name
            if cursor_urn:
                params["cursorUrn"] = cursor_urn
                filters.append(
                    f"(n.displayName {cmp} $cursorName "
                    f"OR (n.displayName = $cursorName AND n.urn {cmp} $cursorUrn))"
                )
            else:
                filters.append(f"n.displayName {cmp} $cursorName")  # legacy cursor
        else:
            params["skip"] = int(offset)
            skip_clause = " SKIP $skip"

        where = " WHERE " + " AND ".join(filters)
        order = f" ORDER BY n.displayName {dir_kw}, n.urn {dir_kw}"

        vocabulary = getattr(self, "_indexed_entity_type_ids", None)
        if vocabulary:
            branches = " UNION ".join(
                f"MATCH (n:{_sanitize_label(label)}){where} RETURN n"
                for label in indexed_labels(vocabulary)
            )
            cypher = "CALL { " + branches + " }" + f" WITH n{order}{skip_clause} LIMIT $limit RETURN n"
        else:
            cypher = f"MATCH (n){where} WITH n{order}{skip_clause} LIMIT $limit RETURN n"

        result = await self._ro_query(cypher, params=params, op="nodes.byLayer")
        nodes: List[GraphNode] = []
        for row in (result.result_set or []):
            n = self._extract_node_from_result(row[0] if isinstance(row, (list, tuple)) else row)
            if n:
                nodes.append(n)
        # Defensive re-sort (same rationale as the other keyset readers).
        return _keyset_sort(nodes, sort_direction)

    # TTL for the observed-casing maps below. Long enough to amortize the
    # vocabulary probe across a bulk load's many calls; short enough that
    # an out-of-band writer's new spelling is picked up quickly.
    _TYPE_CASING_TTL_S = 60.0

    async def _type_casing_maps(self) -> Tuple[Dict[str, str], Dict[str, str]]:
        """``casefold(name) → observed spelling`` for relationship types and
        labels, TTL-cached per provider instance. Newly-written spellings are
        added to the cached maps by ``_consistent_casing`` so consistency
        holds across calls inside the TTL window. Probe failure ⇒ empty maps
        (write-as-given) — casing consistency must never block a write."""
        now = time.monotonic()
        cached = getattr(self, "_casing_maps_cache", None)
        if cached is not None and now - cached[0] < self._TYPE_CASING_TTL_S:
            return cached[1], cached[2]
        rels: Dict[str, str] = {}
        labels: Dict[str, str] = {}
        try:
            res = await self._ro_query("CALL db.relationshipTypes()")
            for row in (res.result_set or []):
                if row and row[0]:
                    rels.setdefault(str(row[0]).casefold(), str(row[0]))
            res = await self._ro_query("CALL db.labels()")
            for row in (res.result_set or []):
                if row and row[0]:
                    labels.setdefault(str(row[0]).casefold(), str(row[0]))
        except Exception as exc:
            logger.debug(
                "type-casing vocabulary probe failed (%s) — writing types "
                "as given this window", exc,
            )
        self._casing_maps_cache = (now, rels, labels)
        return rels, labels

    @staticmethod
    def _consistent_casing(name: str, fold_map: Dict[str, str]) -> str:
        """The graph's canonical spelling for ``name``: an already-observed
        case-fold variant wins (FalkorDB matches types/labels case-
        sensitively — a second casing fragments one logical type across two
        relation matrices, and a differently-cased label makes MERGE mint a
        DUPLICATE of an existing urn node); a genuinely new spelling is
        recorded and becomes canonical for subsequent writes."""
        got = fold_map.get(name.casefold())
        if got is not None:
            return got
        fold_map[name.casefold()] = name
        return name

    async def _bulk_write_batch(self, cypher: str, params: dict, *, what: str) -> None:
        """Execute ONE bulk-load write batch, waiting out a FalkorDB restart/loading instead
        of dropping it.

        This is the line between a resumable multi-million-row load and silently losing data.
        A large load can OOM-restart the server (or trip an AOF rewrite); it comes back in a
        LOADING state that rejects writes for many seconds while it replays its dataset into
        memory. The old code caught that error, logged "batch failed", and moved on — so every
        batch during the reload window was dropped while the caller still saw success. Here we
        instead POLL until the server is ready and retry the SAME batch, and RAISE once the wait
        budget is spent so the caller fails loudly with an accurate progress count. Real errors
        (bad cypher, constraint) are never retried — they raise immediately."""
        try:
            max_wait = float(os.getenv("FALKORDB_LOAD_MAX_WAIT_S", "900"))   # a big graph can take minutes to reload
        except ValueError:
            max_wait = 900.0
        try:
            delay = float(os.getenv("FALKORDB_LOAD_RETRY_BASE_S", "0.5"))
        except ValueError:
            delay = 0.5
        waited = 0.0
        attempt = 0
        while True:
            attempt += 1
            try:
                await self._query(cypher, params=params)
                if attempt > 1:
                    logger.info(
                        "FalkorDB %s: %s written after waiting %.0fs for the server to come back.",
                        self._graph_name, what, waited,
                    )
                return
            except Exception as exc:
                # ProviderUnavailable covers ProviderLoading (its subclass). Anything else that
                # is a transient connection / redis-loading error is also worth waiting out.
                from backend.common.adapters import ProviderUnavailable
                recoverable = (
                    isinstance(exc, ProviderUnavailable)
                    or _is_loading_error(exc)
                    or _is_transient_connection_error(exc)
                )
                if not recoverable or waited >= max_wait:
                    logger.error(
                        "FalkorDB %s: %s could not be written (%s) after %.0fs — aborting the "
                        "load instead of dropping the batch.",
                        self._graph_name, what, type(exc).__name__, waited,
                    )
                    raise
                await asyncio.sleep(delay)
                waited += delay
                delay = min(delay * 1.5, 5.0)
                try:
                    await self._ensure_connected()   # rebuild the handle a restart invalidated
                except Exception:
                    pass                             # the next _query re-attempts the connection

    async def save_custom_graph(
        self, nodes: List[GraphNode], edges: List[GraphEdge],
        endpoint_labels: Optional[Dict[str, str]] = None,
    ) -> bool:
        """Batch-save nodes and edges using UNWIND for bulk writes.

        Groups nodes by label (entity type) so each UNWIND+MERGE targets
        a single label — enabling index-assisted lookups. Turns N individual
        queries into ceil(N/batch_size) queries per label.

        Edges are likewise grouped by (relationship type, source label, target
        label) so the endpoint MATCH carries a label and hits the per-label urn
        index (``Node By Index Scan``) instead of an ``All Node Scan`` — the
        difference between ~180k and ~90 edges/s on a large graph. Endpoint
        labels are resolved from the nodes saved in THIS call plus the optional
        ``endpoint_labels`` (urn→entityType) the caller supplies for edges whose
        endpoints were saved in a previous call (the importer's separate node/
        edge passes). An endpoint with no known label falls back to a label-less
        MATCH (correct, just unindexed) — never a dropped edge.

        ``FALKORDB_SAVE_BATCH_SIZE`` tunes the UNWIND batch size (default
        2000, clamped 100-10000): larger batches amortize parse/plan
        overhead on multi-million-row initial loads; smaller ones bound
        single-query time on constrained instances.
        """
        await self._ensure_connected()
        try:
            batch_size = max(100, min(10000, int(os.getenv("FALKORDB_SAVE_BATCH_SIZE", "2000"))))
        except ValueError:
            batch_size = 2000

        # Observed-casing maps: everything this call CREATES is written in
        # the graph's existing casing (or mints the canonical one) so one
        # logical type/label never fragments across case variants.
        rel_casing, label_casing = await self._type_casing_maps()

        # Group nodes by label for label-specific MERGE
        nodes_by_label: Dict[str, list] = defaultdict(list)
        for node in nodes:
            label = self._consistent_casing(
                _sanitize_label(str(node.entity_type)), label_casing,
            )
            native_props, residual_blob = _split_user_properties(node.properties)
            nodes_by_label[label].append({
                "urn": node.urn,
                "displayName": node.display_name or "",
                "qualifiedName": node.qualified_name or "",
                "description": node.description or "",
                "nativeProps": native_props,
                "propertiesRaw": residual_blob,
                "tags": json.dumps(node.tags or []),
                "layerAssignment": node.layer_assignment or "",
                "childCount": node.child_count or 0,
                "sourceSystem": node.source_system or "",
                "lastSyncedAt": node.last_synced_at or "",
                "level": self._get_node_level(node.entity_type),
                "searchableText": _compute_searchable_text(
                    node.display_name, node.qualified_name,
                    node.description, native_props, tags=node.tags,
                ),
            })

        # Ensure per-label URN indexes BEFORE the writes: node MERGE and
        # edge MATCH both look up by urn, and without the index each row
        # is a label scan. Once per provider instance — CREATE INDEX is
        # idempotent but there's no point re-issuing DDL per chunk.
        if nodes_by_label and not getattr(self, "_save_indices_ensured", False):
            try:
                await self.ensure_indices(list(nodes_by_label.keys()))
                self._save_indices_ensured = True
            except Exception as exc:
                logger.warning(
                    "save_custom_graph: ensure_indices failed (continuing; "
                    "writes will be slower without URN indexes): %s", exc,
                )

        # Bulk-cache urn→label mappings
        label_mapping = {}
        for label, items in nodes_by_label.items():
            for item in items:
                label_mapping[item["urn"]] = label
            for i in range(0, len(items), batch_size):
                batch = items[i : i + batch_size]
                try:
                    # Notes on the SET / REMOVE shape:
                    # - `n += item.nativeProps` merges user-supplied scalar
                    #   properties as real node fields. Merge semantics —
                    #   keys that disappear across upserts are NOT removed
                    #   (delete via an explicit op if needed). This matches
                    #   how every other reserved field is upserted here.
                    # - `n.propertiesRaw` always written (always a string,
                    #   "{}" when empty) so we don't need a separate REMOVE
                    #   round-trip when the residual goes empty.
                    # - `REMOVE n.properties` strips the legacy blob on
                    #   every write so the read-path transitional code
                    #   becomes dead weight as soon as a node is touched.
                    # - `n.level = coalesce(item.level, n.level)` keeps the
                    #   pre-refactor semantics: if the engine hasn't
                    #   injected the entity-type→level map yet (seed-from-
                    #   file before ontology resolution), level stays as-is.
                    await self._bulk_write_batch(
                        f"UNWIND $batch AS item "
                        f"MERGE (n:{label} {{urn: item.urn}}) "
                        f"SET n.displayName = item.displayName, "
                        f"n.qualifiedName = item.qualifiedName, "
                        f"n.description = item.description, "
                        f"n.tags = item.tags, "
                        f"n.layerAssignment = item.layerAssignment, "
                        f"n.childCount = item.childCount, "
                        f"n.sourceSystem = item.sourceSystem, "
                        f"n.lastSyncedAt = item.lastSyncedAt, "
                        f"n.propertiesRaw = item.propertiesRaw, "
                        f"n.level = coalesce(item.level, n.level), "
                        f"n.searchableText = item.searchableText, "
                        f"n += item.nativeProps "
                        f"REMOVE n.properties",
                        {"batch": batch},
                        what=f"node batch :{label}",
                    )
                except Exception as e:
                    logger.error(f"Node merge failed for label {label}: {e}")
                    raise
        await self._cache_urn_labels_bulk(label_mapping)

        # urn → label for endpoint MATCH: same-call nodes (authoritative) over
        # the caller-supplied map (endpoints saved in a prior call). Resolve ONLY the
        # endpoints referenced by THIS call's edges — ``endpoint_labels`` can be the whole
        # graph (millions of urns), so iterating/sanitizing all of it per call is O(graph)
        # per batch (~1.4s/10k-chunk at 2M nodes → ~11min of pure Python for a 5M-edge
        # load). A small value cache avoids re-sanitizing the handful of distinct labels.
        referenced = {u for e in edges for u in (e.source_urn, e.target_urn)}
        urn_label: Dict[str, str] = {}
        _san_cache: Dict[str, str] = {}
        for urn in referenced:
            lbl = label_mapping.get(urn)          # already sanitized (same-call node)
            if lbl is None and endpoint_labels:
                raw = endpoint_labels.get(urn)
                if raw is not None:
                    lbl = _san_cache.get(raw)
                    if lbl is None:
                        lbl = _sanitize_label(str(raw))
                        _san_cache[raw] = lbl
            if lbl is not None:
                urn_label[urn] = lbl

        # Endpoints still unknown (edges into nodes saved in a prior call
        # with no caller-supplied label): resolve through the urn→label
        # cache / graph in one bulk pass so they hit the indexed MATCH
        # too; anything unresolvable keeps the label-less fallback below.
        unknown = list(referenced - set(urn_label))
        if unknown:
            try:
                resolved = await self._resolve_urn_labels_bulk(unknown)
                urn_label.update(
                    {u: lbl for u, lbl in resolved.items() if lbl}
                )
            except Exception as exc:
                logger.warning(
                    "save_custom_graph: bulk urn→label resolve failed (%s) — "
                    "%d endpoint(s) fall back to unlabeled matches",
                    exc, len(unknown),
                )

        # Group edges by (relationship type, source label, target label) so each
        # UNWIND's endpoint MATCH is label-qualified (index-eligible). A None label
        # means "unknown endpoint" → label-less MATCH (correct, unindexed fallback).
        edges_grouped: Dict[tuple, list] = defaultdict(list)
        for edge in edges:
            rel_type = self._consistent_casing(
                _sanitize_label(str(edge.edge_type)), rel_casing,
            )
            key = (rel_type, urn_label.get(edge.source_urn), urn_label.get(edge.target_urn))
            edges_grouped[key].append({
                "src": edge.source_urn,
                "tgt": edge.target_urn,
                "eid": edge.id,
                "conf": edge.confidence,
                "props": json.dumps(edge.properties),
            })

        for (rel_type, src_label, tgt_label), items in edges_grouped.items():
            a_pat = f"(a:{src_label} {{urn: item.src}})" if src_label else "(a {urn: item.src})"
            b_pat = f"(b:{tgt_label} {{urn: item.tgt}})" if tgt_label else "(b {urn: item.tgt})"
            for i in range(0, len(items), batch_size):
                batch = items[i : i + batch_size]
                await self._bulk_write_batch(
                    f"UNWIND $batch AS item "
                    f"MATCH {a_pat} "
                    f"MATCH {b_pat} "
                    f"MERGE (a)-[r:{rel_type}]->(b) "
                    f"SET r.id = item.eid, r.confidence = item.conf, "
                    f"r.properties = item.props",
                    {"batch": batch},
                    what=f"edge batch :{rel_type}",
                )

        return True

    async def create_node(self, node: GraphNode, containment_edge: Optional[GraphEdge] = None) -> bool:
        await self._ensure_connected()
        try:
            rel_casing, label_casing = await self._type_casing_maps()
            label = self._consistent_casing(
                _sanitize_label(str(node.entity_type)), label_casing,
            )
            native_props, residual_blob = _split_user_properties(node.properties)
            # Reserved fields go into the merge map alongside native user
            # props — `SET n += $p` writes them all in one pass. The native
            # user props sit at the top level of the map (they ARE the new
            # node fields); the legacy blob is stripped via REMOVE.
            params: Dict[str, Any] = {
                "displayName": node.display_name or "",
                "qualifiedName": node.qualified_name or "",
                "description": node.description or "",
                "propertiesRaw": residual_blob,
                "tags": json.dumps(node.tags or []),
                "layerAssignment": node.layer_assignment or "",
                "sourceSystem": node.source_system or "",
                "lastSyncedAt": node.last_synced_at or "",
                "searchableText": _compute_searchable_text(
                    node.display_name, node.qualified_name,
                    node.description, native_props, tags=node.tags,
                ),
            }
            if node.child_count is not None:
                params["childCount"] = node.child_count
            # Only include level when the engine has injected the mapping;
            # otherwise omit the key so SET n += $p doesn't overwrite an
            # existing level with null.
            level = self._get_node_level(node.entity_type)
            if level is not None:
                params["level"] = level
            # Merge native user props on top — they become real node
            # fields. Reserved-key collisions were already dropped by
            # _split_user_properties so this is safe.
            params.update(native_props)
            await self._query(
                f"MERGE (n:{label} {{urn: $urn}}) SET n += $p REMOVE n.properties",
                params={"urn": node.urn, "p": params},
            )
            await self._cache_urn_label(node.urn, label)
            if containment_edge:
                rel_type = self._consistent_casing(
                    _sanitize_label(str(containment_edge.edge_type)), rel_casing,
                )
                await self._query(
                    f"""
                    MATCH (a {{urn: $src}}) MATCH (b {{urn: $tgt}})
                    MERGE (a)-[r:{rel_type}]->(b)
                    SET r.id = $eid, r.confidence = $conf, r.properties = $props
                    """,
                    params={
                        "src": containment_edge.source_urn,
                        "tgt": containment_edge.target_urn,
                        "eid": containment_edge.id,
                        "conf": containment_edge.confidence,
                        # Write r.properties like every other edge writer — it was omitted here, so a
                        # containment edge created with properties lost them until the next rebuild.
                        "props": json.dumps(containment_edge.properties or {}),
                    },
                )
            return True
        except Exception as e:
            logger.error(f"create_node failed: {e}")
            return False

    async def create_edge(self, edge: GraphEdge) -> bool:
        """Create a single edge in FalkorDB."""
        await self._ensure_connected()
        try:
            rel_casing, _ = await self._type_casing_maps()
            rel_type = self._consistent_casing(
                _sanitize_label(str(edge.edge_type)), rel_casing,
            )
            await self._query(
                f"MATCH (a {{urn: $src}}) MATCH (b {{urn: $tgt}}) "
                f"MERGE (a)-[r:{rel_type}]->(b) "
                f"SET r.id = $eid, r.confidence = $conf, r.properties = $props",
                params={
                    "src": edge.source_urn,
                    "tgt": edge.target_urn,
                    "eid": edge.id,
                    # Pass confidence through RAW (may be None) — matching save_custom_graph, the
                    # projector reseed, and create_node's containment edge. `edge.confidence or 1.0`
                    # silently rewrote a legitimate 0.0 (and None) to 1.0, fabricating a value the
                    # rebuild round-trip would then treat as real.
                    "conf": edge.confidence,
                    "props": json.dumps(edge.properties or {}),
                },
            )
            return True
        except Exception as e:
            logger.error(f"create_edge failed: {e}")
            return False

    async def update_edge(self, edge_id: str, properties: Dict[str, Any]) -> Optional[GraphEdge]:
        """Update edge properties by edge ID."""
        await self._ensure_connected()
        try:
            result = await self._query(
                "MATCH (a)-[r]->(b) WHERE r.id = $eid "
                "SET r.properties = $props "
                "RETURN a.urn, b.urn, type(r), properties(r)",
                params={"eid": edge_id, "props": json.dumps(properties)},
            )
            if not result.result_set:
                return None
            row = result.result_set[0]
            return _edge_from_row(row[0], row[1], row[2], row[3] or {})
        except Exception as e:
            logger.error(f"update_edge failed: {e}")
            return None

    async def delete_edge(self, edge_id: str) -> bool:
        """Delete an edge by its ID property."""
        await self._ensure_connected()
        try:
            result = await self._query(
                "MATCH ()-[r]->() WHERE r.id = $eid DELETE r RETURN count(r)",
                params={"eid": edge_id},
            )
            if result.result_set and result.result_set[0][0] > 0:
                return True
            return False
        except Exception as e:
            logger.error(f"delete_edge failed: {e}")
            return False
