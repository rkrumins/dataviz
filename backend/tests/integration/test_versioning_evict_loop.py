"""Per-provider eviction daemon loop (P4) — needs Postgres + Redis.

RAM is a property of a FalkorDB instance, so the worker's evict_once() applies
each provider's OWN budget to its OWN resident set: it evicts the coldest graphs
on an over-budget provider while leaving a within-budget provider untouched, skips
pinned graphs (evicting deeper to meet the budget), and is a no-op when no budget
resolver is injected. FalkorDB is mocked (no-op query + a recording delete); we
assert the state transitions + drops, which are the cache logic.
"""
import asyncio
import os
from types import SimpleNamespace

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.cache_manager import CacheManager
from backend.app.services.versioning.messaging import close_broker_redis
from backend.app.services.versioning.models import ProjectionStateORM
from backend.app.services.versioning.projection import FalkorProjector
from backend.app.services.versioning.service import GraphVersioningService
from backend.app.services.versioning.worker import ProjectionWorker


async def _noop(cypher, params=None):
    return None


def _factory(dropped: list):
    def make(name, provider_id=None):
        async def _delete():
            dropped.append(name)
        return SimpleNamespace(query=_noop, delete=_delete)
    return make


async def _seed_resident(svc, proj, provider: str) -> str:
    gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(),
                                  workspace_id="ws1", actor="a",
                                  falkor_provider=provider,
                                  falkor_graph_name="gvt_" + os.urandom(3).hex()))["graph_id"]
    d = await svc.open_draft(graph_id=gid, owner="a")
    await svc.stage_changes(graph_id=gid, branch_id=d, actor="a", ops=[
        {"op": "create", "entity_kind": "node", "entity_id": "A",
         "payload": {"displayName": "A", "entityType": "Dataset"}},
    ])
    await svc.checkpoint(graph_id=gid, branch_id=d, actor="a")
    await svc.publish(graph_id=gid, branch_id=d, actor="a", message="seed")
    await proj.project_graph(gid)                       # resident (status idle)
    return gid


async def _status(gid) -> str:
    async with db.graphver_session() as s:
        return (await s.get(ProjectionStateORM, gid)).status


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    dropped: list = []
    proj = FalkorProjector(graph_client_factory=_factory(dropped))

    # per-provider budgets: provA tight (1), provB loose (2). Unique provider names per run:
    # residents accumulate in the shared dev DB, so fixed names would count graphs from
    # earlier runs against this run's budget.
    provA, provB = "provA_" + os.urandom(3).hex(), "provB_" + os.urandom(3).hex()
    budget = lambda p: {provA: 1, provB: 2}.get(p, 0)

    # provA: three resident, projected oldest→newest (g0 coldest)
    g0 = await _seed_resident(svc, proj, provA); await asyncio.sleep(0.02)
    g1 = await _seed_resident(svc, proj, provA); await asyncio.sleep(0.02)
    g2 = await _seed_resident(svc, proj, provA)
    # provB: two resident — within its own budget
    h0 = await _seed_resident(svc, proj, provB); await asyncio.sleep(0.02)
    h1 = await _seed_resident(svc, proj, provB)

    # ── each provider against its OWN budget ────────────────────────────────
    worker = ProjectionWorker(proj, evict_budget=budget, consumer_name="evict-test")
    pre_drops = len(dropped)                            # full-seed wipes also call delete(); count only evictions
    evicted = await worker.evict_once()
    assert set(evicted) == {g0, g1}, evicted            # provA's two coldest
    assert await _status(g0) == "evicted" and await _status(g1) == "evicted"
    assert await _status(g2) == "idle"                  # provA's hottest survives
    assert await _status(h0) == "idle" and await _status(h1) == "idle"  # provB untouched
    assert len(dropped) - pre_drops == 2                # only provA's two dropped

    # within budget everywhere now → no-op
    assert await worker.evict_once() == []

    # ── a pinned graph is skipped; eviction goes deeper to meet the budget ──
    g3 = await _seed_resident(svc, proj, provA)         # provA resident: g2,g3; budget 1 → over by 1
    cm = CacheManager(proj)
    await cm.acquire_lease(g2)                          # pin the colder one
    evicted = await worker.evict_once()
    assert g2 not in evicted and await _status(g2) == "idle"   # pinned survived
    assert evicted == [g3] and await _status(g3) == "evicted"  # the unpinned one went
    await cm.release_lease(g2)

    # ── no resolver ⇒ daemon disabled ───────────────────────────────────────
    assert ProjectionWorker(proj, evict_budget=None)._cache is None
    assert await ProjectionWorker(proj, evict_budget=None).evict_once() == []

    await close_broker_redis()
    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + live Postgres + Redis to run")
def test_versioning_evict_loop_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning per-provider eviction-loop e2e: OK")
