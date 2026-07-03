"""Provider-aware projection routing — needs Postgres (fake FalkorDB handles).

The projector's graph factory contract is ``(name, provider_id=None)``; a graph pinned to
a provider must project into THAT provider's handle (the same instance the per-provider
read path and aggregation worker use), an unpinned/None provider falls back to the
default handle, an awaitable factory result is awaited (the registry factory resolves
provider rows asynchronously), and eviction drops the graph on its pinned provider.
"""
import asyncio
import os
from types import SimpleNamespace

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.projection import FalkorProjector
from backend.app.services.versioning.service import GraphVersioningService


class Recorder:
    """Per-provider fake FalkorDB: records which (provider, graph name) got writes/drops."""

    def __init__(self):
        self.queries: list = []       # (provider_id, name)
        self.drops: list = []         # (provider_id, name)

    def factory(self, *, awaitable: bool):
        async def _make(name, provider_id=None):
            async def _query(cypher, params=None):
                self.queries.append((provider_id, name))
                return None

            async def _delete():
                self.drops.append((provider_id, name))
            return SimpleNamespace(query=_query, delete=_delete)

        if awaitable:
            return _make                              # factory returns an awaitable

        def _sync(name, provider_id=None):
            # same recording handle, resolved synchronously
            loop = asyncio.get_event_loop()
            return loop.run_until_complete(_make(name, provider_id)) \
                if not loop.is_running() else _SyncHandle(self, name, provider_id)
        return _sync


class _SyncHandle:
    def __init__(self, rec, name, provider_id):
        self._rec, self._name, self._pid = rec, name, provider_id

    async def query(self, cypher, params=None):
        self._rec.queries.append((self._pid, self._name))
        return None

    async def delete(self):
        self._rec.drops.append((self._pid, self._name))


async def _seed(svc, *, provider, name):
    gid = (await svc.create_graph(
        data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="u",
        falkor_graph_name=name, falkor_provider=provider))["graph_id"]
    await svc.apply_ops(graph_id=gid, actor="u", message="seed", ops=[
        {"op": "create", "entity_kind": "node", "entity_id": "A",
         "payload": {"urn": "A", "entityType": "Dataset", "displayName": "A"}}])
    return gid


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    rec = Recorder()

    # ── awaitable factory: pinned provider routes writes to that provider's handle ──
    proj = FalkorProjector(rec.factory(awaitable=True))
    name_b = "gvt_route_" + os.urandom(3).hex()
    gid_b = await _seed(svc, provider="prov_B", name=name_b)
    r = await proj.project_graph(gid_b)
    assert r["noop"] is False, r
    assert {p for p, _n in rec.queries} == {"prov_B"}, rec.queries
    assert all(n == name_b for _p, n in rec.queries)

    # ── None provider falls back to the default handle (provider_id=None) ──
    rec.queries.clear()
    name_d = "gvt_route_" + os.urandom(3).hex()
    gid_d = await _seed(svc, provider=None, name=name_d)
    await proj.project_graph(gid_d)
    assert {p for p, _n in rec.queries} == {None}, rec.queries

    # ── sync factory (env-instance shape) still works through the same call sites ──
    rec.queries.clear()
    proj_sync = FalkorProjector(rec.factory(awaitable=False))
    name_s = "gvt_route_" + os.urandom(3).hex()
    gid_s = await _seed(svc, provider="prov_S", name=name_s)
    await proj_sync.project_graph(gid_s)
    assert {p for p, _n in rec.queries} == {"prov_S"}, rec.queries

    # ── drop routes to the pinned provider (the eviction path's contract) ──
    await proj.drop_graph(name_b, "prov_B")
    assert rec.drops[-1] == ("prov_B", name_b), rec.drops

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_projection_provider_routing_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("provider-aware projection routing (pinned/default/sync-factory/drop) e2e: OK")
