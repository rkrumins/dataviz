"""Per-provider admission control for the insights-service worker.

Three layers, smallest first, each guarding a slower / scarcer resource:

1. **Per-provider token bucket** — caps the rate of provider IO per
   second. Capacity and refill rate are admin-tunable per provider via
   ``provider_admission_config``; absence of a row falls back to module
   defaults. The bucket lives in-memory per worker process; multiple
   workers share the same provider via the same DB-backed config but
   each worker maintains its own bucket. They converge close enough.
2. **Per-provider operation circuit breaker** — opens after
   ``circuit_fail_max`` timeouts inside ``circuit_window_secs``. While
   open, ``acquire()`` short-circuits to ``AdmissionDenied`` until
   ``half_open_after_secs`` elapses; the next call probes with one
   request, and a successful probe closes the circuit again.
3. **Rolling success window** persisted to ``provider_health_window``
   so the UI can render a "provider degraded" surface without each
   handler rolling its own bookkeeping. State is written through an
   independent short session so it is not rolled back when the main
   job's session aborts.

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
from collections import deque
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import AsyncIterator, Optional

from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from backend.app.db.engine import PoolRole, get_session_factory
from backend.app.db.models import (
    ProviderAdmissionConfigORM,
    ProviderHealthWindowORM,
)

logger = logging.getLogger(__name__)


# ── Public exception ─────────────────────────────────────────────────

class AdmissionDenied(Exception):
    """Raised when a job cannot acquire admission within the wait budget.

    ``reason`` is a short tag — ``circuit_open`` or ``bucket_timeout`` —
    so the worker can decide whether to NACK-and-retry (transient) or
    DLQ early (sustained).
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
    circuit_fail_max: int = 5
    circuit_window_secs: float = 30.0
    half_open_after_secs: float = 60.0


_DEFAULT_CONFIG = AdmissionConfig()


# ── Token bucket ────────────────────────────────────────────────────

class _TokenBucket:
    """Standard refilling token bucket. Coroutine-safe."""

    __slots__ = ("_capacity", "_refill_per_sec", "_tokens", "_last_refill", "_lock")

    def __init__(self, capacity: int, refill_per_sec: float) -> None:
        self._capacity = max(1, capacity)
        self._refill_per_sec = max(0.001, refill_per_sec)
        self._tokens: float = float(self._capacity)
        self._last_refill = time.monotonic()
        self._lock = asyncio.Lock()

    def _refill(self, now: float) -> None:
        elapsed = max(0.0, now - self._last_refill)
        self._tokens = min(
            float(self._capacity), self._tokens + elapsed * self._refill_per_sec
        )
        self._last_refill = now

    async def acquire(self, *, wait_max_secs: float) -> bool:
        """True on success; False if wait budget exhausted."""
        deadline = time.monotonic() + wait_max_secs
        while True:
            wait = 0.0
            async with self._lock:
                now = time.monotonic()
                self._refill(now)
                if self._tokens >= 1.0:
                    self._tokens -= 1.0
                    return True
                deficit = 1.0 - self._tokens
                wait = deficit / self._refill_per_sec
            now = time.monotonic()
            if now + wait > deadline:
                return False
            await asyncio.sleep(min(wait, deadline - now))


# ── Circuit state (per provider, in-memory) ──────────────────────────

@dataclass
class _CircuitState:
    state: str = "closed"  # closed | open | half_open
    consecutive_failures: int = 0
    timeout_timestamps: deque[float] = field(default_factory=deque)
    opened_at: Optional[float] = None


# ── Controller ───────────────────────────────────────────────────────

_FLUSH_INTERVAL_SECS = float(os.getenv("ADMISSION_FLUSH_INTERVAL_SECS", "5"))


