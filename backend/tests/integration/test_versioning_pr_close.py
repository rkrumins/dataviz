"""Close/reject a PR (P12) — needs Postgres.

close_pr flips a PR to the (previously-unused) "closed" status, making it terminal:
both approve_pr and merge_pr reject a closed PR. Re-closing is idempotent; an
already-merged PR cannot be closed.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.service import GraphVersioningService


async def _edit_publish(svc, gid, actor, ops, msg):
    d = await svc.open_draft(graph_id=gid, owner=actor)
    await svc.stage_changes(graph_id=gid, branch_id=d, actor=actor, ops=ops)
    await svc.checkpoint(graph_id=gid, branch_id=d, actor=actor)
    return await svc.publish(graph_id=gid, branch_id=d, actor=actor, message=msg)


def _node(eid, **kw):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"displayName": eid, **kw}}


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    ds = lambda: "ds_" + os.urandom(4).hex()

    pg = (await svc.create_graph(data_source_id=ds(), workspace_id="ws1", actor="alice"))["graph_id"]
    await _edit_publish(svc, pg, "alice", [_node("A", f=1)], "seed")

    # ── closing a PR makes it terminal: no approve, no merge ────────────────
    F = await svc.fork_graph(parent_graph_id=pg, workspace_id="ws1", actor="bob")
    await _edit_publish(svc, F["graph_id"], "bob", [_node("A", f=10)], "fork edit")
    pr = await svc.open_pr(source_graph_id=F["graph_id"], actor="bob", reviewers=["carol"])

    assert (await svc.close_pr(pr_id=pr))["status"] == "closed"
    with pytest.raises(ValueError):                       # cannot merge a closed PR
        await svc.merge_pr(pr_id=pr, actor="alice", message="merge")
    with pytest.raises(ValueError):                       # cannot approve a closed PR
        await svc.approve_pr(pr_id=pr, actor="carol")
    assert (await svc.close_pr(pr_id=pr))["status"] == "closed"        # idempotent
    assert (await svc.get_pr(pr))["status"] == "closed"               # persisted

    # ── an already-merged PR cannot be closed ───────────────────────────────
    F2 = await svc.fork_graph(parent_graph_id=pg, workspace_id="ws1", actor="bob")
    await _edit_publish(svc, F2["graph_id"], "bob", [_node("B")], "fork2")
    pr2 = await svc.open_pr(source_graph_id=F2["graph_id"], actor="bob")   # no reviewers → mergeable
    await svc.merge_pr(pr_id=pr2, actor="alice", message="merge ok")       # → merged
    with pytest.raises(ValueError):
        await svc.close_pr(pr_id=pr2)

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_pr_close_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning pr-close e2e: OK")
