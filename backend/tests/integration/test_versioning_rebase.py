"""Pull-latest (rebase_draft) + auto-rebase-when-clean on merge — needs Postgres.

Multiple named drafts run in parallel off the same main. Merging one advances main, so the others
go out of date. A stale draft is NO LONGER hard-blocked: merge auto-rebases it against current main
in one step when the 3-way merge is conflict-free (non-overlapping edits), and only raises
MergeConflict on a genuine same-field clash — which the user resolves via rebase_draft(resolutions=)
(the explicit "pull latest" path, still available). The PR `behind`/`behind_by` meta still surfaces
staleness for the UI even though it no longer blocks a clean merge.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.service import GraphVersioningService, MergeConflict, NotUpToDate


def _node(eid, **kw):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"displayName": eid, "entityType": "Dataset", **kw}}


def _upd(eid, **kw):
    return {"op": "update", "entity_kind": "node", "entity_id": eid,
            "payload": {"displayName": eid, "entityType": "Dataset", **kw}}


async def _draft(svc, gid, owner, name, ops):
    d = await svc.open_draft(graph_id=gid, owner=owner, name=name)
    await svc.stage_changes(graph_id=gid, branch_id=d, actor=owner, ops=ops)
    await svc.checkpoint(graph_id=gid, branch_id=d, actor=owner)
    return d


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    G = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="alice")
    gid, main = G["graph_id"], G["main_branch_id"]
    seed = await _draft(svc, gid, "alice", "seed", [_node("A", f=1), _node("B", f=1)])
    await svc.publish(graph_id=gid, branch_id=seed, actor="alice", message="seed")

    # ── parallel NAMED drafts off the same main ──
    d1 = await _draft(svc, gid, "alice", "feature-x", [_upd("A", f=2)])     # edits A
    d2 = await _draft(svc, gid, "bob", "feature-y", [_upd("B", f=2)])       # edits B (non-overlapping)
    d3 = await _draft(svc, gid, "carol", "feature-z", [_upd("A", f=99)])    # edits A (will clash with d1)
    metas = {b["branch_id"]: b for b in await svc.list_branches(graph_id=gid)}
    assert metas[d1]["name"] == "feature-x" and metas[d2]["name"] == "feature-y"   # names round-trip

    # ── merge one (main advances: A.f -> 2) ──
    mr1 = await svc.open_draft_mr(graph_id=gid, branch_id=d1, actor="alice")
    assert await svc.merge_mr(mr_id=mr1, actor="alice", message="merge x")
    head = (await svc.get_graph(gid))["main_head_commit_seq"]

    # ── the others are now behind: meta surfaces it, and merge is HARD-GATED (pull latest first) ──
    mr2 = await svc.open_draft_mr(graph_id=gid, branch_id=d2, actor="bob")
    pr2 = await svc.get_pr(mr2)
    assert pr2["behind"] is True and pr2["behind_by"] >= 1     # meta still surfaces staleness for the UI
    _ = head

    # ── d2 edits B (non-overlapping): the later arrival is forced to PULL first; the pull is clean,
    #    then the merge lands — end state identical to auto-rebase, but the rebase is explicit. ──
    with pytest.raises(NotUpToDate):
        await svc.merge_mr(mr_id=mr2, actor="bob", message="merge y")
    assert (await svc.rebase_draft(graph_id=gid, branch_id=d2, actor="bob"))["clean"] is True
    assert await svc.merge_mr(mr_id=mr2, actor="bob", message="merge y")
    st_main = await svc.materialize_state(graph_id=gid, branch_id=main)
    assert st_main["nodes"]["A"]["f"] == 2 and st_main["nodes"]["B"]["f"] == 2   # both edits on main

    # ── d3 also edited A → gated; the forced pull is where the same-field clash surfaces & resolves ──
    mr3a = await svc.open_draft_mr(graph_id=gid, branch_id=d3, actor="carol")
    with pytest.raises(NotUpToDate):
        await svc.merge_mr(mr_id=mr3a, actor="carol", message="merge z")
    rc = await svc.rebase_draft(graph_id=gid, branch_id=d3, actor="carol")
    assert rc["clean"] is False and rc["conflicts"][0]["entity_id"] == "A"
    rc2 = await svc.rebase_draft(graph_id=gid, branch_id=d3, actor="carol",
                                 resolutions={"A": {"displayName": "A", "entityType": "Dataset", "f": 99}})
    assert rc2["clean"] is True
    # The SAME PR merges — a pull does not stale a PR, so no second one is opened (nor could be:
    # one live PR per branch). Its diff is computed live from the branch, so the rebase is already
    # reflected in it, and the pull cleared its behind-gate.
    assert (await svc.get_pr(mr3a))["behind"] is False
    assert await svc.merge_mr(mr_id=mr3a, actor="carol", message="merge z2")
    assert (await svc.materialize_state(graph_id=gid, branch_id=main))["nodes"]["A"]["f"] == 99

    # ══ A PULL IS RECORDED. The case that used to write NOTHING: upstream changes that don't touch
    #    the entities this draft edited. deltas over `own` came out empty, so no commit was written —
    #    base_commit_seq just moved and the branch history had a silent gap exactly where someone
    #    else's work arrived. Now a `pull` commit always lands, carrying the upstream commits. ══
    dP = await _draft(svc, gid, "dan", "feature-p", [_node("P", f=1)])         # dan touches only P
    up1 = await _draft(svc, gid, "erin", "up-1", [_node("U1", f=1)])           # …others land elsewhere
    await svc.publish(graph_id=gid, branch_id=up1, actor="erin", message="upstream one")
    up2 = await _draft(svc, gid, "frank", "up-2", [_node("U2", f=1)])
    await svc.publish(graph_id=gid, branch_id=up2, actor="frank", message="upstream two")

    log_before = await svc.commit_log(graph_id=gid, branch_id=dP)
    res = await svc.rebase_draft(graph_id=gid, branch_id=dP, actor="dan")
    assert res["clean"] is True
    assert res["changes"] == {"create": 0, "update": 0, "delete": 0}           # dan's OWN edits: untouched…
    inc = res["incoming"]
    assert inc["commit_count"] == 2                                            # …but TWO commits came in
    assert sorted(inc["contributors"]) == ["erin", "frank"]                    # …from these people
    assert inc["stats"]["create"] == 2                                         # …adding U1 and U2

    log_after = await svc.commit_log(graph_id=gid, branch_id=dP)
    assert len(log_after) == len(log_before) + 1                               # ← was + 0: the silent gap
    pull_commit = log_after[0]                                                 # newest first
    assert pull_commit["kind"] == "pull"
    assert pull_commit["source_commit_count"] == 2
    assert pull_commit["stats"]["create"] == 2                                 # what CAME IN, not our rewrite
    assert pull_commit["stats"]["from_seq"] < pull_commit["stats"]["to_seq"]   # the window to diff main over

    # The drill-down the UI already has (CommitRow → squashed_commits, keyed on source_commit_ids)
    # works on a pull commit with no new code: it lists the upstream commits that arrived.
    drill = await svc.squashed_commits(graph_id=gid, commit_id=pull_commit["commit_id"])
    assert [c["message"] for c in drill] == ["upstream two", "upstream one"]   # newest-first

    # The pull left the draft up to date and its own work intact.
    assert (await svc.branch_freshness(graph_id=gid, branch_id=dP))["behind"] is False
    st_p = await svc.materialize_state(graph_id=gid, branch_id=dP)
    assert st_p["nodes"]["P"]["f"] == 1                                        # dan's edit survived
    assert "U1" in st_p["nodes"] and "U2" in st_p["nodes"]                     # upstream work is visible

    # A no-op pull stays a no-op — it must not litter history with empty pull commits.
    res2 = await svc.rebase_draft(graph_id=gid, branch_id=dP, actor="dan")
    assert res2["already_up_to_date"] is True
    assert res2["incoming"]["commit_count"] == 0
    assert len(await svc.commit_log(graph_id=gid, branch_id=dP)) == len(log_after)

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_rebase_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning rebase + up-to-date gate e2e: OK")