@dataclass
class _PendingOutcome:
    """Buffered counter deltas drained by the periodic flush task."""
    success_delta: int = 0
    failure_delta: int = 0
    consecutive_failures: int = 0


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
        self._buckets: dict[str, _TokenBucket] = {}
        self._circuits: dict[str, _CircuitState] = {}
        self._config_cache: dict[str, AdmissionConfig] = {}
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
                circuit_fail_max=row.circuit_fail_max,
                circuit_window_secs=float(row.circuit_window_secs),
                half_open_after_secs=float(row.half_open_after_secs),
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

    # ── Acquire ──────────────────────────────────────────────────

    async def acquire(
        self, provider_id: str, *, wait_max_secs: float = 30.0
    ) -> None:
        cfg = await self._load_config(provider_id)
        circuit = self._circuits.setdefault(provider_id, _CircuitState())

        now = time.monotonic()
        if circuit.state == "open":
            if (
                circuit.opened_at is not None
                and (now - circuit.opened_at) < cfg.half_open_after_secs
            ):
                raise AdmissionDenied(provider_id, "circuit_open")
            # Promote: allow a single probe.
            logger.info("admission.circuit_half_open provider=%s", provider_id)
            circuit.state = "half_open"

        bucket = self._buckets.setdefault(
            provider_id, _TokenBucket(cfg.bucket_capacity, cfg.refill_per_sec)
        )
        granted = await bucket.acquire(wait_max_secs=wait_max_secs)
        if not granted:
            raise AdmissionDenied(provider_id, "bucket_timeout")

    # ── Outcome reporting ────────────────────────────────────────

    async def report_success(self, provider_id: str) -> None:
        circuit = self._circuits.setdefault(provider_id, _CircuitState())
        if circuit.state == "half_open":
            logger.info("admission.circuit_closed provider=%s", provider_id)
            circuit.state = "closed"
        circuit.consecutive_failures = 0
        await self._persist_outcome(provider_id, succeeded=True)

    async def report_failure(
        self, provider_id: str, *, is_timeout: bool, exc: Optional[BaseException] = None
    ) -> None:
        cfg = await self._load_config(provider_id)
        circuit = self._circuits.setdefault(provider_id, _CircuitState())
        circuit.consecutive_failures += 1

        if is_timeout:
            now = time.monotonic()
            circuit.timeout_timestamps.append(now)
            cutoff = now - cfg.circuit_window_secs
            while (
                circuit.timeout_timestamps
                and circuit.timeout_timestamps[0] < cutoff
            ):
                circuit.timeout_timestamps.popleft()
            if (
                circuit.state != "open"
                and len(circuit.timeout_timestamps) >= cfg.circuit_fail_max
            ):
                logger.warning(
                    "admission.circuit_open provider=%s consecutive_timeouts_in_window=%d",
                    provider_id, len(circuit.timeout_timestamps),
                )
                circuit.state = "open"
                circuit.opened_at = now

        # A half-open probe failure re-opens the circuit immediately.
        if circuit.state == "half_open":
            logger.warning(
                "admission.circuit_reopened provider=%s probe_failed", provider_id
            )
            circuit.state = "open"
            circuit.opened_at = time.monotonic()

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
        circuit = self._circuits.get(provider_id, _CircuitState())
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
        bucket.consecutive_failures = circuit.consecutive_failures
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
                    stmt = insert(ProviderHealthWindowORM).values(
                        provider_id=provider_id,
                        success_count=pending.success_delta,
                        failure_count=pending.failure_delta,
                        window_start=now_iso,
                        consecutive_failures=pending.consecutive_failures,
                        throttle_until=None,
                    )
                    stmt = stmt.on_conflict_do_update(
                        index_elements=["provider_id"],
                        set_={
                            "success_count": (
                                ProviderHealthWindowORM.success_count
                                + pending.success_delta
                            ),
                            "failure_count": (
                                ProviderHealthWindowORM.failure_count
                                + pending.failure_delta
                            ),
                            "consecutive_failures": pending.consecutive_failures,
                        },
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
    op_kind: str = "any",
    wait_max_secs: float = 30.0,
) -> AsyncIterator[None]:
    """Wrap a provider IO call. Increments success/failure counters
    automatically. The first ``asyncio.TimeoutError`` from the wrapped
    block counts toward the circuit-breaker window.
    """
    await controller.acquire(provider_id, wait_max_secs=wait_max_secs)
    try:
        yield
    except asyncio.CancelledError:
        # Cancellation is operator action, not a provider failure.
        raise
    except asyncio.TimeoutError as exc:
        await controller.report_failure(provider_id, is_timeout=True, exc=exc)
        raise
    except AdmissionDenied:
        # Admission re-raises during the await above; bypass the success
        # path but do not double-count as a provider failure.
        raise
    except Exception as exc:
        await controller.report_failure(provider_id, is_timeout=False, exc=exc)
        raise
    else:
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
