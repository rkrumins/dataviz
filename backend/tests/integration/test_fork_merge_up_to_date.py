"""A fork merges into its parent only up to date with it — Postgres and FalkorDB.

A fork's review merges only when the base the fork reads at its head is the parent's head (409
``not_up_to_date``, ``reason: parent_moved``, otherwise): Update from parent settles conflicts on
the fork's side, so the merge is a copy of the fork's own changes — its rows since its last merged
review, each its value at the head the merge took against the parent's, every difference a
change. So a change the fork took from its parent is never proposed back, a fork edit made before
an update is still proposed after it, and a conflict settled in an update is not raised again at
the merge. Its own merge is not the parent's change for the fork's next update: what the review
landed is what both sides agree on. Planned from content hashes and copied from the fork's rows
inside Postgres, a page at a time past ``GRAPHVER_SQUASH_PAGED_ABOVE``.
"""
import os

import pytest

from backend.app.services.versioning.errors import ForkNotUpToDate, ForkUpdateConflicts
from backend.tests.integration.test_fork_overlay_delta import _d, _e, _fork, _n, _run, _u, _ue
from backend.tests.integration.test_fork_update import _agrees, _projected, _state

pytestmark = [pytest.mark.integration, pytest.mark.skipif(
    not os.getenv("GRAPHVER_E2E") or os.getenv("RUN_FALKOR_LIVE") != "1",
    reason="set GRAPHVER_E2E=1 and RUN_FALKOR_LIVE=1 with FalkorDB reachable")]


async def _merge(svc, root, fgid, message="merge"):
    """Open the fork's review and merge it; the parent projected again, as the merge nudges it."""
    pr = await svc.open_pr(source_graph_id=fgid, actor="bob")
    commit = await svc.merge_pr(pr_id=pr, actor="carol", message=message)
    result = await root.projector.project_graph(root.gid)
    assert not result.get("verify_error"), result
    return pr, commit


async def _written(svc, gid, commit_id):
    """The entities a commit wrote rows for."""
    from sqlalchemy import select

    from backend.app.services.versioning import db
    from backend.app.services.versioning.models import EdgeVersionORM, NodeVersionORM
    async with db.graphver_session() as s:
        return sorted([eid for m in (NodeVersionORM, EdgeVersionORM) for eid in (await s.execute(
            select(m.entity_id).where(m.graph_id == gid, m.commit_id == commit_id))).scalars()])


def test_a_fork_behind_its_parent_merges_once_it_has_updated():
    async def case(svc):
        async with _projected(svc) as root:
            gid = await root.make([_n("A"), _n("B")])
            fgid, fmain = await _fork(svc, gid)
            await svc.apply_ops(graph_id=fgid, actor="bob", message="own", ops=[_u("A", "A fork")])
            await root.edit([_u("B", "B parent"), _n("C")])
            pr = await svc.open_pr(source_graph_id=fgid, actor="bob")
            with pytest.raises(ForkNotUpToDate) as exc:
                await svc.merge_pr(pr_id=pr, actor="carol", message="too soon")
            assert exc.value.detail == {
                "type": "not_up_to_date", "reason": "parent_moved", "behind": 2, "graphId": fgid,
                "message": "This fork's parent has changed since the fork last took its changes: "
                           "update from parent first."}
            assert (await svc.get_pr(pr))["status"] == "mergeable"     # nothing marked on it
            await svc.update_fork_from_parent(fork_graph_id=fgid, actor="bob")
            commit = await svc.merge_pr(pr_id=pr, actor="carol", message="merged")
            await root.projector.project_graph(gid)
            pmain = await svc.main_branch_id(gid)
            assert (await _state(svc, gid, pmain))[0] == {"A": "A fork", "B": "B parent", "C": "C"}
            assert await _written(svc, gid, commit) == ["A"]
            meta = await svc.get_pr(pr)
            assert (meta["status"], meta["resulting_commit_id"]) == ("merged", commit)
            # Merged, the fork is up to date with what it merged: nothing behind, and it reads the
            # same through its overlay.
            listed = {f["graph_id"]: f for f in await svc.list_forks(graph_id=gid, workspace_id="ws1",
                                                                     limit=10)}
            assert listed[fgid]["behind"] == 0 and listed[fgid]["ahead"] == 0
            # An update takes nothing then: it only moves the base the fork reads to the one it
            # agrees with, past its merge — a commit with no rows — and is up to date after.
            out = await svc.update_fork_from_parent(fork_graph_id=fgid, actor="bob")
            assert (out["wrote"], out["parent_seq"], out["up_to_date"]) == (
                0, (await svc.get_graph(gid))["main_head_commit_seq"], False)
            assert (await svc.update_fork_from_parent(fork_graph_id=fgid, actor="bob"))["up_to_date"]
            await _agrees(root, fgid, fmain, {"A", "B", "C"})
    _run(case)


