"""
FalkorDB graph provider - persists graph data in FalkorDB and loads it via the application.
Implements GraphDataProvider interface using FalkorDB async client and Cypher queries.
"""

import json
import logging
import os
from collections import defaultdict, deque
from typing import List, Optional, Dict, Any, Set

from ..models.graph import (
    GraphNode, GraphEdge, NodeQuery, EdgeQuery,
    LineageResult, GraphSchemaStats,
    PropertyFilter, TagFilter, TextFilter, FilterOperator,
    EntityTypeSummary, EdgeTypeSummary, TagSummary,
    OntologyMetadata, EdgeTypeMetadata, EntityTypeHierarchy,
    AggregatedEdgeResult, AggregatedEdgeInfo,
    ChildrenWithEdgesResult, TopLevelNodesResult,
)
from .base import GraphDataProvider
from backend.common.interfaces.provider import ProviderConfigurationError

logger = logging.getLogger(__name__)


def _sanitize_label(s: str) -> str:
    """Sanitize string for use as FalkorDB label/relationship type (alphanumeric + underscore)."""
    return "".join(c if c.isalnum() or c == "_" else "_" for c in str(s))


def _node_from_props(props: Dict[str, Any], entity_type_str: Optional[str] = None) -> Optional[GraphNode]:
    """Build GraphNode from FalkorDB node properties."""
    if not props or "urn" not in props:
        return None
    entity_type = entity_type_str or props.get("entityType", "unknown")
    try:
        return GraphNode(
            urn=props["urn"],
            entityType=str(entity_type),
            displayName=props.get("displayName", ""),
            qualifiedName=props.get("qualifiedName"),
            description=props.get("description"),
            properties=json.loads(props["properties"]) if isinstance(props.get("properties"), str) else (props.get("properties") or {}),
            tags=json.loads(props["tags"]) if isinstance(props.get("tags"), str) else (props.get("tags") or []),
            layerAssignment=props.get("layerAssignment"),
            childCount=props.get("childCount"),
            sourceSystem=props.get("sourceSystem"),
            lastSyncedAt=props.get("lastSyncedAt"),
        )
    except Exception as e:
        logger.warning(f"Failed to build GraphNode from props: {e}")
        return None


def _edge_from_row(source_urn: str, target_urn: str, rel_type: str, props: Dict[str, Any]) -> GraphEdge:
    """Build GraphEdge from FalkorDB edge data."""
    edge_id = props.get("id") or f"{source_urn}|{rel_type}|{target_urn}"
    return GraphEdge(
        id=edge_id,
        sourceUrn=source_urn,
        targetUrn=target_urn,
        edgeType=str(rel_type),
        confidence=props.get("confidence"),
        properties=json.loads(props["properties"]) if isinstance(props.get("properties"), str) else (props.get("properties") or {}),
    )


