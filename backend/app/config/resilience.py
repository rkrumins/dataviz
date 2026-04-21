"""Centralized resilience & timeout configuration.

Every timeout, retry, and circuit-breaker tunable lives here so operators
can reason about the system's failure behaviour from a single file.
All values are configurable via environment variables with sensible defaults.

Timeout layering (outermost to innermost):
    HTTP middleware  →  CircuitBreakerProxy  →  Provider-specific query
    (15-45s)            (10s)                   (5-15s)

The innermost timeout fires first in most cases. Outer layers are
defense-in-depth backstops.
"""

import os

# ── Circuit Breaker (applies to ALL provider types) ─────────────────
# Number of consecutive failures before the breaker opens.
BREAKER_FAIL_MAX: int = int(os.getenv("PROVIDER_BREAKER_FAIL_MAX", "3"))
# Seconds the breaker stays open before allowing a single probe request.
BREAKER_RESET_TIMEOUT_SECS: int = int(os.getenv("PROVIDER_BREAKER_RESET_TIMEOUT_SECS", "30"))
# Per-method deadline (seconds) enforced by CircuitBreakerProxy on every
# async call. Converts hung connections into TimeoutErrors that count
# toward the failure budget. 0 = disabled. Applies to ALL providers.
BREAKER_METHOD_TIMEOUT_SECS: float = float(os.getenv("PROVIDER_METHOD_TIMEOUT_SECS", "10"))

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
