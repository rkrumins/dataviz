"""A canvas save retried with its ``Idempotency-Key`` lands once — needs Postgres.

A save whose answer was lost (a timeout, a dropped connection) is sent again with the same key.
The retry names the same entities (``_replay_minters``) and finds the first attempt's commit
after taking the draft's lock, so it answers with that commit and the entities' current values
instead of applying the batch twice. ``uq_commits_idem`` backs this when two attempts race.
"""
import asyncio
import os
from types import SimpleNamespace

import pytest
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from backend.app.api.v1.endpoints.graph import _replay_minters, _resolve_change_ops
from backend.app.ontology.urn import make_urn
from backend.app.services.versioning import db, models
from backend.app.services.versioning.errors import BranchNotOpen
from backend.app.services.versioning.models import CommitORM
from backend.app.services.versioning.service import GraphVersioningService

pytestmark = pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"),
                                reason="set GRAPHVER_E2E=1 + a live Postgres to run")

_KEY = "changes:u:K"


def _op(op, kind, id=None, ref=None, payload=None):
    return SimpleNamespace(op=op, kind=kind, id=id, ref=ref, payload=payload, base_version=None,
                           unset_properties=None)


def _ops(gid, bid, key="K"):
    """The batch as the route resolves it for a save sent with ``key``."""
    request = [
        _op("create", "node", ref="urn:staged:aaaaaaaa-0001",
            payload={"entityType": "Table", "displayName": "A"}),
        _op("create", "node", ref="b", payload={"entityType": "Table", "displayName": "B"}),
    ]
    ops, _assigned = _resolve_change_ops(
        request, *_replay_minters(f"{gid}/{bid}/u", key, make_urn), by_ref=True)
    return ops


async def _commits(gid, bid) -> int:
    async with db.graphver_session() as s:
        return await s.scalar(select(func.count()).select_from(CommitORM).where(
            CommitORM.graph_id == gid, CommitORM.branch_id == bid))


async def _draft(svc):
    gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(),
                                  workspace_id="ws1", actor="u"))["graph_id"]
    return gid, await svc.open_draft(graph_id=gid, owner="u")


async def _save(svc, gid, bid, key=_KEY, ops=None):
    return await svc.apply_ops_detailed(graph_id=gid, branch_id=bid, actor="u",
                                        ops=ops or _ops(gid, bid), idempotency_key=key)


def _e2e(coro_fn):
    async def run():
        await models.create_schema_and_partitions()
        try:
            await coro_fn(GraphVersioningService())
        finally:
            await db.dispose_engine()
    asyncio.run(run())


async def _retry(svc):
    gid, bid = await _draft(svc)
    first = await _save(svc, gid, bid)
    again = await _save(svc, gid, bid)
    assert first.commit_id and again.commit_id == first.commit_id
    assert await _commits(gid, bid) == 1
    nodes = (await svc.materialize_state(graph_id=gid, branch_id=bid))["nodes"]
    assert len(nodes) == 2, nodes
    assert {eid for eid, (_kind, value) in again.written.items() if value} == set(nodes)
    assert again.urns == first.urns


def test_a_retry_answers_with_the_first_commit():
    _e2e(_retry)


async def _race(svc):
    gid, bid = await _draft(svc)
    a, b = await asyncio.gather(_save(svc, gid, bid), _save(svc, gid, bid))
    assert a.commit_id == b.commit_id
    assert await _commits(gid, bid) == 1


def test_two_attempts_racing_with_one_key_land_once():
    _e2e(_race)


async def _unique(svc):
    gid, bid = await _draft(svc)
    first = await _save(svc, gid, bid)
    with pytest.raises(IntegrityError):
        async with db.graphver_session() as s:
            s.add(CommitORM(graph_id=gid, branch_id=bid, commit_seq=99, kind="edit",
                            idempotency_key=_KEY))
            await s.commit()
    assert first.commit_id


def test_the_store_refuses_a_second_commit_with_the_key():
    _e2e(_unique)


async def _other_branch(svc):
    gid, bid = await _draft(svc)
    other = await svc.open_draft(graph_id=gid, owner="u")
    first = await _save(svc, gid, bid)
    elsewhere = await _save(svc, gid, other, ops=_ops(gid, other))
    assert elsewhere.commit_id and elsewhere.commit_id != first.commit_id
    assert await _commits(gid, other) == 1


def test_the_same_key_on_another_draft_is_a_new_save():
    _e2e(_other_branch)


async def _closed(svc):
    gid, bid = await _draft(svc)
    first = await _save(svc, gid, bid)
    await svc.abandon_draft(graph_id=gid, branch_id=bid, actor="u")
    assert (await _save(svc, gid, bid)).commit_id == first.commit_id   # it did land
    with pytest.raises(BranchNotOpen):
        await _save(svc, gid, bid, key="changes:u:K2", ops=_ops(gid, bid, "K2"))


def test_a_retry_after_the_draft_closed_still_reports_the_save():
    _e2e(_closed)
