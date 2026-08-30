"""FalkorDB parent/child and top-level browse queries — ``BrowseMixin``.

Carved from ``backend/app/providers/falkordb/provider.py``'s
``FalkorDBProvider`` class body as it stood before this split:
``get_children`` through ``get_top_level_or_orphan_nodes`` (lines
537-1113), a single contiguous block.

``get_children_with_edges`` re-sorts defensively via ``_keyset_sort``
before minting its ``next_cursor``, to survive FalkorDB discarding an
``ORDER BY`` around an aggregating ``RETURN`` — a real, documented engine
behaviour that costs nothing to defend against.
``get_top_level_or_orphan_nodes`` accepts ``known_total_count`` and
``query_timeout`` kwargs that ``ContextEngine`` passes only when the
signature has them (it inspects), so the signature is unchanged here.
See ``docs/superpowers/plans/2026-08-30-pr1-falkordb-decoupling.md`` §2.2 for why this has
to be a mixin rather than a delegate/helper object.
"""
import asyncio
from typing import Any, Dict, List, Optional

from backend.app.models.graph import (
    GraphNode, GraphEdge, ChildrenWithEdgesResult, TopLevelNodesResult,
)
from backend.app.providers.falkordb._log import logger
from backend.app.providers.falkordb.rowmap import _sanitize_label, _edge_from_row
from backend.app.providers.falkordb.cursors import (
    _decode_keyset_cursor,
    _encode_keyset_cursor,
    _validate_sort_direction,
    _keyset_sort,
)


