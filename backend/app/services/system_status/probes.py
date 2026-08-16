"""Infrastructure status probes — one bounded async probe per component.

Feeds the super-admin Infrastructure dashboard
(``GET /api/v1/admin/system/status``). Every probe:

* bounds its own I/O (``asyncio.timeout``) so the snapshot's wall time is
  the largest single budget, never the sum;
* catches ALL exceptions and degrades to a ``status``/``error`` field —
  one broken dependency can never 500 the snapshot;
* measures its own latency;
* never emits DSNs / URLs / credentials — booleans and host-free facts only.

Verdicts prefer WORK signals in shared state (Postgres rows, Redis streams,
exec-lock heartbeats) over HTTP liveness: on GKE the platform already
restarts dead pods — the question this page answers is "is the work
happening". Managed-Redis (Memorystore) tolerance: a missing or blocked
INFO field becomes ``None``, never an unhealthy verdict.

Nothing here runs at import time — engines, Redis clients and the shared
httpx client are all created lazily inside the probes.
"""
from __future__ import annotations

import asyncio
import logging
import os
import shutil
import time
from datetime import datetime, timezone
from typing import Any, Optional

import httpx

from backend.app.services.aggregation.internal_auth import internal_auth_headers

logger = logging.getLogger(__name__)

# ── Internal service URLs (compose DNS defaults; k8s Service DNS in GKE) ──

def _stats_service_url() -> str:
    return os.getenv("STATS_SERVICE_URL", "http://stats-service:8092")


def _aggregation_worker_health_url() -> str:
    return os.getenv("AGGREGATION_WORKER_HEALTH_URL", "http://aggregation-worker:8090")


def _graph_service_url() -> str:
    return os.getenv("GRAPH_SERVICE_URL", "http://graph-service:8001")


def _aggregation_service_url() -> str:
    # Same default as endpoints/aggregation.py so both resolve identically.
    return os.getenv("AGGREGATION_SERVICE_URL", "http://localhost:8091")


# ── Probe time budgets (seconds) ─────────────────────────────────────

_BUDGET_DB = 1.0
_BUDGET_REDIS = 1.0
_BUDGET_FALKOR = 1.5
_BUDGET_HTTP = 2.0
_BUDGET_STREAMS = 1.5
_BUDGET_PROJECTION = 1.5

# Oldest-pending age beyond which a consumer fleet counts as degraded —
# jobs are being claimed but not acked (worker wedged / timing out).
_PENDING_AGE_DEGRADED_MS = 5 * 60 * 1000

# A consumer idle longer than this while still holding PEL entries is
# treated as dead — its pending messages are "orphaned" (read but never
# acknowledged, and no live consumer is reclaiming them). 5 min is well
# clear of any healthy inter-poll gap.
DEAD_CONSUMER_IDLE_MS = 5 * 60 * 1000

# How many recent DLQ entries to sample for the reason/offender breakdown.
_DLQ_SAMPLE = 200


# ── Shared lazy singletons (never created at import time) ───────────

_http_client: Optional[httpx.AsyncClient] = None
_cache_redis_client = None


def _http() -> httpx.AsyncClient:
    global _http_client
    if _http_client is None:
        _http_client = httpx.AsyncClient(timeout=httpx.Timeout(2.0, connect=1.0))
    return _http_client


def _cache_redis():
    """Probe client for the CACHE endpoint — resolved centrally so it carries the
    same auth + TLS as the real cache client. A probe that cannot authenticate
    reports a healthy cache as DOWN."""
    global _cache_redis_client
    if _cache_redis_client is None:
        import dataclasses

        from backend.common.adapters.redis_endpoint import (
            RedisConfigurationError, RedisRole, build_redis_client,
            resolve_redis_config,
        )
        try:
            cfg = resolve_redis_config(RedisRole.CACHE)
        except RedisConfigurationError:
            return None
        if not cfg.is_configured:
            return None                      # cache not configured -> nothing to probe
                                             # (is_configured handles sentinel mode)
        cfg = dataclasses.replace(
            cfg, socket_timeout=1.0, socket_connect_timeout=1.0, max_connections=2,
            # Pin OFF: build_redis_client applies the CACHE role's default of 30,
            # but the original probe (bare aioredis.from_url(...)) never set this,
            # so redis-py defaulted it to 0 (disabled). A probe opens a
            # short-lived, tightly-budgeted connection — it does not want
            # redis-py's periodic idle-socket liveness PING.
            health_check_interval=0,
        )
        _cache_redis_client = build_redis_client(cfg)
    return _cache_redis_client


# NOTE: FalkorDB gets no cached singleton — probe_falkordb resolves the topology
# per call and builds short-lived clients (cluster nodes come and go on a rotation,
# so a cached client would pin a dead pod).


# ── Envelope helpers ─────────────────────────────────────────────────

def _svc(key: str, label: str, status: str, *,
         latency_ms: Optional[float] = None,
         error: Optional[str] = None,
         detail: Optional[dict] = None) -> dict:
    return {
        "key": key, "label": label, "status": status,
        "latencyMs": round(latency_ms, 1) if latency_ms is not None else None,
        "error": error, "detail": detail or {},
    }


def _err(exc: BaseException) -> str:
    return (str(exc) or exc.__class__.__name__)[:200]


def _now_ms() -> int:
    return int(time.time() * 1000)


def _parse_iso(ts: Optional[str]) -> Optional[datetime]:
    if not ts:
        return None
    try:
        dt = datetime.fromisoformat(ts)
    except (TypeError, ValueError):
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _msg_id_to_ms(msg_id: Any) -> Optional[int]:
    """Stream IDs are ``<ms>-<seq>`` strings/bytes → the ms component."""
    if msg_id is None:
        return None
    try:
        raw = msg_id.decode() if isinstance(msg_id, bytes) else str(msg_id)
        return int(raw.split("-", 1)[0])
    except (ValueError, AttributeError):
        return None


# ── Redis INFO curation (shared by bus / cache / falkordb probes) ────

def _redis_info_detail(info: dict) -> dict:
    """Curated, host-free subset of INFO. Missing fields → None
    (Memorystore blocks/omits some sections — absence is never a fault)."""
    def g(key: str):
        return info.get(key)

    return {
        "version": g("redis_version"),
        "uptimeS": g("uptime_in_seconds"),
        "usedMemoryHuman": g("used_memory_human"),
        "memFragmentationRatio": g("mem_fragmentation_ratio"),
        "connectedClients": g("connected_clients"),
        "blockedClients": g("blocked_clients"),
        "opsPerSec": g("instantaneous_ops_per_sec"),
        "rdbLastBgsaveStatus": g("rdb_last_bgsave_status"),
        "aofEnabled": bool(g("aof_enabled")) if g("aof_enabled") is not None else None,
        "aofLastWriteStatus": g("aof_last_write_status"),
        "loading": bool(g("loading")) if g("loading") is not None else None,
    }


def _redis_persistence_reasons(detail: dict) -> list[str]:
    """Degrade ONLY on explicit bad values — absent fields stay silent."""
    reasons = []
    if detail.get("rdbLastBgsaveStatus") not in (None, "ok"):
        reasons.append(f"last RDB save {detail['rdbLastBgsaveStatus']}")
    if detail.get("aofEnabled") and detail.get("aofLastWriteStatus") not in (None, "ok"):
        reasons.append(f"last AOF write {detail['aofLastWriteStatus']}")
    if detail.get("loading"):
        reasons.append("loading dataset")
    return reasons


# ── Postgres stats (shared by management / graphver probes) ─────────

