"""A FalkorDB read waits for a query slot inside its own budget.

``_guarded_timed`` queued for the process's query semaphore with no limit,
and a read's budget started only once it held a permit. Under saturation a
read could wait tens of seconds and then run its full budget, so the request
tier fired first with an unstructured 504 and nothing was served. A read now
spends at most ``_READ_QUEUE_SHARE`` of its budget waiting, is shed as busy
(429 + Retry-After) when that runs out, and the wait comes out of its budget.
Writes keep waiting as before.

No live FalkorDB required — the graph handle is a stub.
"""
import asyncio
import time

import pytest

from backend.app.providers import falkordb_provider as fp
from backend.common.adapters import ProviderBusy
from test_falkordb_slow_query_log import _make_provider


@pytest.fixture(autouse=True)
def _no_streaks():
    fp._deadline_streaks.clear()
    yield
    fp._deadline_streaks.clear()


def _one_slot(p) -> asyncio.Semaphore:
    p._query_semaphore = asyncio.Semaphore(1)
    return p._query_semaphore


async def _hold(sem: asyncio.Semaphore, seconds: float) -> None:
    async with sem:
        await asyncio.sleep(seconds)


async def test_a_read_that_cannot_get_a_slot_in_time_is_shed_not_queued():
    p = _make_provider()
    sem = _one_slot(p)
    holder = asyncio.create_task(_hold(sem, 1.0))
    await asyncio.sleep(0)

    started = time.monotonic()
    with pytest.raises(ProviderBusy):
        await p._ro_query("MATCH (n) RETURN n", timeout=0.2, op="nodes.get")
    assert time.monotonic() - started < 0.5
    holder.cancel()


async def test_the_wait_is_spent_from_the_reads_budget(monkeypatch):
    monkeypatch.setattr(fp, "_TRANSIENT_RETRY_BACKOFFS", ())
    p = _make_provider(delay_s=5)
    sem = _one_slot(p)
    holder = asyncio.create_task(_hold(sem, 0.3))
    await asyncio.sleep(0)

    started = time.monotonic()
    with pytest.raises(TimeoutError):
        await p._ro_query("MATCH (n) RETURN n", timeout=0.8, op="nodes.get")
    # 0.3s in the queue and then the whole 0.8s was 1.1s.
    assert time.monotonic() - started < 0.95
    await holder


async def test_no_slot_leaks_when_a_read_is_shed_or_cancelled():
    p = _make_provider(delay_s=0.2)
    sem = _one_slot(p)
    holder = asyncio.create_task(_hold(sem, 0.3))
    await asyncio.sleep(0)

    with pytest.raises(ProviderBusy):                  # shed while queued
        await p._ro_query("MATCH (n) RETURN n", timeout=0.1)
    queued = asyncio.create_task(p._ro_query("MATCH (n) RETURN n", timeout=5))
    await asyncio.sleep(0.05)
    queued.cancel()                                    # cancelled while queued
    await holder
    running = asyncio.create_task(p._ro_query("MATCH (n) RETURN n", timeout=5))
    await asyncio.sleep(0.05)
    running.cancel()                                   # cancelled holding the slot
    for task in (queued, running):
        with pytest.raises(asyncio.CancelledError):
            await task

    assert sem._value == 1
    assert (await p._ro_query("MATCH (n) RETURN n", timeout=1)).result_set == [[1]]


async def test_a_write_still_waits_for_its_slot():
    p = _make_provider()
    sem = _one_slot(p)
    holder = asyncio.create_task(_hold(sem, 0.3))
    await asyncio.sleep(0)

    await p._query("CREATE (n)", timeout=0.2)
    await holder


async def test_a_deadline_the_queue_shortened_is_not_counted_as_a_wedged_node(monkeypatch):
    """Otherwise saturation would read as a node that answers nothing, and
    three of those in a row report a failover."""
    from backend.app.config import resilience

    monkeypatch.setattr(resilience, "FALKORDB_SLOW_QUERY_MS", 100)
    monkeypatch.setattr(fp, "_TRANSIENT_RETRY_BACKOFFS", ())
    p = _make_provider(delay_s=5)
    sem = _one_slot(p)
    holder = asyncio.create_task(_hold(sem, 0.55))
    await asyncio.sleep(0)

    with pytest.raises(TimeoutError):
        await p._ro_query("MATCH (n) RETURN n", timeout=1.2)
    assert fp._deadline_streaks.get(p._endpoint_label(), 0) == 0
    await holder