class FalkorDBProvider(GraphDataProvider):
    """
    Graph data provider backed by FalkorDB.
    Schema: nodes have label = entityType, properties include urn, displayName, etc.
    Edges use relationship type = edgeType (CONTAINS, PRODUCES, etc.).
    """

    def __init__(
        self,
        host: str = "localhost",
        port: int = 6379,
        graph_name: str = "nexus_lineage",
        seed_file: Optional[str] = None,
        projection_mode: str = "in_source",
    ):
        self._host = host
        self._port = port
        self._graph_name = graph_name
        self._seed_file = seed_file
        self._projection_mode = projection_mode  # "in_source" or "dedicated"
        self._graph = None
        self._proj_graph = None  # Dedicated projection graph (when mode = "dedicated")
        self._pool = None       # Graph query pool (used by FalkorDB)
        self._redis_pool = None  # Separate pool for Redis data-structure ops (caching, SADD, etc.)
        self._db = None

    @property
    def _proj(self):
        """Transparent access to the projection graph.

        When projection_mode is "in_source", AGGREGATED edges live in the
        same graph as source data. When "dedicated", they go to a separate
        graph key (e.g. nexus_lineage_proj) on the same Redis instance.
        """
        if self._projection_mode == "dedicated" and self._proj_graph is not None:
            return self._proj_graph
        return self._graph

    async def _ensure_connected(self):
        """Lazy connection to FalkorDB."""
        if self._graph is not None:
            return
        try:
            # Non-blocking ConnectionPool: on exhaustion raises ConnectionError
            # immediately instead of blocking the caller (and, for asyncio
            # BlockingConnectionPool, stalling the event loop while waiting
            # on a semaphore inside the loop itself). The circuit-breaker
            # proxy around this provider translates the failure into
            # ProviderUnavailable before it reaches the web tier.
            from redis.asyncio import ConnectionPool, Redis
            from falkordb.asyncio import FalkorDB

            # Pool for graph (Cypher) queries — used by FalkorDB client
            self._pool = ConnectionPool(
                host=self._host,
                port=self._port,
                max_connections=12,
                socket_connect_timeout=1.0,
                socket_timeout=3.0,
                decode_responses=True,
            )
            # Separate pool for Redis data-structure ops (caching, SADD, HSET, etc.)
            # Prevents cache/materialization ops from starving graph query connections
            self._redis_pool = ConnectionPool(
                host=self._host,
                port=self._port,
                max_connections=8,
                socket_connect_timeout=1.0,
                socket_timeout=3.0,
                decode_responses=True,
            )
            self._redis = Redis(connection_pool=self._redis_pool)
            self._db = FalkorDB(connection_pool=self._pool)
            self._graph = self._db.select_graph(self._graph_name)

            # Set up projection graph if using dedicated mode
            if self._projection_mode == "dedicated":
                self._proj_graph = self._db.select_graph(f"{self._graph_name}_proj")

            # Ensure indices exist
            await self.ensure_indices()
            await self.ensure_projections()

            # Optional lazy seed
            if self._seed_file:
                count_result = await self._graph.ro_query(
                    "MATCH (n) RETURN count(n) AS c",
                    params={}
                )
                if count_result.result_set and count_result.result_set[0][0] == 0:
                    await self._seed_from_file()
        except Exception as e:
            logger.error(f"FalkorDB connection failed: {e}")
            raise

    async def _seed_from_file(self):
        """Load graph from seed JSON file if graph is empty."""
        import os as _os
        path = self._seed_file
        if not path or not _os.path.exists(path):
            logger.warning(f"Seed file not found: {path}")
            return
        try:
            with open(path, "r") as f:
                data = json.load(f)
            nodes = [GraphNode(**n) for n in data.get("nodes", [])]
            edges = [GraphEdge(**e) for e in data.get("edges", [])]
            # Limit for large files
            if len(nodes) > 50000:
                nodes = nodes[:50000]
            if len(edges) > 100000:
                edges = edges[:100000]
            await self.save_custom_graph(nodes, edges)
            logger.info(f"Seeded {len(nodes)} nodes and {len(edges)} edges from {path}")
        except Exception as e:
            logger.error(f"Seed failed: {e}")

    async def ensure_indices(self, entity_type_ids: Optional[List[str]] = None):
        """Create indices for node labels and properties.

        When *entity_type_ids* is provided (e.g. from the resolved ontology),
        those labels are indexed in addition to the hardcoded defaults.
        """
        default_labels = [
            "domain",
            "dataPlatform",
            "container",
            "dataset",
            "schemaField",
        ]
        extra = list(entity_type_ids) if entity_type_ids else []
        seen: set[str] = set()
        labels: list[str] = []
        for lbl in default_labels + extra:
            if lbl not in seen:
                seen.add(lbl)
                labels.append(lbl)

        properties = ["urn", "displayName", "qualifiedName"]

        for label in labels:
            for prop in properties:
                try:
                    await self._graph.query(f"CREATE INDEX FOR (n:{label}) ON (n.{prop})")
                except Exception:
                    pass

    @property
    def name(self) -> str:
        return "FalkorDBProvider"

    def set_containment_edge_types(self, types: List[str], from_ontology: bool = True) -> None:
        """Called by ContextEngine after ontology resolution to inject the
        authoritative containment edge types from the resolver.

        Parameters
        ----------
        types : list
            The containment edge types. Empty list means the ontology explicitly
            defines no containment types (flat graph, no hierarchy).
        from_ontology : bool
            True if these came from a real ontology definition (assigned or system).
            False if from introspection-only — an empty list should NOT suppress
            the hardcoded fallback.
        """
        if from_ontology or types:
            self._resolved_containment_types: Set[str] = {t.upper() for t in types}
            self._resolved_containment_types_set = True
        # else: introspection-only with no containment found — don't set sentinel

    def set_resolved_edge_metadata(
        self,
        edge_type_metadata: Dict[str, Any],
        lineage_edge_types: List[str],
    ) -> None:
        """Called by ContextEngine after ontology resolution to inject the
        authoritative edge classification from the resolver.
        When set, get_ontology_metadata() uses this instead of
        re-deriving from env vars and hardcoded type names.
        """
        self._resolved_edge_metadata = {k.upper(): v for k, v in edge_type_metadata.items()}
        self._resolved_lineage_types: Set[str] = {t.upper() for t in lineage_edge_types}
        self._resolved_edge_metadata_set = True

    def _get_containment_edge_types(self) -> Set[str]:
        """Return the authoritative containment edge type set.

        Resolution chain (first match wins):
        1. Ontology-resolved types injected by ContextEngine (may be empty = no hierarchy)
        2. CONTAINMENT_EDGE_TYPES env var (explicit operator opt-in)
        3. Raise ProviderConfigurationError — there is no safe hardcoded fallback
           in a multi-tenant, custom-ontology system.

        Enterprise tenants may use arbitrary edge type naming (e.g. "HAS_TABLE",
        "PART_OF", "OWNS"). Silently defaulting to {CONTAINS, BELONGS_TO} produced
        the "no results" bug in /nodes/top-level because such tenants legitimately
        have neither type, yet the provider classified everything as "has a parent".
        The right failure mode is loud and actionable at the API boundary.
        """
        # Prefer ontology-resolved types if they have been explicitly set
        # (even if the set is empty — empty is a valid resolved state that
        # indicates a flat graph with no containment hierarchy)
        if getattr(self, "_resolved_containment_types_set", False):
            return self._resolved_containment_types
        if not hasattr(self, "_containment_cache"):
            config = os.getenv("CONTAINMENT_EDGE_TYPES", "").strip()
            if config:
                self._containment_cache = {t.strip().upper() for t in config.split(",") if t.strip()}
            else:
                raise ProviderConfigurationError(
                    "Containment edge types are not configured for this provider. "
                    "ContextEngine must call set_containment_edge_types() from a "
                    "resolved ontology, or the CONTAINMENT_EDGE_TYPES env var must "
                    "be set. No hardcoded fallback is safe in a multi-tenant system."
                )
        return self._containment_cache

    def _extract_node_from_result(self, row) -> Optional[GraphNode]:
        """Extract GraphNode from a FalkorDB result row (Node or dict of properties)."""
        if not row:
            return None
        cell = row[0] if isinstance(row, (list, tuple)) else row
        if hasattr(cell, "properties"):
            props = cell.properties or {}
            labels = getattr(cell, "labels", None) or []
            entity_type = labels[0] if labels else props.get("entityType", "unknown")
            return _node_from_props(props, entity_type)
        if isinstance(cell, dict):
            return _node_from_props(cell)
        return None

    # ---- URN → label cache (Redis Hash) ----

    def _urn_label_key(self) -> str:
        return f"{self._graph_name}:urn_labels"

    async def _cache_urn_label(self, urn: str, label: str) -> None:
        """Store a single urn→label mapping."""
        try:
            await self._redis.hset(self._urn_label_key(), urn, label)
        except Exception:
            pass  # best-effort

    async def _cache_urn_labels_bulk(self, mapping: Dict[str, str]) -> None:
        """Bulk-store urn→label mappings via pipeline."""
        if not mapping:
            return
        try:
            pipe = self._redis.pipeline(transaction=False)
            key = self._urn_label_key()
            for urn, label in mapping.items():
                pipe.hset(key, urn, label)
            await pipe.execute()
        except Exception:
            pass  # best-effort

    async def _get_cached_label(self, urn: str) -> Optional[str]:
        """Look up the label for a URN from Redis cache."""
        try:
            return await self._redis.hget(self._urn_label_key(), urn)
        except Exception:
            return None

    async def get_node(self, urn: str) -> Optional[GraphNode]:
        await self._ensure_connected()

        # Try label-aware lookup first (index-assisted, 10-50x faster)
        label = await self._get_cached_label(urn)
        if label:
            result = await self._graph.ro_query(
                f"MATCH (n:{_sanitize_label(label)} {{urn: $urn}}) RETURN n",
                params={"urn": urn},
            )
            if result.result_set and len(result.result_set) > 0:
                return self._extract_node_from_result(result.result_set[0])

        # Fallback: label-less scan (still works, just slower)
        result = await self._graph.ro_query(
            "MATCH (n) WHERE n.urn = $urn RETURN n",
            params={"urn": urn},
        )
        if result.result_set and len(result.result_set) > 0:
            node = self._extract_node_from_result(result.result_set[0])
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
            types = [str(t) for t in query.entity_types]
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
            result = await self._graph.ro_query(cypher, params=params)
        except Exception as e:
            logger.warning(f"get_nodes query failed: {e}")
            return []

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

    async def get_edges(self, query: EdgeQuery) -> List[GraphEdge]:
        await self._ensure_connected()

        cypher = "MATCH (a)-[r]->(b)"
        params: Dict[str, Any] = {}
        conditions: List[str] = []

        if query.source_urns:
            params["sourceUrns"] = query.source_urns
            conditions.append("a.urn IN $sourceUrns")
        if query.target_urns:
            params["targetUrns"] = query.target_urns
            conditions.append("b.urn IN $targetUrns")
        if query.any_urns:
            params["anyUrns"] = query.any_urns
            conditions.append("(a.urn IN $anyUrns OR b.urn IN $anyUrns)")
        if query.edge_types:
            types = [t.value if hasattr(t, "value") else str(t) for t in query.edge_types]
            params["edgeTypes"] = types
            conditions.append("type(r) IN $edgeTypes")
        if query.min_confidence is not None:
            params["minConf"] = query.min_confidence
            conditions.append("r.confidence >= $minConf")

        if conditions:
            cypher += " WHERE " + " AND ".join(conditions)

        offset = query.offset or 0
        limit = query.limit or 100
        params["skip"] = offset
        params["limit"] = limit
        cypher += " RETURN a.urn AS src, b.urn AS tgt, type(r) AS relType, properties(r) AS rprops SKIP $skip LIMIT $limit"

        result = await self._graph.ro_query(cypher, params=params)
        edges = []
        for row in (result.result_set or []):
            src, tgt, rel_type, rprops = row[0], row[1], row[2], (row[3] or {})
            edges.append(_edge_from_row(src, tgt, rel_type, rprops))
        return edges

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
    ) -> List[GraphNode]:
        await self._ensure_connected()
        # None = caller didn't specify, use ontology/fallback; [] = explicitly no containment
        target_edge_types = set(edge_types) if edge_types is not None else set(self._get_containment_edge_types())
        rel_list = list(target_edge_types)
        if not rel_list:
            # No containment types defined — hierarchy is flat, no children exist
            return []

        search_where = ""
        params: Dict[str, Any] = {"parent": parent_urn, "lim": limit, "relTypes": rel_list}

        if search_query:
            search_where = "AND (toLower(c.displayName) CONTAINS toLower($searchQuery) OR toLower(c.urn) CONTAINS toLower($searchQuery)) "
            params["searchQuery"] = search_query

        # Cursor-based pagination: use WHERE c.displayName > $cursor instead of SKIP
        # This is O(log N) with FalkorDB indices vs O(N) for SKIP-based pagination.
        cursor_where = ""
        if cursor:
            cursor_where = "AND c.displayName > $cursor "
            params["cursor"] = cursor
        else:
            # Fallback to offset when no cursor (first page or legacy callers)
            params["skip"] = offset

        # Build ORDER BY suffix for the WITH clause
        order_suffix = ""
        if sort_property:
            safe_prop = _sanitize_label(sort_property)
            order_suffix = f" ORDER BY c.{safe_prop}"

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

        result = await self._graph.ro_query(cypher, params=params)
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
    ) -> ChildrenWithEdgesResult:
        """Optimized single-roundtrip: children + containment edges + cross-child lineage edges.

        Supports cursor-based pagination for O(log N) performance at any page depth.
        When `cursor` is provided, it takes precedence over `offset`.
        """
        await self._ensure_connected()

        # --- Step 1: Fetch children with containment edges (returns edge r) ---
        target_edge_types = set(edge_types) if edge_types is not None else set(self._get_containment_edge_types())
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

        # Cursor-based pagination: WHERE c.displayName > $cursor is O(log N) vs SKIP's O(N)
        cursor_where = ""
        if cursor:
            cursor_where = "AND c.displayName > $cursor "
            params["cursor"] = cursor
        else:
            params["skip"] = offset

        # Build ORDER BY suffix for the WITH clause
        order_suffix = ""
        if sort_property:
            safe_prop = _sanitize_label(sort_property)
            order_suffix = f" ORDER BY c.{safe_prop}"

        skip_clause = "" if cursor else " SKIP $skip"

        # Query returns child node, containment edge properties, and grandchild count
        if len(rel_list) == 1:
            rel = _sanitize_label(rel_list[0])
            cypher = (
                f"MATCH (p)-[r:{rel}]->(c) "
                f"WHERE p.urn = $parent {search_where}{cursor_where}"
                f"WITH p, r, c{order_suffix}{skip_clause} LIMIT $lim "
                f"OPTIONAL MATCH (c)-[rc]->(gc) WHERE type(rc) IN $relTypes "
                f"RETURN c, count(gc) as childCount, p.urn as parentUrn, type(r) as relType, properties(r) as rprops"
            )
        else:
            cypher = (
                f"MATCH (p)-[r]->(c) "
                f"WHERE p.urn = $parent AND type(r) IN $relTypes {search_where}{cursor_where}"
                f"WITH p, r, c{order_suffix}{skip_clause} LIMIT $lim "
                f"OPTIONAL MATCH (c)-[rc]->(gc) WHERE type(rc) IN $relTypes "
                f"RETURN c, count(gc) as childCount, p.urn as parentUrn, type(r) as relType, properties(r) as rprops"
            )

        result = await self._graph.ro_query(cypher, params=params)

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

            lineage_params: Dict[str, Any] = {"pageUrns": page_urns}
            if lineage_edge_types:
                lineage_where = "AND type(lr) IN $lineageTypes"
                lineage_params["lineageTypes"] = lineage_edge_types
            else:
                lineage_where = "AND NOT type(lr) IN $excludeTypes"
                lineage_params["excludeTypes"] = exclude_types

            lineage_cypher = (
                f"MATCH (a)-[lr]->(b) "
                f"WHERE a.urn IN $pageUrns AND b.urn IN $pageUrns {lineage_where} "
                f"RETURN a.urn, b.urn, type(lr), properties(lr)"
            )

            lr_result = await self._graph.ro_query(lineage_cypher, params=lineage_params)
            for row in (lr_result.result_set or []):
                lineage_edges_list.append(_edge_from_row(row[0], row[1], row[2], row[3] or {}))

        has_more = len(children) >= limit
        total = offset + len(children) + (1 if has_more else 0)
        next_cursor = children[-1].display_name if children and has_more else None

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
        # Match any containment-type edge where child is target
        result = await self._graph.ro_query(
            "MATCH (p)-[r]->(c) WHERE c.urn = $child AND type(r) IN $ctypes RETURN p",
            params={"child": child_urn, "ctypes": list(containment)},
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
    ) -> TopLevelNodesResult:
        """Return structurally top-level nodes (no incoming containment edge).

        Mixes ontology root-type instances and orphan non-root instances so the
        wizard can show both in one list, with a root/orphan split in the
        badge text. Classification is done in Python on the returned rows.

        Pagination is cursor-based on displayName for stability under writes:
        callers pass cursor=None for the first page and the returned
        next_cursor for subsequent pages.
        """
        await self._ensure_connected()

        # Raises ProviderConfigurationError if no types resolvable — surfaced
        # as HTTP 400 by the endpoint. An empty set is a valid state meaning
        # "flat graph, every node is top-level".
        containment = self._get_containment_edge_types()
        containment_rel_types = "|".join([_sanitize_label(t) for t in sorted(containment)])
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
        # IMPORTANT: Use openCypher 1.0 pattern negation `NOT ()-[:T]->(n)`
        # NOT `NOT EXISTS { MATCH ... }` which is Neo4j 4.x+ / ISO GQL syntax
        # and is NOT supported by FalkorDB. The subquery form silently throws,
        # gets caught below, and returns empty — which was the original bug.
        if containment_rel_types:
            filter_fragments.append(
                "NOT ()-[:" + containment_rel_types + "]->(n)"
            )

        # ── Build MATCH clause: label UNION if entity_types specified ─────
        use_label_union = bool(entity_types)
        safe_types: List[str] = []
        if use_label_union:
            safe_types = [_sanitize_label(str(t)) for t in entity_types if str(t)]
            if not safe_types:
                use_label_union = False

        # Page-query cursor: keyset over displayName for stability under writes.
        page_filters = list(filter_fragments)
        if cursor is not None:
            params["cursor"] = str(cursor)
            page_filters.append("toString(n.displayName) > $cursor")

        def _build_match(filters: List[str]) -> str:
            where_clause = (" WHERE " + " AND ".join(filters)) if filters else ""
            if use_label_union:
                branches = [
                    f"MATCH (n:{label}){where_clause} RETURN n"
                    for label in safe_types
                ]
                return "CALL { " + " UNION ".join(branches) + " }"
            return f"MATCH (n){where_clause}"

        # ── Page query ────────────────────────────────────────────────────
        if include_child_count and containment_rel_types:
            page_cypher = (
                _build_match(page_filters)
                + " WITH n ORDER BY toString(n.displayName) ASC LIMIT $limit"
                + f" OPTIONAL MATCH (n)-[:{containment_rel_types}]->(child)"
                + " RETURN n, count(child) as childCount"
            )
        else:
            page_cypher = (
                _build_match(page_filters)
                + " WITH n ORDER BY toString(n.displayName) ASC LIMIT $limit"
                + " RETURN n, 0 as childCount"
            )

        try:
            page_result = await self._graph.ro_query(page_cypher, params=params)
        except Exception as e:
            logger.warning(f"get_top_level_or_orphan_nodes page query failed: {e}")
            page_result = None

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

        has_more = len(nodes) >= int(limit)
        next_cursor = nodes[-1].display_name if (has_more and nodes) else None

        # ── Total count query (no cursor filter) ──────────────────────────
        # We run this separately so the page result reflects the cursor, but
        # the total accurately shows how many top-level entities exist.
        count_params: Dict[str, Any] = {}
        if "search" in params:
            count_params["search"] = params["search"]

        if use_label_union:
            where_clause = (" WHERE " + " AND ".join(filter_fragments)) if filter_fragments else ""
            count_branches = [
                f"MATCH (n:{label}){where_clause} RETURN n"
                for label in safe_types
            ]
            count_cypher = "CALL { " + " UNION ".join(count_branches) + " } RETURN count(n) as total"
        else:
            where_clause = (" WHERE " + " AND ".join(filter_fragments)) if filter_fragments else ""
            count_cypher = f"MATCH (n){where_clause} RETURN count(n) as total"

        total_count = 0
        try:
            count_result = await self._graph.ro_query(count_cypher, params=count_params)
            if count_result and count_result.result_set:
                first = count_result.result_set[0]
                total_count = int(first[0] if isinstance(first, (list, tuple)) else first)
        except Exception as e:
            logger.warning(f"get_top_level_or_orphan_nodes count query failed: {e}")
            total_count = len(nodes)

        return TopLevelNodesResult(
            nodes=nodes,
            totalCount=total_count,
            hasMore=has_more,
            nextCursor=next_cursor,
            rootTypeCount=root_type_count,
            orphanCount=orphan_count,
        )

    async def _traverse_lineage(
        self,
        start_urn: str,
        direction: str,
        depth: int,
        descendant_types: Optional[List[str]] = None,
    ) -> Set[str]:
        """Single-query lineage traversal using bounded variable-length Cypher paths.

        Uses *1..{depth} (literal bound) instead of unbounded *1.. so the
        query planner can prune early. Entity-type filtering is pushed into
        Cypher via labels(neighbor)[0] rather than fetching all nodes to
        filter in Python.
        """
        await self._ensure_connected()
        containment = list(self._get_containment_edge_types())
        safe_depth = max(1, min(int(depth), 20))  # Clamp to sane range
        params: Dict[str, Any] = {
            "startUrn": start_urn,
            "containmentTypes": containment,
        }

        # Entity-type filter pushed into Cypher
        type_clause = ""
        if descendant_types:
            allowed = [t.value if hasattr(t, "value") else str(t) for t in descendant_types]
            params["allowedTypes"] = allowed
            type_clause = "AND labels(neighbor)[0] IN $allowedTypes "

        if direction == "upstream":
            cypher = (
                f"MATCH (start) WHERE start.urn = $startUrn "
                f"MATCH path = (neighbor)-[*1..{safe_depth}]->(start) "
                f"WHERE ALL(r IN relationships(path) WHERE NOT type(r) IN $containmentTypes) "
                f"{type_clause}"
                f"RETURN DISTINCT neighbor.urn AS urn"
            )
        else:
            cypher = (
                f"MATCH (start) WHERE start.urn = $startUrn "
                f"MATCH path = (start)-[*1..{safe_depth}]->(neighbor) "
                f"WHERE ALL(r IN relationships(path) WHERE NOT type(r) IN $containmentTypes) "
                f"{type_clause}"
                f"RETURN DISTINCT neighbor.urn AS urn"
            )

        result = await self._graph.ro_query(cypher, params=params)
        return {
            row[0] for row in (result.result_set or [])
            if row[0] and row[0] != start_urn
        }

    async def get_upstream(
        self,
        urn: str,
        depth: int,
        include_column_lineage: bool = False,
        descendant_types: Optional[List[str]] = None,
    ) -> LineageResult:
        upstream_urns = await self._traverse_lineage(urn, "upstream", depth, descendant_types)
        all_urns = upstream_urns | {urn}
        nodes = await self.get_nodes(NodeQuery(urns=list(all_urns), limit=len(all_urns), include_child_count=False))
        node_ids = {n.urn for n in nodes}
        edges = await self.get_edges(EdgeQuery(any_urns=list(all_urns), limit=len(all_urns) * 10))
        edges = [e for e in edges if e.source_urn in node_ids and e.target_urn in node_ids]
        return LineageResult(
            nodes=nodes,
            edges=edges,
            upstreamUrns=upstream_urns,
            downstreamUrns=set(),
            totalCount=len(nodes),
            hasMore=False,
        )

    async def get_downstream(
        self,
        urn: str,
        depth: int,
        include_column_lineage: bool = False,
        descendant_types: Optional[List[str]] = None,
    ) -> LineageResult:
        downstream_urns = await self._traverse_lineage(urn, "downstream", depth, descendant_types)
        all_urns = downstream_urns | {urn}
        nodes = await self.get_nodes(NodeQuery(urns=list(all_urns), limit=len(all_urns), include_child_count=False))
        node_ids = {n.urn for n in nodes}
        edges = await self.get_edges(EdgeQuery(any_urns=list(all_urns), limit=len(all_urns) * 10))
        edges = [e for e in edges if e.source_urn in node_ids and e.target_urn in node_ids]
        return LineageResult(
            nodes=nodes,
            edges=edges,
            upstreamUrns=set(),
            downstreamUrns=downstream_urns,
            totalCount=len(nodes),
            hasMore=False,
        )

    async def get_full_lineage(
        self,
        urn: str,
        upstream_depth: int,
        downstream_depth: int,
        include_column_lineage: bool = False,
        descendant_types: Optional[List[str]] = None,
    ) -> LineageResult:
        up = await self._traverse_lineage(urn, "upstream", upstream_depth, descendant_types)
        down = await self._traverse_lineage(urn, "downstream", downstream_depth, descendant_types)
        all_urns = up | down | {urn}
        nodes = await self.get_nodes(NodeQuery(urns=list(all_urns), limit=len(all_urns), include_child_count=False))
        node_ids = {n.urn for n in nodes}
        edges = await self.get_edges(EdgeQuery(any_urns=list(all_urns), limit=len(all_urns) * 10))
        edges = [e for e in edges if e.source_urn in node_ids and e.target_urn in node_ids]
        return LineageResult(
            nodes=nodes,
            edges=edges,
            upstreamUrns=up,
            downstreamUrns=down,
            totalCount=len(nodes),
            hasMore=False,
        )


    # ------------------------------------------------------------------ #
    # Projection / Materialization Lifecycle Hooks                         #
    # ------------------------------------------------------------------ #

    async def ensure_projections(self) -> None:
        """Create indices on the projection target for fast AGGREGATED reads."""
        proj = self._proj
        try:
            await proj.query("CREATE INDEX FOR (n:_Projection) ON (n.urn)")
        except Exception:
            pass  # Index may already exist

    async def _get_ancestor_chain(self, urn: str) -> List[str]:
        """Get pre-computed ancestor chain from Redis Hash, or compute + cache it.

        Returns list of URNs from immediate parent to root (ordered).
        Uses Redis Hash `{graph_name}:ancestors` for O(1) lookup.
        """
        cache_key = f"{self._graph_name}:ancestors"
        try:
            raw = await self._redis.execute_command("HGET", cache_key, urn)
            if raw:
                return json.loads(raw)
        except Exception:
            pass

        # Cache miss — compute from graph and store
        ancestors = await self._compute_ancestor_chain(urn)
        try:
            await self._redis.execute_command(
                "HSET", cache_key, urn, json.dumps(ancestors)
            )
        except Exception as e:
            logger.debug(f"Failed to cache ancestor chain for {urn}: {e}")
        return ancestors

    async def _compute_ancestor_chain(self, urn: str) -> List[str]:
        """Single Cypher query to walk containment edges upward (1 query instead of N)."""
        containment = list(self._get_containment_edge_types())
        if not containment:
            # No containment types — flat graph, no ancestors
            return []
        containment_cypher = "|".join(_sanitize_label(t) for t in containment)

        # Variable-length path: returns ordered list of ancestor URNs
        # nodes(path) gives [child, parent, grandparent, ...] — skip index 0 (self)
        result = await self._graph.ro_query(
            f"MATCH path = (child)<-[:{containment_cypher}*1..10]-(ancestor) "
            f"WHERE child.urn = $urn "
            f"WITH path ORDER BY length(path) DESC LIMIT 1 "
            f"RETURN [n IN nodes(path)[1..] | n.urn] AS chain",
            params={"urn": urn},
        )
        if result.result_set and result.result_set[0][0]:
            return result.result_set[0][0]
        return []

    async def _compute_and_store_ancestors_bulk(
        self,
        urns: List[str],
    ) -> Dict[str, List[str]]:
        """Compute and cache ancestor chains for multiple URNs at once.

        Uses Redis pipeline for batch HSET — zero extra round-trips.
        """
        cache_key = f"{self._graph_name}:ancestors"
        result: Dict[str, List[str]] = {}

        # First, try to fetch all from cache in one pipeline
        try:
            pipe = self._redis.pipeline(transaction=False)
            for u in urns:
                pipe.execute_command("HGET", cache_key, u)
            cached = await pipe.execute()

            missing_urns = []
            for i, u in enumerate(urns):
                if cached[i]:
                    result[u] = json.loads(cached[i])
                else:
                    missing_urns.append(u)
        except Exception:
            missing_urns = list(urns)

        # Compute missing chains
        if missing_urns:
            store_pipe = self._redis.pipeline(transaction=False)
            for u in missing_urns:
                chain = await self._compute_ancestor_chain(u)
                result[u] = chain
                store_pipe.execute_command("HSET", cache_key, u, json.dumps(chain))
            try:
                await store_pipe.execute()
            except Exception as e:
                logger.debug(f"Failed to batch-store ancestor chains: {e}")

        return result

    async def on_lineage_edge_written(
        self,
        source_urn: str,
        target_urn: str,
        edge_id: str,
        edge_type: str,
    ) -> int:
        """Materialize AGGREGATED edges when a lineage edge is written.

        Uses pre-computed ancestor chains instead of Cypher variable-length
        paths, eliminating the Cartesian product explosion.

        Idempotency: Uses Redis Sets to track which leaf edges contribute
        to each AGGREGATED pair. SADD is naturally idempotent.

        Batching: Collects all new pairs, then issues a single UNWIND+MERGE
        instead of one Cypher call per ancestor pair.

        Returns the number of AGGREGATED pairs whose graph edge was
        newly created or had its weight/sourceEdgeTypes updated as a
        result of this call. Returns 0 if every pair was already
        recorded in the Redis idempotency set (nothing to do). Callers
        sum this across the batch to report *actual graph edges
        affected* rather than *input edges processed*.
        """
        await self._ensure_connected()

        s_ancestors = await self._get_ancestor_chain(source_urn)
        t_ancestors = await self._get_ancestor_chain(target_urn)

        s_chain = [source_urn] + s_ancestors
        t_chain = [target_urn] + t_ancestors

        members_key_prefix = f"{self._graph_name}:agg_members"

        # Phase 1: Redis SADD pipeline to check idempotency for all pairs at once
        pairs_to_check = []
        for s_urn in s_chain:
            for t_urn in t_chain:
                if s_urn != t_urn:
                    pairs_to_check.append((s_urn, t_urn))

        if not pairs_to_check:
            return 0

        # Pipeline: SADD for all pairs
        try:
            pipe = self._redis.pipeline(transaction=False)
            for s_urn, t_urn in pairs_to_check:
                member_key = f"{members_key_prefix}:{s_urn}:{t_urn}"
                pipe.execute_command("SADD", member_key, edge_id)
            sadd_results = await pipe.execute()
        except Exception:
            sadd_results = [1] * len(pairs_to_check)

        # Phase 2: SCARD pipeline for pairs that were newly added
        new_pairs = [(pairs_to_check[i], sadd_results[i]) for i in range(len(pairs_to_check)) if sadd_results[i] != 0]
        if not new_pairs:
            return 0

        try:
            pipe = self._redis.pipeline(transaction=False)
            for (s_urn, t_urn), _ in new_pairs:
                member_key = f"{members_key_prefix}:{s_urn}:{t_urn}"
                pipe.execute_command("SCARD", member_key)
            scard_results = await pipe.execute()
        except Exception:
            scard_results = [1] * len(new_pairs)

        # Phase 3: Single UNWIND+MERGE for all new pairs
        merge_batch = []
        for i, ((s_urn, t_urn), _) in enumerate(new_pairs):
            weight = scard_results[i] if scard_results[i] else 1
            merge_batch.append({"s": s_urn, "t": t_urn, "w": int(weight)})

        proj = self._proj
        try:
            await proj.query(
                "UNWIND $batch AS item "
                "MERGE (s {urn: item.s}) "
                "MERGE (t {urn: item.t}) "
                "MERGE (s)-[r:AGGREGATED]->(t) "
                "SET r.weight = item.w, "
                "r.sourceEdgeTypes = CASE "
                "  WHEN r.sourceEdgeTypes IS NULL THEN [$edgeType] "
                "  WHEN NOT $edgeType IN r.sourceEdgeTypes "
                "    THEN r.sourceEdgeTypes + $edgeType "
                "  ELSE r.sourceEdgeTypes END, "
                "r.latestUpdate = timestamp()",
                params={"batch": merge_batch, "edgeType": edge_type},
            )
            return len(merge_batch)
        except Exception as e:
            logger.error(f"Batched AGGREGATED MERGE failed: {e}")
            return 0

    async def on_lineage_edge_deleted(
        self,
        source_urn: str,
        target_urn: str,
        edge_id: str,
    ) -> None:
        """Decrement AGGREGATED edge weights when a lineage edge is removed.

        Batched: single SREM pipeline → single SCARD pipeline →
        one UNWIND+SET for weight updates + one UNWIND+DELETE for empty pairs.
        """
        await self._ensure_connected()

        s_ancestors = await self._get_ancestor_chain(source_urn)
        t_ancestors = await self._get_ancestor_chain(target_urn)

        s_chain = [source_urn] + s_ancestors
        t_chain = [target_urn] + t_ancestors

        members_key_prefix = f"{self._graph_name}:agg_members"
        pairs = [(s, t) for s in s_chain for t in t_chain if s != t]
        if not pairs:
            return

        # Phase 1: Pipeline SREM for all pairs
        try:
            pipe = self._redis.pipeline(transaction=False)
            for s_urn, t_urn in pairs:
                pipe.srem(f"{members_key_prefix}:{s_urn}:{t_urn}", edge_id)
            await pipe.execute()
        except Exception:
            pass

        # Phase 2: Pipeline SCARD to get remaining counts
        try:
            pipe = self._redis.pipeline(transaction=False)
            for s_urn, t_urn in pairs:
                pipe.scard(f"{members_key_prefix}:{s_urn}:{t_urn}")
            counts = await pipe.execute()
        except Exception:
            return  # Can't determine counts — bail

        # Phase 3: Separate into delete (count=0) vs update (count>0)
        delete_batch = []
        update_batch = []
        cleanup_keys = []
        for i, (s_urn, t_urn) in enumerate(pairs):
            remaining = counts[i] if i < len(counts) else None
            if remaining == 0:
                delete_batch.append({"s": s_urn, "t": t_urn})
                cleanup_keys.append(f"{members_key_prefix}:{s_urn}:{t_urn}")
            elif remaining is not None:
                update_batch.append({"s": s_urn, "t": t_urn, "w": int(remaining)})

        proj = self._proj
        if delete_batch:
            try:
                await proj.query(
                    "UNWIND $batch AS item "
                    "MATCH (s {urn: item.s})-[r:AGGREGATED]->(t {urn: item.t}) "
                    "DELETE r",
                    params={"batch": delete_batch},
                )
                # Clean up empty Redis keys
                pipe = self._redis.pipeline(transaction=False)
                for key in cleanup_keys:
                    pipe.delete(key)
                await pipe.execute()
            except Exception as e:
                logger.error(f"Batched AGGREGATED DELETE failed: {e}")

        if update_batch:
            try:
                await proj.query(
                    "UNWIND $batch AS item "
                    "MATCH (s {urn: item.s})-[r:AGGREGATED]->(t {urn: item.t}) "
                    "SET r.weight = item.w, r.latestUpdate = timestamp()",
                    params={"batch": update_batch},
                )
            except Exception as e:
                logger.error(f"Batched AGGREGATED weight update failed: {e}")

    async def on_containment_changed(self, urn: str) -> None:
        """Invalidate ancestor cache for a node and its descendants, then rebuild.

        When a node's parent changes, its entire subtree's ancestor chains
        are invalidated and lazily recomputed on next access.
        """
        await self._ensure_connected()
        cache_key = f"{self._graph_name}:ancestors"

        # Invalidate this node's cached chain
        try:
            await self._redis.hdel(cache_key, urn)
        except Exception:
            pass

        # Invalidate descendants (BFS through containment)
        containment = list(self._get_containment_edge_types())
        queue = deque([urn])
        visited: Set[str] = {urn}

        while queue:
            current = queue.popleft()
            result = await self._graph.ro_query(
                "MATCH (p)-[r]->(c) WHERE p.urn = $urn AND type(r) IN $ctypes RETURN c.urn",
                params={"urn": current, "ctypes": containment},
            )
            child_urns = [row[0] for row in (result.result_set or []) if row[0] and row[0] not in visited]
            if child_urns:
                try:
                    pipe = self._redis.pipeline(transaction=False)
                    for cu in child_urns:
                        pipe.execute_command("HDEL", cache_key, cu)
                        visited.add(cu)
                        queue.append(cu)
                    await pipe.execute()
                except Exception:
                    pass

        logger.info(f"Invalidated ancestor cache for {len(visited)} nodes under {urn}")

    async def purge_aggregated_edges(self) -> int:
        """Remove ALL materialized AGGREGATED edges from the graph.

        Also deletes the Redis ``{graph_name}:agg_members:*`` tracking
        sets. These sets are the idempotency state used by
        :meth:`on_lineage_edge_written` (SADD returns 0 when an edge_id
        is already a member, short-circuiting the MERGE). If they are
        NOT purged together with the graph edges, the next materialize
        run silently no-ops — the source edges appear "already
        contributed" even though the AGGREGATED edges they produced are
        gone from the graph, and the caller sees
        ``aggregated_edges_affected`` numbers that match the input
        count but 0 edges actually written to the graph.

        The Redis key prefix was renamed from ``agg:sourceEdgeIds:`` to
        ``agg_members:`` in an earlier refactor of
        :meth:`on_lineage_edge_written`; this method's scan pattern was
        not updated and so cleaned nothing until this fix.
        """
        await self._ensure_connected()
        proj = self._proj
        try:
            result = await proj.query(
                "MATCH ()-[r:AGGREGATED]->() "
                "WITH r LIMIT 100000 "
                "DELETE r "
                "RETURN count(r) as deleted"
            )
            deleted = result.result_set[0][0] if result.result_set else 0

            # Clean up Redis tracking keys for this graph. Must match the
            # prefix used by on_lineage_edge_written exactly (see docstring).
            pattern = f"{self._graph_name}:agg_members:*"
            cursor = 0
            cleaned = 0
            while True:
                cursor, keys = await self._redis.scan(cursor, match=pattern, count=500)
                if keys:
                    await self._redis.delete(*keys)
                    cleaned += len(keys)
                if cursor == 0:
                    break

            logger.info(
                "Purged %d AGGREGATED edges and %d Redis tracking keys from %s",
                deleted, cleaned, self._graph_name,
            )
            return deleted
        except Exception as e:
            logger.error("Failed to purge AGGREGATED edges: %s", e)
            raise

    async def materialize_lineage_for_edge(
        self,
        source_urn: str,
        target_urn: str,
        lineage_edge_type: str,
    ) -> bool:
        """Legacy wrapper — delegates to on_lineage_edge_written."""
        try:
            edge_id = f"{source_urn}|{lineage_edge_type}|{target_urn}"
            await self.on_lineage_edge_written(source_urn, target_urn, edge_id, lineage_edge_type)
            return True
        except Exception as e:
            logger.error(f"Failed to materialize lineage: {e}")
            return False

    async def materialize_aggregated_edges_batch(
        self,
        batch_size: int = 1000,
        containment_edge_types: Optional[List[str]] = None,
        lineage_edge_types: Optional[List[str]] = None,
        last_cursor: Optional[str] = None,
        progress_callback: Optional[Any] = None,
    ) -> Dict[str, Any]:
        """Batch materialization using ancestor-chain approach with cursor-based pagination.

        Instead of Cypher variable-length paths with Cartesian products,
        this uses pre-computed ancestor chains stored in Redis Hashes.

        CURSOR-BASED PAGINATION (CRIT-2):
        - Uses stable cursor on sorted composite key (s.urn + '|' + t.urn)
        - Eliminates O(n²) degradation from SKIP at large offsets
        - Safe under concurrent graph mutations
        - Resume from last_cursor after crash/restart

        Args:
            batch_size: Number of edges to process per batch
            containment_edge_types: Structural edge types (from ontology)
            lineage_edge_types: Functional edge types (from ontology)
            last_cursor: Resume point — composite key of last processed edge
            progress_callback: async fn(processed, total, cursor, created_count) for checkpointing
        """
        await self._ensure_connected()

        containment = containment_edge_types or list(self._get_containment_edge_types())
        exclude_types = list(containment) + ["AGGREGATED"]

        # Filter AGGREGATED out of any explicit lineage whitelist. The
        # ontology can legitimately list AGGREGATED as a lineage-category
        # relationship (it is the *result* of aggregation), but feeding
        # existing AGGREGATED edges back into this loop produces new
        # AGGREGATED edges from ancestor chains of the previously-
        # aggregated pairs, compounding on every re-run. This was the
        # cause of the API vs seed_falkordb count divergence: after the
        # first materialization, each API run multiplied the AGGREGATED
        # count whereas the seed-script fallback branch (``NOT IN
        # exclude_types``) already excluded AGGREGATED correctly.
        if lineage_edge_types:
            effective_lineage_types = [t for t in lineage_edge_types if t != "AGGREGATED"]
            if not effective_lineage_types:
                logger.warning(
                    "materialize_aggregated_edges_batch: lineage_edge_types contained "
                    "only AGGREGATED after filtering; no leaf lineage edges to process. "
                    "Check the ontology's is_lineage flags."
                )
                return {"processed": 0, "aggregated_edges_affected": 0, "errors": 0}
            type_filter = "WHERE type(r) IN $lineageEdges"
            type_params: Dict[str, Any] = {"lineageEdges": effective_lineage_types}
        else:
            type_filter = "WHERE NOT type(r) IN $excludeTypes"
            type_params = {"excludeTypes": exclude_types}

        # Count total lineage edges
        count_cypher = f"MATCH ()-[r]->() {type_filter} RETURN count(r)"
        count_res = await self._graph.ro_query(count_cypher, params=type_params)
        total = count_res.result_set[0][0] if count_res.result_set else 0

        logger.info(f"Batch materialization: {total} lineage edges to process (cursor: {last_cursor or 'start'})")

        processed = 0
        errors = 0
        created_count = 0
        current_cursor = last_cursor

        while True:
            # Cursor-based batch fetch — sorted composite key for stable ordering
            if current_cursor:
                batch_cypher = (
                    f"MATCH (s)-[r]->(t) {type_filter} "
                    f"AND (s.urn + '|' + t.urn) > $cursor "
                    f"RETURN s.urn, t.urn, type(r), r.id "
                    f"ORDER BY s.urn + '|' + t.urn LIMIT $limit"
                )
                batch_params = {**type_params, "cursor": current_cursor, "limit": batch_size}
            else:
                batch_cypher = (
                    f"MATCH (s)-[r]->(t) {type_filter} "
                    f"RETURN s.urn, t.urn, type(r), r.id "
                    f"ORDER BY s.urn + '|' + t.urn LIMIT $limit"
                )
                batch_params = {**type_params, "limit": batch_size}

            # Do NOT silently break on batch-fetch failure — that path
            # lets a provider outage mid-aggregation flow through the
            # worker as if the job completed successfully (the worker
            # reads our ``stats`` dict, sees no exception, and marks
            # status=completed with whatever ``processed`` count we
            # managed before the failure). Re-raise so the worker's
            # outer try/except transitions the job to ``failed`` and
            # preserves ``last_cursor`` for crash-resume. The provider
            # is either back (resume succeeds) or still down (breaker
            # opens and triggers 503 upstream).
            res = await self._graph.ro_query(batch_cypher, params=batch_params)
            rows = res.result_set or []

            if not rows:
                break

            # Pre-compute ancestor chains for all URNs in this batch
            all_urns = set()
            for row in rows:
                all_urns.add(row[0])
                all_urns.add(row[1])
            await self._compute_and_store_ancestors_bulk(list(all_urns))

            # Now materialize each edge using cached ancestor chains. The
            # returned count is the number of AGGREGATED graph edges
            # actually created or weight-updated by this call — not the
            # number of input edges processed. Sum these so the caller
            # sees the real graph effect; a count of 0 means the Redis
            # idempotency sets already recorded every ancestor pair for
            # these input edges (e.g. after a repeat run that produced
            # no new AGGREGATED state).
            for row in rows:
                s_urn, t_urn, edge_type, edge_id = row[0], row[1], row[2], row[3]
                if not edge_id:
                    edge_id = f"{s_urn}|{edge_type}|{t_urn}"
                try:
                    affected = await self.on_lineage_edge_written(
                        s_urn, t_urn, edge_id, edge_type,
                    )
                    created_count += int(affected or 0)
                except Exception as e:
                    logger.error(f"Materialization error for {s_urn}->{t_urn}: {e}")
                    errors += 1

            processed += len(rows)
            # Update cursor to last row's composite key
            last_row = rows[-1]
            current_cursor = f"{last_row[0]}|{last_row[1]}"

            logger.info(f"Batch materialization: {processed}/{total} edges processed")

            # Checkpoint via callback (for worker DB persistence)
            if progress_callback:
                try:
                    await progress_callback(processed, total, current_cursor, created_count)
                except Exception as e:
                    logger.error(f"Progress callback failed: {e}")

            # If we got fewer rows than batch_size, we've reached the end
            if len(rows) < batch_size:
                break

        stats = {
            "processed": processed,
            # Historical key name — kept for back-compat with
            # aggregation_jobs.created_edges; now correctly counts the
            # number of AGGREGATED graph edges created or updated, not
            # the number of input lineage edges iterated.
            "aggregated_edges_affected": created_count,
            # New stat so callers + dashboards can distinguish
            # "touched N input edges" from "wrote M aggregated edges".
            # On a clean run these two are typically proportional; when
            # they diverge the operator has a clear signal that the
            # Redis idempotency sets are in a surprising state.
            "input_edges_processed": processed,
            "errors": errors,
        }
        logger.info(f"Batch materialization complete: {stats}")
        return stats

    async def get_aggregated_edges_between(
        self,
        source_urns: List[str],
        target_urns: Optional[List[str]],
        granularity: Any,
        containment_edges: List[str],
        lineage_edges: List[str],
    ) -> AggregatedEdgeResult:
        """Read pre-materialized AGGREGATED edges from the projection graph.

        Pure index lookup — O(|sourceUrns|), sub-millisecond at any scale.
        No live fallback: if materialization hasn't run, returns empty result
        so the caller knows to trigger a backfill.
        """
        await self._ensure_connected()

        proj = self._proj

        if target_urns:
            cypher = (
                "MATCH (s)-[r:AGGREGATED]->(t) "
                "WHERE s.urn IN $sourceUrns AND t.urn IN $targetUrns "
                "AND s.urn <> t.urn "
                "RETURN s.urn AS sUrn, t.urn AS tUrn, "
                "r.weight AS weight, r.sourceEdgeTypes AS types "
                "ORDER BY r.weight DESC"
            )
            params: Dict[str, Any] = {
                "sourceUrns": source_urns,
                "targetUrns": target_urns,
            }
        else:
            cypher = (
                "MATCH (s)-[r:AGGREGATED]->(t) "
                "WHERE s.urn IN $sourceUrns "
                "AND s.urn <> t.urn "
                "RETURN s.urn AS sUrn, t.urn AS tUrn, "
                "r.weight AS weight, r.sourceEdgeTypes AS types "
                "ORDER BY r.weight DESC"
            )
            params = {"sourceUrns": source_urns}

        try:
            result = await proj.ro_query(cypher, params=params)
            rows = result.result_set or []
        except Exception as e:
            logger.warning(f"AGGREGATED edge read failed: {e}")
            rows = []

        return self._rows_to_aggregated_result(rows)

    # ------------------------------------------------------------------
    # Helpers for get_aggregated_edges_between
    # ------------------------------------------------------------------

    def _rows_to_aggregated_result(self, rows: list) -> AggregatedEdgeResult:
        """Convert raw Cypher result rows into AggregatedEdgeResult."""
        aggregated = []
        total_edges = 0
        for row in rows:
            s_urn, t_urn, weight, types = row[0], row[1], row[2], row[3]
            w = int(weight) if weight else 1
            edge_types = types if isinstance(types, list) else [str(types)] if types else []
            aggregated.append(AggregatedEdgeInfo(
                id=f"agg-{s_urn}-{t_urn}",
                sourceUrn=s_urn,
                targetUrn=t_urn,
                edgeCount=w,
                edgeTypes=edge_types,
                confidence=1.0,
                sourceEdgeIds=[],
            ))
            total_edges += w
        return AggregatedEdgeResult(aggregatedEdges=aggregated, totalSourceEdges=total_edges)

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
        
        safe_containment = [_sanitize_label(t) for t in containment_edges]
        safe_lineage = [_sanitize_label(t) for t in lineage_edges]
        
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
            res_kids = await self._graph.ro_query(
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
                res = await self._graph.ro_query(
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

                 res_struct = await self._graph.ro_query(
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

    async def get_stats(self) -> Dict[str, Any]:
        await self._ensure_connected()

        # Check Redis cache (60s TTL)
        cache_key = f"{self._graph_name}:stats_cache"
        try:
            cached = await self._redis.get(cache_key)
            if cached:
                return json.loads(cached)
        except Exception:
            pass

        # Optimize: Combine node counting with type aggregation
        type_res = await self._graph.ro_query(
            "MATCH (n) RETURN labels(n)[0] AS lbl, count(*) AS c"
        )
        entity_type_counts = {}
        node_count = 0
        for row in (type_res.result_set or []):
            lbl = row[0] or "unknown"
            cnt = row[1]
            entity_type_counts[lbl] = cnt
            node_count += cnt

        # Optimize: Combine edge counting with type aggregation
        edge_type_res = await self._graph.ro_query(
            "MATCH ()-[r]->() RETURN type(r) AS t, count(*) AS c"
        )
        edge_type_counts = {}
        edge_count = 0
        for row in (edge_type_res.result_set or []):
            t = row[0] or "UNKNOWN"
            cnt = row[1]
            edge_type_counts[t] = cnt
            edge_count += cnt

        result = {
            "nodeCount": node_count,
            "edgeCount": edge_count,
            "entityTypeCounts": entity_type_counts,
            "edgeTypeCounts": edge_type_counts,
        }

        try:
            await self._redis.setex(cache_key, 60, json.dumps(result))
        except Exception:
            pass

        return result

    async def get_schema_stats(self) -> GraphSchemaStats:
        await self._ensure_connected()
        
        # Single query: counts + samples per label using collect() with slicing
        type_res = await self._graph.ro_query(
            "MATCH (n) "
            "WITH labels(n)[0] AS lbl, n.displayName AS name "
            "WITH lbl, count(*) AS c, collect(name)[0..3] AS samples "
            "RETURN lbl, c, samples"
        )

        entity_stats = []
        total_nodes = 0

        for row in (type_res.result_set or []):
            lbl = row[0] or "unknown"
            cnt = row[1]
            samples = [s for s in (row[2] or []) if s]
            total_nodes += cnt
            entity_stats.append(EntityTypeSummary(id=lbl, name=lbl, count=cnt, sampleNames=samples))

        edge_type_res = await self._graph.ro_query(
            "MATCH ()-[r]->() RETURN type(r) AS t, count(*) AS c"
        )
        edge_stats = []
        total_edges = 0
        
        for row in (edge_type_res.result_set or []):
            t = row[0] or "UNKNOWN"
            cnt = row[1]
            edge_stats.append(EdgeTypeSummary(id=t, name=t, count=cnt))
            total_edges += cnt

        # Tag stats - kept as is for now, but ensured safe execution
        try:
            tag_res = await self._graph.ro_query(
                "MATCH (n) WHERE n.tags IS NOT NULL AND n.tags <> '[]' RETURN n.tags"
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

        cache_key = f"{self._graph_name}:ontology_cache"
        try:
            cached = await self._redis.get(cache_key)
            if cached:
                return OntologyMetadata(**json.loads(cached))
        except Exception:
            pass

        containment = list(self._get_containment_edge_types())
        containment_upper = {t.upper() for t in containment}
        
        # 1. Determine Lineage Types
        # Instead of fetching all edges, we query distinct types
        type_res = await self._graph.ro_query("MATCH ()-[r]->() RETURN DISTINCT type(r)")
        all_types = [row[0] for row in (type_res.result_set or [])]
        
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
        hierarchy_res = await self._graph.ro_query(
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

        try:
            await self._redis.setex(cache_key, 60, result.model_dump_json())
        except Exception:
            pass

        return result

    async def get_distinct_values(self, property_name: str) -> List[Any]:
        await self._ensure_connected()
        if property_name in ("entityType", "entitytype"):
            res = await self._graph.ro_query("MATCH (n) RETURN DISTINCT labels(n)[0] AS lbl")
            return [row[0] for row in (res.result_set or []) if row[0]]
        if property_name == "tags":
            res = await self._graph.ro_query("MATCH (n) RETURN n.tags")
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
            res = await self._graph.ro_query(
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

        result = await self._graph.ro_query(cypher, params=params)
        nodes = []
        for row in (result.result_set or []):
            n = self._extract_node_from_result(row)
            if n:
                nodes.append(n)
        return nodes

    async def get_nodes_by_tag(self, tag: str, limit: int = 100, offset: int = 0) -> List[GraphNode]:
        await self._ensure_connected()
        tag_pattern = json.dumps(tag)
        result = await self._graph.ro_query(
            "MATCH (n) WHERE n.tags IS NOT NULL AND n.tags CONTAINS $tag RETURN n SKIP $skip LIMIT $limit",
            params={"tag": tag_pattern, "skip": offset, "limit": limit},
        )
        nodes = []
        for row in (result.result_set or []):
            n = self._extract_node_from_result(row)
            if n and tag in (n.tags or []):
                nodes.append(n)
        return nodes

    async def get_nodes_by_layer(self, layer_id: str, limit: int = 100, offset: int = 0) -> List[GraphNode]:
        await self._ensure_connected()
        result = await self._graph.ro_query(
            "MATCH (n) WHERE n.layerAssignment = $lid RETURN n SKIP $skip LIMIT $limit",
            params={"lid": layer_id, "skip": offset, "limit": limit},
        )
        return [self._extract_node_from_result(row) for row in (result.result_set or []) if self._extract_node_from_result(row)]

    async def save_custom_graph(self, nodes: List[GraphNode], edges: List[GraphEdge]) -> bool:
        """Batch-save nodes and edges using UNWIND for bulk writes.

        Groups nodes by label (entity type) so each UNWIND+MERGE targets
        a single label — enabling index-assisted lookups. Turns N individual
        queries into ceil(N/batch_size) queries per label.
        """
        await self._ensure_connected()
        batch_size = 500

        # Group nodes by label for label-specific MERGE
        nodes_by_label: Dict[str, list] = defaultdict(list)
        for node in nodes:
            label = _sanitize_label(str(node.entity_type))
            nodes_by_label[label].append({
                "urn": node.urn,
                "displayName": node.display_name or "",
                "qualifiedName": node.qualified_name or "",
                "description": node.description or "",
                "properties": json.dumps(node.properties),
                "tags": json.dumps(node.tags or []),
                "layerAssignment": node.layer_assignment or "",
                "childCount": node.child_count or 0,
                "sourceSystem": node.source_system or "",
                "lastSyncedAt": node.last_synced_at or "",
            })

        # Bulk-cache urn→label mappings
        label_mapping = {}
        for label, items in nodes_by_label.items():
            for item in items:
                label_mapping[item["urn"]] = label
            for i in range(0, len(items), batch_size):
                batch = items[i : i + batch_size]
                try:
                    await self._graph.query(
                        f"UNWIND $batch AS item "
                        f"MERGE (n:{label} {{urn: item.urn}}) "
                        f"SET n.displayName = item.displayName, "
                        f"n.qualifiedName = item.qualifiedName, "
                        f"n.description = item.description, "
                        f"n.properties = item.properties, "
                        f"n.tags = item.tags, "
                        f"n.layerAssignment = item.layerAssignment, "
                        f"n.childCount = item.childCount, "
                        f"n.sourceSystem = item.sourceSystem, "
                        f"n.lastSyncedAt = item.lastSyncedAt",
                        params={"batch": batch},
                    )
                except Exception as e:
                    logger.warning(f"Batch node merge failed for label {label}: {e}")
        await self._cache_urn_labels_bulk(label_mapping)

        # Group edges by relationship type for type-specific MERGE
        edges_by_type: Dict[str, list] = defaultdict(list)
        for edge in edges:
            rel_type = _sanitize_label(str(edge.edge_type))
            edges_by_type[rel_type].append({
                "src": edge.source_urn,
                "tgt": edge.target_urn,
                "eid": edge.id,
                "conf": edge.confidence,
                "props": json.dumps(edge.properties),
            })

        for rel_type, items in edges_by_type.items():
            for i in range(0, len(items), batch_size):
                batch = items[i : i + batch_size]
                try:
                    await self._graph.query(
                        f"UNWIND $batch AS item "
                        f"MATCH (a {{urn: item.src}}) "
                        f"MATCH (b {{urn: item.tgt}}) "
                        f"MERGE (a)-[r:{rel_type}]->(b) "
                        f"SET r.id = item.eid, r.confidence = item.conf, "
                        f"r.properties = item.props",
                        params={"batch": batch},
                    )
                except Exception as e:
                    logger.warning(f"Batch edge merge failed for type {rel_type}: {e}")

        return True

    async def create_node(self, node: GraphNode, containment_edge: Optional[GraphEdge] = None) -> bool:
        await self._ensure_connected()
        try:
            label = _sanitize_label(str(node.entity_type))
            params = {
                "urn": node.urn,
                "displayName": node.display_name or "",
                "qualifiedName": node.qualified_name or "",
                "description": node.description or "",
                "properties": json.dumps(node.properties),
                "tags": json.dumps(node.tags or []),
                "layerAssignment": node.layer_assignment or "",
                "childCount": node.child_count,
                "sourceSystem": node.source_system or "",
                "lastSyncedAt": node.last_synced_at or "",
            }
            await self._graph.query(
                f"MERGE (n:{label} {{urn: $urn}}) SET n += $p",
                params={"urn": node.urn, "p": params},
            )
            await self._cache_urn_label(node.urn, label)
            if containment_edge:
                rel_type = _sanitize_label(str(containment_edge.edge_type))
                await self._graph.query(
                    f"""
                    MATCH (a {{urn: $src}}) MATCH (b {{urn: $tgt}})
                    MERGE (a)-[r:{rel_type}]->(b)
                    SET r.id = $eid, r.confidence = $conf
                    """,
                    params={
                        "src": containment_edge.source_urn,
                        "tgt": containment_edge.target_urn,
                        "eid": containment_edge.id,
                        "conf": containment_edge.confidence,
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
            rel_type = _sanitize_label(str(edge.edge_type))
            await self._graph.query(
                f"MATCH (a {{urn: $src}}) MATCH (b {{urn: $tgt}}) "
                f"MERGE (a)-[r:{rel_type}]->(b) "
                f"SET r.id = $eid, r.confidence = $conf, r.properties = $props",
                params={
                    "src": edge.source_urn,
                    "tgt": edge.target_urn,
                    "eid": edge.id,
                    "conf": edge.confidence or 1.0,
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
            result = await self._graph.query(
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
            result = await self._graph.query(
                "MATCH ()-[r]->() WHERE r.id = $eid DELETE r RETURN count(r)",
                params={"eid": edge_id},
            )
            if result.result_set and result.result_set[0][0] > 0:
                return True
            return False
        except Exception as e:
            logger.error(f"delete_edge failed: {e}")
            return False

    # ------------------------------------------------------------------ #
    # ProviderRegistry lifecycle helpers                                   #
    # ------------------------------------------------------------------ #

    async def list_graphs(self) -> list:
        """Return all graph keys on this FalkorDB instance via GRAPH.LIST."""
        await self._ensure_connected()
        try:
            result = await self._db.execute_command("GRAPH.LIST")
            return list(result) if result else []
        except Exception as exc:
            logger.warning("GRAPH.LIST failed: %s", exc)
            return []

    async def close(self) -> None:
        """Release both connection pools held by this provider."""
        try:
            if hasattr(self, "_redis") and self._redis is not None:
                await self._redis.aclose()
            if self._redis_pool is not None:
                await self._redis_pool.aclose()
            if self._pool is not None:
                await self._pool.aclose()
        except Exception as exc:
            logger.warning("Error closing FalkorDB pools: %s", exc)
        finally:
            self._graph = None
            self._proj_graph = None
            self._pool = None
            self._redis_pool = None
            self._redis = None
            self._db = None
