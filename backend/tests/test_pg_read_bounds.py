"""Reads of a versioned graph from Postgres are bounded, so one large graph's can't take the pool.

While FalkorDB holds no version of a graph, its main is read from Postgres, and those reads cost
the whole graph. Each holds a place among the process's and the graph's reads from Postgres
(``ProviderManager.pg_read_slot``, sized by New-version builds' live settings), and each statement
is cut off past its limit (``db.bounded_read_sessions``) — answered as ``GraphReadBusy`` (503,
retryable) or ``ProviderBusy`` (429) rather than holding a connection every other read needs.
The statement limit needs Postgres (``GRAPHVER_E2E=1``).
"""
from __future__ import annotations

import asyncio
import os

import pytest

from backend.app.providers import manager as manager_mod
from backend.app.providers.manager import ProviderManager
from backend.app.services.versioning import build_policy, db
from backend.app.services.versioning.errors import GraphReadBusy
from backend.common.adapters.circuit import ProviderBusy

e2e = pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres")


@pytest.fixture(autouse=True)
def _short_wait(monkeypatch):
    monkeypatch.setattr(manager_mod, "_SEMAPHORE_ACQUIRE_BUDGET_S", 0.05)


async def _hold(manager, graph_id, gate, *, per_process=8, per_graph=2):
    async with manager.pg_read_slot(graph_id, per_process=per_process, per_graph=per_graph):
        await gate.wait()


async def test_one_graph_reads_at_most_its_share_at_once_and_the_next_is_shed():
    manager, gate = ProviderManager(), asyncio.Event()
    held = [asyncio.create_task(_hold(manager, "g1", gate)) for _ in range(2)]
    await asyncio.sleep(0.01)
    with pytest.raises(ProviderBusy):
        await _hold(manager, "g1", gate)
    other = asyncio.create_task(_hold(manager, "g2", gate))      # another graph still reads
    await asyncio.sleep(0.01)
    assert not other.done()
    gate.set()
    await asyncio.gather(*held, other)
    gate.clear()
    once_more = asyncio.create_task(_hold(manager, "g1", gate))   # places come back
    await asyncio.sleep(0.01)
    gate.set()
    await once_more


async def test_the_process_reads_at_most_its_share_across_graphs():
    manager, gate = ProviderManager(), asyncio.Event()
    held = [asyncio.create_task(_hold(manager, f"g{i}", gate, per_process=3)) for i in range(3)]
    await asyncio.sleep(0.01)
    with pytest.raises(ProviderBusy):
        await _hold(manager, "g9", gate, per_process=3)
    gate.set()
    await asyncio.gather(*held)


async def test_a_size_changed_live_applies_to_the_next_read():
    manager, gate = ProviderManager(), asyncio.Event()
    held = asyncio.create_task(_hold(manager, "g1", gate, per_graph=1))
    await asyncio.sleep(0.01)
    with pytest.raises(ProviderBusy):
        await _hold(manager, "g1", gate, per_graph=1)
    second = asyncio.create_task(_hold(manager, "g1", gate, per_graph=2))
    await asyncio.sleep(0.01)
    assert not second.done(), "the larger share admits another"
    gate.set()
    await asyncio.gather(held, second)


class _Slots:
    """Counts the places a bounded factory takes."""

    def __init__(self):
        self.taken = []

    def __call__(self, graph_id, *, per_process, per_graph):
        slots = self

        class _Place:
            async def __aenter__(self):
                slots.taken.append((graph_id, per_process, per_graph))

            async def __aexit__(self, *exc):
                return False
        return _Place()


def _policy(monkeypatch, **values):
    policy = build_policy.BuildPolicy({**build_policy.defaults().values, **values})

    async def resolve(session=None):
        return policy
    monkeypatch.setattr(build_policy, "resolve", resolve)


@e2e
async def test_a_statement_past_its_limit_is_a_retryable_busy_answer(monkeypatch):
    from sqlalchemy import text

    _policy(monkeypatch, pgStatementTimeoutMs=1000, pgReadsPerGraph=3, pgReadsPerProcess=5)
    slots = _Slots()
    factory = db.bounded_read_sessions("g_bounded", slot=slots)
    try:
        with pytest.raises(GraphReadBusy) as exc:
            async with factory() as s:
                await s.execute(text("SELECT pg_sleep(3)"))
        assert exc.value.status_code == 503 and exc.value.detail["retryable"] is True
        assert slots.taken == [("g_bounded", 5, 3)], "sized by the live settings"
        # A session opened inside another, for the same graph, takes no second place.
        async with factory() as s1:
            async with factory() as s2:
                assert (await s2.execute(text("SELECT 1"))).scalar() == 1
            assert (await s1.execute(text("SELECT 1"))).scalar() == 1
        assert len(slots.taken) == 2
    finally:
        await db.dispose_engine()