_PG_STATS_SQL = """
SELECT
  pg_database_size(current_database())::bigint            AS db_size_bytes,
  (SELECT count(*) FROM pg_stat_activity)::int            AS conn_total,
  (SELECT count(*) FROM pg_stat_activity
    WHERE state = 'active')::int                          AS conn_active,
  (SELECT setting::int FROM pg_settings
    WHERE name = 'max_connections')                       AS conn_max,
  (SELECT coalesce(extract(epoch FROM max(now() - xact_start)), 0)::float
     FROM pg_stat_activity WHERE xact_start IS NOT NULL)  AS longest_xact_s
"""

_PG_SCHEMA_SIZE_SQL = """
SELECT coalesce(sum(pg_total_relation_size(c.oid)), 0)::bigint
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = :schema AND c.relkind IN ('r', 'm', 'p')
"""


async def _pg_probe(key: str, label: str, engine, *,
                    schema_size_of: Optional[str] = None,
                    extra_detail: Optional[dict] = None) -> dict:
    """SELECT 1 ping (verdict + latency) then one stats round-trip (detail).

    A stats failure degrades to null fields, not to an unhealthy verdict —
    e.g. a restricted pg_stat_activity on a managed instance.
    """
    from sqlalchemy import text

    detail: dict = dict(extra_detail or {})
    started = time.monotonic()
    try:
        async with asyncio.timeout(_BUDGET_DB):
            async with engine.connect() as conn:
                await conn.execute(text("SELECT 1"))
                latency_ms = (time.monotonic() - started) * 1000
                try:
                    row = (await conn.execute(text(_PG_STATS_SQL))).one()
                    detail.update({
                        "dbSizeBytes": row.db_size_bytes,
                        "connections": {
                            "total": row.conn_total,
                            "active": row.conn_active,
                            "max": row.conn_max,
                        },
                        "longestXactAgeS": round(row.longest_xact_s, 1),
                    })
                    if schema_size_of is not None:
                        size = (await conn.execute(
                            text(_PG_SCHEMA_SIZE_SQL), {"schema": schema_size_of},
                        )).scalar()
                        detail["schemaSizeBytes"] = size
                except Exception as exc:
                    detail["statsError"] = _err(exc)
    except Exception as exc:
        return _svc(key, label, "down", error=_err(exc), detail=detail)

    reasons = []
    if latency_ms > 250:
        reasons.append(f"slow ping {latency_ms:.0f}ms")
    conns = detail.get("connections") or {}
    if conns.get("max") and conns.get("total") is not None \
            and conns["total"] >= 0.9 * conns["max"]:
        reasons.append(f"connections {conns['total']}/{conns['max']}")
    if reasons:
        detail["reasons"] = reasons
    return _svc(key, label, "degraded" if reasons else "healthy",
                latency_ms=latency_ms, detail=detail)


# ── Service probes ───────────────────────────────────────────────────

async def probe_viz_service(app_state) -> dict:
    """In-process signals only — no I/O beyond a local statvfs."""
    detail: dict = {}
    reasons: list[str] = []

    if getattr(app_state, "degraded", False):
        reasons.append(getattr(app_state, "degraded_reason", None) or "degraded flag set")

    lag_stats = getattr(app_state, "event_loop_lag_stats", None)
    if lag_stats is not None:
        p99_ms = round(lag_stats.p99_s * 1000, 1)
        detail["eventLoop"] = {"p99Ms": p99_ms,
                               "peakMs": round(lag_stats.peak_s * 1000, 1)}
        if p99_ms >= 50:
            reasons.append(f"event-loop p99 {p99_ms:.0f}ms")

    # Warmup-loop heartbeat (same thresholds as /health/deps).
    try:
        from backend.app.providers.manager import provider_manager

        last_cycle = getattr(provider_manager, "warmup_last_cycle_at", None)
        if last_cycle is None:
            detail["warmupLoop"] = "starting"
        else:
            age_s = time.monotonic() - last_cycle
            detail["warmupLoop"] = f"cycle {age_s:.0f}s ago"
            threshold = float(os.getenv("WARMUP_HEARTBEAT_STALE_THRESHOLD_S", "90"))
            if age_s > threshold:
                reasons.append(f"warmup loop stalled {age_s:.0f}s")
    except Exception as exc:
        detail["warmupLoop"] = f"unavailable: {_err(exc)}"

    try:
        from backend.app.db.engine import get_schema_state, pool_status

        state = get_schema_state()
        at_head = state.get("at_head")
        detail["schemaAtHead"] = at_head
        if at_head is False:
            reasons.append("schema not at Alembic head")
        detail["pools"] = pool_status()
    except Exception as exc:
        detail["schemaAtHead"] = None
        detail["poolsError"] = _err(exc)

    # In-process versioning projection worker (GRAPHVER_PROJECTION_INPROCESS).
    task = getattr(app_state, "_versioning_worker_task", None)
    if task is not None:
        alive = not task.done()
        detail["projectionWorker"] = {"mode": "inprocess", "alive": alive}
        if not alive:
            reasons.append("in-process projection worker task exited")
    else:
        detail["projectionWorker"] = {"mode": "standalone"}

    try:
        usage = shutil.disk_usage("/")
        pct = round(usage.used / usage.total * 100, 1)
        detail["disk"] = {"usedPct": pct, "totalBytes": usage.total}
        if pct >= 80:
            reasons.append(f"disk {pct:.0f}% full")
    except Exception as exc:
        detail["disk"] = {"error": _err(exc)}

    if reasons:
        detail["reasons"] = reasons
    return _svc("vizService", "Viz Service",
                "degraded" if reasons else "healthy", detail=detail)


async def probe_management_db() -> dict:
    from backend.app.db.engine import PoolRole, get_engine

    return await _pg_probe("managementDb", "Postgres · Management",
                           get_engine(PoolRole.READONLY))


async def probe_graphver_db() -> dict:
    from backend.app.services.versioning import config as gv_config
    from backend.app.services.versioning import db as gv_db

    gv_url = os.getenv("GRAPHVER_DB_URL")
    colocated = not gv_url or gv_url == os.getenv("MANAGEMENT_DB_URL")
    schema = gv_config.graphver_schema()
    return await _pg_probe(
        "graphverDb", "Postgres · GraphVer",
        gv_db.get_engine(),
        schema_size_of=schema,
        extra_detail={"colocated": colocated, "schema": schema},
    )


async def _redis_probe(key: str, label: str, client, budget: float,
                       extra: Optional[dict] = None) -> dict:
    started = time.monotonic()
    try:
        async with asyncio.timeout(budget):
            await client.ping()
            latency_ms = (time.monotonic() - started) * 1000
            try:
                info = await client.info()
            except Exception:
                info = {}
    except Exception as exc:
        return _svc(key, label, "down", error=_err(exc))

    detail = _redis_info_detail(info)
    if extra:
        detail.update(extra)
    reasons = _redis_persistence_reasons(detail)
    if reasons:
        detail["reasons"] = reasons
    return _svc(key, label, "degraded" if reasons else "healthy",
                latency_ms=latency_ms, detail=detail)


def _role_config_detail(role) -> dict:
    """mode/tls/auth-presence for a role's probe detail — lets the dashboard
    show WHAT was probed (a sentinel master vs a standalone host, TLS or
    plaintext, authenticated or not), not just that it answered. Best-effort:
    a config error must never take down the probe itself."""
    from backend.common.adapters.redis_endpoint import resolve_redis_config

    try:
        cfg = resolve_redis_config(role)
        return {
            "mode": cfg.mode,
            "tls": cfg.tls.enabled,
            "authenticated": bool(cfg.password),
        }
    except Exception:
        return {}


