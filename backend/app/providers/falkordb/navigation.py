"""FalkorDB ancestor/descendant/tag/layer node lookups — ``NavigationMixin``.

Carved from ``backend/app/providers/falkordb/provider.py``'s
``FalkorDBProvider`` class body as it stood before this split:
``get_ancestors`` through ``get_nodes_by_layer`` (lines 10675-10801), a
single contiguous block.

This mixin holds the four read-path node-lookup entry points that key off
a URN's place in the containment/tag/layer structure rather than off a
free-form node query: ``get_ancestors`` (Redis chain + one Cypher hydrate),
``get_descendants``, ``get_nodes_by_tag``, and ``get_nodes_by_layer``.
``get_nodes_by_layer`` uses a per-label ``CALL { … } UNION`` shape rather
than a bare ``MATCH (n)`` because FalkorDB's indexes are label-scoped and
a bare match cannot use them — it reads ``_indexed_entity_type_ids``,
which ``ensure_indices`` sets; the ``CALL {} UNION`` wrapper itself now
renders via ``self.dialect.label_union`` (task 14's dialect seam). See
``docs/superpowers/plans/2026-08-30-pr1-falkordb-decoupling.md`` §2.2 for why this has
to be a mixin rather than a delegate/helper object.
"""
import json
from typing import Any, Dict, List, Optional

from backend.app.models.graph import GraphNode, NodeQuery
from backend.app.providers.falkordb.cursors import (
    _decode_keyset_cursor,
    _keyset_sort,
    _validate_sort_direction,
)
from backend.app.providers.falkordb.rowmap import _sanitize_label


class NavigationMixin:
    """Node lookups keyed off containment ancestry, tags, and layers."""

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
            safe_labels = [_sanitize_label(label) for label in indexed_labels(vocabulary)]
            cypher = (
                self.dialect.label_union(safe_labels, where)
                + f" WITH n{order}{skip_clause} LIMIT $limit RETURN n"
            )
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
