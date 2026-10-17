"""Placement by versioned graph id reads the key and provider from ``projection_state`` — where the
projector writes — so a fork answers with its own ``__fork_`` key rather than its parent data
source's graph, and only to a caller who may read the graph's workspace. Needs Postgres
(GRAPHVER_E2E=1)."""
import asyncio
import os

import pytest
from fastapi import HTTPException

from backend.app.api.v1.endpoints import graph_store as gs
from backend.app.services.graph_store import topology
from backend.app.services.graph_store.schemas import (
    GraphOnShard,
    GraphStoreInstance,
    GraphStoreNode,
    GraphStoreShard,
    GraphStoreTopologyResponse,
    ProviderRef,
)
from backend.app.services.permission_service import PermissionClaims
from backend.app.services.versioning import models
from backend.app.services.versioning.service import GraphVersioningService


def _snapshot(provider: str, keys) -> GraphStoreTopologyResponse:
    master = GraphStoreNode(endpoint="10.0.0.1:6379", node_id="m1", role="master")
    shard = GraphStoreShard(
        index=0, slot_ranges=[[0, 16383]], slot_count=16384, master=master,
        graphs=[GraphOnShard(key=k, slot=topology.key_slot(k), present=True) for k in keys],
        graphs_total=len(keys),
    )
    return GraphStoreTopologyResponse(instances=[GraphStoreInstance(
        id="inst1", providers=[ProviderRef(id=provider, name="Falkor West")],
        mode="cluster", reachable=True, shards=[shard],
    )])


def _readers(*workspaces) -> PermissionClaims:
    return PermissionClaims(sid="s1", global_perms=(),
                            ws_perms={ws: ("workspace:datasource:read",) for ws in workspaces})


async def _run(monkeypatch) -> None:
    from sqlalchemy import update

    from backend.app.services.versioning.db import graphver_session

    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    sfx = os.urandom(3).hex()
    prov = f"prov_pl_{sfx}"
    pinned = (await svc.create_graph(
        data_source_id=f"ds_pl_{sfx}", workspace_id="ws1",
        falkor_graph_name=f"customer_{sfx}", falkor_provider=prov))["graph_id"]
    fork = (await svc.fork_graph(parent_graph_id=pinned, workspace_id="ws1", actor="u_test"))["graph_id"]
    unprojected = (await svc.create_graph(data_source_id=f"ds_up_{sfx}", workspace_id="ws1"))["graph_id"]
    trashed = (await svc.create_graph(
        data_source_id=f"ds_tr_{sfx}", workspace_id="ws1",
        falkor_graph_name=f"trashed_{sfx}", falkor_provider=prov))["graph_id"]
    async with graphver_session() as s:
        await s.execute(update(models.GraphORM).where(models.GraphORM.id == trashed)
                        .values(deleted_at="2026-10-17T00:00:00Z"))
        await s.commit()

    fork_key = f"customer_{sfx}__fork_{fork}"
    rows = await svc.projection_placements([pinned, fork, unprojected, trashed, "graph_missing"])
    assert set(rows) == {pinned, fork, unprojected}          # trashed and unknown graphs: absent
    assert (rows[fork]["falkor_graph_name"], rows[fork]["falkor_provider"]) == (fork_key, prov)
    assert rows[fork]["workspace_id"] == "ws1"
    assert rows[unprojected]["falkor_graph_name"] is None

    snapshot = _snapshot(prov, [f"customer_{sfx}", fork_key])

    async def _for_request(*, fresh=False, wait_s=0.0):
        return snapshot, False

    monkeypatch.setattr(topology, "snapshot_for_request", _for_request)
    out = await gs.get_placement(graphId=fork, dataSourceId=None, providerId=None, graph=None,
                                 claims=_readers("ws1"))
    assert [(p.role, p.graph_key, p.present) for p in out.placements] == [("source", fork_key, True)]
    assert out.provider_id == prov and out.provider_name == "Falkor West"

    with pytest.raises(HTTPException) as exc:
        await gs.get_placement(graphId=fork, dataSourceId=None, providerId=None, graph=None,
                               claims=_readers("ws2"))
    assert exc.value.status_code == 404

    batch = await gs.get_placements(dataSourceIds=None, graphIds=f"{pinned},{fork},{trashed}",
                                    claims=_readers("ws1"))
    assert {g: b.graph_key for g, b in batch.placements.items()} == {
        pinned: f"customer_{sfx}", fork: fork_key}


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_placement_by_graph_id_reads_projection_state(monkeypatch):
    asyncio.run(_run(monkeypatch))
