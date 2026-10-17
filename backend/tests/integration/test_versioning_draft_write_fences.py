"""Draft write fences and draft-writer serialization — needs Postgres.

Every writer of one draft (apply_ops, stage, checkpoint, pull, claim, abandon) takes the draft's
row lock (``_lock_branch``, graph-scoped) and then checks it is open, so:

* a write that names main (its id or ``'main'``) is refused unless the caller allows write-through;
* a draft of another graph is unknown to this one;
* a save that arrives during a pull or a checkpoint of the same draft waits for it, and then lands
  on top of it instead of being reverted by it (or reverting it);
* two concurrent stages of one draft get distinct ``working_changes`` seqs;
* an abandon waits for a save in flight, and later saves see the draft closed.

The races are forced with hooks inside the first writer's transaction: the second writer is
started there and must still be waiting after a pause. Writes to a merged or abandoned draft are
covered in ``test_versioning_draft_abandon.py``.
"""
import asyncio
import os

import pytest
from sqlalchemy import func, select

from backend.app.services.versioning import db, models
from backend.app.services.versioning.changeset import Delta
from backend.app.services.versioning.errors import BranchNotOpen, MainWriteForbidden
from backend.app.services.versioning.merkle import content_hash
from backend.app.services.versioning.models import BranchORM, CommitORM, WorkingChangeORM
from backend.app.services.versioning.service import GraphVersioningService

pytestmark = pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"),
                                reason="set GRAPHVER_E2E=1 + a live Postgres to run")

_PAUSE = 0.3


def _node(eid, **p):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": f"urn:{eid}", "entityType": "Table", "displayName": eid, **p}}


def _upd(eid, **fields):
    return {"op": "update", "entity_kind": "node", "entity_id": eid, "payload": fields}


async def _graph(svc, *seed):
    gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(),
                                  workspace_id="ws1", actor="u"))["graph_id"]
    if seed:
        await svc.apply_ops(graph_id=gid, actor="u", message="seed", ops=list(seed))
    return gid


async def _commits(gid, bid) -> int:
    async with db.graphver_session() as s:
        return await s.scalar(select(func.count()).select_from(CommitORM).where(
            CommitORM.graph_id == gid, CommitORM.branch_id == bid))


async def _blocked(task) -> None:
    """The second writer was started inside the first one's transaction: it must still wait."""
    await asyncio.sleep(_PAUSE)
    assert not task.done(), "the second writer did not wait for the draft lock"


def _e2e(coro_fn):
    async def run():
        await models.create_schema_and_partitions()
        try:
            await coro_fn(GraphVersioningService())
        finally:
            await db.dispose_engine()
    asyncio.run(run())


async def _named_main(svc):
    gid = await _graph(svc, _node("N"))
    main = await svc.main_branch_id(gid)
    seq = (await svc.get_graph(gid))["main_head_commit_seq"]
    for bid in (main, "main"):
        with pytest.raises(MainWriteForbidden):
            await svc.apply_ops(graph_id=gid, branch_id=bid, actor="u", ops=[_upd("N", description="x")])
    assert (await svc.get_graph(gid))["main_head_commit_seq"] == seq
    # The provider write-through on a stale-main read is the one caller that may name main.
    assert await svc.apply_ops(graph_id=gid, branch_id=main, actor="u", allow_main=True,
                               ops=[_upd("N", description="x")])
    assert (await svc.get_graph(gid))["main_head_commit_seq"] == seq + 1


def test_a_write_naming_main_is_refused():
    _e2e(_named_main)


async def _foreign_draft(svc):
    ga, gb = await _graph(svc, _node("N")), await _graph(svc, _node("N"))
    db_ = await svc.open_draft(graph_id=gb, owner="u")
    with pytest.raises(ValueError, match="unknown branch"):
        await svc.apply_ops(graph_id=ga, branch_id=db_, actor="u", ops=[_upd("N", description="x")])
    assert await _commits(ga, db_) == 0 and await _commits(gb, db_) == 0


def test_a_draft_of_another_graph_is_unknown():
    _e2e(_foreign_draft)


async def _save_during_pull(svc):
    gid = await _graph(svc, _node("N", description="v0"), _node("M"))
    d = await svc.open_draft(graph_id=gid, owner="u")
    await svc.apply_ops(graph_id=gid, branch_id=d, actor="u", ops=[_upd("N", description="v1")])
    # Main moves on, without touching N: the draft is behind.
    await svc.apply_ops(graph_id=gid, actor="u", ops=[_upd("M", displayName="M2")])

    orig, race = svc._compute_merge, {}

    async def merging(*a, **k):
        out = await orig(*a, **k)
        if "save" not in race:
            race["save"] = asyncio.create_task(svc.apply_ops(
                graph_id=gid, branch_id=d, actor="u", message="save",
                ops=[_node("Q"), _upd("N", description="v2")]))
            await _blocked(race["save"])
        return out

    svc._compute_merge = merging
    try:
        assert (await svc.rebase_draft(graph_id=gid, branch_id=d, actor="u"))["clean"] is True
    finally:
        svc._compute_merge = orig
        await asyncio.gather(*race.values(), return_exceptions=True)
    await race["save"]
    assert await svc.entity_value(graph_id=gid, branch_id=d, entity_id="Q") is not None
    n = await svc.entity_value(graph_id=gid, branch_id=d, entity_id="N")
    assert n["description"] == "v2", n
    assert (await svc.entity_value(graph_id=gid, branch_id=d, entity_id="M"))["displayName"] == "M2"


