"""A fork reads its parent at the base each of its commits took — needs Postgres.

``fork_bases`` holds, per fork, the parent seq its ``main`` reads from each fork seq on: one row
at the fork point, and (with Update from parent) one per update. A read of the fork at seq S
composes its parent at the ``parent_seq`` of the latest row at or before S, or at S before the
first. These cases write a second row directly, as an update will, and check that every read
follows it — the whole state, the heads, the bounded values, what changed in a window — that a
read at an earlier seq is unchanged by it and a restore to before it refused, and that a fork of a
fork reads through both. A fork forked before the table, with no row, still reads at its fork point.
"""
import asyncio
import os

import pytest
from sqlalchemy import delete, select

from backend.app.services.versioning import db, models
from backend.app.services.versioning.errors import CrossesUpdate
from backend.app.services.versioning.models import CommitORM, ForkBaseORM, GraphORM
from backend.app.services.versioning.service import GraphVersioningService
from backend.tests.integration.test_versioning_bounded_reads import _node, _upd

pytestmark = [pytest.mark.integration, pytest.mark.skipif(
    not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")]


async def _publish(svc, gid, actor, ops, msg):
    d = await svc.open_draft(graph_id=gid, owner=actor)
    await svc.stage_changes(graph_id=gid, branch_id=d, actor=actor, ops=ops)
    await svc.checkpoint(graph_id=gid, branch_id=d, actor=actor)
    await svc.publish(graph_id=gid, branch_id=d, actor=actor, message=msg)
    return (await svc.get_graph(gid))["main_head_commit_seq"]


async def _take_base(fork_id, fork_seq, parent_seq):
    """What Update from parent will write: from ``fork_seq`` on, the fork reads its parent at
    ``parent_seq``."""
    async with db.graphver_session() as s:
        s.add(ForkBaseORM(fork_graph_id=fork_id, fork_seq=fork_seq, parent_seq=parent_seq,
                          created_by="test"))


async def _read(svc, method, gid, bid, *args):
    async with db.graphver_session() as s:
        return await getattr(svc, method)(s, gid, bid, *args)


def _names(state):
    return {eid: (p or {}).get("displayName") for eid, p in state.items() if p is not None}


async def _a_second_base_moves_what_the_fork_reads_from_its_seq_on(svc):
    pg = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                                 actor="alice"))["graph_id"]
    pmain = await svc.main_branch_id(pg)
    p1 = await _publish(svc, pg, "alice", [_node("A", "one")], "A")
    fork = await svc.fork_graph(parent_graph_id=pg, workspace_id="ws1", actor="bob")
    fg, fmain = fork["graph_id"], fork["main_branch_id"]
    async with db.graphver_session() as s:                       # fork_graph wrote the fork point
        rows = (await s.execute(select(ForkBaseORM.fork_seq, ForkBaseORM.parent_seq,
                                       ForkBaseORM.created_by)
                                .where(ForkBaseORM.fork_graph_id == fg))).all()
    assert rows == [(p1, p1, "bob")], rows
    await _publish(svc, pg, "alice", [_upd("A", "two")], "A two")
    p3 = await _publish(svc, pg, "alice", [_node("B")], "B")
    f2 = await _publish(svc, fg, "bob", [_node("C")], "C")
    assert p1 < f2 < p3              # the parent read at f2 instead of p3 would have no B

    # Before the second base: the fork point is all the fork sees of its parent.
    assert _names(await _read(svc, "_state_as_of", fg, fmain, f2)) == {"A": "one", "C": "C name"}
    assert await _read(svc, "_changed_in_window", fg, fmain, p1, f2) == {"C"}
    before = {seq: await _read(svc, "_state_as_of", fg, fmain, seq) for seq in (0, p1)}

    await _take_base(fg, f2, p3)
    async with db.graphver_session() as s:
        assert await svc._layers(s, fg, fmain, f2) == [(fg, fmain, f2), (pg, pmain, p3)]
        assert await svc._layers(s, fg, fmain, p1) == [(fg, fmain, p1), (pg, pmain, p1)]
        # Before the fork point, a fork is its parent's history.
        assert await svc._layers(s, fg, fmain, 0) == [(fg, fmain, 0), (pg, pmain, 0)]

    # From the second base on, the fork reads its parent at p3: the whole state, the heads, the
    # bounded values; and what changed across it includes what the parent changed in between.
    assert _names(await _read(svc, "_state_as_of", fg, fmain, f2)) == {
        "A": "two", "B": "B name", "C": "C name"}
    heads = await _read(svc, "_heads_as_of", fg, fmain, f2)
    assert {eid: h[1] for eid, h in heads.items()} == {"A": pg, "B": pg, "C": fg}, heads
    values = await _read(svc, "_values_at", fg, fmain, ["A", "B", "C"], f2)
    assert _names(values) == {"A": "two", "B": "B name", "C": "C name"}, values
    assert await _read(svc, "_changed_in_window", fg, fmain, p1, f2) == {"A", "B", "C"}
    assert await _read(svc, "_changed_in_window", fg, fmain, f2, f2) == set()
    async with db.graphver_session() as s:
        assert await svc._count_changed_in_window(s, fg, fmain, p1, f2) == 3

    # Before it, nothing moved: a read at an earlier seq, the heads and values there, time travel.
    for seq, state in before.items():
        assert await _read(svc, "_state_as_of", fg, fmain, seq) == state, seq
    assert _names(before[p1]) == {"A": "one"}
    heads = await _read(svc, "_heads_as_of", fg, fmain, p1)
    assert set(heads) == {"A"} and heads["A"][1] == pg, heads
    assert _names(await _read(svc, "_values_at", fg, fmain, ["A", "B", "C"], p1)) == {"A": "one"}
    old = await svc.materialize_state(graph_id=fg, branch_id=fmain, as_of_seq=p1)
    assert {eid: n["displayName"] for eid, n in old["nodes"].items()} == {"A": "one"}, old

    # A restore to the fork point is refused: from f2 on the fork reads its parent at p3, which no
    # commit of its own can take back — it would write the parent's older values as its own.
    async with db.graphver_session() as s:
        point = (await s.execute(select(CommitORM.id).where(
            CommitORM.graph_id == fg, CommitORM.commit_seq == p1))).scalar_one()
    with pytest.raises(CrossesUpdate):
        await svc.restore_preview(graph_id=fg, commit_id=point)
    with pytest.raises(CrossesUpdate):
        await svc.restore_to_commit(graph_id=fg, commit_id=point, actor="bob")
    now = await svc.materialize_state(graph_id=fg, branch_id=fmain)
    assert {eid: n["displayName"] for eid, n in now["nodes"].items()} == {
        "A": "two", "B": "B name", "C": "C name"}, now