def test_a_change_taken_from_the_parent_is_never_proposed_back():
    async def case(svc):
        async with _projected(svc) as root:
            gid = await root.make([_n("A"), _n("B"), _e("ab", "A", "B")])
            fgid, _fmain = await _fork(svc, gid)
            await svc.apply_ops(graph_id=fgid, actor="bob", message="own", ops=[_u("A", "A fork")])
            # The parent changes A elsewhere, B, an edge, and makes X: all taken in by the update,
            # A merged with the fork's own change to it.
            await root.edit([_u("A", "A", note="parent"), _u("B", "B parent"), _ue("ab", "A", "B", w=1),
                             _n("X")])
            out = await svc.update_fork_from_parent(fork_graph_id=fgid, actor="bob")
            assert out["wrote"] == 1
            pr = await svc.open_pr(source_graph_id=fgid, actor="bob")
            diff = await svc.diff_pr(pr_id=pr)
            assert ([m["entityId"] for m in diff["modified"]], diff["added"], diff["removed"]) == (
                ["A"], [], [])
            assert diff["modified"][0]["after"]["properties"] == {"note": "parent"}
            commit = await svc.merge_pr(pr_id=pr, actor="carol", message="merged")
            assert await _written(svc, gid, commit) == ["A"]
            pmain = await svc.main_branch_id(gid)
            nodes = (await svc.materialize_state(graph_id=gid, branch_id=pmain))["nodes"]
            assert (nodes["A"]["displayName"], nodes["A"]["properties"]) == ("A fork", {"note": "parent"})
    _run(case)


def test_a_fork_edit_made_before_an_update_is_still_proposed_after_it():
    async def case(svc):
        async with _projected(svc) as root:
            gid = await root.make([_n("A"), _n("B")])
            fgid, _fmain = await _fork(svc, gid)
            await svc.apply_ops(graph_id=fgid, actor="bob", message="own",
                                ops=[_n("C"), _u("A", "A fork"), _d("B")])
            await root.edit([_n("P")])
            assert (await svc.update_fork_from_parent(fork_graph_id=fgid, actor="bob"))["wrote"] == 0
            pr, commit = await _merge(svc, root, fgid)
            assert await _written(svc, gid, commit) == ["A", "B", "C"]
            pmain = await svc.main_branch_id(gid)
            assert (await _state(svc, gid, pmain))[0] == {"A": "A fork", "C": "C", "P": "P"}
    _run(case)