def test_a_save_during_a_pull_waits_and_survives_it():
    _e2e(_save_during_pull)


async def _save_during_checkpoint(svc):
    gid = await _graph(svc, _node("X", description="d0"))
    d = await svc.open_draft(graph_id=gid, owner="bob", shared=True)
    await svc.add_branch_member(graph_id=gid, branch_id=d, subject_type="user",
                                subject_id="carol", role="editor", actor="bob")
    await svc.stage_changes(graph_id=gid, branch_id=d, actor="bob",
                            ops=[_upd("X", displayName="BOB")])

    orig, race = svc._composed_state, {}

    async def composing(s, graph_id, branch_id):
        out = await orig(s, graph_id, branch_id)
        if "save" not in race:
            race["save"] = asyncio.create_task(svc.apply_ops(
                graph_id=gid, branch_id=d, actor="carol", ops=[_upd("X", description="CAROL")]))
            await _blocked(race["save"])
        return out

    svc._composed_state = composing
    try:
        assert await svc.checkpoint(graph_id=gid, branch_id=d, actor="bob")
    finally:
        svc._composed_state = orig
        await asyncio.gather(*race.values(), return_exceptions=True)
    await race["save"]
    x = await svc.entity_value(graph_id=gid, branch_id=d, entity_id="X")
    assert x["displayName"] == "BOB" and x["description"] == "CAROL", x


def test_a_save_during_a_checkpoint_waits_and_survives_it():
    _e2e(_save_during_checkpoint)


async def _concurrent_stages(svc):
    gid = await _graph(svc, _node("X"))
    d = await svc.open_draft(graph_id=gid, owner="u")

    orig, race = svc._effective_head_hash, {}

    async def reading(*a, **k):
        if "stage" not in race:
            race["stage"] = asyncio.create_task(svc.stage_changes(
                graph_id=gid, branch_id=d, actor="u", ops=[_upd("X", description="2")]))
            await _blocked(race["stage"])
        return await orig(*a, **k)

    svc._effective_head_hash = reading
    try:
        await svc.stage_changes(graph_id=gid, branch_id=d, actor="u", ops=[_upd("X", description="1")])
    finally:
        svc._effective_head_hash = orig
        await asyncio.gather(*race.values(), return_exceptions=True)
    await race["stage"]
    async with db.graphver_session() as s:
        seqs = (await s.execute(select(WorkingChangeORM.seq).where(
            WorkingChangeORM.graph_id == gid, WorkingChangeORM.branch_id == d))).scalars().all()
    assert sorted(seqs) == [1, 2], seqs


def test_concurrent_stages_get_distinct_seqs():
    _e2e(_concurrent_stages)


async def _empty_own_head(svc):
    gid = await _graph(svc, _node("N"))
    d = await svc.open_draft(graph_id=gid, owner="u")
    # A legacy draft head whose payload is {} (no write path stores one today): it reads as absent.
    async with db.graphver_session() as s:
        draft = await s.get(BranchORM, d)
        commit = CommitORM(graph_id=gid, branch_id=d, commit_seq=await svc._next_seq(s, gid, d),
                           parent_commit_id=draft.head_commit_id, kind="edit", message="legacy",
                           actor="u")
        s.add(commit)
        await s.flush()
        await svc._write_deltas(s, gid, d, commit, [Delta("E", "create", {}, None, content_hash({}))],
                                {"E": "node"}, "u")
        draft.head_commit_id = commit.id
    # Main then creates E: the pull writes main's E over the {} head (a CAS from "absent").
    await svc.apply_ops(graph_id=gid, actor="u", ops=[_node("E", description="main")])
    assert (await svc.rebase_draft(graph_id=gid, branch_id=d, actor="u"))["clean"] is True
    e = await svc.entity_value(graph_id=gid, branch_id=d, entity_id="E")
    assert e and e["description"] == "main", e


def test_a_pull_over_an_empty_own_head_succeeds():
    _e2e(_empty_own_head)


async def _abandon_during_save(svc):
    gid = await _graph(svc, _node("N"))
    d = await svc.open_draft(graph_id=gid, owner="u")

    orig, race = svc._current_values, {}

    async def reading(s, graph_id, bid, ids):
        if "abandon" not in race:
            race["abandon"] = asyncio.create_task(svc.abandon_draft(graph_id=gid, branch_id=d, actor="u"))
            await _blocked(race["abandon"])
        return await orig(s, graph_id, bid, ids)

    svc._current_values = reading
    try:
        await svc.apply_ops(graph_id=gid, branch_id=d, actor="u", ops=[_upd("N", description="x")])
    finally:
        svc._current_values = orig
        await asyncio.gather(*race.values(), return_exceptions=True)
    assert (await race["abandon"])["status"] == "abandoned"
    with pytest.raises(BranchNotOpen):
        await svc.apply_ops(graph_id=gid, branch_id=d, actor="u", ops=[_upd("N", description="y")])


def test_an_abandon_waits_for_a_save_in_flight():
    _e2e(_abandon_during_save)
