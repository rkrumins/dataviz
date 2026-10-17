"""The per-process fan-out hub.

The hub exists so that Redis work is O(processes) instead of O(clients).
The job-events stream next door does the opposite — one blocking
``XREAD`` per connected client — and that is survivable only because
almost nobody watches job rows. A channel every open tab holds would
exhaust the shared bus pool (``max_connections=20``, and it raises rather
than waits on exhaustion) and start failing session revocation checks and
permission claims for everyone on the replica.

So the properties worth pinning are the ones that keep it cheap and the
ones that keep it honest: publishing never blocks or drops, a subscriber
only hears its own topics, and any gap the hub cannot account for turns
into a resync rather than a guess.
"""
from __future__ import annotations

import asyncio

import pytest

from backend.app.changes.hub import ChangeHub, Subscriber


# ── Subscriber: the dirty-set ─────────────────────────────────────────


def test_offer_ignores_topics_the_subscriber_did_not_ask_for():
    sub = Subscriber(["announcements"])
    sub.offer("notif:someone-else", 5)
    pending, _ = sub.drain()
    assert pending == {}


def test_repeated_offers_collapse_to_the_latest_version():
    """A flapping topic must not accumulate work.

    This is why the subscriber holds a dirty-set rather than a queue:
    there is no backlog to bound and therefore no drop policy to get
    wrong. Five bumps while a client is busy are one refetch, which is
    all the client would have done anyway.
    """
    sub = Subscriber(["announcements"])
    for version in (1, 2, 3, 4, 5):
        sub.offer("announcements", version)

    pending, _ = sub.drain()
    assert pending == {"announcements": 5}


def test_an_out_of_order_offer_cannot_lower_a_version():
    sub = Subscriber(["announcements"])
    sub.offer("announcements", 9)
    sub.offer("announcements", 4)
    pending, _ = sub.drain()
    assert pending == {"announcements": 9}


def test_drain_clears_so_the_next_wait_blocks():
    sub = Subscriber(["announcements"])
    sub.offer("announcements", 1)
    assert sub.wake.is_set()
    sub.drain()
    assert not sub.wake.is_set()


async def test_wait_times_out_when_nothing_happens():
    """A quiet stream must fall through to a heartbeat, not hang."""
    sub = Subscriber(["announcements"])
    assert await sub.wait(timeout=0.01) is False


async def test_wait_returns_true_when_woken():
    sub = Subscriber(["announcements"])
    sub.offer("announcements", 1)
    assert await sub.wait(timeout=0.01) is True


# ── Hub: dispatch and resync ──────────────────────────────────────────


class _FakeRedis:
    """Serves scripted ``xread`` results, then blocks.

    The trailing block matters: a real ``XREAD`` parks rather than
    returning empty forever, and a fake that returns immediately would
    spin the hub's loop and make timing-based assertions meaningless.
    """

    def __init__(self, batches=None, fail_times: int = 0):
        self._batches = list(batches or [])
        self._fail_times = fail_times
        self.read_count = 0

    async def xread(self, streams, block=None, count=None):
        self.read_count += 1
        if self._fail_times > 0:
            self._fail_times -= 1
            raise ConnectionError("redis is down")
        if self._batches:
            return self._batches.pop(0)
        await asyncio.sleep(3600)


async def _settle(times: int = 20) -> None:
    for _ in range(times):
        await asyncio.sleep(0)


@pytest.fixture
async def hub_factory():
    hubs: list[ChangeHub] = []

    def _make(redis) -> ChangeHub:
        hub = ChangeHub(redis)
        hubs.append(hub)
        return hub

    yield _make
    for hub in hubs:
        await hub.stop()


async def test_a_new_subscriber_starts_owing_a_resync():
    """It cannot know what it missed before attaching, so it asks."""
    hub = ChangeHub(_FakeRedis())
    sub = hub.subscribe(["announcements"])
    _, needs_resync = sub.drain()
    assert needs_resync is True


