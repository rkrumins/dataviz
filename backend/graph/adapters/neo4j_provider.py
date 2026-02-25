"""
Neo4j Bolt adapter for GraphDataProvider.

Phase 4 stub — connection-level methods (ping, list_graphs, close) are
implemented.  All graph-query methods raise NotImplementedError until
Phase 4 is fully delivered.
"""
import asyncio
import logging
from typing import List, Optional

from backend.common.interfaces.provider import GraphDataProvider
from backend.common.models.graph import (
    GraphNode, GraphEdge, LineageResult, ContainmentResult,
    OntologyMetadata, GraphSchemaStats, GraphSchema,
    NodeQuery, EdgeQuery, AggregatedEdgeRequest, AggregatedEdgeResult,
    CreateNodeRequest, CreateNodeResult,
)

logger = logging.getLogger(__name__)

_NOT_IMPLEMENTED = "Neo4jProvider Phase 4 — not yet implemented"


class Neo4jProvider(GraphDataProvider):
    """
    GraphDataProvider backed by a Neo4j database via the Bolt protocol.

    Currently implements:
      - ping / connectivity test
      - list_graphs  (SHOW DATABASES)
      - close        (driver pool release)

    All graph-query methods raise NotImplementedError pending Phase 4.
    """

    name = "neo4j"

    def __init__(
        self,
        uri: str,
        username: str = "neo4j",
        password: str = "",
        database: str = "neo4j",
    ) -> None:
        self._uri = uri
        self._username = username
        self._password = password
        self._database = database
        self._driver = None
        self._lock = asyncio.Lock()

    # ------------------------------------------------------------------ #
    # Lifecycle                                                            #
    # ------------------------------------------------------------------ #

    async def _get_driver(self):
        if self._driver is not None:
            return self._driver
        async with self._lock:
            if self._driver is not None:
                return self._driver
            from neo4j import AsyncGraphDatabase
            self._driver = AsyncGraphDatabase.driver(
                self._uri,
                auth=(self._username, self._password),
            )
            logger.info("Neo4j driver created for %s", self._uri)
        return self._driver

    async def close(self) -> None:
        if self._driver is not None:
            await self._driver.close()
            self._driver = None
            logger.info("Neo4j driver closed for %s", self._uri)

    # ------------------------------------------------------------------ #
    # Connectivity helpers                                                 #
    # ------------------------------------------------------------------ #

    async def list_graphs(self) -> List[str]:
        """Return available Neo4j database names (excludes system DB)."""
        driver = await self._get_driver()
        async with driver.session(database="system") as session:
            result = await session.run("SHOW DATABASES YIELD name")
            records = await result.data()
        return [r["name"] for r in records if r["name"] != "system"]

    async def get_stats(self):
        """Lightweight ping — runs RETURN 1 against the target database."""
        driver = await self._get_driver()
        async with driver.session(database=self._database) as session:
            result = await session.run("RETURN 1 AS ping")
            await result.single()
        return {"provider": "neo4j", "database": self._database, "status": "healthy"}

    # ------------------------------------------------------------------ #
    # GraphDataProvider interface — Phase 4 stubs                         #
    # ------------------------------------------------------------------ #

    async def get_node(self, urn: str) -> Optional[GraphNode]:
        raise NotImplementedError(_NOT_IMPLEMENTED)

    async def get_nodes(self, query: NodeQuery) -> List[GraphNode]:
        raise NotImplementedError(_NOT_IMPLEMENTED)

    async def get_parent(self, urn: str) -> Optional[GraphNode]:
        raise NotImplementedError(_NOT_IMPLEMENTED)

    async def get_children(
        self, urn: str, edge_types: Optional[List[str]] = None, limit: int = 100
    ) -> List[GraphNode]:
        raise NotImplementedError(_NOT_IMPLEMENTED)

    async def get_upstream(
        self, urn: str, depth: int = 3, **kwargs
    ) -> LineageResult:
        raise NotImplementedError(_NOT_IMPLEMENTED)

    async def get_downstream(
        self, urn: str, depth: int = 3, **kwargs
    ) -> LineageResult:
        raise NotImplementedError(_NOT_IMPLEMENTED)

    async def get_edges(self, query: EdgeQuery) -> List[GraphEdge]:
        raise NotImplementedError(_NOT_IMPLEMENTED)

    async def search_nodes(
        self, query: str, limit: int = 10, offset: int = 0
    ) -> List[GraphNode]:
        raise NotImplementedError(_NOT_IMPLEMENTED)

    async def get_distinct_values(self, property_name: str) -> List[str]:
        raise NotImplementedError(_NOT_IMPLEMENTED)

    async def get_schema_stats(self) -> GraphSchemaStats:
        raise NotImplementedError(_NOT_IMPLEMENTED)

    async def get_ontology_metadata(self) -> OntologyMetadata:
        """Hardcoded Neo4j ontology stub — PRODUCES, CONSUMES, CONTAINS."""
        from backend.common.models.graph import EdgeTypeMetadata
        return OntologyMetadata(
            containmentEdgeTypes=["CONTAINS", "HAS_PART"],
            lineageEdgeTypes=["PRODUCES", "CONSUMES", "DERIVES_FROM"],
            edgeTypeMetadata={
                "PRODUCES": EdgeTypeMetadata(
                    edgeType="PRODUCES", displayName="Produces",
                    isLineage=True, isContainment=False, color="#22c55e", weight=1.0,
                ),
                "CONSUMES": EdgeTypeMetadata(
                    edgeType="CONSUMES", displayName="Consumes",
                    isLineage=True, isContainment=False, color="#f97316", weight=1.0,
                ),
                "CONTAINS": EdgeTypeMetadata(
                    edgeType="CONTAINS", displayName="Contains",
                    isLineage=False, isContainment=True, color="#6366f1", weight=0.5,
                ),
            },
            entityTypeHierarchy={},
            rootEntityTypes=[],
        )

    async def get_ancestors(
        self, urn: str, limit: int = 100, offset: int = 0
    ) -> List[GraphNode]:
        raise NotImplementedError(_NOT_IMPLEMENTED)

    async def get_descendants(
        self, urn: str, depth: int = 5,
        entity_types: Optional[List[str]] = None,
        limit: int = 100, offset: int = 0,
    ) -> List[GraphNode]:
        raise NotImplementedError(_NOT_IMPLEMENTED)

    async def get_nodes_by_tag(
        self, tag: str, limit: int = 100, offset: int = 0
    ) -> List[GraphNode]:
        raise NotImplementedError(_NOT_IMPLEMENTED)

    async def get_nodes_by_layer(
        self, layer_id: str, limit: int = 100, offset: int = 0
    ) -> List[GraphNode]:
        raise NotImplementedError(_NOT_IMPLEMENTED)

    async def get_neighborhood(self, urn: str):
        raise NotImplementedError(_NOT_IMPLEMENTED)

    async def save_custom_graph(
        self, nodes: List[GraphNode], edges: List[GraphEdge]
    ) -> bool:
        raise NotImplementedError(_NOT_IMPLEMENTED)

    async def create_node(self, request: CreateNodeRequest) -> CreateNodeResult:
        raise NotImplementedError(_NOT_IMPLEMENTED)

    async def get_aggregated_edges(
        self, request: AggregatedEdgeRequest
    ) -> AggregatedEdgeResult:
        raise NotImplementedError(_NOT_IMPLEMENTED)

    async def get_graph_schema(self) -> GraphSchema:
        raise NotImplementedError(_NOT_IMPLEMENTED)