def test_a_conflict_settled_in_an_update_is_not_raised_again_at_the_merge_or_the_next_update():
    async def case(svc):
        async with _projected(svc) as root:
            gid = await root.make([_n("A"), _n("B"), _n("D")])
            fgid, fmain = await _fork(svc, gid)
            await svc.apply_ops(graph_id=fgid, actor="bob", message="own", ops=[_u("A", "A fork")])
            await root.edit([_u("A", "A parent")])
            with pytest.raises(ForkUpdateConflicts) as exc:
                await svc.update_fork_from_parent(fork_graph_id=fgid, actor="bob")
            await svc.update_fork_from_parent(fork_graph_id=fgid, actor="bob", resolutions={
                "A": {**exc.value.seeds["A"], "displayName": "A both"}})
            pr, _commit = await _merge(svc, root, fgid)
            pmain = await svc.main_branch_id(gid)
            assert (await _state(svc, gid, pmain))[0]["A"] == "A both"

            # After the merge the fork changes A again, and the parent B: no conflict on A — the
            # merge is not a change of the parent's the fork has to take.
            await svc.apply_ops(graph_id=fgid, actor="bob", message="more", ops=[_u("A", "A again")])
            await root.edit([_u("B", "B parent")])
            assert (await svc.update_fork_from_parent(fork_graph_id=fgid, actor="bob"))["wrote"] == 0
            # The parent changes what the fork merged, and the fork does not: the parent's is taken.
            pr2, _ = await _merge(svc, root, fgid, "second")
            await root.edit([_u("A", "A later")])
            assert (await svc.update_fork_from_parent(fork_graph_id=fgid, actor="bob"))["wrote"] == 1
            assert (await _agrees(root, fgid, fmain, {"A", "B", "D"}))[0] == {
                "A": "A later", "B": "B parent", "D": "D"}
            # Both change it after that: a conflict, as it is.
            await svc.apply_ops(graph_id=fgid, actor="bob", message="mine", ops=[_u("A", "A mine")])
            await root.edit([_u("A", "A theirs")])
            with pytest.raises(ForkUpdateConflicts):
                await svc.update_fork_from_parent(fork_graph_id=fgid, actor="bob")
    _run(case)


def test_a_merge_takes_the_head_it_pinned_and_the_next_review_the_rest():
    async def case(svc):
        async with _projected(svc) as root:
            gid = await root.make([_n("A")])
            fgid, _fmain = await _fork(svc, gid)
            await svc.apply_ops(graph_id=fgid, actor="bob", message="first", ops=[_n("F1")])
            pinned = (await svc.get_graph(fgid))["main_head_commit_seq"]
            await svc.apply_ops(graph_id=fgid, actor="bob", message="later", ops=[_n("F2")])
            pr = await svc.open_pr(source_graph_id=fgid, actor="bob")
            commit = await svc.merge_pr(pr_id=pr, actor="carol", message="m", pinned_seq=pinned)
            assert await _written(svc, gid, commit) == ["F1"]
            from sqlalchemy import select

            from backend.app.services.versioning import db
            from backend.app.services.versioning.models import MergeRequestORM
            async with db.graphver_session() as s:
                assert (await s.scalar(select(MergeRequestORM.merged_source_seq).where(
                    MergeRequestORM.id == pr))) == pinned
            await root.projector.project_graph(gid)
            pr2, commit2 = await _merge(svc, root, fgid, "rest")
            assert await _written(svc, gid, commit2) == ["F2"]
    _run(case)


def test_a_large_review_is_merged_a_page_at_a_time_as_one_commit(monkeypatch):
    """Paged, the merge writes what it writes in one go: the same rows, one commit, the cascade
    and the integrity checks across pages."""
    from backend.app.services.versioning import config

    async def case(svc):
        async with _projected(svc) as root:
            gid = await root.make([_n("A"), _n("B"), _n("C"), _e("ab", "A", "B"), _e("bc", "B", "C")])
            fgid, fmain = await _fork(svc, gid)
            await svc.apply_ops(graph_id=fgid, actor="bob", message="own", ops=[
                _n("N1"), _n("N2"), _n("N3"), _u("A", "A fork"), _d("C"),
                _e("n1a", "N1", "A"), _e("n2n3", "N2", "N3"), _ue("ab", "A", "B", w=2)])
            fork_state = await _state(svc, fgid, fmain)
            monkeypatch.setattr(config, "SQUASH_PAGED_ABOVE", 2)
            monkeypatch.setattr(config, "SQUASH_PAGE", 2)
            pr, commit = await _merge(svc, root, fgid)
            pmain = await svc.main_branch_id(gid)
            assert await _state(svc, gid, pmain) == fork_state
            assert await _written(svc, gid, commit) == ["A", "C", "N1", "N2", "N3", "ab", "bc",
                                                        "n1a", "n2n3"]
            log = [c for c in await svc.commit_log(graph_id=gid, branch_id=pmain)
                   if c["kind"] == "squash_publish"]
            assert [c["commit_id"] for c in log] == [commit]
            assert log[0]["stats"] == {"create": 5, "update": 2, "delete": 2}
    _run(case)


