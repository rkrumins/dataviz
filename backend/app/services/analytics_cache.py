"""Result cache for the Analytics endpoints.

The summary document is ~25 aggregate queries. Uncached, every page load and
every range toggle pays all of them, and a handful of admins opening the
dashboard at 9am pays them concurrently.

Two layers, because they solve different problems:

* **Single-flight** collapses *concurrent* identical requests, so a cold key hit
  by five browsers at once runs the queries once and hands the same document to
  all five. This is the classic thundering herd, and
  ``backend/app/common/single_flight.py`` already exists for exactly it.
* **A short TTL cache** serves *sequential* repeats — the same admin switching
  tabs, or the next admin ten seconds later. Single-flight alone does nothing
  for these; the work has already finished, so there is no flight to join.

Redis-backed when a client is reachable, so replicas share one warm copy;
in-process otherwise, so this works in dev, in tests, and during a Redis
outage. The fallback is not a degraded mode to apologise for — a per-replica
cache is a completely adequate cache for an admin dashboard, and making Redis
mandatory would mean an outage in a cache takes down a read-only page.

**Staleness is a deliberate product choice, not a compromise.** Growth metrics
are read in minutes and act on in weeks; a document up to a minute old is
indistinguishable from a live one to a human reading a 90-day trend, and the
response carries ``generatedAt`` so the UI can say exactly how old it is.
"""
from __future__ import annotations

import json
import logging
import time
from typing import Any, Awaitable, Callable, Optional

from backend.app.common.single_flight import SingleFlight

logger = logging.getLogger(__name__)

#: How long a computed document stays servable. Short enough that "as of" never
#: reads as wrong, long enough to absorb tab-switching and a room full of
#: admins opening the same dashboard.
TTL_SECONDS = 60.0

#: Redis key prefix. Versioned so a payload-shape change cannot serve a
#: document the current frontend cannot read — bump it when the shape changes.
_PREFIX = "analytics:v1:"

#: Concurrency dedup. Its TTL is the ceiling on how long a follower waits for a
#: leader, not a cache lifetime, so it tracks the slowest plausible summary.
_flight = SingleFlight(ttl_seconds=30.0)

#: Per-replica fallback: ``{key: (expires_at, document)}``. Bounded by key
#: cardinality, which is bounded by the range presets × workspaces.
_memory: dict[str, tuple[float, Any]] = {}

#: Redis is optional. Once a call fails we stop trying for this long rather
#: than paying a connect timeout on every request during an outage.
_REDIS_RETRY_AFTER = 30.0
_redis_down_until = 0.0


async def _redis_get(key: str) -> Optional[Any]:
    global _redis_down_until
    if time.monotonic() < _redis_down_until:
        return None
    try:
        from backend.app.services.aggregation.redis_client import get_redis

        raw = await get_redis().get(_PREFIX + key)
        return json.loads(raw) if raw else None
    except Exception as exc:  # noqa: BLE001 — a cache must never fail a read
        _redis_down_until = time.monotonic() + _REDIS_RETRY_AFTER
        logger.debug("Analytics cache read fell back to memory: %s", exc)
        return None


async def _redis_set(key: str, value: Any) -> None:
    global _redis_down_until
    if time.monotonic() < _redis_down_until:
        return
    try:
        from backend.app.services.aggregation.redis_client import get_redis

        await get_redis().set(
            _PREFIX + key, json.dumps(value), ex=int(TTL_SECONDS),
        )
    except Exception as exc:  # noqa: BLE001 — same: never fail the request
        _redis_down_until = time.monotonic() + _REDIS_RETRY_AFTER
        logger.debug("Analytics cache write skipped: %s", exc)


def _memory_get(key: str) -> Optional[Any]:
    entry = _memory.get(key)
    if entry is None:
        return None
    expires_at, value = entry
    if expires_at < time.monotonic():
        _memory.pop(key, None)
        return None
    return value


async def cached(key: str, build: Callable[[], Awaitable[Any]]) -> Any:
    """Return ``key``'s document, computing it at most once per TTL per key.

    ``build`` is a factory rather than an awaited coroutine so that followers
    joining a flight never re-invoke the work themselves.
    """
    hit = _memory_get(key)
    if hit is not None:
        return hit
    hit = await _redis_get(key)
    if hit is not None:
        # Populate the local layer too: the next read on this replica skips
        # even the Redis round trip.
        _memory[key] = (time.monotonic() + TTL_SECONDS, hit)
        return hit

    async def _compute() -> Any:
        # Re-check inside the flight: the leader may have landed while this
        # caller was queueing, and recomputing would waste the dedup entirely.
        again = _memory_get(key)
        if again is not None:
            return again
        value = await build()
        # A ``None`` document means "no such workspace". Caching it would store
        # an entry that ``cached`` can never serve (it tests ``is not None``),
        # so a caller walking random ids would grow ``_memory`` without bound
        # while getting no benefit. Negatives are cheap to recompute; don't
        # store them.
        if value is not None:
            _memory[key] = (time.monotonic() + TTL_SECONDS, value)
            await _redis_set(key, value)
        return value

    return await _flight.run(("analytics", key), _compute)


def clear() -> None:
    """Drop the in-process layer. For tests, which must not see each other's
    documents; Redis entries expire on their own TTL."""
    _memory.clear()
