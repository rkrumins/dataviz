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

3. **Per-node reservation ledger** — ``agg:reserve:{node}``. One HASH per
   graph-store node: field = job id, value = the bytes that job has been
   allowed to write but the node's ``used_memory`` does not show yet. The
   write budget subtracts every OTHER job's entry from the node's free
   memory, so two rebuilds racing onto one node cannot both pass on the
   same headroom. Renewed in the background; a crashed holder's entry
   expires (its ``expires_at``, pruned on read) and the key itself lives
   only while someone keeps writing it. Keyed by the node the SHARD
   READING names (``ShardMemory.endpoint`` — the live owner of the graph),
   not by ``endpoint_key`` (the connection config's host:port, which in
   cluster mode is a seed address): two rebuilds on one node must meet in
   the same ledger whatever address they connected through.

**Failure mode: Redis down ⇒ fail OPEN.** If the bus Redis is
unreachable the controller logs (rate-limited) and admits the write —
the provider's per-process write semaphore, latency-quiesce circuit,
server-side query timeouts and AIMD pacing still bound the damage, and
if the bus is down no NEW jobs dispatch anyway. Admission must never be
the thing that deadlocks a running job.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import random
import time
import uuid
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

_SLOT_LIMIT = int(os.getenv("FALKORDB_ENDPOINT_WRITE_SLOTS", "2"))
_SLOT_STALE_SECS = float(os.getenv("AGGREGATION_SLOT_STALE_SECS", "660"))
"""Holders older than this are pruned. Must exceed the longest single
write query the pipeline may send — the write-timeout knob's maximum
(600 s; the store's TIMEOUT_MAX can be raised to it at runtime from
Infrastructure) plus slot-wait/event-loop jitter — or an in-flight write's
slot could be reclaimed and the endpoint over-admitted."""
_SLOT_WAIT_MAX_SECS = float(os.getenv("AGGREGATION_SLOT_WAIT_MAX_SECS", "120"))
"""Upper bound on waiting for a slot before proceeding anyway (fail-open
bias: local gates still apply, and an indefinitely-starved job is worse
than a briefly over-admitted endpoint)."""

_GRAPH_LEASE_TTL_MS = int(os.getenv("AGGREGATION_GRAPH_LEASE_TTL_MS", "60000"))
_GRAPH_LEASE_RENEW_SECS = _GRAPH_LEASE_TTL_MS / 1000 / 3
_RESERVATION_TTL_MS = 2 * _GRAPH_LEASE_TTL_MS
"""A reservation outlives a missed renewal or two, never a dead job: the
entry is renewed on the lease cadence and expires at twice the lease TTL."""

_READ_PRESSURE_PREFIX = "agg:readpressure"
_READ_PRESSURE_POLL_SECS = float(os.getenv("AGGREGATION_READ_PRESSURE_POLL_SECS", "2"))
"""How long a read-pressure verdict is reused before Redis is asked again.
One GET per write batch would already be cheap; one per couple of seconds
is free. The key's own TTL (``AGGREGATION_READ_PRESSURE_TTL_S``, stamped
by the web tier — see ``read_pressure.py``) bounds how stale a verdict
can be."""


def read_pressure_key(endpoint: str) -> str:
    """Where the web tier says interactive reads are starving on ``endpoint``."""
    return f"{_READ_PRESSURE_PREFIX}:{endpoint}"

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

# Atomic compare-and-replace: take the lease over only if it still holds
# the exact value we observed (no window for a third party's fresh lease
# to be clobbered).
_TAKE_OVER_IF_VALUE_LUA = """
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
  return 1
end
return 0
"""


def reservation_key(endpoint: str) -> str:
    """The ledger of one graph-store node — keyed by the node the shard
    reading names, never by ``endpoint_key`` (see the module docstring)."""
    return f"agg:reserve:{endpoint}"


def _text(value: Any) -> str:
    return value.decode() if isinstance(value, (bytes, bytearray)) else str(value)


def _parse_ledger(raw: Any, now: float) -> Tuple[Dict[str, Dict[str, Any]], List[str]]:
    """The live entries of one ledger by job id, and the job ids whose
    entries have expired or cannot be read (to prune)."""
    live: Dict[str, Dict[str, Any]] = {}
    expired: List[str] = []
    for field, value in (raw or {}).items():
        job = _text(field)
        try:
            entry = json.loads(_text(value))
            nbytes = int(entry.get("bytes") or 0)
            expires_at = float(entry.get("expires_at") or 0)
        except Exception:                                   # noqa: BLE001 — garbage is pruned
            expired.append(job)
            continue
        if expires_at <= now or nbytes <= 0:
            expired.append(job)
            continue
        live[job] = {"bytes": nbytes, "expires_at": expires_at, "host": str(entry.get("host") or "")}
    return live, expired


