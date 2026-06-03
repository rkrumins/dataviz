"""LIVE FalkorDB validation of per-provider cache EVICTION (P4) — needs Postgres,
Redis, and a real FalkorDB.

``test_versioning_eviction.py`` / ``test_versioning_evict_loop.py`` mock the FalkorDB
drop (a no-op client + a recording stub); they prove the Postgres watermark logic.
This proves the part that can only be tested for real: the daemon's ``GRAPH.DELETE``
actually empties the FalkorDB graph, the within-budget graph survives, and
``ensure_rebuilt()`` repopulates the real graph from the durable Postgres log — with
the budget sourced from a real provider row via ``make_registry_budget_resolver()``.

Run:  docker run -d -p 6379:6379 falkordb/falkordb          # or:  ./dev.sh infra
      GRAPHVER_E2E=1 FALKORDB_HOST=localhost FALKORDB_PORT=6379 \
      MANAGEMENT_DB_URL=postgresql+asyncpg://... \
      pytest backend/tests/integration/test_versioning_evict_live.py -v -m integration
"""
import asyncio
import os

import pytest

from backend.app.db.engine import PoolRole, get_engine, get_session_factory
from backend.app.db.models import Base as MgmtBase, ProviderORM
from backend.app.db.repositories import provider_repo
from backend.app.providers.eviction_budget import make_registry_budget_resolver
from backend.app.services.versioning import db, models
from backend.app.services.versioning.cache_manager import CacheManager
from backend.app.services.versioning.messaging import close_broker_redis
from backend.app.services.versioning.models import ProjectionStateORM
from backend.app.services.versioning.projection import FalkorProjector, make_falkor_graph_factory
from backend.app.services.versioning.service import GraphVersioningService
from backend.app.services.versioning.worker import ProjectionWorker
from backend.common.models.management import ProviderCreateRequest, ProviderType


def _falkordb_available() -> bool:
    try:
        import redis
        c = redis.Redis(host=os.getenv("FALKORDB_HOST", "localhost"),
                        port=int(os.getenv("FALKORDB_PORT", "6379")), socket_connect_timeout=2)
        return c.ping() is True
    except Exception:
        return False


async def _count(factory, name: str) -> int:
    res = await factory(name).query("MATCH (n) RETURN count(n)")
    rows = res.result_set or []
    return int(rows[0][0]) if rows else 0


async def _ps(gid: str):
    async with db.graphver_session() as s:
        ps = await s.get(ProjectionStateORM, gid)
        return ps.status, ps.projected_commit_seq, ps.target_commit_seq


async def _seed(svc, proj, provider: str, name: str) -> str:
    gid = (await svc.create_graph(
        data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="a",
        falkor_graph_name=name, falkor_provider=provider,
    ))["graph_id"]
    d = await svc.open_draft(graph_id=gid, owner="a")
    await svc.stage_changes(graph_id=gid, branch_id=d, actor="a", ops=[
        {"op": "create", "entity_kind": "node", "entity_id": "A",
         "payload": {"urn": f"urn:{name}:A", "displayName": "A", "entityType": "Dataset"}},
    ])
    await svc.checkpoint(graph_id=gid, branch_id=d, actor="a")
    await svc.publish(graph_id=gid, branch_id=d, actor="a", message="seed")
    await proj.project_graph(gid)                       # resident in the REAL FalkorDB
    return gid


async def _run() -> None:
    await models.create_schema_and_partitions()
    # the providers table lives in the management DB (same Postgres via MANAGEMENT_DB_URL)
    eng = get_engine(PoolRole.WEB)
    async with eng.begin() as c:
        await c.run_sync(MgmtBase.metadata.create_all, tables=[ProviderORM.__table__])
    # a real provider row whose registry budget is 1 resident graph
    async with get_session_factory(PoolRole.WEB)() as s:
        prov = await provider_repo.create_provider(s, ProviderCreateRequest(
            name="e2e-evict", provider_type=ProviderType.FALKORDB, falkor_max_resident=1))
        await s.commit()
    pid = prov.id

    svc = GraphVersioningService()
    factory = make_falkor_graph_factory()
    proj = FalkorProjector(graph_client_factory=factory)
    tag = f"{os.getpid()}_{os.urandom(3).hex()}"
    n1, n2 = f"gv_evict_{tag}_1", f"gv_evict_{tag}_2"
    g1 = g2 = None

    try:
        # two graphs on the same provider; g1 projected first → coldest by last_projected_at
        g1 = await _seed(svc, proj, pid, n1)
        await asyncio.sleep(0.05)
        g2 = await _seed(svc, proj, pid, n2)
        assert await _count(factory, n1) == 1 and await _count(factory, n2) == 1   # both resident

        # ── registry budget (1) drives the daemon: drop the coldest, for real ──
        worker = ProjectionWorker(proj, evict_budget=make_registry_budget_resolver(),
                                  consumer_name="evict-live")
        # evict_once enforces EVERY resident provider's budget, so scope to ours:
        # our coldest is dropped, our within-budget one is kept.
        evicted = await worker.evict_once()
        assert g1 in evicted and g2 not in evicted, evicted
        assert await _count(factory, n1) == 0            # REAL GRAPH.DELETE freed the graph
        assert await _count(factory, n2) == 1            # within-budget graph untouched
        assert (await _ps(g1))[:2] == ("evicted", 0)     # marked for rebuild, watermark reset
        assert (await _ps(g2))[0] == "idle"

        # ── rebuild repopulates the REAL graph from the durable Postgres log ──
        assert await CacheManager(proj).ensure_rebuilt(g1) is True
        assert await _count(factory, n1) == 1            # back, rebuilt from commits
        status, projected, target = await _ps(g1)
        assert status == "idle" and projected == target  # re-converged to head
    finally:
        for n in (n1, n2):
            try:
                await factory(n).delete()               # free the real FalkorDB graphs
            except Exception:
                pass
        # drop our own rows so reruns and peer tests see a clean resident set
        try:
            async with db.graphver_session() as s:
                for gid in (g1, g2):
                    ps = await s.get(ProjectionStateORM, gid) if gid else None
                    if ps is not None:
                        await s.delete(ps)
        except Exception:
            pass
        try:
            async with get_session_factory(PoolRole.WEB)() as s:
                p = await s.get(ProviderORM, pid)
                if p is not None:
                    await s.delete(p)
                    await s.commit()
        except Exception:
            pass
        await close_broker_redis()
        await db.dispose_engine()


@pytest.mark.integration
@pytest.mark.skipif(
    not (os.getenv("GRAPHVER_E2E") and _falkordb_available()),
    reason="set GRAPHVER_E2E=1 + live Postgres + Redis + a real FalkorDB (FALKORDB_HOST/PORT) to run",
)
def test_versioning_evict_live():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning LIVE FalkorDB per-provider eviction + rebuild: OK")
