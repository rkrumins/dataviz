"""Read-your-writes on main after a merge (versioning) — needs Postgres.

A merge commits to the Postgres version store and only *nudges* an async FalkorDB projection
(setting the projection target); it does not write through to FalkorDB. So right after a merge the
projection watermark is stale (projected < committed). This asserts that contract for both a direct
publish and a reviewed-MR merge, and that the Postgres main reader — the one
ContextEngine.for_workspace falls back to while the projection lags (see
test_versioning_draft_read_routing) — already reflects the merged change. Together they guarantee a
merge is visible on main immediately, before the projector catches up.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.service import GraphVersioningService


def _node(eid, **kw):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"displayName": eid, "entityType": "Dataset", **kw}}


async def _draft_edit(svc, gid, actor, ops):
    d = await svc.open_draft(graph_id=gid, owner=actor)
    await svc.stage_changes(graph_id=gid, branch_id=d, actor=actor, ops=ops)
    await svc.checkpoint(graph_id=gid, branch_id=d, actor=actor)
    return d


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    G = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(),
                               workspace_id="ws1", actor="alice")
    gid, main = G["graph_id"], G["main_branch_id"]

    # era 1 — direct publish of a draft to main
    d = await _draft_edit(svc, gid, "alice", [_node("A")])
    await svc.publish(graph_id=gid, branch_id=d, actor="alice", message="add A")

    wm = await svc.projection_watermark(gid)
    committed = (await svc.get_graph(gid))["main_head_commit_seq"]
    assert wm["committed"] == committed and wm["target"] == committed   # merge advanced + nudged
    assert wm["projected"] < committed and wm["fresh"] is False         # projector hasn't caught up
    # the Postgres main reader (the read-your-writes target) already has the change
    assert "A" in (await svc.materialize_state(graph_id=gid, branch_id=main))["nodes"]

    # era 2 — reviewed MR merge advances main again; still stale, still visible via Postgres
    d2 = await _draft_edit(svc, gid, "alice", [_node("B")])
    mr = await svc.open_draft_mr(graph_id=gid, branch_id=d2, actor="alice")
    assert await svc.merge_mr(mr_id=mr, actor="alice", message="add B")

    wm2 = await svc.projection_watermark(gid)
    assert wm2["projected"] < wm2["committed"] and wm2["fresh"] is False
    assert "B" in (await svc.materialize_state(graph_id=gid, branch_id=main))["nodes"]

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_merge_visibility_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning merge visibility (read-your-writes on main) e2e: OK")
