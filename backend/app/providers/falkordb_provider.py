"""
FalkorDB graph provider - persists graph data in FalkorDB and loads it via the application.
Implements GraphDataProvider interface using FalkorDB async client and Cypher queries.
"""

import json
import logging
import os
from collections import deque
from typing import List, Optional, Dict, Any, Set

from ..models.graph import (
    GraphNode, GraphEdge, NodeQuery, EdgeQuery,
    LineageResult, EntityType, EdgeType, GraphSchemaStats,
    PropertyFilter, TagFilter, TextFilter, FilterOperator,
    EntityTypeSummary, EdgeTypeSummary, TagSummary,
    OntologyMetadata, EdgeTypeMetadata, EntityTypeHierarchy,
    AggregatedEdgeResult, AggregatedEdgeInfo
)
from .base import GraphDataProvider

logger = logging.getLogger(__name__)


def _sanitize_label(s: str) -> str:
    """Sanitize string for use as FalkorDB label/relationship type (alphanumeric + underscore)."""
    return "".join(c if c.isalnum() or c == "_" else "_" for c in str(s))


def _node_from_props(props: Dict[str, Any], entity_type_str: Optional[str] = None) -> Optional[GraphNode]:
    """Build GraphNode from FalkorDB node properties."""
    if not props or "urn" not in props:
        return None
    entity_type = entity_type_str or props.get("entityType", "container")
    try:
        et_enum = EntityType(entity_type) if isinstance(entity_type, str) else entity_type
    except ValueError:
        et_enum = EntityType.CONTAINER
    try:
        return GraphNode(
            urn=props["urn"],
            entityType=et_enum,
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
    try:
        et = EdgeType(rel_type) if isinstance(rel_type, str) else rel_type
    except ValueError:
        et = EdgeType.RELATED_TO
    return GraphEdge(
        id=edge_id,
        sourceUrn=source_urn,
        targetUrn=target_urn,
        edgeType=et,
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
        graph_name: str = "nexus",
        seed_file: Optional[str] = None,
    ):
        self._host = host
        self._port = port
        self._graph_name = graph_name
        self._seed_file = seed_file
        self._graph = None
        self._pool = None
        self._db = None

    async def _ensure_connected(self):
        """Lazy connection to FalkorDB."""
        if self._graph is not None:
            return
        try:
            from redis.asyncio import BlockingConnectionPool
            from falkordb.asyncio import FalkorDB

            self._pool = BlockingConnectionPool(
                host=self._host,
                port=self._port,
                max_connections=16,
                timeout=None,
                decode_responses=True,
            )
            self._db = FalkorDB(connection_pool=self._pool)
            self._graph = self._db.select_graph(self._graph_name)

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

    @property
    def name(self) -> str:
        return "FalkorDBProvider"

    def _get_containment_edge_types(self) -> Set[str]:
        config = os.getenv("CONTAINMENT_EDGE_TYPES", "").strip()
        if config:
            return {t.strip().upper() for t in config.split(",") if t.strip()}
        return {EdgeType.CONTAINS.value, EdgeType.BELONGS_TO.value}

    def _extract_node_from_result(self, row) -> Optional[GraphNode]:
        """Extract GraphNode from a FalkorDB result row (Node or dict of properties)."""
        if not row:
            return None
        cell = row[0] if isinstance(row, (list, tuple)) else row
        if hasattr(cell, "properties"):
            props = cell.properties or {}
            labels = getattr(cell, "labels", None) or []
            entity_type = labels[0] if labels else props.get("entityType", "container")
            return _node_from_props(props, entity_type)
        if isinstance(cell, dict):
            return _node_from_props(cell)
        return None

    def _extract_props_from_node(self, row) -> Optional[Dict]:
        """Extract properties dict from a FalkorDB node result."""
        if not row:
            return None
        cell = row[0] if isinstance(row, (list, tuple)) else row
        if hasattr(cell, "properties"):
            return cell.properties
        if isinstance(cell, dict):
            return cell
        return None

    async def get_node(self, urn: str) -> Optional[GraphNode]:
        await self._ensure_connected()
        result = await self._graph.ro_query(
            "MATCH (n) WHERE n.urn = $urn RETURN n",
            params={"urn": urn},
        )
        if result.result_set and len(result.result_set) > 0:
            return self._extract_node_from_result(result.result_set[0])
        return None

    async def get_nodes(self, query: NodeQuery) -> List[GraphNode]:
        await self._ensure_connected()

        clauses = ["MATCH (n)"]
        params: Dict[str, Any] = {}
        conditions = []

        if query.urns:
            # FalkorDB IN with list - use UNWIND or multiple OR
            if len(query.urns) == 1:
                conditions.append("n.urn = $urn0")
                params["urn0"] = query.urns[0]
            else:
                urns_param = "urnList"
                params[urns_param] = query.urns
                conditions.append(f"n.urn IN ${urns_param}")

        if query.entity_types:
            types = [t.value if hasattr(t, "value") else str(t) for t in query.entity_types]
            params["entityTypes"] = types
            conditions.append(f"labels(n)[0] IN $entityTypes")

        if query.tags:
            # Tags stored as JSON array string - match quoted tag in JSON
            params["tagVal"] = json.dumps(query.tags[0])
            conditions.append("(n.tags IS NOT NULL AND n.tags CONTAINS $tagVal)")

        if query.search_query:
            params["search"] = query.search_query.lower()
            conditions.append("(toLower(toString(n.displayName)) CONTAINS $search OR toLower(toString(n.urn)) CONTAINS $search)")

        if conditions:
            clauses.append("WHERE " + " AND ".join(conditions))

        offset = int(query.offset or 0)
        limit = query.limit or 100
        params["skip"] = offset
        params["limit"] = limit
        clauses.append("RETURN n SKIP $skip LIMIT $limit")

        cypher = " ".join(clauses)

        try:
            result = await self._graph.ro_query(cypher, params=params)
        except Exception as e:
            logger.warning(f"get_nodes query failed, falling back to simpler query: {e}")
            result = await self._graph.ro_query(
                "MATCH (n) RETURN n SKIP $skip LIMIT $limit",
                params={"skip": offset, "limit": limit * 2},
            )

        nodes = []
        for row in (result.result_set or []):
            n = self._extract_node_from_result(row)
            if n:
                if query.property_filters and not self._match_property_filters(n, query.property_filters):
                    continue
                if query.tag_filters and not self._match_tag_filters(n, query.tag_filters):
                    continue
                if query.name_filter and not self._match_text_filter(n.display_name, query.name_filter):
                    continue
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

        # FalkorDB variable relationship types: use MATCH (a)-[r]->(b) and filter by type(r)
        cypher = "MATCH (a)-[r]->(b) WHERE a.urn IS NOT NULL AND b.urn IS NOT NULL"
        params: Dict[str, Any] = {}

        if query.source_urns:
            params["sourceUrns"] = query.source_urns
            cypher += " AND a.urn IN $sourceUrns"
        if query.target_urns:
            params["targetUrns"] = query.target_urns
            cypher += " AND b.urn IN $targetUrns"
        if query.any_urns:
            params["anyUrns"] = query.any_urns
            cypher += " AND (a.urn IN $anyUrns OR b.urn IN $anyUrns)"
        if query.edge_types:
            types = [t.value if hasattr(t, "value") else str(t) for t in query.edge_types]
            params["edgeTypes"] = types
            cypher += " AND type(r) IN $edgeTypes"
        if query.min_confidence is not None:
            params["minConf"] = query.min_confidence
            cypher += " AND r.confidence >= $minConf"

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
        entity_types: Optional[List[EntityType]] = None,
        edge_types: Optional[List[str]] = None,
        offset: int = 0,
        limit: int = 100,
    ) -> List[GraphNode]:
        await self._ensure_connected()
        target_edge_types = set(edge_types) if edge_types else {EdgeType.CONTAINS.value}
        rel_list = list(target_edge_types)

        if len(rel_list) == 1:
            rel = _sanitize_label(rel_list[0])
            cypher = f"MATCH (p)-[r:{rel}]->(c) WHERE p.urn = $parent RETURN c SKIP $skip LIMIT $lim"
            params: Dict[str, Any] = {"parent": parent_urn, "skip": offset, "lim": limit}
        else:
            cypher = "MATCH (p)-[r]->(c) WHERE p.urn = $parent AND type(r) IN $relTypes RETURN c SKIP $skip LIMIT $lim"
            params = {"parent": parent_urn, "relTypes": rel_list, "skip": offset, "lim": limit}

        result = await self._graph.ro_query(cypher, params=params)
        nodes = []
        for row in (result.result_set or []):
            n = self._extract_node_from_result(row)
            if n and (not entity_types or n.entity_type in entity_types):
                nodes.append(n)
        nodes.sort(key=lambda x: x.display_name)
        return nodes

    async def get_parent(self, child_urn: str) -> Optional[GraphNode]:
        await self._ensure_connected()
        containment = self._get_containment_edge_types()
        # Match any containment-type edge where child is target
        result = await self._graph.ro_query(
            "MATCH (p)-[r]->(c) WHERE c.urn = $child AND type(r) IN $ctypes RETURN p",
            params={"child": child_urn, "ctypes": list(containment)},
        )
        if result.result_set and len(result.result_set) > 0:
            return self._extract_node_from_result(result.result_set[0])
        return None

    async def _traverse_lineage(
        self,
        start_urn: str,
        direction: str,
        depth: int,
        descendant_types: Optional[List[EntityType]] = None,
    ) -> Set[str]:
        """BFS traversal for lineage (excluding containment edges)."""
        containment = self._get_containment_edge_types()
        allowed_types = None
        if descendant_types:
            allowed_types = {t.value if hasattr(t, "value") else str(t) for t in descendant_types}

        visited = set()
        queue = deque([(start_urn, 0)])
        result_urns = set()

        while queue:
            current_urn, d = queue.popleft()
            if d >= depth:
                continue
            visited.add(current_urn)

            if direction == "upstream":
                edges = await self.get_edges(EdgeQuery(target_urns=[current_urn]))
            else:
                edges = await self.get_edges(EdgeQuery(source_urns=[current_urn]))

            for e in edges:
                et = e.edge_type.value if hasattr(e.edge_type, "value") else str(e.edge_type)
                if et.upper() in containment:
                    continue
                neighbor = e.source_urn if direction == "upstream" else e.target_urn
                if allowed_types:
                    n = await self.get_node(neighbor)
                    if n:
                        nt = n.entity_type.value if hasattr(n.entity_type, "value") else str(n.entity_type)
                        if nt not in allowed_types:
                            continue
                if neighbor not in visited:
                    result_urns.add(neighbor)
                    queue.append((neighbor, d + 1))

        return result_urns

    async def get_upstream(
        self,
        urn: str,
        depth: int,
        include_column_lineage: bool = False,
        descendant_types: Optional[List[EntityType]] = None,
    ) -> LineageResult:
        upstream_urns = await self._traverse_lineage(urn, "upstream", depth, descendant_types)
        all_urns = upstream_urns | {urn}
        nodes = []
        for u in all_urns:
            n = await self.get_node(u)
            if n:
                nodes.append(n)
        node_ids = {n.urn for n in nodes}
        edges = await self.get_edges(EdgeQuery(limit=100000))
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
        descendant_types: Optional[List[EntityType]] = None,
    ) -> LineageResult:
        downstream_urns = await self._traverse_lineage(urn, "downstream", depth, descendant_types)
        all_urns = downstream_urns | {urn}
        nodes = []
        for u in all_urns:
            n = await self.get_node(u)
            if n:
                nodes.append(n)
        node_ids = {n.urn for n in nodes}
        edges = await self.get_edges(EdgeQuery(limit=100000))
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
        descendant_types: Optional[List[EntityType]] = None,
    ) -> LineageResult:
        up = await self._traverse_lineage(urn, "upstream", upstream_depth, descendant_types)
        down = await self._traverse_lineage(urn, "downstream", downstream_depth, descendant_types)
        all_urns = up | down | {urn}
        nodes = []
        for u in all_urns:
            n = await self.get_node(u)
            if n:
                nodes.append(n)
        node_ids = {n.urn for n in nodes}
        edges = await self.get_edges(EdgeQuery(limit=100000))
        edges = [e for e in edges if e.source_urn in node_ids and e.target_urn in node_ids]
        return LineageResult(
            nodes=nodes,
            edges=edges,
            upstreamUrns=up,
            downstreamUrns=down,
            totalCount=len(nodes),
            hasMore=False,
        )

    async def materialize_lineage_for_edge(
        self,
        source_urn: str,
        target_urn: str,
        lineage_edge_type: str
    ) -> bool:
        """
        Write Path Aggregation:
        When a granular edge (source)->(target) is created, we "rollup" this connection
        to all matching structural ancestors.
        
        Logic:
        1. Find all ancestors of Source (s_anc).
        2. Find all ancestors of Target (t_anc).
        3. Match ancestors that are at the SAME LEVEL (e.g. Table-Table, Domain-Domain).
           (We infer level equivalence by EntityType or Label).
        4. MERGE (s_anc)-[:AGGREGATED]->(t_anc).
        5. Increment weight.
        
        Optimization:
        We perform this in a SINGLE Cypher query for atomicity and speed.
        """
        await self._ensure_connected()
        
        containment = list(self._get_containment_edge_types())
        
        # Cypher Logic:
        # 1. Match source leaf and its ancestors 
        # 2. Match target leaf and its ancestors
        # 3. Filter for pairs where labels(s_anc) == labels(t_anc) (Horizontal Aggregation)
        #    OR specific EntityType matching if labels are messy.
        #    Simpler: We just blindly agg between all ancestors and let the "Same Level" check happen via logic or just agg everything? 
        #    User requirement: "Match Equivalent Tiers".
        #    We can check "WHERE s_anc.entityType = t_anc.entityType".
        # 4. EXCLUDE self-loops (s_anc <> t_anc).
        
        cypher = (
            "MATCH (s_leaf {urn: $sourceUrn}) "
            "MATCH (t_leaf {urn: $targetUrn}) "
            # Find ancestors (0..5 hops up). 0 means the node itself (if it's a Table matching a Table).
            "MATCH (s_anc)-[:CONTAINS*0..5]->(s_leaf) "
            "MATCH (t_anc)-[:CONTAINS*0..5]->(t_leaf) "
            # Filter: structural entities (containers/roots) + Match Levels
            "WHERE s_anc.urn <> t_anc.urn "  # No self-loops (internal lineage)
            # Ensure we are linking equivalent types (Table to Table, DB to DB)
            # Use labels comparison as entityType property might be missing
            "AND labels(s_anc) = labels(t_anc) " 
            # Create/Merge the Aggregated Edge
            "MERGE (s_anc)-[r:AGGREGATED {targetUrn: t_anc.urn}]->(t_anc) "
            "ON CREATE SET r.weight = 1, r.sourceEdgeTypes = [$edgeType], r.latestUpdate = timestamp() "
            "ON MATCH SET r.weight = r.weight + 1, "
            # Append edgeType if not present? (Set logic simulation)
            "r.sourceEdgeTypes = CASE WHEN NOT $edgeType IN r.sourceEdgeTypes THEN r.sourceEdgeTypes + $edgeType ELSE r.sourceEdgeTypes END, "
            "r.latestUpdate = timestamp() "
            "RETURN count(r)"
        )
        
        params = {
            "sourceUrn": source_urn,
            "targetUrn": target_urn,
            "edgeType": lineage_edge_type
        }
        
        try:
            await self._graph.query(cypher, params=params)
            return True
        except Exception as e:
            logger.error(f"Failed to materialize lineage: {e}")
            return False

    async def get_aggregated_edges_between(
        self,
        source_urns: List[str],
        target_urns: Optional[List[str]],
        granularity: Any,
        containment_edges: List[str],
        lineage_edges: List[str],
    ) -> AggregatedEdgeResult:
        """
        Optimized Read Path:
        Reads directly from 'AGGREGATED' edges.
        """
        await self._ensure_connected()

        # If we have AGGREGATED edges, we don't need deep traversal!
        # We just look for AGGREGATED edges connected to the requested source_urns.
        
        # Case 1: Source URNs are the containers themselves (e.g. Tables).
        # We just pull the edges.
        
        query_params = {
            "sourceUrns": source_urns
        }
        
        # We assume the requested 'granularity' matches the source_urns provided.
        # (e.g. frontend asks for Table-level lineage and provides Table URNs).
        
        cypher = (
            "MATCH (s)-[r:AGGREGATED]->(t) "
            "WHERE s.urn IN $sourceUrns "
        )
        
        if target_urns:
            query_params["targetUrns"] = target_urns
            cypher += "AND t.urn IN $targetUrns "
            
        cypher += (
            "RETURN s.urn, t.urn, r.weight, r.sourceEdgeTypes, r.properties "
        )
        
        # print(f"DEBUG READ AGG: {cypher} params={query_params}")
        
        result = await self._graph.ro_query(cypher, params=query_params)
        
        aggregated = []
        total_edges = 0
        
        for row in (result.result_set or []):
            s_urn, t_urn, weight, types, props = row[0], row[1], row[2], row[3], row[4]
            
            agg_entry = AggregatedEdgeInfo(
                id=f"agg-{s_urn}-{t_urn}",
                sourceUrn=s_urn,
                targetUrn=t_urn,
                edgeCount=int(weight) if weight else 1,
                edgeTypes=types if isinstance(types, list) else [str(types)],
                confidence=1.0, # Pre-calculated is high confidence
                sourceEdgeIds=[] 
            )
            aggregated.append(agg_entry)
            total_edges += int(weight) if weight else 1
            
        return AggregatedEdgeResult(
            aggregatedEdges=aggregated,
            totalSourceEdges=total_edges
        )

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

        # We can do BFS from the set of start_urns
        # Note: We treat start_urns as depth 0
        
        search_queue = deque([(u, 0) for u in start_urns])
        visited_lineage = set(start_urns)
        
        # Populate initial nodes
        # Optimization: Fetch them in bulk later, or fetch as we go? 
        # FalkorDB is fast, fetching as we go or bulk at end. 
        # Let's match nodes during traversal.
        
        while search_queue:
            curr_urn, curr_depth = search_queue.popleft()
            
            if curr_depth >= depth:
                continue
                
            # Construct query based on direction
            # For "both", we can just do (a)-[r]-(b) but we need to know direction for result classification
            
            queries = []
            if direction in ["upstream", "both"]:
                queries.append(("upstream", f"MATCH (curr)-[r]->(next) WHERE next.urn = $urn AND type(r) IN $lineage RETURN curr, r, next")) # Incoming to current
            if direction in ["downstream", "both"]:
                queries.append(("downstream", f"MATCH (curr)-[r]->(next) WHERE curr.urn = $urn AND type(r) IN $lineage RETURN curr, r, next")) # Outgoing from current
                
            for dir_label, cypher_q in queries:
                res = await self._graph.ro_query(cypher_q, params={"urn": curr_urn, "lineage": safe_lineage})
                
                for row in (res.result_set or []):
                    # Extract node/edge
                    # upstream: next.urn=$urn, so curr is the dependency (upstream node)
                    # downstream: curr.urn=$urn, so next is the dependent (downstream node)
                    
                    # Row: [StartNode, Edge, EndNode]
                    # But wait, my query variable names might be confusing.
                    # Let's map standard Cypher return: SOURCE, EDGE, TARGET
                    
                    src_node_obj = self._extract_node_from_result(row[0])
                    edge_obj_raw = row[1]
                    tgt_node_obj = self._extract_node_from_result(row[2])
                    
                    if not src_node_obj or not tgt_node_obj:
                        continue
                        
                    # Build edge object
                    # edge_obj_raw is the relation object or properties dict
                    # FalkorDB python client returns Relation object or similar
                    # We need to parse it. 
                    # row[1] is relation.
                    
                    r_type = getattr(edge_obj_raw, "relation", None) or getattr(edge_obj_raw, "type", None) or "RELATED_TO"
                    r_props = getattr(edge_obj_raw, "properties", {})
                    
                    edge = _edge_from_row(src_node_obj.urn, tgt_node_obj.urn, r_type, r_props)
                    
                    if edge.id not in collected_edges:
                        collected_edges[edge.id] = edge
                        
                        # Determine neighbor
                        if dir_label == "upstream":
                            neighbor = src_node_obj
                            if neighbor.urn not in visited_lineage:
                                visited_lineage.add(neighbor.urn)
                                upstream_urns.add(neighbor.urn)
                                search_queue.append((neighbor.urn, curr_depth + 1))
                        else:
                            neighbor = tgt_node_obj
                            if neighbor.urn not in visited_lineage:
                                visited_lineage.add(neighbor.urn)
                                downstream_urns.add(neighbor.urn)
                                search_queue.append((neighbor.urn, curr_depth + 1))
                                
                        collected_nodes[src_node_obj.urn] = src_node_obj
                        collected_nodes[tgt_node_obj.urn] = tgt_node_obj

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
             
             # Let's do a generic ancestor fetch
             current_level_urns = all_lineage_urns
             for _ in range(3): # limit hierarchy depth to 3 levels up from lineage
                 if not current_level_urns:
                     break
                 
                 res_struct = await self._graph.ro_query(
                     cypher_structure,
                     params={"urns": current_level_urns, "containment": safe_containment}
                 )
                 
                 next_level_urns = []
                 found_any = False
                 
                 for row in (res_struct.result_set or []):
                     parent = self._extract_node_from_result(row[0])
                     r_raw = row[1]
                     child = self._extract_node_from_result(row[2])
                     
                     if parent and child:
                         collected_nodes[parent.urn] = parent
                         collected_nodes[child.urn] = child # Ensure child is there
                         
                         r_type = getattr(r_raw, "relation", None) or getattr(r_raw, "type", None) or "CONTAINS"
                         r_props = getattr(r_raw, "properties", {})
                         
                         edge = _edge_from_row(parent.urn, child.urn, r_type, r_props)
                         collected_edges[edge.id] = edge
                         
                         if parent.urn not in collected_nodes: # New node found
                             next_level_urns.append(parent.urn)
                         found_any = True
                 
                 if not found_any:
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
        nr = await self._graph.ro_query("MATCH (n) RETURN count(n) AS c")
        er = await self._graph.ro_query("MATCH ()-[r]->() RETURN count(r) AS c")
        node_count = nr.result_set[0][0] if nr.result_set else 0
        edge_count = er.result_set[0][0] if er.result_set else 0

        type_res = await self._graph.ro_query(
            "MATCH (n) RETURN labels(n)[0] AS lbl, count(*) AS c"
        )
        entity_type_counts = {}
        for row in (type_res.result_set or []):
            lbl = row[0] or "unknown"
            entity_type_counts[lbl] = row[1]

        edge_type_res = await self._graph.ro_query(
            "MATCH ()-[r]->() RETURN type(r) AS t, count(*) AS c"
        )
        edge_type_counts = {}
        for row in (edge_type_res.result_set or []):
            t = row[0] or "UNKNOWN"
            edge_type_counts[t] = row[1]

        return {
            "nodeCount": node_count,
            "edgeCount": edge_count,
            "entityTypeCounts": entity_type_counts,
            "edgeTypeCounts": edge_type_counts,
        }

    async def get_schema_stats(self) -> GraphSchemaStats:
        await self._ensure_connected()
        nr = await self._graph.ro_query("MATCH (n) RETURN count(n) AS c")
        er = await self._graph.ro_query("MATCH ()-[r]->() RETURN count(r) AS c")
        total_nodes = nr.result_set[0][0] if nr.result_set else 0
        total_edges = er.result_set[0][0] if er.result_set else 0

        type_res = await self._graph.ro_query(
            "MATCH (n) RETURN labels(n)[0] AS lbl, count(*) AS c, collect(n.displayName) AS samples"
        )
        entity_stats = []
        for row in (type_res.result_set or []):
            lbl, cnt, samples = row[0] or "unknown", row[1], (row[2] if len(row) > 2 else [])
            if isinstance(samples, str):
                samples = [samples]
            sample_list = (list(samples)[:3] if hasattr(samples, "__iter__") and not isinstance(samples, str) else []) or []
            entity_stats.append(EntityTypeSummary(id=lbl, name=lbl, count=cnt, sampleNames=sample_list))

        edge_type_res = await self._graph.ro_query(
            "MATCH ()-[r]->() RETURN type(r) AS t, count(*) AS c"
        )
        edge_stats = [
            EdgeTypeSummary(id=row[0], name=row[0], count=row[1])
            for row in (edge_type_res.result_set or [])
        ]

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
                # Get node type from a sample - simplified
                tag_types[tag].add("entity")
        tag_stats = [TagSummary(tag=t, count=c, entityTypes=list(tag_types.get(t, {"entity"}))) for t, c in tag_counts.items()]

        return GraphSchemaStats(
            totalNodes=total_nodes,
            totalEdges=total_edges,
            entityTypeStats=entity_stats,
            edgeTypeStats=edge_stats,
            tagStats=tag_stats,
        )

    async def get_ontology_metadata(self) -> OntologyMetadata:
        containment = list(self._get_containment_edge_types())
        config_lineage = os.getenv("LINEAGE_EDGE_TYPES", "").strip()
        if config_lineage:
            lineage_types = [t.strip() for t in config_lineage.split(",") if t.strip()]
        else:
            config_metadata = os.getenv("METADATA_EDGE_TYPES", "").strip()
            metadata_types = {t.strip().upper() for t in config_metadata.split(",") if t.strip()} if config_metadata else {EdgeType.TAGGED_WITH.value}
            containment_upper = {t.upper() for t in containment}
            lineage_types = []
            edges = await self.get_edges(EdgeQuery(limit=100000))
            seen = set()
            for e in edges:
                et = e.edge_type.value if hasattr(e.edge_type, "value") else str(e.edge_type)
                if et.upper() not in containment_upper and et.upper() not in metadata_types and et.upper() != EdgeType.AGGREGATED.value and et not in seen:
                    lineage_types.append(et)
                    seen.add(et)

        containment_upper = {t.upper() for t in containment}
        lineage_upper = {t.upper() for t in lineage_types}
        edge_type_metadata: Dict[str, EdgeTypeMetadata] = {}
        all_edge_types = set(containment) | set(lineage_types) | {EdgeType.TAGGED_WITH.value}
        for et in all_edge_types:
            is_containment = et.upper() in containment_upper
            is_lineage = et.upper() in lineage_upper
            if is_containment:
                category = "structural"
                direction = "child-to-parent" if et.upper() == EdgeType.BELONGS_TO.value else "parent-to-child"
            elif is_lineage:
                category = "flow"
                direction = "source-to-target"
            elif et.upper() == EdgeType.TAGGED_WITH.value:
                category = "metadata"
                direction = "bidirectional"
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

        entity_type_hierarchy: Dict[str, EntityTypeHierarchy] = {}
        edges = await self.get_edges(EdgeQuery(limit=100000))
        for e in edges:
            et = e.edge_type.value if hasattr(e.edge_type, "value") else str(e.edge_type)
            if et.upper() not in containment_upper:
                continue
            source_node = await self.get_node(e.source_urn)
            target_node = await self.get_node(e.target_urn)
            if not source_node or not target_node:
                continue
            st = source_node.entity_type.value if hasattr(source_node.entity_type, "value") else str(source_node.entity_type)
            tt = target_node.entity_type.value if hasattr(target_node.entity_type, "value") else str(target_node.entity_type)
            meta = edge_type_metadata.get(et)
            if meta and meta.direction == "child-to-parent":
                parent_type, child_type = tt, st
            else:
                parent_type, child_type = st, tt
            if parent_type not in entity_type_hierarchy:
                entity_type_hierarchy[parent_type] = EntityTypeHierarchy(canContain=[], canBeContainedBy=[])
            if child_type not in entity_type_hierarchy:
                entity_type_hierarchy[child_type] = EntityTypeHierarchy(canContain=[], canBeContainedBy=[])
            if child_type not in entity_type_hierarchy[parent_type].can_contain:
                entity_type_hierarchy[parent_type].can_contain.append(child_type)
            if parent_type not in entity_type_hierarchy[child_type].can_be_contained_by:
                entity_type_hierarchy[child_type].can_be_contained_by.append(parent_type)

        all_hierarchy = set(entity_type_hierarchy.keys())
        contained = set()
        for hi in entity_type_hierarchy.values():
            contained.update(hi.can_contain)
        root_entity_types = list(all_hierarchy - contained)

        return OntologyMetadata(
            containmentEdgeTypes=containment,
            lineageEdgeTypes=lineage_types,
            edgeTypeMetadata=edge_type_metadata,
            entityTypeHierarchy=entity_type_hierarchy,
            rootEntityTypes=root_entity_types,
        )

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
        ancestors = []
        current = urn
        while len(ancestors) < limit + offset:
            parent = await self.get_parent(current)
            if not parent:
                break
            ancestors.append(parent)
            current = parent.urn
        return ancestors[offset : offset + limit]

    async def get_descendants(
        self,
        urn: str,
        depth: int = 5,
        entity_types: Optional[List[EntityType]] = None,
        limit: int = 100,
        offset: int = 0,
    ) -> List[GraphNode]:
        descendants = []
        queue = deque([(urn, 0)])
        while queue and len(descendants) < limit + offset + 100:
            cur, d = queue.popleft()
            if d >= depth:
                continue
            children = await self.get_children(cur, entity_types=entity_types, limit=500)
            for c in children:
                if not entity_types or c.entity_type in entity_types:
                    descendants.append(c)
                queue.append((c.urn, d + 1))
        return descendants[offset : offset + limit]

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
        await self._ensure_connected()
        batch_size = 200
        for i in range(0, len(nodes), batch_size):
            batch = nodes[i : i + batch_size]
            for node in batch:
                try:
                    label = _sanitize_label(node.entity_type.value if hasattr(node.entity_type, "value") else str(node.entity_type))
                    params = {
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
                    }
                    await self._graph.query(
                        f"""
                        MERGE (n:{label} {{urn: $urn}})
                        SET n.displayName = $displayName, n.qualifiedName = $qualifiedName, n.description = $description,
                            n.properties = $properties, n.tags = $tags, n.layerAssignment = $layerAssignment,
                            n.childCount = $childCount, n.sourceSystem = $sourceSystem, n.lastSyncedAt = $lastSyncedAt
                        """,
                        params=params,
                    )
                except Exception as e:
                    logger.warning(f"Node merge failed for {node.urn}: {e}")

        for i in range(0, len(edges), batch_size):
            batch = edges[i : i + batch_size]
            for edge in batch:
                try:
                    rel_type = _sanitize_label(edge.edge_type.value if hasattr(edge.edge_type, "value") else str(edge.edge_type))
                    await self._graph.query(
                        f"""
                        MATCH (a {{urn: $src}}) MATCH (b {{urn: $tgt}})
                        MERGE (a)-[r:{rel_type}]->(b)
                        SET r.id = $eid, r.confidence = $conf, r.properties = $props
                        """,
                        params={
                            "src": edge.source_urn,
                            "tgt": edge.target_urn,
                            "eid": edge.id,
                            "conf": edge.confidence,
                            "props": json.dumps(edge.properties),
                        },
                    )
                except Exception as e:
                    logger.warning(f"Edge merge failed for {edge.id}: {e}")

        return True

    async def create_node(self, node: GraphNode, containment_edge: Optional[GraphEdge] = None) -> bool:
        await self._ensure_connected()
        try:
            label = _sanitize_label(node.entity_type.value if hasattr(node.entity_type, "value") else str(node.entity_type))
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
            if containment_edge:
                rel_type = _sanitize_label(containment_edge.edge_type.value if hasattr(containment_edge.edge_type, "value") else str(containment_edge.edge_type))
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
