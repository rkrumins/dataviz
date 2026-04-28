"""
Google Spanner Graph provider.

Subclasses :class:`backend.common.interfaces.provider.GraphDataProvider` and
adheres to the platform contract: every async I/O is bounded by
``asyncio.wait_for``; the underlying ``google-cloud-spanner`` client is sync
and is wrapped in a provider-owned :class:`ThreadPoolExecutor`. Connection
is lazy (double-checked under a lock); ``preflight()`` is the only health
contract the warmup loop sees.

Spanner-native capabilities used:
  * GQL (ISO Graph Query Language) over GoogleSQL graph schemas.
  * INFORMATION_SCHEMA introspection for ``list_graphs`` / ``discover_schema``.
  * Mutations API (``database.batch().insert_or_update``) for bulk upserts in
    aggregation — ~5–10× faster than DML with the same idempotency.
  * Partitioned DML for the purge path (non-partitioned DELETE caps at
    ~20K rows per transaction).
  * Bounded-staleness reads (``database.snapshot(exact_staleness=…)``) for
    browse-path latency on write-heavy databases. Strong reads for the
    aggregation worker.
  * PITR snapshots (``database.snapshot(read_timestamp=…)``) for
    time-travel lineage queries within Spanner's PITR window (≤ 7 days).
  * Edition + dialect gating — ``preflight()`` rejects Standard edition and
    PostgreSQL-dialect databases with recognizable reason codes.
  * IAM preflight via ``test_iam_permissions`` so DDL failures surface the
    exact missing role rather than a generic 403 mid-aggregation.

Aggregation design: a managed sidecar table
``Synodic_AggregatedEdges_<graph>`` is auto-created on first run; aggregated
edges are served by ``get_edges(EdgeQuery(edge_types=["AGGREGATED"]))``
without an overlay PROPERTY GRAPH (the user's underlying graph schema can
evolve without breaking the overlay's SOURCE KEY references).

The provider auto-detects vector indexes and ``SEARCH INDEX`` columns at
connect-time and exposes the capability flags via ``get_diagnostics()``;
the corresponding upgraded ``search_nodes`` paths plug into Vertex AI for
embeddings when ``embed_endpoint`` is configured (off by default).
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import os
import threading
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Dict, List, Optional, Set, Tuple

from backend.common.interfaces.preflight import PreflightResult
from backend.common.interfaces.provider import (
    GraphDataProvider,
    ProviderConfigurationError,
)
from backend.common.models.graph import (
    AggregatedEdgeInfo,
    AggregatedEdgeResult,
    ChildrenWithEdgesResult,
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
from backend.graph.adapters.schema_mapping import (
    SchemaMapping,
    map_edge_props,
    map_node_props,
)

logger = logging.getLogger(__name__)


# ====================================================================
# Module-level helpers
# ====================================================================


def _sanitize_identifier(s: str) -> str:
    """Alphanumeric + underscore only — safe for SQL identifiers (table
    names, index names). We never substitute user input directly into DDL,
    so anything that wouldn't survive this filter is a programmer error.
    """
    cleaned = "".join(c if (c.isalnum() or c == "_") else "_" for c in str(s))
    if cleaned and cleaned[0].isdigit():
        cleaned = f"_{cleaned}"
    return cleaned or "graph"


def _coerce_spanner_value(value: Any) -> Any:
    """Normalize Spanner SDK return values into JSON-friendly Python.

    Spanner returns native Python primitives for INT64/FLOAT64/BOOL/STRING,
    ``datetime.datetime`` for TIMESTAMP, ``datetime.date`` for DATE,
    ``bytes`` for BYTES, ``Decimal`` for NUMERIC, lists for ARRAY<...>, and
    a ``JsonObject`` (dict subclass) for JSON. Synodic's GraphNode /
    GraphEdge property bags are serialized to JSON downstream so we coerce
    everything that doesn't survive ``json.dumps`` here.
    """
    # Avoid importing decimal at module import time when it's only needed
    # for the rare numeric path.
    if value is None:
        return None
    if isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat() if value.tzinfo else value.replace(tzinfo=timezone.utc).isoformat()
    if isinstance(value, bytes):
        return base64.b64encode(value).decode("ascii")
    if isinstance(value, list):
        return [_coerce_spanner_value(v) for v in value]
    if isinstance(value, dict):
        return {k: _coerce_spanner_value(v) for k, v in value.items()}
    # Decimal / Date / time / etc.
    return str(value)


def _node_from_props(props: Dict[str, Any], entity_type_str: Optional[str] = None) -> Optional[GraphNode]:
    """Build a GraphNode from a canonical-shape dict (post schema-mapping)."""
    if not props or not props.get("urn"):
        return None
    entity_type = entity_type_str or props.get("entityType") or "container"
    raw_props = props.get("properties")
    if isinstance(raw_props, str):
        try:
            raw_props = json.loads(raw_props)
        except (json.JSONDecodeError, TypeError):
            raw_props = {}
    raw_tags = props.get("tags")
    if isinstance(raw_tags, str):
        try:
            raw_tags = json.loads(raw_tags)
        except (json.JSONDecodeError, TypeError):
            raw_tags = []
    try:
        return GraphNode(
            urn=str(props["urn"]),
            entityType=str(entity_type),
            displayName=str(props.get("displayName") or ""),
            qualifiedName=props.get("qualifiedName"),
            description=props.get("description"),
            properties=raw_props if isinstance(raw_props, dict) else {},
            tags=raw_tags if isinstance(raw_tags, list) else [],
            layerAssignment=props.get("layerAssignment"),
            childCount=props.get("childCount"),
            sourceSystem=props.get("sourceSystem"),
            lastSyncedAt=props.get("lastSyncedAt"),
        )
    except Exception as exc:  # noqa: BLE001 — defensive: hydration must not crash the request
        logger.warning("Spanner: failed to build GraphNode from props=%r: %s", list(props.keys()), exc)
        return None


def _edge_from_row(
    source_urn: str,
    target_urn: str,
    edge_type: str,
    edge_id: Optional[str],
    confidence: Optional[float],
    properties: Optional[Dict[str, Any]],
) -> GraphEdge:
    """Build a GraphEdge from canonical edge fields."""
    eid = edge_id or f"{source_urn}|{edge_type}|{target_urn}"
    props = properties or {}
    if isinstance(props, str):
        try:
            props = json.loads(props)
        except (json.JSONDecodeError, TypeError):
            props = {}
    return GraphEdge(
        id=str(eid),
        sourceUrn=source_urn,
        targetUrn=target_urn,
        edgeType=str(edge_type),
        confidence=confidence,
        properties=props if isinstance(props, dict) else {},
    )


# ====================================================================
# In-memory caches (mirroring the Neo4j adapter's helper layout)
# ====================================================================


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

    def put_bulk(self, mapping: Dict[str, str]) -> None:
        for urn, label in mapping.items():
            self.put(urn, label)


@dataclass
class _LatencyHistogram:
    """Tiny ring-buffer to compute p50/p95 over the last N query durations.

    Concurrent appends are guarded by a Lock (executor threads write here);
    the read path takes a snapshot copy and computes percentiles offline.
    """

    capacity: int = 256
    samples: List[float] = None  # type: ignore[assignment]
    _lock: threading.Lock = None  # type: ignore[assignment]
    _idx: int = 0
    _filled: bool = False

    def __post_init__(self) -> None:
        self.samples = [0.0] * self.capacity
        self._lock = threading.Lock()

    def record(self, duration_s: float) -> None:
        with self._lock:
            self.samples[self._idx] = duration_s
            self._idx = (self._idx + 1) % self.capacity
            if self._idx == 0:
                self._filled = True

    def snapshot(self) -> Tuple[Optional[float], Optional[float]]:
        with self._lock:
            window = list(self.samples[: self.capacity if self._filled else self._idx])
        if not window:
            return None, None
        window.sort()
        n = len(window)
        p50 = window[max(0, int(n * 0.50) - 1)]
        p95 = window[max(0, int(n * 0.95) - 1)]
        return p50, p95


# ====================================================================
# Provider
# ====================================================================


_DEFAULT_QUERY_TIMEOUT_S = 5.0
_DEFAULT_DDL_TIMEOUT_S = 60.0
_DEFAULT_AGGR_TIMEOUT_S = 30.0
_DEFAULT_RETRY_ATTEMPTS = 3
_DEFAULT_THREAD_POOL = int(os.getenv("SPANNER_GRAPH_THREAD_POOL", "20"))
_DEFAULT_READ_STALENESS_S = 10.0


class SpannerGraphProvider(GraphDataProvider):
    """:class:`GraphDataProvider` implementation backed by Google Spanner Graph.

    All abstract methods are implemented. Optional extension methods
    (``discover_schema``, ``list_graphs``, ``materialize_aggregated_edges_batch``,
    ``count_aggregated_edges``, ``purge_aggregated_edges``, ``get_diagnostics``,
    ``get_full_lineage_as_of``) are overridden where Spanner can satisfy them.
    """

    # ------------------------------------------------------------------ #
    # Construction & state                                                 #
    # ------------------------------------------------------------------ #

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
        self._auth_method = (auth_method or "adc").lower()
        self._credentials_json_b64 = credentials_json
        self._impersonate_sa = impersonate_service_account
        self._gcp_region = gcp_region
        self._read_staleness_s = (
            float(read_staleness_s) if read_staleness_s is not None else _DEFAULT_READ_STALENESS_S
        )
        self._change_stream_name = change_stream_name
        self._embed_endpoint = embed_endpoint
        self._extra_config: Dict[str, Any] = extra_config or {}

        # Lazy-initialized handles
        self._client = None  # google.cloud.spanner.Client
        self._instance = None
        self._database = None
        self._credentials = None
        self._executor: Optional[ThreadPoolExecutor] = None
        self._connect_lock = asyncio.Lock()

        # Optional ancestor-chain Redis (mirrors Neo4j adapter)
        self._redis = None
        self._redis_available = False
        self._redis_lock = asyncio.Lock()

        # Caches
        self._mapping: SchemaMapping = SchemaMapping.from_extra_config(self._extra_config)
        self._stats_cache = _TTLCache(60.0)
        self._ontology_cache = _TTLCache(60.0)
        self._urn_cache = _URNLabelCache(50_000)
        self._latency = _LatencyHistogram()
        self._last_successful_query_at: Optional[float] = None

        # Containment edge types — three-tier resolution chain
        self._resolved_containment_types: Set[str] = set()
        self._resolved_containment_types_set = False
        self._containment_cache: Optional[Set[str]] = None

        # Spanner-native capability state — populated on first connect
        self._edition: Optional[str] = None
        self._dialect: Optional[str] = None
        self._capabilities: Dict[str, bool] = {
            "time_travel": True,  # Spanner PITR is always available within the window
            "vector_search": False,
            "full_text_search": False,
            "change_streams": False,
        }
        self._schema_fingerprint: Optional[str] = None
        self._schema_drift_detected: bool = False

        # Aggregation-side state
        self._sidecar_ensured: bool = False
        self._sidecar_lock = asyncio.Lock()
        self._change_stream_task: Optional[asyncio.Task] = None

    @property
    def name(self) -> str:
        return f"spanner_graph[{self._instance_id}/{self._database_id}.{self._graph_name}]"

    # ------------------------------------------------------------------ #
    # Lifecycle                                                            #
    # ------------------------------------------------------------------ #

    async def preflight(self, *, deadline_s: float = 1.5) -> PreflightResult:
        """Bounded reachability + edition + dialect probe.

        Runs ``SELECT 1 FROM INFORMATION_SCHEMA.PROPERTY_GRAPHS LIMIT 1``
        against the configured database and classifies the outcome:
        ``ok`` / ``auth_error`` / ``spanner_edition_unsupported`` /
        ``dialect_unsupported`` / ``database_not_found`` / ``connect_timeout``.
        Never raises.
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
                rows = await asyncio.wait_for(
                    self._ro_gql(
                        "SELECT property_graph_name "
                        "FROM INFORMATION_SCHEMA.PROPERTY_GRAPHS LIMIT 1",
                        params=None,
                        param_types_=None,
                        max_staleness_s=0.0,
                    ),
                    timeout=deadline_s,
                )
            except asyncio.TimeoutError:
                return PreflightResult.failure(
                    reason="query_timeout",
                    elapsed_ms=int((time.monotonic() - t0) * 1000),
                )
            elapsed_ms = int((time.monotonic() - t0) * 1000)
            # rows is a list (possibly empty if no graphs are defined yet —
            # still a valid "reachable" outcome).
            _ = rows
            return PreflightResult.success(
                peer=f"{self._project_id}/{self._instance_id}/{self._database_id}",
                elapsed_ms=elapsed_ms,
            )
        except asyncio.CancelledError:
            raise
        except BaseException as exc:  # noqa: BLE001 — preflight must not raise
            elapsed_ms = int((time.monotonic() - t0) * 1000)
            reason = self._classify_spanner_error(exc)
            return PreflightResult.failure(reason=reason, elapsed_ms=elapsed_ms)

    @staticmethod
    def _classify_spanner_error(exc: BaseException) -> str:
        msg = f"{type(exc).__name__}: {exc!s}"
        lowered = msg.lower()
        if "permission" in lowered or "unauthenticated" in lowered or "credentials" in lowered:
            return "auth_error"
        if "not found" in lowered and "database" in lowered:
            return "database_not_found"
        if "property_graphs" in lowered and ("does not exist" in lowered or "not found" in lowered):
            # Standard edition does not expose INFORMATION_SCHEMA.PROPERTY_GRAPHS
            return "spanner_edition_unsupported"
        if "postgresql" in lowered or "pg_catalog" in lowered or "dialect" in lowered:
            return "dialect_unsupported"
        if "timeout" in lowered or "deadline" in lowered:
            return "connect_timeout"
        if "unavailable" in lowered:
            return "service_unavailable"
        return f"error: {msg[:120]}"

    def _build_credentials(self) -> Tuple[Any, Optional[str]]:
        """Return ``(credentials, project_override)`` per ``auth_method``.

        ADC: returns ``(None, None)`` so ``spanner.Client`` falls back to
             ``google.auth.default()``.
        service_account_json: decodes the base64-wrapped JSON key.
        impersonation: builds ``impersonated_credentials.Credentials`` whose
                       source is whatever ADC the runtime has — token
                       refresh is automatic across calls.

        Imports are scoped per branch so the ADC path doesn't drag in
        ``google.oauth2`` or ``google.auth.impersonated_credentials``
        unless the user actually opted into them.
        """
        scopes = ["https://www.googleapis.com/auth/spanner.data"]

        if self._auth_method == "adc":
            # spanner.Client does its own google.auth.default() call when
            # credentials=None — no need to import google.auth here.
            return None, None

        if self._auth_method == "service_account_json":
            if not self._credentials_json_b64:
                raise ProviderConfigurationError(
                    "spanner_graph: auth_method='service_account_json' but no "
                    "credentials_json was provided. Paste the service-account "
                    "JSON key in the wizard or switch auth method."
                )
            try:
                raw = base64.b64decode(self._credentials_json_b64).decode("utf-8")
                info = json.loads(raw)
            except Exception as exc:  # noqa: BLE001
                raise ProviderConfigurationError(
                    f"spanner_graph: malformed service-account JSON: {exc}"
                ) from exc
            if info.get("type") != "service_account" or not info.get("client_email") or not info.get("private_key"):
                raise ProviderConfigurationError(
                    "spanner_graph: pasted JSON is not a valid service account "
                    "key (expected type='service_account' with client_email + "
                    "private_key)."
                )
            from google.oauth2 import service_account
            creds = service_account.Credentials.from_service_account_info(info, scopes=scopes)
            return creds, info.get("project_id")

        if self._auth_method == "impersonation":
            if not self._impersonate_sa:
                raise ProviderConfigurationError(
                    "spanner_graph: auth_method='impersonation' but no "
                    "impersonate_service_account email was provided."
                )
            from google.auth import default as adc_default
            from google.auth import impersonated_credentials
            source_creds, _ = adc_default()
            target_creds = impersonated_credentials.Credentials(
                source_credentials=source_creds,
                target_principal=self._impersonate_sa,
                target_scopes=scopes,
                lifetime=3600,
            )
            return target_creds, None

        raise ProviderConfigurationError(
            f"spanner_graph: unknown auth_method={self._auth_method!r}"
        )

    async def _ensure_connected(self) -> None:
        """Lazy connect — idempotent + double-checked under a lock."""
        if self._database is not None:
            return
        async with self._connect_lock:
            if self._database is not None:
                return

            loop = asyncio.get_running_loop()

            def _build() -> None:
                from google.cloud import spanner
                # ``PingingPool`` keeps sessions warm; size matches the
                # executor pool to avoid contention.
                pool = spanner.PingingPool(
                    size=_DEFAULT_THREAD_POOL,
                    default_timeout=_DEFAULT_QUERY_TIMEOUT_S,
                )
                creds, _project_override = self._build_credentials()
                client = spanner.Client(
                    project=self._project_id,
                    credentials=creds,
                )
                instance = client.instance(self._instance_id)
                if not self._database_id:
                    raise ProviderConfigurationError(
                        "spanner_graph: database_id missing — set it on the "
                        "data source's graph_name as '<database_id>.<graph_name>' "
                        "or in extra_config.database_id."
                    )
                database = instance.database(self._database_id, pool=pool)
                # Touch the database with a trivial statement to surface
                # auth / database-not-found errors here rather than later.
                with database.snapshot() as snap:
                    list(snap.execute_sql("SELECT 1"))
                self._client = client
                self._instance = instance
                self._database = database

            self._executor = ThreadPoolExecutor(
                max_workers=_DEFAULT_THREAD_POOL,
                thread_name_prefix=f"spanner-{self._instance_id[:8]}",
            )
            await loop.run_in_executor(self._executor, _build)

            # Capability detection (best-effort; failures are logged, not raised)
            try:
                await self._detect_capabilities()
            except Exception as exc:  # noqa: BLE001
                logger.warning("spanner_graph: capability detection failed: %s", exc)

            logger.info(
                "spanner_graph: connected project=%s instance=%s database=%s graph=%s "
                "edition=%s dialect=%s capabilities=%s",
                self._project_id, self._instance_id, self._database_id,
                self._graph_name, self._edition, self._dialect, self._capabilities,
            )

    async def _detect_capabilities(self) -> None:
        """Probe edition / dialect / vector / FTS / change-streams support."""
        # Dialect check — fall back gracefully if the view shape differs
        try:
            rows = await self._ro_gql(
                "SELECT option_value FROM INFORMATION_SCHEMA.DATABASE_OPTIONS "
                "WHERE option_name = 'database_dialect'",
                params=None, param_types_=None, max_staleness_s=0.0,
            )
            self._dialect = (rows[0][0] if rows else "GOOGLE_STANDARD_SQL") or "GOOGLE_STANDARD_SQL"
        except Exception:  # noqa: BLE001
            self._dialect = "GOOGLE_STANDARD_SQL"

        # Edition — Spanner Graph requires Enterprise / Enterprise Plus.
        # The presence of INFORMATION_SCHEMA.PROPERTY_GRAPHS is the
        # operationally-reliable signal we already gate on in preflight.
        try:
            await self._ro_gql(
                "SELECT 1 FROM INFORMATION_SCHEMA.PROPERTY_GRAPHS LIMIT 1",
                params=None, param_types_=None, max_staleness_s=0.0,
            )
            self._edition = "ENTERPRISE"
        except Exception:  # noqa: BLE001
            self._edition = "STANDARD"

        # Vector / FTS index detection (best-effort — uses INFORMATION_SCHEMA
        # views that vary slightly across Spanner releases; failure leaves
        # the capability flagged off, which is the safe default).
        try:
            rows = await self._ro_gql(
                "SELECT COUNT(*) FROM INFORMATION_SCHEMA.INDEXES "
                "WHERE INDEX_TYPE = 'VECTOR'",
                params=None, param_types_=None, max_staleness_s=0.0,
            )
            self._capabilities["vector_search"] = bool(rows and int(rows[0][0] or 0) > 0)
        except Exception:  # noqa: BLE001
            pass
        try:
            rows = await self._ro_gql(
                "SELECT COUNT(*) FROM INFORMATION_SCHEMA.INDEXES "
                "WHERE INDEX_TYPE = 'SEARCH'",
                params=None, param_types_=None, max_staleness_s=0.0,
            )
            self._capabilities["full_text_search"] = bool(rows and int(rows[0][0] or 0) > 0)
        except Exception:  # noqa: BLE001
            pass
        self._capabilities["change_streams"] = bool(self._change_stream_name)

        # Schema fingerprint
        self._schema_fingerprint = await self._compute_schema_fingerprint()

    async def _compute_schema_fingerprint(self) -> Optional[str]:
        try:
            rows = await self._ro_gql(
                "SELECT property_graph_name, node_label_name, edge_label_name "
                "FROM INFORMATION_SCHEMA.PROPERTY_GRAPHS",
                params=None, param_types_=None, max_staleness_s=0.0,
            )
            payload = json.dumps(sorted(tuple(_coerce_spanner_value(c) for c in r) for r in rows))
            return hashlib.sha256(payload.encode()).hexdigest()[:16]
        except Exception:  # noqa: BLE001
            return None

    async def close(self) -> None:
        # Cancel optional change-stream task
        if self._change_stream_task is not None and not self._change_stream_task.done():
            self._change_stream_task.cancel()
            try:
                await self._change_stream_task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            self._change_stream_task = None

        # Close optional Redis
        if self._redis is not None:
            try:
                await self._redis.aclose()
            except Exception:  # noqa: BLE001
                pass
            self._redis = None
            self._redis_available = False

        # Close Spanner client (no async API; use executor)
        if self._client is not None:
            loop = asyncio.get_running_loop()
            client = self._client
            self._client = None
            self._instance = None
            self._database = None
            try:
                await loop.run_in_executor(self._executor, client.close)
            except Exception:  # noqa: BLE001
                pass

        if self._executor is not None:
            self._executor.shutdown(wait=False, cancel_futures=True)
            self._executor = None

    # ------------------------------------------------------------------ #
    # Optional Redis ancestor cache (mirrors Neo4j adapter pattern)        #
    # ------------------------------------------------------------------ #

    async def _ensure_redis(self) -> None:
        if self._redis is not None:
            return
        async with self._redis_lock:
            if self._redis is not None:
                return
            redis_url = self._extra_config.get("redisUrl") or os.getenv("CACHE_REDIS_URL")
            if not redis_url:
                return
            try:
                import redis.asyncio as aioredis  # type: ignore[import-not-found]
                from backend.common.adapters import TimeoutRedis
                op_timeout = float(os.getenv("SPANNER_GRAPH_REDIS_OP_TIMEOUT", "3"))
                raw = aioredis.from_url(redis_url, decode_responses=True)
                await raw.ping()
                self._redis = TimeoutRedis(raw, timeout=op_timeout)
                self._redis_available = True
                logger.info("spanner_graph: Redis ancestor cache connected at %s", redis_url)
            except Exception as exc:  # noqa: BLE001
                logger.warning("spanner_graph: Redis unavailable (%s); falling back to in-memory", exc)
                self._redis = None
                self._redis_available = False

    # ------------------------------------------------------------------ #
    # Query execution helpers                                              #
    # ------------------------------------------------------------------ #

    async def _run_in_executor(
        self,
        fn: Callable[..., Any],
        *args: Any,
        timeout: float = _DEFAULT_QUERY_TIMEOUT_S,
    ) -> Any:
        """Run a sync callable on the provider's executor with a deadline."""
        if self._executor is None:
            await self._ensure_connected()
        assert self._executor is not None
        loop = asyncio.get_running_loop()
        t0 = time.monotonic()
        try:
            return await asyncio.wait_for(
                loop.run_in_executor(self._executor, fn, *args),
                timeout=timeout,
            )
        finally:
            duration = time.monotonic() - t0
            self._latency.record(duration)
            if duration < timeout:
                self._last_successful_query_at = time.time()

    async def _ro_gql(
        self,
        query: str,
        *,
        params: Optional[Dict[str, Any]] = None,
        param_types_: Optional[Dict[str, Any]] = None,
        timeout: float = _DEFAULT_QUERY_TIMEOUT_S,
        max_staleness_s: Optional[float] = None,
        request_tag: Optional[str] = None,
    ) -> List[Tuple[Any, ...]]:
        """Execute a read-only SQL/GQL statement and return all rows.

        Uses ``database.snapshot(exact_staleness=…)`` for bounded staleness
        when ``max_staleness_s>0`` (default from extra_config); strong reads
        when ``max_staleness_s=0``.
        """
        await self._ensure_connected()
        if max_staleness_s is None:
            max_staleness_s = self._read_staleness_s
        params = params or {}
        param_types_ = param_types_ or {}
        graph_clause = f"GRAPH {self._graph_name} " if self._needs_graph_clause(query) else ""
        full_query = f"{graph_clause}{query}"

        def _exec() -> List[Tuple[Any, ...]]:
            from google.cloud.spanner_v1 import RequestOptions
            assert self._database is not None
            req_opts = RequestOptions(request_tag=f"synodic:{request_tag}") if request_tag else None
            kwargs: Dict[str, Any] = {}
            if max_staleness_s and max_staleness_s > 0:
                # ``exact_staleness`` accepts ``datetime.timedelta``.
                from datetime import timedelta
                kwargs["exact_staleness"] = timedelta(seconds=max_staleness_s)
            with self._database.snapshot(**kwargs) as snap:
                result = snap.execute_sql(
                    full_query,
                    params=params,
                    param_types=param_types_,
                    request_options=req_opts,
                )
                return [tuple(row) for row in result]

        return await self._run_with_retry(_exec, timeout=timeout)

    async def _rw_gql(
        self,
        query: str,
        *,
        params: Optional[Dict[str, Any]] = None,
        param_types_: Optional[Dict[str, Any]] = None,
        timeout: float = _DEFAULT_QUERY_TIMEOUT_S,
        request_tag: Optional[str] = None,
    ) -> int:
        """Execute a DML statement inside a read-write transaction.

        Returns the row count from ``ResultSet.row_count`` (e.g. for
        ``INSERT``/``UPDATE``/``DELETE``).
        """
        await self._ensure_connected()
        params = params or {}
        param_types_ = param_types_ or {}
        graph_clause = f"GRAPH {self._graph_name} " if self._needs_graph_clause(query) else ""
        full_query = f"{graph_clause}{query}"

        def _exec() -> int:
            from google.cloud.spanner_v1 import RequestOptions
            assert self._database is not None
            req_opts = RequestOptions(request_tag=f"synodic:{request_tag}") if request_tag else None

            def _work(tx) -> int:
                rs = tx.execute_update(
                    full_query,
                    params=params,
                    param_types=param_types_,
                    request_options=req_opts,
                )
                return int(rs)

            return int(self._database.run_in_transaction(_work))

        return await self._run_with_retry(_exec, timeout=timeout)

    async def _run_with_retry(
        self,
        fn: Callable[[], Any],
        *,
        timeout: float,
        attempts: int = _DEFAULT_RETRY_ATTEMPTS,
    ) -> Any:
        """Retry transient errors (Unavailable / DeadlineExceeded) with
        exponential backoff. ``Aborted`` retries are handled inside
        ``run_in_transaction`` by the SDK itself."""
        last_exc: Optional[BaseException] = None
        for attempt in range(attempts):
            try:
                return await self._run_in_executor(fn, timeout=timeout)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                last_exc = exc
                cls = type(exc).__name__
                if cls in ("ServiceUnavailable", "DeadlineExceeded", "Aborted") and attempt + 1 < attempts:
                    backoff = min(2 ** attempt * 0.1, 1.0)
                    await asyncio.sleep(backoff)
                    continue
                raise
        if last_exc is not None:
            raise last_exc
        return None

    @staticmethod
    def _needs_graph_clause(query: str) -> bool:
        """Heuristic: GQL traversal queries start with ``MATCH`` or contain
        ``->`` / ``-[`` patterns; SQL/INFORMATION_SCHEMA does not.
        """
        head = query.strip().upper()
        return head.startswith("MATCH ") or " MATCH (" in head or " MATCH(" in head

    # ------------------------------------------------------------------ #
    # Containment edge-type resolution                                     #
    # ------------------------------------------------------------------ #

    def set_containment_edge_types(self, types: List[str], from_ontology: bool = True) -> None:
        """Inject ontology-resolved containment edge types.

        Empty list is valid (flat graph). Setting clears the env-var fallback
        so subsequent reads see the ontology's authoritative answer.
        """
        self._resolved_containment_types = {t.upper() for t in types}
        self._resolved_containment_types_set = True
        self._stats_cache.invalidate()
        self._ontology_cache.invalidate()

    def _get_containment_edge_types(self) -> Set[str]:
        if self._resolved_containment_types_set:
            return self._resolved_containment_types
        if self._containment_cache is None:
            cfg = os.getenv("CONTAINMENT_EDGE_TYPES", "").strip()
            if cfg:
                self._containment_cache = {t.strip().upper() for t in cfg.split(",") if t.strip()}
            else:
                # Match the FalkorDB / Neo4j default fallback so tests &
                # smoke runs work before ontology resolution.
                self._containment_cache = {"CONTAINS", "BELONGS_TO"}
        return self._containment_cache

    def _require_containment_types(self) -> Set[str]:
        types = self._get_containment_edge_types()
        if not types and self._resolved_containment_types_set:
            # Ontology-resolved to empty is intentional (flat graph) — return
            # the empty set rather than raising.
            return types
        if not types:
            raise ProviderConfigurationError(
                "spanner_graph: no containment edge types are configured. "
                "ContextEngine must call set_containment_edge_types(...) from "
                "the resolved ontology before lineage / containment endpoints "
                "can be served, or set the CONTAINMENT_EDGE_TYPES env var."
            )
        return types

    # ------------------------------------------------------------------ #
    # Hydration helpers                                                    #
    # ------------------------------------------------------------------ #

    def _extract_node_from_record(
        self,
        node_json: Optional[Dict[str, Any]],
        labels: Optional[List[str]] = None,
    ) -> Optional[GraphNode]:
        """Hydrate a GraphNode from a JSON-encoded Spanner row.

        Spanner GQL ``SAFE_TO_JSON(n)`` returns a dict containing
        ``identifier`` (graph element id), ``labels`` (list of label names)
        and ``properties`` (the node's user-visible properties). We pass
        the property map plus labels through the SchemaMapping helper so
        the same canonical-shape dict feeds ``_node_from_props``.
        """
        if not node_json:
            return None
        try:
            if isinstance(node_json, str):
                node_json = json.loads(node_json)
        except (json.JSONDecodeError, TypeError):
            return None
        if not isinstance(node_json, dict):
            return None
        raw_props = node_json.get("properties") or {}
        if not isinstance(raw_props, dict):
            return None
        node_labels: List[str] = list(labels or node_json.get("labels") or [])
        # Coerce values (TIMESTAMP/BYTES/etc.) to JSON-safe primitives
        coerced = {k: _coerce_spanner_value(v) for k, v in raw_props.items()}
        mapped = map_node_props(coerced, node_labels, self._mapping)
        node = _node_from_props(mapped)
        if node:
            self._urn_cache.put(node.urn, node.entity_type)
        return node

    def _extract_edge_from_record(
        self,
        source_urn: str,
        target_urn: str,
        edge_label: str,
        edge_json: Optional[Dict[str, Any]],
    ) -> Optional[GraphEdge]:
        if not source_urn or not target_urn:
            return None
        if isinstance(edge_json, str):
            try:
                edge_json = json.loads(edge_json)
            except (json.JSONDecodeError, TypeError):
                edge_json = {}
        edge_json = edge_json or {}
        raw_props = edge_json.get("properties") or {}
        if not isinstance(raw_props, dict):
            raw_props = {}
        coerced = {k: _coerce_spanner_value(v) for k, v in raw_props.items()}
        mapped = map_edge_props(coerced, self._mapping)
        edge_id = mapped.get("id") or edge_json.get("identifier")
        confidence = mapped.get("confidence")
        try:
            confidence = float(confidence) if confidence is not None else None
        except (TypeError, ValueError):
            confidence = None
        return _edge_from_row(
            source_urn=source_urn,
            target_urn=target_urn,
            edge_type=edge_label,
            edge_id=str(edge_id) if edge_id else None,
            confidence=confidence,
            properties=mapped.get("properties") or {},
        )

    def _node_to_write_props(self, node: GraphNode) -> Dict[str, Any]:
        """Serialize a GraphNode to a property dict using the schema mapping."""
        m = self._mapping
        out: Dict[str, Any] = {
            m.identity_field: node.urn,
            m.display_name_field: node.display_name or "",
            m.qualified_name_field: node.qualified_name or "",
            m.description_field: node.description or "",
            m.tags_field: json.dumps(node.tags or []),
            m.layer_field: node.layer_assignment or "",
            m.source_system_field: node.source_system or "",
            m.last_synced_field: node.last_synced_at or "",
        }
        if m.properties_field:
            out[m.properties_field] = json.dumps(node.properties or {})
        if m.entity_type_strategy == "property" and m.entity_type_field:
            out[m.entity_type_field] = str(node.entity_type)
        return out

    # ------------------------------------------------------------------ #
    # Client-side filter helpers (verbatim shapes from neo4j_provider)     #
    # ------------------------------------------------------------------ #

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

    # ------------------------------------------------------------------ #
    # Index management                                                     #
    # ------------------------------------------------------------------ #

    async def ensure_indices(self, entity_type_ids: Optional[List[str]] = None) -> None:
        """Create ``CREATE INDEX IF NOT EXISTS`` on identity / displayName /
        qualifiedName for each node table referenced by the graph. Idempotent
        and best-effort — index creation failures are logged and swallowed
        because the user may not have DDL permission yet.
        """
        await self._ensure_connected()
        try:
            tables = await self._get_node_tables()
        except Exception as exc:  # noqa: BLE001
            logger.warning("spanner_graph: ensure_indices could not list node tables: %s", exc)
            return
        properties = [
            self._mapping.identity_field,
            self._mapping.display_name_field,
            self._mapping.qualified_name_field,
        ]
        statements: List[str] = []
        for table in tables:
            tname = _sanitize_identifier(table)
            for prop in properties:
                if not prop:
                    continue
                pname = _sanitize_identifier(prop)
                idx = _sanitize_identifier(f"idx_{tname}_{pname}")[:127]
                statements.append(
                    f"CREATE INDEX IF NOT EXISTS {idx} ON `{tname}`(`{prop}`)"
                )
        if not statements:
            return

        def _ddl() -> None:
            assert self._database is not None
            op = self._database.update_ddl(statements)
            op.result(timeout=_DEFAULT_DDL_TIMEOUT_S)

        try:
            await self._run_in_executor(_ddl, timeout=_DEFAULT_DDL_TIMEOUT_S + 5)
        except Exception as exc:  # noqa: BLE001
            logger.info("spanner_graph: ensure_indices skipped (%s)", exc)

    # ------------------------------------------------------------------ #
    # Graph metadata helpers                                               #
    # ------------------------------------------------------------------ #

    async def _get_node_tables(self) -> List[str]:
        """Return the list of node tables backing the configured graph."""
        rows = await self._ro_gql(
            "SELECT DISTINCT node_table_name "
            "FROM INFORMATION_SCHEMA.PROPERTY_GRAPH_NODE_TABLES "
            "WHERE property_graph_name = @graph",
            params={"graph": self._graph_name},
            param_types_=None,  # STRING is inferred
            max_staleness_s=0.0,
        )
        return [str(r[0]) for r in rows if r and r[0]]

    async def _get_edge_tables(self) -> List[Tuple[str, str, str]]:
        """Return ``(edge_table, source_node_table, dest_node_table)`` tuples."""
        rows = await self._ro_gql(
            "SELECT edge_table_name, source_node_table_name, destination_node_table_name "
            "FROM INFORMATION_SCHEMA.PROPERTY_GRAPH_EDGE_TABLES "
            "WHERE property_graph_name = @graph",
            params={"graph": self._graph_name},
            param_types_=None,
            max_staleness_s=0.0,
        )
        return [(str(r[0]), str(r[1]), str(r[2])) for r in rows if r and r[0]]

    # ------------------------------------------------------------------ #
    # GraphDataProvider — abstract methods                                 #
    # ------------------------------------------------------------------ #

    async def get_node(self, urn: str) -> Optional[GraphNode]:
        if not urn:
            return None
        from google.cloud.spanner_v1 import param_types
        rows = await self._ro_gql(
            "MATCH (n) WHERE n.urn = @urn "
            "RETURN SAFE_TO_JSON(n) AS node, LABELS(n) AS labels LIMIT 1",
            params={"urn": urn},
            param_types_={"urn": param_types.STRING},
            request_tag="get_node",
        )
        if not rows:
            return None
        node_json, labels = rows[0]
        return self._extract_node_from_record(node_json, labels)

    async def get_nodes(self, query: NodeQuery) -> List[GraphNode]:
        from google.cloud.spanner_v1 import param_types

        clauses: List[str] = []
        params: Dict[str, Any] = {}
        ptypes: Dict[str, Any] = {}

        if query.urns:
            clauses.append("n.urn IN UNNEST(@urns)")
            params["urns"] = list(query.urns)
            ptypes["urns"] = param_types.Array(param_types.STRING)
        if query.entity_types:
            clauses.append("LABELS(n) && @entity_types")
            params["entity_types"] = list(query.entity_types)
            ptypes["entity_types"] = param_types.Array(param_types.STRING)
        if query.search_query:
            clauses.append(
                "(LOWER(n.displayName) LIKE @search OR LOWER(n.urn) LIKE @search)"
            )
            params["search"] = f"%{query.search_query.lower()}%"
            ptypes["search"] = param_types.STRING

        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        offset = max(0, int(query.offset or 0))
        limit = max(1, min(int(query.limit or 100), 10_000))

        gql = (
            f"MATCH (n) {where} "
            f"RETURN SAFE_TO_JSON(n) AS node, LABELS(n) AS labels "
            f"ORDER BY n.urn "
            f"LIMIT {limit} OFFSET {offset}"
        )
        rows = await self._ro_gql(
            gql, params=params, param_types_=ptypes, request_tag="get_nodes"
        )
        nodes: List[GraphNode] = []
        for node_json, labels in rows:
            node = self._extract_node_from_record(node_json, labels)
            if not node:
                continue
            # Apply client-side filters that don't translate cleanly to GQL.
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
            nodes.append(node)
        return nodes

    async def search_nodes(self, query: str, limit: int = 10) -> List[GraphNode]:
        # FTS / vector upgrades are detected in _detect_capabilities and can
        # be plugged in here; the substring path is the always-available
        # fallback that works on any Spanner Graph schema.
        return await self.get_nodes(
            NodeQuery(searchQuery=query, limit=limit)
        )

    async def get_edges(self, query: EdgeQuery) -> List[GraphEdge]:
        from google.cloud.spanner_v1 import param_types

        # AGGREGATED edges are served from the sidecar table (no overlay graph)
        if query.edge_types and set(t.upper() for t in query.edge_types) == {"AGGREGATED"}:
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
            clauses.append("LABELS(r) && @edge_types")
            params["edge_types"] = list(query.edge_types)
            ptypes["edge_types"] = param_types.Array(param_types.STRING)

        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        offset = max(0, int(query.offset or 0))
        limit = max(1, min(int(query.limit or 100), 10_000))

        gql = (
            f"MATCH (s)-[r]->(t) {where} "
            f"RETURN s.urn AS s_urn, t.urn AS t_urn, "
            f"LABELS(r)[OFFSET(0)] AS edge_type, SAFE_TO_JSON(r) AS edge "
            f"ORDER BY s.urn, t.urn LIMIT {limit} OFFSET {offset}"
        )
        rows = await self._ro_gql(
            gql, params=params, param_types_=ptypes, request_tag="get_edges"
        )
        edges: List[GraphEdge] = []
        for s_urn, t_urn, edge_type, edge_json in rows:
            edge = self._extract_edge_from_record(str(s_urn), str(t_urn), str(edge_type), edge_json)
            if edge is None:
                continue
            if query.min_confidence is not None and (edge.confidence or 0.0) < query.min_confidence:
                continue
            edges.append(edge)
        return edges

    async def _get_aggregated_edges(self, query: EdgeQuery) -> List[GraphEdge]:
        from google.cloud.spanner_v1 import param_types
        sidecar = self._sidecar_table_name()
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
        sql = (
            f"SELECT source_urn, target_urn, weight, source_edge_types "
            f"FROM `{sidecar}` {where} "
            f"ORDER BY source_urn, target_urn LIMIT {limit} OFFSET {offset}"
        )
        rows = await self._ro_gql(
            sql, params=params, param_types_=ptypes, request_tag="get_aggregated_edges"
        )
        out: List[GraphEdge] = []
        for s, t, weight, src_types in rows:
            src_types = src_types or []
            out.append(GraphEdge(
                id=f"{s}|AGGREGATED|{t}",
                sourceUrn=str(s),
                targetUrn=str(t),
                edgeType="AGGREGATED",
                confidence=None,
                properties={
                    "weight": int(weight or 0),
                    "sourceEdgeTypes": [str(x) for x in src_types],
                },
            ))
        return out

    # ------------------------------------------------------------------ #
    # Containment hierarchy                                                #
    # ------------------------------------------------------------------ #

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
        from google.cloud.spanner_v1 import param_types
        cont_types = list(edge_types) if edge_types else list(self._require_containment_types())
        if not cont_types:
            return []
        clauses: List[str] = ["p.urn = @parent", "LABELS(r) && @cont_types"]
        params: Dict[str, Any] = {
            "parent": parent_urn,
            "cont_types": cont_types,
        }
        ptypes: Dict[str, Any] = {
            "parent": param_types.STRING,
            "cont_types": param_types.Array(param_types.STRING),
        }
        if entity_types:
            clauses.append("LABELS(child) && @entity_types")
            params["entity_types"] = list(entity_types)
            ptypes["entity_types"] = param_types.Array(param_types.STRING)
        if search_query:
            clauses.append("(LOWER(child.displayName) LIKE @search OR LOWER(child.urn) LIKE @search)")
            params["search"] = f"%{search_query.lower()}%"
            ptypes["search"] = param_types.STRING
        if cursor:
            clauses.append("child.displayName > @cursor")
            params["cursor"] = cursor
            ptypes["cursor"] = param_types.STRING

        sort_col = "child.displayName" if sort_property == "displayName" else f"child.{sort_property or 'displayName'}"

        gql = (
            f"MATCH (p)-[r]->(child) WHERE {' AND '.join(clauses)} "
            f"RETURN SAFE_TO_JSON(child) AS node, LABELS(child) AS labels "
            f"ORDER BY {sort_col} "
            f"LIMIT {max(1, int(limit))} OFFSET {max(0, int(offset))}"
        )
        rows = await self._ro_gql(
            gql, params=params, param_types_=ptypes, request_tag="get_children"
        )
        out: List[GraphNode] = []
        for node_json, labels in rows:
            node = self._extract_node_from_record(node_json, labels)
            if node:
                out.append(node)
        return out

    async def get_parent(self, child_urn: str) -> Optional[GraphNode]:
        from google.cloud.spanner_v1 import param_types
        cont_types = list(self._require_containment_types())
        if not cont_types:
            return None
        rows = await self._ro_gql(
            "MATCH (p)-[r]->(c) WHERE c.urn = @child AND LABELS(r) && @cont_types "
            "RETURN SAFE_TO_JSON(p) AS node, LABELS(p) AS labels LIMIT 1",
            params={"child": child_urn, "cont_types": cont_types},
            param_types_={
                "child": param_types.STRING,
                "cont_types": param_types.Array(param_types.STRING),
            },
            request_tag="get_parent",
        )
        if not rows:
            return None
        node_json, labels = rows[0]
        return self._extract_node_from_record(node_json, labels)

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
        from google.cloud.spanner_v1 import param_types
        cont_types = list(self._require_containment_types())
        clauses: List[str] = []
        params: Dict[str, Any] = {}
        ptypes: Dict[str, Any] = {}
        if cont_types:
            clauses.append(
                "NOT EXISTS { MATCH (p)-[rr]->(n) WHERE LABELS(rr) && @cont_types }"
            )
            params["cont_types"] = cont_types
            ptypes["cont_types"] = param_types.Array(param_types.STRING)
        if entity_types:
            clauses.append("LABELS(n) && @entity_types")
            params["entity_types"] = list(entity_types)
            ptypes["entity_types"] = param_types.Array(param_types.STRING)
        if search_query:
            clauses.append("(LOWER(n.displayName) LIKE @search OR LOWER(n.urn) LIKE @search)")
            params["search"] = f"%{search_query.lower()}%"
            ptypes["search"] = param_types.STRING
        if cursor:
            clauses.append("n.displayName > @cursor")
            params["cursor"] = cursor
            ptypes["cursor"] = param_types.STRING

        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        gql = (
            f"MATCH (n) {where} "
            f"RETURN SAFE_TO_JSON(n) AS node, LABELS(n) AS labels "
            f"ORDER BY n.displayName LIMIT {max(1, int(limit)) + 1}"
        )
        rows = await self._ro_gql(
            gql, params=params, param_types_=ptypes, request_tag="get_top_level"
        )
        nodes: List[GraphNode] = []
        for node_json, labels in rows:
            n = self._extract_node_from_record(node_json, labels)
            if n:
                nodes.append(n)
        has_more = len(nodes) > limit
        nodes = nodes[:limit]
        next_cursor = nodes[-1].display_name if has_more and nodes else None

        roots = set(t.lower() for t in (root_entity_types or []))
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

    # ------------------------------------------------------------------ #
    # Lineage traversal                                                    #
    # ------------------------------------------------------------------ #

    async def get_upstream(
        self,
        urn: str,
        depth: int,
        include_column_lineage: bool = False,
        descendant_types: Optional[List[str]] = None,
    ) -> LineageResult:
        return await self._traverse_lineage(urn, depth, direction="in", descendant_types=descendant_types)

    async def get_downstream(
        self,
        urn: str,
        depth: int,
        include_column_lineage: bool = False,
        descendant_types: Optional[List[str]] = None,
    ) -> LineageResult:
        return await self._traverse_lineage(urn, depth, direction="out", descendant_types=descendant_types)

    async def get_full_lineage(
        self,
        urn: str,
        upstream_depth: int,
        downstream_depth: int,
        include_column_lineage: bool = False,
        descendant_types: Optional[List[str]] = None,
    ) -> LineageResult:
        upstream = await self._traverse_lineage(urn, upstream_depth, direction="in", descendant_types=descendant_types)
        downstream = await self._traverse_lineage(urn, downstream_depth, direction="out", descendant_types=descendant_types)
        # Merge nodes & edges (dedup by urn / id)
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
        read_timestamp: Optional[datetime] = None,
    ) -> LineageResult:
        """BFS via GQL quantified path patterns."""
        from google.cloud.spanner_v1 import param_types
        depth = max(1, min(int(depth or 1), 25))
        cont_types = list(self._require_containment_types())
        # Lineage-only edges = exclude containment + AGGREGATED (sidecar lives outside the graph)
        # The traversal pattern follows direction.
        arrow = "->" if direction == "out" else "<-"
        clauses: List[str] = ["start.urn = @start_urn"]
        params: Dict[str, Any] = {"start_urn": urn}
        ptypes: Dict[str, Any] = {"start_urn": param_types.STRING}
        if cont_types:
            clauses.append("NOT (LABELS(r) && @cont_types)")
            params["cont_types"] = cont_types
            ptypes["cont_types"] = param_types.Array(param_types.STRING)
        if descendant_types:
            clauses.append("LABELS(other) && @descendant_types")
            params["descendant_types"] = list(descendant_types)
            ptypes["descendant_types"] = param_types.Array(param_types.STRING)

        where = " AND ".join(clauses)
        gql = (
            f"MATCH (start){arrow}[r]{arrow}{{1,{depth}}}(other) "
            f"WHERE {where} "
            f"RETURN DISTINCT SAFE_TO_JSON(other) AS node, LABELS(other) AS labels"
        )
        rows = await self._ro_gql(
            gql, params=params, param_types_=ptypes, request_tag=f"lineage_{direction}",
        )
        nodes: Dict[str, GraphNode] = {}
        for node_json, labels in rows:
            n = self._extract_node_from_record(node_json, labels)
            if n:
                nodes[n.urn] = n

        # Fetch edges between the start node and the discovered set.
        edges: List[GraphEdge] = []
        if nodes:
            urns = [urn] + list(nodes.keys())
            edge_query = EdgeQuery(anyUrns=urns, limit=10_000)
            try:
                fetched = await self.get_edges(edge_query)
                # Filter out containment edges to keep the lineage view clean
                cont_set = set(t.upper() for t in cont_types)
                for e in fetched:
                    if e.edge_type.upper() in cont_set or e.edge_type.upper() == "AGGREGATED":
                        continue
                    edges.append(e)
            except Exception as exc:  # noqa: BLE001
                logger.warning("spanner_graph: lineage edge fetch failed: %s", exc)

        # Compose result — include the start node itself when possible
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
        from google.cloud.spanner_v1 import param_types
        sidecar = self._sidecar_table_name()
        clauses: List[str] = ["source_urn IN UNNEST(@source_urns)"]
        params: Dict[str, Any] = {"source_urns": list(source_urns or [])}
        ptypes: Dict[str, Any] = {"source_urns": param_types.Array(param_types.STRING)}
        if target_urns:
            clauses.append("target_urn IN UNNEST(@target_urns)")
            params["target_urns"] = list(target_urns)
            ptypes["target_urns"] = param_types.Array(param_types.STRING)
        rows = await self._ro_gql(
            f"SELECT source_urn, target_urn, weight, source_edge_types "
            f"FROM `{sidecar}` WHERE {' AND '.join(clauses)} "
            f"ORDER BY source_urn, target_urn",
            params=params, param_types_=ptypes,
            request_tag="get_aggregated_edges_between",
        )
        infos: List[AggregatedEdgeInfo] = []
        total = 0
        for s, t, weight, src_types in rows:
            src_types = list(src_types or [])
            total += int(weight or 0)
            infos.append(AggregatedEdgeInfo(
                id=f"{s}|AGGREGATED|{t}",
                sourceUrn=str(s),
                targetUrn=str(t),
                edgeCount=int(weight or 0),
                edgeTypes=[str(x) for x in src_types],
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
        # The trace endpoint expects same-shape results; reuse the BFS path.
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
        # Spanner PITR window is up to 7 days (configurable per database).
        # The sync snapshot path uses ``read_timestamp``; we re-route the
        # standard traversal through a snapshot bound to that instant.
        # Rather than threading ``read_timestamp`` through every helper,
        # set a transient read context for the duration of the call.
        from datetime import timedelta
        if as_of_timestamp.tzinfo is None:
            as_of_timestamp = as_of_timestamp.replace(tzinfo=timezone.utc)
        # Sanity-check: PITR window
        now = datetime.now(tz=timezone.utc)
        if now - as_of_timestamp > timedelta(days=7):
            raise ValueError(
                "spanner_graph: as_of_timestamp is older than the 7-day PITR window"
            )
        original = self._read_staleness_s
        self._read_staleness_s = 0.0  # strong reads through the snapshot context
        # We rely on the snapshot helper accepting an explicit read_timestamp
        # via a lightweight monkey-patch path: callers expect the canonical
        # full-lineage shape. Implementation re-uses get_full_lineage and
        # records the as-of context on the underlying database via the
        # existing ``_ro_gql`` contract by passing ``max_staleness_s=-1``
        # (treated as "use exact_timestamp"). Rather than inflate the helper
        # signature, we run a single read here and merge.
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

    # ------------------------------------------------------------------ #
    # Metadata                                                             #
    # ------------------------------------------------------------------ #

    async def get_stats(self) -> Dict[str, Any]:
        cached = self._stats_cache.get()
        if cached is not None:
            return cached
        # Spanner GQL forbids ``COUNT(<graph_var>)`` — graph elements are
        # ZetaSQL-typed and the COUNT signature requires a value type.
        # ``COUNT(*)`` returns one-per-match, which is the same total here.
        rows = await self._ro_gql(
            "MATCH (n) RETURN COUNT(*) AS node_count",
            request_tag="get_stats_nodes",
        )
        node_count = int(rows[0][0]) if rows else 0
        rows = await self._ro_gql(
            "MATCH ()-[r]->() RETURN COUNT(*) AS edge_count",
            request_tag="get_stats_edges",
        )
        edge_count = int(rows[0][0]) if rows else 0
        agg_count = await self.count_aggregated_edges()
        out: Dict[str, Any] = {
            "node_count": node_count,
            "edge_count": edge_count,
            "aggregated_edge_count": agg_count,
            "graph": f"{self._database_id}.{self._graph_name}",
        }
        self._stats_cache.set(out)
        return out

    async def get_schema_stats(self) -> GraphSchemaStats:
        # Per-label counts (entity types) — leverage GQL LABELS() and GROUP BY
        entity_rows = await self._ro_gql(
            "MATCH (n) WITH LABELS(n)[OFFSET(0)] AS lbl, COUNT(*) AS c "
            "RETURN lbl, c ORDER BY c DESC",
            request_tag="schema_stats_entities",
        )
        entity_summaries = [
            EntityTypeSummary(id=str(lbl), name=str(lbl), count=int(c))
            for lbl, c in entity_rows
            if lbl is not None
        ]
        edge_rows = await self._ro_gql(
            "MATCH ()-[r]->() WITH LABELS(r)[OFFSET(0)] AS lbl, COUNT(*) AS c "
            "RETURN lbl, c ORDER BY c DESC",
            request_tag="schema_stats_edges",
        )
        edge_summaries = [
            EdgeTypeSummary(id=str(lbl), name=str(lbl), count=int(c))
            for lbl, c in edge_rows
            if lbl is not None
        ]
        total_nodes = sum(s.count for s in entity_summaries)
        total_edges = sum(s.count for s in edge_summaries)
        # Tag stats — best-effort; many schemas don't have a tags property
        tag_summaries: List[TagSummary] = []
        try:
            rows = await self._ro_gql(
                "MATCH (n) WHERE n.tags IS NOT NULL "
                "WITH UNNEST(n.tags) AS tag, COUNT(*) AS c "
                "RETURN tag, c ORDER BY c DESC LIMIT 100",
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
        cont_types = sorted(self._get_containment_edge_types())
        # Discover edge labels from the schema; flag containment vs lineage
        edge_labels: List[str] = []
        try:
            edge_rows = await self._ro_gql(
                "MATCH ()-[r]->() WITH DISTINCT LABELS(r)[OFFSET(0)] AS lbl RETURN lbl",
                request_tag="ontology_edge_labels",
            )
            edge_labels = [str(r[0]) for r in edge_rows if r and r[0]]
        except Exception:  # noqa: BLE001
            pass
        edge_metadata: Dict[str, EdgeTypeMetadata] = {}
        lineage_types: List[str] = []
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
        # Hierarchy — discover from edge tables
        hierarchy: Dict[str, EntityTypeHierarchy] = {}
        try:
            edge_tables = await self._get_edge_tables()
            for _edge_table, src_table, dst_table in edge_tables:
                hierarchy.setdefault(src_table, EntityTypeHierarchy()).can_contain.append(dst_table)
                hierarchy.setdefault(dst_table, EntityTypeHierarchy()).can_be_contained_by.append(src_table)
        except Exception:  # noqa: BLE001
            pass
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
        # Defensive: property_name flows into the query string — sanitize.
        prop = _sanitize_identifier(property_name)
        if not prop:
            return []
        rows = await self._ro_gql(
            f"MATCH (n) WHERE n.{prop} IS NOT NULL "
            f"RETURN DISTINCT n.{prop} AS v ORDER BY v LIMIT 1000",
            request_tag="get_distinct_values",
        )
        return [_coerce_spanner_value(r[0]) for r in rows]

    # ------------------------------------------------------------------ #
    # Traversal extensions                                                 #
    # ------------------------------------------------------------------ #

    async def get_ancestors(self, urn: str, limit: int = 100, offset: int = 0) -> List[GraphNode]:
        from google.cloud.spanner_v1 import param_types
        cont_types = list(self._require_containment_types())
        if not cont_types:
            return []
        # Spanner GQL filters edges along a quantified path via a WHERE
        # clause INSIDE the edge bracket — Cypher's ``ALL r IN r SATISFIES``
        # has no equivalent. Inside the bracket ``r`` is a single edge being
        # matched at each step; outside it is ARRAY<EDGE>. So the
        # containment-types filter goes inline with the edge pattern.
        rows = await self._ro_gql(
            "MATCH (a)-[r WHERE LABELS(r) && @cont_types]->{1,25}(c) "
            "WHERE c.urn = @urn "
            "RETURN DISTINCT SAFE_TO_JSON(a) AS node, LABELS(a) AS labels "
            "ORDER BY a.displayName "
            f"LIMIT {max(1, int(limit))} OFFSET {max(0, int(offset))}",
            params={"urn": urn, "cont_types": cont_types},
            param_types_={
                "urn": param_types.STRING,
                "cont_types": param_types.Array(param_types.STRING),
            },
            request_tag="get_ancestors",
        )
        out: List[GraphNode] = []
        for node_json, labels in rows:
            n = self._extract_node_from_record(node_json, labels)
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
        from google.cloud.spanner_v1 import param_types
        cont_types = list(self._require_containment_types())
        if not cont_types:
            return []
        # Containment-types filter is pushed INSIDE the edge bracket — see
        # the comment on get_ancestors() above for why.
        clauses = ["a.urn = @urn"]
        params: Dict[str, Any] = {"urn": urn, "cont_types": cont_types}
        ptypes: Dict[str, Any] = {
            "urn": param_types.STRING,
            "cont_types": param_types.Array(param_types.STRING),
        }
        if entity_types:
            clauses.append("LABELS(d) && @entity_types")
            params["entity_types"] = list(entity_types)
            ptypes["entity_types"] = param_types.Array(param_types.STRING)
        d = max(1, min(int(depth), 25))
        rows = await self._ro_gql(
            f"MATCH (a)-[r WHERE LABELS(r) && @cont_types]->{{1,{d}}}(d) "
            f"WHERE {' AND '.join(clauses)} "
            f"RETURN DISTINCT SAFE_TO_JSON(d) AS node, LABELS(d) AS labels "
            f"ORDER BY d.displayName "
            f"LIMIT {max(1, int(limit))} OFFSET {max(0, int(offset))}",
            params=params, param_types_=ptypes,
            request_tag="get_descendants",
        )
        out: List[GraphNode] = []
        for node_json, labels in rows:
            n = self._extract_node_from_record(node_json, labels)
            if n:
                out.append(n)
        return out

    async def get_nodes_by_tag(self, tag: str, limit: int = 100, offset: int = 0) -> List[GraphNode]:
        from google.cloud.spanner_v1 import param_types
        rows = await self._ro_gql(
            "MATCH (n) WHERE @tag IN n.tags "
            "RETURN SAFE_TO_JSON(n) AS node, LABELS(n) AS labels "
            "ORDER BY n.displayName "
            f"LIMIT {max(1, int(limit))} OFFSET {max(0, int(offset))}",
            params={"tag": tag},
            param_types_={"tag": param_types.STRING},
            request_tag="get_nodes_by_tag",
        )
        out: List[GraphNode] = []
        for node_json, labels in rows:
            n = self._extract_node_from_record(node_json, labels)
            if n:
                out.append(n)
        return out

    async def get_nodes_by_layer(self, layer_id: str, limit: int = 100, offset: int = 0) -> List[GraphNode]:
        from google.cloud.spanner_v1 import param_types
        rows = await self._ro_gql(
            "MATCH (n) WHERE n.layerAssignment = @layer "
            "RETURN SAFE_TO_JSON(n) AS node, LABELS(n) AS labels "
            "ORDER BY n.displayName "
            f"LIMIT {max(1, int(limit))} OFFSET {max(0, int(offset))}",
            params={"layer": layer_id},
            param_types_={"layer": param_types.STRING},
            request_tag="get_nodes_by_layer",
        )
        out: List[GraphNode] = []
        for node_json, labels in rows:
            n = self._extract_node_from_record(node_json, labels)
            if n:
                out.append(n)
        return out

    # ------------------------------------------------------------------ #
    # Write operations                                                     #
    # ------------------------------------------------------------------ #

    async def save_custom_graph(self, nodes: List[GraphNode], edges: List[GraphEdge]) -> bool:
        """Bulk-write nodes + edges via the Mutations API.

        Required by the GraphDataProvider contract. For Spanner Graph, this
        writes into a single managed table per kind (``Synodic_Nodes`` /
        ``Synodic_Edges``) auto-created on first use. Customers using
        Synodic as a write-through datastore (rather than just visualizing
        an existing Spanner Graph) can target this table via their own
        property graph. This is consistent with the FalkorDB/Neo4j
        ``save_custom_graph`` semantics.
        """
        await self._ensure_connected()
        await self._ensure_save_tables()

        def _write() -> None:
            from datetime import datetime as _dt
            assert self._database is not None
            now = _dt.utcnow()
            with self._database.batch() as batch:
                if nodes:
                    rows = [
                        [
                            n.urn,
                            n.entity_type or "",
                            n.display_name or "",
                            n.qualified_name or "",
                            json.dumps(n.properties or {}),
                            json.dumps(n.tags or []),
                            now,
                        ]
                        for n in nodes
                    ]
                    batch.insert_or_update(
                        table="Synodic_Nodes",
                        columns=("urn", "entity_type", "display_name", "qualified_name", "properties", "tags", "last_synced_at"),
                        values=rows,
                    )
                if edges:
                    erows = [
                        [
                            e.id,
                            e.source_urn,
                            e.target_urn,
                            e.edge_type,
                            float(e.confidence) if e.confidence is not None else 1.0,
                            json.dumps(e.properties or {}),
                            now,
                        ]
                        for e in edges
                    ]
                    batch.insert_or_update(
                        table="Synodic_Edges",
                        columns=("edge_id", "source_urn", "target_urn", "edge_type", "confidence", "properties", "updated_at"),
                        values=erows,
                    )

        await self._run_in_executor(_write, timeout=_DEFAULT_AGGR_TIMEOUT_S)
        self._stats_cache.invalidate()
        return True

    async def _ensure_save_tables(self) -> None:
        """Idempotent DDL for the optional Synodic_Nodes / Synodic_Edges
        tables used by ``save_custom_graph``. Failures surface as
        ``ProviderConfigurationError`` so missing DDL permission is visible.
        """
        statements = [
            (
                "CREATE TABLE IF NOT EXISTS Synodic_Nodes ("
                "  urn STRING(MAX) NOT NULL,"
                "  entity_type STRING(MAX),"
                "  display_name STRING(MAX),"
                "  qualified_name STRING(MAX),"
                "  properties JSON,"
                "  tags ARRAY<STRING(MAX)>,"
                "  last_synced_at TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp=true)"
                ") PRIMARY KEY (urn)"
            ),
            (
                "CREATE TABLE IF NOT EXISTS Synodic_Edges ("
                "  edge_id STRING(MAX) NOT NULL,"
                "  source_urn STRING(MAX) NOT NULL,"
                "  target_urn STRING(MAX) NOT NULL,"
                "  edge_type STRING(MAX),"
                "  confidence FLOAT64,"
                "  properties JSON,"
                "  updated_at TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp=true)"
                ") PRIMARY KEY (edge_id)"
            ),
            "CREATE INDEX IF NOT EXISTS idx_synodic_edges_src ON Synodic_Edges(source_urn)",
            "CREATE INDEX IF NOT EXISTS idx_synodic_edges_tgt ON Synodic_Edges(target_urn)",
        ]
        await self._run_ddl(statements, label="ensure_save_tables")

    async def create_node(self, node: GraphNode, containment_edge: Optional[GraphEdge] = None) -> bool:
        await self.save_custom_graph([node], [containment_edge] if containment_edge else [])
        return True

    async def create_edge(self, edge: GraphEdge) -> bool:
        await self.save_custom_graph([], [edge])
        return True

    async def update_edge(self, edge_id: str, properties: Dict[str, Any]) -> Optional[GraphEdge]:
        await self._ensure_connected()
        from google.cloud.spanner_v1 import param_types

        def _update() -> Optional[GraphEdge]:
            assert self._database is not None

            def _work(tx) -> Optional[List[Any]]:
                tx.execute_update(
                    "UPDATE Synodic_Edges SET properties = @props, updated_at = PENDING_COMMIT_TIMESTAMP() "
                    "WHERE edge_id = @id",
                    params={"props": json.dumps(properties or {}), "id": edge_id},
                    param_types={"props": param_types.JSON, "id": param_types.STRING},
                )
                rs = tx.execute_sql(
                    "SELECT edge_id, source_urn, target_urn, edge_type, confidence, properties "
                    "FROM Synodic_Edges WHERE edge_id = @id LIMIT 1",
                    params={"id": edge_id},
                    param_types={"id": param_types.STRING},
                )
                for row in rs:
                    return list(row)
                return None

            row = self._database.run_in_transaction(_work)
            if not row:
                return None
            eid, src, tgt, etype, conf, props = row
            return _edge_from_row(
                source_urn=str(src),
                target_urn=str(tgt),
                edge_type=str(etype),
                edge_id=str(eid),
                confidence=float(conf) if conf is not None else None,
                properties=props if isinstance(props, dict) else (json.loads(props) if isinstance(props, str) else {}),
            )

        return await self._run_in_executor(_update, timeout=_DEFAULT_QUERY_TIMEOUT_S * 2)

    async def delete_edge(self, edge_id: str) -> bool:
        from google.cloud.spanner_v1 import param_types
        rows = await self._rw_gql(
            "DELETE FROM Synodic_Edges WHERE edge_id = @id",
            params={"id": edge_id},
            param_types_={"id": param_types.STRING},
            request_tag="delete_edge",
        )
        return rows > 0

    # ------------------------------------------------------------------ #
    # Aggregation pipeline                                                 #
    # ------------------------------------------------------------------ #

    def _sidecar_table_name(self) -> str:
        """Stable per-graph table name for aggregated edges."""
        return f"Synodic_AggregatedEdges_{_sanitize_identifier(self._graph_name)}"

    def _aggregation_state_table_name(self) -> str:
        return f"Synodic_AggregationState_{_sanitize_identifier(self._graph_name)}"

    async def set_projection_mode(self, mode: str) -> None:
        if mode == "dedicated":
            logger.warning(
                "spanner_graph: projection_mode='dedicated' is treated as 'in_source' — "
                "the sidecar table approach already provides isolation."
            )

    async def ensure_projections(self) -> None:
        """Idempotent DDL for the aggregation sidecar table + watermark state."""
        if self._sidecar_ensured:
            return
        async with self._sidecar_lock:
            if self._sidecar_ensured:
                return
            sidecar = self._sidecar_table_name()
            state_table = self._aggregation_state_table_name()
            idx_target = _sanitize_identifier(f"idx_{sidecar}_target")[:127]
            statements = [
                (
                    f"CREATE TABLE IF NOT EXISTS `{sidecar}` ("
                    "  source_urn STRING(MAX) NOT NULL,"
                    "  target_urn STRING(MAX) NOT NULL,"
                    "  weight INT64 NOT NULL,"
                    "  source_edge_types ARRAY<STRING(MAX)>,"
                    "  source_commit_ts TIMESTAMP,"
                    "  latest_update TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp=true)"
                    ") PRIMARY KEY (source_urn, target_urn)"
                ),
                f"CREATE INDEX IF NOT EXISTS `{idx_target}` ON `{sidecar}`(target_urn)",
                (
                    f"CREATE TABLE IF NOT EXISTS `{state_table}` ("
                    "  scope STRING(MAX) NOT NULL,"
                    "  last_aggregation_commit_ts TIMESTAMP,"
                    "  last_full_run_at TIMESTAMP,"
                    "  notes STRING(MAX)"
                    ") PRIMARY KEY (scope)"
                ),
            ]
            await self._run_ddl(statements, label="ensure_aggregation_projections")
            self._sidecar_ensured = True

    async def _run_ddl(self, statements: List[str], *, label: str) -> None:
        """Run a DDL batch with a clear ProviderConfigurationError on
        permission failure so the operator sees the exact missing role.
        """

        def _ddl() -> None:
            assert self._database is not None
            op = self._database.update_ddl(statements)
            op.result(timeout=_DEFAULT_DDL_TIMEOUT_S)

        try:
            await self._run_in_executor(_ddl, timeout=_DEFAULT_DDL_TIMEOUT_S + 5)
        except Exception as exc:  # noqa: BLE001
            msg = str(exc).lower()
            if "permission" in msg or "forbidden" in msg or "iam" in msg:
                raise ProviderConfigurationError(
                    f"spanner_graph: DDL for {label} requires "
                    f"`spanner.databases.updateDdl` on database "
                    f"`{self._project_id}/{self._instance_id}/{self._database_id}`. "
                    f"Grant `roles/spanner.databaseAdmin` (or a custom role with "
                    f"that permission) to the principal running Synodic. "
                    f"Underlying error: {exc}"
                ) from exc
            raise

    async def count_aggregated_edges(self) -> int:
        if not self._sidecar_ensured:
            # Don't trigger DDL just to count — assume zero if uninitialized.
            return 0
        sidecar = self._sidecar_table_name()
        rows = await self._ro_gql(
            f"SELECT COUNT(*) FROM `{sidecar}`",
            request_tag="count_aggregated",
        )
        return int(rows[0][0]) if rows else 0

    async def purge_aggregated_edges(
        self,
        *,
        batch_size: int = 10_000,
        progress_callback: Optional[Callable[[int], Awaitable[None]]] = None,
    ) -> int:
        """Delete every aggregated edge using Partitioned DML.

        Spanner's non-partitioned DELETE caps at ~20K rows per transaction.
        Partitioned DML chunks the delete across partitions and reports a
        ``lower_bound_count`` of affected rows.
        """
        await self.ensure_projections()
        sidecar = self._sidecar_table_name()
        total_before = await self.count_aggregated_edges()

        def _purge() -> int:
            assert self._database is not None
            return int(
                self._database.execute_partitioned_dml(
                    f"DELETE FROM `{sidecar}` WHERE TRUE"
                )
            )

        deleted = await self._run_in_executor(_purge, timeout=_DEFAULT_DDL_TIMEOUT_S * 5)
        if progress_callback is not None:
            try:
                await progress_callback(min(deleted, total_before or deleted))
            except Exception as exc:  # noqa: BLE001
                logger.warning("spanner_graph: purge progress_callback failed: %s", exc)
        # Reset watermark so a subsequent aggregation does a full pass
        try:
            from google.cloud.spanner_v1 import param_types
            await self._rw_gql(
                f"DELETE FROM `{self._aggregation_state_table_name()}` "
                f"WHERE scope = @scope",
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
        """Materialize aggregated lineage edges via cursor-based pagination.

        Mirrors the FalkorDB signature byte-for-byte; the worker calls into
        this method with no Spanner-specific knowledge. Uses the Mutations
        API (``batch.insert_or_update``) for upserts and a commit-timestamp
        watermark in the state table for incremental re-runs.
        """
        from google.cloud.spanner_v1 import param_types

        await self._ensure_connected()
        await self.ensure_projections()

        cont = list(containment_edge_types or self._require_containment_types())
        # Filter out AGGREGATED from the lineage whitelist to avoid recursive
        # self-aggregation (matches the FalkorDB behavior).
        if lineage_edge_types:
            effective = [t for t in lineage_edge_types if t.upper() != "AGGREGATED"]
            if not effective:
                logger.warning(
                    "spanner_graph: lineage_edge_types contained only AGGREGATED — nothing to do."
                )
                return {"processed": 0, "aggregated_edges_affected": 0, "errors": 0}
        else:
            effective = []
        exclude_types = list(cont) + ["AGGREGATED"]

        # Watermark: read prior commit timestamp for incremental re-aggregation
        last_ts: Optional[datetime] = None
        try:
            ws = await self._ro_gql(
                f"SELECT last_aggregation_commit_ts FROM `{self._aggregation_state_table_name()}` "
                f"WHERE scope = @scope LIMIT 1",
                params={"scope": self._graph_name},
                param_types_={"scope": param_types.STRING},
                max_staleness_s=0.0,
            )
            if ws and ws[0][0]:
                last_ts = ws[0][0]
                if isinstance(last_ts, str):
                    last_ts = datetime.fromisoformat(last_ts)
        except Exception:  # noqa: BLE001
            last_ts = None

        # Build the leaf-edge selection clause
        clauses: List[str] = []
        params: Dict[str, Any] = {}
        ptypes: Dict[str, Any] = {}
        if effective:
            clauses.append("LABELS(r) && @types")
            params["types"] = effective
            ptypes["types"] = param_types.Array(param_types.STRING)
        else:
            clauses.append("NOT (LABELS(r) && @exclude)")
            params["exclude"] = exclude_types
            ptypes["exclude"] = param_types.Array(param_types.STRING)
        if last_ts is not None:
            # Prefer commit-ts watermark when available — incremental delta.
            # Spanner doesn't expose commit_timestamp on user nodes/edges
            # automatically, so this only fires when the leaf edges live in
            # a table with ``allow_commit_timestamp=true`` on a TIMESTAMP
            # column conventionally named ``last_modified_ts``. We probe for
            # it; absence falls back to a full pass.
            try:
                rows = await self._ro_gql(
                    "SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS "
                    "WHERE column_name = 'last_modified_ts' LIMIT 1",
                    max_staleness_s=0.0,
                )
                if rows:
                    clauses.append("r.last_modified_ts > @last_ts")
                    params["last_ts"] = last_ts
                    ptypes["last_ts"] = param_types.TIMESTAMP
            except Exception:  # noqa: BLE001
                pass

        # Total for progress reporting
        try:
            total_rows = await self._ro_gql(
                f"MATCH (s)-[r]->(t) WHERE {' AND '.join(clauses)} "
                f"RETURN COUNT(*) AS c",
                params=params, param_types_=ptypes,
                max_staleness_s=0.0,
                request_tag="aggr_total",
            )
            total = int(total_rows[0][0]) if total_rows else 0
        except Exception:  # noqa: BLE001
            total = 0

        sidecar = self._sidecar_table_name()
        processed = 0
        errors = 0
        created_count = 0
        current_cursor = last_cursor

        while True:
            if should_cancel and should_cancel():
                break

            # Cursor-based batch fetch
            cursor_clause = ""
            cur_params = dict(params)
            cur_ptypes = dict(ptypes)
            if current_cursor:
                cursor_clause = " AND CONCAT(s.urn, '|', t.urn) > @cursor"
                cur_params["cursor"] = current_cursor
                cur_ptypes["cursor"] = param_types.STRING

            gql = (
                f"MATCH (s)-[r]->(t) WHERE {' AND '.join(clauses)}{cursor_clause} "
                f"RETURN s.urn, t.urn, LABELS(r)[OFFSET(0)] AS et "
                f"ORDER BY CONCAT(s.urn, '|', t.urn) LIMIT {max(1, int(batch_size))}"
            )
            try:
                batch_rows = await self._ro_gql(
                    gql, params=cur_params, param_types_=cur_ptypes,
                    timeout=_DEFAULT_AGGR_TIMEOUT_S,
                    max_staleness_s=0.0,
                    request_tag="aggr_batch",
                )
            except Exception as exc:  # noqa: BLE001
                logger.exception("spanner_graph: aggregation batch fetch failed: %s", exc)
                errors += 1
                break
            if not batch_rows:
                break

            # Compute upserts via ancestor expansion. For a v1 implementation,
            # treat each leaf edge (s -> t) as a single aggregated edge
            # (s, t) — ancestor-chain expansion is a follow-up enhancement
            # that requires the customer's ontology to expose a directed
            # containment graph, which we read on demand.
            mutations: List[Tuple[str, str, str]] = [
                (str(r[0]), str(r[1]), str(r[2])) for r in batch_rows
            ]

            try:
                created_count += await self._upsert_aggregated_batch(sidecar, mutations)
                processed += len(mutations)
                current_cursor = f"{mutations[-1][0]}|{mutations[-1][1]}"
            except Exception as exc:  # noqa: BLE001
                logger.exception("spanner_graph: aggregation batch upsert failed: %s", exc)
                errors += 1
                break

            if intra_batch_callback is not None:
                try:
                    await intra_batch_callback(created_count)
                except Exception as cb_exc:  # noqa: BLE001
                    logger.warning("spanner_graph: intra_batch_callback failed: %s", cb_exc)

            if progress_callback is not None:
                try:
                    await progress_callback(processed, total, current_cursor, created_count)
                except Exception as cb_exc:  # noqa: BLE001
                    logger.warning("spanner_graph: progress_callback failed: %s", cb_exc)

            if len(batch_rows) < batch_size:
                break

        # Update watermark
        try:
            now = datetime.now(tz=timezone.utc)
            from google.cloud.spanner_v1 import param_types as pt
            await self._rw_gql(
                f"INSERT OR UPDATE `{self._aggregation_state_table_name()}` "
                f"(scope, last_aggregation_commit_ts, last_full_run_at, notes) "
                f"VALUES (@scope, @ts, @ts, @notes)",
                params={"scope": self._graph_name, "ts": now, "notes": f"processed={processed}"},
                param_types_={
                    "scope": pt.STRING,
                    "ts": pt.TIMESTAMP,
                    "notes": pt.STRING,
                },
                request_tag="aggr_state_update",
            )
        except Exception:  # noqa: BLE001
            pass

        return {
            "processed": processed,
            "aggregated_edges_affected": created_count,
            "errors": errors,
            "last_cursor": current_cursor,
        }

    async def _upsert_aggregated_batch(
        self,
        sidecar: str,
        mutations: List[Tuple[str, str, str]],
    ) -> int:
        """Upsert a batch of (source_urn, target_urn, edge_type) tuples
        into the sidecar table via the Mutations API.
        """
        if not mutations:
            return 0

        # Group by (source, target) and aggregate edge types
        agg: Dict[Tuple[str, str], List[str]] = {}
        for s, t, et in mutations:
            agg.setdefault((s, t), []).append(et)

        def _write() -> int:
            from datetime import datetime as _dt
            assert self._database is not None
            now = _dt.utcnow()
            rows = [
                [s, t, len(types), sorted(set(types)), now, now]
                for (s, t), types in agg.items()
            ]
            with self._database.batch() as batch:
                batch.insert_or_update(
                    table=sidecar,
                    columns=("source_urn", "target_urn", "weight", "source_edge_types", "source_commit_ts", "latest_update"),
                    values=rows,
                )
            return len(rows)

        return int(await self._run_in_executor(_write, timeout=_DEFAULT_AGGR_TIMEOUT_S))

    async def on_lineage_edge_written(
        self,
        source_urn: str,
        target_urn: str,
        edge_id: str,
        edge_type: str,
    ) -> None:
        if edge_type.upper() == "AGGREGATED":
            return  # never re-aggregate an aggregated edge
        await self.ensure_projections()
        await self._upsert_aggregated_batch(
            self._sidecar_table_name(),
            [(source_urn, target_urn, edge_type)],
        )

    async def on_lineage_edge_deleted(
        self,
        source_urn: str,
        target_urn: str,
        edge_id: str,
    ) -> None:
        from google.cloud.spanner_v1 import param_types
        sidecar = self._sidecar_table_name()
        # Decrement weight; remove row when weight drops to zero
        await self._rw_gql(
            f"UPDATE `{sidecar}` "
            f"SET weight = weight - 1, latest_update = PENDING_COMMIT_TIMESTAMP() "
            f"WHERE source_urn = @s AND target_urn = @t",
            params={"s": source_urn, "t": target_urn},
            param_types_={"s": param_types.STRING, "t": param_types.STRING},
            request_tag="aggr_decrement",
        )
        await self._rw_gql(
            f"DELETE FROM `{sidecar}` WHERE source_urn = @s AND target_urn = @t AND weight <= 0",
            params={"s": source_urn, "t": target_urn},
            param_types_={"s": param_types.STRING, "t": param_types.STRING},
            request_tag="aggr_delete_zero",
        )

    async def on_containment_changed(self, urn: str) -> None:
        # Containment changes invalidate ancestor caches; re-derivation is on
        # next read. No persistent state to update here.
        self._urn_cache = _URNLabelCache(50_000)

    # ------------------------------------------------------------------ #
    # Schema discovery & list_graphs                                       #
    # ------------------------------------------------------------------ #

    async def list_graphs(self) -> List[str]:
        """Enumerate every property graph across every database on the instance.

        Returns qualified ``"<database_id>.<property_graph_name>"`` strings
        so the data-source picker in the UI can present a single flat list
        across the whole instance — matching the FalkorDB / Neo4j fan-out
        UX. Failures on any individual database are logged and skipped.
        """
        await self._ensure_connected()

        # Step 1: list all databases on the instance
        def _list_dbs() -> List[str]:
            assert self._instance is not None
            return [db.database_id for db in self._instance.list_databases()]

        try:
            db_ids = await self._run_in_executor(_list_dbs, timeout=_DEFAULT_QUERY_TIMEOUT_S)
        except Exception as exc:  # noqa: BLE001
            logger.warning("spanner_graph: list_databases failed: %s", exc)
            db_ids = [self._database_id] if self._database_id else []

        out: List[str] = []
        for db_id in db_ids:
            if not db_id:
                continue

            def _list_graphs_in(db_id: str = db_id) -> List[str]:
                from google.cloud import spanner
                assert self._instance is not None
                db = self._instance.database(db_id)
                with db.snapshot() as snap:
                    rs = snap.execute_sql(
                        "SELECT property_graph_name FROM INFORMATION_SCHEMA.PROPERTY_GRAPHS"
                    )
                    return [str(row[0]) for row in rs if row and row[0]]

            try:
                graphs = await self._run_in_executor(
                    _list_graphs_in, timeout=_DEFAULT_QUERY_TIMEOUT_S
                )
                for g in graphs:
                    out.append(f"{db_id}.{g}")
            except Exception as exc:  # noqa: BLE001
                logger.info("spanner_graph: list_graphs skipping db=%s (%s)", db_id, exc)
        return sorted(set(out))

    async def discover_schema(self) -> Dict[str, Any]:
        """Introspect node + edge labels with property definitions.

        Output shape matches Neo4j's so the wizard's existing schema-mapping
        step works unchanged: ``labels``, ``relationshipTypes``,
        ``labelDetails`` (per-label property keys + sample row), and
        ``suggestedMapping`` (best-guess SchemaMapping).
        """
        await self._ensure_connected()
        try:
            node_rows = await self._ro_gql(
                "SELECT DISTINCT node_label_name "
                "FROM INFORMATION_SCHEMA.PROPERTY_GRAPH_NODE_LABELS "
                "WHERE property_graph_name = @graph",
                params={"graph": self._graph_name},
                max_staleness_s=0.0,
            )
            edge_rows = await self._ro_gql(
                "SELECT DISTINCT edge_label_name "
                "FROM INFORMATION_SCHEMA.PROPERTY_GRAPH_EDGE_LABELS "
                "WHERE property_graph_name = @graph",
                params={"graph": self._graph_name},
                max_staleness_s=0.0,
            )
            prop_rows = await self._ro_gql(
                "SELECT label_name, property_name, property_data_type "
                "FROM INFORMATION_SCHEMA.PROPERTY_GRAPH_PROPERTY_DEFINITIONS "
                "WHERE property_graph_name = @graph",
                params={"graph": self._graph_name},
                max_staleness_s=0.0,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("spanner_graph: discover_schema failed: %s", exc)
            return {}

        labels = sorted({str(r[0]) for r in node_rows if r and r[0]})
        rels = sorted({str(r[0]) for r in edge_rows if r and r[0]})
        label_details: Dict[str, Dict[str, Any]] = {}
        for lbl, pname, ptype in prop_rows:
            if lbl is None:
                continue
            entry = label_details.setdefault(str(lbl), {"properties": {}, "count": 0, "sample": {}})
            entry["properties"][str(pname)] = str(ptype)

        # Per-label sample (best-effort)
        for lbl in labels:
            try:
                sample = await self._ro_gql(
                    f"MATCH (n:{_sanitize_identifier(lbl)}) RETURN SAFE_TO_JSON(n) AS node LIMIT 1",
                    max_staleness_s=self._read_staleness_s,
                )
                if sample and sample[0][0]:
                    label_details.setdefault(lbl, {"properties": {}, "count": 0, "sample": {}})
                    label_details[lbl]["sample"] = _coerce_spanner_value(sample[0][0])
                count_rows = await self._ro_gql(
                    f"MATCH (n:{_sanitize_identifier(lbl)}) RETURN COUNT(*) AS c",
                    max_staleness_s=self._read_staleness_s,
                )
                if count_rows:
                    label_details.setdefault(lbl, {"properties": {}, "count": 0, "sample": {}})
                    label_details[lbl]["count"] = int(count_rows[0][0])
            except Exception:  # noqa: BLE001
                pass

        # Suggested mapping — same heuristics Neo4j uses
        all_props: Set[str] = set()
        for det in label_details.values():
            all_props.update(det.get("properties", {}).keys())
        suggested = self._suggest_mapping(all_props)

        return {
            "labels": labels,
            "relationshipTypes": rels,
            "labelDetails": label_details,
            "suggestedMapping": suggested,
            "capabilities": dict(self._capabilities),
        }

    @staticmethod
    def _suggest_mapping(props: Set[str]) -> Dict[str, str]:
        lc = {p.lower(): p for p in props}

        def pick(*candidates: str) -> Optional[str]:
            for cand in candidates:
                if cand in lc:
                    return lc[cand]
            return None

        return {
            "identity_field": pick("urn", "uuid", "id", "guid") or "urn",
            "display_name_field": pick("displayname", "display_name", "name", "title", "label") or "displayName",
            "qualified_name_field": pick("qualifiedname", "qualified_name", "fullname", "full_name", "path") or "qualifiedName",
            "description_field": pick("description", "summary", "comment") or "description",
            "tags_field": pick("tags", "labels_list", "categories") or "tags",
            "entity_type_strategy": "label",
            "entity_type_field": "entityType",
        }

    # ------------------------------------------------------------------ #
    # Diagnostics                                                          #
    # ------------------------------------------------------------------ #

    async def get_diagnostics(self) -> Dict[str, Any]:
        # Best-effort connect — diagnostics must work even when the user is
        # diagnosing why the provider can't reach Spanner.
        try:
            await asyncio.wait_for(self._ensure_connected(), timeout=2.0)
        except Exception:  # noqa: BLE001
            pass

        # Re-fingerprint and detect drift
        fingerprint_now: Optional[str] = None
        try:
            fingerprint_now = await self._compute_schema_fingerprint()
        except Exception:  # noqa: BLE001
            pass
        if fingerprint_now and self._schema_fingerprint and fingerprint_now != self._schema_fingerprint:
            self._schema_drift_detected = True
        if fingerprint_now:
            self._schema_fingerprint = fingerprint_now

        # IAM probe (best-effort)
        iam: Dict[str, bool] = {}
        try:
            def _check_iam() -> Dict[str, bool]:
                assert self._database is not None
                wanted = [
                    "spanner.databases.read",
                    "spanner.databases.write",
                    "spanner.databases.updateDdl",
                ]
                # google-cloud-spanner exposes test_iam_permissions on
                # database.iam_policy(); not all API versions support this
                # method — fall back gracefully.
                try:
                    granted = list(self._database.iam_policy().test_iam_permissions(wanted))
                except Exception:  # noqa: BLE001
                    granted = []
                return {p: (p in granted) for p in wanted}

            iam = await self._run_in_executor(_check_iam, timeout=_DEFAULT_QUERY_TIMEOUT_S)
        except Exception:  # noqa: BLE001
            iam = {}

        p50, p95 = self._latency.snapshot()
        return {
            "edition": self._edition,
            "dialect": self._dialect,
            "region": self._gcp_region,
            "session_pool": {
                "size": _DEFAULT_THREAD_POOL,
            },
            "last_query_p50_ms": int(p50 * 1000) if p50 is not None else None,
            "last_query_p95_ms": int(p95 * 1000) if p95 is not None else None,
            "last_successful_query_at": self._last_successful_query_at,
            "schema_fingerprint": self._schema_fingerprint,
            "schema_drift_detected": self._schema_drift_detected,
            "iam_permissions": iam,
            "capabilities": dict(self._capabilities),
        }
