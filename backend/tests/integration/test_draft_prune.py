"""A closed draft's changes are removed after the retention window, and its record stays (live Postgres).

Pins:
- Due: a draft merged or abandoned longer ago than the window. Its rows go: heads, staged changes,
  integrity tree, versions. Its record stays: the branch (``prunedAt``), its commits, its review.
  ``updated_at`` is not moved.
- Kept: an open draft, one closed inside the window, and an abandoned one whose review is still
  open.
- ``main`` reads as before, and so do its history and the squash commit's diff.
- A read of a removed draft's changes is 410 ``draft_pruned``, never an empty diff: its diff, its
  state, its commits' diffs, a closed review's.
- A merged review's Files changed is what its merge changed (its squash commit), before the draft
  is removed and after. Before, it was recomputed against a ``main`` that already held it, so it
  was empty.
- A removal cut off by the pass's budget is finished first by the next pass. A window another
  worker emptied at the same moment deletes nothing here, so the draft is looked at again before it
  is called finished.
"""
from __future__ import annotations

import asyncio
import os
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select, text, update

from backend.app.services.versioning import config, db, models, purge_worker
from backend.app.services.versioning.change_index import ChangeOrigin
from backend.app.services.versioning.errors import DraftPruned
from backend.app.services.versioning.models import BranchORM
from backend.app.services.versioning.service import GraphVersioningService, Viewer, _DRAFT_ROWS

pytestmark = pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"),
                                reason="set GRAPHVER_E2E=1 + a live Postgres to run")


def _node(eid, **p):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": f"urn:{eid}", "entityType": "Table", "displayName": eid, **p}}


def _upd(eid, **p):
    return {"op": "update", "entity_kind": "node", "entity_id": eid, "payload": p}


def _counts(diff):
    return {k: len(diff[k]) for k in ("added", "removed", "modified")}


async def _rows(gid, bid):
    async with db.graphver_session() as s:
        return {t: (await s.execute(text(
            f'SELECT count(*) FROM "{config.graphver_schema()}"."{t}" '
            "WHERE graph_id = :g AND branch_id = :b"), {"g": gid, "b": bid})).scalar()
            for t, _order in _DRAFT_ROWS}


async def _branch(bid):
    async with db.graphver_session() as s:
        return await s.get(BranchORM, bid)


