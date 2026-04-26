"""Per-provider admission control for the insights-service worker.

Two layers, smallest first, each guarding a slower / scarcer resource:

1. **Per-provider token bucket (Redis-backed GCRA)** — caps the rate
   of provider IO per second across the whole worker fleet. Capacity
   and refill rate are admin-tunable per provider via
   ``provider_admission_config``; absence of a row falls back to module
   defaults. One Redis key per provider gives a real cluster-wide cap
   regardless of replica count.
2. **Rolling success window** persisted to ``provider_health_window``
   so the UI can render a "provider degraded" surface without each
   handler rolling its own bookkeeping. Buffered + flushed periodically
   to avoid commit-per-job hot path.

Circuit breaking lives in the provider proxy
(``backend/common/adapters/circuit.py`` — ``_AsyncCircuitBreaker``
wrapped by ``CircuitBreakerProxy``). When that breaker opens it raises
``ProviderUnavailable`` from inside the gated block, which the worker's
soft-retry path treats identically to ``AdmissionDenied``. Duplicating
that logic here was redundant and made 3am triage ambiguous; gone.

Use via the :func:`gate` async context manager. Handlers call::

    async with admission.gate(provider_id):
        result = await asyncio.wait_for(instance.get_stats(), timeout=...)

The gate increments success/failure counters automatically based on
whether the protected block raised.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import AsyncIterator, Optional

from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from backend.app.db.engine import PoolRole, get_session_factory
from backend.app.db.models import (
    ProviderAdmissionConfigORM,
    ProviderHealthWindowORM,
)
from backend.app.services.aggregation.redis_client import get_redis

logger = logging.getLogger(__name__)


# ── Public exception ─────────────────────────────────────────────────

class AdmissionDenied(Exception):
    """Raised when a job cannot acquire admission within the wait budget.

    ``reason`` is a short tag (currently always ``bucket_timeout``)
    kept structured so the worker can route soft-retry decisions
    without parsing strings. Provider-circuit-open is now signalled
    by ``ProviderUnavailable`` from the provider proxy, not by a
    second admission state machine here.
    """

    def __init__(self, provider_id: str, reason: str):
        super().__init__(f"admission_denied(provider={provider_id}, reason={reason})")
        self.provider_id = provider_id
        self.reason = reason


# ── Config ──────────────────────────────────────────────────────────

@dataclass(frozen=True)
class AdmissionConfig:
    bucket_capacity: int = 8
    refill_per_sec: float = 2.0


_DEFAULT_CONFIG = AdmissionConfig()


# ── Token bucket: Redis-backed GCRA ─────────────────────────────────
#
# Generic Cell Rate Algorithm. One Redis key per provider holds the
# Theoretical Arrival Time of the next allowed token; capacity and
# refill rate are passed as args on every call so per-provider config
# changes take effect on the next acquire without invalidation.
#
# Why not in-memory? With N workers each holding their own bucket,
# the **cold-start burst** is N × bucket_capacity simultaneous calls
# (e.g. 4 workers × 8 capacity = 32 concurrent calls to a slow
# upstream — which is exactly the scenario `bucket_capacity=8` was
# meant to prevent). One Redis key gives us a real cluster-wide cap.
#
# Falls open on Redis failures: if EVAL raises, we allow the call
# rather than block the worker. Admission is best-effort; provider
# circuit breakers still catch the real outage.

_GCRA_LUA = """
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_per_sec = tonumber(ARGV[2])
local now_ms = tonumber(ARGV[3])

-- Emission interval (ms between tokens) and delay variation tolerance
-- (max burst expressed in time units = capacity × interval).
local emission_ms = 1000.0 / refill_per_sec
local dvt_ms = capacity * emission_ms

local tat_str = redis.call('GET', key)
local tat
if tat_str then
    tat = tonumber(tat_str)
else
    tat = 0
end

if tat < now_ms then
    tat = now_ms
end

local new_tat = tat + emission_ms
local diff_ms = new_tat - now_ms

if diff_ms > dvt_ms then
    -- Denied; tell caller how long to wait before the next attempt.
    return {0, math.floor(diff_ms - dvt_ms)}
end

