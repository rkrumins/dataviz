"""Worker fleet registry, memory-aware claim policy, and fleet reporting.

Each worker process registers itself in the job-bus Redis
(``agg:worker:{worker_id}``, TTL'd hash refreshed by the consumer loop)
with its live load: active jobs, large-job count, RSS vs cgroup memory
limit, and drain state. The control plane's ``GET /aggregation/workers``
aggregates those entries plus the job-stream depth so operators can see
backlog vs capacity per worker.

The claim policy is what stops one pod from OOMing itself while a
sibling idles: before executing a delivered job the consumer asks
``WorkerFleetMember.claim_decision`` —

* **drain**: shutting down, never claim;
* **memory high-water** (``AGGREGATION_MEM_HIGH_WATER_PCT`` of the
  cgroup limit, default 75%): RSS too high to take on more work;
* **large-job cap** (``AGGREGATION_MAX_LARGE_JOBS_PER_WORKER``, default
  1): a job whose known edge count exceeds
  ``AGGREGATION_LARGE_JOB_EDGE_THRESHOLD`` (default 500k) counts as
  large — the in-memory aggregation of two such jobs on one pod is the
  OOM scenario.

A deferred job is re-enqueued (XADD) after a short jittered delay so an
idle pod picks it up; exec locks and cancel flags already make duplicate
delivery safe. Everything here fails OPEN — a Redis or /proc hiccup
degrades to "claim allowed" and an absent registry entry simply drops
that worker from the fleet view.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import platform
import time
from datetime import datetime, timezone
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

WORKER_KEY_PREFIX = "agg:worker:"
WORKER_TTL_SECS = int(os.getenv("AGGREGATION_WORKER_TTL_SECS", "30"))

MEM_HIGH_WATER_PCT = float(os.getenv("AGGREGATION_MEM_HIGH_WATER_PCT", "75"))
LARGE_JOB_EDGE_THRESHOLD = int(
    os.getenv("AGGREGATION_LARGE_JOB_EDGE_THRESHOLD", "500000")
)
MAX_LARGE_JOBS_PER_WORKER = int(
    os.getenv("AGGREGATION_MAX_LARGE_JOBS_PER_WORKER", "1")
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def read_rss_mb() -> Optional[float]:
    """Current process RSS from /proc/self/status (Linux; None elsewhere)."""
    try:
        with open("/proc/self/status") as fh:
            for line in fh:
                if line.startswith("VmRSS:"):
                    return int(line.split()[1]) / 1024.0  # kB → MB
    except Exception:
        return None
    return None


def read_mem_limit_mb() -> Optional[float]:
    """Cgroup memory limit (v2 then v1). None when unlimited/unknown."""
    for path in ("/sys/fs/cgroup/memory.max",
                 "/sys/fs/cgroup/memory/memory.limit_in_bytes"):
        try:
            raw = open(path).read().strip()
            if raw == "max":
                return None
            value = int(raw)
            if value <= 0 or value >= 1 << 60:  # sentinel for "unlimited"
                return None
            return value / (1024.0 * 1024.0)
        except Exception:
            continue
    return None


class WorkerFleetMember:
    """This process's entry in the fleet registry."""

    def __init__(self, redis_client: Any, worker_id: str, concurrency: int) -> None:
        self._redis = redis_client
        self.worker_id = worker_id
        self.concurrency = concurrency
        self.started_at = _now_iso()
        self.drain = False
        self.active_jobs: Dict[str, Dict[str, Any]] = {}
        self._warned_at = 0.0

    # -- job bookkeeping --------------------------------------------------

    def register_job(self, job_id: str, *, graph_name: Optional[str], large: bool) -> None:
        self.active_jobs[job_id] = {
            "jobId": job_id, "graphName": graph_name, "large": large,
            "phase": None,
        }

    def set_job_phase(self, job_id: str, phase: Optional[str]) -> None:
        entry = self.active_jobs.get(job_id)
        if entry is not None:
            entry["phase"] = phase

    def unregister_job(self, job_id: str) -> None:
        self.active_jobs.pop(job_id, None)

    @property
    def large_jobs_active(self) -> int:
        return sum(1 for j in self.active_jobs.values() if j.get("large"))

    # -- claim policy ------------------------------------------------------

    @staticmethod
    def is_large(total_edges: Optional[int]) -> bool:
        return bool(total_edges) and int(total_edges) >= LARGE_JOB_EDGE_THRESHOLD

    def claim_decision(self, *, total_edges: Optional[int]) -> Optional[str]:
        """None = claim allowed; otherwise a human-readable defer reason."""
        if self.drain:
            return "worker is draining"
        rss = read_rss_mb()
        limit = read_mem_limit_mb()
        if rss is not None and limit is not None and limit > 0:
            pct = 100.0 * rss / limit
            if pct >= MEM_HIGH_WATER_PCT:
                return (
                    f"memory high-water: rss {rss:.0f}MB is {pct:.0f}% of the "
                    f"{limit:.0f}MB limit (threshold {MEM_HIGH_WATER_PCT:.0f}%)"
                )
        if self.is_large(total_edges) and self.large_jobs_active >= MAX_LARGE_JOBS_PER_WORKER:
            return (
                f"large-job cap: {self.large_jobs_active} large job(s) active "
                f"(cap {MAX_LARGE_JOBS_PER_WORKER}, job has {total_edges} edges)"
            )
        return None

    # -- registry heartbeat -------------------------------------------------

    async def heartbeat(self) -> None:
        """Refresh this worker's registry entry (TTL'd). Fail-open."""
        try:
            payload = {
                "worker_id": self.worker_id,
                "hostname": platform.node(),
                "pid": os.getpid(),
                "started_at": self.started_at,
                "last_heartbeat_at": _now_iso(),
                "concurrency": self.concurrency,
                "active_jobs": list(self.active_jobs.values()),
                "large_jobs_active": self.large_jobs_active,
                "rss_mb": read_rss_mb(),
                "mem_limit_mb": read_mem_limit_mb(),
                "drain": self.drain,
            }
            key = f"{WORKER_KEY_PREFIX}{self.worker_id}"
            await self._redis.set(key, json.dumps(payload), ex=WORKER_TTL_SECS)
        except Exception as exc:
            now = time.monotonic()
            if now - self._warned_at > 60:
                self._warned_at = now
                logger.warning("fleet heartbeat failed (continuing): %s", exc)

    async def deregister(self) -> None:
        try:
            await self._redis.delete(f"{WORKER_KEY_PREFIX}{self.worker_id}")
        except Exception:
            pass


