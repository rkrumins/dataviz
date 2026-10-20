"""Version control as a data source's life sees it — needs Postgres.

``main_heads`` is what the data-source list reports with ``include=versioning``: only graphs that
are live, in the workspace asking, and whose "enable version control" job (if any) finished —
each with the head of ``main``. A source that is absent is not versioned there.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models, purge_worker
from backend.app.services.versioning.service import GraphVersioningService


def _ds() -> str:
    return "ds_" + os.urandom(4).hex()


async def _publish(svc, gid, actor, eid, msg):
    d = await svc.open_draft(graph_id=gid, owner=actor)
    await svc.stage_changes(graph_id=gid, branch_id=d, actor=actor, ops=[
        {"op": "create", "entity_kind": "node", "entity_id": eid,
         "payload": {"entityType": "Dataset", "displayName": eid}}])
    await svc.checkpoint(graph_id=gid, branch_id=d, actor=actor)
    return await svc.publish(graph_id=gid, branch_id=d, actor=actor, message=msg)


async def _main_heads() -> None:
    svc = GraphVersioningService()
    ds_a, ds_b, ds_blank, ds_none = _ds(), _ds(), _ds(), _ds()

    a = (await svc.create_graph(data_source_id=ds_a, workspace_id="ws_a", actor="alice"))["graph_id"]
    head = await _publish(svc, a, "alice", "A", "add A")                 # seq 2
    top = (await svc.commit_log(graph_id=a, limit=1))[0]
    assert top["commit_id"] == head

    heads = await svc.main_heads(workspace_id="ws_a", data_source_ids=[ds_a, ds_none])
    assert heads == {ds_a: {
        "graph_id": a, "kind": "manual", "main_head_commit_seq": 2,
        "main_head_commit_id": head, "main_head_committed_at": top["created_at"],
    }}

    # another workspace's graph is not versioned here
    assert await svc.main_heads(workspace_id="ws_other", data_source_ids=[ds_a]) == {}

    # a graph with only its genesis and no enable job is versioned (a blank model is)
    blank = (await svc.create_graph(data_source_id=ds_blank, workspace_id="ws_a",
                                    actor="alice", kind="blank"))["graph_id"]
    got = await svc.main_heads(workspace_id="ws_a", data_source_ids=[ds_blank])
    assert got[ds_blank]["graph_id"] == blank and got[ds_blank]["main_head_commit_seq"] == 1

    # while version control is still being turned on — or its enable failed — it is not
    b = (await svc.create_graph(data_source_id=ds_b, workspace_id="ws_a", actor="alice"))["graph_id"]
    async with db.graphver_session() as s:
        job = models.JobORM(job_type="bootstrap", graph_id=b, workspace_id="ws_a",
                            data_source_id=ds_b, status="pending")
        s.add(job)
    for status, versioned in (("running", False), ("failed", False), ("completed", True)):
        async with db.graphver_session() as s:
            (await s.get(models.JobORM, job.id)).status = status
        got = await svc.main_heads(workspace_id="ws_a", data_source_ids=[ds_b])
        assert (ds_b in got) is versioned, status

    # a graph in the trash is not
    await purge_worker.tombstone_graphs_for_data_source(
        data_source_id=ds_a, workspace_id="ws_a", actor="alice")
    assert await svc.main_heads(workspace_id="ws_a", data_source_ids=[ds_a]) == {}


async def _run(*steps) -> None:
    await models.create_schema_and_partitions()
    try:
        for step in steps:
            await step()
    finally:
        await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_main_heads_report_only_graphs_whose_version_control_is_on():
    asyncio.run(_run(_main_heads))
