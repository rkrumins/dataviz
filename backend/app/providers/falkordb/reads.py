"""FalkorDB single-node, multi-node, and edge reads — ``ReadMixin``.

Carved from ``backend/app/providers/falkordb/provider.py``'s
``FalkorDBProvider`` class body as it stood before this split:
``get_node`` through ``get_edges`` (lines 69-535), a single contiguous
block that opened the class body, immediately after the class docstring.

This mixin is the canvas's read path: ``get_node``/``get_nodes`` (plus
the ``_match_*`` filter helpers and ``search_nodes``), the three
``deep_search*`` one-line delegations into
``backend.app.providers.falkordb_deep_search`` (kept as a lazy, in-body
import — that module is 3,604 lines and reaches back into this
provider's private surface), and ``get_edges``. ``get_nodes`` carries
the label-union shape that only exists because FalkorDB indexes are
label-scoped; it is not simplified here. See carve-protocol.md in
``.superpowers/sdd/2026-08-30-pr1-falkordb-decoupling/`` for why this has
to be a mixin rather than a delegate/helper object.
"""
import asyncio
import json
from typing import Any, Dict, List, Optional

from backend.app.models.graph import (
    GraphNode, GraphEdge, NodeQuery, EdgeQuery,
    PropertyFilter, TagFilter, TextFilter, FilterOperator,
)
from backend.app.providers.falkordb._log import logger
from backend.app.providers.falkordb.rowmap import _sanitize_label, _edge_from_row


