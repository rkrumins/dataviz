"""Main-advancing writers take the graph lock before they read main, and wait for it a bounded
time — needs Postgres.

* A main write whose graph row was loaded before another writer moved main re-reads it after the
  lock: an edge onto a node the other writer deleted is refused instead of committed dangling.
* Revert, restore, sync and bulk import hold the graph lock, so a canvas save started in the
  middle of one waits for it, and the two land as consecutive commits instead of the first one
  failing on the seq the save took.
* Bulk import through the API seeds only an empty graph; a replay of its key still answers.
* A lock wait past ``GRAPHVER_GRAPH_LOCK_TIMEOUT_MS`` (SQLSTATE 55P03 from real asyncpg) is
  LockBusy, and ContentionExhausted once the retries run out, for the graph lock and a draft's row
  lock alike.

The races are forced with hooks inside the first writer's transaction, as in
``test_versioning_draft_write_fences.py``. Unit coverage: ``tests/test_versioning_main_lock.py``.
"""
import asyncio
import os
import time

import pytest
from sqlalchemy import func, select

from backend.app.services.versioning import config, db, models
from backend.app.services.versioning.errors import ContentionExhausted, LockBusy
from backend.app.services.versioning.models import BranchORM, CommitORM
from backend.app.services.versioning.service import ConcurrencyError, GraphVersioningService

pytestmark = pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"),
                                reason="set GRAPHVER_E2E=1 + a live Postgres to run")

_PAUSE = 0.3


def _node(eid, **p):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": f"urn:{eid}", "entityType": "Table", "displayName": eid, **p}}


def _edge(eid, src, tgt):
    return {"op": "create", "entity_kind": "edge", "entity_id": eid,
            "payload": {"sourceEntityId": src, "targetEntityId": tgt, "edgeType": "RELATED_TO"}}


def _row(eid):
    return {"kind": "node", "entity_id": eid, "urn": f"urn:{eid}", "entityType": "Table",
            "displayName": eid}


async def _graph(svc):
    return (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(),
                                   workspace_id="ws1", actor="u"))["graph_id"]


async def _main_commits(svc, gid):
    main = await svc.main_branch_id(gid)
    async with db.graphver_session() as s:
        return (await s.execute(select(CommitORM.commit_seq, CommitORM.kind, CommitORM.id).where(
            CommitORM.graph_id == gid, CommitORM.branch_id == main)
            .order_by(CommitORM.commit_seq))).all()


def _e2e(coro_fn):
    async def run():
        await models.create_schema_and_partitions()
        try:
            await coro_fn(GraphVersioningService())
        finally:
            await db.dispose_engine()
    asyncio.run(run())


async def _edge_onto_a_node_deleted_before_the_lock(svc):
    gid = await _graph(svc)
    await svc.apply_ops(graph_id=gid, actor="u", message="seed", ops=[_node("X"), _node("N")])
    other, real, raced = GraphVersioningService(), GraphVersioningService._lock_graph, []
    racing = [[{"op": "delete", "entity_kind": "node", "entity_id": "N"}]]

    async def lock(s, graph_id):               # the graph row is loaded; main moves; then the lock
        if racing:
            raced.append(await other.apply_ops(graph_id=gid, actor="v", ops=racing.pop(0)))
        await real(s, graph_id)

    svc._lock_graph = lock
    with pytest.raises(ConcurrencyError, match="would dangle"):    # N is read through the skeletons
        await svc.apply_ops(graph_id=gid, actor="u", ops=[_edge("e1", "X", "N")])
    assert await svc.entity_value(graph_id=gid, entity_id="e1") is None

    racing.append([_node("Z")])                # an unrelated write lands on the racing commit
    mine = await svc.apply_ops(graph_id=gid, actor="u", ops=[_node("Y")])
    async with db.graphver_session() as s:
        assert (await s.get(CommitORM, (gid, mine))).parent_commit_id == raced[-1]


def test_a_main_write_reads_main_as_the_lock_holder_left_it():
    _e2e(_edge_onto_a_node_deleted_before_the_lock)


async def _seeded(svc):
    gid = await _graph(svc)
    first = await svc.apply_ops(graph_id=gid, actor="u", message="A", ops=[_node("A")])
    second = await svc.apply_ops(graph_id=gid, actor="u", message="B", ops=[_node("B")])
    return gid, first, second


