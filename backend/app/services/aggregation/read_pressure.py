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
  shared job-bus Redis with a short TTL. Keyed by the NODE that owns the
  graph whose read starved — the same identity the reservation ledger and
  the write slots use — so it lands on the writers of the shard that is
  actually starving and not on every writer in the cluster. (The previous
  key was the connection config's host:port, a seed address on a cluster:
  pressure on one shard made a rebuild on a different, idle shard yield.)
  Outside cluster mode there is one node and the two are the same string.
  At most one stamp per provider per ``_SIGNAL_MIN_INTERVAL_S`` per
  process — a 504 storm costs one SET.
* **Worker** (``AggregationAdmission.read_pressure``): the materializer's
  pacing loop reads the key (memoised for a couple of seconds) and, while
  it lives, stretches its sleep-after-write to
  ``AGGREGATION_READ_PRESSURE_PACING_RATIO``. Jobs finish later; users
  are not kept waiting on a background rebuild.

Fail-open both ways: no Redis, no signal, no slowdown. Never raises into
a request or a job.

**One key, resolved one way.** Both halves used to derive the key
independently and fall back independently — the stamp to the connection
seed when the owner lookup timed out, the worker to the same seed when its
governor had no measured reading. The two fallbacks fire under exactly the
load this mechanism exists for, and they fire at different moments, so the
stamp and the read addressed different keys and the yield silently never
happened. When they both fell back, the shared seed made pressure on shard 0
throttle rebuilds on shards 1 and 2 — the fleet-wide yield described above as
the bug. :func:`pressure_key` is now the single resolver, and on a cluster it
returns None rather than the seed: no key means no yield for this signal,
which is strictly better than a yield aimed at every shard.

Rolling deploy: for the length of one rollout a web pod may stamp the node
key while a worker still reads the endpoint key (or the reverse), and a
cluster's reads lose the yield until both sides are new. Both halves ship in
one image, the window is minutes, and the failure is "aggregation does not
slow down for a few minutes", which is the same direction every other
fail-open in this module takes.
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
    "signals_unkeyed": 0,
    "signal_errors": 0,
}


def _count(outcome: str) -> None:
    """One counter, two places.

    ``_STATS`` is a module global, so it counts THIS process only — and the
    web tier runs twelve of them behind a load balancer. Release notes §8
    tells an operator to check ``signals_sent`` is non-zero on
    ``/health/deps``; against twelve processes that check reads zero on
    eleven of twelve hits, which is a verification step that fails when the
    thing works. The Prometheus counter is the one to alert on: it is
    per-process too, but a scrape sums across the fleet.
    """
    _STATS[outcome] = _STATS.get(outcome, 0) + 1
    try:
        from backend.app.jobs.metrics import increment

        increment("aggregation_read_pressure_signals_total", outcome=outcome)
    except Exception:  # noqa: BLE001 — a counter is never worth a request
        pass


def read_pressure_stats() -> dict[str, int]:
    """Process-wide counters, reported under ``/health/deps`` → resilience.
    Per PROCESS — see :func:`_count`; the Prometheus counter is the fleet
    view."""
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
            _count("signals_coalesced")
            return
        self._last_sent[endpoint] = now
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:  # pragma: no cover — listeners fire inside a request
            return
        task = loop.create_task(self._stamp(kind, target))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _stamp(self, kind: str, target: Any = None) -> None:
        endpoint = await pressure_key(target)
        if endpoint is None:
            _count("signals_unkeyed")
            return
        try:
            await self._redis_factory().set(read_pressure_key(endpoint), kind, ex=_TTL_S)
        except Exception as exc:  # noqa: BLE001 — fail open
            _count("signal_errors")
            logger.debug("read-pressure stamp failed for %s: %s", endpoint, exc)
            return
        _count("signals_sent")
        logger.info(
            "read pressure on %s (%s): aggregation writers yield for the next %ds",
            endpoint, kind, _TTL_S,
        )


_OWNER_LOOKUP_TIMEOUT_S = 2.0


async def pressure_key(target: Any) -> str | None:
    """The read-pressure key for ``target``'s graph, or None when there is
    none to write.

    **The one resolver.** Whoever stamps and whoever reads must agree, so both
    sides call this rather than deriving a key of their own. (The worker half
    lives in ``falkordb_materialize``; it passes the node its governor
    measured, which is this same owning endpoint.)

    Outside cluster mode there is one node and ``endpoint_key`` already names
    it. On a cluster the answer is the node that owns the graph, off the
    client's CURRENT slot map — the one its own reads route by — so it costs
    no round trip once the map is there.

    **On a cluster there is no fallback.** The connection endpoint is a seed
    shared by every shard, so a stamp written there tells the writers of all
    three shards to slow down for pressure on one. That is the regression this
    module exists to have fixed, and it would fire precisely when the lookup
    is slowest — under load. None instead: this one signal is lost, the next
    one (five seconds later, at most) lands, and nothing idle is throttled.
    """
    db = getattr(target, "_db", None)
    graph = getattr(target, "_graph_name", None)
    cfg = getattr(target, "_conn_cfg", None)
    if getattr(cfg, "mode", None) != "cluster":
        return endpoint_key(target)
    if db is None or not graph:
        return None
    try:
        from backend.app.providers.shard_capacity import owner_endpoint

        owner = await owner_endpoint(
            db, mode="cluster", graph_key=graph, timeout=_OWNER_LOOKUP_TIMEOUT_S,
        )
    except Exception as exc:                          # noqa: BLE001 — fail open
        logger.debug("read-pressure owner lookup failed for %s: %s", graph, exc)
        return None
    return owner if owner and owner != "unknown" else None
