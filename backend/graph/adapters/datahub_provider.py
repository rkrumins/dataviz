"""
DataHub GraphQL adapter for GraphDataProvider.

Phase 4 stub — connectivity (ping, get_stats) and basic lineage methods
point to the DataHub API.  All other methods raise NotImplementedError.

DataHub is inherently read-only from a lineage perspective; save_custom_graph
always returns False.
"""
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

_NOT_IMPLEMENTED = "DataHubGraphQLProvider Phase 4 — not yet implemented"

_GRAPHQL_HEALTH = """
{ health { status } }
"""


class DataHubGraphQLProvider(GraphDataProvider):
    """
    GraphDataProvider backed by DataHub's GraphQL API.

    Currently implements:
      - ping / get_stats via ``{ health { status } }``
      - get_ontology_metadata → hardcoded DataHub relationship types
      - list_graphs → [] (DataHub has no concept of named graphs)
      - close → aclose the httpx client

    All graph-query methods raise NotImplementedError pending Phase 4.
    """

    name = "datahub"

    def __init__(self, base_url: str, token: Optional[str] = None) -> None:
        self._base_url = base_url.rstrip("/")
        self._token = token
        self._client = None

    # ------------------------------------------------------------------ #
    # Lifecycle                                                            #
    # ------------------------------------------------------------------ #

    def _get_client(self):
        if self._client is None:
            import httpx
            headers = {"Content-Type": "application/json"}
            if self._token:
                headers["Authorization"] = f"Bearer {self._token}"
            self._client = httpx.AsyncClient(
                base_url=self._base_url,
                headers=headers,
                timeout=30.0,
            )
        return self._client

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None
            logger.info("DataHub httpx client closed for %s", self._base_url)

    # ------------------------------------------------------------------ #
    # Connectivity helpers                                                 #
    # ------------------------------------------------------------------ #

    async def get_stats(self):
        """Ping DataHub via the health GraphQL query."""
        client = self._get_client()
        response = await client.post(
            "/api/graphql",
            json={"query": _GRAPHQL_HEALTH},
        )
        response.raise_for_status()
        data = response.json()
        health = data.get("data", {}).get("health", [{}])
        status = health[0].get("status", "UNKNOWN") if health else "UNKNOWN"
        return {"provider": "datahub", "url": self._base_url, "status": status}

    async def list_graphs(self) -> List[str]:
        """DataHub does not have named graphs; returns empty list."""
        return []

    # ------------------------------------------------------------------ #
    # Ontology — hardcoded DataHub relationship types                     #
    # ------------------------------------------------------------------ #

    async def get_ontology_metadata(self) -> OntologyMetadata:
        from backend.common.models.graph import EdgeTypeMetadata
        return OntologyMetadata(
            containmentEdgeTypes=["DownstreamOf"],
            lineageEdgeTypes=["DownstreamOf", "UpstreamOf"],
            edgeTypeMetadata={
                "DownstreamOf": EdgeTypeMetadata(
                    edgeType="DownstreamOf", displayName="Downstream Of",
                    isLineage=True, isContainment=False, color="#f97316", weight=1.0,
                ),
                "UpstreamOf": EdgeTypeMetadata(
                    edgeType="UpstreamOf", displayName="Upstream Of",
                    isLineage=True, isContainment=False, color="#22c55e", weight=1.0,
                ),
            },
            entityTypeHierarchy={},
            rootEntityTypes=[],
        )

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

    async def get_upstream(self, urn: str, depth: int = 3, **kwargs) -> LineageResult:
        raise NotImplementedError(_NOT_IMPLEMENTED)

    async def get_downstream(self, urn: str, depth: int = 3, **kwargs) -> LineageResult:
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
        """DataHub is read-only — saving custom graphs is not supported."""
        return False

    async def create_node(self, request: CreateNodeRequest) -> CreateNodeResult:
        raise NotImplementedError(_NOT_IMPLEMENTED)

    async def get_aggregated_edges(
        self, request: AggregatedEdgeRequest
    ) -> AggregatedEdgeResult:
        raise NotImplementedError(_NOT_IMPLEMENTED)

    async def get_graph_schema(self) -> GraphSchema:
        raise NotImplementedError(_NOT_IMPLEMENTED)