async def _a_fork_of_a_fork_reads_through_both_bases(svc):
    pg = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                                 actor="alice"))["graph_id"]
    pmain = await svc.main_branch_id(pg)
    p1 = await _publish(svc, pg, "alice", [_node("A", "one")], "A")
    fg = (await svc.fork_graph(parent_graph_id=pg, workspace_id="ws1", actor="bob"))["graph_id"]
    fmain = await svc.main_branch_id(fg)
    gg = (await svc.fork_graph(parent_graph_id=fg, workspace_id="ws1", actor="dave"))["graph_id"]
    gmain = await svc.main_branch_id(gg)
    await _publish(svc, pg, "alice", [_upd("A", "two")], "A two")
    p3 = await _publish(svc, pg, "alice", [_node("B")], "B")
    f2 = await _publish(svc, fg, "bob", [_node("C")], "C")
    g2 = await _publish(svc, gg, "dave", [_node("D")], "D")
    await _take_base(fg, f2, p3)                     # the fork takes the parent's p3 at f2,
    await _take_base(gg, g2, f2)                     # and its fork takes the fork's f2 at g2

    async with db.graphver_session() as s:
        assert await svc._layers(s, gg, gmain, g2) == [(gg, gmain, g2), (fg, fmain, f2),
                                                       (pg, pmain, p3)]
        assert await svc._layers(s, gg, gmain, p1) == [(gg, gmain, p1), (fg, fmain, p1),
                                                       (pg, pmain, p1)]
    assert _names(await _read(svc, "_state_as_of", gg, gmain, g2)) == {
        "A": "two", "B": "B name", "C": "C name", "D": "D name"}
    assert _names(await _read(svc, "_state_as_of", gg, gmain, p1)) == {"A": "one"}
    heads = await _read(svc, "_heads_as_of", gg, gmain, g2)
    assert {eid: h[1] for eid, h in heads.items()} == {"A": pg, "B": pg, "C": fg, "D": gg}, heads
    assert _names(await _read(svc, "_values_at", gg, gmain, ["A", "B", "C", "D"], g2)) == {
        "A": "two", "B": "B name", "C": "C name", "D": "D name"}
    assert _names(await _read(svc, "_values_at", gg, gmain, ["A", "B", "C", "D"], p1)) == {
        "A": "one"}
    # The grandchild's window holds its own change, the fork's between its bases, and the
    # parent's between the fork's.
    assert await _read(svc, "_changed_in_window", gg, gmain, p1, g2) == {"A", "B", "C", "D"}