async def probe_bus_redis() -> dict:
    from backend.app.services.aggregation.redis_client import get_redis
    from backend.common.adapters.redis_endpoint import RedisRole

    return await _redis_probe(
        "busRedis", "Redis · Bus", get_redis(), _BUDGET_REDIS,
        extra=_role_config_detail(RedisRole.STREAMS),
    )


async def probe_cache_redis() -> dict:
    """Health of the GLOBAL cache endpoint only. Providers whose caches ride
    their own ``extra_config.cacheConnection`` are not covered by this probe
    (they resolve per-provider at connect time); a deployment with ONLY
    per-provider caches correctly reports "unknown" here, not "down"."""
    client = _cache_redis()
    if client is None:
        return _svc(
            "cacheRedis", "Redis · Cache", "unknown",
            error=(
                "no global cache endpoint configured (REDIS_CACHE_* / legacy "
                "CACHE_REDIS_URL); per-provider cacheConnection caches are "
                "not covered by this probe"
            ),
            detail={"scope": "global"},
        )

    from backend.common.adapters.redis_endpoint import RedisRole

    result = await _redis_probe(
        "cacheRedis", "Redis · Cache", client, _BUDGET_REDIS,
        extra=_role_config_detail(RedisRole.CACHE),
    )
    result.setdefault("detail", {})["scope"] = "global"
    if result["status"] == "down":
        return result
    # Cache-specific effectiveness stats, best-effort on top of the base info.
    try:
        async with asyncio.timeout(_BUDGET_REDIS):
            info = await client.info()
            hits = info.get("keyspace_hits")
            misses = info.get("keyspace_misses")
            hit_rate = (round(hits / (hits + misses) * 100, 1)
                        if hits is not None and misses is not None and hits + misses > 0
                        else None)
            result["detail"].update({
                "hitRate": hit_rate,
                "evictedKeys": info.get("evicted_keys"),
                "expiredKeys": info.get("expired_keys"),
                "maxmemory": info.get("maxmemory"),
                "maxmemoryPolicy": info.get("maxmemory_policy"),
                "keys": await client.dbsize(),
            })
    except Exception as exc:
        result["detail"]["cacheStatsError"] = _err(exc)
    return result


def _build_falkor_probe_client(
    host: str, port: int, *, username=None, password=None, tls=None,
    connect_timeout=None, socket_timeout=None,
):
    """Short-lived probe client for ONE FalkorDB node, carrying the graph
    connection's auth + TLS. It used to be a bare Redis(host, port), which cannot
    talk to an authenticated instance at all. The 1/1.5s defaults false-down a
    slow cross-cluster hop, so a configured connectTimeout/socketTimeout wins."""
    import redis.asyncio as aioredis

    from backend.common.adapters.redis_tls import tls_client_kwargs

    kw = dict(
        host=host, port=port, decode_responses=True,
        socket_connect_timeout=connect_timeout or 1,
        socket_timeout=socket_timeout or 1.5,
        **tls_client_kwargs(tls),
    )
    if username:
        kw["username"] = username
    if password:
        kw["password"] = password
    return aioredis.Redis(**kw)


async def _falkor_node_probe(
    host: str, port: int, label: str, *, username=None, password=None, tls=None,
    connect_timeout=None, socket_timeout=None, budget=None,
) -> dict:
    """One FalkorDB node: PING + INFO + its own GRAPH.LIST count. Builds a
    short-lived client (nodes come and go on a rotation, so nothing is cached)."""
    budget = budget or _BUDGET_FALKOR
    client = _build_falkor_probe_client(
        host, port, username=username, password=password, tls=tls,
        connect_timeout=connect_timeout, socket_timeout=socket_timeout,
    )
    try:
        result = await _redis_probe("falkordbNode", label, client, budget)
        if result["status"] != "down":
            # Best-effort — GRAPH.LIST failing alone is not a fault. On a cluster
            # this is the count of keys in THIS node's slots.
            try:
                async with asyncio.timeout(budget):
                    graphs = await client.execute_command("GRAPH.LIST")
                    result["detail"]["graphCount"] = (
                        len(graphs) if graphs is not None else None
                    )
            except Exception:
                result["detail"]["graphCount"] = None
        result["detail"]["endpoint"] = f"{host}:{port}"
        return result
    finally:
        try:
            await client.aclose()
        except Exception:
            pass


async def probe_falkordb() -> dict:
    """Topology-aware FalkorDB health.

    Standalone / Sentinel: probe the configured endpoint (Sentinel's master is
    followed by the data path itself; the dashboard reports the endpoint it has).

    CLUSTER: probe EVERY primary. A single-seed probe would report the whole graph
    tier "healthy" while a rotating shard is down and a third of the graphs are
    unreadable — and its graph count would only see the seed's own slots. Shard
    verdicts roll up: all up → healthy, some up → degraded (naming the dead shards),
    none up → down. Graph count is the sum across shards.
    """
    from backend.app.providers.falkordb_connection import (
        cluster_primary_nodes, connect_verify_budget, env_conn_config,
        resolve_sentinel_master,
    )

    try:
        cfg = env_conn_config()
    except Exception as exc:
        # env_conn_config() raises (never silently) when FALKORDB_PASSWORD_FILE
        # is set but missing/empty — a probe must degrade to "down", not blow up
        # the dashboard. _err() truncates to the exception text only (var name +
        # path — never a secret value).
        return _svc("falkordb", "FalkorDB", "down", error=_err(exc))

    # WHAT is being probed: TLS/auth-presence for the dashboard (the mode is
    # stamped per branch below; the standalone branch previously stamped none).
    graph_conf_detail = {
        "tls": cfg.tls_enabled,
        "authenticated": bool(cfg.password),
    }
    # The fixed 1/1.5s probe windows false-down a slow cross-cluster hop.
    # The env-default instance's dial/query knobs are the FALKORDB_SOCKET_*
    # env vars (cfg carries them only when set via JSON) — when EXPLICITLY
    # set, they and probeDeadlineS extend the probe windows (never shrink;
    # unset keeps the fast 1/1.5s defaults).
    def _env_float(name):
        raw = os.getenv(name)
        try:
            return float(raw) if raw else None
        except ValueError:
            return None

    connect_timeout = (
        cfg.socket_connect_timeout or _env_float("FALKORDB_SOCKET_CONNECT_TIMEOUT")
    )
    socket_timeout = cfg.socket_timeout or _env_float("FALKORDB_SOCKET_TIMEOUT")
    import dataclasses
    budget = connect_verify_budget(
        dataclasses.replace(cfg, socket_connect_timeout=connect_timeout),
        _BUDGET_FALKOR,
    )
    node_probe_kw = dict(
        username=cfg.username, password=cfg.password, tls=cfg.tls_settings(),
        connect_timeout=connect_timeout,
        socket_timeout=socket_timeout,
        budget=budget,
    )

    if cfg.mode == "sentinel":
        # Probe the MASTER Sentinel currently names, not a Sentinel daemon: a
        # sentinel answers PONG happily while the master it watches is dead, which
        # would show the graph tier green through a whole master outage.
        host, port = cfg.host, cfg.port
        try:
            async with asyncio.timeout(budget):
                host, port = await resolve_sentinel_master(cfg, budget)
        except Exception as exc:
            return _svc("falkordb", "FalkorDB · Sentinel", "down",
                        error=_err(exc), detail={"mode": "sentinel"})
        result = await _falkor_node_probe(
            host, port, "FalkorDB · Sentinel", **node_probe_kw,
        )
        result["detail"]["mode"] = "sentinel"
        result["detail"]["master"] = f"{host}:{port}"
        result["detail"].update(graph_conf_detail)
        return result

    if cfg.mode != "cluster":
        result = await _falkor_node_probe(
            cfg.host, cfg.port, "FalkorDB", **node_probe_kw,
        )
        result["detail"]["mode"] = "standalone"
        result["detail"].update(graph_conf_detail)
        if result["status"] == "down" and os.getenv("FALKORDB_HOST") is None:
            # No FALKORDB_* endpoint was ever configured, so the probe dialed
            # the localhost default. Where FalkorDB lives only in provider rows
            # (probed per-provider) this is not an outage — report unconfigured
            # (the cache probe's convention), not a false DOWN.
            result["status"] = "unknown"
            result["detail"]["configured"] = False
            result["error"] = (
                "no env-default FalkorDB endpoint configured (FALKORDB_HOST "
                "unset); provider-routed instances are probed per provider"
            )
        return result

    try:
        async with asyncio.timeout(budget):
            nodes = await cluster_primary_nodes(cfg, budget)
    except Exception as exc:
        # No topology → the cluster is unreachable from here, which IS the fault.
        return _svc("falkordb", "FalkorDB · Cluster", "down", error=_err(exc),
                    detail={"mode": "cluster"})

    results = await asyncio.gather(
        *(_falkor_node_probe(h, p, f"shard {h}:{p}", **node_probe_kw)
          for h, p in nodes),
        return_exceptions=True,
    )
    shards = [r for r in results if isinstance(r, dict)]
    up = [s for s in shards if s["status"] != "down"]
    down = [s for s in shards if s["status"] == "down"]

    if not up:
        status = "down"
    elif down:
        status = "degraded"
    else:
        status = "healthy"

    counts = [s["detail"].get("graphCount") for s in up]
    detail = {
        "mode": "cluster",
        **graph_conf_detail,
        "shardsTotal": len(shards),
        "shardsUp": len(up),
        "graphCount": sum(c for c in counts if c is not None) if counts else None,
        "shards": [
            {"endpoint": s["detail"].get("endpoint"), "status": s["status"],
             "latencyMs": s.get("latencyMs"), "graphCount": s["detail"].get("graphCount")}
            for s in shards
        ],
    }
    if down:
        detail["reasons"] = [
            f"shard {s['detail'].get('endpoint')} unreachable" for s in down
        ]
    latencies = [s["latencyMs"] for s in up if s.get("latencyMs") is not None]
    return _svc("falkordb", "FalkorDB · Cluster", status,
                latency_ms=max(latencies) if latencies else None,
                error="; ".join(detail.get("reasons", [])) or None,
                detail=detail)


