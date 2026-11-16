"""Signals (``services/settings/signals.py``): counted in this process's memory where they happen,
added to Redis in hourly buckets, read back by window.

* ``bump`` does no IO: a Redis that raises when touched is never touched, and it runs with no event
  loop at all.
* A flush is one pipelined transaction: ``HINCRBY`` into the hour's buckets, each with its TTL.
* A flush Redis refuses keeps its counts for the next one; past the cap the oldest go, logged once.
* A window's count is the sum of its hours, given oldest first; a graph's are its own.
* The flusher flushes when it stops.
* An unknown id is refused where tests run, and dropped elsewhere.
* The ids are the registry's, once its ``SIGNALS`` are there.

Against a real Redis: ``integration/test_graph_health_live.py``.
"""
from __future__ import annotations

import asyncio
import inspect
import logging
from datetime import datetime, timezone

import pytest

from backend.app.services.settings import registry, signals

#: 13:30 UTC, 16 November 2026.
NOW = datetime(2026, 11, 16, 13, 30, tzinfo=timezone.utc).timestamp()
HOUR = 3600


class FakeRedis:
    """Enough of a Redis for signals: hashes, TTLs and pipelines, each pipeline it ran
    (``executed``: ``(transaction, commands)``); ``down`` refuses every one."""

    def __init__(self):
        self.hashes, self.ttl, self.executed, self.down = {}, {}, [], False

    def pipeline(self, transaction=True):
        return _Pipe(self, transaction)


class _Pipe:
    def __init__(self, redis, transaction):
        self.redis, self.transaction, self.commands = redis, transaction, []

    def __getattr__(self, name):
        def queue(*args):
            self.commands.append((name, *args))
            return self
        return queue

    async def execute(self):
        if self.redis.down:
            raise ConnectionError("Redis is out of reach")
        self.redis.executed.append((self.transaction, list(self.commands)))
        out = []
        for name, key, *args in self.commands:
            fields = self.redis.hashes.get(key, {})
            if name == "hincrby":
                fields = self.redis.hashes.setdefault(key, {})
                fields[args[0]] = fields.get(args[0], 0) + args[1]
                out.append(fields[args[0]])
            elif name == "expire":
                self.redis.ttl[key] = args[0]
                out.append(True)
            elif name == "hget":
                found = fields.get(args[0])
                out.append(None if found is None else str(found))
            elif name == "hgetall":
                out.append({k: str(v) for k, v in fields.items()})
        return out


@pytest.fixture
def redis(monkeypatch):
    fake = FakeRedis()
    monkeypatch.setattr(signals, "_redis", lambda: fake)
    monkeypatch.setattr(signals, "_clock", lambda: NOW)
    signals.reset()
    yield fake
    signals.reset()


def at(when: float):
    """The clock signals reads, set to ``when``."""
    return lambda: when


