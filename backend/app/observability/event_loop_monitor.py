"""
Event-loop lag canary — the single most-valuable diagnostic for the
"app frozen" failure mode.

The original 5-minute freeze was invisible until users complained
because the platform exported zero metrics. The monitor below:

    while not shutdown:
        t0 = monotonic()
        await asyncio.sleep(0.1)
        lag = monotonic() - t0 - 0.1

…records how late each 100ms wakeup landed relative to its scheduled
target. The lag is essentially zero on a healthy event loop and grows
when a coroutine blocks the loop (sync I/O, CPU-bound work in the
loop thread, GIL contention). At >50ms p99 the loop is unhealthy; at
>500ms it's wedged.

Operators consume the signal via:
  - The ``event_loop_lag_seconds`` gauge (P3.2 metrics endpoint).
  - The peak / p99 fields on ``app.state.event_loop_lag_stats`` (read
    by ``/health/deps``).
  - WARN-level log lines on threshold crossing.

Self-supervision: the monitor catches every non-CancelledError and
respawns its own loop after a small backoff. Any uncaught exception
inside the monitor is itself a critical signal — but the monitor is
the LAST thing that should be down, so we self-heal rather than letting
the canary itself die silently.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from dataclasses import dataclass, field
from typing import Optional

logger = logging.getLogger(__name__)


# Sample interval — small enough that one bad coroutine produces a clear
# spike in p99, large enough to keep monitor overhead negligible (1% of a
# CPU at 100ms cadence).
SAMPLE_INTERVAL_S: float = float(os.getenv("EVENT_LOOP_SAMPLE_INTERVAL_S", "0.1"))

# WARN threshold — sustained lag above this means coroutines are queueing.
WARN_THRESHOLD_S: float = float(os.getenv("EVENT_LOOP_WARN_THRESHOLD_S", "0.05"))

# CRITICAL threshold — loop is wedged; pages should fire on this.
CRITICAL_THRESHOLD_S: float = float(os.getenv("EVENT_LOOP_CRITICAL_THRESHOLD_S", "0.5"))

# Rolling window for p99/peak computation.
WINDOW_SIZE: int = int(os.getenv("EVENT_LOOP_WINDOW_SIZE", "300"))   # 30s @ 100ms

# Throttle for log lines — avoid spamming if the loop is sustained-bad.
LOG_INTERVAL_S: float = float(os.getenv("EVENT_LOOP_LOG_INTERVAL_S", "10.0"))


@dataclass
class EventLoopLagStats:
    """Public read-only snapshot consumed by /health/deps and metrics.

    Exposed via ``app.state.event_loop_lag_stats``. Updated in place by
    the monitor; readers do a single attribute access (atomic in CPython).
    """
    last_sample_s: float = 0.0
    peak_s: float = 0.0          # rolling-window max
    p99_s: float = 0.0           # rolling-window p99
    samples_taken: int = 0
    started_at: Optional[float] = None
    # Recent samples for rolling stats. Bounded by WINDOW_SIZE.
    _window: list = field(default_factory=list)

    def add_sample(self, lag_s: float) -> None:
        self._window.append(lag_s)
        if len(self._window) > WINDOW_SIZE:
            self._window = self._window[-WINDOW_SIZE:]
        self.last_sample_s = lag_s
        self.samples_taken += 1
        if self._window:
            self.peak_s = max(self._window)
            sorted_w = sorted(self._window)
            idx = max(0, int(len(sorted_w) * 0.99) - 1)
            self.p99_s = sorted_w[idx]


async def run_event_loop_monitor(
    *,
    stats: EventLoopLagStats,
    shutdown: asyncio.Event,
) -> None:
    """The canary loop. Runs forever until shutdown."""
    stats.started_at = time.monotonic()
    last_log_at = 0.0
    backoff = 1.0

    while not shutdown.is_set():
        try:
            t0 = time.monotonic()
            try:
                await asyncio.wait_for(
                    shutdown.wait(), timeout=SAMPLE_INTERVAL_S,
                )
                return  # shutdown signalled
            except asyncio.TimeoutError:
                pass
            actual_elapsed = time.monotonic() - t0
            lag = max(0.0, actual_elapsed - SAMPLE_INTERVAL_S)
            stats.add_sample(lag)

            now = time.monotonic()
            if lag >= CRITICAL_THRESHOLD_S:
                if (now - last_log_at) >= LOG_INTERVAL_S:
                    logger.error(
                        "event_loop_lag CRITICAL: lag=%.0fms peak_30s=%.0fms "
                        "p99_30s=%.0fms — loop is wedged or starved",
                        lag * 1000, stats.peak_s * 1000, stats.p99_s * 1000,
                    )
                    last_log_at = now
            elif lag >= WARN_THRESHOLD_S:
                if (now - last_log_at) >= LOG_INTERVAL_S:
                    logger.warning(
                        "event_loop_lag elevated: lag=%.0fms peak_30s=%.0fms "
                        "p99_30s=%.0fms",
                        lag * 1000, stats.peak_s * 1000, stats.p99_s * 1000,
                    )
                    last_log_at = now
            backoff = 1.0
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            # The canary itself failing is a near-impossibility — but if
            # it does, log loudly and respawn rather than going silent.
            logger.error(
                "event_loop_monitor crashed (will retry in %.1fs): %s",
                backoff, exc,
            )
            try:
                await asyncio.wait_for(shutdown.wait(), timeout=backoff)
                return
            except asyncio.TimeoutError:
                pass
            backoff = min(backoff * 2, 30.0)

    logger.info("event_loop_monitor stopped")