async def _a_fork_with_no_base_row_reads_at_its_fork_point(svc):
    pg = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                                 actor="alice"))["graph_id"]
    pmain = await svc.main_branch_id(pg)
    p1 = await _publish(svc, pg, "alice", [_node("A", "one")], "A")
    fg = (await svc.fork_graph(parent_graph_id=pg, workspace_id="ws1", actor="bob"))["graph_id"]
    fmain = await svc.main_branch_id(fg)
    await _publish(svc, pg, "alice", [_upd("A", "two")], "A two")
    f2 = await _publish(svc, fg, "bob", [_node("C")], "C")
    async with db.graphver_session() as s:                      # forked before the table
        await s.execute(delete(ForkBaseORM).where(ForkBaseORM.fork_graph_id == fg))
    async with db.graphver_session() as s:
        assert await svc._layers(s, fg, fmain, f2) == [(fg, fmain, f2), (pg, pmain, p1)]
        assert await svc._layers(s, fg, fmain, 0) == [(fg, fmain, 0), (pg, pmain, 0)]
        (await s.get(GraphORM, fg)).fork_base_commit_seq = None
    async with db.graphver_session() as s:                      # and with no fork point: genesis
        assert await svc._layers(s, fg, fmain, f2) == [(fg, fmain, f2), (pg, pmain, 0)]
    assert _names(await _read(svc, "_state_as_of", fg, fmain, f2)) == {"C": "C name"}


async def _the_genesis_commit_changed_nothing(svc):
    """A fork's genesis commit is its fork point: it changed nothing, whatever the parent's commit
    at that seq changed. Its drill-down (the window just before it to it) took the parent's
    commit at the base for the fork's, once the windows added the parent's between their bases;
    a window between two bases still holds the parent's changes."""
    pg = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                                 actor="alice"))["graph_id"]
    p1 = await _publish(svc, pg, "alice", [_node("A", "one"), _node("B")], "A and B")
    fork = await svc.fork_graph(parent_graph_id=pg, workspace_id="ws1", actor="bob")
    fg, fmain = fork["graph_id"], fork["main_branch_id"]
    async with db.graphver_session() as s:
        genesis = (await s.execute(select(CommitORM.id).where(
            CommitORM.graph_id == fg, CommitORM.commit_seq == p1))).scalar_one()
    summary = await svc.diff_commit_summary(graph_id=fg, commit_id=genesis,
                                            containment_edge_types=[])
    assert summary["groups"] == [] and summary["groupTotal"] == 0, summary
    assert await _read(svc, "_changed_in_window", fg, fmain, p1 - 1, p1) == set()
    async with db.graphver_session() as s:
        assert await svc._count_changed_in_window(s, fg, fmain, p1 - 1, p1) == 0

    p2 = await _publish(svc, pg, "alice", [_upd("A", "two")], "A two")
    f2 = await _publish(svc, fg, "bob", [_node("C")], "C")
    await _take_base(fg, f2, p2)
    assert await _read(svc, "_changed_in_window", fg, fmain, p1, f2) == {"A", "C"}
    assert await _read(svc, "_changed_in_window", fg, fmain, p1 - 1, f2) == {"A", "C"}

async def _run(case) -> None:
    await models.create_schema_and_partitions()
    try:
        await case(GraphVersioningService())
    finally:
        await db.dispose_engine()


def test_a_second_base_moves_what_the_fork_reads_from_its_seq_on():
    asyncio.run(_run(_a_second_base_moves_what_the_fork_reads_from_its_seq_on))


def test_a_fork_of_a_fork_reads_through_both_bases():
    asyncio.run(_run(_a_fork_of_a_fork_reads_through_both_bases))


def test_a_fork_with_no_base_row_reads_at_its_fork_point():
    asyncio.run(_run(_a_fork_with_no_base_row_reads_at_its_fork_point))


def test_the_genesis_commit_changed_nothing():
    asyncio.run(_run(_the_genesis_commit_changed_nothing))