# ── bump ──────────────────────────────────────────────────────────────────────────────────────────
def test_bump_counts_in_memory_and_touches_nothing_else(monkeypatch):
    """No Redis (one that raises if asked), no event loop (this test runs none), no IO: a dict."""
    def touched():
        raise AssertionError("bump touched Redis")

    monkeypatch.setattr(signals, "_redis", touched)
    monkeypatch.setattr(signals, "_clock", lambda: NOW)
    signals.reset()
    assert not inspect.iscoroutinefunction(signals.bump)
    for _ in range(3):
        signals.bump("builds.dropped", graph_id="g1")
    signals.bump("drafts.idle_closed", n=4)
    signals.bump("drafts.changes_removed", graph_id="g1", n=0)   # nothing removed: no counter
    hour = int(NOW // HOUR)
    assert signals._pending == {("builds.dropped", "g1", hour): 3,
                                ("drafts.idle_closed", None, hour): 4}
    signals.reset()


def test_an_unknown_id_is_refused_in_tests_and_dropped_elsewhere(monkeypatch):
    signals.reset()
    with pytest.raises(AssertionError, match="builds.droped"):
        signals.bump("builds.droped")
    monkeypatch.setattr(signals, "STRICT", False)
    signals.bump("builds.droped")
    assert signals._pending == {}


def test_a_count_belongs_to_the_hour_it_was_made_in(redis, monkeypatch):
    top = NOW - NOW % HOUR + HOUR                     # 14:00
    monkeypatch.setattr(signals, "_clock", at(top - 1))
    signals.bump("reads.asked_to_retry", graph_id="g1")
    monkeypatch.setattr(signals, "_clock", at(top + 1))
    signals.bump("reads.asked_to_retry", graph_id="g1")
    asyncio.run(signals.flush())
    assert redis.hashes["sig:reads.asked_to_retry:2026111613"] == {"n": 1}
    assert redis.hashes["sig:reads.asked_to_retry:2026111614"] == {"n": 1}


# ── flush ─────────────────────────────────────────────────────────────────────────────────────────
def test_a_flush_is_one_transaction_of_hincrby_into_the_hours_buckets(redis):
    signals.bump("builds.dropped", graph_id="g1")
    signals.bump("builds.dropped", graph_id="g1", n=2)
    signals.bump("builds.dropped", graph_id="g2")
    signals.bump("drafts.idle_closed", n=4)
    assert asyncio.run(signals.flush()) == 3
    [(transaction, commands)] = redis.executed
    assert transaction is True
    assert sorted(c for c in commands if c[0] == "hincrby") == [
        ("hincrby", "sig:builds.dropped:2026111613", "n", 4),
        ("hincrby", "sig:builds.dropped:g:2026111613", "g1", 3),
        ("hincrby", "sig:builds.dropped:g:2026111613", "g2", 1),
        ("hincrby", "sig:drafts.idle_closed:2026111613", "n", 4)]
    assert redis.ttl == dict.fromkeys(("sig:builds.dropped:2026111613",
                                       "sig:builds.dropped:g:2026111613",
                                       "sig:drafts.idle_closed:2026111613"), 8 * 24 * HOUR)
    assert signals._pending == {}
    assert asyncio.run(signals.flush()) == 0           # nothing new: Redis isn't asked
    assert len(redis.executed) == 1


def test_a_refused_flush_keeps_its_counts_for_the_next_and_logs_once(redis, caplog):
    redis.down = True
    signals.bump("builds.copy_timed_out", graph_id="g1")
    with caplog.at_level(logging.WARNING, logger=signals.__name__):
        assert asyncio.run(signals.flush()) == 0
        signals.bump("builds.copy_timed_out", graph_id="g1")
        assert asyncio.run(signals.flush()) == 0
    assert len([r for r in caplog.records if "could not be written" in r.message]) == 1
    redis.down = False
    assert asyncio.run(signals.flush()) == 1
    assert redis.hashes["sig:builds.copy_timed_out:g:2026111613"] == {"g1": 2}
    assert redis.hashes["sig:builds.copy_timed_out:2026111613"] == {"n": 2}


def test_past_the_cap_the_oldest_counts_go_logged_once(redis, monkeypatch, caplog):
    monkeypatch.setattr(signals, "MAX_PENDING", 10)
    redis.down = True
    with caplog.at_level(logging.WARNING, logger=signals.__name__):
        for i in range(15):
            signals.bump("reads.asked_to_retry", graph_id=f"g{i:02d}")
        # Counted while a refused flush was out: kept after the flush's own, older ones.
        late = [f"late{i}" for i in range(5)]

        async def refuse_after_more():
            for gid in late:
                signals.bump("reads.asked_to_retry", graph_id=gid)
            raise ConnectionError("Redis is out of reach")

        monkeypatch.setattr(signals, "_write", lambda batch: refuse_after_more())
        asyncio.run(signals.flush())
    kept = [gid for _sid, gid, _h in signals._pending]
    assert len(kept) == 10
    assert kept == [f"g{i:02d}" for i in range(10, 15)] + late
    assert len([r for r in caplog.records if "oldest are dropped" in r.message]) == 1


def test_the_flusher_flushes_on_its_interval_and_once_more_when_it_stops(redis):
    async def go():
        signals.bump("drafts.changes_removed", graph_id="g1")
        stop = asyncio.Event()
        task = asyncio.create_task(signals.run_flusher(stop, interval=0.01))
        for _ in range(100):
            if redis.executed:
                break
            await asyncio.sleep(0.01)
        assert len(redis.executed) == 1
        signals.bump("drafts.changes_removed", graph_id="g1")
        stop.set()
        await task
        assert redis.hashes["sig:drafts.changes_removed:2026111613"] == {"n": 2}

        signals.start_flusher()
        signals.start_flusher()                          # once is enough
        signals.bump("drafts.idle_closed", graph_id="g2")
        await signals.stop_flusher()
        assert redis.hashes["sig:drafts.idle_closed:g:2026111613"] == {"g2": 1}
        await signals.stop_flusher()                     # stopped already: nothing to do

    asyncio.run(go())


# ── read ──────────────────────────────────────────────────────────────────────────────────────────
def _hour_key(signal_id: str, hours_ago: int, *, graph: bool = False) -> str:
    when = datetime.fromtimestamp(NOW - hours_ago * HOUR, timezone.utc).strftime("%Y%m%d%H")
    return f"sig:{signal_id}:g:{when}" if graph else f"sig:{signal_id}:{when}"


def test_a_window_counts_its_hours_oldest_first_and_every_id_is_there(redis):
    redis.hashes.update({
        _hour_key("builds.dropped", 0): {"n": 2},
        _hour_key("builds.dropped", 5): {"n": 3},
        _hour_key("builds.dropped", 23): {"n": 1},
        _hour_key("builds.dropped", 24): {"n": 50},     # 25 hours ago: outside 24h
        _hour_key("builds.dropped", 167): {"n": 7},     # the oldest hour of 7d
        _hour_key("builds.dropped", 0, graph=True): {"g1": 2},
        _hour_key("builds.dropped", 5, graph=True): {"g1": 1, "g2": 2},
    })
    day = asyncio.run(signals.read("24h"))
    assert list(day) == list(signals.IDS)
    dropped = day["builds.dropped"]
    assert len(dropped["byHour"]) == 24 and dropped["count"] == sum(dropped["byHour"]) == 6
    assert dropped["byHour"][-1] == 2 and dropped["byHour"][-6] == 3 and dropped["byHour"][0] == 1
    assert all(v == {"count": 0, "byHour": [0] * 24} for k, v in day.items()
               if k != "builds.dropped")
    assert asyncio.run(signals.read("1h"))["builds.dropped"] == {"count": 2, "byHour": [2]}
    week = asyncio.run(signals.read("7d"))["builds.dropped"]
    assert (len(week["byHour"]), week["count"], week["byHour"][0]) == (168, 63, 7)
    mine = asyncio.run(signals.read("24h", graph_id="g1"))["builds.dropped"]
    assert mine["count"] == 3 and mine["byHour"][-1] == 2 and mine["byHour"][-6] == 1
    assert asyncio.run(signals.read("24h", graph_id="g9"))["builds.dropped"]["count"] == 0


def test_the_graphs_a_signal_named_most_come_first(redis):
    redis.hashes.update({
        _hour_key("reads.asked_to_retry", 0, graph=True): {"g1": 2, "g2": 9, "g3": 1},
        _hour_key("reads.asked_to_retry", 30, graph=True): {"g1": 8, "g4": 4},
    })
    assert asyncio.run(signals.top_graphs("24h"))["reads.asked_to_retry"] == [
        ("g2", 9), ("g1", 2), ("g3", 1)]
    week = asyncio.run(signals.top_graphs("7d", limit=2))
    assert week["reads.asked_to_retry"] == [("g1", 10), ("g2", 9)]
    assert week["builds.dropped"] == []


def test_a_read_redis_refuses_raises_rather_than_answer_zeros(redis):
    redis.down = True
    with pytest.raises(ConnectionError):
        asyncio.run(signals.read("24h"))
    with pytest.raises(ConnectionError):
        asyncio.run(signals.top_graphs("24h"))


# ── The ids ───────────────────────────────────────────────────────────────────────────────────────
def test_the_ids_are_fixed_and_the_registrys():
    assert len(signals.IDS) == len(set(signals.IDS)) == 11
    described = getattr(registry(), "SIGNALS", None)
    if described is None:
        pytest.skip("the registry's SIGNALS are not in this tree yet")
    assert sorted(s.id for s in described) == sorted(signals.IDS)
