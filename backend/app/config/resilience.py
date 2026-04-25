"""Centralized resilience & timeout configuration.

Every timeout, retry, and circuit-breaker tunable lives here so operators
can reason about the system's failure behaviour from a single file.
All values are configurable via environment variables with sensible defaults.

Timeout layering (outermost to innermost):
    HTTP middleware                       →  CircuitBreakerProxy
    (15-45s)                                 (no deadline; gate + observer)
                                          →  Provider per-operation deadline
                                             (5-15s, owned by provider)
The innermost timeout fires first by design. The proxy does not impose
a deadline because only the provider knows the right granularity (a
single query vs. an orchestration of many).
"""

import os

# ── Circuit Breaker (applies to ALL provider types) ─────────────────
# Number of consecutive failures before the breaker opens.
BREAKER_FAIL_MAX: int = int(os.getenv("PROVIDER_BREAKER_FAIL_MAX", "3"))
# Seconds the breaker stays open before allowing a single probe request.
BREAKER_RESET_TIMEOUT_SECS: int = int(os.getenv("PROVIDER_BREAKER_RESET_TIMEOUT_SECS", "30"))

# ── FalkorDB-specific query timeouts ────────────────────────────────
# Read-only Cypher queries (MATCH ... RETURN).
FALKORDB_QUERY_TIMEOUT_SECS: float = float(os.getenv("FALKORDB_QUERY_TIMEOUT", "5"))
# Write Cypher queries (CREATE, MERGE, UNWIND+MERGE batch ops).
# Generous default because batch MERGE operations in the aggregation
# worker can legitimately take 10-15s on large graphs.
FALKORDB_WRITE_TIMEOUT_SECS: float = float(os.getenv("FALKORDB_WRITE_TIMEOUT", "15"))
# Startup-time operations: seed check, index creation.
# Short because these run during _ensure_connected() on the critical path.
FALKORDB_INIT_TIMEOUT_SECS: float = float(os.getenv("FALKORDB_INIT_TIMEOUT", "3"))

# ── HTTP request timeouts (ASGI middleware, per-path) ───────────────
# Health/readiness probes — must respond fast for K8s.
HTTP_TIMEOUT_HEALTH_SECS: float = float(os.getenv("HTTP_TIMEOUT_HEALTH_SECS", "5"))
# Read-only graph queries — bounded by per-query timeouts below.
HTTP_TIMEOUT_GRAPH_SECS: float = float(os.getenv("HTTP_TIMEOUT_GRAPH_SECS", "15"))
# Write-heavy aggregation operations.
HTTP_TIMEOUT_AGGREGATION_SECS: float = float(os.getenv("HTTP_TIMEOUT_AGGREGATION_SECS", "45"))
# Default for all other endpoints.
HTTP_TIMEOUT_DEFAULT_SECS: float = float(os.getenv("HTTP_TIMEOUT_DEFAULT_SECS", "30"))

# ── Redis data-structure operations (caching, materialization state) ─
# Per-operation timeout for ALL Redis calls (HGET, SADD, pipeline, etc.)
# in FalkorDB provider. These are separate from graph (Cypher) queries.
FALKORDB_REDIS_OP_TIMEOUT_SECS: float = float(os.getenv("FALKORDB_REDIS_OP_TIMEOUT", "3"))
# Same for Neo4j provider's optional Redis (ancestor chain caching).
NEO4J_REDIS_OP_TIMEOUT_SECS: float = float(os.getenv("NEO4J_REDIS_OP_TIMEOUT", "3"))

# ── Dedicated Redis for non-graph operations ────────────────────────
# When set, ALL Redis caching + materialization state in FalkorDB
# provider uses this dedicated instance instead of the FalkorDB server.
# This cleanly separates graph queries (FalkorDB) from caching/state
# (dedicated Redis). Unset = falls back to FalkorDB instance (dev compat).
# CACHE_REDIS_URL: str (e.g. "redis://cache-redis:6379/0")

