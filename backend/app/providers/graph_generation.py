"""Per-graph generation: how every process learns a FalkorDB graph was dropped.

falkordb-py decodes a result's labels, relationship types and property keys through a
per-Graph copy of the graph's catalogue, and refreshes it only when an id is out of range:
the async client never sends a schema version (and never awaits the refresh its
version-mismatch branch would start). A graph that is dropped and written again gets a new
catalogue under the SAME name, so every long-lived handle keeps decoding with the old
names — in the 2026-09-22 incident every Domain rendered as "Schema Field" while FalkorDB
and Postgres were both intact.

Rebuilds no longer drop (the projector reconciles in place). Whatever still does —
eviction, purge — bumps ``falkorgen:<graph>`` on the job-bus Redis, and every provider
checks it before a query (at most once per interval) and clears its handles' tables when
it moved. Pull, not push: a process that missed a message, or started after it, still
converges within one interval.
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Awaitable, Callable, Dict, Optional, Tuple

logger = logging.getLogger(__name__)

_KEY = "falkorgen:{}"
#: How often a provider re-reads a graph's generation. A read is one Redis GET.
CHECK_INTERVAL_S = 2.0
#: The read rides a user's query: a slow or unreachable bus must cost that query at most
#: this, never the client's multi-second socket timeouts. A timed-out read changes nothing.
READ_TIMEOUT_S = 0.25
_TTL_S = 30 * 24 * 3600


async def bump_graph_generation(graph_name: str, *, reason: str, redis_client=None) -> None:
    """Record that ``graph_name`` was dropped. Never raises: a missed bump costs at most
    staleness until an id falls out of range, never a failed drop."""
    try:
        if redis_client is None:
            from backend.app.services.aggregation.redis_client import get_redis
            redis_client = get_redis()
        key = _KEY.format(graph_name)
        gen = await redis_client.incr(key)
        # Bounded, not permanent: a lapsed key reads as "moved" once — a harmless refresh.
        await redis_client.expire(key, _TTL_S)
        logger.info("graph %s dropped (%s) — generation %s", graph_name, reason, gen)
    except Exception as exc:                             # pragma: no cover - infra
        logger.warning("could not record that graph %s was dropped (%s): %s — long-lived "
                       "readers keep their id tables until an id falls out of range",
                       graph_name, reason, exc)


async def read_graph_generation(graph_name: str, redis_client=None) -> Optional[str]:
    if redis_client is None:
        from backend.app.services.aggregation.redis_client import get_redis
        redis_client = get_redis()
    value = await redis_client.get(_KEY.format(graph_name))
    return None if value is None else str(value)


class GraphRebuildWatch:
    """One provider's view of its graphs' generations."""

    def __init__(
        self,
        reader: Callable[[str], Awaitable[Optional[str]]] = read_graph_generation,
        clock: Callable[[], float] = time.monotonic,
        interval_s: float = CHECK_INTERVAL_S,
        read_timeout_s: float = READ_TIMEOUT_S,
    ):
        self._reader = reader
        self._clock = clock
        self._interval = interval_s
        self._read_timeout = read_timeout_s
        self._seen: Dict[str, Tuple[bool, Optional[str]]] = {}   # name -> (known, generation)
        self._checked_at: Dict[str, float] = {}

    async def rebuilt(self, graph_name: str) -> bool:
        """True exactly once after ``graph_name``'s generation moves. The first look only
        records it: a handle built now holds no tables yet."""
        now = self._clock()
        if now - self._checked_at.get(graph_name, float("-inf")) < self._interval:
            return False
        self._checked_at[graph_name] = now
        try:
            current = await asyncio.wait_for(self._reader(graph_name), timeout=self._read_timeout)
        except Exception:
            return False                                 # an unreadable bus changes nothing
        known, seen = self._seen.get(graph_name, (False, None))
        self._seen[graph_name] = (True, current)
        return known and current != seen
