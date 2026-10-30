"""A fork of a graph of millions costs what changes in it, not the graph — needs Postgres.

A fork copies no rows: its ``main`` reads its parent's at the fork point for what it has not
changed. Forking hashed every entity of the parent for the fork point's fingerprint, under the
parent's lock, and every commit on the fork hashed its whole state again, for a fingerprint nothing
reads. The fork point carries the root the parent stored at its head instead, and a commit on the
fork none, as a draft's.

Every other read of a fork's ``main`` went through the parent's whole state too (``_state_as_of``,
``_composed_state``), since the bounded reads saw only the fork's own rows: each save to a draft
on the fork, its preview, pull, publish and diffs, and a revert or restore of the fork's ``main``;
and every review of the fork: opening it, its preview, diff and summary, and the merge composed
three whole states, the parent's under its lock. A review now merges what the fork changed since
the last one, with the parent's edges on what it deletes and the ends of what it draws. Those paths
run here with the whole-state reads refused, and must still give the right answer — on a fork, and
on a fork of a fork, which reads and merges through both.
"""
import asyncio
import contextlib
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.models import BranchORM, CommitORM
from backend.app.services.versioning.service import GraphVersioningService
from backend.tests.integration.test_versioning_bounded_reads import _del, _edge, _node, _upd

