"""Draft & PR read visibility (RBAC scoping) — needs Postgres.

Drafts are PRIVATE: a draft's individual commits, state and diff are visible only to its owner and
to workspace managers (and explicit members of a shared draft). Once a draft is submitted as a merge
request, its commits become visible to the PR's author, its assigned reviewers, and managers — so a
reviewer can see exactly what (and who) is in the change before merging, while uninvolved readers
can't browse it. Managers (``Viewer.can_manage``) see everything; ``main`` stays readable to any
``datasource:read`` caller. A read called WITHOUT a Viewer (internal/tests) is unscoped.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.service import AccessDenied, GraphVersioningService, Viewer


def _node(eid, **kw):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"displayName": eid, "entityType": "Dataset", **kw}}


def _ids(rows):
    return [r["pr_id"] for r in rows]


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    G = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="alice")
    gid, main = G["graph_id"], G["main_branch_id"]
    seed = await svc.open_draft(graph_id=gid, owner="alice", name="seed")
    await svc.stage_changes(graph_id=gid, branch_id=seed, actor="alice", ops=[_node("A")])
    await svc.checkpoint(graph_id=gid, branch_id=seed, actor="alice")
    await svc.publish(graph_id=gid, branch_id=seed, actor="alice", message="seed")

    # alice's PRIVATE draft with two authored checkpoints
    dA = await svc.open_draft(graph_id=gid, owner="alice", name="feature-x")
    await svc.stage_changes(graph_id=gid, branch_id=dA, actor="alice", ops=[_node("B")])
    await svc.checkpoint(graph_id=gid, branch_id=dA, actor="alice")
    await svc.stage_changes(graph_id=gid, branch_id=dA, actor="alice", ops=[_node("C")])
    await svc.checkpoint(graph_id=gid, branch_id=dA, actor="alice")

    alice, bob, mgr = Viewer("alice", False), Viewer("bob", False), Viewer("mgr", True)
    rev = Viewer("rev", False)

    # ── owner sees its own draft's INDIVIDUAL commits, each with its author ──
    log = await svc.commit_log(graph_id=gid, branch_id=dA, viewer=alice)
    assert len(log) == 2 and all(c["actor"] == "alice" for c in log)

    # ── a non-owner, non-manager is blocked from the private draft (commits / state / diff) ──
    with pytest.raises(AccessDenied):
        await svc.commit_log(graph_id=gid, branch_id=dA, viewer=bob)
    with pytest.raises(AccessDenied):
        await svc.materialize_state(graph_id=gid, branch_id=dA, viewer=bob)
    with pytest.raises(AccessDenied):
        await svc.diff_branch_vs_base(graph_id=gid, branch_id=dA, viewer=bob)

    # ── a manager sees everything; main is readable by any datasource:read caller ──
    assert len(await svc.commit_log(graph_id=gid, branch_id=dA, viewer=mgr)) == 2
    assert len(await svc.commit_log(graph_id=gid, branch_id=main, viewer=bob)) >= 1

    # ── list_branches is filtered: bob sees only main; alice + manager see the draft ──
    assert dA not in [b["branch_id"] for b in await svc.list_branches(graph_id=gid, viewer=bob)]
    assert dA in [b["branch_id"] for b in await svc.list_branches(graph_id=gid, viewer=alice)]
    assert dA in [b["branch_id"] for b in await svc.list_branches(graph_id=gid, viewer=mgr)]

    # ── submit a PR with a reviewer; the source-branch owner is surfaced on the single-PR read ──
    mr = await svc.open_draft_mr(graph_id=gid, branch_id=dA, actor="alice", reviewers=["rev"])
    pr = await svc.get_pr(mr)
    assert pr["source_branch_owner"] == "alice" and pr["source_branch_name"] == "feature-x"

    # ── PR visibility: uninvolved bob doesn't see it; reviewer / author / manager do ──
    assert mr not in _ids(await svc.list_pulls(target_graph_id=gid, viewer=bob))
    assert mr in _ids(await svc.list_pulls(target_graph_id=gid, viewer=rev))
    assert mr in _ids(await svc.list_pulls(target_graph_id=gid, viewer=alice))
    assert mr in _ids(await svc.list_pulls(target_graph_id=gid, viewer=mgr))

    # ── the reviewer may read the draft's commits via the PR-participant rule (not a draft member) ──
    assert len(await svc.commit_log(graph_id=gid, branch_id=dA, viewer=rev)) == 2
    with pytest.raises(AccessDenied):                       # …but bob still cannot
        await svc.commit_log(graph_id=gid, branch_id=dA, viewer=bob)

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_visibility_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning draft/PR read visibility e2e: OK")
