"""Snapshot assembly for the super-admin Infrastructure dashboard.

On-demand fan-in: all probes run concurrently (each self-bounds its I/O,
see ``probes.py``), so the snapshot's wall time is the largest single
probe budget (~2s worst case), never the sum. The assembled snapshot is
cached for ``SYSTEM_STATUS_CACHE_TTL_S`` (default 10s) behind a lock so
concurrent admin viewers share one probe sweep — zero load when nobody
is watching, bounded load when everybody is.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from datetime import datetime, timezone
from typing import Optional

from . import probes

logger = logging.getLogger(__name__)

_cache: Optional[tuple[float, dict]] = None
_lock = asyncio.Lock()


def _ttl() -> float:
    return float(os.getenv("SYSTEM_STATUS_CACHE_TTL_S", "10"))


def _with_age(snapshot: dict, cached_at: float) -> dict:
    return {**snapshot, "cacheAgeMs": int((time.monotonic() - cached_at) * 1000)}


async def get_system_snapshot(app_state) -> dict:
    """Return the (possibly cached) infrastructure snapshot."""
    global _cache
    if _cache is not None and time.monotonic() - _cache[0] < _ttl():
        return _with_age(_cache[1], _cache[0])
    async with _lock:
        # Re-check after the wait: another caller may have assembled while
        # we queued on the lock (stampede guard).
        if _cache is not None and time.monotonic() - _cache[0] < _ttl():
            return _with_age(_cache[1], _cache[0])
        snapshot = await _assemble(app_state)
        _cache = (time.monotonic(), snapshot)
        return _with_age(snapshot, _cache[0])


def _coerce_service(result, key: str, label: str) -> dict:
    """Belt-and-braces: a probe that leaked an exception through
    ``gather(return_exceptions=True)`` becomes a down tile, never a 500."""
    if isinstance(result, BaseException):
        logger.warning("probe %s raised: %s", key, result)
        return {"key": key, "label": label, "status": "down",
                "latencyMs": None, "error": str(result)[:200], "detail": {}}
    return result


def _coerce_data(result):
    if isinstance(result, BaseException):
        logger.warning("data probe raised: %s", result)
        return None
    return result


def _degrade(tile: dict, reason: str) -> None:
    """Downgrade a healthy tile to degraded with an appended reason."""
    if tile["status"] == "healthy":
        tile["status"] = "degraded"
    tile["detail"].setdefault("reasons", []).append(reason)


async def _assemble(app_state) -> dict:
    results = await asyncio.gather(
        probes.probe_viz_service(app_state),
        probes.probe_management_db(),
        probes.probe_graphver_db(),
        probes.probe_bus_redis(),
        probes.probe_cache_redis(),
        probes.probe_falkordb(),
        probes.probe_aggregation_controlplane(),
        probes.probe_aggregation_worker(),
        probes.probe_stats_service(),
        probes.probe_graph_service(),
        probes.probe_streams(),
        probes.probe_projection_lag(),
        probes.probe_aggregation_jobs(app_state),
        probes.probe_stats_polling(),
        probes.probe_outbox(app_state),
        return_exceptions=True,
    )
    (viz, mgmt_db, gv_db, bus_redis, cache_redis, falkordb,
     controlplane, worker, stats_svc, graph_svc,
     streams, projection, agg_jobs, stats_polling, outbox) = results

    services = [
        _coerce_service(viz, "vizService", "Viz Service"),
        _coerce_service(mgmt_db, "managementDb", "Postgres · Management"),
        _coerce_service(gv_db, "graphverDb", "Postgres · GraphVer"),
        _coerce_service(bus_redis, "busRedis", "Redis · Bus"),
        _coerce_service(cache_redis, "cacheRedis", "Redis · Cache"),
        _coerce_service(falkordb, "falkordb", "FalkorDB"),
        _coerce_service(controlplane, "aggregationControlplane", "Aggregation Controlplane"),
        _coerce_service(worker, "aggregationWorker", "Aggregation Worker"),
        _coerce_service(stats_svc, "statsService", "Stats Service"),
        _coerce_service(graph_svc, "graphService", "Graph Service"),
    ]
    streams = _coerce_data(streams)
    projection = _coerce_data(projection)
    agg_jobs = _coerce_data(agg_jobs)
    stats_polling = _coerce_data(stats_polling)
    outbox = _coerce_data(outbox)

    by_key = {tile["key"]: tile for tile in services}

    # ── Cross-probe verdict finishing (work signals over liveness) ──
    # Worker: stuck jobs need the jobs probe's DB read.
    if agg_jobs and (agg_jobs.get("stuckJobs") or 0) > 0:
        _degrade(by_key["aggregationWorker"], f"{agg_jobs['stuckJobs']} stuck job(s)")
    # Stats service: it may be HTTP-unreachable (one replica behind a k8s
    # Service, or internal port) while demonstrably consuming its streams.
    stats_tile = by_key["statsService"]
    insights_streams = ((streams or {}).get("insights") or {}).get("streams") or {}
    insights_consumers = [d.get("consumers") for d in insights_streams.values()
                          if d.get("consumers") is not None]
    if stats_tile["status"] == "down" and insights_consumers \
            and max(insights_consumers) > 0:
        stats_tile["status"] = "degraded"
        stats_tile["detail"].setdefault("reasons", []).append(
            "HTTP unreachable (consuming streams)")
        stats_tile["detail"]["consumers"] = max(insights_consumers)
    if stats_polling and (stats_polling.get("overdue") or 0) > 0:
        _degrade(stats_tile, f"{stats_polling['overdue']} data source(s) overdue")
    insights_dlq = ((streams or {}).get("insights") or {}).get("dlq") or {}
    if (insights_dlq.get("len") or 0) > 0:
        _degrade(stats_tile, f"DLQ {insights_dlq['len']}")

    # ── Rollup ──
    if by_key["managementDb"]["status"] == "down":
        overall = "down"
    elif any(tile["status"] in ("degraded", "down") for tile in services):
        overall = "degraded"
    else:
        overall = "healthy"

    return {
        "status": overall,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "services": services,
        "streams": streams,
        "projection": projection,
        "aggregationJobs": agg_jobs,
        "statsPolling": stats_polling,
        "outbox": outbox,
    }
