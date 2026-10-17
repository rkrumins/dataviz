"""The write-through writes a versioned graph's main to Postgres only — needs Postgres.

* An edge between nodes main already holds writes no node versions: FalkorDB's cache-shaped
  copies of the endpoints are not re-sent over what main committed.
* A node main deleted counts as recorded (the real ``entity_recorded``, on
  ``_current_skeletons``), so an edge onto it is refused as dangling instead of FalkorDB's copy
  bringing the node back.
* Two writers patching one edge each get back the edge as Postgres holds it after their own
  commit; FalkorDB is never written.
* An edge Postgres does not hold is not found, and nothing commits.

The inner provider stands in for FalkorDB and records every write; the projector is the only
FalkorDB writer. Unit coverage: ``tests/test_versioning_single_writer.py``.
"""
import asyncio
import os

import pytest
from sqlalchemy import func, select

from backend.app.providers import versioned_write_provider as vwp
from backend.app.services.versioning import db, models
from backend.app.services.versioning.models import NodeVersionORM
from backend.app.services.versioning.service import ConcurrencyError, GraphVersioningService
from backend.common.models.graph import GraphEdge, GraphNode

pytestmark = pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"),
                                reason="set GRAPHVER_E2E=1 + a live Postgres to run")


class _Falkor:
    """FalkorDB-shaped inner provider: cache-valued node copies; records every write."""

    def __init__(self, *urns):
        self.nodes = {u: GraphNode(urn=u, entityType="Table", displayName=u, description="",
                                   sourceSystem="", lastSyncedAt="", layerAssignment="",
                                   childCount=3) for u in urns}
        self.calls = []

    async def get_node(self, urn):
        return self.nodes.get(urn)

    async def create_node(self, node, containment_edge=None):
        self.calls.append(("create_node", node.urn))
        return True

    async def create_edge(self, edge):
        self.calls.append(("create_edge", edge.id))
        return True

    async def update_edge(self, edge_id, properties):
        self.calls.append(("update_edge", edge_id))
        return None

    async def delete_edge(self, edge_id):
        self.calls.append(("delete_edge", edge_id))
        return True


def _node(eid):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": eid, "entityType": "Table", "displayName": eid}}


@pytest.fixture
def e2e(monkeypatch):
    async def _flag_on():
        return None

    async def _no_nudge(graph_id):
        return None
    monkeypatch.setattr(vwp, "_require_versioning_flag", _flag_on)
    monkeypatch.setattr(vwp, "nudge_projection", _no_nudge, raising=False)

    def run(coro_fn):
        async def go():
            await models.create_schema_and_partitions()
            svc = GraphVersioningService()
            ds = "ds_" + os.urandom(4).hex()
            gid = (await svc.create_graph(data_source_id=ds, workspace_id="ws1",
                                          actor="u"))["graph_id"]
            try:
                await coro_fn(svc, ds, gid)
            finally:
                await db.dispose_engine()
        asyncio.run(go())
    return run


def _vwp(inner, svc, ds):
    return vwp.VersionedWriteProvider(inner, workspace_id="ws1", data_source_id=ds,
                                      actor="u", svc=svc)


async def _node_versions(gid):
    async with db.graphver_session() as s:
        return await s.scalar(select(func.count()).select_from(NodeVersionORM)
                              .where(NodeVersionORM.graph_id == gid))


async def _commits(svc, gid):
    return len(await svc.commit_log(graph_id=gid, limit=100))


def test_an_edge_between_existing_nodes_writes_no_node_versions(e2e):
    async def body(svc, ds, gid):
        await svc.apply_ops(graph_id=gid, actor="u", message="seed", ops=[_node("N"), _node("M")])
        before = await _node_versions(gid)
        inner = _Falkor("N", "M")
        edge = GraphEdge(id="e1", sourceUrn="N", targetUrn="M", edgeType="FLOWS_TO")
        assert await _vwp(inner, svc, ds).create_edge(edge) is True
        assert await _node_versions(gid) == before
        assert (await svc.entity_value(graph_id=gid, entity_id="e1"))["targetEntityId"] == "M"
        assert inner.calls == []
    e2e(body)


def test_a_node_main_deleted_is_not_brought_back(e2e):
    async def body(svc, ds, gid):
        await svc.apply_ops(graph_id=gid, actor="u", message="seed", ops=[_node("X"), _node("N")])
        await svc.apply_ops(graph_id=gid, actor="u", message="drop N",
                            ops=[{"op": "delete", "entity_kind": "node", "entity_id": "N"}])
        inner = _Falkor("X", "N")                         # FalkorDB still serves N
        edge = GraphEdge(id="e1", sourceUrn="X", targetUrn="N", edgeType="FLOWS_TO")
        with pytest.raises(ConcurrencyError, match="dangle"):
            await _vwp(inner, svc, ds).create_edge(edge)
        assert await svc.entity_value(graph_id=gid, entity_id="N") is None
        assert inner.calls == []
        assert await svc.entity_recorded(graph_id=gid, entity_id="N") is True   # deleted, recorded
        assert await svc.entity_recorded(graph_id=gid, entity_id="never") is False
    e2e(body)


def test_two_writers_each_get_the_edge_postgres_committed(e2e):
    async def body(svc, ds, gid):
        await svc.apply_ops(graph_id=gid, actor="u", message="seed", ops=[
            _node("N"), _node("M"),
            {"op": "create", "entity_kind": "edge", "entity_id": "e1",
             "payload": {"sourceEntityId": "N", "targetEntityId": "M", "edgeType": "FLOWS_TO",
                         "properties": {"keep": True}}}])
        inner = _Falkor("N", "M")
        for w, prov in ((1, _vwp(inner, svc, ds)), (2, _vwp(inner, GraphVersioningService(), ds))):
            edge = await prov.update_edge("e1", {"w": w})
            stored = await svc.entity_value(graph_id=gid, entity_id="e1")
            assert edge.properties == stored["properties"] == {"keep": True, "w": w}
            assert (edge.source_urn, edge.target_urn, edge.edge_type) == ("N", "M", "FLOWS_TO")
        assert inner.calls == []
    e2e(body)


def test_an_edge_postgres_does_not_hold_is_not_found(e2e):
    async def body(svc, ds, gid):
        inner, before = _Falkor(), await _commits(svc, gid)
        prov = _vwp(inner, svc, ds)
        assert await prov.update_edge("ghost", {"w": 1}) is None
        assert await prov.delete_edge("ghost") is False
        assert await _commits(svc, gid) == before
        assert inner.calls == []
    e2e(body)
