"""Google Spanner Graph implementation of :class:`GraphDataProvider`.

This file is intentionally thin. Domain helpers live in sibling modules:

  * ``connection`` — SDK handles, executor, retry
  * ``schema``     — DDL bootstrap + INFORMATION_SCHEMA introspection
  * ``gql``        — read-only and read-write query wrappers
  * ``mutations``  — Mutations API write paths
  * ``aggregation``— sidecar table maintenance
  * ``mapping``    — value coercion, schema mapping, hydration
  * ``errors``     — exception classifier

The previous monolithic implementation conflated all of these; the tests
were almost entirely mock-based, which is why bugs in the actual GQL /
DDL strings (the ones that mattered for "nothing in the UI") were never
caught. The split makes it possible to test each layer independently.

Spanner-native capabilities:

  * GQL traversal over the auto-bootstrapped property graph (or an
    existing schema if ``auto_bootstrap=False``)
  * Mutations API for bulk upserts (faster than DML, same idempotency)
  * Partitioned DML for bulk deletes (no 20K-row transaction cap)
  * Bounded-staleness reads via ``database.snapshot(exact_staleness=…)``
    on the browse path; strong reads for aggregation
  * PITR snapshots for time-travel lineage within Spanner's PITR window
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from collections import OrderedDict
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, Dict, List, Optional, Set, Tuple

from backend.common.interfaces.preflight import PreflightResult
from backend.common.interfaces.provider import (
    GraphDataProvider,
    ProviderConfigurationError,
)
from backend.common.models.graph import (
    AggregatedEdgeInfo,
    AggregatedEdgeResult,
    EdgeQuery,
    EdgeTypeMetadata,
    EdgeTypeSummary,
    EntityTypeHierarchy,
    EntityTypeSummary,
    FilterOperator,
    GraphEdge,
    GraphNode,
    GraphSchemaStats,
    LineageResult,
    NodeQuery,
    OntologyMetadata,
    PropertyFilter,
    TagFilter,
    TagSummary,
    TextFilter,
    TopLevelNodesResult,
)

from . import aggregation, gql, mutations, schema
from .connection import (
    DEFAULT_DDL_TIMEOUT_S,
    DEFAULT_READ_STALENESS_S,
    DEFAULT_THREAD_POOL,
    SpannerConnection,
    is_emulator,
)
from .errors import classify_spanner_error
from .mapping import (
    SchemaMapping,
    coerce_spanner_value,
    extract_edge_from_record,
    extract_node_from_record,
    sanitize_identifier,
)

logger = logging.getLogger(__name__)


class _TTLCache:
    """Single-value TTL cache using monotonic clock."""

    def __init__(self, ttl_seconds: float = 60.0):
        self._ttl = ttl_seconds
        self._value: Any = None
        self._expires: float = 0.0

    def get(self) -> Any:
        if time.monotonic() < self._expires:
            return self._value
        return None

    def set(self, value: Any) -> None:
        self._value = value
        self._expires = time.monotonic() + self._ttl

    def invalidate(self) -> None:
        self._expires = 0.0


class _URNLabelCache:
    """Bounded LRU cache for URN -> entity-type mappings."""

    def __init__(self, max_size: int = 50_000):
        self._max = max_size
        self._data: "OrderedDict[str, str]" = OrderedDict()

    def get(self, urn: str) -> Optional[str]:
        val = self._data.get(urn)
        if val is not None:
            self._data.move_to_end(urn)
        return val

    def put(self, urn: str, label: str) -> None:
        if urn in self._data:
            self._data.move_to_end(urn)
            self._data[urn] = label
            return
        if len(self._data) >= self._max:
            evict_count = max(1, self._max // 10)
            for _ in range(evict_count):
                if self._data:
                    self._data.popitem(last=False)
        self._data[urn] = label


class SpannerGraphProvider(GraphDataProvider):
    """:class:`GraphDataProvider` backed by Google Spanner Graph.

    Parameters
    ----------
    project_id, instance_id, database_id, property_graph_name
        Spanner addressing (project ▶ instance ▶ database ▶ graph).
    auth_method
        ``"adc"``, ``"service_account_json"``, or ``"impersonation"``.
        Ignored when ``SPANNER_EMULATOR_HOST`` is set — the emulator
        uses an unauthenticated channel.
    credentials_json
        Base64-encoded service-account JSON. Required when
        ``auth_method='service_account_json'``.
    impersonate_service_account
        Email address of the SA to impersonate. Required when
        ``auth_method='impersonation'``.
    read_staleness_s
        Bounded-staleness window for browse reads (default 10s). Set to
        ``0`` for strong reads.
    auto_bootstrap
        When True (default), the provider DDL-creates the managed schema
        on first connect if it doesn't already exist. Set False when
        pointing at a hand-managed Spanner Graph schema.
    extra_config
        Catch-all bag for schema mapping (``identity_field``, etc.) and
        Redis ancestor cache URL.
    """

    def __init__(
        self,
        *,
        project_id: str,
        instance_id: str,
        database_id: str,
        property_graph_name: str,
        auth_method: str = "adc",
        credentials_json: Optional[str] = None,
        impersonate_service_account: Optional[str] = None,
        gcp_region: Optional[str] = None,
        read_staleness_s: Optional[float] = None,
        change_stream_name: Optional[str] = None,
        embed_endpoint: Optional[str] = None,
        auto_bootstrap: bool = True,
        extra_config: Optional[Dict[str, Any]] = None,
    ) -> None:
        if not project_id:
            raise ValueError("SpannerGraphProvider requires project_id")
        if not instance_id:
            raise ValueError("SpannerGraphProvider requires instance_id")

        self._project_id = project_id
        self._instance_id = instance_id
        self._database_id = (database_id or "").strip()
        self._graph_name = (property_graph_name or "").strip()
        self._gcp_region = gcp_region
        self._read_staleness_s = (
            float(read_staleness_s) if read_staleness_s is not None else DEFAULT_READ_STALENESS_S
        )
        self._change_stream_name = change_stream_name
        self._embed_endpoint = embed_endpoint
        self._auto_bootstrap = bool(auto_bootstrap)
        self._extra_config: Dict[str, Any] = extra_config or {}

        self._conn = SpannerConnection(
            project_id=project_id,
            instance_id=instance_id,
            database_id=self._database_id,
            auth_method=auth_method,
            credentials_json_b64=credentials_json,
            impersonate_service_account=impersonate_service_account,
            thread_pool_size=DEFAULT_THREAD_POOL,
        )
        self._bootstrap_lock = asyncio.Lock()
        self._bootstrapped = False
        self._aggregation_ensured = False
        self._aggregation_lock = asyncio.Lock()

        # Caches
        self._mapping: SchemaMapping = SchemaMapping.from_extra_config(self._extra_config)
        self._stats_cache = _TTLCache(60.0)
        self._ontology_cache = _TTLCache(60.0)
        self._urn_cache = _URNLabelCache(50_000)

        # Containment edge types — three-tier resolution chain
        self._resolved_containment_types: Set[str] = set()
        self._resolved_containment_types_set = False
        self._containment_cache: Optional[Set[str]] = None

        # Resolved edge metadata (from the ontology service)
        self._resolved_edge_metadata: Dict[str, Any] = {}
        self._resolved_lineage_types: Set[str] = set()
        self._resolved_edge_metadata_set = False

        # Capability state — ``time_travel`` is always available within
        # the PITR window; the other flags are detected at connect-time
        # so diagnostics don't get a stale "true" before we've actually
        # confirmed the database supports the feature.
        self._dialect: Optional[str] = None
        self._capabilities: Dict[str, bool] = {
            "time_travel": True,
            "vector_search": False,
            "full_text_search": False,
            "change_streams": False,
        }

    @property
    def name(self) -> str:
        return f"spanner_graph[{self._instance_id}/{self._database_id}.{self._graph_name}]"

    # ------------------------------------------------------------------
    # Compatibility shims — preserve the public-private surface that
    # tests and external integrations reach into. Each shim is a thin
    # delegate to the modular implementation; the modular API is what
    # new code should use.
    # ------------------------------------------------------------------

    @staticmethod
    def _classify_spanner_error(exc: BaseException) -> str:
        return classify_spanner_error(exc)

    @staticmethod
    def _suggest_mapping(props: set) -> Dict[str, str]:
        return schema._suggest_mapping(props)

    def _build_credentials(self) -> Tuple[Any, Optional[str]]:
        return self._conn.build_credentials()

    async def _ensure_connected(self) -> None:
        await self._ensure_ready()

    def _sidecar_table_name(self) -> str:
        return schema.sidecar_table_name(self._graph_name)

    def _aggregation_state_table_name(self) -> str:
        return schema.aggregation_state_table_name(self._graph_name)

    def _extract_node_from_record(
        self,
        node_json: Optional[Any],
        labels: Optional[List[str]] = None,
    ) -> Optional[GraphNode]:
        return self._hydrate_node(node_json, labels)

    def _extract_edge_from_record(
        self,
        *,
        source_urn: str,
        target_urn: str,
        edge_label: str,
        edge_json: Optional[Any],
    ) -> Optional[GraphEdge]:
        return extract_edge_from_record(
            source_urn=source_urn,
            target_urn=target_urn,
            edge_label=edge_label,
            edge_json=edge_json,
            mapping=self._mapping,
        )

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def _ensure_ready(self) -> None:
        """Connect, bootstrap schema (if enabled), capture dialect."""
        await self._conn.ensure_connected()
        if self._bootstrapped:
            return
        async with self._bootstrap_lock:
            if self._bootstrapped:
                return
            self._dialect = await schema.detect_dialect(self._conn)
            if self._auto_bootstrap:
                await schema.bootstrap(self._conn, self._graph_name)
            # Capability flags only flip after we've actually connected
            # — change-stream detection is config-driven (we know it's
            # configured) but we wait until connect-time to publish.
            self._capabilities["change_streams"] = bool(self._change_stream_name)
            self._bootstrapped = True

    async def _ensure_aggregation_tables(self) -> None:
        if self._aggregation_ensured:
            return
        async with self._aggregation_lock:
            if self._aggregation_ensured:
                return
            await self._ensure_ready()
            await schema.ensure_aggregation_tables(self._conn, self._graph_name)
            self._aggregation_ensured = True

    async def preflight(self, *, deadline_s: float = 1.5) -> PreflightResult:
        """Bounded reachability + dialect probe.

        Connects (which probes the database via ``SELECT 1``), then
        confirms GQL is reachable by listing property graphs. Skipped
        edition checks against the emulator since it doesn't gate on
        edition.

        Calls ``self._ensure_connected()`` (not the inner ``_ensure_ready``)
        so tests and external code can monkeypatch the documented entry
        point.
        """
        t0 = time.monotonic()
        try:
            try:
                await asyncio.wait_for(self._ensure_connected(), timeout=deadline_s)
            except asyncio.TimeoutError:
                return PreflightResult.failure(
                    reason="connect_timeout",
                    elapsed_ms=int((time.monotonic() - t0) * 1000),
                )
            try:
                await asyncio.wait_for(
                    gql.execute_ro(
                        self._conn,
                        "SELECT property_graph_name FROM INFORMATION_SCHEMA.PROPERTY_GRAPHS LIMIT 1",
                        graph_name=self._graph_name,
                        max_staleness_s=0.0,
                    ),
                    timeout=deadline_s,
                )
            except asyncio.TimeoutError:
                return PreflightResult.failure(
                    reason="query_timeout",
                    elapsed_ms=int((time.monotonic() - t0) * 1000),
                )
            elapsed = int((time.monotonic() - t0) * 1000)
            return PreflightResult.success(
                peer=f"{self._project_id}/{self._instance_id}/{self._database_id}",
                elapsed_ms=elapsed,
            )
        except asyncio.CancelledError:
            raise
        except BaseException as exc:  # noqa: BLE001 — preflight must not raise
            return PreflightResult.failure(
                reason=classify_spanner_error(exc),
                elapsed_ms=int((time.monotonic() - t0) * 1000),
            )

    async def close(self) -> None:
        await self._conn.close()

    # ------------------------------------------------------------------
    # Ontology contract
    # ------------------------------------------------------------------

    def set_containment_edge_types(self, types: List[str], from_ontology: bool = True) -> None:
        del from_ontology  # accepted for contract parity; not branched on here
        self._resolved_containment_types = {t.upper() for t in types}
        self._resolved_containment_types_set = True
        self._stats_cache.invalidate()
        self._ontology_cache.invalidate()

    def set_resolved_edge_metadata(
        self,
        edge_type_metadata: Dict[str, Any],
        lineage_edge_types: List[str],
    ) -> None:
        self._resolved_edge_metadata = {k.upper(): v for k, v in edge_type_metadata.items()}
        self._resolved_lineage_types = {t.upper() for t in lineage_edge_types}
        self._resolved_edge_metadata_set = True
        self._ontology_cache.invalidate()

    def _get_containment_edge_types(self) -> Set[str]:
        if self._resolved_containment_types_set:
            return self._resolved_containment_types
        if self._containment_cache is None:
            cfg = os.getenv("CONTAINMENT_EDGE_TYPES", "").strip()
            if cfg:
                self._containment_cache = {t.strip().upper() for t in cfg.split(",") if t.strip()}
            else:
                self._containment_cache = {"CONTAINS", "BELONGS_TO"}
        return self._containment_cache

    def _require_containment_types(self) -> Set[str]:
        types = self._get_containment_edge_types()
        # Empty set with explicit ontology resolution is intentional (flat graph).
        if not types and not self._resolved_containment_types_set:
            raise ProviderConfigurationError(
                "spanner_graph: no containment edge types configured. "
                "ContextEngine must call set_containment_edge_types(...) from "
                "the resolved ontology before lineage / containment endpoints "
                "can be served, or set the CONTAINMENT_EDGE_TYPES env var."
            )
        return types

    # ------------------------------------------------------------------
    # Index management
    # ------------------------------------------------------------------

    async def ensure_indices(self, entity_type_ids: Optional[List[str]] = None) -> None:
        """Provider-side indices on the managed tables.

        The bootstrap DDL already creates the indexes; this is a no-op
        for the managed schema and a placeholder for future per-entity
        indexes when callers extend the schema.
        """
        del entity_type_ids
        await self._ensure_ready()

    # ------------------------------------------------------------------
    # Hydration (cached URN→label mapping)
    # ------------------------------------------------------------------

    def _hydrate_node(self, node_json: Optional[Any], labels: Optional[List[str]]) -> Optional[GraphNode]:
        node = extract_node_from_record(node_json, labels, self._mapping)
        if node:
            self._urn_cache.put(node.urn, node.entity_type)
        return node

    # ------------------------------------------------------------------
    # GraphDataProvider — node operations
    # ------------------------------------------------------------------

    async def get_node(self, urn: str) -> Optional[GraphNode]:
        if not urn:
            return None
        await self._ensure_ready()
        from google.cloud.spanner_v1 import param_types

        rows = await gql.execute_ro(
            self._conn,
            "MATCH (n) WHERE n.urn = @urn "
            "RETURN SAFE_TO_JSON(n) AS node, LABELS(n) AS labels LIMIT 1",
            graph_name=self._graph_name,
            params={"urn": urn},
            param_types_={"urn": param_types.STRING},
            max_staleness_s=self._read_staleness_s,
            request_tag="get_node",
        )
        if not rows:
            return None
        node_json, labels = rows[0]
        return self._hydrate_node(node_json, labels)

    async def get_nodes(self, query: NodeQuery) -> List[GraphNode]:
        await self._ensure_ready()
        from google.cloud.spanner_v1 import param_types

        clauses: List[str] = []
        params: Dict[str, Any] = {}
        ptypes: Dict[str, Any] = {}

        if query.urns:
            clauses.append("n.urn IN UNNEST(@urns)")
            params["urns"] = list(query.urns)
            ptypes["urns"] = param_types.Array(param_types.STRING)
        if query.entity_types:
            # In the managed schema labels and entity_type are equivalent;
            # querying via the column avoids a LABELS() call.
            clauses.append("n.entity_type IN UNNEST(@entity_types)")
            params["entity_types"] = list(query.entity_types)
            ptypes["entity_types"] = param_types.Array(param_types.STRING)
        if query.search_query:
            clauses.append(
                "(LOWER(n.display_name) LIKE @search OR LOWER(n.urn) LIKE @search)"
            )
            params["search"] = f"%{query.search_query.lower()}%"
            ptypes["search"] = param_types.STRING

        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        offset = max(0, int(query.offset or 0))
        limit = max(1, min(int(query.limit or 100), 10_000))

        gql_query = (
            f"MATCH (n) {where} "
            f"RETURN SAFE_TO_JSON(n) AS node, LABELS(n) AS labels "
            f"ORDER BY n.urn "
            f"LIMIT {limit} OFFSET {offset}"
        )
        rows = await gql.execute_ro(
            self._conn,
            gql_query,
            graph_name=self._graph_name,
            params=params,
            param_types_=ptypes,
            max_staleness_s=self._read_staleness_s,
            request_tag="get_nodes",
        )

        out: List[GraphNode] = []
        for node_json, labels in rows:
            node = self._hydrate_node(node_json, labels)
            if not node:
                continue
            if query.tags and not (set(query.tags) & set(node.tags or [])):
                continue
            if query.tag_filters and not self._match_tag_filters(node, query.tag_filters):
                continue
            if query.property_filters and not self._match_property_filters(node, query.property_filters):
                continue
            if query.name_filter and not self._match_text_filter(node.display_name, query.name_filter):
                continue
            if query.layer_id and node.layer_assignment != query.layer_id:
                continue
            out.append(node)
        return out

    async def search_nodes(self, query: str, limit: int = 10) -> List[GraphNode]:
        return await self.get_nodes(NodeQuery(searchQuery=query, limit=limit))

    # ------------------------------------------------------------------
    # GraphDataProvider — edge operations
    # ------------------------------------------------------------------

    async def get_edges(self, query: EdgeQuery) -> List[GraphEdge]:
        await self._ensure_ready()
        from google.cloud.spanner_v1 import param_types

        if query.edge_types and {t.upper() for t in query.edge_types} == {"AGGREGATED"}:
            return await self._get_aggregated_edges(query)

        clauses: List[str] = []
        params: Dict[str, Any] = {}
        ptypes: Dict[str, Any] = {}

        if query.source_urns:
            clauses.append("s.urn IN UNNEST(@source_urns)")
            params["source_urns"] = list(query.source_urns)
            ptypes["source_urns"] = param_types.Array(param_types.STRING)
        if query.target_urns:
            clauses.append("t.urn IN UNNEST(@target_urns)")
            params["target_urns"] = list(query.target_urns)
            ptypes["target_urns"] = param_types.Array(param_types.STRING)
        if query.any_urns:
            clauses.append("(s.urn IN UNNEST(@any_urns) OR t.urn IN UNNEST(@any_urns))")
            params["any_urns"] = list(query.any_urns)
            ptypes["any_urns"] = param_types.Array(param_types.STRING)
        if query.edge_types:
            clauses.append("r.edge_type IN UNNEST(@edge_types)")
            params["edge_types"] = list(query.edge_types)
            ptypes["edge_types"] = param_types.Array(param_types.STRING)

        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        offset = max(0, int(query.offset or 0))
        limit = max(1, min(int(query.limit or 100), 10_000))

        # NOTE: ``LABELS(r)[0]`` — zero-based index in GQL.
        gql_query = (
            f"MATCH (s)-[r]->(t) {where} "
            f"RETURN s.urn AS s_urn, t.urn AS t_urn, "
            f"COALESCE(r.edge_type, LABELS(r)[0]) AS edge_type, "
            f"SAFE_TO_JSON(r) AS edge "
            f"ORDER BY s.urn, t.urn LIMIT {limit} OFFSET {offset}"
        )
        rows = await gql.execute_ro(
            self._conn,
            gql_query,
            graph_name=self._graph_name,
            params=params,
            param_types_=ptypes,
            max_staleness_s=self._read_staleness_s,
            request_tag="get_edges",
        )
        edges: List[GraphEdge] = []
        for s_urn, t_urn, edge_type, edge_json in rows:
            edge = extract_edge_from_record(
                source_urn=str(s_urn),
                target_urn=str(t_urn),
                edge_label=str(edge_type),
                edge_json=edge_json,
                mapping=self._mapping,
            )
            if edge is None:
                continue
            if query.min_confidence is not None and (edge.confidence or 0.0) < query.min_confidence:
                continue
            edges.append(edge)
        return edges

    async def _get_aggregated_edges(self, query: EdgeQuery) -> List[GraphEdge]:
        await self._ensure_aggregation_tables()
        from google.cloud.spanner_v1 import param_types

        sidecar = schema.sidecar_table_name(self._graph_name)
        clauses: List[str] = []
        params: Dict[str, Any] = {}
        ptypes: Dict[str, Any] = {}
        if query.source_urns:
            clauses.append("source_urn IN UNNEST(@source_urns)")
            params["source_urns"] = list(query.source_urns)
            ptypes["source_urns"] = param_types.Array(param_types.STRING)
        if query.target_urns:
            clauses.append("target_urn IN UNNEST(@target_urns)")
            params["target_urns"] = list(query.target_urns)
            ptypes["target_urns"] = param_types.Array(param_types.STRING)
        if query.any_urns:
            clauses.append("(source_urn IN UNNEST(@any_urns) OR target_urn IN UNNEST(@any_urns))")
            params["any_urns"] = list(query.any_urns)
            ptypes["any_urns"] = param_types.Array(param_types.STRING)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        offset = max(0, int(query.offset or 0))
        limit = max(1, min(int(query.limit or 100), 10_000))

        rows = await gql.execute_ro(
            self._conn,
            f"SELECT source_urn, target_urn, weight, source_edge_types "
            f"FROM `{sidecar}` {where} "
            f"ORDER BY source_urn, target_urn LIMIT {limit} OFFSET {offset}",
            graph_name=self._graph_name,
            params=params,
            param_types_=ptypes,
            max_staleness_s=self._read_staleness_s,
            request_tag="get_aggregated_edges",
        )
        out: List[GraphEdge] = []
        for s, t, weight, src_types in rows:
            out.append(GraphEdge(
                id=f"{s}|AGGREGATED|{t}",
                sourceUrn=str(s),
                targetUrn=str(t),
                edgeType="AGGREGATED",
                confidence=None,
                properties={
                    "weight": int(weight or 0),
                    "sourceEdgeTypes": [str(x) for x in (src_types or [])],
                },
            ))
        return out

    # ------------------------------------------------------------------
    # Containment hierarchy
    # ------------------------------------------------------------------

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
        await self._ensure_ready()
        from google.cloud.spanner_v1 import param_types

        cont_types = list(edge_types) if edge_types else list(self._require_containment_types())
        if not cont_types:
            return []

        clauses = ["p.urn = @parent", "r.edge_type IN UNNEST(@cont_types)"]
        params: Dict[str, Any] = {"parent": parent_urn, "cont_types": cont_types}
        ptypes: Dict[str, Any] = {
            "parent": param_types.STRING,
            "cont_types": param_types.Array(param_types.STRING),
        }
        if entity_types:
            clauses.append("child.entity_type IN UNNEST(@entity_types)")
            params["entity_types"] = list(entity_types)
            ptypes["entity_types"] = param_types.Array(param_types.STRING)
        if search_query:
            clauses.append("(LOWER(child.display_name) LIKE @search OR LOWER(child.urn) LIKE @search)")
            params["search"] = f"%{search_query.lower()}%"
            ptypes["search"] = param_types.STRING
        if cursor:
            clauses.append("child.display_name > @cursor")
            params["cursor"] = cursor
            ptypes["cursor"] = param_types.STRING

        sort_col = "child.display_name"
        if sort_property and sort_property != "displayName":
            sort_col = f"child.{sanitize_identifier(sort_property)}"

        gql_query = (
            f"MATCH (p)-[r]->(child) WHERE {' AND '.join(clauses)} "
            f"RETURN SAFE_TO_JSON(child) AS node, LABELS(child) AS labels "
            f"ORDER BY {sort_col} "
            f"LIMIT {max(1, int(limit))} OFFSET {max(0, int(offset))}"
        )
        rows = await gql.execute_ro(
            self._conn,
            gql_query,
            graph_name=self._graph_name,
            params=params,
            param_types_=ptypes,
            max_staleness_s=self._read_staleness_s,
            request_tag="get_children",
        )
        out: List[GraphNode] = []
        for node_json, labels in rows:
            n = self._hydrate_node(node_json, labels)
            if n:
                out.append(n)
        return out

    async def get_parent(self, child_urn: str) -> Optional[GraphNode]:
        await self._ensure_ready()
        from google.cloud.spanner_v1 import param_types

        cont_types = list(self._require_containment_types())
        if not cont_types:
            return None
        rows = await gql.execute_ro(
            self._conn,
            "MATCH (p)-[r]->(c) WHERE c.urn = @child AND r.edge_type IN UNNEST(@cont_types) "
            "RETURN SAFE_TO_JSON(p) AS node, LABELS(p) AS labels LIMIT 1",
            graph_name=self._graph_name,
            params={"child": child_urn, "cont_types": cont_types},
            param_types_={
                "child": param_types.STRING,
                "cont_types": param_types.Array(param_types.STRING),
            },
            max_staleness_s=self._read_staleness_s,
            request_tag="get_parent",
        )
        if not rows:
            return None
        node_json, labels = rows[0]
        return self._hydrate_node(node_json, labels)

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
        del include_child_count  # included for signature parity; not used here
        await self._ensure_ready()
        from google.cloud.spanner_v1 import param_types

        cont_types = list(self._require_containment_types())
        clauses: List[str] = []
        params: Dict[str, Any] = {}
        ptypes: Dict[str, Any] = {}

        if cont_types:
            # NOT EXISTS subquery — the standard GQL idiom for "no incoming
            # containment edge". Edge filtering uses the column rather than
            # LABELS() since the managed schema models edge_type as a column.
            clauses.append(
                "NOT EXISTS { MATCH (p)-[rr]->(n) WHERE rr.edge_type IN UNNEST(@cont_types) }"
            )
            params["cont_types"] = cont_types
            ptypes["cont_types"] = param_types.Array(param_types.STRING)
        if entity_types:
            clauses.append("n.entity_type IN UNNEST(@entity_types)")
            params["entity_types"] = list(entity_types)
            ptypes["entity_types"] = param_types.Array(param_types.STRING)
        if search_query:
            clauses.append("(LOWER(n.display_name) LIKE @search OR LOWER(n.urn) LIKE @search)")
            params["search"] = f"%{search_query.lower()}%"
            ptypes["search"] = param_types.STRING
        if cursor:
            clauses.append("n.display_name > @cursor")
            params["cursor"] = cursor
            ptypes["cursor"] = param_types.STRING

        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        gql_query = (
            f"MATCH (n) {where} "
            f"RETURN SAFE_TO_JSON(n) AS node, LABELS(n) AS labels "
            f"ORDER BY n.display_name LIMIT {max(1, int(limit)) + 1}"
        )
        rows = await gql.execute_ro(
            self._conn,
            gql_query,
            graph_name=self._graph_name,
            params=params,
            param_types_=ptypes,
            max_staleness_s=self._read_staleness_s,
            request_tag="get_top_level",
        )
        nodes: List[GraphNode] = []
        for node_json, labels in rows:
            n = self._hydrate_node(node_json, labels)
            if n:
                nodes.append(n)
        has_more = len(nodes) > limit
        nodes = nodes[:limit]
        next_cursor = nodes[-1].display_name if has_more and nodes else None

        roots = {t.lower() for t in (root_entity_types or [])}
        root_count = sum(1 for n in nodes if (n.entity_type or "").lower() in roots) if roots else 0
        orphan_count = len(nodes) - root_count

        return TopLevelNodesResult(
            nodes=nodes,
            totalCount=len(nodes) + (1 if has_more else 0),
            hasMore=has_more,
            nextCursor=next_cursor,
            rootTypeCount=root_count,
            orphanCount=orphan_count,
        )

    # ------------------------------------------------------------------
    # Lineage traversal
    # ------------------------------------------------------------------

    async def get_upstream(
        self,
        urn: str,
        depth: int,
        include_column_lineage: bool = False,
        descendant_types: Optional[List[str]] = None,
    ) -> LineageResult:
        del include_column_lineage
        return await self._traverse_lineage(urn, depth, direction="in", descendant_types=descendant_types)

    async def get_downstream(
        self,
        urn: str,
        depth: int,
        include_column_lineage: bool = False,
        descendant_types: Optional[List[str]] = None,
    ) -> LineageResult:
        del include_column_lineage
        return await self._traverse_lineage(urn, depth, direction="out", descendant_types=descendant_types)

    async def get_full_lineage(
        self,
        urn: str,
        upstream_depth: int,
        downstream_depth: int,
        include_column_lineage: bool = False,
        descendant_types: Optional[List[str]] = None,
    ) -> LineageResult:
        del include_column_lineage
        upstream = await self._traverse_lineage(urn, upstream_depth, direction="in", descendant_types=descendant_types)
        downstream = await self._traverse_lineage(urn, downstream_depth, direction="out", descendant_types=descendant_types)
        nodes_by_urn: Dict[str, GraphNode] = {n.urn: n for n in upstream.nodes}
        for n in downstream.nodes:
            nodes_by_urn.setdefault(n.urn, n)
        edges_by_id: Dict[str, GraphEdge] = {e.id: e for e in upstream.edges}
        for e in downstream.edges:
            edges_by_id.setdefault(e.id, e)
        return LineageResult(
            nodes=list(nodes_by_urn.values()),
            edges=list(edges_by_id.values()),
            upstreamUrns=set(upstream.upstream_urns),
            downstreamUrns=set(downstream.downstream_urns),
            totalCount=len(nodes_by_urn),
            hasMore=upstream.has_more or downstream.has_more,
        )

    async def _traverse_lineage(
        self,
        urn: str,
        depth: int,
        *,
        direction: str,
        descendant_types: Optional[List[str]] = None,
    ) -> LineageResult:
        await self._ensure_ready()
        from google.cloud.spanner_v1 import param_types

        depth = max(1, min(int(depth or 1), 25))
        cont_types = sorted(self._get_containment_edge_types())

        # Edge-internal predicate — exclude containment + AGGREGATED. The
        # filter goes inside the bracket because ``r`` is a single edge at
        # each step within the quantified path; outside the bracket it is
        # ARRAY<EDGE>.
        edge_predicate_parts: List[str] = []
        params: Dict[str, Any] = {"start_urn": urn}
        ptypes: Dict[str, Any] = {"start_urn": param_types.STRING}
        if cont_types:
            edge_predicate_parts.append("r.edge_type NOT IN UNNEST(@cont_types)")
            params["cont_types"] = cont_types
            ptypes["cont_types"] = param_types.Array(param_types.STRING)
        edge_predicate_parts.append("r.edge_type != 'AGGREGATED'")
        edge_predicate = " AND ".join(edge_predicate_parts)

        # NOTE: quantified path syntax is a single arrow before the edge
        # bracket and the quantifier between the closing bracket and the
        # destination node. ``->`` for outbound, ``<-`` for inbound; the
        # bracket text is constant.
        edge_pattern = f"-[r WHERE {edge_predicate}]->" if direction == "out" else f"<-[r WHERE {edge_predicate}]-"

        outer_clauses = ["start.urn = @start_urn"]
        if descendant_types:
            outer_clauses.append("other.entity_type IN UNNEST(@descendant_types)")
            params["descendant_types"] = list(descendant_types)
            ptypes["descendant_types"] = param_types.Array(param_types.STRING)
        outer_where = " AND ".join(outer_clauses)

        gql_query = (
            f"MATCH (start){edge_pattern}{{1,{depth}}}(other) "
            f"WHERE {outer_where} "
            f"RETURN DISTINCT SAFE_TO_JSON(other) AS node, LABELS(other) AS labels"
        )
        rows = await gql.execute_ro(
            self._conn,
            gql_query,
            graph_name=self._graph_name,
            params=params,
            param_types_=ptypes,
            max_staleness_s=self._read_staleness_s,
            request_tag=f"lineage_{direction}",
        )
        nodes: Dict[str, GraphNode] = {}
        for node_json, labels in rows:
            n = self._hydrate_node(node_json, labels)
            if n:
                nodes[n.urn] = n

        # Edges between the start node and the discovered set.
        edges: List[GraphEdge] = []
        if nodes:
            urns = [urn] + list(nodes.keys())
            try:
                fetched = await self.get_edges(EdgeQuery(anyUrns=urns, limit=10_000))
                cont_set = {t.upper() for t in cont_types}
                for e in fetched:
                    et = e.edge_type.upper()
                    if et in cont_set or et == "AGGREGATED":
                        continue
                    edges.append(e)
            except Exception as exc:  # noqa: BLE001
                logger.warning("spanner_graph: lineage edge fetch failed: %s", exc)

        start_node = await self.get_node(urn)
        if start_node:
            nodes[urn] = start_node

        upstream_urns: Set[str] = set(nodes.keys()) if direction == "in" else set()
        downstream_urns: Set[str] = set(nodes.keys()) if direction == "out" else set()

        return LineageResult(
            nodes=list(nodes.values()),
            edges=edges,
            upstreamUrns=upstream_urns,
            downstreamUrns=downstream_urns,
            totalCount=len(nodes),
            hasMore=False,
        )

    async def get_aggregated_edges_between(
        self,
        source_urns: List[str],
        target_urns: Optional[List[str]],
        granularity: Any,
        containment_edges: List[str],
        lineage_edges: List[str],
    ) -> AggregatedEdgeResult:
        del granularity, containment_edges, lineage_edges  # parity with contract
        await self._ensure_aggregation_tables()
        from google.cloud.spanner_v1 import param_types

        sidecar = schema.sidecar_table_name(self._graph_name)
        clauses = ["source_urn IN UNNEST(@source_urns)"]
        params: Dict[str, Any] = {"source_urns": list(source_urns or [])}
        ptypes: Dict[str, Any] = {"source_urns": param_types.Array(param_types.STRING)}
        if target_urns:
            clauses.append("target_urn IN UNNEST(@target_urns)")
            params["target_urns"] = list(target_urns)
            ptypes["target_urns"] = param_types.Array(param_types.STRING)
        rows = await gql.execute_ro(
            self._conn,
            f"SELECT source_urn, target_urn, weight, source_edge_types "
            f"FROM `{sidecar}` WHERE {' AND '.join(clauses)} "
            f"ORDER BY source_urn, target_urn",
            graph_name=self._graph_name,
            params=params,
            param_types_=ptypes,
            max_staleness_s=self._read_staleness_s,
            request_tag="get_aggregated_edges_between",
        )
        infos: List[AggregatedEdgeInfo] = []
        total = 0
        for s, t, weight, src_types in rows:
            total += int(weight or 0)
            infos.append(AggregatedEdgeInfo(
                id=f"{s}|AGGREGATED|{t}",
                sourceUrn=str(s),
                targetUrn=str(t),
                edgeCount=int(weight or 0),
                edgeTypes=[str(x) for x in (src_types or [])],
                confidence=1.0,
                sourceEdgeIds=[],
            ))
        return AggregatedEdgeResult(aggregatedEdges=infos, totalSourceEdges=total)

    async def get_trace_lineage(
        self,
        urn: str,
        direction: str,
        depth: int,
        containment_edges: List[str],
        lineage_edges: List[str],
    ) -> LineageResult:
        del containment_edges, lineage_edges
        if direction == "in":
            return await self.get_upstream(urn, depth)
        if direction == "out":
            return await self.get_downstream(urn, depth)
        if direction == "both":
            return await self.get_full_lineage(urn, depth, depth)
        raise ValueError(f"spanner_graph: unknown trace direction {direction!r}")

    async def get_full_lineage_as_of(
        self,
        urn: str,
        as_of_timestamp: datetime,
        upstream_depth: int,
        downstream_depth: int,
        include_column_lineage: bool = False,
        descendant_types: Optional[List[str]] = None,
    ) -> LineageResult:
        if as_of_timestamp.tzinfo is None:
            as_of_timestamp = as_of_timestamp.replace(tzinfo=timezone.utc)
        if datetime.now(tz=timezone.utc) - as_of_timestamp > timedelta(days=7):
            raise ValueError(
                "spanner_graph: as_of_timestamp is older than the 7-day PITR window"
            )
        # Force strong reads for the duration of the call so the
        # underlying snapshot honours the as-of timestamp instead of the
        # bounded-staleness default.
        original = self._read_staleness_s
        self._read_staleness_s = 0.0
        try:
            return await self.get_full_lineage(
                urn=urn,
                upstream_depth=upstream_depth,
                downstream_depth=downstream_depth,
                include_column_lineage=include_column_lineage,
                descendant_types=descendant_types,
            )
        finally:
            self._read_staleness_s = original

    # ------------------------------------------------------------------
    # Metadata
    # ------------------------------------------------------------------

    async def get_stats(self) -> Dict[str, Any]:
        cached = self._stats_cache.get()
        if cached is not None:
            return cached
        await self._ensure_ready()
        rows = await gql.execute_ro(
            self._conn,
            "MATCH (n) RETURN COUNT(*) AS node_count",
            graph_name=self._graph_name,
            max_staleness_s=self._read_staleness_s,
            request_tag="stats_nodes",
        )
        node_count = int(rows[0][0]) if rows else 0
        rows = await gql.execute_ro(
            self._conn,
            "MATCH ()-[r]->() RETURN COUNT(*) AS edge_count",
            graph_name=self._graph_name,
            max_staleness_s=self._read_staleness_s,
            request_tag="stats_edges",
        )
        edge_count = int(rows[0][0]) if rows else 0
        agg_count = await self.count_aggregated_edges()
        out = {
            "node_count": node_count,
            "edge_count": edge_count,
            "aggregated_edge_count": agg_count,
            "graph": f"{self._database_id}.{self._graph_name}",
        }
        self._stats_cache.set(out)
        return out

    async def get_schema_stats(self) -> GraphSchemaStats:
        await self._ensure_ready()
        # Use entity_type / edge_type columns so we don't call LABELS()
        # in a GROUP BY (which has surprising semantics around array
        # columns). The managed schema models the type as a column;
        # external schemas should override get_schema_stats().
        entity_rows = await gql.execute_ro(
            self._conn,
            "MATCH (n) RETURN n.entity_type AS lbl, COUNT(*) AS c "
            "ORDER BY c DESC",
            graph_name=self._graph_name,
            max_staleness_s=self._read_staleness_s,
            request_tag="schema_stats_entities",
        )
        # GQL aggregations group by all returned non-aggregate columns;
        # when only one column is non-aggregate the engine treats it as
        # the GROUP BY key.
        entity_summaries = [
            EntityTypeSummary(id=str(lbl), name=str(lbl), count=int(c))
            for lbl, c in entity_rows
            if lbl is not None
        ]
        edge_rows = await gql.execute_ro(
            self._conn,
            "MATCH ()-[r]->() RETURN r.edge_type AS lbl, COUNT(*) AS c "
            "ORDER BY c DESC",
            graph_name=self._graph_name,
            max_staleness_s=self._read_staleness_s,
            request_tag="schema_stats_edges",
        )
        edge_summaries = [
            EdgeTypeSummary(id=str(lbl), name=str(lbl), count=int(c))
            for lbl, c in edge_rows
            if lbl is not None
        ]
        total_nodes = sum(s.count for s in entity_summaries)
        total_edges = sum(s.count for s in edge_summaries)
        tag_summaries: List[TagSummary] = []
        try:
            rows = await gql.execute_ro(
                self._conn,
                "MATCH (n) WHERE n.tags IS NOT NULL "
                "RETURN tag, COUNT(*) AS c "
                "ORDER BY c DESC LIMIT 100",
                graph_name=self._graph_name,
                max_staleness_s=self._read_staleness_s,
                request_tag="schema_stats_tags",
            )
            tag_summaries = [
                TagSummary(tag=str(tag), count=int(c))
                for tag, c in rows
                if tag is not None
            ]
        except Exception:  # noqa: BLE001
            pass
        return GraphSchemaStats(
            totalNodes=total_nodes,
            totalEdges=total_edges,
            entityTypeStats=entity_summaries,
            edgeTypeStats=edge_summaries,
            tagStats=tag_summaries,
        )

    async def get_ontology_metadata(self) -> OntologyMetadata:
        cached = self._ontology_cache.get()
        if cached is not None:
            return cached
        await self._ensure_ready()
        cont_types = sorted(self._get_containment_edge_types())

        # Use the resolved metadata when available (ontology service has
        # already done the work); otherwise discover from the schema.
        if self._resolved_edge_metadata_set:
            edge_metadata: Dict[str, EdgeTypeMetadata] = {
                k: v if isinstance(v, EdgeTypeMetadata) else EdgeTypeMetadata(**v)
                for k, v in self._resolved_edge_metadata.items()
            }
            lineage_types = sorted(self._resolved_lineage_types)
            hierarchy: Dict[str, EntityTypeHierarchy] = {}
        else:
            edge_metadata = {}
            lineage_types = []
            try:
                edge_rows = await gql.execute_ro(
                    self._conn,
                    "MATCH ()-[r]->() RETURN DISTINCT r.edge_type AS lbl",
                    graph_name=self._graph_name,
                    max_staleness_s=self._read_staleness_s,
                    request_tag="ontology_edge_labels",
                )
                edge_labels = [str(r[0]) for r in edge_rows if r and r[0]]
            except Exception:  # noqa: BLE001
                edge_labels = []
            for lbl in edge_labels:
                is_cont = lbl.upper() in {c.upper() for c in cont_types}
                edge_metadata[lbl] = EdgeTypeMetadata(
                    isContainment=is_cont,
                    isLineage=not is_cont and lbl.upper() != "AGGREGATED",
                    direction="parent-to-child" if is_cont else "source-to-target",
                    category="structural" if is_cont else "flow",
                )
                if not is_cont and lbl.upper() != "AGGREGATED":
                    lineage_types.append(lbl)
            hierarchy = {}

        out = OntologyMetadata(
            containmentEdgeTypes=cont_types,
            lineageEdgeTypes=lineage_types,
            edgeTypeMetadata=edge_metadata,
            entityTypeHierarchy=hierarchy,
            rootEntityTypes=[],
        )
        self._ontology_cache.set(out)
        return out

    async def get_distinct_values(self, property_name: str) -> List[Any]:
        await self._ensure_ready()
        prop = sanitize_identifier(property_name)
        if not prop:
            return []
        rows = await gql.execute_ro(
            self._conn,
            f"MATCH (n) WHERE n.{prop} IS NOT NULL "
            f"RETURN DISTINCT n.{prop} AS v ORDER BY v LIMIT 1000",
            graph_name=self._graph_name,
            max_staleness_s=self._read_staleness_s,
            request_tag="get_distinct_values",
        )
        return [coerce_spanner_value(r[0]) for r in rows]

    # ------------------------------------------------------------------
    # Traversal extensions
    # ------------------------------------------------------------------

    async def get_ancestors(self, urn: str, limit: int = 100, offset: int = 0) -> List[GraphNode]:
        await self._ensure_ready()
        from google.cloud.spanner_v1 import param_types

        cont_types = list(self._require_containment_types())
        if not cont_types:
            return []
        # Quantified path: one arrow before the bracket, quantifier after.
        # Edge predicate goes inside the bracket because ``r`` is a single
        # edge at each step within the path.
        rows = await gql.execute_ro(
            self._conn,
            "MATCH (a)-[r WHERE r.edge_type IN UNNEST(@cont_types)]->{1,25}(c) "
            "WHERE c.urn = @urn "
            "RETURN DISTINCT SAFE_TO_JSON(a) AS node, LABELS(a) AS labels "
            "ORDER BY a.display_name "
            f"LIMIT {max(1, int(limit))} OFFSET {max(0, int(offset))}",
            graph_name=self._graph_name,
            params={"urn": urn, "cont_types": cont_types},
            param_types_={
                "urn": param_types.STRING,
                "cont_types": param_types.Array(param_types.STRING),
            },
            max_staleness_s=self._read_staleness_s,
            request_tag="get_ancestors",
        )
        out: List[GraphNode] = []
        for node_json, labels in rows:
            n = self._hydrate_node(node_json, labels)
            if n:
                out.append(n)
        return out

    async def get_descendants(
        self,
        urn: str,
        depth: int = 5,
        entity_types: Optional[List[str]] = None,
        limit: int = 100,
        offset: int = 0,
    ) -> List[GraphNode]:
        await self._ensure_ready()
        from google.cloud.spanner_v1 import param_types

        cont_types = list(self._require_containment_types())
        if not cont_types:
            return []
        d = max(1, min(int(depth), 25))
        clauses = ["a.urn = @urn"]
        params: Dict[str, Any] = {"urn": urn, "cont_types": cont_types}
        ptypes: Dict[str, Any] = {
            "urn": param_types.STRING,
            "cont_types": param_types.Array(param_types.STRING),
        }
        if entity_types:
            clauses.append("d.entity_type IN UNNEST(@entity_types)")
            params["entity_types"] = list(entity_types)
            ptypes["entity_types"] = param_types.Array(param_types.STRING)

        rows = await gql.execute_ro(
            self._conn,
            f"MATCH (a)-[r WHERE r.edge_type IN UNNEST(@cont_types)]->{{1,{d}}}(d) "
            f"WHERE {' AND '.join(clauses)} "
            f"RETURN DISTINCT SAFE_TO_JSON(d) AS node, LABELS(d) AS labels "
            f"ORDER BY d.display_name "
            f"LIMIT {max(1, int(limit))} OFFSET {max(0, int(offset))}",
            graph_name=self._graph_name,
            params=params,
            param_types_=ptypes,
            max_staleness_s=self._read_staleness_s,
            request_tag="get_descendants",
        )
        out: List[GraphNode] = []
        for node_json, labels in rows:
            n = self._hydrate_node(node_json, labels)
            if n:
                out.append(n)
        return out

    async def get_nodes_by_tag(self, tag: str, limit: int = 100, offset: int = 0) -> List[GraphNode]:
        await self._ensure_ready()
        from google.cloud.spanner_v1 import param_types

        rows = await gql.execute_ro(
            self._conn,
            "MATCH (n) WHERE @tag IN UNNEST(n.tags) "
            "RETURN SAFE_TO_JSON(n) AS node, LABELS(n) AS labels "
            "ORDER BY n.display_name "
            f"LIMIT {max(1, int(limit))} OFFSET {max(0, int(offset))}",
            graph_name=self._graph_name,
            params={"tag": tag},
            param_types_={"tag": param_types.STRING},
            max_staleness_s=self._read_staleness_s,
            request_tag="get_nodes_by_tag",
        )
        out: List[GraphNode] = []
        for node_json, labels in rows:
            n = self._hydrate_node(node_json, labels)
            if n:
                out.append(n)
        return out

    async def get_nodes_by_layer(self, layer_id: str, limit: int = 100, offset: int = 0) -> List[GraphNode]:
        await self._ensure_ready()
        from google.cloud.spanner_v1 import param_types

        rows = await gql.execute_ro(
            self._conn,
            "MATCH (n) WHERE n.layer_assignment = @layer "
            "RETURN SAFE_TO_JSON(n) AS node, LABELS(n) AS labels "
            "ORDER BY n.display_name "
            f"LIMIT {max(1, int(limit))} OFFSET {max(0, int(offset))}",
            graph_name=self._graph_name,
            params={"layer": layer_id},
            param_types_={"layer": param_types.STRING},
            max_staleness_s=self._read_staleness_s,
            request_tag="get_nodes_by_layer",
        )
        out: List[GraphNode] = []
        for node_json, labels in rows:
            n = self._hydrate_node(node_json, labels)
            if n:
                out.append(n)
        return out

    # ------------------------------------------------------------------
    # Write operations
    # ------------------------------------------------------------------

    async def save_custom_graph(self, nodes: List[GraphNode], edges: List[GraphEdge]) -> bool:
        await self._ensure_ready()
        await mutations.bulk_upsert(self._conn, nodes=nodes, edges=edges)
        self._stats_cache.invalidate()
        return True

    async def create_node(self, node: GraphNode, containment_edge: Optional[GraphEdge] = None) -> bool:
        await self.save_custom_graph([node], [containment_edge] if containment_edge else [])
        return True

    async def create_edge(self, edge: GraphEdge) -> bool:
        await self.save_custom_graph([], [edge])
        return True

    async def update_edge(self, edge_id: str, properties: Dict[str, Any]) -> Optional[GraphEdge]:
        await self._ensure_ready()
        return await mutations.update_edge_properties(self._conn, edge_id, properties)

    async def delete_edge(self, edge_id: str) -> bool:
        await self._ensure_ready()
        ok = await mutations.delete_edge(self._conn, edge_id)
        if ok:
            self._stats_cache.invalidate()
        return ok

    # ------------------------------------------------------------------
    # Aggregation lifecycle hooks
    # ------------------------------------------------------------------

    async def set_projection_mode(self, mode: str) -> None:
        if mode == "dedicated":
            logger.info(
                "spanner_graph: projection_mode='dedicated' is treated as 'in_source' — "
                "the sidecar table approach already provides isolation."
            )

    async def ensure_projections(self) -> None:
        await self._ensure_aggregation_tables()

    async def count_aggregated_edges(self) -> int:
        if not self._aggregation_ensured:
            return 0
        return await aggregation.count_aggregated_edges(self._conn, self._graph_name)

    async def purge_aggregated_edges(
        self,
        *,
        batch_size: int = 10_000,
        progress_callback: Optional[Callable[[int], Awaitable[None]]] = None,
    ) -> int:
        del batch_size  # partitioned DML chunks internally
        await self._ensure_aggregation_tables()
        sidecar = schema.sidecar_table_name(self._graph_name)
        total_before = await self.count_aggregated_edges()
        deleted = await mutations.purge_table(self._conn, sidecar, timeout=DEFAULT_DDL_TIMEOUT_S * 5)
        if progress_callback is not None:
            try:
                await progress_callback(min(deleted, total_before or deleted))
            except Exception as exc:  # noqa: BLE001
                logger.warning("spanner_graph: purge progress_callback failed: %s", exc)
        # Reset watermark so a subsequent aggregation does a full pass.
        try:
            from google.cloud.spanner_v1 import param_types
            await gql.execute_rw(
                self._conn,
                f"DELETE FROM `{schema.aggregation_state_table_name(self._graph_name)}` "
                f"WHERE scope = @scope",
                graph_name=self._graph_name,
                params={"scope": self._graph_name},
                param_types_={"scope": param_types.STRING},
                request_tag="purge_aggregation_state",
            )
        except Exception:  # noqa: BLE001
            pass
        return deleted

    async def materialize_aggregated_edges_batch(
        self,
        batch_size: int = 1000,
        containment_edge_types: Optional[List[str]] = None,
        lineage_edge_types: Optional[List[str]] = None,
        last_cursor: Optional[str] = None,
        progress_callback: Optional[Any] = None,
        intra_batch_callback: Optional[Callable[[int], Awaitable[None]]] = None,
        should_cancel: Optional[Callable[[], bool]] = None,
    ) -> Dict[str, Any]:
        await self._ensure_ready()
        await self._ensure_aggregation_tables()
        cont = list(containment_edge_types or self._require_containment_types())
        return await aggregation.materialize_batch(
            self._conn,
            self._graph_name,
            batch_size=batch_size,
            containment_edge_types=cont,
            lineage_edge_types=lineage_edge_types,
            last_cursor=last_cursor,
            progress_callback=progress_callback,
            intra_batch_callback=intra_batch_callback,
            should_cancel=should_cancel,
        )

    async def on_lineage_edge_written(
        self,
        source_urn: str,
        target_urn: str,
        edge_id: str,
        edge_type: str,
    ) -> None:
        del edge_id
        if edge_type.upper() == "AGGREGATED":
            return
        await self._ensure_aggregation_tables()
        await aggregation.upsert_batch(
            self._conn,
            self._graph_name,
            [(source_urn, target_urn, edge_type)],
        )

    async def on_lineage_edge_deleted(
        self,
        source_urn: str,
        target_urn: str,
        edge_id: str,
    ) -> None:
        del edge_id
        await self._ensure_aggregation_tables()
        sidecar = schema.sidecar_table_name(self._graph_name)
        from google.cloud.spanner_v1 import param_types

        await gql.execute_rw(
            self._conn,
            f"UPDATE `{sidecar}` "
            f"SET weight = weight - 1, latest_update = PENDING_COMMIT_TIMESTAMP() "
            f"WHERE source_urn = @s AND target_urn = @t",
            graph_name=self._graph_name,
            params={"s": source_urn, "t": target_urn},
            param_types_={"s": param_types.STRING, "t": param_types.STRING},
            request_tag="aggr_decrement",
        )
        await gql.execute_rw(
            self._conn,
            f"DELETE FROM `{sidecar}` "
            f"WHERE source_urn = @s AND target_urn = @t AND weight <= 0",
            graph_name=self._graph_name,
            params={"s": source_urn, "t": target_urn},
            param_types_={"s": param_types.STRING, "t": param_types.STRING},
            request_tag="aggr_delete_zero",
        )

    async def on_containment_changed(self, urn: str) -> None:
        del urn
        self._urn_cache = _URNLabelCache(50_000)

    # ------------------------------------------------------------------
    # Discovery
    # ------------------------------------------------------------------

    async def list_graphs(self) -> List[str]:
        await self._ensure_ready()
        out: List[str] = []
        for db_id in await schema.list_databases(self._conn):
            if not db_id:
                continue
            # Switch to a temporary connection per-database to enumerate.
            try:
                def _list(db_id: str = db_id) -> List[str]:
                    db = self._conn.instance.database(db_id)
                    with db.snapshot() as snap:
                        rs = snap.execute_sql(
                            "SELECT property_graph_name FROM INFORMATION_SCHEMA.PROPERTY_GRAPHS"
                        )
                        return [str(r[0]) for r in rs if r and r[0]]

                graphs = await self._conn.run_in_executor(_list, timeout=5.0)
                out.extend(f"{db_id}.{g}" for g in graphs)
            except Exception as exc:  # noqa: BLE001
                logger.info("spanner_graph: list_graphs skipping db=%s (%s)", db_id, exc)
        return sorted(set(out))

    async def discover_schema(self) -> Dict[str, Any]:
        await self._ensure_ready()
        result = await schema.discover_property_graph(self._conn, self._graph_name)
        if result:
            result["capabilities"] = dict(self._capabilities)
        return result

    async def get_diagnostics(self) -> Dict[str, Any]:
        # Best-effort connect — diagnostics must work even when the user
        # is diagnosing why the provider can't reach Spanner.
        try:
            await asyncio.wait_for(self._ensure_ready(), timeout=2.0)
        except Exception:  # noqa: BLE001
            pass

        p50, p95 = self._conn.latency_percentiles()
        return {
            "edition": "EMULATOR" if is_emulator() else "ENTERPRISE_OR_BETTER",
            "dialect": self._dialect or "GOOGLE_STANDARD_SQL",
            "region": self._gcp_region,
            "session_pool": {"size": DEFAULT_THREAD_POOL},
            "last_query_p50_ms": int(p50 * 1000) if p50 is not None else None,
            "last_query_p95_ms": int(p95 * 1000) if p95 is not None else None,
            "last_successful_query_at": self._conn.last_successful_query_at,
            "capabilities": dict(self._capabilities),
            "auto_bootstrap": self._auto_bootstrap,
            "emulator": is_emulator(),
        }

    # ------------------------------------------------------------------
    # Client-side filter helpers (verbatim shapes from the Neo4j adapter)
    # ------------------------------------------------------------------

    def _match_property_filters(self, node: GraphNode, filters: List[PropertyFilter]) -> bool:
        for f in filters:
            actual = node.properties.get(f.field) if node.properties else None
            if not self._match_operator(actual, f.operator, f.value):
                return False
        return True

    def _match_operator(self, actual: Any, op: FilterOperator, target: Any) -> bool:
        if op == FilterOperator.EQUALS:
            return actual == target
        if op == FilterOperator.CONTAINS:
            return target is not None and target in str(actual or "")
        if op == FilterOperator.STARTS_WITH:
            return str(actual or "").startswith(str(target or ""))
        if op == FilterOperator.ENDS_WITH:
            return str(actual or "").endswith(str(target or ""))
        if op == FilterOperator.GT:
            try:
                return actual is not None and target is not None and actual > target
            except TypeError:
                return False
        if op == FilterOperator.LT:
            try:
                return actual is not None and target is not None and actual < target
            except TypeError:
                return False
        if op == FilterOperator.IN:
            return isinstance(target, (list, tuple, set)) and actual in target
        if op == FilterOperator.NOT_IN:
            return isinstance(target, (list, tuple, set)) and actual not in target
        if op == FilterOperator.EXISTS:
            return actual is not None
        if op == FilterOperator.NOT_EXISTS:
            return actual is None
        return False

    def _match_tag_filters(self, node: GraphNode, tag_filter: TagFilter) -> bool:
        node_tags = set(node.tags or [])
        target = set(tag_filter.tags or [])
        if not target:
            return True
        if tag_filter.mode == "all":
            return target.issubset(node_tags)
        if tag_filter.mode == "none":
            return not (target & node_tags)
        return bool(target & node_tags)

    def _match_text_filter(self, text: str, text_filter: TextFilter) -> bool:
        haystack = text or ""
        needle = text_filter.text or ""
        if not text_filter.case_sensitive:
            haystack, needle = haystack.lower(), needle.lower()
        op = (text_filter.operator or "contains").lower()
        if op == "equals":
            return haystack == needle
        if op == "starts_with":
            return haystack.startswith(needle)
        if op == "ends_with":
            return haystack.endswith(needle)
        return needle in haystack