async def read_reservations(redis_client: Any, endpoint: str) -> Dict[str, Dict[str, Any]]:
    """Every live reservation on ``endpoint`` by job id (``bytes``,
    ``expires_at``, ``host``), expired entries pruned as a side effect.
    Raises on a bus failure — the caller decides how to fail open."""
    key = reservation_key(endpoint)
    live, expired = _parse_ledger(await redis_client.hgetall(key), time.time())
    if expired:
        try:
            await redis_client.hdel(key, *expired)
        except Exception:                                   # noqa: BLE001 — best-effort
            pass
    return live


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


class ShardReservation:
    """This job's entry in one node's ledger; renewed in the background."""

    def __init__(self, endpoint: str, job_id: str, nbytes: int) -> None:
        self.endpoint = endpoint
        self.job_id = job_id
        self.bytes = int(nbytes)
        self.renew_task: Optional[asyncio.Task] = None


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
        # endpoint key → (checked_at, reason) — see read_pressure()
        self._read_pressure_memo: dict[str, tuple[float, Optional[str]]] = {}

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
            holder_job = ""
            holder_value = None
            ttl_desc = ""
            try:
                raw = await self._redis.get(key)
                if raw is not None:
                    val = raw.decode() if isinstance(raw, (bytes, bytearray)) else str(raw)
                    holder_value = val
                    parts = val.split("|")
                    if len(parts) == 3:
                        holder_job = parts[1]
                        holder_desc = f"job {parts[1]} on {parts[2]}"
                ttl_ms = await self._redis.pttl(key)
                if isinstance(ttl_ms, int) and ttl_ms > 0:
                    ttl_desc = (
                        f"; lease auto-expires in {ttl_ms / 1000:.0f}s if "
                        f"the holder dies"
                    )
            except Exception:
                pass
            # SELF-REACQUIRE: the holder is THIS job (a retry after a
            # crash / failed release of its own previous attempt). Take
            # the lease over instead of parking on ourselves for up to a
            # full TTL — the previous attempt is dead by definition
            # (one executor per job, enforced by the exec lock).
            if owner and holder_job == owner and holder_value is not None:
                took = await self._try_take_over(key, holder_value, token)
                if took:
                    logger.info(
                        "aggregation admission: re-acquired own graph "
                        "lease for job %s (previous attempt's lease had "
                        "not expired).", owner,
                    )
                    return self._start_renew(key, token)
            from backend.common.adapters import ProviderBusy
            raise ProviderBusy(
                provider_name=graph,
                reason=(
                    f"another aggregation job is writing to this graph "
                    f"(cross-pod write lease held by {holder_desc}{ttl_desc})"
                ),
                retry_after_seconds=30,
            )

        return self._start_renew(key, token)

    def _start_renew(self, key: str, token: str) -> GraphLease:
        async def _renew() -> None:
            try:
                while True:
                    await asyncio.sleep(_GRAPH_LEASE_RENEW_SECS)
                    try:
                        # Refresh TTL only while we still own the lease.
                        current = await self._redis.get(key)
                        if isinstance(current, (bytes, bytearray)):
                            current = current.decode()
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

    async def _try_take_over(
        self, key: str, expected_value: str, new_token: str,
    ) -> bool:
        try:
            res = await self._redis.eval(
                _TAKE_OVER_IF_VALUE_LUA, 1, key,
                expected_value, new_token, str(_GRAPH_LEASE_TTL_MS),
            )
            return bool(res)
        except Exception as exc:
            self._warn_fail_open("graph-lease takeover", exc)
            return False

    async def get_lease_holder(self, provider: Any) -> Optional[tuple]:
        """(holder_job_id, raw_value) of the current graph-lease holder,
        or None. Used by the worker to detect ZOMBIE leases — a holder
        whose job row is already terminal (crashed pre-release, or an
        orphan from the pre-cancellation-fix build) that would otherwise
        block every writer until TTL (or forever while an orphan renews)."""
        graph = getattr(provider, "_graph_name", "unknown")
        key = f"agg:graphwrite:{endpoint_key(provider)}:{graph}"
        try:
            raw = await self._redis.get(key)
        except Exception:
            return None
        if raw is None:
            return None
        val = raw.decode() if isinstance(raw, (bytes, bytearray)) else str(raw)
        parts = val.split("|")
        if len(parts) != 3:
            return None
        return parts[1], val

    async def break_lease_if_holder(
        self, provider: Any, expected_value: str,
    ) -> bool:
        """Delete the graph lease iff it still holds ``expected_value``
        (atomic — a freshly acquired third-party lease is never
        clobbered). Returns True when the zombie was cleared."""
        graph = getattr(provider, "_graph_name", "unknown")
        key = f"agg:graphwrite:{endpoint_key(provider)}:{graph}"
        try:
            res = await self._redis.eval(
                _RELEASE_IF_OWNED_LUA, 1, key, expected_value,
            )
            return bool(res)
        except Exception as exc:
            self._warn_fail_open("graph-lease break", exc)
            return False

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

    # -- per-node reservation ledger ---------------------------------------------

    async def _write_reservation(self, endpoint: str, job_id: str, nbytes: int) -> None:
        key = reservation_key(endpoint)
        host = os.getenv("HOSTNAME", "") or "unknown-host"
        value = json.dumps({
            "bytes": int(nbytes),
            "expires_at": time.time() + _RESERVATION_TTL_MS / 1000,
            "host": host,
        })
        await self._redis.hset(key, job_id, value)
        await self._redis.pexpire(key, _RESERVATION_TTL_MS)

    async def reserve(
        self, endpoint: str, job_id: str, nbytes: int,
    ) -> Optional[ShardReservation]:
        """Enter ``nbytes`` for ``job_id`` in ``endpoint``'s ledger — what
        this job may still write that the node's ``used_memory`` does not
        show — and keep it renewed. None (fail open: nothing held) when the
        bus is unavailable or the node is unknown."""
        if not endpoint or endpoint == "unknown" or not job_id:
            return None
        try:
            await self._write_reservation(endpoint, job_id, nbytes)
        except Exception as exc:
            self._warn_fail_open("shard-reservation write", exc)
            return None
        reservation = ShardReservation(endpoint, job_id, nbytes)

        async def _renew() -> None:
            try:
                while True:
                    await asyncio.sleep(_GRAPH_LEASE_RENEW_SECS)
                    try:
                        await self._write_reservation(endpoint, job_id, reservation.bytes)
                    except Exception as exc:
                        self._warn_fail_open("shard-reservation renew", exc)
            except asyncio.CancelledError:
                pass

        reservation.renew_task = asyncio.create_task(_renew())
        return reservation

    async def update(self, reservation: Optional[ShardReservation], nbytes: int) -> None:
        """Replace the bytes held (what is still to land shrinks as the
        apply progresses)."""
        if reservation is None:
            return
        reservation.bytes = int(nbytes)
        try:
            await self._write_reservation(reservation.endpoint, reservation.job_id, reservation.bytes)
        except Exception as exc:
            self._warn_fail_open("shard-reservation update", exc)

    async def release(self, reservation: Optional[ShardReservation]) -> None:
        if reservation is None:
            return
        if reservation.renew_task is not None:
            reservation.renew_task.cancel()
        try:
            await self._redis.hdel(reservation_key(reservation.endpoint), reservation.job_id)
        except Exception as exc:
            # The entry expires on its own within the reservation TTL.
            self._warn_fail_open("shard-reservation release", exc)

    async def reserved_by_others(self, endpoint: str, job_id: str) -> Tuple[int, int]:
        """(bytes, jobs) every OTHER job holds on ``endpoint`` right now.
        ``(0, 0)`` when the bus is unavailable — the budget then measures
        the node alone, as it did before the ledger existed."""
        try:
            live = await read_reservations(self._redis, endpoint)
        except Exception as exc:
            self._warn_fail_open("shard-reservation read", exc)
            return 0, 0
        others = [entry for job, entry in live.items() if job != job_id]
        return sum(int(entry["bytes"]) for entry in others), len(others)

    # -- read pressure: interactive reads first -----------------------------------

    async def read_pressure(self, provider: Any) -> Optional[str]:
        """Why the web tier last reported interactive reads starving on this
        provider's endpoint (``queue_full``, ``server_timeout``, ``deadline``),
        or None. The materializer's pacing loop stretches its sleep-after-
        write while this is set. Memoised for ``_READ_PRESSURE_POLL_SECS``;
        fails open to None like everything else here."""
        key = read_pressure_key(endpoint_key(provider))
        now = time.monotonic()
        memo = self._read_pressure_memo.get(key)
        if memo is not None and now - memo[0] < _READ_PRESSURE_POLL_SECS:
            return memo[1]
        try:
            value = await self._redis.get(key)
        except Exception as exc:  # noqa: BLE001 — fail open
            self._warn_fail_open("read-pressure check", exc)
            value = None
        reason = str(value) if value else None
        self._read_pressure_memo[key] = (now, reason)
        return reason

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
