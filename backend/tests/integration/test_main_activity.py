"""Every commit that moves a published graph records one activity event (doc 19 §3.6).

The event is the commit's: same actor, API key and request, its kind and its counts. It exists only
once the commit does — a transaction that rolls back records nothing — and a failure to record it
never fails the commit.
"""
import asyncio
import json
import os
from contextlib import contextmanager

import pytest
from sqlalchemy import select

from backend.app.common import activity_context
from backend.app.db.engine import get_async_session
from backend.app.db.models import OutboxEventORM
from backend.app.services.versioning import db, main_activity, models
from backend.app.services.versioning.service import GraphVersioningService

_live = pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"),
                           reason="set GRAPHVER_E2E=1 + a live Postgres (both schemas) to run")


@contextmanager
def _as(actor, key=None, request=None, reason=None):
    token = activity_context.bind(activity_context.ActivityContext(
        actor_id=actor, api_key_id=key, correlation_id=request, stated_reason=reason))
    try:
        yield
    finally:
        activity_context.reset(token)


def _node(eid, name):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": eid, "entityType": "domain", "displayName": name}}


def _rename(eid, name):
    return {"op": "update", "entity_kind": "node", "entity_id": eid, "payload": {"displayName": name}}


async def _events(ds):
    async with get_async_session() as s:
        rows = (await s.execute(select(OutboxEventORM).where(
            OutboxEventORM.aggregate_id == ds,
            OutboxEventORM.event_type.like("workspace.versioning.%"))
            .order_by(OutboxEventORM.created_at, OutboxEventORM.id))).scalars().all()
    return [(r.event_type, json.loads(r.payload)) for r in rows]


async def _every_main_commit_records_one_event(svc):
    ds = "ds_" + os.urandom(4).hex()
    gid = (await svc.create_graph(data_source_id=ds, workspace_id="ws1", actor="alice"))["graph_id"]
    assert await _events(ds) == []                                    # genesis moves nothing

    await svc.bulk_ingest(graph_id=gid, actor="alice", rows=[
        {"kind": "node", "id": u, "urn": u, "entityType": "domain", "displayName": u}
        for u in ("A", "B")])
    with _as("svc_bot", key="apk_1", request="req-1"):
        await svc.apply_ops(graph_id=gid, actor="svc_bot", ops=[_rename("A", "Bot's A")])
    draft = await svc.open_draft(graph_id=gid, owner="alice")
    await svc.apply_ops(graph_id=gid, branch_id=draft, actor="alice", ops=[_node("C", "C")])
    with _as("alice", request="req-2", reason="quarterly clean-up"):
        published = await svc.publish(graph_id=gid, branch_id=draft, actor="alice", message="add C")
    reverted = await svc.revert_commit(graph_id=gid, commit_id=published, actor="alice")
    log = await svc.commit_log(graph_id=gid)
    first = next(c for c in log if c["kind"] == "import")
    await svc.restore_to_commit(graph_id=gid, commit_id=first["commit_id"], actor="bob")

    events = await _events(ds)
    kinds = [t for t, _ in events]
    assert kinds == ["workspace.versioning.ingested", "workspace.versioning.main_edited",
                     "workspace.versioning.published", "workspace.versioning.reverted",
                     "workspace.versioning.restored"], kinds

    by_type = dict(events)
    edit = by_type["workspace.versioning.main_edited"]
    assert (edit["actor_id"], edit["api_key_id"], edit["correlation_id"]) == \
        ("svc_bot", "apk_1", "req-1"), edit
    assert edit["details"]["automation"] is True and edit["details"]["actorKind"] == "service"
    assert edit["details"]["changes"] == {"create": 0, "update": 1, "delete": 0}, edit
    assert (edit["data_source_id"], edit["workspace_id"]) == (ds, "ws1"), edit

    pub = by_type["workspace.versioning.published"]
    assert pub["details"]["commitId"] == published and pub["details"]["kind"] == "squash_publish"
    assert (pub["actor_id"], pub["correlation_id"], pub["stated_reason"]) == \
        ("alice", "req-2", "quarterly clean-up"), pub
    assert "api_key_id" not in pub and pub["details"]["automation"] is False, pub
    assert pub["details"]["changes"]["create"] == 1 and pub["details"]["message"] == "add C", pub

    assert by_type["workspace.versioning.reverted"]["details"]["commitId"] == reverted
    assert by_type["workspace.versioning.restored"]["actor_id"] == "bob"

    # A commit on a draft moves no published graph: nothing more was recorded.
    await svc.apply_ops(graph_id=gid, branch_id=await svc.open_draft(graph_id=gid, owner="alice"),
                        actor="alice", ops=[_node("D", "D")])
    assert len(await _events(ds)) == len(events)