async def probe_aggregation_controlplane() -> dict:
    mode = ("proxy"
            if os.getenv("AGGREGATION_PROXY_ENABLED", "false").lower() == "true"
            else "inprocess")
    started = time.monotonic()
    try:
        async with asyncio.timeout(_BUDGET_HTTP):
            resp = await _http().get(f"{_aggregation_service_url()}/health")
        latency_ms = (time.monotonic() - started) * 1000
        if resp.status_code == 200:
            return _svc("aggregationControlplane", "Aggregation Controlplane",
                        "healthy", latency_ms=latency_ms,
                        detail={"mode": mode})
        return _svc("aggregationControlplane", "Aggregation Controlplane",
                    "degraded", latency_ms=latency_ms,
                    error=f"HTTP {resp.status_code}", detail={"mode": mode})
    except Exception as exc:
        return _svc("aggregationControlplane", "Aggregation Controlplane",
                    "down", error=_err(exc), detail={"mode": mode})


async def probe_aggregation_worker() -> dict:
    """Work signals are the verdict; HTTP is detail.

    The consumer group counts EVERY replica (HTTP behind a k8s Service hits
    one pod), so group membership + pending age decide the tile. Assembly
    additionally degrades this tile when stuck jobs are detected
    (see service.py — that signal needs the jobs probe's DB read).
    """
    from backend.app.services.aggregation.redis_client import (
        CONSUMER_GROUP, JOBS_STREAM, get_redis,
    )

    detail: dict = {}
    consumers: Optional[int] = None
    oldest_pending_ms: Optional[int] = None
    try:
        async with asyncio.timeout(_BUDGET_HTTP):
            redis = get_redis()
            try:
                for grp in await redis.xinfo_groups(JOBS_STREAM):
                    if grp.get("name") == CONSUMER_GROUP:
                        consumers = grp.get("consumers")
                        detail["groupLag"] = grp.get("lag")
                        break
            except Exception:
                pass  # fresh install: stream/group not created yet
            try:
                pending = await redis.xpending(JOBS_STREAM, CONSUMER_GROUP)
                if isinstance(pending, dict) and pending.get("pending"):
                    min_ms = _msg_id_to_ms(pending.get("min"))
                    if min_ms is not None:
                        oldest_pending_ms = max(0, _now_ms() - min_ms)
            except Exception:
                pass
    except Exception as exc:
        detail["streamError"] = _err(exc)

    detail["consumers"] = consumers
    detail["oldestPendingAgeMs"] = oldest_pending_ms

    http_ok = False
    started = time.monotonic()
    try:
        async with asyncio.timeout(_BUDGET_HTTP):
            resp = await _http().get(_aggregation_worker_health_url())
        if resp.status_code == 200:
            http_ok = True
            body = resp.json()
            detail["worker"] = {k: body.get(k)
                                for k in ("uptime", "activeJobs", "consumer")}
        else:
            detail["httpError"] = f"HTTP {resp.status_code}"
    except Exception as exc:
        detail["httpError"] = _err(exc)
    latency_ms = (time.monotonic() - started) * 1000

    reasons: list[str] = []
    if not consumers:
        status = "down"
        reasons.append("no consumers in group")
    else:
        status = "healthy"
        if oldest_pending_ms is not None and oldest_pending_ms > _PENDING_AGE_DEGRADED_MS:
            status = "degraded"
            reasons.append(f"oldest pending {oldest_pending_ms // 1000}s")
        if not http_ok:
            status = "degraded"
            reasons.append("HTTP unreachable (reachable via stream group)")
    if reasons:
        detail["reasons"] = reasons
    return _svc("aggregationWorker", "Aggregation Worker", status,
                latency_ms=latency_ms if http_ok else None, detail=detail)


async def probe_stats_service() -> dict:
    """HTTP reachability + curated payload. The final tile verdict is
    finished in assembly, where insights stream consumption + overdue
    polling (work signals) are available."""
    started = time.monotonic()
    try:
        async with asyncio.timeout(_BUDGET_HTTP):
            resp = await _http().get(f"{_stats_service_url()}/health")
        latency_ms = (time.monotonic() - started) * 1000
        if resp.status_code != 200:
            return _svc("statsService", "Stats Service", "down",
                        latency_ms=latency_ms, error=f"HTTP {resp.status_code}")
        body = resp.json()
        detail = {k: body.get(k)
                  for k in ("uptime", "activeJobs", "consumer", "scheduler",
                            "discovery_scheduler", "lanes")
                  if k in body}
        return _svc("statsService", "Stats Service", "healthy",
                    latency_ms=latency_ms, detail=detail)
    except Exception as exc:
        return _svc("statsService", "Stats Service", "down", error=_err(exc))


async def probe_graph_service() -> dict:
    started = time.monotonic()
    try:
        async with asyncio.timeout(_BUDGET_HTTP):
            resp = await _http().get(f"{_graph_service_url()}/health")
        latency_ms = (time.monotonic() - started) * 1000
        if resp.status_code == 200:
            return _svc("graphService", "Graph Service", "healthy",
                        latency_ms=latency_ms)
        return _svc("graphService", "Graph Service", "degraded",
                    latency_ms=latency_ms, error=f"HTTP {resp.status_code}")
    except Exception as exc:
        return _svc("graphService", "Graph Service", "down", error=_err(exc))


