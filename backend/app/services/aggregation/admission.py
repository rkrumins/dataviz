"""Distributed write-admission control for aggregation materialization.

Protects a FalkorDB endpoint from being stampeded by aggregation writes
when the worker fleet scales horizontally (HPA can run 10 pods, each with
``WORKER_CONCURRENCY`` jobs — the provider's in-process write semaphore
only throttles one pod). Two primitives, both on the existing job-bus
Redis (the same instance that already carries exec locks and cancel
flags, so no new dependency):

1. **Per-graph write lease** — ``agg:graphwrite:{endpoint}:{graph}``.
   One materialization job writes to a graph at a time ACROSS ALL PODS.
   FalkorDB serializes writes per graph anyway; two jobs interleaving
   MERGEs on one graph just doubles queue depth for zero throughput.
   Acquired for the duration of the job, renewed by a background task,
   released on completion. A crashed holder self-heals via TTL.
   Contention raises ``ProviderBusy`` so the worker's existing
   park-and-resume path (not the retry budget) handles it.

2. **Per-endpoint write slots** — ``agg:writeslots:{endpoint}``. A Lua
   sorted-set semaphore capping how many aggregation write queries are
   in flight against one FalkorDB endpoint across all pods (default 2 —
   matched to the endpoint's worker THREAD_COUNT so interactive readers
   always have a thread). Held per write query, not per job: a job that
   is scanning or computing in Python holds no slot. Stale holders
   (crashed mid-write) are pruned by score.

**Failure mode: Redis down ⇒ fail OPEN.** If the bus Redis is
unreachable the controller logs (rate-limited) and admits the write —
the provider's per-process write semaphore, latency-quiesce circuit,
server-side query timeouts and AIMD pacing still bound the damage, and
if the bus is down no NEW jobs dispatch anyway. Admission must never be
the thing that deadlocks a running job.
"""

from __future__ import annotations

import asyncio
import logging
import os
import random
import time
import uuid
from typing import Any, Optional

logger = logging.getLogger(__name__)

_SLOT_LIMIT = int(os.getenv("FALKORDB_ENDPOINT_WRITE_SLOTS", "2"))
_SLOT_STALE_SECS = float(os.getenv("AGGREGATION_SLOT_STALE_SECS", "260"))
"""Holders older than this are pruned. Must exceed the longest single
write query (server TIMEOUT_MAX 180s + slot-wait/event-loop jitter) or
an in-flight write's slot could be reclaimed and the endpoint
over-admitted."""
_SLOT_WAIT_MAX_SECS = float(os.getenv("AGGREGATION_SLOT_WAIT_MAX_SECS", "120"))
"""Upper bound on waiting for a slot before proceeding anyway (fail-open
bias: local gates still apply, and an indefinitely-starved job is worse
than a briefly over-admitted endpoint)."""

_GRAPH_LEASE_TTL_MS = int(os.getenv("AGGREGATION_GRAPH_LEASE_TTL_MS", "60000"))
_GRAPH_LEASE_RENEW_SECS = _GRAPH_LEASE_TTL_MS / 1000 / 3

_ACQUIRE_SLOT_LUA = """
local key = KEYS[1]
local now = tonumber(ARGV[1])
local stale = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]
redis.call('ZREMRANGEBYSCORE', key, 0, now - stale)
if redis.call('ZCARD', key) < limit then
  redis.call('ZADD', key, now, member)
  redis.call('EXPIRE', key, 600)
  return 1
end
return 0
"""

_RELEASE_IF_OWNED_LUA = """
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
"""


def endpoint_key(provider: Any) -> str:
    """Stable identity for the FalkorDB endpoint a provider talks to.
    Prefers host:port from the connection config; falls back to the graph
    name (still correct — just scopes the budget per graph)."""
    cfg = getattr(provider, "_conn_cfg", None)
    host = getattr(cfg, "host", None)
    port = getattr(cfg, "port", None)
    if host and port:
        return f"{host}:{port}"
    return f"graph:{getattr(provider, '_graph_name', 'unknown')}"


class GraphLease:
    """Held per materialization job; renewed in the background."""

    def __init__(self, key: str, token: str, renew_task: asyncio.Task) -> None:
        self.key = key
        self.token = token
        self.renew_task = renew_task


class _SlotContext:
    """Async context manager for one write-query admission slot."""

    def __init__(self, admission: "AggregationAdmission", provider: Any) -> None:
        self._admission = admission
        self._provider = provider
        self._member: Optional[str] = None
        self._key: Optional[str] = None

    async def __aenter__(self) -> "_SlotContext":
        self._key, self._member = await self._admission._acquire_slot(self._provider)
        return self

    async def __aexit__(self, *exc_info: Any) -> None:
        if self._key and self._member:
            await self._admission._release_slot(self._key, self._member)