# ── Ontology introspection ──────────────────────────────────────────
# Outer timeout for the aggregate get_ontology_metadata() call (which
# issues 4-5 internal Cypher queries). Per-query timeouts fire first;
# this is a defense-in-depth backstop.
ONTOLOGY_INTROSPECTION_TIMEOUT_SECS: float = float(os.getenv("ONTOLOGY_INTROSPECTION_TIMEOUT", "8"))

# ── Scheduler & drift checks ───────────────────────────────────────
# Per-provider timeout during periodic fingerprint comparison.
# Also used by AggregationService.check_drift() and readiness check.
SCHEDULER_DRIFT_CHECK_TIMEOUT_SECS: float = float(os.getenv("SCHEDULER_DRIFT_CHECK_TIMEOUT", "5"))

# ── Event listener ──────────────────────────────────────────────────
# Timeout for Redis subscribe and per-message poll in the aggregation
# event listener background task.
EVENT_LISTENER_TIMEOUT_SECS: float = float(os.getenv("EVENT_LISTENER_TIMEOUT", "10"))

# ── Stats service (background schema/ontology refresh) ─────────────
# Per-data-source polling timeout. Size-adaptive: default for small
# graphs, extended for graphs past the large-node threshold (since
# full-graph MATCH scans on 1M+ node graphs legitimately need minutes).
STATS_POLL_TIMEOUT_SECS: float = float(os.getenv("STATS_POLL_TIMEOUT_SECS", "30"))
STATS_POLL_TIMEOUT_LARGE_SECS: float = float(os.getenv("STATS_POLL_TIMEOUT_LARGE_SECS", "600"))
STATS_POLL_LARGE_THRESHOLD: int = int(os.getenv("STATS_POLL_LARGE_THRESHOLD", "100000"))

# ── Schema / ontology in-memory Redis cache ─────────────────────────
# Short-term memoization layer for get_stats / get_ontology_metadata.
# Postgres (DataSourceStatsORM, populated by the stats service) is the
# durable source of truth. Set to 0 to disable the Redis memoization.
FALKORDB_SCHEMA_CACHE_TTL: int = int(os.getenv("FALKORDB_SCHEMA_CACHE_TTL", "300"))

# ── Cache-only read path for graph introspection endpoints ──────────
# HTTP handlers (/graph/stats, /graph/metadata/schema, /introspection,
# /metadata/ontology) read exclusively from data_source_stats when
# STATS_CACHE_STRICT_MODE=true. The stats service owns all provider
# introspection; the web tier never runs a MATCH on the critical path.
# Set to "false" to restore the legacy try-cache-then-provider fallback
# as a one-release rollback escape hatch.
STATS_CACHE_STRICT_MODE: bool = os.getenv("STATS_CACHE_STRICT_MODE", "true").lower() == "true"

# Freshness classification — fed to X-Cache-* headers and the frontend
# staleness banner. A cache entry is "fresh" when polled within this
# window (default aligns with the scheduler's 5-min default interval).
STATS_CACHE_FRESH_SECS: int = int(os.getenv("STATS_CACHE_FRESH_SECS", "300"))
# Absolute expiry: a cache row older than this is treated as missing —
# the handler refuses to serve it and falls through to synthetic-or-202.
# 7 days survives weekend outages of the stats service while ensuring
# abandoned data sources don't surface year-old numbers.
STATS_CACHE_ABSOLUTE_EXPIRY_SECS: int = int(os.getenv("STATS_CACHE_ABSOLUTE_EXPIRY_SECS", "604800"))

# Stats-service health classification — compared against
# data_source_polling_configs.last_polled_at. Emitted as
# X-Stats-Service-Status so the frontend can show a "updates paused"
# banner without needing a separate health endpoint.
STATS_SERVICE_LAGGING_THRESHOLD_SECS: int = int(os.getenv("STATS_SERVICE_LAGGING_THRESHOLD_SECS", "60"))
STATS_SERVICE_UNREACHABLE_THRESHOLD_SECS: int = int(os.getenv("STATS_SERVICE_UNREACHABLE_THRESHOLD_SECS", "600"))