class BrowseMixin:
    """Parent/child navigation and top-level (root/orphan) node
    listing."""

    async def get_children(
        self,
        parent_urn: str,
        entity_types: Optional[List[str]] = None,
        edge_types: Optional[List[str]] = None,
        search_query: Optional[str] = None,
        offset: int = 0,
        limit: int = 100,
        sort_property: Optional[str] = "displayName",
        cursor: Optional[str] = None,
        sort_direction: str = "asc",
    ) -> List[GraphNode]:
        await self._ensure_connected()
        sort_direction = _validate_sort_direction(sort_direction)
        # None = caller didn't specify, use ontology/fallback; [] = explicitly no containment
        target_edge_types = set(self._alias_rel_types(edge_types)) if edge_types is not None else set(self._get_containment_edge_types())
        rel_list = list(target_edge_types)
        if not rel_list:
            # No containment types defined — hierarchy is flat, no children exist
            return []

        search_where = ""
        params: Dict[str, Any] = {"parent": parent_urn, "lim": limit, "relTypes": rel_list}

        if search_query:
            search_where = "AND (toLower(c.displayName) CONTAINS toLower($searchQuery) OR toLower(c.urn) CONTAINS toLower($searchQuery)) "
            params["searchQuery"] = search_query

        # Keyset pagination (O(log N) with FalkorDB indices vs O(N) for SKIP).
        # COMPOSITE on (displayName, urn) — displayName is not unique, and a
        # non-unique keyset drops rows at page boundaries (_encode_keyset_cursor).
        cursor_where = ""
        cmp = "<" if sort_direction == "desc" else ">"
        if cursor:
            cursor_name, cursor_urn = _decode_keyset_cursor(cursor, sort_direction)
            params["cursorName"] = cursor_name
            if cursor_urn:
                cursor_where = (
                    f"AND (c.displayName {cmp} $cursorName "
                    f"OR (c.displayName = $cursorName AND c.urn {cmp} $cursorUrn)) "
                )
                params["cursorUrn"] = cursor_urn
            else:
                cursor_where = f"AND c.displayName {cmp} $cursorName "  # legacy cursor
        else:
            # Fallback to offset when no cursor (first page or legacy callers)
            params["skip"] = offset

        # ORDER BY must match the keyset exactly, or paging skips/repeats rows.
        order_suffix = ""
        if sort_property:
            safe_prop = _sanitize_label(sort_property)
            dir_kw = " DESC" if sort_direction == "desc" else ""
            order_suffix = f" ORDER BY c.{safe_prop}{dir_kw}, c.urn{dir_kw}"

        # Use SKIP only when no cursor is provided (first page)
        skip_clause = "" if cursor else " SKIP $skip"

        if len(rel_list) == 1:
            rel = _sanitize_label(rel_list[0])
            cypher = (
                f"MATCH (p)-[r:{rel}]->(c) "
                f"WHERE p.urn = $parent {search_where}{cursor_where}"
                f"WITH c{order_suffix}{skip_clause} LIMIT $lim "
                f"OPTIONAL MATCH (c)-[rc]->(gc) WHERE type(rc) IN $relTypes "
                f"RETURN c, count(gc) as childCount"
            )
        else:
            cypher = (
                f"MATCH (p)-[r]->(c) "
                f"WHERE p.urn = $parent AND type(r) IN $relTypes {search_where}{cursor_where}"
                f"WITH c{order_suffix}{skip_clause} LIMIT $lim "
                f"OPTIONAL MATCH (c)-[rc]->(gc) WHERE type(rc) IN $relTypes "
                f"RETURN c, count(gc) as childCount"
            )

        from backend.app.config.resilience import FALKORDB_CHILDREN_QUERY_TIMEOUT_SECS
        result = await self._ro_query(cypher, params=params, timeout=FALKORDB_CHILDREN_QUERY_TIMEOUT_SECS, op="children.page")
        # Align the entity-type post-filter to the graph's observed label spelling (Task E),
        # so a declared `Table` still matches a TABLE-graph node. Identity for governed graphs.
        entity_types = self._alias_entity_types(entity_types) if entity_types else entity_types
        nodes = []
        for row in (result.result_set or []):
            # Extract node and childCount
            n = self._extract_node_from_result(row[0])
            child_count = row[1]
            if n and (not entity_types or n.entity_type in entity_types):
                # Valid dynamic child count overrides static property if present, or fills gap
                if child_count is not None:
                    n.child_count = int(child_count)
                    # Also update properties so it serializes correctly if needed (though Pydantic model uses field)
                    if n.properties:
                        n.properties['childCount'] = int(child_count)
                nodes.append(n)
        return nodes

    async def get_children_with_edges(
        self,
        parent_urn: str,
        edge_types: Optional[List[str]] = None,
        lineage_edge_types: Optional[List[str]] = None,
        search_query: Optional[str] = None,
        offset: int = 0,
        limit: int = 100,
        include_lineage_edges: bool = True,
        sort_property: Optional[str] = "displayName",
        cursor: Optional[str] = None,
        sort_direction: str = "asc",
    ) -> ChildrenWithEdgesResult:
        """Optimized single-roundtrip: children + containment edges + cross-child lineage edges.

        Supports cursor-based pagination for O(log N) performance at any page depth.
        When `cursor` is provided, it takes precedence over `offset`.
        """
        await self._ensure_connected()
        sort_direction = _validate_sort_direction(sort_direction)

        # --- Step 1: Fetch children with containment edges (returns edge r) ---
        target_edge_types = set(self._alias_rel_types(edge_types)) if edge_types is not None else set(self._get_containment_edge_types())
        lineage_edge_types = self._alias_rel_types(lineage_edge_types) if lineage_edge_types else lineage_edge_types
        rel_list = list(target_edge_types)
        if not rel_list:
            # No containment types — return empty result
            return ChildrenWithEdgesResult(
                children=[], containmentEdges=[], lineageEdges=[],
                totalChildren=0, hasMore=False,
            )

        search_where = ""
        params: Dict[str, Any] = {"parent": parent_urn, "lim": limit, "relTypes": rel_list}

        if search_query:
            search_where = "AND (toLower(c.displayName) CONTAINS toLower($searchQuery) OR toLower(c.urn) CONTAINS toLower($searchQuery)) "
            params["searchQuery"] = search_query

        # Keyset pagination, O(log N) vs SKIP's O(N). The keyset is COMPOSITE
        # (displayName, urn): displayName alone is not unique, and a non-unique
        # keyset silently drops every row sharing the boundary row's name — see
        # _encode_keyset_cursor.
        cursor_where = ""
        cmp = "<" if sort_direction == "desc" else ">"
        if cursor:
            cursor_name, cursor_urn = _decode_keyset_cursor(cursor, sort_direction)
            params["cursorName"] = cursor_name
            if cursor_urn:
                cursor_where = (
                    f"AND (c.displayName {cmp} $cursorName "
                    f"OR (c.displayName = $cursorName AND c.urn {cmp} $cursorUrn)) "
                )
                params["cursorUrn"] = cursor_urn
            else:
                # Legacy cursor minted before the tiebreaker existed.
                cursor_where = f"AND c.displayName {cmp} $cursorName "
        else:
            params["skip"] = offset

        # ORDER BY must match the keyset exactly, or paging skips/repeats rows.
        order_suffix = ""
        if sort_property:
            safe_prop = _sanitize_label(sort_property)
            dir_kw = " DESC" if sort_direction == "desc" else ""
            order_suffix = f" ORDER BY c.{safe_prop}{dir_kw}, c.urn{dir_kw}"

        skip_clause = "" if cursor else " SKIP $skip"

        # Query returns child node, containment edge properties, and grandchild count.
        # Anchors + relationships are index-friendly (root cause of the 5-11s
        # children reads on multi-million-node graphs):
        #  * the parent match is label-qualified via the urn→label cache so it
        #    is a URN-index seek, not an All-Node-Scan (this build has no
        #    label-less URN index — unlabeled residue keeps the old pattern);
        #  * relationship types are pattern alternations ([r:HAS|PART_OF]),
        #    not post-hoc `type(r) IN` filters, so the traversal never visits
        #    edges of other types on hub nodes (both r and the grandchild rc).
        rel_alt = "|".join(_sanitize_label(t) for t in rel_list)
        parent_label = await self._get_cached_label(parent_urn)
        p_anchor = f"(p:{_sanitize_label(parent_label)})" if parent_label else "(p)"
        cypher = (
            f"MATCH {p_anchor}-[r:{rel_alt}]->(c) "
            f"WHERE p.urn = $parent {search_where}{cursor_where}"
            f"WITH p, r, c{order_suffix}{skip_clause} LIMIT $lim "
            f"OPTIONAL MATCH (c)-[rc:{rel_alt}]->(gc) "
            f"RETURN c, count(gc) as childCount, p.urn as parentUrn, type(r) as relType, properties(r) as rprops"
        )

        from backend.app.config.resilience import FALKORDB_CHILDREN_QUERY_TIMEOUT_SECS
        result = await self._ro_query(cypher, params=params, timeout=FALKORDB_CHILDREN_QUERY_TIMEOUT_SECS, op="children.page")

        children: List[GraphNode] = []
        containment_edges: List[GraphEdge] = []
        child_urns: List[str] = []

        for row in (result.result_set or []):
            n = self._extract_node_from_result(row[0])
            child_count = row[1]
            parent_u = row[2]
            rel_type = row[3]
            rprops = row[4] or {}

            if n:
                if child_count is not None:
                    n.child_count = int(child_count)
                    if n.properties:
                        n.properties['childCount'] = int(child_count)
                children.append(n)
                child_urns.append(n.urn)

                # Build containment edge from the matched relationship
                containment_edges.append(_edge_from_row(parent_u, n.urn, rel_type, rprops))

        # --- Step 2: Fetch cross-child lineage edges (scoped to current page only) ---
        # Only use the current page's child URNs + parent, NOT cumulative URNs.
        # This keeps the query O(pageSize²) instead of O(totalLoaded²).
        lineage_edges_list: List[GraphEdge] = []
        if include_lineage_edges and len(child_urns) >= 2:
            page_urns = [parent_urn] + child_urns
            exclude_types = list(target_edge_types) + ["AGGREGATED"]

            # Prefer a TYPED alternation: explicit lineage types from the
            # caller, else the resolved ontology's lineage set. The untyped
            # NOT-filter form survives only for graphs with no resolved
            # lineage vocabulary (pre-ontology) — there is nothing to type on.
            effective_lineage = lineage_edge_types or [
                t for t in self._get_lineage_edge_types() if t
            ]
            lineage_params: Dict[str, Any] = {"pageUrns": page_urns}
            if effective_lineage:
                # Case-INSENSITIVE match. A rebuild reseeds edges with the type spelling stored in
                # the Postgres payload, and the reader's ontology→observed alias map can be stale
                # (a projection rebuild does NOT invalidate resolved_ontology_cache), so a
                # case-sensitive `[lr:Type]` alternation silently misses a differently-cased stored
                # spelling → raw lineage edges vanish from the canvas. Matching on
                # `toUpper(type(lr))` renders them regardless of stored casing / alias freshness.
                # This lineage step is already page-scoped (a.urn IN $bucketUrns AND b.urn IN
                # $pageUrns), so the untyped scan is over a tiny neighborhood. (Containment step 1
                # keeps its typed alternation — a deliberate hub-node index optimization, and its
                # canonical-uppercase types already match.)
                lr_pattern = "[lr]"
                lineage_where = "AND toUpper(type(lr)) IN $lineageUpper "
                lineage_params["lineageUpper"] = [_sanitize_label(t).upper() for t in effective_lineage]
            else:
                lr_pattern, lineage_where = "[lr]", "AND NOT type(lr) IN $excludeTypes "
                lineage_params["excludeTypes"] = exclude_types

            # Anchor `a` per label bucket (urn-index seeks); `b` stays an
            # IN-filter over the small page set after the typed traversal.
            async def _lineage_for(label: str, bucket: List[str]) -> list:
                a_anchor = f"(a:{label})" if label else "(a)"
                try:
                    res = await self._ro_query(
                        f"MATCH {a_anchor}-{lr_pattern}->(b) "
                        f"WHERE a.urn IN $bucketUrns AND b.urn IN $pageUrns {lineage_where}"
                        f"RETURN a.urn, b.urn, type(lr), properties(lr)",
                        params={**lineage_params, "bucketUrns": bucket},
                        timeout=FALKORDB_CHILDREN_QUERY_TIMEOUT_SECS,
                        op="children.lineage",
                    )
                    return res.result_set or []
                except Exception as exc:
                    logger.warning("children page-lineage query failed: %s", exc)
                    return []

            lineage_rows = await asyncio.gather(*[
                _lineage_for(label, bucket)
                for label, bucket in await self._label_buckets(page_urns)
            ])
            for rows in lineage_rows:
                for row in rows:
                    lineage_edges_list.append(_edge_from_row(row[0], row[1], row[2], row[3] or {}))

        has_more = len(children) >= limit
        total = offset + len(children) + (1 if has_more else 0)
        # Defensive re-sort before deriving the keyset cursor: FalkorDB may
        # discard ORDER BY around an aggregating RETURN (count(gc) here), and
        # the cursor MUST be the page's boundary sort key or keyset pagination
        # skips rows. LIMIT selection is unaffected (known engine behaviour).
        # Sorts on (displayName, urn) — the same composite key the cursor uses,
        # in the requested direction.
        if sort_property == "displayName" and children:
            # Derive the index permutation from _keyset_sort (the single
            # source of keyset order, incl. the DESC prefix semantics) so the
            # paired containment_edges list stays aligned with its child.
            ordered = _keyset_sort(list(children), sort_direction)
            index_of = {id(node): i for i, node in enumerate(children)}
            order = [index_of[id(node)] for node in ordered]
            children = [children[i] for i in order]
            containment_edges = [containment_edges[i] for i in order]
            child_urns = [children[i].urn for i in range(len(children))]
        next_cursor = (
            _encode_keyset_cursor(children[-1].display_name, children[-1].urn, sort_direction)
            if children and has_more else None
        )

        return ChildrenWithEdgesResult(
            children=children,
            containmentEdges=containment_edges,
            lineageEdges=lineage_edges_list,
            totalChildren=total,
            hasMore=has_more,
            nextCursor=next_cursor,
        )

    async def get_parent(self, child_urn: str) -> Optional[GraphNode]:
        await self._ensure_connected()
        containment = self._get_containment_edge_types()
        if not containment:
            # No containment types — flat graph, no parent
            return None
        # Match any containment-type edge where child is target — typed
        # alternation + label-seeked child anchor (index seek, no scan).
        c_alt = "|".join(_sanitize_label(t) for t in containment if t)
        child_label = await self._get_cached_label(child_urn)
        c_anchor = (
            f"(c:{_sanitize_label(child_label)} {{urn: $child}})"
            if child_label else "(c {urn: $child})"
        )
        result = await self._ro_query(
            f"MATCH (p)-[r:{c_alt}]->{c_anchor} RETURN p",
            params={"child": child_urn},
            op="nodes.parent",
        )
        if result.result_set and len(result.result_set) > 0:
            return self._extract_node_from_result(result.result_set[0])
        return None

    async def get_top_level_or_orphan_nodes(
        self,
        *,
        root_entity_types: Optional[List[str]] = None,
        entity_types: Optional[List[str]] = None,
        search_query: Optional[str] = None,
        limit: int = 100,
        cursor: Optional[str] = None,
        include_child_count: bool = True,
        query_timeout: Optional[float] = None,
        known_total_count: Optional[int] = None,
        sort_direction: str = "asc",
    ) -> TopLevelNodesResult:
        """Return structurally top-level nodes (no incoming containment edge).

        Mixes ontology root-type instances and orphan non-root instances so the
        wizard can show both in one list, with a root/orphan split in the
        badge text. Classification is done in Python on the returned rows.

        Pagination is cursor-based on displayName for stability under writes:
        callers pass cursor=None for the first page and the returned
        next_cursor for subsequent pages.

        query_timeout overrides the default per-query timeout for both the
        page and count queries. known_total_count, when given, skips the
        count query entirely and uses the value directly (e.g. a caller
        serving from a materialized cache that already knows the total).
        """
        await self._ensure_connected()
        sort_direction = _validate_sort_direction(sort_direction)

        from backend.app.config.resilience import (
            FALKORDB_TOP_LEVEL_COUNT_TIMEOUT_SECS,
            FALKORDB_TOP_LEVEL_QUERY_TIMEOUT_SECS,
        )
        t = query_timeout if query_timeout is not None else FALKORDB_TOP_LEVEL_QUERY_TIMEOUT_SECS
        # Count is best-effort with a shorter budget (display-only); an
        # explicit query_timeout (e.g. the collector's materialization)
        # keeps its generous budget for both queries.
        ct = query_timeout if query_timeout is not None else FALKORDB_TOP_LEVEL_COUNT_TIMEOUT_SECS

        # Raises ProviderConfigurationError if no types resolvable — surfaced
        # as HTTP 400 by the endpoint. An empty set is a valid state meaning
        # "flat graph, every node is top-level".
        containment = self._get_containment_edge_types()
        containment_rel_types = "|".join([_sanitize_label(t) for t in sorted(containment)])
        # Align entity-type labels/roots to the source's observed spellings (labels are
        # case-sensitive too), so root classification and the label-union filter match.
        root_entity_types = self._alias_entity_types(root_entity_types)
        entity_types = self._alias_entity_types(entity_types)
        root_types_set = {str(t) for t in (root_entity_types or [])}

        params: Dict[str, Any] = {"limit": int(limit)}

        # ── Build optional filters ────────────────────────────────────────
        # Each filter produces a WHERE fragment applied uniformly to both the
        # page query and the count query.
        filter_fragments: List[str] = []

        if search_query:
            params["search"] = search_query.lower()
            filter_fragments.append(
                "(toLower(toString(n.displayName)) CONTAINS $search "
                "OR toLower(toString(n.urn)) CONTAINS $search)"
            )

        # Structural top-level predicate — the whole point of this method.
        # Empty containment set = flat graph, skip the predicate entirely.
        #
        # Direction-reversed from the original `NOT ()-[:T]->(n)` so n
        # (already bound by the outer MATCH) is the anchor of the pattern.
        # Same semantics — "no incoming :T edge to n" — but the planner
        # walks n's incoming adjacency list directly instead of scanning
        # all :T relationships. Avoids the O(N) full-graph scan that was
        # a top contributor to the FalkorDB CPU pin under load.
        #
        # IMPORTANT: keep the openCypher-1.0 pattern-negation form. Do NOT
        # rewrite to `NOT EXISTS { MATCH ... }` — that is Neo4j 4.x+ / ISO
        # GQL syntax and is NOT supported by FalkorDB. The subquery form
        # silently throws, gets caught below, and returns empty — which
        # was the original bug.
        if containment_rel_types:
            filter_fragments.append(
                self.dialect.no_incoming_pattern("n", containment_rel_types)
            )

        # ── Build MATCH clause: label UNION if entity_types specified ─────
        use_label_union = bool(entity_types)
        safe_types: List[str] = []
        if use_label_union:
            safe_types = [_sanitize_label(str(t)) for t in entity_types if str(t)]
            if not safe_types:
                use_label_union = False

        # Page-query cursor: keyset over (displayName, urn) for stability under
        # writes. The urn tiebreaker is what makes the key UNIQUE — without it a
        # run of same-named nodes straddling a page boundary is silently dropped
        # (_encode_keyset_cursor).
        page_filters = list(filter_fragments)
        cmp = "<" if sort_direction == "desc" else ">"
        if cursor is not None:
            cursor_name, cursor_urn = _decode_keyset_cursor(str(cursor), sort_direction)
            params["cursorName"] = cursor_name
            if cursor_urn:
                params["cursorUrn"] = cursor_urn
                page_filters.append(
                    f"(n.displayName {cmp} $cursorName "
                    f"OR (n.displayName = $cursorName AND n.urn {cmp} $cursorUrn))"
                )
            else:
                page_filters.append(f"n.displayName {cmp} $cursorName")  # legacy cursor

        def _build_match(filters: List[str]) -> str:
            where_clause = (" WHERE " + " AND ".join(filters)) if filters else ""
            if use_label_union:
                return self.dialect.label_union(safe_types, where_clause)
            return f"MATCH (n){where_clause}"

        # ── Page query ────────────────────────────────────────────────────
        dir_kw = "DESC" if sort_direction == "desc" else "ASC"
        if include_child_count and containment_rel_types:
            page_cypher = (
                _build_match(page_filters)
                + f" WITH n ORDER BY n.displayName {dir_kw}, n.urn {dir_kw} LIMIT $limit"
                + f" OPTIONAL MATCH (n)-[:{containment_rel_types}]->(child)"
                # Re-project through a non-aggregating WITH before ORDER BY:
                # FalkorDB discards an ORDER BY that sits directly on an
                # aggregating RETURN (and also a trailing RETURN ... ORDER BY),
                # so the pre-aggregation window order is lost. Materializing the
                # count into a WITH first, then ordering that WITH, restores the
                # displayName-ordered output the keyset cursor depends on.
                + f" WITH n, count(child) as childCount ORDER BY n.displayName {dir_kw}, n.urn {dir_kw}"
                + " RETURN n, childCount"
            )
        else:
            page_cypher = (
                _build_match(page_filters)
                + f" WITH n ORDER BY n.displayName {dir_kw}, n.urn {dir_kw} LIMIT $limit"
                + " RETURN n, 0 as childCount"
            )

        try:
            page_result = await self._ro_query(page_cypher, params=params, timeout=t, op="toplevel.page")
        except asyncio.TimeoutError as e:
            # Same type (GraphCache stale-fallback and the 503 handler match
            # on it) but with a non-empty str() so the surfaced reason names
            # the budget that actually fired instead of a blank string.
            raise asyncio.TimeoutError(
                f"top-level page query exceeded {t:.0f}s provider budget "
                f"(graph={self._graph_name})"
            ) from e
        except Exception as e:
            if not await self._is_verified_missing_graph(e):
                logger.warning(f"get_top_level_or_orphan_nodes page query failed: {e}")
                raise  # connection refused / transient = surface it (breaker -> 503)
            page_result = None  # never-created / empty key = legitimately no data

        nodes: List[GraphNode] = []
        root_type_count = 0
        orphan_count = 0
        if page_result and page_result.result_set:
            for row in page_result.result_set:
                node = self._extract_node_from_result(row[0] if isinstance(row, (list, tuple)) else row)
                if not node:
                    continue
                try:
                    child_count = int(row[1]) if isinstance(row, (list, tuple)) and len(row) > 1 else None
                except (TypeError, ValueError):
                    child_count = None
                if child_count is not None:
                    node.child_count = child_count
                    if node.properties is not None:
                        node.properties["childCount"] = child_count
                # Classify: root-type instance vs orphan of non-root type
                if root_types_set and str(node.entity_type) in root_types_set:
                    root_type_count += 1
                else:
                    orphan_count += 1
                nodes.append(node)

        # Defense-in-depth: guarantee displayName-ordered output even if the
        # engine reorders across the aggregating RETURN, so next_cursor is
        # always the page boundary and keyset pagination never overlaps/skips.
        # Uses the same key (and direction) the cursor compares on.
        # Classification/childCount are already attached above and are
        # order-independent.
        nodes = _keyset_sort(nodes, sort_direction)

        has_more = len(nodes) >= int(limit)
        next_cursor = (
            _encode_keyset_cursor(nodes[-1].display_name, nodes[-1].urn, sort_direction)
            if (has_more and nodes) else None
        )

        if known_total_count is not None:
            # Caller already knows the total (e.g. serving from a materialized
            # cache) — skip the full-scan count query entirely.
            total_count = int(known_total_count)
        else:
            # ── Total count query (no cursor filter) ──────────────────────────
            # We run this separately so the page result reflects the cursor, but
            # the total accurately shows how many top-level entities exist.
            count_params: Dict[str, Any] = {}
            if "search" in params:
                count_params["search"] = params["search"]

            if use_label_union:
                where_clause = (" WHERE " + " AND ".join(filter_fragments)) if filter_fragments else ""
                count_cypher = self.dialect.label_union(safe_types, where_clause) + " RETURN count(n) as total"
            else:
                where_clause = (" WHERE " + " AND ".join(filter_fragments)) if filter_fragments else ""
                count_cypher = f"MATCH (n){where_clause} RETURN count(n) as total"

            total_count: Optional[int] = 0
            try:
                count_result = await self._ro_query(count_cypher, params=count_params, timeout=ct, op="toplevel.count")
                if count_result and count_result.result_set:
                    first = count_result.result_set[0]
                    total_count = int(first[0] if isinstance(first, (list, tuple)) else first)
            except asyncio.TimeoutError:
                # Best-effort: the count is display-only, has_more is derived
                # from the page size, and on large graphs the full-scan count
                # is expected to miss its budget. Degrade instead of failing
                # the whole request.
                logger.warning(
                    "get_top_level_or_orphan_nodes count query degraded: "
                    f"exceeded {ct:.0f}s budget (graph={self._graph_name}); "
                    "returning totalCount=null"
                )
                total_count = None
            except Exception as e:
                if not await self._is_verified_missing_graph(e):
                    logger.warning(f"get_top_level_or_orphan_nodes count query failed: {e}")
                    raise  # connection refused / transient = surface it (breaker -> 503)
                total_count = len(nodes)  # never-created / empty key = 0 top-level nodes

        return TopLevelNodesResult(
            nodes=nodes,
            totalCount=total_count,
            hasMore=has_more,
            nextCursor=next_cursor,
            rootTypeCount=root_type_count,
            orphanCount=orphan_count,
        )
