"""Projection worker e2e — needs Postgres (+ optional Redis for the stream path).

Verifies the reconciling poll backstop (project every lagging graph), per-graph
serialization, and — when a broker Redis is reachable — the inline-nudge → Redis
stream → project path with XACK. FalkorDB content correctness is covered by
test_versioning_projection; here we assert the *watermark* advances (the worker's
job), so a no-op graph client suffices.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.messaging import (
    CONSUMER_GROUP,
    PROJECTION_STREAM,
    close_broker_redis,
    ensure_consumer_group,
    get_broker_redis,
    nudge_projection,
)
from backend.app.services.versioning.models import ProjectionStateORM
from backend.app.services.versioning.projection import FalkorProjector
from backend.app.services.versioning.service import GraphVersioningService
from backend.app.services.versioning.worker import ProjectionWorker


class _NoopGraph:
    async def query(self, cypher, params=None):
        return None


def _factory(_name, _provider_id=None):
    return _NoopGraph()


async def _seed_graph(svc) -> str:
    g = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="a",
                               falkor_graph_name="gvt_" + os.urandom(3).hex())
    gid = g["graph_id"]
    d = await svc.open_draft(graph_id=gid, owner="a")
    await svc.stage_changes(graph_id=gid, branch_id=d, actor="a", ops=[
        {"op": "create", "entity_kind": "node", "entity_id": "A",
         "payload": {"displayName": "A", "entityType": "Dataset"}},
    ])
    await svc.checkpoint(graph_id=gid, branch_id=d, actor="a")
    await svc.publish(graph_id=gid, branch_id=d, actor="a", message="seed")
    return gid


async def _watermark(gid: str) -> int:
    async with db.graphver_session() as s:
        return (await s.get(ProjectionStateORM, gid)).projected_commit_seq


async def _redis_ok() -> bool:
    try:
        await get_broker_redis().ping()
        return True
    except Exception:
        return False


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    worker = ProjectionWorker(FalkorProjector(graph_client_factory=_factory), poll_secs=100)

    # ── poll backstop catches up every lagging graph ─────────────────────
    gids = [await _seed_graph(svc) for _ in range(2)]
    assert [await _watermark(g) for g in gids] == [0, 0]        # projected lags target
    await worker.reconcile_once()
    assert [await _watermark(g) for g in gids] == [2, 2]        # all caught up to head

    # ── per-graph serialization: a graph already in-flight is skipped ────
    worker._inflight.add(gids[0])
    assert await worker._project_one(gids[0]) is None
    worker._inflight.discard(gids[0])
    assert (await worker._project_one(gids[0]))["noop"] is True  # now allowed, already caught up

    # ── inline-nudge → Redis stream → project (skipped if no broker) ─────
    if await _redis_ok():
        await ensure_consumer_group()
        gid = await _seed_graph(svc)                            # projected=0, target=2
        await nudge_projection(gid)                             # XADD wake-up
        client = get_broker_redis()
        resp = await client.xreadgroup(CONSUMER_GROUP, "test", {PROJECTION_STREAM: ">"}, count=20, block=1000)
        hit = False
        for _stream, msgs in resp or []:
            for msg_id, fields in msgs:
                if (fields or {}).get("graph_id") == gid:
                    await worker._project_one(gid)
                    hit = True
                await client.xack(PROJECTION_STREAM, CONSUMER_GROUP, msg_id)
        assert hit, "nudge did not land on the stream"
        assert await _watermark(gid) == 2
        # nudge is best-effort even on a bad id — never raises
        await nudge_projection("does-not-exist")
        await close_broker_redis()

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_worker_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning projection worker e2e: OK")
