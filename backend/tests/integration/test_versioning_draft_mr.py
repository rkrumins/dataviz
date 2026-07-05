"""Draft -> main Merge Request + approval gate (unification Phase 3) — needs Postgres.

A per-user draft is merged to main through a reviewed Merge Request: reviewers gate the
squash, the author can't self-approve, the merge recomputes the 3-way at merge time
(so a draft that went stale conflicts and is resolvable), and a no-reviewer MR merges
freely. The same merge_mr entrypoint still drives legacy fork PRs (source_graph_id NULL).
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.service import (
    AccessDenied,
    ApprovalRequired,
    GraphVersioningService,
    MergeConflict,
    NotUpToDate,
)


def _node(eid, et="Dataset", **kw):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"displayName": eid, "entityType": et, **kw}}


def _upd(eid, et="Dataset", **kw):
    return {"op": "update", "entity_kind": "node", "entity_id": eid,
            "payload": {"displayName": eid, "entityType": et, **kw}}


async def _edit_publish(svc, gid, actor, ops, msg):
    d = await svc.open_draft(graph_id=gid, owner=actor)
    await svc.stage_changes(graph_id=gid, branch_id=d, actor=actor, ops=ops)
    await svc.checkpoint(graph_id=gid, branch_id=d, actor=actor)
    return await svc.publish(graph_id=gid, branch_id=d, actor=actor, message=msg)


async def _draft(svc, gid, actor, ops):
    d = await svc.open_draft(graph_id=gid, owner=actor)
    await svc.stage_changes(graph_id=gid, branch_id=d, actor=actor, ops=ops)
    await svc.checkpoint(graph_id=gid, branch_id=d, actor=actor)
    return d


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    ds = lambda: "ds_" + os.urandom(4).hex()

    G = await svc.create_graph(data_source_id=ds(), workspace_id="ws1", actor="alice")
    gid, main = G["graph_id"], G["main_branch_id"]
    await _edit_publish(svc, gid, "alice", [_node("A", f=1)], "seed")           # main seq 2

    # ══ A. reviewed MR: approval gate, author can't self-approve, then merge ══
    d = await _draft(svc, gid, "alice", [_upd("A", f=2), _node("B")])
    mr = await svc.open_draft_mr(graph_id=gid, branch_id=d, actor="alice", reviewers=["carol"])
    meta = await svc.get_pr(mr)
    assert meta["status"] == "mergeable" and meta["approval_status"] == "pending"
    assert meta["source_graph_id"] == gid                                       # draft MR discriminator
    assert (await svc.preview_mr(mr_id=mr))["clean"] is True

    with pytest.raises(ApprovalRequired) as ei:                                 # unapproved → blocked
        await svc.merge_mr(mr_id=mr, actor="alice", message="merge")
    assert ei.value.pending == ["carol"]
    with pytest.raises(AccessDenied):                                           # author can't self-approve
        await svc.approve_pr(pr_id=mr, actor="alice")
    assert (await svc.approve_pr(pr_id=mr, actor="carol"))["approval_status"] == "approved"

    head_before = (await svc.get_graph(gid))["main_head_commit_seq"]
    cid = await svc.merge_mr(mr_id=mr, actor="alice", message="merge")
    assert cid
    st = await svc.materialize_state(graph_id=gid, branch_id=main)
    assert st["nodes"]["A"]["f"] == 2 and "B" in st["nodes"]
    assert (await svc.get_graph(gid))["main_head_commit_seq"] == head_before + 1   # exactly one squash
    done = await svc.get_pr(mr)
    assert done["status"] == "merged" and done["resulting_commit_id"] == cid
    with pytest.raises(ValueError):                                             # re-merging a merged MR
        await svc.merge_mr(mr_id=mr, actor="alice", message="again")

    # ══ B. a no-reviewer MR merges without approval ══
    d2 = await _draft(svc, gid, "alice", [_node("C")])
    mr2 = await svc.open_draft_mr(graph_id=gid, branch_id=d2, actor="alice")
    assert (await svc.get_pr(mr2))["approval_status"] is None
    assert await svc.merge_mr(mr_id=mr2, actor="alice", message="no-review")
    assert "C" in (await svc.materialize_state(graph_id=gid, branch_id=main))["nodes"]

    # ══ C. a stale draft is HARD-GATED at merge; the forced pull is where a same-field clash
    #       surfaces and is resolved, then it merges ══
    dX = await _draft(svc, gid, "alice", [_upd("A", f=10)])
    dY = await _draft(svc, gid, "alice", [_upd("A", f=20)])                     # same base, same field
    mrX = await svc.open_draft_mr(graph_id=gid, branch_id=dX, actor="alice")
    assert await svc.merge_mr(mr_id=mrX, actor="alice", message="X")           # main A.f -> 10
    mrY = await svc.open_draft_mr(graph_id=gid, branch_id=dY, actor="alice")
    assert (await svc.get_pr(mrY))["status"] == "conflicts"                     # main advanced under dY
    with pytest.raises(NotUpToDate):                                            # behind → forced to pull first
        await svc.merge_mr(mr_id=mrY, actor="alice", message="Y")
    assert (await svc.rebase_draft(graph_id=gid, branch_id=dY, actor="alice"))["clean"] is False  # clash surfaces at the pull
    assert (await svc.rebase_draft(graph_id=gid, branch_id=dY, actor="alice",
            resolutions={"A": {"displayName": "A", "entityType": "Dataset", "f": 99}}))["clean"] is True
    assert await svc.merge_mr(mr_id=mrY, actor="alice", message="Y resolved")
    assert (await svc.materialize_state(graph_id=gid, branch_id=main))["nodes"]["A"]["f"] == 99

    # ══ D. dispatch: a legacy fork PR still merges through merge_mr ══
    F = await svc.fork_graph(parent_graph_id=gid, workspace_id="ws1", actor="bob")
    await _edit_publish(svc, F["graph_id"], "bob", [_node("Z")], "fork edit")
    prF = await svc.open_pr(source_graph_id=F["graph_id"], actor="bob")
    assert (await svc.get_pr(prF))["source_graph_id"] is None                   # fork PR (not a draft MR)
    assert await svc.merge_mr(mr_id=prF, actor="alice", message="merge fork via mr")
    assert "Z" in (await svc.materialize_state(graph_id=gid, branch_id=main))["nodes"]

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_draft_mr_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning draft -> main merge request + approval gate e2e: OK")