async def read_fleet() -> "Any":
    """Aggregate all live worker entries + queue depth for the API."""
    from .redis_client import get_redis, JOBS_STREAM, CONSUMER_GROUP
    from .schemas import WorkersResponse, WorkerInfo, WorkerActiveJob

    redis_client = get_redis()
    workers = []
    try:
        cursor = 0
        keys = []
        while True:
            cursor, chunk = await redis_client.scan(
                cursor=cursor, match=f"{WORKER_KEY_PREFIX}*", count=100,
            )
            keys.extend(chunk)
            if cursor == 0:
                break
        for key in keys:
            raw = await redis_client.get(key)
            if not raw:
                continue
            try:
                data = json.loads(raw)
            except (TypeError, ValueError):
                continue
            workers.append(WorkerInfo(
                worker_id=str(data.get("worker_id") or key),
                hostname=data.get("hostname"),
                pid=data.get("pid"),
                started_at=data.get("started_at"),
                last_heartbeat_at=data.get("last_heartbeat_at"),
                concurrency=int(data.get("concurrency") or 0),
                active_jobs=[
                    WorkerActiveJob(
                        job_id=str(j.get("jobId")),
                        graph_name=j.get("graphName"),
                        phase=j.get("phase"),
                        large=bool(j.get("large")),
                    )
                    for j in (data.get("active_jobs") or [])
                    if isinstance(j, dict) and j.get("jobId")
                ],
                large_jobs_active=int(data.get("large_jobs_active") or 0),
                rss_mb=data.get("rss_mb"),
                mem_limit_mb=data.get("mem_limit_mb"),
                drain=bool(data.get("drain")),
            ))
    except Exception as exc:
        logger.warning("fleet read failed (returning partial): %s", exc)

    queue_depth = 0
    queue_pending = 0
    try:
        queue_depth = int(await redis_client.xlen(JOBS_STREAM))
        pending = await redis_client.xpending(JOBS_STREAM, CONSUMER_GROUP)
        queue_pending = int(pending.get("pending") or 0) if isinstance(pending, dict) else 0
    except Exception:
        pass

    workers.sort(key=lambda w: w.worker_id)
    return WorkersResponse(
        workers=workers, queue_depth=queue_depth, queue_pending=queue_pending,
    )