async def _misfiled_delete(svc, fgid, eid):
    """A commit on the fork's main that deleted the parent's edge ``eid`` but filed it under
    ``node_versions`` — what a revert or restore across an update wrote before it was refused."""
    from backend.app.services.versioning import db
    from backend.app.services.versioning.changeset import Delta
    from backend.app.services.versioning.merkle import content_hash
    from backend.app.services.versioning.models import BranchORM, CommitORM, GraphORM
    async with db.graphver_session() as s:
        await svc._lock_graph(s, fgid)
        fork = await s.get(GraphORM, fgid)
        fmain = await svc._main_branch_id(s, fgid)
        main = await s.get(BranchORM, fmain)
        held = (await svc._hashes_at(s, fgid, fmain, [eid], fork.main_head_commit_seq))[eid]
        seq = fork.main_head_commit_seq + 1
        commit = CommitORM(graph_id=fgid, branch_id=fmain, commit_seq=seq,
                           parent_commit_id=main.head_commit_id, kind="edit",
                           message="a delete filed under nodes", actor="bob")
        s.add(commit)
        await s.flush()
        await svc._write_deltas(s, fgid, fmain, commit,
                                [Delta(eid, "delete", None, held.content_hash, content_hash(None))],
                                {eid: "node"}, "bob")
        main.head_commit_id = commit.id
        fork.main_head_commit_seq = seq


def test_a_merged_edge_delete_lands_in_edge_versions_on_the_parent():
    """The parent's delete takes the parent's own kind for what it deletes, never the fork's head's:
    an edge's tombstone goes to ``edge_versions``, where the parent reads the edge."""
    async def case(svc):
        from sqlalchemy import select

        from backend.app.services.versioning import db
        from backend.app.services.versioning.models import EdgeVersionORM

        async with _projected(svc) as root:
            gid = await root.make([_n("A"), _n("B"), _e("ab", "A", "B")])
            fgid, _fmain = await _fork(svc, gid)
            await _misfiled_delete(svc, fgid, "ab")
            pr, commit = await _merge(svc, root, fgid)
            async with db.graphver_session() as s:
                assert (await s.scalar(select(EdgeVersionORM.op).where(
                    EdgeVersionORM.graph_id == gid, EdgeVersionORM.commit_id == commit))) == "delete"
            pmain = await svc.main_branch_id(gid)
            assert (await _state(svc, gid, pmain))[1] == {}
    _run(case)


def test_a_drafts_review_is_not_merged_as_a_forks(monkeypatch):
    """A draft's review sent to the fork merge is refused at once, as unknown to it, before any
    count of how far behind anything is."""
    async def case(svc):
        from backend.tests.integration.test_fork_overlay_delta import _graph

        gid = await _graph(svc, [_n("A")])
        draft = await svc.open_draft(graph_id=gid, owner="bob")
        await svc.apply_ops(graph_id=gid, branch_id=draft, actor="bob", message="d",
                            ops=[_u("A", "A draft")])
        mr = await svc.open_draft_mr(graph_id=gid, branch_id=draft, actor="bob")

        async def counted(*_a, **_k):
            raise AssertionError("counted a window")
        monkeypatch.setattr(svc, "_window_count", counted)
        with pytest.raises(ValueError, match="not a fork"):
            await svc.merge_pr(pr_id=mr, actor="carol", message="m")
    _run(case)
