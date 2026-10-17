"""Bulkheads: one kind of slow work gets a fixed share of a process.

Pinned here: no more than the limit run at once, the rest wait their turn;
one that waits too long is refused with a retry hint rather than left to
time out on an empty pool; a slot comes back however its work ends; and work
nested inside a slot never waits on the slot it already holds.
"""
from __future__ import annotations

import asyncio

import pytest

from backend.app.common.bulkhead import Bulkhead, Busy

pytestmark = pytest.mark.asyncio


async def _hold(bulkhead: Bulkhead, release: asyncio.Event) -> None:
    async with bulkhead.slot():
        await release.wait()


async def test_past_the_limit_work_waits_its_turn():
    bulkhead = Bulkhead("tests", 2, wait_seconds=5.0)
    running = peak = done = 0

    async def work():
        nonlocal running, peak, done
        async with bulkhead.slot():
            running += 1
            peak = max(peak, running)
            await asyncio.sleep(0.01)
            running -= 1
            done += 1

    await asyncio.gather(*(work() for _ in range(7)))
    assert (peak, done) == (2, 7)


async def test_work_that_waits_too_long_is_refused_with_a_retry_hint():
    bulkhead = Bulkhead("tests", 1, wait_seconds=0.01, retry_after_seconds=7)
    release = asyncio.Event()
    holder = asyncio.create_task(_hold(bulkhead, release))
    await asyncio.sleep(0)
    assert bulkhead.full

    with pytest.raises(Busy) as refused:
        async with bulkhead.slot():
            raise AssertionError("ran without a slot")
    assert refused.value.retry_after_seconds == 7
    assert "tests" in str(refused.value)

    release.set()
    await holder
    assert not bulkhead.full


async def test_a_slot_comes_back_however_its_work_ends():
    bulkhead = Bulkhead("tests", 1, wait_seconds=0.01)
    with pytest.raises(RuntimeError):
        async with bulkhead.slot():
            raise RuntimeError("boom")

    started = asyncio.Event()

    async def cancelled():
        async with bulkhead.slot():
            started.set()
            await asyncio.sleep(60)

    task = asyncio.create_task(cancelled())
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    async with bulkhead.slot():
        pass
    assert not bulkhead.full


async def test_nested_work_runs_on_the_slot_it_already_holds():
    """A summary's closed days are folded through the same cache that built
    the summary: asking for a second slot would wait on itself."""
    bulkhead = Bulkhead("tests", 1, wait_seconds=0.01)
    async with bulkhead.slot():
        async with bulkhead.slot():
            await asyncio.gather(asyncio.sleep(0), _nested(bulkhead))
    assert not bulkhead.full


async def _nested(bulkhead: Bulkhead) -> None:
    # A task started inside the slot is part of the same work.
    async with bulkhead.slot():
        pass


async def test_a_task_started_elsewhere_does_not_borrow_a_slot():
    bulkhead = Bulkhead("tests", 1, wait_seconds=0.01)
    release = asyncio.Event()
    holder = asyncio.create_task(_hold(bulkhead, release))
    await asyncio.sleep(0)
    with pytest.raises(Busy):
        await asyncio.create_task(_nested(bulkhead))
    release.set()
    await holder
