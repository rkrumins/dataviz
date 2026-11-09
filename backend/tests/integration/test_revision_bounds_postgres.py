"""Reads of the past stay within bounds — needs Postgres.

"Since then" sums its window in Postgres (``_window_commits``): its count, when its revisions were
made, the changes they recorded and who made them come out as the window's rows say — the same as
reading every row and adding them up, which it no longer does. A statement reading a past revision
that runs past ``GRAPHVER_REVISION_STATEMENT_TIMEOUT_MS`` is cancelled and answered busy (503,
retryable); a plan whose count runs that long is too far back, and is kept so it is not counted
again for that head. A whole-state read past ``GRAPHVER_STATE_READ_MAX`` is refused, and so is a
commit diff past the change tree's limit, each pointing to what reads any size.
"""
import asyncio
import os

import pytest
from sqlalchemy import select, text, update

from backend.app.services.versioning import config, db, models
from backend.app.services.versioning.change_index import stat_changes
from backend.app.services.versioning.errors import RevisionBusy, StateTooLarge
from backend.app.services.versioning.service import DiffTooLarge, GraphVersioningService

pytestmark = [pytest.mark.integration, pytest.mark.skipif(
    not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")]

CONT = ["CONTAINS"]


def _node(eid, name):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": eid, "entityType": "Table", "displayName": name}}


async def _history(svc, edits):
    G = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                               actor="alice")
    gid, main = G["graph_id"], G["main_branch_id"]
    for i, actor in enumerate(edits):
        await svc.apply_ops(graph_id=gid, actor=actor, message=f"edit {i}", ops=[
            _node(f"n{i}", f"N {i}")], containment_edge_types=CONT)
    return gid, main


def _window_by_rows(rows, lo, hi):
    """The window as reading every row of it says (what ``_window_commits`` used to do)."""
    start = next((r for r in rows if r.commit_seq == lo), None)
    inside = [r for r in rows if lo < r.commit_seq <= hi]
    people = {}
    create = upd = delete = 0
    for r in inside:
        for person in [r.actor, *(r.contributors or [])]:
            if person:
                people.setdefault(person, None)
        c, u, d = stat_changes(r.stats)
        create, upd, delete = create + c, upd + u, delete + d

    def end(r):
        return {"seq": r.commit_seq, "commitId": r.id, "kind": r.kind, "message": r.message,
                "actor": r.actor, "createdAt": r.created_at}
    return {
        "commitCount": len(inside), "contributors": list(people)[:50],
        "contributorCount": len(people),
        "firstAt": inside[0].created_at if inside else None,
        "lastAt": inside[-1].created_at if inside else None,
        "from": end(start) if start is not None else None,
        "to": end(inside[-1]) if inside and inside[-1].commit_seq == hi else None,
    }, (create, upd, delete)


async def _run_window_sums() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    gid, main = await _history(svc, ["bob", "carol", "bob", "dave", "erin", "carol", "frank"])
    C = models.CommitORM
    async with db.graphver_session() as s:
        seqs = list((await s.execute(select(C.commit_seq).where(
            C.graph_id == gid, C.branch_id == main).order_by(C.commit_seq))).scalars())
        # What else a revision records of itself: an import's {nodes, edges}, none at all, and
        # the people a publish names besides its actor, blanks and repeats among them.
        shapes = [({"nodes": 3, "edges": 2}, ["zoe", "bob"]), (None, ["", "yan", "zoe"]),
                  ({"create": 1, "update": 4, "delete": 2}, None), ({"weird": "x"}, ["bob"])]
        for seq, (stats, people) in zip(seqs[1::2], shapes):
            await s.execute(update(C).where(C.graph_id == gid, C.commit_seq == seq)
                            .values(stats=stats, contributors=people))
        await s.commit()
        rows = (await s.execute(select(C).where(C.graph_id == gid, C.branch_id == main)
                                .order_by(C.commit_seq))).scalars().all()
    async with svc._session() as s:
        for lo in [0, *seqs]:
            for hi in seqs:
                if hi < lo:
                    continue
                got = await svc._window_commits(s, gid, main, lo, hi)
                assert got == _window_by_rows(rows, lo, hi), (lo, hi)


def test_since_then_is_summed_in_postgres_as_its_rows_say():
    asyncio.run(_run_window_sums())


async def _run_timeouts(monkeypatch) -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    gid, main = await _history(svc, ["bob", "carol", "dave"])
    monkeypatch.setattr(config, "REVISION_STATEMENT_TIMEOUT_MS", 50)
    counted = []

    async def slow(self, s, *a, **k):
        counted.append(1)
        await s.execute(text("SELECT pg_sleep(1)"))
        return 0
    # Putting a revision together: a statement past the timeout is busy, not an error.
    monkeypatch.setattr(GraphVersioningService, "_changed_in_window", slow)
    with pytest.raises(RevisionBusy) as busy:
        await svc.revision_overlay_delta(graph_id=gid, as_of_seq=1, head_seq=3)
    assert busy.value.status_code == 503
    assert busy.value.detail["reason"] == "statement_timeout"
    # Planning one: a count past the timeout is too far back to draw, and kept for that head.
    monkeypatch.setattr(GraphVersioningService, "_own_change_count", slow)
    counted.clear()
    for _ in range(2):
        plan = await svc.revision_read_plan(gid, 1)
        assert plan["too_far"] and plan["changed"] == config.REVISION_REWIND_MAX + 1
    assert len(counted) == 1


def test_a_past_revision_past_its_statement_timeout_is_busy_or_too_far(monkeypatch):
    asyncio.run(_run_timeouts(monkeypatch))


async def _run_caps(monkeypatch) -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    gid, main = await _history(svc, ["bob", "carol", "dave", "erin"])
    assert len((await svc.materialize_state(graph_id=gid, branch_id=main,
                                            max_entities=4))["nodes"]) == 4
    with pytest.raises(StateTooLarge) as big:
        await svc.materialize_state(graph_id=gid, branch_id=main, max_entities=3)
    assert big.value.detail["limit"] == 3 and big.value.detail["entities"] > 3
    # Deleted since: the state as it was holds them, so they count toward its cap.
    await svc.apply_ops(graph_id=gid, actor="bob", message="tidy", containment_edge_types=CONT,
                        ops=[{"op": "delete", "entity_kind": "node", "entity_id": f"n{i}",
                              "payload": None} for i in range(3)])
    assert len((await svc.materialize_state(graph_id=gid, branch_id=main,
                                            max_entities=1))["nodes"]) == 1
    with pytest.raises(StateTooLarge):
        await svc.materialize_state(graph_id=gid, branch_id=main, as_of_seq=5, max_entities=3)
    then = await svc.materialize_state(graph_id=gid, branch_id=main, as_of_seq=5, max_entities=4)
    assert len(then["nodes"]) == 4
    monkeypatch.setattr(config, "DIFF_TREE_MAX_CHANGES", 2)
    with pytest.raises(DiffTooLarge) as far:
        await svc.diff_commits(graph_id=gid, branch_id=main, from_seq=0, to_seq=4)
    assert far.value.limit == 2 and "diff/entries" in str(far.value)
    assert await svc.diff_commits(graph_id=gid, branch_id=main, from_seq=2, to_seq=4)


def test_a_whole_state_or_diff_past_its_cap_is_refused(monkeypatch):
    asyncio.run(_run_caps(monkeypatch))
