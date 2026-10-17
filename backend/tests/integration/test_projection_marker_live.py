"""LIVE: the projector's ``_GVProjMeta`` marker and its replica WAIT on a real FalkorDB.

* A publishing pass leaves ``_GVProjMeta {seq, epoch}`` with the published seq and the pass's
  epoch, and the verify's count does not see it (it is a derived label).
* With ``GRAPHVER_PROJECTION_WAIT_REPLICAS=1`` against an instance with no replica, WAIT answers 0:
  the watermark is held as ``replica_unconfirmed`` and backs off. With 0 the pass publishes.

Needs ``GRAPHVER_E2E=1``, Postgres and a real FalkorDB (``FALKORDB_HOST``/``FALKORDB_PORT``)
with no replica attached.
"""
import asyncio
import os

import pytest

from backend.app.providers.falkordb_connection import graph_clients
from backend.app.services.versioning import config, db, models
from backend.app.services.versioning.models import ProjectionStateORM
from backend.app.services.versioning.projection import FalkorProjector, make_falkor_graph_factory
from backend.app.services.versioning.reconcile import falkor_counts
from backend.app.services.versioning.service import GraphVersioningService

from backend.tests.integration.test_versioning_projection import _edit_publish, _node


def _falkordb_available() -> bool:
    try:
        import redis
        c = redis.Redis(host=os.getenv("FALKORDB_HOST", "localhost"),
                        port=int(os.getenv("FALKORDB_PORT", "6379")), socket_connect_timeout=2)
        return c.ping() is True
    except Exception:
        return False


pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(not (os.getenv("GRAPHVER_E2E") and _falkordb_available()),
                       reason="set GRAPHVER_E2E=1 + live Postgres + a real FalkorDB to run"),
]


def _create(entity_id: str) -> list:
    return [{"op": "create", "entity_kind": "node", "entity_id": entity_id,
             "payload": _node(entity_id)}]


async def _ps(gid: str):
    async with db.graphver_session() as s:
        return await s.get(ProjectionStateORM, gid)


async def _run(monkeypatch) -> None:
    await models.create_schema_and_partitions()
    svc, factory = GraphVersioningService(), make_falkor_graph_factory()
    name = f"gv_marker_{os.getpid()}_{os.urandom(3).hex()}"
    proj = FalkorProjector(graph_client_factory=factory)
    graph = await factory(name)
    try:
        gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(),
                                      workspace_id="ws1", actor="a", falkor_graph_name=name,
                                      owns_falkor_graph=True))["graph_id"]
        await _edit_publish(svc, gid, "a", _create("A") + _create("B"), "seed")

        # (1) a publish leaves the marker, and the verify's count does not see it
        assert (await proj.project_graph(gid))["projected"] == 2   # genesis is 1
        ps = await _ps(gid)
        res = await graph.query("MATCH (m:_GVProjMeta) RETURN m.seq, m.epoch")
        assert res.result_set == [[2, ps.epoch]], res.result_set
        assert await falkor_counts(graph) == (2, 0)

        # (2) WAIT on, no replica to confirm it: held back, backing off
        await _edit_publish(svc, gid, "a", _create("C"), "more")
        monkeypatch.setattr(config, "PROJECTION_WAIT_REPLICAS", 1)
        monkeypatch.setattr(config, "PROJECTION_WAIT_MS", 100)
        r = await proj.project_graph(gid)
        ps = await _ps(gid)
        assert r["projected"] == 2 and ps.projected_commit_seq == 2, r
        assert (ps.last_error or "").startswith("replica_unconfirmed"), ps.last_error
        assert ps.failed_attempts == 1 and ps.next_retry_at, ps.failed_attempts

        monkeypatch.setattr(config, "PROJECTION_WAIT_REPLICAS", 0)
        assert (await proj.project_graph(gid))["projected"] == 3
        ps = await _ps(gid)
        res = await graph.query("MATCH (m:_GVProjMeta) RETURN m.seq, m.epoch")
        assert res.result_set == [[3, ps.epoch]] and ps.last_error is None, res.result_set
    finally:
        try:
            await graph.delete()
        except Exception:
            pass
        await graph_clients().aclose()      # the factory's pools are bound to this loop
        await db.dispose_engine()


def test_the_marker_and_its_wait_on_a_real_falkordb(monkeypatch):
    asyncio.run(_run(monkeypatch))
