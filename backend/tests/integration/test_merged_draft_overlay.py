"""A published draft reads as main — never as main plus its own edits a second time.

After a draft merges, everything it changed is in main. Overlaying its edits on main again
counted each added child twice in its parent's count: a tab still showing the published draft
offered "Load 2 more" that loaded nothing.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.service import GraphVersioningService


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                                  actor="alice"))["graph_id"]
    d = await svc.open_draft(graph_id=gid, owner="alice")
    await svc.stage_changes(graph_id=gid, branch_id=d, actor="alice", ops=[
        {"op": "create", "entity_kind": "node", "entity_id": "P",
         "payload": {"urn": "P", "entityType": "domain", "displayName": "P"}},
    ])
    await svc.checkpoint(graph_id=gid, branch_id=d, actor="alice")
    before = await svc.branch_overlay_delta(graph_id=gid, branch_id=d)
    assert [n["urn"] for n in before["nodesUpsert"]] == ["P"], "an open draft overlays its edits"
    await svc.publish(graph_id=gid, branch_id=d, actor="alice", message="publish")
    after = await svc.branch_overlay_delta(graph_id=gid, branch_id=d)
    assert after == {"nodesUpsert": [], "nodesRemove": [], "edgesUpsert": [], "edgesRemove": [],
                     "nodesNew": []}, f"a merged draft must read as main: {after}"
    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_a_published_draft_reads_as_main():
    asyncio.run(_run())
