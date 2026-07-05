"""Live "is this draft behind main?" signal — the O(1) collaboration primitive.

Powers "notified right away": a client polls this while editing so a branch owner learns a teammate
published under them BEFORE they try to merge. Semantics mirror the merge gate exactly
(behind_by = max(0, main_head - base)); main itself is never behind.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.service import GraphVersioningService


def _node(eid):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": f"urn:{eid}", "entityType": "Dataset", "displayName": eid}}


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    G = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="u")
    gid = G["graph_id"]

    d = await svc.open_draft(graph_id=gid, owner="alice")
    f = await svc.branch_freshness(graph_id=gid, branch_id=d)
    assert f["behind"] is False and f["behind_by"] == 0, f          # fresh draft is up-to-date

    # A DIFFERENT draft publishes → main advances under d.
    d2 = await svc.open_draft(graph_id=gid, owner="bob")
    await svc.apply_ops(graph_id=gid, branch_id=d2, actor="bob", ops=[_node("X")])
    await svc.publish(graph_id=gid, branch_id=d2, actor="bob", message="B publishes")

    f2 = await svc.branch_freshness(graph_id=gid, branch_id=d)
    assert f2["behind"] is True and f2["behind_by"] >= 1, f2        # d learns it's behind — right away
    assert f2["main_head_commit_seq"] > f2["base_commit_seq"], f2

    main_id = await svc.main_branch_id(gid)
    fm = await svc.branch_freshness(graph_id=gid, branch_id=main_id)
    assert fm["behind"] is False and fm["behind_by"] == 0, fm       # main is never behind itself

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres")
def test_versioning_branch_freshness():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("branch freshness signal: OK")
