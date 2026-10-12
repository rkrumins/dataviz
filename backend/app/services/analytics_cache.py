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
import os
import time
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Optional

from backend.app.common.single_flight import SingleFlight

logger = logging.getLogger(__name__)

def read_ttl_seconds() -> float:
    """How long a READ-THROUGH document stays servable: exactly one epoch.

    It was a flat 60 seconds, chosen when every build stamped its own ``now``
    and a shorter TTL genuinely meant fresher numbers. Once ``now`` snaps to
    the epoch that stopped being true in both directions.

    Shorter than an epoch is pure waste. Inside a slot the window bounds are
    pinned, so rebuilding at second 10 and again at second 250 produces the
    same document — at 60 seconds the fallback path paid for the same ~25
    grouped queries five times per slot and got the same answer five times.

    Longer than an epoch buys nothing either, because the epoch is part of the
    key: at the boundary the key changes and the old entry is unreachable no
    matter how long it lives. So an entry should live exactly as long as it can
    still be used, and every key is computed at most once, ever.
    """
    return epoch_seconds()

#: Redis key prefix. Versioned so a payload-shape change cannot serve a
#: document the current frontend cannot read — bump it when the shape changes.
_PREFIX = "analytics:v1:"

#: Concurrency dedup. Its TTL is the ceiling on how long a follower waits for a
#: leader, not a cache lifetime, so it tracks the slowest plausible summary.
_flight = SingleFlight(ttl_seconds=30.0)

#: Per-replica fallback: ``{key: (expires_at, document)}``.
_memory: dict[str, tuple[float, Any]] = {}

#: Ceiling on the in-process tier.
#:
#: Eviction here is lazy — ``_memory_get`` drops an entry when the key it was
#: asked for turns out to have expired. That only ever fires for a key someone
#: looks up again, and every key carries the epoch it was built for, so no key
#: is ever requested twice across a boundary. An entry therefore expires at
#: precisely the moment nothing can ask for it again, and the lazy path never
#: reaches it: without a bound the map grows by one entry per surface per
#: window per epoch, forever, independently in every worker process, holding a
#: whole analytics document each.
#:
#: 256 is generous next to what a slot actually needs — twelve warmed
#: documents, plus whatever custom ranges and drill-ins were asked for — and
#: small enough to stay a rounding error in a worker's footprint.
_MEMORY_MAX_ENTRIES = 256

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


async def _redis_set(key: str, value: Any, ttl: float | None = None) -> bool:
    """Write one entry. Returns whether it actually reached Redis."""
    global _redis_down_until
    ttl = read_ttl_seconds() if ttl is None else ttl
    if time.monotonic() < _redis_down_until:
        return False
    try:
        from backend.app.services.aggregation.redis_client import get_redis

        await get_redis().set(
            _PREFIX + key, json.dumps(value), ex=int(ttl),
        )
        return True
    except Exception as exc:  # noqa: BLE001 — same: never fail the request
        _redis_down_until = time.monotonic() + _REDIS_RETRY_AFTER
        logger.debug("Analytics cache write skipped: %s", exc)
        return False


def _memory_put(key: str, value: Any) -> None:
    """Store one entry, first dropping whatever has aged out of reach."""
    now = time.monotonic()
    if len(_memory) >= _MEMORY_MAX_ENTRIES:
        for stale in [k for k, (expires_at, _) in _memory.items() if expires_at < now]:
            _memory.pop(stale, None)
        # Still full, so these are live entries: a burst of distinct windows
        # rather than the accumulation above. Drop the tier instead of growing
        # past the bound — Redis still holds them, and the worst case is a
        # rebuild, which is what the read-through path is for.
        if len(_memory) >= _MEMORY_MAX_ENTRIES:
            _memory.clear()
    _memory[key] = (now + read_ttl_seconds(), value)


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
        _memory_put(key, hit)
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
            _memory_put(key, value)
            await _redis_set(key, value)
        return value

    return await _flight.run(("analytics", key), _compute)


# ── One clock for every window ───────────────────────────────────────

#: How wide a slot of wall clock counts as "the same instant".
#:
#: Every document is a trailing window ending at ``now``, and ``now`` used to
#: be whatever the wall clock said when that particular document happened to be
#: built. Six warmed windows in one pass therefore had six different ends, and
#: a read-through miss had a seventh — so a 14-day figure could be SMALLER than
#: the 7-day figure it contains, because the 14-day document was built a minute
#: earlier and had not seen the newest events. Reported from the running app:
#: "Saved views" showed 4 over 7 days and 3 over 14, and a popular view
#: vanished entirely as the window widened.
#:
#: Snapping ``now`` down to a fixed grid makes every document built in the same
#: slot share an end instant exactly, which is what makes them comparable. The
#: epoch is part of the CACHE KEY as well, so all windows roll over together
#: rather than a fresh 7-day document being served beside a stale 14-day one —
#: mixing two epochs is the same bug wearing a smaller number.
#:
#: Aligned with the warm interval by construction: they read the same variable,
#: so a deployment that speeds one up speeds up the other.
_DEFAULT_EPOCH_SECONDS = 300.0


