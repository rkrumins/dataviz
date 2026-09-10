"""Interactive reads first: tell the aggregation writers when reads starve.

Aggregation jobs and interactive users share one FalkorDB. The writers
already pace themselves (a sleep after every write batch, a fleet-wide
write lease per graph, two write slots per endpoint so readers keep
query threads) — but the only feedback they had was their OWN write
latency. A job writing small, fast MERGEs while the canvas's reads queue
behind them looked healthy from the writer's side, so nothing yielded.

The web tier learns that reads are starving in exactly one place: the
breaker proxy relabelling a capacity reply (FalkorDB's queue-full
rejection, its server-side query kill) or its own per-operation deadline
firing. Those are per-process facts; the writers that could yield run in
other pods. This module carries the signal across:

* **Web tier** (``ReadPressureSignal``, registered as a breaker capacity
  listener at startup): stamps ``agg:readpressure:{endpoint}`` on the
  shared job-bus Redis with a short TTL. Keyed by FalkorDB endpoint
  exactly like the write-admission budget, so it lands on the writers of
  the instance that is actually starving. At most one stamp per endpoint
  per ``_SIGNAL_MIN_INTERVAL_S`` per process — a 504 storm costs one SET.
* **Worker** (``AggregationAdmission.read_pressure``): the materializer's
  pacing loop reads the key (memoised for a couple of seconds) and, while
  it lives, stretches its sleep-after-write to
  ``AGGREGATION_READ_PRESSURE_PACING_RATIO``. Jobs finish later; users
  are not kept waiting on a background rebuild.

Fail-open both ways: no Redis, no signal, no slowdown. Never raises into
a request or a job.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Any, Callable

from .admission import endpoint_key, read_pressure_key

logger = logging.getLogger(__name__)


def _ttl_seconds() -> int:
    """How long one signal keeps the writers yielding; every new signal
    refreshes it. Long enough to outlast the burst that raised it, short
    enough that a single slow query cannot slow a night of jobs."""
    try:
        raw = int(os.getenv("AGGREGATION_READ_PRESSURE_TTL_S", "30"))
    except ValueError:
        raw = 30
    return max(5, min(600, raw))


_TTL_S = _ttl_seconds()
_SIGNAL_MIN_INTERVAL_S = 5.0

_STATS: dict[str, int] = {
    "signals_sent": 0,
    "signals_coalesced": 0,
    "signal_errors": 0,
}


def read_pressure_stats() -> dict[str, int]:
    """Process-wide counters, reported under ``/health/deps`` → resilience."""
    return dict(_STATS)


class ReadPressureSignal:
    """The web-tier half. ``on_capacity`` matches the breaker's listener
    signature and is synchronous: it schedules the Redis write on the
    running loop and returns, so the request that observed the pressure
    is never delayed by reporting it."""

    def __init__(self, redis_factory: Callable[[], Any]) -> None:
        self._redis_factory = redis_factory
        self._last_sent: dict[str, float] = {}
        self._tasks: set[asyncio.Task] = set()

    def on_capacity(self, kind: str, target: Any) -> None:
        endpoint = endpoint_key(target)
        now = time.monotonic()
        last = self._last_sent.get(endpoint)
        if last is not None and now - last < _SIGNAL_MIN_INTERVAL_S:
            _STATS["signals_coalesced"] += 1
            return
        self._last_sent[endpoint] = now
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:  # pragma: no cover — listeners fire inside a request
            return
        task = loop.create_task(self._stamp(endpoint, kind))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _stamp(self, endpoint: str, kind: str) -> None:
        try:
            await self._redis_factory().set(read_pressure_key(endpoint), kind, ex=_TTL_S)
        except Exception as exc:  # noqa: BLE001 — fail open
            _STATS["signal_errors"] += 1
            logger.debug("read-pressure stamp failed for %s: %s", endpoint, exc)
            return
        _STATS["signals_sent"] += 1
        logger.info(
            "read pressure on %s (%s): aggregation writers yield for the next %ds",
            endpoint, kind, _TTL_S,
        )