pytestmark = [pytest.mark.integration, pytest.mark.skipif(
    not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")]

N = 120          # baseline nodes; edges N0->N1 … N59->N60; S contains N0 … N9
CONT = ["CONTAINS"]
WHOLE = ("_state_as_of", "_composed_state", "_composed_state_as_of")


@contextlib.contextmanager
def _refused(*names):
    """Each of ``names`` — a read of a branch's whole state — raises, naming the graph it read."""
    saved = {n: getattr(GraphVersioningService, n) for n in names}

    def refuse(name):
        async def _refused_read(self, s, graph_id, *a, **k):
            raise AssertionError(f"{name} read the whole of graph {graph_id}")
        return _refused_read

    for n in names:
        setattr(GraphVersioningService, n, refuse(n))
    try:
        yield
    finally:
        for n, f in saved.items():
            setattr(GraphVersioningService, n, f)


async def _draft(svc, gid, owner, ops):
    d = await svc.open_draft(graph_id=gid, owner=owner)
    await svc.stage_changes(graph_id=gid, branch_id=d, actor=owner, ops=ops)
    await svc.checkpoint(graph_id=gid, branch_id=d, actor=owner, containment_edge_types=CONT)
    return d


async def _publish(svc, gid, actor, ops, msg):
    d = await svc.open_draft(graph_id=gid, owner=actor)
    await svc.stage_changes(graph_id=gid, branch_id=d, actor=actor, ops=ops)
    await svc.checkpoint(graph_id=gid, branch_id=d, actor=actor, containment_edge_types=CONT)
    return await svc.publish(graph_id=gid, branch_id=d, actor=actor, message=msg,
                             containment_edge_types=CONT)


async def _parent(svc):
    g = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                               actor="alice")
    await _publish(svc, g["graph_id"], "alice",
                   [_node(f"N{i}") for i in range(N)] + [_node("S")]
                   + [_edge(f"E{i}", f"N{i}", f"N{i + 1}") for i in range(60)]
                   + [_edge(f"C{i}", "S", f"N{i}", "CONTAINS") for i in range(10)], "baseline")
    return g["graph_id"], g["main_branch_id"]


async def _root(gid, cid):
    async with db.graphver_session() as s:
        return (await s.get(CommitORM, (gid, cid))).merkle_root


async def _head(bid):
    async with db.graphver_session() as s:
        return (await s.get(BranchORM, bid)).head_commit_id


async def _forking_builds_no_whole_graph_fingerprint(svc):
    pg, pmain = await _parent(svc)
    fork = await svc.fork_graph(parent_graph_id=pg, workspace_id="ws1", actor="bob")
    fg, fmain = fork["graph_id"], fork["main_branch_id"]
    point = await _head(fmain)
    cid = await _publish(svc, fg, "bob", [_upd("N1", "one"), _node("X")], "fork work")
    # The fork point is the parent's head: it carries the root the parent stored there. A commit
    # on the fork carries none, as a draft's: nothing reads a fork's.
    parents = await _root(pg, await _head(pmain))
    assert parents is not None and await _root(fg, point) == parents
    assert await _root(fg, cid) is None


async def _values(svc, gid, bid, ids):
    async with db.graphver_session() as s:
        return await svc._current_values(s, gid, bid, ids)


async def _a_forks_drafts_read_only_what_they_change(svc):
    pg, pmain = await _parent(svc)
    with _refused(*WHOLE):
        fork = await svc.fork_graph(parent_graph_id=pg, workspace_id="ws1", actor="bob")
        fg, fmain = fork["graph_id"], fork["main_branch_id"]
        # A save on the fork: an entity it inherits is updated, not created, and a delete takes
        # the parent's edges on it (E49, E50).
        a = await _draft(svc, fg, "bob", [_upd("N1", "one"), _node("X"), _edge("EX", "X", "N2"),
                                          _del("N50")])
        b = await _draft(svc, fg, "dave", [_upd("N100", "hundred")])
        await svc.publish(graph_id=fg, branch_id=b, actor="dave", message="dave's",
                          containment_edge_types=CONT)
        # The publish dialog's preview, the canvas's overlay and diff, then pull latest.
        pv = await svc.preview_merge(graph_id=fg, branch_id=a)
        assert pv["clean"] and pv["changes"] == {"create": 2, "update": 1, "delete": 3}, pv
        overlay = await svc.branch_overlay_delta(graph_id=fg, branch_id=a)      # main's N100 rewound
        rewound = {n.get("entityId"): n for n in overlay["nodesUpsert"]}["N100"]
        assert rewound["displayName"] == "N100 name", overlay
        diff = await svc.diff_branch_vs_base(graph_id=fg, branch_id=a)
        assert {e["entityId"] for e in diff["removed"]} == {"N50", "E49", "E50"}, diff
        pulled = await svc.rebase_draft(graph_id=fg, branch_id=a, actor="bob")
        assert pulled["clean"], pulled
        mine = await svc.publish(graph_id=fg, branch_id=a, actor="bob", message="bob's",
                                 containment_edge_types=CONT)
        head = (await svc.get_graph(fg))["main_head_commit_seq"]
        changes = await svc.diff_commits(graph_id=fg, branch_id=fmain, from_seq=head - 1,
                                         to_seq=head)
        assert changes == {"added": ["EX", "X"], "removed": ["E49", "E50", "N50"],
                           "modified": {"N1": {"displayName": ("N1 name", "one")}}}, changes
        # Undo the publish, then bring the fork back to it.
        await svc.revert_commit(graph_id=fg, commit_id=mine, actor="bob")
        undone = await _values(svc, fg, fmain, ["N1", "X", "N50", "E49"])
        assert undone["N1"]["displayName"] == "N1 name" and undone["X"] is None, undone
        assert undone["N50"] is not None and undone["E49"] is not None, undone
        rp = await svc.restore_preview(graph_id=fg, commit_id=mine)
        assert rp["nodes"]["create"] == 1 and rp["nodes"]["delete"] == 1, rp      # X back; N50 gone
        await svc.restore_to_commit(graph_id=fg, commit_id=mine, actor="bob")

    now = await _values(svc, fg, fmain, ["N1", "X", "EX", "N50", "E49", "E50", "N100", "N2"])
    assert now["N1"]["displayName"] == "one" and now["X"] and now["EX"], now
    assert now["N50"] is None and now["E49"] is None and now["E50"] is None, now
    assert now["N100"]["displayName"] == "hundred" and now["N2"]["displayName"] == "N2 name", now
    parent = await _values(svc, pg, pmain, ["N1", "X", "N50", "E49"])
    assert parent["N1"]["displayName"] == "N1 name" and "X" not in parent, parent
    assert parent["N50"] is not None and parent["E49"] is not None, parent


async def _a_fork_review_reads_only_what_the_fork_changed(svc):
    pg, pmain = await _parent(svc)
    with _refused(*WHOLE):
        fg = (await svc.fork_graph(parent_graph_id=pg, workspace_id="ws1", actor="bob"))["graph_id"]
        await _publish(svc, fg, "bob", [_upd("N1", "one"), _node("X"), _edge("EX", "X", "N2"),
                                        _del("N50")], "fork work")
        # The parent moves on: an edge onto N50, which the fork deleted, and N3 deleted, which the
        # fork then draws an edge to.
        await _publish(svc, pg, "alice", [_upd("N100", "hundred"), _edge("EP", "N51", "N50"),
                                          _del("N3")], "parent work")
        await _publish(svc, fg, "bob", [_edge("EY", "X", "N3")], "fork edge")

        pr = await svc.open_pr(source_graph_id=fg, actor="bob")
        # The merge's cascade, seen in its preview: EP goes with N50, EY with N3.
        pv = await svc.preview_pr(pr_id=pr)
        assert pv["clean"] and pv["changes"] == {"create": 2, "update": 1, "delete": 4}, pv
        assert (await svc.preview_mr(mr_id=pr))["changes"] == pv["changes"]
        diff = await svc.diff_pr(pr_id=pr)
        assert {e["entityId"] for e in diff["added"]} == {"X", "EX"}, diff
        assert {e["entityId"] for e in diff["modified"]} == {"N1"}, diff
        assert {e["entityId"] for e in diff["removed"]} == {"N50", "E49", "E50", "EP"}, diff
        summary = await svc.diff_pr_summary(pr_id=pr, containment_edge_types=CONT)
        assert summary["counts"] == {"added": 2, "modified": 1, "removed": 4}, summary
        assert [g["counts"] for g in summary["groups"] if g["key"] == "S"] == [
            {"added": 0, "modified": 1, "removed": 0}], summary       # N1, under its container
        assert await svc.merge_pr(pr_id=pr, actor="carol", message="bob's",
                                  containment_edge_types=CONT)

        # The next review merges what changed since.
        await _publish(svc, fg, "bob", [_upd("N60", "sixty")], "more fork work")
        again = await svc.open_pr(source_graph_id=fg, actor="bob")
        assert (await svc.preview_pr(pr_id=again))["changes"] == {
            "create": 0, "update": 1, "delete": 0}
        assert await svc.merge_pr(pr_id=again, actor="carol", message="bob's again")

    now = await _values(svc, pg, pmain, ["N1", "X", "EX", "N50", "E49", "EP", "N3", "EY", "N100",
                                         "N60", "N2"])
    assert now["N1"]["displayName"] == "one" and now["X"] and now["EX"], now
    assert now["N50"] is None and now["E49"] is None and now["EP"] is None, now
    assert now["N3"] is None and "EY" not in now, now
    assert now["N100"]["displayName"] == "hundred" and now["N60"]["displayName"] == "sixty", now
    assert now["N2"]["displayName"] == "N2 name", now


async def _a_fork_of_a_fork_reads_and_merges_through_both(svc):
    pg, _pmain = await _parent(svc)
    with _refused(*WHOLE):
        fg = (await svc.fork_graph(parent_graph_id=pg, workspace_id="ws1", actor="bob"))["graph_id"]
        fmain = await svc.main_branch_id(fg)
        await _publish(svc, fg, "bob", [_upd("N1", "one")], "the fork's")
        gg = (await svc.fork_graph(parent_graph_id=fg, workspace_id="ws1", actor="dave"))["graph_id"]
        gmain = await svc.main_branch_id(gg)
        # A delete on the grandchild takes the grandparent's edges on N5, two layers up: E4, E5
        # and its containment link C5.
        await _publish(svc, gg, "dave", [_upd("N2", "two"), _del("N5")], "the fork's fork's")
        seen = await _values(svc, gg, gmain, ["N1", "N2", "N3", "N5", "E4", "E5", "C5"])
        assert seen["N1"]["displayName"] == "one" and seen["N2"]["displayName"] == "two", seen
        assert seen["N3"]["displayName"] == "N3 name", seen                   # the grandparent's
        assert seen["N5"] is None and seen["E4"] is None and seen["E5"] is None, seen
        assert seen["C5"] is None, seen
        pr = await svc.open_pr(source_graph_id=gg, actor="dave")
        assert (await svc.preview_pr(pr_id=pr))["changes"] == {"create": 0, "update": 1, "delete": 4}
        assert await svc.merge_pr(pr_id=pr, actor="bob", message="into the fork")
    now = await _values(svc, fg, fmain, ["N1", "N2", "N5", "E4", "E5", "C5"])
    assert now["N1"]["displayName"] == "one" and now["N2"]["displayName"] == "two", now
    assert now["N5"] is None and now["E4"] is None and now["E5"] is None and now["C5"] is None, now


async def _run(case) -> None:
    await models.create_schema_and_partitions()
    try:
        await case(GraphVersioningService())
    finally:
        await db.dispose_engine()


def test_forking_builds_no_whole_graph_fingerprint():
    asyncio.run(_run(_forking_builds_no_whole_graph_fingerprint))


def test_a_forks_drafts_read_only_what_they_change():
    asyncio.run(_run(_a_forks_drafts_read_only_what_they_change))


def test_a_fork_review_reads_only_what_the_fork_changed():
    asyncio.run(_run(_a_fork_review_reads_only_what_the_fork_changed))


def test_a_fork_of_a_fork_reads_and_merges_through_both():
    asyncio.run(_run(_a_fork_of_a_fork_reads_and_merges_through_both))