-- Granted; persist new TAT with a TTL bounded by max possible wait.
local pttl = math.ceil(dvt_ms + 1000)
redis.call('PSETEX', key, pttl, new_tat)
return {1, 0}
"""


def _bucket_key(provider_id: str) -> str:
    return f"insights:bucket:{provider_id}"


async def _redis_acquire_token(
    provider_id: str,
    *,
    capacity: int,
    refill_per_sec: float,
    wait_max_secs: float,
) -> bool:
    """Acquire one token from the Redis-backed GCRA bucket.

    Returns ``True`` on grant, ``False`` if the wait budget was
    exhausted. Falls open (returns ``True``) when Redis is unreachable
    so admission outages don't cascade into worker errors.
    """
    deadline = time.monotonic() + wait_max_secs
    redis = get_redis()
    while True:
        now_ms = int(time.time() * 1000)
        try:
            result = await redis.eval(
                _GCRA_LUA,
                1,
                _bucket_key(provider_id),
                str(int(capacity)),
                str(float(refill_per_sec)),
                str(now_ms),
            )
        except Exception as exc:
            # Fail-open. Provider circuit breakers still gate against
            # real outages; a Redis blip should not block all worker
            # progress.
            logger.warning(
                "admission.token_acquire_redis_unavailable provider=%s err=%s — "
                "allowing through (fail-open)",
                provider_id, exc,
            )
            return True

        allowed = int(result[0])
        wait_ms = int(result[1])
        if allowed == 1:
            return True

        wait_secs = wait_ms / 1000.0
        if time.monotonic() + wait_secs > deadline:
            return False
        await asyncio.sleep(min(wait_secs, deadline - time.monotonic()))


# ── Controller ───────────────────────────────────────────────────────

_FLUSH_INTERVAL_SECS = float(os.getenv("ADMISSION_FLUSH_INTERVAL_SECS", "5"))


@dataclass
class _PendingOutcome:
    """Buffered counter deltas drained by the periodic flush task."""
    success_delta: int = 0
    failure_delta: int = 0
    consecutive_failures: int = 0
    # Last-writer-wins; None means "no timing observed in this window".
    last_duration_ms: Optional[int] = None


class _AdmissionController:
    """Process-singleton. State is per-worker; counters in
    ``provider_health_window`` make it observable to other workers
    without a coordination protocol.

    Outcome persistence is **batched**: every ``report_*`` call buffers
    counter deltas in-memory and a single background task flushes them
    every ``ADMISSION_FLUSH_INTERVAL_SECS`` (default 5s). At 50 jobs/sec
    against 4 providers that drops 50 commits/sec to ~0.8 commits/sec
    — which is the difference between "DB write hot path" and "noise".
    """

    def __init__(self) -> None:
        # Token buckets live in Redis (see ``_redis_acquire_token``);
        # only config + per-provider consecutive-failure counters live
        # per-process. The latter is a UI signal, not an admission
        # decision — the provider proxy's circuit breaker handles
        # short-circuiting cluster-wide.
        self._config_cache: dict[str, AdmissionConfig] = {}
        self._consecutive_failures: dict[str, int] = {}
        # Last observed call duration (ms) per provider — populated by
        # ``record_latency`` from inside ``gate()``. A single number
        # per provider is enough triage signal for "is this provider
        # slow right now"; real percentile aggregation would need a
        # proper sketch (t-digest / HDR-histogram) and is deferred.
        self._last_durations: dict[str, int] = {}
        self._lock = asyncio.Lock()
        # Coalesced outcome buffer drained by ``_flush_loop``.
        self._pending: dict[str, _PendingOutcome] = {}
        self._flush_task: Optional[asyncio.Task] = None

    # ── Config lookup ────────────────────────────────────────────

    async def _load_config(self, provider_id: str) -> AdmissionConfig:
        if provider_id in self._config_cache:
            return self._config_cache[provider_id]

        factory = get_session_factory(PoolRole.READONLY)
        try:
            async with factory() as session:
                row = await session.get(ProviderAdmissionConfigORM, provider_id)
        except Exception as exc:
            logger.warning(
                "admission.config_load_failed provider=%s err=%s — using defaults",
                provider_id, exc,
            )
            self._config_cache[provider_id] = _DEFAULT_CONFIG
            return _DEFAULT_CONFIG

        cfg = (
            AdmissionConfig(
                bucket_capacity=row.bucket_capacity,
                refill_per_sec=float(row.refill_per_sec),
            )
            if row is not None
            else _DEFAULT_CONFIG
        )
        self._config_cache[provider_id] = cfg
        return cfg

    def invalidate_config(self, provider_id: str) -> None:
        """Drop the cached AdmissionConfig so the next acquire re-reads
        the DB. Call this from the admin-config editor handler."""
        self._config_cache.pop(provider_id, None)

    # ── Latency observability ────────────────────────────────────

    def record_latency(self, provider_id: str, elapsed_ms: int) -> None:
        """Record the most recent provider-call duration. Called from
        inside ``gate()`` after the wrapped block returns.

        Single most-recent value per provider — see ``__init__`` for
        why we don't pretend to compute percentiles. The flush task
        persists this to ``provider_health_window.last_p99_ms``
        (column name preserved across the in-memory→last-call rename;
        column rename lives in PR B's Alembic migration)."""
        if elapsed_ms < 0:
            return
        self._last_durations[provider_id] = elapsed_ms

    def last_durations_snapshot(self) -> dict[str, int]:
        """Read-only copy for /health snapshot consumers."""
        return dict(self._last_durations)

    # ── Acquire ──────────────────────────────────────────────────

    async def acquire(
        self, provider_id: str, *, wait_max_secs: float = 30.0
    ) -> None:
        """Acquire one provider-IO permit.

        Raises ``AdmissionDenied(reason='bucket_timeout')`` if the
        Redis-backed GCRA bucket can't grant one within
        ``wait_max_secs``. The worker's soft-retry path catches this
        and re-queues without burning a delivery attempt.

        Provider-level circuit-open is signalled separately by
        ``ProviderUnavailable`` from inside the wrapped block; we
        don't re-implement it here.
        """
        cfg = await self._load_config(provider_id)
        granted = await _redis_acquire_token(
            provider_id,
            capacity=cfg.bucket_capacity,
            refill_per_sec=cfg.refill_per_sec,
            wait_max_secs=wait_max_secs,
        )
        if not granted:
            raise AdmissionDenied(provider_id, "bucket_timeout")

    # ── Outcome reporting ────────────────────────────────────────

    async def report_success(self, provider_id: str) -> None:
        """Record a successful provider call. Resets the per-provider
        consecutive-failure counter to 0; the value lands in
        ``provider_health_window`` on the next flush."""
        self._consecutive_failures[provider_id] = 0
        await self._persist_outcome(provider_id, succeeded=True)

    async def report_failure(
        self,
        provider_id: str,
        *,
        is_timeout: bool,  # noqa: ARG002  (preserved on signature for forward-compat)
        exc: Optional[BaseException] = None,  # noqa: ARG002
    ) -> None:
        """Record a failed provider call. Increments the per-provider
        consecutive-failure counter; the value lands in
        ``provider_health_window`` on the next flush.

        ``is_timeout`` and ``exc`` are kept on the signature even
        though the in-memory circuit is gone — callers (the gate)
        already pass them; reusing the signature avoids a churn-y API
        change if we later route timeouts to a metrics emitter.
        """
        self._consecutive_failures[provider_id] = (
            self._consecutive_failures.get(provider_id, 0) + 1
        )
        await self._persist_outcome(provider_id, succeeded=False)

    # ── Persistence: buffered rolling window ────────────────────

    async def _persist_outcome(self, provider_id: str, *, succeeded: bool) -> None:
        """Buffer the outcome for the periodic flush task.

        Deltas accumulate in-memory; the flush task (``_flush_loop``)
        emits one upsert per affected provider every
        ``ADMISSION_FLUSH_INTERVAL_SECS``. This eliminates the
        commit-per-job hot path; in exchange, counters in
        ``provider_health_window`` lag real-time by up to one flush
        interval. That's acceptable for an observability surface
        (the UI's "provider health" chip refreshes on its own cadence).
        """
        bucket = self._pending.get(provider_id)
        if bucket is None:
            bucket = _PendingOutcome()
            self._pending[provider_id] = bucket
        if succeeded:
            bucket.success_delta += 1
        else:
            bucket.failure_delta += 1
        # Last-writer-wins: the latest in-memory consecutive_failures
        # value is the right one to persist; deltas don't apply.
        bucket.consecutive_failures = self._consecutive_failures.get(provider_id, 0)
        # Carry latest duration into the next flush. ``record_latency``
        # may have already updated ``_last_durations`` for this call.
        bucket.last_duration_ms = self._last_durations.get(provider_id)
        self._ensure_flush_task()

    def _ensure_flush_task(self) -> None:
        """Lazily spawn the flush coroutine on the running event loop.

        Tolerates "no loop" environments (some test paths exercise
        admission state without running asyncio); persistence is
        best-effort and missing it doesn't break admission decisions.
        """
        if self._flush_task is not None and not self._flush_task.done():
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._flush_task = loop.create_task(
            self._flush_loop(), name="admission-flush",
        )

    async def _flush_loop(self) -> None:
        try:
            while True:
                await asyncio.sleep(_FLUSH_INTERVAL_SECS)
                await self.drain()
        except asyncio.CancelledError:
            # Final drain on shutdown so we don't lose the last window
            # of counters when the worker stops gracefully.
            with contextlib.suppress(Exception):
                await self.drain()
            raise
        except Exception:
            logger.exception("admission.flush_loop crashed (will not restart)")

    async def drain(self) -> None:
        """Flush all buffered outcomes to ``provider_health_window``.

        Public so tests / shutdown hooks can force a flush. Atomically
        swaps the buffer so concurrent ``report_*`` calls during the
        flush land in the next batch.
        """
        if not self._pending:
            return
        snapshot, self._pending = self._pending, {}
        factory = get_session_factory(PoolRole.JOBS)
        try:
            async with factory() as session:
                dialect = (
                    session.bind.dialect.name if session.bind else "sqlite"
                )
                insert = pg_insert if dialect == "postgresql" else sqlite_insert
                now_iso = datetime.now(timezone.utc).isoformat()
                for provider_id, pending in snapshot.items():
                    if (
                        pending.success_delta == 0
                        and pending.failure_delta == 0
                    ):
                        continue
                    # ``last_p99_ms`` column is reused for last-call
                    # duration in ms — single observed value, not a
                    # real percentile. PR B's Alembic renames the
                    # column to ``last_call_duration_ms``.
                    insert_values: dict = dict(
                        provider_id=provider_id,
                        success_count=pending.success_delta,
                        failure_count=pending.failure_delta,
                        window_start=now_iso,
                        consecutive_failures=pending.consecutive_failures,
                        throttle_until=None,
                    )
                    update_values: dict = {
                        "success_count": (
                            ProviderHealthWindowORM.success_count
                            + pending.success_delta
                        ),
                        "failure_count": (
                            ProviderHealthWindowORM.failure_count
                            + pending.failure_delta
                        ),
                        "consecutive_failures": pending.consecutive_failures,
                    }
                    if pending.last_duration_ms is not None:
                        insert_values["last_p99_ms"] = pending.last_duration_ms
                        update_values["last_p99_ms"] = pending.last_duration_ms

                    stmt = insert(ProviderHealthWindowORM).values(**insert_values)
                    stmt = stmt.on_conflict_do_update(
                        index_elements=["provider_id"],
                        set_=update_values,
                    )
                    await session.execute(stmt)
                await session.commit()
        except Exception as exc:
            # If flush fails, fold the snapshot back into the pending
            # buffer so a subsequent flush retries — losing counters
            # because Postgres blipped is worse than a brief delay.
            for provider_id, pending in snapshot.items():
                existing = self._pending.get(provider_id)
                if existing is None:
                    self._pending[provider_id] = pending
                else:
                    existing.success_delta += pending.success_delta
                    existing.failure_delta += pending.failure_delta
                    existing.consecutive_failures = pending.consecutive_failures
            logger.warning("admission.drain_failed err=%s", exc)


# Process-singleton.
controller = _AdmissionController()


# ── Context manager ──────────────────────────────────────────────────

@asynccontextmanager
async def gate(
    provider_id: str,
    *,
    op_kind: str = "any",  # noqa: ARG001  (op_kind reserved for future per-op metrics)
    wait_max_secs: float = 30.0,
) -> AsyncIterator[None]:
    """Wrap a provider IO call. Increments success/failure counters
    automatically and records the wrapped-block duration via
    ``controller.record_latency`` so /health and the admission admin
    surface "last call took X ms" without each handler duplicating
    timing logic.
    """
    await controller.acquire(provider_id, wait_max_secs=wait_max_secs)
    start_ts = time.monotonic()
    try:
        yield
    except asyncio.CancelledError:
        # Cancellation is operator action, not a provider failure.
        raise
    except asyncio.TimeoutError as exc:
        controller.record_latency(provider_id, int((time.monotonic() - start_ts) * 1000))
        await controller.report_failure(provider_id, is_timeout=True, exc=exc)
        raise
    except AdmissionDenied:
        # Admission re-raises during the await above; bypass the success
        # path but do not double-count as a provider failure.
        raise
    except Exception as exc:
        controller.record_latency(provider_id, int((time.monotonic() - start_ts) * 1000))
        await controller.report_failure(provider_id, is_timeout=False, exc=exc)
        raise
    else:
        controller.record_latency(provider_id, int((time.monotonic() - start_ts) * 1000))
        await controller.report_success(provider_id)


# Convenience for callers that want the raw API
acquire = controller.acquire
report_success = controller.report_success
report_failure = controller.report_failure
invalidate_config = controller.invalidate_config


__all__ = [
    "AdmissionDenied",
    "AdmissionConfig",
    "controller",
    "gate",
    "acquire",
    "report_success",
    "report_failure",
    "invalidate_config",
]