# ── Shared data-source directory (id → human name + backing provider) ─

async def _resolve_data_sources(ds_ids: list[str]) -> dict[str, dict]:
    """Resolve data-source ids to display info from the management DB.

    Returns ``{ds_id: {label, workspaceId, workspaceName, providerName,
    providerType}}``. One outer-joined query; returns ``{}`` on any failure
    so callers degrade to raw ids. Shared by every surface that would
    otherwise show a meaningless ``ds_<id>`` (projection, DLQ offenders).
    """
    ids = list({i for i in ds_ids if i})
    if not ids:
        return {}
    from sqlalchemy import select

    from backend.app.db.engine import PoolRole, get_session_factory
    from backend.app.db.models import (
        ProviderORM, WorkspaceDataSourceORM, WorkspaceORM,
    )

    out: dict[str, dict] = {}
    try:
        async with asyncio.timeout(_BUDGET_DB):
            async with get_session_factory(PoolRole.READONLY)() as s:
                rows = (await s.execute(
                    select(  # noqa: cross-domain — read-only admin diagnostics join
                        WorkspaceDataSourceORM.id,
                        WorkspaceDataSourceORM.label,
                        WorkspaceDataSourceORM.workspace_id,
                        WorkspaceORM.name.label("workspace_name"),
                        ProviderORM.name.label("provider_name"),
                        ProviderORM.provider_type.label("provider_type"),
                    )
                    .outerjoin(WorkspaceORM,
                               WorkspaceORM.id == WorkspaceDataSourceORM.workspace_id)
                    .outerjoin(ProviderORM,
                               ProviderORM.id == WorkspaceDataSourceORM.provider_id)
                    .where(WorkspaceDataSourceORM.id.in_(ids))
                    .where(WorkspaceDataSourceORM.deleted_at.is_(None))
                )).all()
        for r in rows:
            out[r.id] = {
                "label": r.label,
                "workspaceId": r.workspace_id,
                "workspaceName": r.workspace_name,
                "providerName": r.provider_name,
                "providerType": r.provider_type,
            }
    except Exception as exc:
        logger.warning("data-source resolution failed: %s", exc)
    return out


async def _present_data_source_ids() -> list[str]:
    """The ids of data sources that are LIVE in the management DB.

    Versioned-graph metrics are scoped to these so the numbers reflect live
    entities — the graphver store has no GC, so graphs for deleted sources
    (and dev/test seed graphs) accumulate and would otherwise dominate every
    count and the projection list. A soft-deleted source is exactly such an
    orphaned graph, so tombstones are excluded.
    """
    from sqlalchemy import select

    from backend.app.db.engine import PoolRole, get_session_factory
    from backend.app.db.models import WorkspaceDataSourceORM

    async with asyncio.timeout(_BUDGET_DB):
        async with get_session_factory(PoolRole.READONLY)() as s:
            return list((await s.execute(
                select(WorkspaceDataSourceORM.id)
                .where(WorkspaceDataSourceORM.deleted_at.is_(None)))).scalars().all())


# ── Data-plane sections ──────────────────────────────────────────────

async def _stream_depth(redis, stream: str, group: str) -> dict:
    """Uniform depth/lag snapshot for one stream + consumer group.

    Every sub-read degrades independently to None: XINFO raises on a
    fresh install (stream not created yet) and ``lag`` can be nil after
    XDEL/trim — both are absence, not failure.
    """
    now_ms = _now_ms()
    # ``group`` travels with the row so consumers (UI, diagnostics) never
    # reconstruct Redis group-naming conventions — the backend owns them.
    out: dict = {"group": group,
                 "len": None, "pending": None, "oldestPendingAgeMs": None,
                 "consumers": None, "groupLag": None,
                 "entriesAdded": None, "lastGeneratedId": None,
                 "consumerDetail": None, "orphanedPending": None, "deadConsumers": None}
    try:
        out["len"] = int(await redis.xlen(stream))
    except Exception:
        pass
    try:
        pending = await redis.xpending(stream, group)
        if isinstance(pending, dict):
            out["pending"] = int(pending.get("pending", 0) or 0)
            min_id = pending.get("min")
        else:  # legacy tuple shape
            out["pending"] = int(pending[0] or 0) if pending else 0
            min_id = pending[1] if pending and len(pending) > 1 else None
        if out["pending"] and min_id is not None:
            min_ms = _msg_id_to_ms(min_id)
            if min_ms is not None:
                out["oldestPendingAgeMs"] = max(0, now_ms - min_ms)
    except Exception:
        pass
    try:
        for grp in await redis.xinfo_groups(stream):
            if grp.get("name") == group:
                out["consumers"] = grp.get("consumers")
                out["groupLag"] = grp.get("lag")
                break
    except Exception:
        pass
    try:
        sinfo = await redis.xinfo_stream(stream)
        out["entriesAdded"] = sinfo.get("entries-added")
        out["lastGeneratedId"] = sinfo.get("last-generated-id")
    except Exception:
        pass
    # Per-consumer breakdown — the signal that turns "3.1k pending" into
    # "3.1k stranded by a dead consumer": a consumer idle past the dead
    # threshold while still holding PEL entries is orphaned work no live
    # consumer is reclaiming.
    try:
        detail, orphaned, dead = [], 0, 0
        for c in await redis.xinfo_consumers(stream, group):
            idle = c.get("idle")
            pend = int(c.get("pending") or 0)
            detail.append({"name": c.get("name"), "pending": pend, "idleMs": idle})
            if idle is not None and idle > DEAD_CONSUMER_IDLE_MS:
                dead += 1
                orphaned += pend
        detail.sort(key=lambda d: d["pending"], reverse=True)
        out["consumerDetail"] = detail
        out["orphanedPending"] = orphaned
        out["deadConsumers"] = dead
    except Exception:
        pass
    return out


async def _dlq_depth(redis, stream: str) -> dict:
    out: dict = {"len": None, "oldestAgeMs": None,
                 "reasons": None, "topSources": None, "kinds": None, "sampled": None}
    try:
        out["len"] = int(await redis.xlen(stream))
        if out["len"] > 0:
            head = await redis.xrange(stream, count=1)
            if head:
                head_ms = _msg_id_to_ms(head[0][0])
                if head_ms is not None:
                    out["oldestAgeMs"] = max(0, _now_ms() - head_ms)
            # Sample the most recent entries to explain WHY they died and
            # WHICH sources dominate — a few bad data sources usually
            # generate most of a DLQ.
            reasons: dict[str, int] = {}
            kinds: dict[str, int] = {}
            sources: dict[tuple, int] = {}
            sample = await redis.xrevrange(stream, count=_DLQ_SAMPLE)
            for _mid, fields in sample:
                reason = fields.get("reason") or "unknown"
                reasons[reason] = reasons.get(reason, 0) + 1
                kind = fields.get("kind")
                if kind:
                    kinds[kind] = kinds.get(kind, 0) + 1
                ds = fields.get("data_source_id")
                if ds:
                    key = (ds, fields.get("workspace_id"))
                    sources[key] = sources.get(key, 0) + 1
            out["reasons"] = reasons
            out["kinds"] = kinds
            out["sampled"] = len(sample)
            top = sorted(sources.items(), key=lambda kv: kv[1], reverse=True)[:5]
            out["topSources"] = [
                {"dataSourceId": ds, "workspaceId": ws, "count": n}
                for (ds, ws), n in top
            ]
    except Exception:
        pass
    return out


