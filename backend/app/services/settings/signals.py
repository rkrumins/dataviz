"""Signals: how many times something happened that a versioned-graph setting can change — a build
waited for room, a read was asked to retry, a replace was refused — counted where it happens, for
the "Something's wrong?" finder and each graph's health.

:func:`bump` counts in this process's memory: sync, no IO, about the cost of a dict increment, so
it can sit on a read's path. Every ``FLUSH_SECONDS``, and once more when the process stops, the
flusher (:func:`start_flusher`) adds what was counted to Redis in one pipelined transaction of
``HINCRBY`` into hourly buckets (UTC), each kept ``TTL_SECONDS``:

* ``sig:<id>:<YYYYMMDDHH>``, field ``n``: every count of the signal in that hour;
* ``sig:<id>:g:<YYYYMMDDHH>``, field ``<graph id>``: the counts that named a graph.

A flush Redis refuses keeps its counts for the next one, up to ``MAX_PENDING`` counters. Past
that the oldest go, and that is logged once until a flush lands again. A process that dies loses at
most its last ``FLUSH_SECONDS``.

:func:`read` and :func:`top_graphs` answer from Redis alone, when someone asks, and raise when it
can't be read: their callers say so rather than show zeros. Each process's latest counts reach
them within ``FLUSH_SECONDS``.

The ids are fixed (:data:`IDS`); the registry's ``SIGNALS`` describe the same ones.
"""
from __future__ import annotations

import asyncio
import functools
import itertools
import logging
import sys
import time
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

IDS: Tuple[str, ...] = (
    "builds.waited_for_room",             # a build asked for room and was told to wait
    "builds.copy_timed_out",              # a build's copy outlived the projector's socket
    "builds.dropped",                     # a build dropped after its attempts
    "reads.asked_to_retry",               # the database's read slots were full: asked to retry
    "reads.from_database_while_behind",   # the database served a read: the copy is too far behind
    "residency.unloaded_under_pressure",  # a copy unloaded to bring its node under its mark
    "residency.load_waited_for_room",     # a load asked for room and was told to wait
    "imports.replace_refused_by_guard",   # a replace refused by the replace guard
    "imports.replace_stopped_low_match",  # a replace stopped: too few rows found an item
    "drafts.idle_closed",                 # an idle draft closed
    "drafts.changes_removed",             # a closed draft's changes removed
)
_KNOWN = frozenset(IDS)
#: A window: that many clock hours (UTC), the last the hour under way.
WINDOWS = {"1h": 1, "24h": 24, "7d": 168}

FLUSH_SECONDS = 10.0
TTL_SECONDS = 8 * 24 * 3600
#: Counters held between flushes, at most: memory stays bounded however long Redis is away.
MAX_PENDING = 10_000
_FLUSH_WAIT_S = 5.0
_READ_WAIT_S = 3.0

#: An unknown id is refused loudly where tests run (pytest loaded this process) and dropped
#: silently elsewhere, so a typo never fails the projection pass or the read it sits in.
STRICT = "pytest" in sys.modules

_clock = time.time
#: (signal id, graph id or None, hour since the epoch) -> its count since the last flush, oldest
#: first.
_pending: Dict[Tuple[str, Optional[str], int], int] = {}
#: What was logged since the last flush that landed: a refused flush, counts dropped.
_told = {"refused": False, "dropped": False}
_flusher: Dict[str, Any] = {"task": None, "stop": None}


