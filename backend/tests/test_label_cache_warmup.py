"""THE URN->LABEL CACHE ONLY EVER FILLED FROM THE WRITE SIDE.

`_get_cached_label` is a Redis HGET. Every caller that misses falls back to a
bare `(p)` anchor, and on a graph with no label-less URN index that is an
All-Node-Scan — the shape this provider's own comments price at 5-11 seconds
for a children read.

`_warmup_urn_label_cache_for_aggregation` exists to fill the hash with one
index-assisted scan per label. It had exactly one occurrence in the
repository: its own definition. Nothing called it. So on a store that is read
far more than it is written, the cache stayed empty and every children read
took the scan.

These pin the wiring and its bounds. The warmup runs OFF the request path on
purpose: the read that discovers the miss is already taking the slow path,
and making it wait for the warmup too would charge the first reader twice.
"""
import asyncio
import time

import pytest

from backend.app.providers import falkordb_provider as fp


class _Provider:
    """The two methods under test, on a bare object."""

    def __init__(self, label=None):
        self._graph_name = "g"
        self._label = label
        self.warmups = 0

        class _Redis:
            def __init__(self, label):
                self._label = label

            async def hget(self, _key, _urn):
                return self._label

        self._redis = _Redis(label)

    def _urn_label_key(self):
        return "g:urn_labels"

    async def _warmup_urn_label_cache_for_aggregation(self):
        self.warmups += 1

    _get_cached_label = fp.FalkorDBProvider._get_cached_label
    _schedule_label_warmup = fp.FalkorDBProvider._schedule_label_warmup


async def _drain():
    for _ in range(4):
        await asyncio.sleep(0)


def test_a_label_miss_schedules_the_warmup():
    """The whole point: a miss is what tells us the cache is cold, and it was
    the one signal nobody acted on."""
    async def go():
        p = _Provider(label=None)
        assert await p._get_cached_label("urn:a") is None
        await _drain()
        return p.warmups

    assert asyncio.run(go()) == 1


def test_a_label_hit_does_not():
    async def go():
        p = _Provider(label="dataset")
        assert await p._get_cached_label("urn:a") == "dataset"
        await _drain()
        return p.warmups

    assert asyncio.run(go()) == 0


def test_a_burst_of_misses_schedules_one_warmup():
    """A cold canvas open misses for every parent it touches. Scheduling one
    warmup per miss would turn a cold cache into a scan storm — the cooldown
    is set BEFORE the task is created so the whole burst coalesces."""
    async def go():
        p = _Provider(label=None)
        await asyncio.gather(*(p._get_cached_label(f"urn:{i}") for i in range(50)))
        await _drain()
        return p.warmups

    assert asyncio.run(go()) == 1


def test_the_warmup_does_not_run_again_inside_the_cooldown():
    """A graph whose URNs are genuinely label-less misses forever. Without a
    cooldown it would re-scan every label on every read, which is worse than
    the scan the warmup exists to prevent."""
    async def go():
        p = _Provider(label=None)
        await p._get_cached_label("urn:a")
        await _drain()
        await p._get_cached_label("urn:b")
        await _drain()
        return p.warmups

    assert asyncio.run(go()) == 1


def test_the_cooldown_expires():
    async def go():
        p = _Provider(label=None)
        await p._get_cached_label("urn:a")
        await _drain()
        p._label_warmup_until = time.monotonic() - 1     # pretend it lapsed
        await p._get_cached_label("urn:b")
        await _drain()
        return p.warmups

    assert asyncio.run(go()) == 2


def test_a_failing_warmup_never_reaches_the_read():
    """The read that triggered it is already answering from the slow path.
    A warmup that raises must not turn that into an error."""
    async def go():
        p = _Provider(label=None)

        async def _boom():
            p.warmups += 1
            raise RuntimeError("db.labels unavailable")

        p._warmup_urn_label_cache_for_aggregation = _boom
        assert await p._get_cached_label("urn:a") is None
        await _drain()
        return p.warmups

    assert asyncio.run(go()) == 1


def test_the_cooldown_is_configurable_and_sane():
    assert fp._LABEL_WARMUP_COOLDOWN_S > 0
    # Long enough to not re-scan per read, short enough to pick up new labels
    # without a restart.
    assert 60 <= fp._LABEL_WARMUP_COOLDOWN_S <= 86_400