async def probe_streams() -> Optional[dict]:
    """Depth + lag for every job stream + DLQ, as flat generic lists.

    Each stream/DLQ is described by data (name, family, group, lane) rather
    than a fixed two-family structure, so adding another producer is a
    catalogue entry — not a schema change here or in the UI.
    """
    from backend.app.services.aggregation.redis_client import (
        CONSUMER_GROUP, DLQ_STREAM as AGG_DLQ, JOBS_STREAM, get_redis,
    )
    # Names only — the module is light (redis.asyncio + resilience config).
    from backend.insights_service.redis_streams import (
        ALL_STREAMS, DLQ_STREAM as INSIGHTS_DLQ,
    )

    try:
        async with asyncio.timeout(_BUDGET_STREAMS):
            redis = get_redis()
            streams: list[dict] = [
                {"name": JOBS_STREAM, "family": "aggregation",
                 **await _stream_depth(redis, JOBS_STREAM, CONSUMER_GROUP)},
            ]
            for cfg in ALL_STREAMS:
                streams.append({
                    "name": cfg.stream, "family": "insights",
                    "kind": cfg.kind, "lane": cfg.lane,
                    **await _stream_depth(redis, cfg.stream, cfg.group),
                })
            dlqs: list[dict] = [
                {"name": AGG_DLQ, "family": "aggregation",
                 **await _dlq_depth(redis, AGG_DLQ)},
                {"name": INSIGHTS_DLQ, "family": "insights",
                 **await _dlq_depth(redis, INSIGHTS_DLQ)},
            ]
    except Exception as exc:
        logger.warning("streams probe failed: %s", exc)
        return None

    # Name the DLQ offenders so the UI shows "Customer 360 (falkordb)" rather
    # than a raw ds_<id>. One shared lookup across every DLQ's top sources.
    directory = await _resolve_data_sources(
        [src["dataSourceId"]
         for dlq in dlqs for src in (dlq.get("topSources") or [])])
    for dlq in dlqs:
        for src in dlq.get("topSources") or []:
            info = directory.get(src["dataSourceId"])
            if info:
                src["label"] = info["label"]
                src["workspaceName"] = info["workspaceName"]
                src["providerName"] = info["providerName"]
                src["providerType"] = info["providerType"]

    return {"streams": streams, "dlqs": dlqs}


async def probe_graph_providers(app_state) -> Optional[list]:
    """Registered graph data providers + reachability — provider-agnostic.

    Reuses the shared ``resolve_provider_status`` resolver (the same one
    behind ``/admin/providers/status`` and the blank-model gate), so this
    covers FalkorDB, Neo4j, Spanner, DataHub and any future type with zero
    per-type code and zero request-path I/O — it reads only the in-memory
    circuit-breaker state and the background warmup cache.
    """
    from backend.app.db.engine import PoolRole, get_session_factory
    from backend.app.db.repositories import provider_repo
    from backend.app.providers.manager import provider_manager
    from backend.app.providers.reachability import resolve_provider_status

    try:
        async with asyncio.timeout(_BUDGET_DB):
            async with get_session_factory(PoolRole.READONLY)() as s:
                providers = await provider_repo.list_providers(s)
    except Exception as exc:
        logger.warning("graph-providers probe failed: %s", exc)
        return None

    try:
        breaker_states = provider_manager.report_provider_states()
    except Exception:
        breaker_states = {}
    warmup_cache = (getattr(app_state, "provider_warmup_cache", None)
                    or getattr(provider_manager, "warmup_cache", None) or {})

    # readiness → the dashboard's shared status vocabulary.
    _MAP = {"ready": "healthy", "unavailable": "down", "unknown": "unknown"}
    out = []
    for p in providers:
        status, error = resolve_provider_status(
            is_active=p.is_active, provider_id=p.id,
            breaker_states=breaker_states, warmup_cache=warmup_cache,
        )
        out.append({
            "id": p.id,
            "name": p.name,
            "type": p.provider_type,
            "status": _MAP.get(status, "unknown"),
            "error": error,
            "isActive": p.is_active,
        })
    out.sort(key=lambda d: (d["status"] != "down", d["type"], d["name"] or ""))
    return out or None


async def probe_projection_lag() -> Optional[dict]:
    """Global Postgres→FalkorDB projection watermark rollup (all graphs).

    Aggregate + top-5 worst only — never all rows (scale-safe). Runs on
    the dedicated graphver engine, not the management pools.
    """
    from sqlalchemy import and_, func, or_, select

    from backend.app.services.versioning.db import graphver_session
    from backend.app.services.versioning.models import GraphORM, ProjectionStateORM

    # Scope to graphs backed by a data source that still exists — orphaned /
    # seed graphs would otherwise flood both the counts and the worst list.
    try:
        present_ids = await _present_data_source_ids()
    except Exception as exc:
        logger.warning("projection-lag probe failed (present ids): %s", exc)
        return None
    present = GraphORM.data_source_id.in_(present_ids)

    lag = GraphORM.main_head_commit_seq - func.coalesce(
        ProjectionStateORM.projected_commit_seq, 0)
    status = func.coalesce(ProjectionStateORM.status, "idle")

    err = ProjectionStateORM.last_error.isnot(None)
    agg_stmt = (
        select(
            func.count().label("total"),
            # in sync = caught up AND no projection error (mutually exclusive
            # with failed, so the chips read consistently).
            func.count().filter(and_(lag <= 0, ~err)).label("fresh"),
            func.count().filter(and_(lag > 0, status == "idle", ~err)).label("lagging"),
            func.count().filter(status == "projecting").label("projecting"),
            func.count().filter(status == "rebuilding").label("rebuilding"),
            func.count().filter(status == "evicted").label("evicted"),
            func.count().filter(err).label("failed"),
            func.coalesce(func.max(lag), 0).label("max_lag"),
        )
        .select_from(GraphORM)
        .outerjoin(ProjectionStateORM, ProjectionStateORM.graph_id == GraphORM.id)
        .where(present)
    )
    worst_stmt = (
        select(
            GraphORM.id, GraphORM.workspace_id, GraphORM.data_source_id,
            GraphORM.kind, GraphORM.main_head_commit_seq,
            ProjectionStateORM.falkor_graph_name, ProjectionStateORM.falkor_provider,
            ProjectionStateORM.projected_commit_seq, ProjectionStateORM.target_commit_seq,
            lag.label("lag"), status.label("status"),
            ProjectionStateORM.last_error, ProjectionStateORM.last_projected_at,
            ProjectionStateORM.progress_done, ProjectionStateORM.progress_total,
            ProjectionStateORM.updated_at,
        )
        .select_from(GraphORM)
        .outerjoin(ProjectionStateORM, ProjectionStateORM.graph_id == GraphORM.id)
        .where(present)
        .where(or_(lag > 0, ProjectionStateORM.last_error.isnot(None),
                   ProjectionStateORM.status.in_(("projecting", "rebuilding"))))
        .order_by(lag.desc())
        .limit(8)
    )

    try:
        async with asyncio.timeout(_BUDGET_PROJECTION):
            async with graphver_session() as session:
                agg = (await session.execute(agg_stmt)).one()
                worst_rows = (await session.execute(worst_stmt)).all()
    except Exception as exc:
        logger.warning("projection-lag probe failed: %s", exc)
        return None

    # The graphver store holds only logical refs — resolve each graph's
    # data source to its human name + backing provider (shared directory)
    # so the table reads "Customer 360 (falkordb) · Sales", not "ds_sr_df567f".
    directory = await _resolve_data_sources(
        [r.data_source_id for r in worst_rows if r.data_source_id])

    def _row(r) -> dict:
        info = directory.get(r.data_source_id) or {}
        return {
            "graphId": r.id,
            "workspaceId": r.workspace_id,
            "workspaceName": info.get("workspaceName"),
            "dataSourceId": r.data_source_id,
            "dataSourceLabel": info.get("label"),
            "providerName": info.get("providerName"),
            "providerType": info.get("providerType"),
            "kind": r.kind,
            "falkorGraphName": r.falkor_graph_name,
            "falkorProvider": r.falkor_provider,
            "committed": r.main_head_commit_seq,
            "projected": r.projected_commit_seq,
            "target": r.target_commit_seq,
            "lag": r.lag,
            "status": r.status,
            "lastError": r.last_error,
            "lastProjectedAt": r.last_projected_at,
            "progressDone": r.progress_done,
            "progressTotal": r.progress_total,
            "updatedAt": r.updated_at,
        }

    return {
        "totalGraphs": agg.total,
        "fresh": agg.fresh,
        "lagging": agg.lagging,
        "projecting": agg.projecting,
        "rebuilding": agg.rebuilding,
        "evicted": agg.evicted,
        "failed": agg.failed,
        "maxLag": agg.max_lag,
        "worst": [_row(r) for r in worst_rows],
    }