class ReadMixin:
    """Node and edge reads: single-node lookup, filtered multi-node
    search, deep-search delegation, and edge queries."""

    async def get_node(self, urn: str) -> Optional[GraphNode]:
        await self._ensure_connected()

        # DETERMINISTIC childCount: counted live from real containment
        # edges when types are configured — never the stored property.
        try:
            _ct_types = self._get_containment_edge_types() or []
        except Exception:
            # Unconfigured provider (probes, pre-ontology warmup): degrade
            # to the bare form — childCount reports unknown, never stale.
            _ct_types = []
        ct = "|".join(_sanitize_label(t) for t in _ct_types if t)
        count_clause = (
            f" OPTIONAL MATCH (n)-[:{ct}]->(child) RETURN n, count(child) as childCount"
            if ct else " RETURN n"
        )

        def _from_row(row) -> Optional[GraphNode]:
            if ct and isinstance(row, (list, tuple)) and len(row) >= 2:
                node = self._extract_node_from_result([row[0]])
                if node is not None:
                    node.child_count = int(row[1])
                    if node.properties is not None:
                        node.properties['childCount'] = int(row[1])
                return node
            return self._extract_node_from_result(row)

        # Try label-aware lookup first (index-assisted, 10-50x faster)
        label = await self._get_cached_label(urn)
        if label:
            result = await self._ro_query(
                f"MATCH (n:{_sanitize_label(label)} {{urn: $urn}}){count_clause}",
                params={"urn": urn},
                op="nodes.get",
            )
            if result.result_set and len(result.result_set) > 0:
                return _from_row(result.result_set[0])

        # Fallback: label-less scan (still works, just slower)
        result = await self._ro_query(
            f"MATCH (n) WHERE n.urn = $urn{count_clause}",
            params={"urn": urn},
            op="nodes.get_unlabeled",
        )
        if result.result_set and len(result.result_set) > 0:
            node = _from_row(result.result_set[0])
            # Backfill the cache for next time
            if node:
                await self._cache_urn_label(urn, str(node.entity_type))
            return node
        return None

    async def get_nodes(self, query: NodeQuery) -> List[GraphNode]:
        await self._ensure_connected()

        params: Dict[str, Any] = {}
        conditions = []

        # Label-indexed matching: use per-label MATCH with UNION for O(1) index lookup
        # instead of MATCH (n) WHERE toLower(labels(n)[0]) IN $types which scans all nodes.
        use_label_union = bool(query.entity_types) and not query.urns
        if use_label_union:
            # Align declared entity types to the graph's observed label spelling (Task E):
            # the label-union MATCH (n:Label) is case-sensitive, so a `Table` filter must
            # become `TABLE` against a TABLE graph. The non-union path below already compares
            # case-insensitively (toLower). Identity for governed graphs.
            types = list(self._alias_entity_types([str(t) for t in query.entity_types]))
            # Build per-label conditions (shared across all UNION branches)
            shared_conditions = []
        else:
            shared_conditions = None  # not used

        if not use_label_union:
            if query.entity_types:
                # Fallback for combined entity_types + urns queries
                types_lower = [t.lower() for t in [str(t) for t in query.entity_types]]
                params["entityTypesLower"] = types_lower
                conditions.append("toLower(labels(n)[0]) IN $entityTypesLower")

        if query.urns:
            if len(query.urns) == 1:
                conditions.append("n.urn = $urn0")
                params["urn0"] = query.urns[0]
            else:
                params["urnList"] = query.urns
                conditions.append("n.urn IN $urnList")

        if query.tags:
            # Tags stored as JSON array string - match quoted tag in JSON
            params["tagVal"] = json.dumps(query.tags[0])
            tag_cond = "(n.tags IS NOT NULL AND n.tags CONTAINS $tagVal)"
            conditions.append(tag_cond)
            if shared_conditions is not None:
                shared_conditions.append(tag_cond)

        if query.search_query:
            params["search"] = query.search_query.lower()
            search_cond = "(toLower(toString(n.displayName)) CONTAINS $search OR toLower(toString(n.urn)) CONTAINS $search)"
            conditions.append(search_cond)
            if shared_conditions is not None:
                shared_conditions.append(search_cond)

        offset = int(query.offset or 0)
        limit = query.limit or 100
        params["skip"] = offset
        params["limit"] = limit

        # Child count: only compute when needed (skip for bulk lineage fetches)
        include_child_count = query.include_child_count

        # ── URN-anchored fetch: label-index seeks, not an All-Node-Scan ──
        # ``MATCH (n) WHERE n.urn IN $list`` was a full node scan on this
        # FalkorDB build (no label-less URN index) — measured 1.6s for 100
        # urns on a 2M-node graph, and this is the /nodes/query hydration hot
        # path. Bucket the urns by label via the warmed urn->label cache and
        # seek each label's URN index; the unresolved-label residue keeps the
        # unlabeled pattern. Other filters (entity type, tags, search) ride
        # along as WHERE conditions. Pagination/order are applied in Python
        # over the merged, bounded result (the urn set IS the bound).
        if query.urns:
            extra_conditions = [c for c in conditions
                                if "n.urn " not in c and "n.urn=" not in c]
            containment_rel_types = ""
            if include_child_count:
                containment = list(self._get_containment_edge_types())
                containment_rel_types = "|".join(
                    _sanitize_label(t) for t in containment)

            def _urn_cypher(label: str) -> str:
                anchor = f"(n:{label})" if label else "(n)"
                where = " AND ".join(["n.urn IN $urnList", *extra_conditions])
                base = f"MATCH {anchor} WHERE {where}"
                if include_child_count and containment_rel_types:
                    return (f"{base} WITH n "
                            f"OPTIONAL MATCH (n)-[:{containment_rel_types}]->(child) "
                            f"RETURN n, count(child) as childCount")
                if include_child_count:
                    return f"{base} RETURN n, 0 as childCount"
                return f"{base} RETURN n"

            async def _fetch_bucket(label: str, bucket: List[str]) -> list:
                try:
                    res = await self._ro_query(
                        _urn_cypher(label),
                        params={**params, "urnList": bucket},
                        op="nodes.query",
                    )
                    return res.result_set or []
                except Exception as e:
                    if await self._is_verified_missing_graph(e):
                        return []
                    logger.warning(f"get_nodes urn bucket failed: {e}")
                    return []

            buckets = await self._label_buckets(query.urns)
            rows_per_bucket = await asyncio.gather(*[
                _fetch_bucket(lbl, b) for lbl, b in buckets
            ])
            merged: List[GraphNode] = []
            for rows in rows_per_bucket:
                for row in rows:
                    if include_child_count:
                        n = self._extract_node_from_result(row[0])
                        child_count = row[1]
                    else:
                        n = self._extract_node_from_result(row)
                        child_count = None
                    if not n:
                        continue
                    if query.property_filters and not self._match_property_filters(n, query.property_filters):
                        continue
                    if query.tag_filters and not self._match_tag_filters(n, query.tag_filters):
                        continue
                    if query.name_filter and not self._match_text_filter(n.display_name, query.name_filter):
                        continue
                    if child_count is not None:
                        n.child_count = int(child_count)
                        if n.properties:
                            n.properties['childCount'] = int(child_count)
                    merged.append(n)
            # Stable displayName order (matches the SKIP/LIMIT paths), then
            # apply the requested window over the bounded urn result.
            merged.sort(key=lambda n: (n.display_name is None, n.display_name or ""))
            return merged[offset:offset + limit]

        if use_label_union:
            # Build UNION query with per-label MATCH clauses (uses FalkorDB label indices)
            where_suffix = (" WHERE " + " AND ".join(shared_conditions)) if shared_conditions else ""
            union_branches = []
            for t in types:
                safe_label = _sanitize_label(t)
                union_branches.append(f"MATCH (n:{safe_label}){where_suffix} RETURN n")
            # Wrap in subquery pattern: UNION all branches, then paginate + child count
            inner = " UNION ".join(union_branches)
            if include_child_count:
                containment = list(self._get_containment_edge_types())
                containment_rel_types = "|".join([_sanitize_label(t) for t in containment])
                if containment_rel_types:
                    cypher = (
                        f"CALL {{ {inner} }} "
                        f"WITH n ORDER BY n.displayName SKIP $skip LIMIT $limit "
                        f"OPTIONAL MATCH (n)-[:{containment_rel_types}]->(child) "
                        f"RETURN n, count(child) as childCount"
                    )
                else:
                    cypher = (
                        f"CALL {{ {inner} }} "
                        f"WITH n ORDER BY n.displayName SKIP $skip LIMIT $limit "
                        f"RETURN n, 0 as childCount"
                    )
            else:
                cypher = (
                    f"CALL {{ {inner} }} "
                    f"WITH n ORDER BY n.displayName SKIP $skip LIMIT $limit "
                    f"RETURN n"
                )
        else:
            # Original non-UNION path (URN lookups, no entity_types, etc.)
            clauses = ["MATCH (n)"]
            if conditions:
                clauses.append("WHERE " + " AND ".join(conditions))

            if include_child_count:
                containment = list(self._get_containment_edge_types())
                containment_rel_types = "|".join([_sanitize_label(t) for t in containment])
                clauses.append("WITH n SKIP $skip LIMIT $limit")
                if containment_rel_types:
                    clauses.append(f"OPTIONAL MATCH (n)-[:{containment_rel_types}]->(child)")
                    clauses.append("RETURN n, count(child) as childCount")
                else:
                    clauses.append("RETURN n, 0 as childCount")
            else:
                clauses.append("RETURN n SKIP $skip LIMIT $limit")

            cypher = " ".join(clauses)

        try:
            result = await self._ro_query(cypher, params=params)
        except Exception as e:
            if await self._is_verified_missing_graph(e):
                return []  # never-created / empty key = legitimately no data
            logger.warning(f"get_nodes query failed: {e}")
            raise  # connection refused / transient = surface it (breaker -> 503)

        nodes = []
        for row in (result.result_set or []):
            if include_child_count:
                n = self._extract_node_from_result(row[0])
                child_count = row[1]
            else:
                n = self._extract_node_from_result(row)
                child_count = None
            if n:
                if query.property_filters and not self._match_property_filters(n, query.property_filters):
                    continue
                if query.tag_filters and not self._match_tag_filters(n, query.tag_filters):
                    continue
                if query.name_filter and not self._match_text_filter(n.display_name, query.name_filter):
                    continue

                # Apply dynamic child count when available
                if child_count is not None:
                    n.child_count = int(child_count)
                    if n.properties:
                        n.properties['childCount'] = int(child_count)

                nodes.append(n)
                if len(nodes) >= limit:
                    break
        return nodes

    def _match_property_filters(self, node: GraphNode, filters: List[PropertyFilter]) -> bool:
        for f in filters:
            val = node.properties.get(f.field)
            if hasattr(node, f.field):
                val = getattr(node, f.field)
            if not self._match_operator(val, f.operator, f.value):
                return False
        return True

    def _match_operator(self, actual: Any, op: FilterOperator, target: Any) -> bool:
        if op == FilterOperator.EXISTS:
            return actual is not None
        if op == FilterOperator.NOT_EXISTS:
            return actual is None
        if actual is None:
            return False
        if op == FilterOperator.EQUALS:
            return actual == target
        if op == FilterOperator.CONTAINS:
            return str(target).lower() in str(actual).lower()
        if op == FilterOperator.STARTS_WITH:
            return str(actual).lower().startswith(str(target).lower())
        if op == FilterOperator.ENDS_WITH:
            return str(actual).lower().endswith(str(target).lower())
        try:
            if op == FilterOperator.GT:
                return actual > target
            if op == FilterOperator.LT:
                return actual < target
        except Exception:
            return False
        if op == FilterOperator.IN:
            return isinstance(target, list) and actual in target
        if op == FilterOperator.NOT_IN:
            return isinstance(target, list) and actual not in target
        return True

    def _match_tag_filters(self, node: GraphNode, filter: TagFilter) -> bool:
        node_tags = set(node.tags or [])
        target_tags = set(filter.tags)
        if filter.mode == "any":
            return not node_tags.isdisjoint(target_tags)
        if filter.mode == "all":
            return target_tags.issubset(node_tags)
        if filter.mode == "none":
            return node_tags.isdisjoint(target_tags)
        return True

    def _match_text_filter(self, text: str, filter: TextFilter) -> bool:
        t = text if filter.case_sensitive else text.lower()
        q = filter.text if filter.case_sensitive else filter.text.lower()
        if filter.operator == "equals":
            return t == q
        if filter.operator == "contains":
            return q in t
        if filter.operator == "startsWith":
            return t.startswith(q)
        if filter.operator == "endsWith":
            return t.endswith(q)
        return True

    async def search_nodes(self, query: str, limit: int = 10, offset: int = 0) -> List[GraphNode]:
        q = NodeQuery(search_query=query, limit=limit, offset=offset)
        return await self.get_nodes(q)

    async def deep_search(self, query, *, deadline_ms=None):
        """Advanced server-side search. See ``backend/common/models/search.py``.

        Implementation lives in ``falkordb_deep_search.execute_deep_search``
        to keep this provider module focused. Imported lazily to avoid a
        circular dependency at module load (the deep-search module
        imports from this one's read-path helpers indirectly via
        ``_extract_node_from_result`` and friends).
        """
        from backend.app.providers.falkordb_deep_search import execute_deep_search
        await self._ensure_connected()
        return await execute_deep_search(self, query, deadline_ms=deadline_ms)

    async def deep_search_explain(self, query):
        """Compile-only path. Mirrors ``deep_search`` (lazy import to
        avoid the circular load order)."""
        from backend.app.providers.falkordb_deep_search import explain_deep_search
        await self._ensure_connected()
        return explain_deep_search(self, query)

    async def deep_search_discover(self, *, sample_per_label: int = 200):
        """Schema discovery. Mirrors ``deep_search`` (lazy import)."""
        from backend.app.providers.falkordb_deep_search import discover_native_property_keys
        await self._ensure_connected()
        return await discover_native_property_keys(
            self, sample_per_label=sample_per_label,
        )

    async def get_edges(self, query: EdgeQuery) -> List[GraphEdge]:
        await self._ensure_connected()

        offset = query.offset or 0
        limit = query.limit or 100

        # Relationship types as a PATTERN alternation (alias-mapped to this
        # graph's observed spellings), not a post-hoc `type(r) IN` filter —
        # the traversal then never visits other edge types on hub nodes.
        types: Optional[List[str]] = None
        if query.edge_types:
            raw = [t.value if hasattr(t, "value") else str(t) for t in query.edge_types]
            types = [t for t in self._alias_rel_types(raw) if t]
        rel_pattern = (
            f"[r:{'|'.join(_sanitize_label(t) for t in types)}]" if types else "[r]"
        )

        extra_conditions: List[str] = []
        extra_params: Dict[str, Any] = {}
        if query.min_confidence is not None:
            extra_params["minConf"] = query.min_confidence
            extra_conditions.append("r.confidence >= $minConf")

        is_between = bool(query.source_urns and query.target_urns)
        op = "edges.between" if is_between else "edges.query"
        timeout = self._EDGES_BETWEEN_TIMEOUT if is_between else None

        # URN-anchored reads (the /edges/between hydration path) run one
        # urn-index-seeked sub-query per label bucket, gathered — an
        # unlabeled `a.urn IN $list` anchor is a FULL node scan on builds
        # without a label-less URN index (measured 310ms/2M nodes, before
        # even walking edges). Bucketing keeps result sets disjoint (a node
        # has one label), so a simple merge + truncate preserves semantics
        # at offset 0. offset>0 or anyUrns fall back to the legacy single
        # query below — those shapes have no index-friendly form.
        anchor_urns = query.source_urns or query.target_urns
        if anchor_urns and offset == 0 and not query.any_urns:
            anchor_on_source = bool(query.source_urns)
            conditions = list(extra_conditions)
            params: Dict[str, Any] = {**extra_params, "limit": limit}
            if anchor_on_source and query.target_urns:
                params["targetUrns"] = query.target_urns
                conditions.append("b.urn IN $targetUrns")

            async def _run_bucket(label: str, bucket: List[str]) -> list:
                var = "a" if anchor_on_source else "b"
                node = f"({var}:{label})" if label else f"({var})"
                pattern = (
                    f"MATCH {node}-{rel_pattern}->(b)" if anchor_on_source
                    else f"MATCH (a)-{rel_pattern}->{node}"
                )
                where = " AND ".join([f"{var}.urn IN $anchorUrns"] + conditions)
                try:
                    res = await self._ro_query(
                        f"{pattern} WHERE {where} "
                        "RETURN a.urn AS src, b.urn AS tgt, type(r) AS relType, "
                        "properties(r) AS rprops LIMIT $limit",
                        params={**params, "anchorUrns": bucket},
                        timeout=timeout, op=op,
                    )
                    return res.result_set or []
                except Exception as exc:
                    logger.warning("get_edges bucket query failed: %s", exc)
                    return []

            rows_per_bucket = await asyncio.gather(*[
                _run_bucket(label, bucket)
                for label, bucket in await self._label_buckets(list(anchor_urns))
            ])
            edges: List[GraphEdge] = []
            for rows in rows_per_bucket:
                for row in rows:
                    edges.append(_edge_from_row(row[0], row[1], row[2], row[3] or {}))
                    if len(edges) >= limit:
                        break
                if len(edges) >= limit:
                    break
            return edges

        cypher = f"MATCH (a)-{rel_pattern}->(b)"
        params = dict(extra_params)
        conditions = list(extra_conditions)
        if query.source_urns:
            params["sourceUrns"] = query.source_urns
            conditions.append("a.urn IN $sourceUrns")
        if query.target_urns:
            params["targetUrns"] = query.target_urns
            conditions.append("b.urn IN $targetUrns")
        if query.any_urns:
            params["anyUrns"] = query.any_urns
            conditions.append("(a.urn IN $anyUrns OR b.urn IN $anyUrns)")
        if conditions:
            cypher += " WHERE " + " AND ".join(conditions)
        params["skip"] = offset
        params["limit"] = limit
        cypher += " RETURN a.urn AS src, b.urn AS tgt, type(r) AS relType, properties(r) AS rprops SKIP $skip LIMIT $limit"

        result = await self._ro_query(cypher, params=params, timeout=timeout, op=op)
        edges = []
        for row in (result.result_set or []):
            src, tgt, rel_type, rprops = row[0], row[1], row[2], (row[3] or {})
            edges.append(_edge_from_row(src, tgt, rel_type, rprops))
        return edges
