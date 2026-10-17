"""The change registry, and the invariants clients depend on.

The change feed replaces nine idle polls with one question — "has
anything you are showing moved?" — so the properties that matter are not
about throughput, they are about what happens when the answer is wrong.
Each test below corresponds to a way a client could be left permanently
stale with nothing in any log to show for it.
"""
from __future__ import annotations

import asyncio

import pytest

from backend.app.changes import topics as change_topics
from backend.app.changes.registry import (
    InMemoryChangeRegistry,
    RedisChangeRegistry,
    version_key,
)


# ── topics: the authorization boundary ────────────────────────────────


def test_topics_are_derived_from_the_user_not_requested():
    """A caller gets exactly their own per-user topics."""
    topics = change_topics.topics_for_user("u_alice")

    assert change_topics.notifications_for("u_alice") in topics
    assert change_topics.permissions_for("u_alice") in topics
    assert change_topics.invite_activity_for("u_alice") in topics
    # Nothing belonging to anyone else, by construction.
    assert change_topics.notifications_for("u_bob") not in topics
    assert change_topics.permissions_for("u_bob") not in topics


def test_global_topics_are_included_for_everyone():
    topics = change_topics.topics_for_user("u_alice")
    for topic in change_topics.GLOBAL_TOPICS:
        assert topic in topics


def test_narrow_can_only_shrink_the_set():
    """A client-supplied list is a filter, never a grant.

    This is the whole defence against ``?topics=notif:someone-else``: the
    requested name is intersected with what the session may hear, so a
    forbidden topic simply is not in the result. There is deliberately no
    error, because a distinguishable error is a probing oracle.
    """
    allowed = change_topics.topics_for_user("u_alice")

    narrowed = change_topics.narrow(
        allowed,
        [
            change_topics.ANNOUNCEMENTS,
            change_topics.notifications_for("u_bob"),   # not theirs
            "totally-made-up",                          # not a topic
        ],
    )

    assert narrowed == (change_topics.ANNOUNCEMENTS,)


def test_narrow_with_no_request_returns_everything_allowed():
    allowed = change_topics.topics_for_user("u_alice")
    assert change_topics.narrow(allowed, None) == allowed


# ── registry semantics ────────────────────────────────────────────────


async def test_bump_advances_and_snapshot_reads():
    registry = InMemoryChangeRegistry()

    assert await registry.snapshot(["a"]) == {"a": 0}
    await registry.bump("a")
    await registry.bump("a")
    assert await registry.snapshot(["a"]) == {"a": 2}


async def test_unknown_topic_reads_zero_not_missing():
    """A client diffs the whole map, so a missing key must read as 0.

    If ``snapshot`` omitted unknown topics, a client that had never seen
    a topic bumped would find no entry, skip the comparison, and never
    fetch that resource at all.
    """
    registry = InMemoryChangeRegistry()
    assert await registry.snapshot(["never-bumped"]) == {"never-bumped": 0}


async def test_snapshot_of_nothing_is_empty_not_an_error():
    registry = InMemoryChangeRegistry()
    assert await registry.snapshot([]) == {}


# ── the Redis implementation's failure contract ───────────────────────


class _ExplodingRedis:
    """Every operation fails, the way an unreachable Redis would."""

    def pipeline(self):
        raise ConnectionError("redis is down")

    async def mget(self, keys):
        raise ConnectionError("redis is down")


async def test_bump_never_raises_into_the_caller():
    """A publish failure must not fail the write that triggered it.

    ``bump`` is called from the commit path of real mutations. If it
    could raise, a Redis blip would turn "your announcement was saved"
    into a 500 — failing a write because a cache-invalidation hint could
    not be delivered.
    """
    registry = RedisChangeRegistry(_ExplodingRedis())
    assert await registry.bump(change_topics.ANNOUNCEMENTS) is None


async def test_snapshot_raises_rather_than_reporting_zeros():
    """The read path must NOT fail open to zeros.

    Zeros are not a neutral answer — they are the specific answer
    "everything you hold is stale". Every connected client would refetch
    every resource at once, aimed at a backend that is already unwell.
    Raising lets the endpoint answer 503, and clients keep what they have.
    """
    registry = RedisChangeRegistry(_ExplodingRedis())
    with pytest.raises(ConnectionError):
        await registry.snapshot([change_topics.ANNOUNCEMENTS])


def test_version_key_is_namespaced():
    assert version_key("announcements").endswith(":v:announcements")


# ── the ordering invariant, stated as an executable example ───────────


async def test_a_change_between_fetch_and_version_read_is_not_lost():
    """Read the version FIRST, then the data. Never the other way round.

    The natural implementation is backwards — fetch the resource, then
    record the version you were told about — and it loses any change
    committed in between, permanently:

        fetch data       (sees v1 content)
        ... writer commits, bumps to v2 ...
        read version     -> 2
        store applied=2  -> client believes it holds v2, but holds v1

    Reading the version first makes the same interleaving safe: the
    client stores the OLD version, sees the mismatch on its next check,
    and refetches.
    """
    registry = InMemoryChangeRegistry()
    await registry.bump("announcements")          # now at 1

    # Correct order: version first.
    observed_version = (await registry.snapshot(["announcements"]))["announcements"]
    # A writer commits while the client is fetching the resource.
    await registry.bump("announcements")          # now at 2
    applied = observed_version                    # what the client records

    later = (await registry.snapshot(["announcements"]))["announcements"]
    assert later != applied, (
        "client would not refetch — the change committed during its fetch "
        "was lost"
    )


async def test_clients_must_compare_with_inequality_not_greater_than():
    """A counter can go backwards, so ``>`` would latch forever.

    Counters carry a TTL (they must, to be evictable under this
    deployment's ``volatile-lru`` policy) and a missing key reads as 0. A
    client holding 4000 that only refetches on ``new > applied`` would
    never fetch again after an eviction.
    """
    registry = InMemoryChangeRegistry()
    applied = 4000                                 # what a long-lived tab holds

    after_eviction = (await registry.snapshot(["announcements"]))["announcements"]

    assert after_eviction == 0
    assert not (after_eviction > applied), "a '>' comparison would never fire again"
    assert after_eviction != applied, "'!=' correctly detects the reset"