@_live
def test_every_main_commit_records_one_event():
    async def go():
        await models.create_schema_and_partitions()
        try:
            await _every_main_commit_records_one_event(GraphVersioningService())
        finally:
            await db.dispose_engine()
    asyncio.run(go())


@_live
def test_an_after_commit_step_runs_once_and_only_if_the_commit_lands():
    async def go():
        ran = []

        async def step():
            ran.append("ran")

        async def broken():
            raise RuntimeError("the activity log is down")

        # Rolled back: dropped.
        with pytest.raises(ValueError):
            async with db.graphver_session() as s:
                db.after_commit(s, step)
                raise ValueError("refused")
        assert ran == []

        # Committed: run once, after the session has closed; a failing step fails nothing.
        async with db.graphver_session() as s:
            db.after_commit(s, broken)
            db.after_commit(s, step)
            await s.execute(select(1))
        assert ran == ["ran"]

        # Committed mid-scope, then the scope fails: the commit landed, so its step runs.
        with pytest.raises(ValueError):
            async with db.graphver_session() as s:
                db.after_commit(s, step)
                await s.commit()
                raise ValueError("after the commit")
        assert ran == ["ran", "ran"]
        await db.dispose_engine()
    asyncio.run(go())


@_live
def test_a_failure_to_record_never_fails_the_commit(monkeypatch):
    async def go():
        await models.create_schema_and_partitions()
        svc = GraphVersioningService()
        gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                                      actor="alice"))["graph_id"]

        async def down(**_kwargs):
            raise RuntimeError("the management database is down")

        from backend.app.services.activity import recorder
        monkeypatch.setattr(recorder, "record_activity", down)
        await svc.apply_ops(graph_id=gid, actor="alice", ops=[_node("A", "A")])
        main = await svc.main_branch_id(gid)
        assert "A" in (await svc.materialize_state(graph_id=gid, branch_id=main))["nodes"]
        await db.dispose_engine()
    asyncio.run(go())


def test_every_kind_that_moves_main_is_catalogued():
    from backend.app.services.activity import catalogue

    for kind, event_type in main_activity.EVENT_BY_KIND.items():
        assert event_type in catalogue.LABELS and event_type in catalogue._EVENT_META, kind
    _severity, summary = catalogue._EVENT_META["workspace.versioning.published"]
    assert summary({"target_label": "Sales", "details": {"changes": {"create": 2, "update": 1}}}) == \
        "Published 3 changes to Sales"
    _severity, summary = catalogue._EVENT_META["workspace.versioning.main_edited"]
    assert summary({"target_label": "Sales", "details": {"changes": {"update": 1}}}) == \
        "Changed the published data of Sales (1 change)"


@_live
def test_turning_version_control_on_records_no_import_event():
    """Seeding a graph in the transaction that makes it is turning version control on, which records
    its own event (`workspace.versioning.enabled`): no `ingested` beside it."""
    async def go():
        await models.create_schema_and_partitions()
        svc = GraphVersioningService()
        ds = "ds_" + os.urandom(4).hex()
        async with db.graphver_session() as s:
            gid = (await svc.create_graph(data_source_id=ds, workspace_id="ws1", actor="alice",
                                          session=s))["graph_id"]
            await svc.bulk_ingest(graph_id=gid, actor="alice", session=s, rows=[
                {"kind": "node", "id": "A", "urn": "A", "entityType": "domain", "displayName": "A"}])
        assert await _events(ds) == []
        await db.dispose_engine()
    asyncio.run(go())