async def probe_aggregation_jobs(app_state) -> Optional[dict]:
    """Job KPIs (dual-mode, mirrors endpoints/aggregation.py) + stuck count.

    ``stuckJobs`` = ``running`` rows with no live ``agg:exec:{id}`` lock —
    the reconciler's own "executor died mid-job" predicate.
    """
    from sqlalchemy import select

    from backend.app.db.engine import PoolRole, get_session_factory
    from backend.app.services.aggregation.models import AggregationJobORM
    from backend.app.services.aggregation.redis_client import exec_lock_key, get_redis

    summary: Optional[dict] = None
    try:
        async with asyncio.timeout(_BUDGET_STREAMS):
            svc = getattr(app_state, "aggregation_service", None)
            if svc is not None:
                factory = get_session_factory(PoolRole.READONLY)
                async with factory() as session:
                    summary = await svc.get_jobs_summary(session)
            else:
                resp = await _http().get(
                    f"{_aggregation_service_url()}/aggregation/jobs/summary",
                    headers=internal_auth_headers())
                if resp.status_code == 200:
                    summary = resp.json()
    except Exception as exc:
        logger.warning("aggregation-jobs summary probe failed: %s", exc)

    stuck: Optional[int] = None
    try:
        async with asyncio.timeout(_BUDGET_STREAMS):
            factory = get_session_factory(PoolRole.READONLY)
            async with factory() as session:
                running_ids = (await session.execute(
                    select(AggregationJobORM.id)
                    .where(AggregationJobORM.status == "running")
                    .limit(500)
                )).scalars().all()
            if running_ids:
                redis = get_redis()
                locks = await asyncio.gather(
                    *(redis.exists(exec_lock_key(job_id)) for job_id in running_ids))
                stuck = sum(1 for present in locks if not present)
            else:
                stuck = 0
    except Exception as exc:
        logger.warning("stuck-jobs probe failed: %s", exc)

    if summary is None and stuck is None:
        return None
    return {**(summary or {}), "stuckJobs": stuck}


async def probe_stats_polling() -> Optional[dict]:
    """Per-data-source polling outcomes (management DB, one query).

    ``overdue`` = enabled sources not polled within 2× their configured
    interval — the "is the stats service actually polling" work signal.
    """
    from sqlalchemy import select

    from backend.app.db.engine import PoolRole, get_session_factory
    from backend.app.db.models import DataSourcePollingConfigORM, WorkspaceDataSourceORM

    stmt = (
        select(  # noqa: cross-domain — read-only admin diagnostics join
            WorkspaceDataSourceORM.id.label("data_source_id"),
            WorkspaceDataSourceORM.workspace_id,
            WorkspaceDataSourceORM.label,
            DataSourcePollingConfigORM.is_enabled,
            DataSourcePollingConfigORM.interval_seconds,
            DataSourcePollingConfigORM.last_polled_at,
            DataSourcePollingConfigORM.last_status,
            DataSourcePollingConfigORM.last_error,
        )
        .join(
            DataSourcePollingConfigORM,
            WorkspaceDataSourceORM.id == DataSourcePollingConfigORM.data_source_id,
            isouter=True,
        )
        .where(WorkspaceDataSourceORM.deleted_at.is_(None))
    )
    try:
        async with asyncio.timeout(_BUDGET_DB):
            factory = get_session_factory(PoolRole.READONLY)
            async with factory() as session:
                rows = (await session.execute(stmt)).all()
    except Exception as exc:
        logger.warning("stats-polling probe failed: %s", exc)
        return None

    now = datetime.now(timezone.utc)
    by_status: dict[str, int] = {}
    overdue = 0
    errors = []
    for row in rows:
        status_key = row.last_status or "never"
        by_status[status_key] = by_status.get(status_key, 0) + 1
        if row.is_enabled and (row.interval_seconds or 0) > 0:
            polled = _parse_iso(row.last_polled_at)
            if polled is None or (now - polled).total_seconds() > 2 * row.interval_seconds:
                overdue += 1
        if row.last_error:
            errors.append({
                "dataSourceId": row.data_source_id,
                "workspaceId": row.workspace_id,
                "label": row.label,
                "lastPolledAt": row.last_polled_at,
                "lastError": row.last_error[:200],
            })
    errors.sort(key=lambda e: e["lastPolledAt"] or "", reverse=True)
    return {"byStatus": by_status, "overdue": overdue, "recentErrors": errors[:5]}


async def probe_reconciliation() -> Optional[dict]:
    """Sweep liveness + fleet breaker count.

    ``stopped`` matches the Freshness pulse: last non-preview run older
    than three resolved check intervals, and only while automation is on.
    A missing first run is ``notYetRun``, not an outage.
    """
    from sqlalchemy import func, select

    from backend.app.db.engine import PoolRole, get_session_factory
    from backend.app.services.aggregation.models import (
        AggregationDataSourceStateORM,
        ReconcileRunORM,
    )
    from backend.app.services.aggregation.service import (
        AGGREGATION_RECONCILE_ENABLED,
        read_global_cadence,
        resolve_reconcile_interval,
    )

    try:
        async with asyncio.timeout(_BUDGET_DB):
            factory = get_session_factory(PoolRole.READONLY)
            async with factory() as session:
                last_started = (await session.execute(
                    select(ReconcileRunORM.started_at)
                    .where(ReconcileRunORM.mode != "preview")
                    .order_by(ReconcileRunORM.started_at.desc())
                    .limit(1)
                )).scalar()
                suspended_count = (await session.execute(
                    select(func.count())
                    .select_from(AggregationDataSourceStateORM)
                    .where(
                        AggregationDataSourceStateORM.drift_state
                        == "suspended"
                    )
                )).scalar() or 0
                cadence = await read_global_cadence(session)
    except Exception as exc:
        logger.warning("reconciliation probe failed: %s", exc)
        return None

    interval = resolve_reconcile_interval(
        None, getattr(cadence, "reconcile_check_interval_secs", None),
    )
    enabled = getattr(cadence, "reconcile_enabled", None)
    if enabled is None:
        enabled = AGGREGATION_RECONCILE_ENABLED

    last = _parse_iso(last_started)
    age_secs: Optional[float] = None
    if last is not None:
        age_secs = max(
            0.0, (datetime.now(timezone.utc) - last).total_seconds(),
        )
    stopped = bool(
        enabled
        and last is not None
        and interval > 0
        and age_secs is not None
        and age_secs >= 3 * interval
    )
    return {
        "enabled": bool(enabled),
        "intervalSecs": interval,
        "lastStartedAt": last_started,
        "stopped": stopped,
        "notYetRun": last_started is None,
        "suspendedCount": int(suspended_count),
    }