class AggregationAdmission:
    """Shared write budget for aggregation jobs across all worker pods."""

    def __init__(self, redis_client: Any) -> None:
        self._redis = redis_client
        self._warned_at = 0.0

    # -- fail-open logging ---------------------------------------------------

    def _warn_fail_open(self, what: str, exc: Exception) -> None:
        now = time.monotonic()
        if now - self._warned_at > 60:
            self._warned_at = now
            logger.warning(
                "aggregation admission: %s failed (%s) — FAILING OPEN to "
                "per-process limits. Distributed write protection is degraded "
                "until the job-bus Redis recovers.", what, exc,
            )

    # -- per-graph lease -------------------------------------------------------

    async def acquire_graph_lease(
        self, provider: Any, owner: str = "",
    ) -> Optional[GraphLease]:
        """Acquire the exclusive per-graph write lease or raise
        ``ProviderBusy`` (the worker parks and resumes — not a retry).
        Returns None (fail open) if Redis is unavailable.

        ``owner`` identifies the holder (job id) — embedded in the lease
        value so a CONFLICTING claimant can name who is writing instead
        of reporting an anonymous "lease held". Anonymous conflicts were
        undiagnosable in production (an invisible in-process shadow run
        held the lease while every user-triggered job parked)."""
        graph = getattr(provider, "_graph_name", "unknown")
        key = f"agg:graphwrite:{endpoint_key(provider)}:{graph}"
        host = os.getenv("HOSTNAME", "") or "unknown-host"
        token = f"{uuid.uuid4().hex}|{owner or 'unattributed'}|{host}"
        try:
            ok = await self._redis.set(key, token, nx=True, px=_GRAPH_LEASE_TTL_MS)
        except Exception as exc:
            self._warn_fail_open("graph-lease acquire", exc)
            return None
        if not ok:
            holder_desc = "unknown holder"
            ttl_desc = ""
            try:
                raw = await self._redis.get(key)
                if raw is not None:
                    val = raw.decode() if isinstance(raw, (bytes, bytearray)) else str(raw)
                    parts = val.split("|")
                    if len(parts) == 3:
                        holder_desc = f"job {parts[1]} on {parts[2]}"
                ttl_ms = await self._redis.pttl(key)
                if isinstance(ttl_ms, int) and ttl_ms > 0:
                    ttl_desc = (
                        f"; lease auto-expires in {ttl_ms / 1000:.0f}s if "
                        f"the holder dies"
                    )
            except Exception:
                pass
            from backend.common.adapters import ProviderBusy
            raise ProviderBusy(
                provider_name=graph,
                reason=(
                    f"another aggregation job is writing to this graph "
                    f"(cross-pod write lease held by {holder_desc}{ttl_desc})"
                ),
                retry_after_seconds=30,
            )

        async def _renew() -> None:
            try:
                while True:
                    await asyncio.sleep(_GRAPH_LEASE_RENEW_SECS)
                    try:
                        # Refresh TTL only while we still own the lease.
                        current = await self._redis.get(key)
                        if current != token:
                            logger.warning(
                                "aggregation admission: graph lease %s lost "
                                "(holder changed); stopping renewal.", key,
                            )
                            return
                        await self._redis.pexpire(key, _GRAPH_LEASE_TTL_MS)
                    except Exception as exc:
                        self._warn_fail_open("graph-lease renew", exc)
            except asyncio.CancelledError:
                pass

        task = asyncio.create_task(_renew())
        return GraphLease(key, token, task)

    async def release_graph_lease(self, lease: Optional[GraphLease]) -> None:
        if lease is None:
            return
        lease.renew_task.cancel()
        try:
            await self._redis.eval(
                _RELEASE_IF_OWNED_LUA, 1, lease.key, lease.token,
            )
        except Exception as exc:
            # TTL cleans up within 60s — releasing is best-effort.
            self._warn_fail_open("graph-lease release", exc)

    # -- per-endpoint write slots -------------------------------------------------

    def write_slot(self, provider: Any) -> _SlotContext:
        """Async context manager gating one write query."""
        return _SlotContext(self, provider)

    async def _acquire_slot(self, provider: Any) -> tuple:
        key = f"agg:writeslots:{endpoint_key(provider)}"
        member = uuid.uuid4().hex
        deadline = time.monotonic() + _SLOT_WAIT_MAX_SECS
        while True:
            try:
                got = await self._redis.eval(
                    _ACQUIRE_SLOT_LUA, 1, key,
                    time.time(), _SLOT_STALE_SECS, _SLOT_LIMIT, member,
                )
            except Exception as exc:
                self._warn_fail_open("write-slot acquire", exc)
                return None, None
            if int(got or 0) == 1:
                return key, member
            if time.monotonic() >= deadline:
                logger.warning(
                    "aggregation admission: no write slot on %s after %.0fs — "
                    "proceeding anyway (fail-open bias).",
                    key, _SLOT_WAIT_MAX_SECS,
                )
                return None, None
            # Jittered wait — doubles as natural pacing under contention.
            await asyncio.sleep(2.0 + random.uniform(0, 3.0))

    async def _release_slot(self, key: str, member: str) -> None:
        try:
            await self._redis.zrem(key, member)
        except Exception as exc:
            # Score-based pruning reclaims it after _SLOT_STALE_SECS.
            self._warn_fail_open("write-slot release", exc)
