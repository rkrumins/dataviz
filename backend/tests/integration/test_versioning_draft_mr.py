"""Draft -> main Merge Request + approval gate (unification Phase 3) — needs Postgres.

A per-user draft is merged to main through a reviewed Merge Request: reviewers gate the
squash, the author can't self-approve, the merge recomputes the 3-way at merge time
(so a draft that went stale conflicts and is resolvable), and a no-reviewer MR merges
freely. The same merge_mr entrypoint still drives legacy fork PRs (source_graph_id NULL).
"""
import asyncio
import os

import pytest
from sqlalchemy.exc import IntegrityError

from backend.app.services.versioning import db, models
from backend.app.services.versioning.service import (
    AccessDenied,
    ApprovalRequired,
    GraphVersioningService,
    MergeConflict,
    NotUpToDate,
    PullRequestExists,
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
    assert (await svc.get_pr(mrY))["behind"] is True                            # …and the FE's merge gate is up
    with pytest.raises(NotUpToDate):                                            # behind → forced to pull first
        await svc.merge_mr(mr_id=mrY, actor="alice", message="Y")
    assert (await svc.rebase_draft(graph_id=gid, branch_id=dY, actor="alice"))["clean"] is False  # clash surfaces at the pull
    assert (await svc.rebase_draft(graph_id=gid, branch_id=dY, actor="alice",
            resolutions={"A": {"displayName": "A", "entityType": "Dataset", "f": 99}}))["clean"] is True
    # The pull MUST clear the PR's behind flag. `behind` is read from the LIVE branch base, not the
    # frozen pr.base_commit_seq — reading the latter left a pulled draft "behind" forever, and the
    # FE swaps Merge for "Pull latest" on this flag, so the PR became unmergeable through the UI
    # even though merge_mr (which reads the live base) would have accepted it.
    pulled = await svc.get_pr(mrY)
    assert pulled["behind"] is False and pulled["behind_by"] == 0
    assert await svc.merge_mr(mr_id=mrY, actor="alice", message="Y resolved")
    assert (await svc.materialize_state(graph_id=gid, branch_id=main))["nodes"]["A"]["f"] == 99

    # ══ C2. the two-user race, no conflict: B's PR goes behind when A beats them to the merge, and
    #        PULLING clears the gate. This is the ordinary "someone merged before me" path — the one
    #        the deadlock made impossible (behind stayed True forever, so Merge never came back). ══
    dA = await _draft(svc, gid, "alice", [_node("RA")])
    dB = await _draft(svc, gid, "bob", [_node("RB")])                           # same base, disjoint entities
    mrB = await svc.open_draft_mr(graph_id=gid, branch_id=dB, actor="bob")
    assert (await svc.get_pr(mrB))["behind"] is False                           # nobody has moved main yet
    mrA = await svc.open_draft_mr(graph_id=gid, branch_id=dA, actor="alice")
    assert await svc.merge_mr(mr_id=mrA, actor="alice", message="A wins the race")
    assert (await svc.get_pr(mrB))["behind"] is True                            # main moved under B
    with pytest.raises(NotUpToDate):
        await svc.merge_mr(mr_id=mrB, actor="bob", message="B")
    assert (await svc.rebase_draft(graph_id=gid, branch_id=dB, actor="bob"))["clean"] is True
    assert (await svc.get_pr(mrB))["behind"] is False                           # ← the deadlock: was True forever
    assert await svc.merge_mr(mr_id=mrB, actor="bob", message="B after pull")
    both = await svc.materialize_state(graph_id=gid, branch_id=main)
    assert "RA" in both["nodes"] and "RB" in both["nodes"]                      # both users' work landed

    # ══ D. dispatch: a legacy fork PR still merges through merge_mr ══
    F = await svc.fork_graph(parent_graph_id=gid, workspace_id="ws1", actor="bob")
    await _edit_publish(svc, F["graph_id"], "bob", [_node("Z")], "fork edit")
    prF = await svc.open_pr(source_graph_id=F["graph_id"], actor="bob")
    assert (await svc.get_pr(prF))["source_graph_id"] is None                   # fork PR (not a draft MR)
    assert await svc.merge_mr(mr_id=prF, actor="alice", message="merge fork via mr")
    assert "Z" in (await svc.materialize_state(graph_id=gid, branch_id=main))["nodes"]

    # ══ E. ONE LIVE PR PER BRANCH. A PR's diff is computed live from its source branch, so commits
    #       made after it was raised are already in it — a second PR would be a duplicate, and
    #       merging either one strands the other as an unmergeable row. ══
    dE = await _draft(svc, gid, "alice", [_node("E1")])
    prE = await svc.open_draft_mr(graph_id=gid, branch_id=dE, actor="alice", title="first")
    with pytest.raises(PullRequestExists) as ex:                                # the friendly path…
        await svc.open_draft_mr(graph_id=gid, branch_id=dE, actor="alice", title="second")
    assert ex.value.pr_id == prE and ex.value.title == "first"                  # …routes to the EXISTING review

    # …and the DB index is the backstop for the race two concurrent openers would otherwise win
    # together (both pass the service pre-check, both insert). Bypass the service entirely to prove
    # the constraint itself holds.
    async with db.get_session_factory()() as s:
        s.add(models.MergeRequestORM(
            graph_id=gid, source_graph_id=gid, source_branch_id=dE, target_graph_id=gid,
            target_branch="main", status="mergeable", actor="mallory",
        ))
        with pytest.raises(IntegrityError):
            await s.flush()

    # A new PR is allowed once the branch's PR is no longer live (closed → the branch is free again).
    await svc.close_pr(pr_id=prE, actor="alice")
    prE2 = await svc.open_draft_mr(graph_id=gid, branch_id=dE, actor="alice", title="reopened")
    assert prE2 != prE
    assert await svc.merge_mr(mr_id=prE2, actor="alice", message="E")
    assert "E1" in (await svc.materialize_state(graph_id=gid, branch_id=main))["nodes"]
    assert (await svc.get_pr(prE2))["merged_via"] == "review"                   # merged THROUGH the review

    # ══ F. NO LIVE PR SURVIVES A SQUASH OF ITS SOURCE BRANCH. A direct `publish` lands exactly the
    #       changes the open PR proposed, so it RESOLVES that PR (stamped direct_publish, so the
    #       bypassed review is legible as such). It used to orphan it: a live PR pointing at a
    #       merged branch, unmergeable but still rendered as actionable, showing an empty diff. ══
    dF = await _draft(svc, gid, "alice", [_node("F1")])
    prF2 = await svc.open_draft_mr(graph_id=gid, branch_id=dF, actor="alice", title="bypassed")
    cidF = await svc.publish(graph_id=gid, branch_id=dF, actor="alice", message="publish over the PR")
    settled = await svc.get_pr(prF2)
    assert settled["status"] == "merged"                                        # ← was left live (zombie)
    assert settled["resulting_commit_id"] == cidF                               # points at the squash that landed it
    assert settled["merged_via"] == "direct_publish"                            # the review was bypassed — say so
    assert "F1" in (await svc.materialize_state(graph_id=gid, branch_id=main))["nodes"]

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_draft_mr_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning draft -> main merge request + approval gate e2e: OK")
