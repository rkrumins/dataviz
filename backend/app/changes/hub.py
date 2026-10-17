"""Per-process fan-out for the change stream.

One background task per web process tails Redis; every connected client
is served from memory. That shape is the whole design, and it is a
deliberate departure from the job-events SSE next door.

**Why not one Redis reader per client.** The job stream gives each client
its own blocking ``XREAD``, so a connection is parked for the client's
whole lifetime. The bus pool is built with ``max_connections=20`` per
process and is shared with everything else that talks to Redis in that
process — session revocation checks, permission claims, rate-limit
counters — and it *raises* on exhaustion rather than waiting. That is
survivable for a handful of people watching job rows. It is not
survivable for a channel every open tab holds: at the documented target
of ~300 concurrent users the arithmetic says roughly 150 streams per
process, and long before that the process stops being able to
authenticate anybody. Here Redis connections are O(processes) — one —
regardless of how many clients are attached.

**Why a dirty-set instead of a queue.** Each subscriber holds
``{topic: version}`` plus an ``asyncio.Event``. Publishing is
``pending[topic] = version; wake.set()`` — it never awaits, never blocks
on a slow reader, and is bounded by the subscriber's topic count. There
is no drop policy because there is nothing to drop: a topic that moves
five times while a client is busy collapses to its latest version, which
is exactly what the client would have fetched anyway. Backpressure is
structurally impossible rather than handled.

**Why a resync on every (re)connect to Redis.** The hub cannot prove it
saw every entry — the stream is capped, a reconnect can span a gap, and
a cold process starts at the tail with no history. So it does not try:
on entering the tailing state it tells every attached subscriber to
reconcile against the manifest, which is authoritative. This is what
allows the transport to be lossy, and a lossy transport is what allows
it to be cheap.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Iterable, Optional

from .registry import stream_key

logger = logging.getLogger(__name__)

__all__ = ["ChangeHub", "Subscriber", "get_hub", "reset_for_testing"]


# How long ``XREAD`` blocks before looping. Short enough to notice
# cancellation promptly at shutdown, long enough that a quiet stream —
# the normal state — costs one Redis round trip every few seconds per
# process rather than a busy loop.
_XREAD_BLOCK_MS = 5_000

# Backoff after a Redis read error, so an unreachable Redis is retried
# steadily instead of hammered.
_RECONNECT_DELAY_S = 2.0


class Subscriber:
    """One connected client's view of the feed.

    Not constructed directly — :meth:`ChangeHub.subscribe` hands these
    out and removes them on close.
    """

    __slots__ = ("topics", "pending", "wake", "needs_resync")

    def __init__(self, topics: Iterable[str]) -> None:
        self.topics: frozenset[str] = frozenset(topics)
        self.pending: dict[str, int] = {}
        self.wake = asyncio.Event()
        #: Set when this subscriber must reconcile against the manifest
        #: rather than trust the deltas it has been sent.
        self.needs_resync = False

    def offer(self, topic: str, version: int) -> None:
        """Record a change if this subscriber cares about it.

        Synchronous and total: no await, no failure mode, no unbounded
        growth. ``max`` guards against an out-of-order delivery lowering
        a version the client has already been told about.
        """
        if topic not in self.topics:
            return
        current = self.pending.get(topic)
        self.pending[topic] = version if current is None else max(current, version)
        self.wake.set()

    def mark_resync(self) -> None:
        self.needs_resync = True
        self.wake.set()

    def drain(self) -> tuple[dict[str, int], bool]:
        """Take everything pending and clear the flag. Never blocks."""
        pending, self.pending = self.pending, {}
        resync, self.needs_resync = self.needs_resync, False
        self.wake.clear()
        return pending, resync

    async def wait(self, timeout: float) -> bool:
        """Wait for something to send. False on timeout (send a heartbeat)."""
        try:
            await asyncio.wait_for(self.wake.wait(), timeout=timeout)
            return True
        except (asyncio.TimeoutError, TimeoutError):
            return False


class ChangeHub:
    """Tails the change stream and fans entries out in-process."""

    def __init__(self, redis_client) -> None:
        self._redis = redis_client
        self._subscribers: set[Subscriber] = set()
        self._task: Optional[asyncio.Task] = None
        self._ready = asyncio.Event()

    # ── lifecycle ─────────────────────────────────────────────────

    def start(self) -> None:
        """Begin tailing. Idempotent."""
        if self._task is not None and not self._task.done():
            return
        self._task = asyncio.create_task(self._run(), name="change-hub")

    async def stop(self) -> None:
        """Stop tailing and release every subscriber."""
        self._ready.clear()
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None
        # Wake everyone so their streams can close cleanly rather than
        # sitting on a heartbeat timeout while the process goes down.
        for sub in list(self._subscribers):
            sub.mark_resync()

    @property
    def ready(self) -> bool:
        """True once the tail is live.

        The stream endpoint checks this and refuses rather than opening a
        connection the hub cannot serve. It matters more than it looks:
        the SSE bypass in the timeout middleware returns *before* the
        readiness gate, so a client reconnecting during a rolling deploy
        reaches the handler while the process is still starting.
        """
        return self._ready.is_set()

    # ── subscription ──────────────────────────────────────────────

    def subscribe(self, topics: Iterable[str]) -> Subscriber:
        sub = Subscriber(topics)
        # A new subscriber has not seen anything, and cannot know what it
        # missed before it attached. It reconciles first, then trusts the
        # deltas.
        sub.mark_resync()
        self._subscribers.add(sub)
        return sub

    def unsubscribe(self, sub: Subscriber) -> None:
        self._subscribers.discard(sub)

    @property
    def subscriber_count(self) -> int:
        return len(self._subscribers)

    # ── the tail ──────────────────────────────────────────────────

    def _broadcast_resync(self) -> None:
        for sub in list(self._subscribers):
            sub.mark_resync()

    def _dispatch(self, topic: str, version: int) -> None:
        for sub in list(self._subscribers):
            sub.offer(topic, version)

    async def _run(self) -> None:
        key = stream_key()
        # Start at the tail: history is not ours to replay. Anything that
        # happened before this process attached is covered by each
        # client's manifest read.
        last_id = "$"
        while True:
            try:
                if not self._ready.is_set():
                    # Entering (or re-entering) the tailing state. Nobody
                    # can prove what was missed while we were away, so
                    # everyone reconciles.
                    self._broadcast_resync()
                    self._ready.set()

                entries = await self._redis.xread(
                    {key: last_id}, block=_XREAD_BLOCK_MS, count=100
                )
                if not entries:
                    continue
                for _stream, records in entries:
                    for entry_id, fields in records:
                        last_id = entry_id
                        topic = fields.get("topic")
                        raw_version = fields.get("version")
                        if not topic:
                            continue
                        try:
                            version = int(raw_version)
                        except (TypeError, ValueError):
                            # A malformed entry is not worth dropping the
                            # tail for; treat it as "something moved".
                            self._broadcast_resync()
                            continue
                        self._dispatch(topic, version)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                # Redis went away, or answered something unexpected. Drop
                # out of the ready state so the next successful loop
                # broadcasts a resync — the gap we just created is
                # exactly what resync exists for.
                self._ready.clear()
                logger.warning("change hub tail error: %s", exc)
                await asyncio.sleep(_RECONNECT_DELAY_S)


_hub: Optional[ChangeHub] = None


def get_hub() -> ChangeHub:
    """Process-wide hub singleton."""
    global _hub
    if _hub is None:
        from backend.app.services.aggregation.redis_client import get_redis

        _hub = ChangeHub(get_redis())
    return _hub


def reset_for_testing() -> None:
    """Drop the singleton. Tests only."""
    global _hub
    _hub = None