#: Floor on the grid. Each warm pass is ~25 grouped queries per window, so a
#: very short setting turns the warmer into the load it exists to remove.
#:
#: It lives HERE, with the grid, because this is the single clamp — the warmer
#: used to apply its own floor of 30 to the same variable while this function
#: allowed 1, so ``ANALYTICS_WARM_INTERVAL_SECONDS=10`` gave readers a 10s grid
#: and the warmer a 30s cadence: it wrote keys for epochs readers had already
#: passed and warmed nothing, silently. Two clamps on one variable is two
#: clocks wearing one name.
_MIN_EPOCH_SECONDS = 30.0


def epoch_seconds() -> float:
    raw = os.getenv("ANALYTICS_WARM_INTERVAL_SECONDS")
    if not raw:
        return _DEFAULT_EPOCH_SECONDS
    try:
        parsed = float(raw)
    except ValueError:
        logger.warning(
            "ANALYTICS_WARM_INTERVAL_SECONDS=%r is not a number; using %.0f",
            raw, _DEFAULT_EPOCH_SECONDS,
        )
        return _DEFAULT_EPOCH_SECONDS
    if parsed < _MIN_EPOCH_SECONDS:
        logger.warning(
            "ANALYTICS_WARM_INTERVAL_SECONDS=%.0f is too aggressive; "
            "clamping to %.0fs.", parsed, _MIN_EPOCH_SECONDS,
        )
        return _MIN_EPOCH_SECONDS
    return parsed


def epoch_start(at: Optional[datetime] = None) -> datetime:
    """The start of the slot ``at`` falls in — the shared "now" for a document.

    Callers pass this to the repository AND fold it into the cache key, so a
    document and the key it is stored under always agree about when it ends.
    """
    at = at or datetime.now(timezone.utc)
    grid = epoch_seconds()
    stamp = at.timestamp()
    return datetime.fromtimestamp(stamp - (stamp % grid), tz=timezone.utc)


#: Bump when the SHAPE of a cached document changes — a field added, removed
#: or renamed. These documents outlive the code that wrote them: they sit in
#: Redis for a TTL measured in minutes, so a deploy that adds a field will keep
#: serving the old shape to freshly-deployed clients until every entry expires.
#: Versioning the key makes a shape change a cache miss instead of a puzzle.
#: (v2 added ``series.previous.buckets``.)
SCHEMA_VERSION = 2


def document_key(
    surface: str, args: dict[str, Any], *, epoch: Optional[datetime] = None,
) -> str:
    """The cache key for one surface over one window.

    Lives HERE rather than in the endpoint because two callers now build it —
    the reader and the warmer — and a key they disagree about is a warmer that
    silently warms nothing. Built from the resolved window arguments rather
    than the query string, so ``?days=30`` and ``?days=30&from=`` land on the
    same entry.

    ``raw:`` names what the value is: an UNREDACTED document, shared by every
    reader, filtered per-reader on the way out. Nothing may serve it directly.

    ``epoch`` is the instant the window ENDS at, and it belongs in the key for
    the same reason the window does: it is an input to the document. Without it
    a 7-day entry written this minute sits in the cache beside a 14-day entry
    written five minutes ago, and the two contradict each other.
    """
    window = (
        f"d{args['days']}" if "days" in args
        else f"{args.get('start')}:{args.get('end')}"
    )
    stamp = int((epoch or epoch_start()).timestamp())
    return f"raw:v{SCHEMA_VERSION}:e{stamp}:{surface}:{window}"


async def put(key: str, value: Any, *, ttl: float) -> bool:
    """Store a precomputed document. Returns whether Redis took it.

    The warmer's write path.

    ``ttl`` used to be several refresh passes long, so a warmed entry outlived
    a missed pass and a stalled warmer degraded to staler numbers rather than
    to a stampede. The epoch in the key ended that: at the next slot the key
    changes, and last slot's entry cannot be served however long it lives. An
    entry only needs to outlast its own slot now, and a longer TTL just leaves
    dead keys squatting in Redis.

    The failure mode moved with it, deliberately. A missed pass no longer means
    "everyone sees slightly older numbers"; it means readers rebuild that slot
    on demand, deduplicated by single-flight. Correct but slower, which is what
    the fallback path has always been — and the alternative was serving last
    slot's 14-day document beside this slot's 7-day one, which is the
    contradiction all of this exists to prevent.
    """
    if value is None:
        return False
    _memory_put(key, value)
    return await _redis_set(key, value, ttl)


def clear() -> None:
    """Drop the in-process layer. For tests, which must not see each other's
    documents; Redis entries expire on their own TTL."""
    _memory.clear()
