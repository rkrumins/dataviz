"""Evictable/rebuildable FalkorDB cache (P4) — needs Postgres + Redis.

The riskiest scale bet (FalkorDB as a volatile cache), proven directly: a pinned
graph is never evicted; eviction marks the graph for rebuild and drops its
FalkorDB graph; a single-flight lock means concurrent rebuild attempts rebuild
exactly once; and LRU orders coldest-first. FalkorDB content is mocked (no-op
client) — we assert the watermark/state transitions, which are the cache logic.
"""
import asyncio
import os

import pytest
from types import SimpleNamespace

from backend.app.services.versioning import db, models
from backend.app.services.versioning.cache_manager import CacheManager
from backend.app.services.versioning.messaging import close_broker_redis, get_broker_redis
from backend.app.services.versioning.models import ProjectionStateORM
from backend.app.services.versioning.projection import FalkorProjector
from backend.app.services.versioning.service import GraphVersioningService


async def _noop(cypher, params=None):
    return None


async def _seed(svc) -> str:
    gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="a",
                                   falkor_graph_name="gvt_" + os.urandom(3).hex()))["graph_id"]
    d = await svc.open_draft(graph_id=gid, owner="a")
    await svc.stage_changes(graph_id=gid, branch_id=d, actor="a", ops=[
        {"op": "create", "entity_kind": "node", "entity_id": "A", "payload": {"displayName": "A", "entityType": "Dataset"}},
    ])
    await svc.checkpoint(graph_id=gid, branch_id=d, actor="a")
    await svc.publish(graph_id=gid, branch_id=d, actor="a", message="seed")
    return gid


async def _ps(gid):
    async with db.graphver_session() as s:
        ps = await s.get(ProjectionStateORM, gid)
        return ps.status, ps.projected_commit_seq, ps.target_commit_seq


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    proj = FalkorProjector(graph_client_factory=lambda name: SimpleNamespace(query=_noop))
    cm = CacheManager(proj)
    dropped: list = []

    async def drop_graph(name):
        dropped.append(name)

    gid = await _seed(svc)
    await proj.project_graph(gid)                       # resident
    assert await _ps(gid) == ("idle", 2, 2)

    # ── pinned graph is NOT evicted ──────────────────────────────────────
    await cm.acquire_lease(gid)
    assert await cm.is_pinned(gid) is True
    assert await cm.evict(gid, drop_graph=drop_graph) is False
    assert await _ps(gid) == ("idle", 2, 2) and dropped == []

    # ── unpinned graph evicts: marked for rebuild + FalkorDB graph dropped ─
    await cm.release_lease(gid)
    assert await cm.is_pinned(gid) is False
    assert await cm.evict(gid, drop_graph=drop_graph) is True
    status, projected, target = await _ps(gid)
    assert status == "evicted" and projected == 0 and target == 2
    assert len(dropped) == 1                            # the FalkorDB graph was dropped

    # ── single-flight rebuild: concurrent attempts rebuild exactly once ──
    results = await asyncio.gather(cm.ensure_rebuilt(gid), cm.ensure_rebuilt(gid))
    assert sum(1 for r in results if r) == 1, results   # exactly one caller rebuilt
    assert await _ps(gid) == ("idle", 2, 2)             # rebuilt from Postgres to head
    # idempotent: nothing to rebuild now
    assert await cm.ensure_rebuilt(gid) is False
    # lock released
    assert await get_broker_redis().get(f"versioning:rebuild:{gid}") is None

    # ── LRU orders coldest-first ─────────────────────────────────────────
    g1 = await _seed(svc)
    await proj.project_graph(g1)
    await asyncio.sleep(0.02)
    g2 = await _seed(svc)
    await proj.project_graph(g2)
    lru = await cm.lru_candidates(limit=10_000)
    assert lru.index(g1) < lru.index(g2)                # g1 projected earlier → colder → first

    await close_broker_redis()
    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + live Postgres + Redis to run")
def test_versioning_eviction_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning evictable/rebuildable cache e2e: OK")
