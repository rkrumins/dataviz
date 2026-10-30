"""A fork of a graph of millions costs what changes in it, not the graph — needs Postgres.

A fork copies no rows: its ``main`` reads its parent's at the fork point for what it has not
changed. Forking hashed every entity of the parent for the fork point's fingerprint, under the
parent's lock, and every commit on the fork hashed its whole state again, for a fingerprint nothing
reads. The fork point carries the root the parent stored at its head instead, and a commit on the
fork none, as a draft's.

Every other read of a fork's ``main`` went through the parent's whole state too (``_state_as_of``,
``_composed_state``), since the bounded reads saw only the fork's own rows: each save to a draft
on the fork, its preview, pull, publish and diffs, and a revert or restore of the fork's ``main``.
Those paths run here with the whole-state reads refused, and must still give the right answer.
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
