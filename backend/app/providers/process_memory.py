"""This process's memory, as the kernel sees it — for decisions that must
follow real pressure rather than a count.

Two readers (Linux; None elsewhere, never an exception) and one gauge:

* :func:`read_rss_mb` — resident set size from ``/proc/self/status``.
* :func:`read_mem_limit_mb` — the cgroup memory limit (v2, then v1); None
  when unlimited or unknown, so a caller fails OPEN.
* :class:`MemoryGauge` — a throttled sampler for a hot loop: the RSS read
  is a file read, cheap but not free, so a loop that polls every thousand
  merges asks the gauge and the gauge asks the kernel at most once per
  ``min_interval_s``; the limit is read once. It remembers the high-water
  mark, so a run can report the peak it reached.

Used by the worker fleet (deferring new claims above a high-water share)
and by the aggregation pipeline's memory-aware flush.
"""
from __future__ import annotations

import time
from typing import Callable, Optional, Tuple


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


class MemoryGauge:
    """A throttled view of ``(rss_mb, limit_mb)`` for a hot loop.

    ``sample()`` re-reads the RSS at most once per ``min_interval_s`` and
    answers the last reading in between; the limit is read once, on the
    first sample. ``high_water_mb`` is the largest RSS seen. Never raises:
    an unreadable value is None, and the caller decides what None means
    (for the flush: no pressure — the pair cap still bounds memory).
    """

    def __init__(
        self, *, min_interval_s: float = 1.0, clock: Callable[[], float] = time.monotonic,
        rss_reader: Callable[[], Optional[float]] = read_rss_mb,
        limit_reader: Callable[[], Optional[float]] = read_mem_limit_mb,
    ) -> None:
        self._min_interval_s = float(min_interval_s)
        self._clock = clock
        self._read_rss = rss_reader
        self._read_limit = limit_reader
        self._last_at: Optional[float] = None
        self._rss_mb: Optional[float] = None
        self._limit_mb: Optional[float] = None
        self._limit_read = False
        self.high_water_mb: Optional[float] = None
        self.samples = 0

    def sample(self) -> Tuple[Optional[float], Optional[float]]:
        now = self._clock()
        if self._last_at is None or now - self._last_at >= self._min_interval_s:
            self._last_at = now
            self.samples += 1
            self._rss_mb = self._read_rss()
            if self._rss_mb is not None:
                self.high_water_mb = max(self.high_water_mb or 0.0, self._rss_mb)
            if not self._limit_read:
                self._limit_read = True
                self._limit_mb = self._read_limit()
        return self._rss_mb, self._limit_mb