async def test_a_stream_entry_reaches_a_matching_subscriber(hub_factory):
    redis = _FakeRedis(
        batches=[[("changes:stream", [("1-0", {"topic": "announcements", "version": "7"})])]]
    )
    hub = hub_factory(redis)
    sub = hub.subscribe(["announcements"])
    sub.drain()  # clear the initial resync

    hub.start()
    await _settle()

    pending, _ = sub.drain()
    assert pending == {"announcements": 7}


async def test_a_stream_entry_skips_a_non_matching_subscriber(hub_factory):
    redis = _FakeRedis(
        batches=[[("changes:stream", [("1-0", {"topic": "notif:usr_a", "version": "3"})])]]
    )
    hub = hub_factory(redis)
    mine = hub.subscribe(["notif:usr_a"])
    theirs = hub.subscribe(["notif:usr_b"])
    mine.drain()
    theirs.drain()

    hub.start()
    await _settle()

    assert mine.drain()[0] == {"notif:usr_a": 3}
    assert theirs.drain()[0] == {}


async def test_becoming_ready_broadcasts_a_resync(hub_factory):
    """Attaching to the tail is exactly when history is unknowable."""
    hub = hub_factory(_FakeRedis())
    sub = hub.subscribe(["announcements"])
    sub.drain()

    hub.start()
    await _settle()

    assert hub.ready is True
    assert sub.drain()[1] is True


async def test_a_redis_failure_drops_readiness_and_resyncs_on_recovery(hub_factory):
    """A gap we cannot account for is a resync, never a guess.

    While the tail is broken the hub must also stop claiming to be ready,
    so the stream endpoint refuses new connections instead of opening
    ones it cannot feed.
    """
    redis = _FakeRedis(fail_times=1)
    hub = hub_factory(redis)
    sub = hub.subscribe(["announcements"])

    hub.start()
    # First loop: becomes ready, then the read raises and clears it.
    await _settle()
    sub.drain()

    # Wait out the reconnect backoff and let it re-enter the tail.
    await asyncio.sleep(2.2)
    await _settle()

    assert hub.ready is True
    assert sub.drain()[1] is True, "recovery did not broadcast a resync"


async def test_a_malformed_entry_resyncs_rather_than_dropping_the_tail(hub_factory):
    redis = _FakeRedis(
        batches=[[("changes:stream", [("1-0", {"topic": "announcements", "version": "not-a-number"})])]]
    )
    hub = hub_factory(redis)
    sub = hub.subscribe(["announcements"])
    sub.drain()

    hub.start()
    await _settle()

    pending, needs_resync = sub.drain()
    assert pending == {}
    assert needs_resync is True


async def test_unsubscribe_stops_delivery(hub_factory):
    hub = hub_factory(_FakeRedis())
    sub = hub.subscribe(["announcements"])
    assert hub.subscriber_count == 1
    hub.unsubscribe(sub)
    assert hub.subscriber_count == 0


async def test_stop_wakes_every_subscriber(hub_factory):
    """So streams close deliberately at shutdown.

    Without this each one sits on its heartbeat timeout while the process
    goes down, and they all reconnect at the same instant afterwards.
    """
    hub = hub_factory(_FakeRedis())
    sub = hub.subscribe(["announcements"])
    hub.start()
    await _settle()
    sub.drain()

    await hub.stop()

    assert sub.wake.is_set()
    assert hub.ready is False


async def test_start_is_idempotent(hub_factory):
    hub = hub_factory(_FakeRedis())
    hub.start()
    first = hub._task
    hub.start()
    assert hub._task is first


async def test_many_subscribers_share_one_redis_reader(hub_factory):
    """The whole point: Redis cost does not scale with client count."""
    redis = _FakeRedis(
        batches=[[("changes:stream", [("1-0", {"topic": "announcements", "version": "2"})])]]
    )
    hub = hub_factory(redis)
    subs = [hub.subscribe(["announcements"]) for _ in range(50)]
    for sub in subs:
        sub.drain()

    hub.start()
    await _settle()

    assert all(sub.drain()[0] == {"announcements": 2} for sub in subs)
    # One tail serving fifty clients — not fifty parked connections.
    assert redis.read_count <= 2