async def probe_outbox(app_state) -> Optional[dict]:
    """Transactional-outbox backlog — the event-delivery lag signal."""
    from sqlalchemy import func, select

    from backend.app.db.engine import PoolRole, get_session_factory
    from backend.app.db.models import OutboxEventORM

    stmt = select(
        func.count().label("pending"),
        func.min(OutboxEventORM.created_at).label("oldest"),
    ).where(OutboxEventORM.processed.is_(False))
    try:
        async with asyncio.timeout(_BUDGET_DB):
            factory = get_session_factory(PoolRole.READONLY)
            async with factory() as session:
                row = (await session.execute(stmt)).one()
    except Exception as exc:
        logger.warning("outbox probe failed: %s", exc)
        return None

    oldest_age_s: Optional[float] = None
    oldest = _parse_iso(row.oldest)
    if oldest is not None:
        oldest_age_s = max(0.0, (datetime.now(timezone.utc) - oldest).total_seconds())

    # Relay ownership is role-based (controlplane/dev own it); when this
    # process isn't the owner the task is absent → None, not a fault.
    task = getattr(app_state, "_outbox_relay_task", None)
    relay_alive = (not task.done()) if task is not None else None

    return {
        "pending": row.pending,
        "oldestPendingAgeS": round(oldest_age_s, 1) if oldest_age_s is not None else None,
        "relayAlive": relay_alive,
    }


async def probe_overview(app_state) -> Optional[dict]:
    """System-at-a-glance inventory — the key components and their scale.

    Versioned-graph metrics (graphs, commits, open reviews) are scoped to
    graphs backed by a data source that still exists, so the numbers reflect
    LIVE entities — not the orphaned/seed graphs the store never GCs."""
    from sqlalchemy import and_, func, select

    from backend.app.db.engine import PoolRole, get_session_factory

    out: dict = {}

    # Management inventory (small tables — exact counts are cheap).
    present_ids: list[str] = []
    try:
        from backend.app.db.models import (
            ProviderORM, WorkspaceDataSourceORM, WorkspaceORM,
        )

        async with asyncio.timeout(_BUDGET_DB):
            async with get_session_factory(PoolRole.READONLY)() as s:
                out["workspaces"] = (await s.execute(
                    select(func.count()).select_from(WorkspaceORM))).scalar()
                present_ids = list((await s.execute(
                    select(WorkspaceDataSourceORM.id)
                    .where(WorkspaceDataSourceORM.deleted_at.is_(None)))).scalars().all())
                out["dataSources"] = len(present_ids)
                total_p, active_p = (await s.execute(select(
                    func.count(),
                    func.count().filter(ProviderORM.is_active.is_(True)),
                ).select_from(ProviderORM))).one()
                out["providers"] = {"total": total_p, "active": active_p}
    except Exception as exc:
        logger.warning("overview management counts failed: %s", exc)

    # Versioned-graph scale (graphver store), scoped to live data sources.
    try:
        from backend.app.services.versioning.db import graphver_session
        from backend.app.services.versioning.models import (
            CommitORM, GraphORM, MergeRequestORM,
        )

        live_graph_ids = select(GraphORM.id).where(
            GraphORM.data_source_id.in_(present_ids))
        async with asyncio.timeout(_BUDGET_DB):
            async with graphver_session() as s:
                total_graphs = (await s.execute(
                    select(func.count()).select_from(GraphORM))).scalar() or 0
                live_graphs = (await s.execute(
                    select(func.count()).where(
                        GraphORM.data_source_id.in_(present_ids))
                    .select_from(GraphORM))).scalar() or 0
                out["versionedGraphs"] = live_graphs
                # Graphs whose data source no longer exists — the store has no
                # GC, so these accumulate (cleanup candidates).
                out["orphanedGraphs"] = max(0, total_graphs - live_graphs)
                out["openReviews"] = (await s.execute(
                    select(func.count()).select_from(MergeRequestORM).where(and_(
                        MergeRequestORM.status.in_(
                            ("open", "conflicts", "mergeable", "approved")),
                        MergeRequestORM.graph_id.in_(live_graph_ids))))).scalar()
                out["commits"] = (await s.execute(
                    select(func.count()).select_from(CommitORM).where(
                        CommitORM.graph_id.in_(live_graph_ids)))).scalar()
    except Exception as exc:
        logger.warning("overview graphver scale failed: %s", exc)

    return out or None


async def probe_bootstrap_jobs() -> Optional[dict]:
    """"Enable version control" jobs — the one long-running job with no ops surface.

    This exists because its absence was worse than a blind spot. A bootstrap parks the
    graph's projection watermark at genesis so the projector never touches the pinned
    SOURCE graph mid-copy — which means `probe_projection_lag` sees lag=0, status='idle'
    and no error, and counts the graph as FRESH. A 7.7M-entity copy grinding for an hour,
    or one that FAILED three days ago and is silently blocking writes to that data source,
    both render on the dashboard as "in sync". Nothing else reads `graphver.jobs`.

    `stalled` is the honest liveness question: a `running` job whose heartbeat has aged past
    the takeover threshold and that no worker has picked up — i.e. the whole worker tier is
    gone, not merely one pod. It reuses `claim_one`'s own staleness predicate, so the
    dashboard and the worker cannot disagree about what "dead" means.
    """
    from sqlalchemy import case, func, select

    from backend.app.services.versioning import config as gv_config
    from backend.app.services.versioning.bootstrap_worker import (
        BOOTSTRAP_JOB_TYPE,
        _now_minus,
    )
    from backend.app.services.versioning.db import graphver_session
    from backend.app.services.versioning.models import JobORM

    try:
        async with asyncio.timeout(_BUDGET_DB):
            stale_before = _now_minus(gv_config.INGEST_STALE_SECS)
            async with graphver_session() as s:
                counts = dict((await s.execute(
                    select(JobORM.status, func.count())
                    .where(JobORM.job_type == BOOTSTRAP_JOB_TYPE)
                    .group_by(JobORM.status))).all())
                stalled = (await s.scalar(
                    select(func.count()).select_from(JobORM).where(
                        JobORM.job_type == BOOTSTRAP_JOB_TYPE,
                        JobORM.status == "running",
                        JobORM.updated_at < stale_before))) or 0
                # Whose, and how far — enough to act on without opening a SQL client.
                worst = (await s.execute(
                    select(JobORM.id, JobORM.graph_id, JobORM.data_source_id,
                           JobORM.workspace_id, JobORM.status, JobORM.current_phase,
                           JobORM.processed, JobORM.total, JobORM.error_message,
                           JobORM.updated_at)
                    .where(JobORM.job_type == BOOTSTRAP_JOB_TYPE,
                           JobORM.status.in_(("running", "pending", "failed")))
                    .order_by(case((JobORM.status == "failed", 0), else_=1),
                              JobORM.updated_at.asc())
                    .limit(8))).all()
    except Exception as exc:
        logger.warning("bootstrap-jobs probe failed: %s", exc)
        return None

    return {
        "running": int(counts.get("running", 0)),
        "pending": int(counts.get("pending", 0)),
        "failed": int(counts.get("failed", 0)),
        "completed": int(counts.get("completed", 0)),
        "stalled": int(stalled),
        "jobs": [{
            "jobId": r[0], "graphId": r[1], "dataSourceId": r[2], "workspaceId": r[3],
            "status": r[4], "phase": r[5], "processed": int(r[6] or 0),
            "total": int(r[7] or 0), "error": r[8], "updatedAt": r[9],
        } for r in worst],
    }