async def _revert(svc):
    gid, _, second = await _seeded(svc)
    return gid, "_changed_in_window", lambda: svc.revert_commit(graph_id=gid, commit_id=second, actor="u")


async def _restore(svc):
    gid, first, _ = await _seeded(svc)
    return gid, "_changed_in_window", lambda: svc.restore_to_commit(graph_id=gid, commit_id=first, actor="u")


async def _sync(svc):
    gid = await _graph(svc)
    return gid, "_external_state_bounded", lambda: svc.sync_ingest(graph_id=gid, rows=[_row("C")], actor="u")


async def _bulk(svc):
    gid = await _graph(svc)
    return gid, "_main_branch_id", lambda: svc.bulk_ingest(graph_id=gid, rows=[_row("C")], actor="u")


@pytest.mark.parametrize("setup", [_revert, _restore, _sync, _bulk],
                         ids=["revert", "restore", "sync", "bulk"])
def test_a_save_during_a_main_advancer_waits_for_it(setup):
    async def run(svc):
        gid, read, advance = await setup(svc)
        other, orig, race = GraphVersioningService(), getattr(svc, read), []

        async def reading(*a, **k):            # main's head is read: a canvas save starts now
            if not race:
                race.append(asyncio.create_task(other.apply_ops(
                    graph_id=gid, actor="v", message="save", ops=[_node("D")])))
                await asyncio.sleep(_PAUSE)
            return await orig(*a, **k)

        setattr(svc, read, reading)
        try:
            assert await advance()
        finally:
            await asyncio.gather(*race, return_exceptions=True)
        await race[0]
        *_, (seq, kind, _), (save_seq, save_kind, _) = await _main_commits(svc, gid)
        assert kind != "edit" and save_kind == "edit" and save_seq == seq + 1
    _e2e(run)


async def _bulk_into_a_graph_with_entities(svc):
    gid = await _graph(svc)
    seeded = await svc.bulk_ingest(graph_id=gid, rows=[_row("A")], actor="u", idempotency_key="k1")
    before = await _main_commits(svc, gid)
    with pytest.raises(ConcurrencyError, match="empty graph"):
        await svc.bulk_ingest(graph_id=gid, rows=[_row("A"), _row("B")], actor="u")
    assert await _main_commits(svc, gid) == before
    assert await svc.entity_value(graph_id=gid, entity_id="B") is None
    replay = await svc.bulk_ingest(graph_id=gid, rows=[_row("A")], actor="u", idempotency_key="k1")
    assert replay["idempotent_replay"] and replay["commit_id"] == seeded["commit_id"]


def test_bulk_import_seeds_only_an_empty_graph():
    _e2e(_bulk_into_a_graph_with_entities)


async def _held_locks(svc):
    gid = await _graph(svc)
    await svc.apply_ops(graph_id=gid, actor="u", ops=[_node("A")])
    draft = await svc.open_draft(graph_id=gid, owner="u")
    async with db.graphver_session() as holder:
        await holder.execute(select(func.pg_advisory_xact_lock(func.hashtext(gid))))
        await holder.execute(select(BranchORM.id).where(BranchORM.id == draft).with_for_update())
        started = time.monotonic()
        with pytest.raises(ContentionExhausted):
            await asyncio.wait_for(svc.apply_ops(graph_id=gid, actor="u", ops=[_node("B")]), 10)
        with pytest.raises(ContentionExhausted):
            await asyncio.wait_for(svc.apply_ops(graph_id=gid, branch_id=draft, actor="u",
                                                 ops=[_node("C")]), 10)
        with pytest.raises(LockBusy) as busy:            # not retried: LockBusy itself
            await asyncio.wait_for(svc.request_projection_rebuild(gid), 10)
        assert not isinstance(busy.value, ContentionExhausted)
        assert time.monotonic() - started < 6
        await holder.rollback()
    assert await svc.apply_ops(graph_id=gid, actor="u", ops=[_node("B")])
    assert await svc.apply_ops(graph_id=gid, branch_id=draft, actor="u", ops=[_node("C")])


def test_a_lock_wait_is_bounded(monkeypatch):
    monkeypatch.setattr(config, "GRAPH_LOCK_TIMEOUT_MS", 200, raising=False)
    monkeypatch.setattr(config, "COMMIT_MAX_RETRIES", 2)
    _e2e(_held_locks)