async def _cases(svc, monkeypatch):
    gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(),
                                  workspace_id="ws1", actor="alice"))["graph_id"]
    await svc.apply_ops(graph_id=gid, actor="alice", message="seed",
                        ops=[_node("N"), _node("M"), _node("K")])
    main = await svc.main_branch_id(gid)
    alice = Viewer(actor="alice")

    # Merged through a review: its Files changed is its merge's, before and after the removal.
    merged = await svc.open_draft(graph_id=gid, owner="alice")
    await svc.apply_ops(graph_id=gid, branch_id=merged, actor="alice", message="edit",
                        ops=[_upd("N", description="new"), _node("X")])
    mr = await svc.open_draft_mr(graph_id=gid, branch_id=merged, actor="alice", reviewers=["carol"])
    await svc.approve_pr(pr_id=mr, actor="carol")
    squash = await svc.merge_mr(mr_id=mr, actor="carol", message="merge")
    landed = _counts(await svc.diff_pr(pr_id=mr))
    assert landed == {"added": 1, "removed": 0, "modified": 1}, landed
    summary = await svc.diff_pr_summary(pr_id=mr, containment_edge_types=[])
    assert summary["counts"] == {"added": 1, "modified": 1, "removed": 0}, summary["counts"]
    main_before = (await svc.materialize_state(graph_id=gid, branch_id=main))["nodes"]
    log_before = [c["commit_id"] for c in await svc.commit_log(graph_id=gid, branch_id=main)]

    # Abandoned, with its review closed and an edit left staged: removed. Abandoned with its
    # review open: kept.
    abandoned = await svc.open_draft(graph_id=gid, owner="alice")
    await svc.apply_ops(graph_id=gid, branch_id=abandoned, actor="alice", message="try",
                        ops=[_upd("M", description="tried")])
    await svc.stage_changes(graph_id=gid, branch_id=abandoned, actor="alice",
                            ops=[_upd("K", note="staged")])
    assert (await _rows(gid, abandoned))["working_changes"], "an edit left staged"
    closed_mr = await svc.open_draft_mr(graph_id=gid, branch_id=abandoned, actor="alice")
    await svc.close_pr(pr_id=closed_mr, actor="alice")
    await svc.abandon_draft(graph_id=gid, branch_id=abandoned, actor="alice")
    waiting = await svc.open_draft(graph_id=gid, owner="alice")
    await svc.apply_ops(graph_id=gid, branch_id=waiting, actor="alice", message="wait",
                        ops=[_upd("M", description="waiting")])
    await svc.open_draft_mr(graph_id=gid, branch_id=waiting, actor="alice")
    await svc.abandon_draft(graph_id=gid, branch_id=waiting, actor="alice")
    open_draft = await svc.open_draft(graph_id=gid, owner="alice")
    await svc.apply_ops(graph_id=gid, branch_id=open_draft, actor="alice", message="open",
                        ops=[_upd("K", description="open")])
    kept = {b: await _rows(gid, b) for b in (waiting, open_draft)}
    assert all(sum(r.values()) for r in kept.values()), kept
    closed_at = {b: (await _branch(b)).updated_at for b in (merged, abandoned)}

    # Inside the window: nothing is due.
    soon = datetime.now(timezone.utc) + timedelta(days=29)
    assert await svc.prune_closed_drafts(older_than_days=30, now=soon, graph_id=gid) == []
    assert (await _branch(merged)).pruned_at is None

    # A removal cut off before its first window: marked, its rows still there, then finished
    # first by the next pass.
    later = datetime.now(timezone.utc) + timedelta(days=31)
    async with db.graphver_session() as s:
        await s.execute(update(BranchORM).where(BranchORM.id == abandoned)
                        .values(pruned_at="2026-01-01T00:00:00+00:00", updated_at=BranchORM.updated_at))
    assert sum((await _rows(gid, abandoned)).values())
    finished = await svc.prune_closed_drafts(older_than_days=30, now=later, graph_id=gid)
    assert finished[0] == abandoned and set(finished) == {abandoned, merged}, finished
    async with db.graphver_session() as s:
        others = set((await s.execute(select(BranchORM.id).where(
            BranchORM.graph_id == gid, BranchORM.pruned_at.isnot(None)))).scalars())
    assert others == {merged, abandoned}, "the open draft and the one under review are kept"

    for b in (merged, abandoned):
        assert await _rows(gid, b) == {t: 0 for t, _o in _DRAFT_ROWS}, b
        row = await _branch(b)
        assert row.pruned_at and row.prune_finished_at, b
        assert row.updated_at == closed_at[b], "the closed clock is not moved"
    for b, rows in kept.items():
        assert await _rows(gid, b) == rows, b

    # Its record still reads; its changes are refused, never read as an empty diff.
    meta = await svc.get_branch(graph_id=gid, branch_id=merged, viewer=alice)
    assert meta["status"] == "merged" and meta["pruned_at"], meta
    assert [c["commit_id"] for c in await svc.commit_log(graph_id=gid, branch_id=merged)]
    draft_commit = (await svc.commit_log(graph_id=gid, branch_id=merged))[0]["commit_id"]
    refused = [
        svc.diff_branch_vs_base(graph_id=gid, branch_id=merged, viewer=alice),
        svc.materialize_state(graph_id=gid, branch_id=abandoned),
        svc.diff_commit_summary(graph_id=gid, commit_id=draft_commit, containment_edge_types=[]),
        svc.diff_pr(pr_id=closed_mr),
        svc.diff_pr_summary(pr_id=closed_mr, containment_edge_types=[]),
    ]
    for read in refused:
        with pytest.raises(DraftPruned) as gone:
            await read
        assert gone.value.status_code == 410 and gone.value.detail["type"] == "draft_pruned"

    # main, its history and the review's merge read as they did.
    assert (await svc.materialize_state(graph_id=gid, branch_id=main))["nodes"] == main_before
    assert [c["commit_id"] for c in await svc.commit_log(graph_id=gid, branch_id=main)] == log_before
    assert _counts(await svc.diff_pr(pr_id=mr)) == landed
    squash_summary = await svc.diff_commit_summary(graph_id=gid, commit_id=squash,
                                                   containment_edge_types=[])
    assert squash_summary["counts"] == summary["counts"]
    # Its change list, for one too large for a diff: main between the commit's seq - 1 and it.
    seq = (await svc.get_pr(mr))["resulting_commit_seq"]
    listed = await svc.change_summary(graph_id=gid, origin=ChangeOrigin(from_seq=seq - 1, to_seq=seq),
                                      containment_edge_types=[])
    assert listed["listed"] == 2, listed
    with pytest.raises(DraftPruned):
        await svc.change_summary(graph_id=gid, origin=ChangeOrigin(branch_id=merged),
                                 containment_edge_types=[])

    # Run again: nothing more is due.
    assert await svc.prune_closed_drafts(older_than_days=30, now=later, graph_id=gid) == []

    # Another worker's window took the rows this one's first window looked for: it deleted
    # nothing, and the rows after them are still there.
    raced = await svc.open_draft(graph_id=gid, owner="alice")
    await svc.apply_ops(graph_id=gid, branch_id=raced, actor="alice", message="race",
                        ops=[_upd("K", description="raced")])
    await svc.abandon_draft(graph_id=gid, branch_id=raced, actor="alice")
    real, windows = purge_worker.delete_window, []

    async def the_first_finds_nothing(s, table, *args, **kwargs):
        windows.append(table)
        return 0 if len(windows) == 1 else await real(s, table, *args, **kwargs)
    monkeypatch.setattr(purge_worker, "delete_window", the_first_finds_nothing)
    assert await svc.prune_closed_drafts(older_than_days=30, now=later, graph_id=gid) == [raced]
    assert await _rows(gid, raced) == {t: 0 for t, _o in _DRAFT_ROWS}
    assert windows.count(_DRAFT_ROWS[0][0]) >= 3, windows


def test_a_closed_draft_keeps_its_record_and_loses_its_changes_after_the_window(monkeypatch):
    async def run():
        await models.create_schema_and_partitions()
        try:
            await _cases(GraphVersioningService(), monkeypatch)
        finally:
            await db.dispose_engine()
    asyncio.run(run())