def bump(signal_id: str, *, graph_id: Optional[str] = None, n: int = 1) -> None:
    """Count ``n`` of ``signal_id`` now, naming ``graph_id`` when it is known. In memory only."""
    if signal_id not in _KNOWN:
        assert not STRICT, f"unknown signal {signal_id!r}: it is not in signals.IDS"
        return
    if n <= 0:
        return
    key = (signal_id, graph_id, int(_clock() // 3600))
    held = _pending.get(key)
    if held is None:
        if len(_pending) >= MAX_PENDING:
            _drop(MAX_PENDING // 10)
        _pending[key] = n
    else:
        _pending[key] = held + n


def _drop(count: int) -> None:
    """Make room: the ``count`` oldest counters go. Logged once until a flush lands."""
    global _pending
    _pending = dict(itertools.islice(_pending.items(), count, None))
    if not _told["dropped"]:
        _told["dropped"] = True
        logger.warning("signals: Redis has taken no counts for a while; the oldest are dropped "
                       "to keep at most %d counters until it does", MAX_PENDING)


@functools.lru_cache(maxsize=256)
def _bucket(hour: int) -> str:
    return time.strftime("%Y%m%d%H", time.gmtime(hour * 3600))


def _redis():
    """The coordination bus, as the settings' generation uses it."""
    from backend.app.services.aggregation.redis_client import get_redis

    return get_redis()


async def flush() -> int:
    """Add what this process counted to Redis, all in one transaction. Returns how many counters
    it wrote: 0 when there were none, or when Redis refused them, which are kept for the next."""
    global _pending
    if not _pending:
        return 0
    batch, _pending = _pending, {}
    try:
        await asyncio.wait_for(_write(batch), timeout=_FLUSH_WAIT_S)
    except asyncio.CancelledError:
        _keep(batch)
        raise
    except Exception as exc:  # noqa: BLE001 — the counts wait for the next flush
        _keep(batch)
        if not _told["refused"]:
            _told["refused"] = True
            logger.warning("signals: the counts could not be written to Redis; they are kept "
                           "for the next flush: %s", exc)
        return 0
    _told.update(refused=False, dropped=False)
    return len(batch)


async def _write(batch: Dict[Tuple[str, Optional[str], int], int]) -> None:
    totals: Dict[str, int] = {}
    named = set()
    pipe = _redis().pipeline(transaction=True)
    for (signal_id, graph_id, hour), n in batch.items():
        total = f"sig:{signal_id}:{_bucket(hour)}"
        totals[total] = totals.get(total, 0) + n
        if graph_id is not None:
            key = f"sig:{signal_id}:g:{_bucket(hour)}"
            pipe.hincrby(key, graph_id, n)
            named.add(key)
    for key, n in totals.items():
        pipe.hincrby(key, "n", n)
    for key in (*totals, *named):
        pipe.expire(key, TTL_SECONDS)
    await pipe.execute()


def _keep(batch: Dict[Tuple[str, Optional[str], int], int]) -> None:
    """Put a refused flush's counts back, older than what was counted since; past the cap the
    oldest go."""
    global _pending
    for key, n in _pending.items():
        batch[key] = batch.get(key, 0) + n
    _pending = batch
    if len(_pending) > MAX_PENDING:
        _drop(len(_pending) - MAX_PENDING)


async def run_flusher(stop: asyncio.Event, *, interval: float = FLUSH_SECONDS) -> None:
    """Flush every ``interval`` seconds until ``stop`` is set, then once more."""
    while not stop.is_set():
        try:
            await asyncio.wait_for(stop.wait(), timeout=interval)
        except asyncio.TimeoutError:
            await flush()                     # a whole interval: time to flush again
    await flush()                             # stopping: what is still counted


def start_flusher() -> None:
    """Start this process's flusher in the running event loop; started already, nothing more."""
    loop, task = asyncio.get_running_loop(), _flusher["task"]
    if task is not None and not task.done() and task.get_loop() is loop:
        return
    stop = asyncio.Event()
    _flusher.update(stop=stop, task=loop.create_task(run_flusher(stop), name="signals-flush"))


async def stop_flusher(timeout: float = 5.0) -> None:
    """Stop the flusher once it has added what is still counted, waiting ``timeout`` at most.
    Never raises."""
    task, stop = _flusher["task"], _flusher["stop"]
    _flusher.update(task=None, stop=None)
    if task is None:
        return
    stop.set()
    try:
        await asyncio.wait_for(task, timeout=timeout)
    except (asyncio.TimeoutError, asyncio.CancelledError):
        logger.warning("signals: the last flush did not finish in %.0fs", timeout)
    except Exception as exc:  # noqa: BLE001 — stopping either way
        logger.warning("signals: the last flush failed: %s", exc)


def _hours(window: str) -> List[int]:
    now = int(_clock() // 3600)
    return list(range(now - WINDOWS[window] + 1, now + 1))


async def read(window: str, *, graph_id: Optional[str] = None) -> Dict[str, Dict[str, Any]]:
    """Each signal's count over ``window`` (:data:`WINDOWS`) and per hour, oldest first:
    ``{id: {count, byHour}}``, every id there (0: nothing happened). ``graph_id``: only the counts
    that named it. Raises when Redis can't be read."""
    hours = _hours(window)
    pipe = _redis().pipeline(transaction=False)
    for signal_id in IDS:
        for hour in hours:
            if graph_id is None:
                pipe.hget(f"sig:{signal_id}:{_bucket(hour)}", "n")
            else:
                pipe.hget(f"sig:{signal_id}:g:{_bucket(hour)}", graph_id)
    got = await asyncio.wait_for(pipe.execute(), timeout=_READ_WAIT_S)
    out: Dict[str, Dict[str, Any]] = {}
    for i, signal_id in enumerate(IDS):
        by_hour = [int(v or 0) for v in got[i * len(hours):(i + 1) * len(hours)]]
        out[signal_id] = {"count": sum(by_hour), "byHour": by_hour}
    return out


async def top_graphs(window: str, *, limit: int = 5) -> Dict[str, List[Tuple[str, int]]]:
    """The graphs each signal named most over ``window``, most first, at most ``limit``:
    ``{id: [(graph id, count)]}``. Raises when Redis can't be read."""
    hours = _hours(window)
    pipe = _redis().pipeline(transaction=False)
    for signal_id in IDS:
        for hour in hours:
            pipe.hgetall(f"sig:{signal_id}:g:{_bucket(hour)}")
    got = await asyncio.wait_for(pipe.execute(), timeout=_READ_WAIT_S)
    out: Dict[str, List[Tuple[str, int]]] = {}
    for i, signal_id in enumerate(IDS):
        counts: Dict[str, int] = {}
        for fields in got[i * len(hours):(i + 1) * len(hours)]:
            for graph_id, n in (fields or {}).items():
                graph_id = graph_id.decode() if isinstance(graph_id, bytes) else graph_id
                counts[graph_id] = counts.get(graph_id, 0) + int(n)
        out[signal_id] = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:limit]
    return out


def reset() -> None:
    """Forget what is counted and logged (tests)."""
    _pending.clear()
    _told.update(refused=False, dropped=False)
