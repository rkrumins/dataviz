"""A draft being published takes no more changes, and gets them back if the publish does not land
— needs Postgres.

* Queuing a publish (``create_publish_job``) takes the draft's row lock and sets it ``publishing``
  in the transaction that stores the job, already queued. Saves, stages, checkpoints, pulls,
  abandons, an in-request publish and a second queued publish are then refused (409
  branch_closed); only the job's own publish runs. A job queued before this change, on a draft
  still ``open``, runs as well.
* A job that ends without landing hands the draft back: ``release_publishing`` reopens every
  ``publishing`` draft with no pending or running publish job (a failed lease, a queued job timed
  out by the reaper), leaves one whose job is still running alone however quiet it is, and skips a
  draft whose row is locked, so a publish being queued is never reopened.
* A publish takes the draft's row lock too: a save in flight is published with the draft, and an
  edit staged after the publish folded the staged edits is folded on the retry, not dropped.

The races are forced with hooks inside the first writer's transaction, as in
``test_versioning_draft_write_fences.py``.
"""
import asyncio
import os
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import func, select, update

from backend.app.services.versioning import config, db, models
from backend.app.services.versioning.errors import BranchNotOpen, MainWriteForbidden
from backend.app.services.versioning.models import JobORM, WorkingChangeORM
from backend.app.services.versioning.service import GraphVersioningService

pytestmark = pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"),
                                reason="set GRAPHVER_E2E=1 + a live Postgres to run")

_PAUSE = 0.3


def _node(eid, **p):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": f"urn:{eid}", "entityType": "Table", "displayName": eid, **p}}


def _upd(eid, **fields):
    return {"op": "update", "entity_kind": "node", "entity_id": eid, "payload": fields}


async def _graph(svc):
    gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(),
                                  workspace_id="ws1", actor="u"))["graph_id"]
    await svc.apply_ops(graph_id=gid, actor="u", message="seed", ops=[_node("N"), _node("M")])
    return gid


async def _draft(svc, gid, **fields):
    d = await svc.open_draft(graph_id=gid, owner="u")
    await svc.apply_ops(graph_id=gid, branch_id=d, actor="u", ops=[_upd("N", **(fields or {"description": d}))])
    return d


async def _status(svc, bid):
    return (await svc.branch_statuses([bid]))[bid]


def _ago(secs):
    return (datetime.now(timezone.utc) - timedelta(seconds=secs)).isoformat()


async def _set_job(job_id, **values):
    async with db.graphver_session() as s:
        await s.execute(update(JobORM).where(JobORM.id == job_id).values(**values))


def _e2e(coro_fn):
    async def run():
        from backend.app.api.v1.endpoints.versioning import get_import_export_service
        await models.create_schema_and_partitions()
        try:
            await coro_fn(GraphVersioningService(), get_import_export_service())
        finally:
            await db.dispose_engine()
    asyncio.run(run())


def _queue(ie, gid, bid):
    return ie.create_publish_job(workspace_id="ws1", data_source_id=None, graph_id=gid,
                                 branch_id=bid, actor="u", message="by job")


async def _queued_publish_holds_the_draft(svc, ie):
    gid = await _graph(svc)
    main = await svc.main_branch_id(gid)
    with pytest.raises(MainWriteForbidden):
        await _queue(ie, gid, main)
    other = await svc.open_draft(graph_id=await _graph(svc), owner="u")
    with pytest.raises(ValueError, match="unknown branch"):
        await _queue(ie, gid, other)

    d = await _draft(svc, gid, description="queued")
    job = await _queue(ie, gid, d)
    assert await _status(svc, d) == "publishing"
    async with db.graphver_session() as s:
        row = await s.get(JobORM, job["job_id"])
        assert (row.status, row.current_phase) == ("pending", "queued")

    refused = {
        "apply_ops": svc.apply_ops(graph_id=gid, branch_id=d, actor="u", ops=[_upd("N", description="x")]),
        "stage": svc.stage_changes(graph_id=gid, branch_id=d, actor="u", ops=[_upd("N", description="x")]),
        "checkpoint": svc.checkpoint(graph_id=gid, branch_id=d, actor="u"),
        "pull": svc.rebase_draft(graph_id=gid, branch_id=d, actor="u"),
        "abandon": svc.abandon_draft(graph_id=gid, branch_id=d, actor="u"),
        "publish": svc.publish(graph_id=gid, branch_id=d, actor="u", message="in the request"),
        "queue again": _queue(ie, gid, d),
    }
    for name, call in refused.items():
        with pytest.raises(BranchNotOpen) as ei:
            await call
        assert ei.value.status == "publishing", name

    result = await ie.run_publish(job["job_id"])
    assert result.get("commitId"), result
    assert await _status(svc, d) == "merged"
    assert (await svc.entity_value(graph_id=gid, branch_id=main, entity_id="N"))["description"] == "queued"

    # A job queued before this change left its draft open: it still runs.
    legacy = await _draft(svc, gid, description="legacy")
    async with db.graphver_session() as s:
        row = JobORM(job_type="publish", graph_id=gid, workspace_id="ws1", branch_id=legacy,
                     field_scope={"actor": "u", "message": "legacy"}, status="pending",
                     current_phase="queued")
        s.add(row)
        await s.flush()
        legacy_job = row.id
    assert (await ie.run_publish(legacy_job)).get("commitId")
    assert await _status(svc, legacy) == "merged"


def test_a_queued_publish_holds_its_draft_until_it_lands():
    _e2e(_queued_publish_holds_the_draft)


async def _release(svc, ie):
    from backend.app.services.versioning.import_export.import_worker import lease_job
    from backend.app.services.versioning.import_export.runner import JobReaper
    from backend.app.services.versioning.import_export.service import ImportExportService

    gid = await _graph(svc)

    # The lease failed (the worker's publish raised): the next release reopens the draft.
    failed = await _draft(svc, gid)
    job = await _queue(ie, gid, failed)

    async def raising(_job):
        raise RuntimeError("worker fell over")
    broken = ImportExportService(versioning=svc, store=object(), publish_hook=raising)
    await broken.run_publish_safe(job["job_id"], await lease_job(job["job_id"]))
    assert (await ie.get_job(job["job_id"]))["status"] == "failed"
    assert await _status(svc, failed) == "publishing"
    assert failed in await svc.release_publishing()
    assert await _status(svc, failed) == "open"

    # No worker took the queued job in time: the reaper fails it, and the release reopens.
    timed_out = await _draft(svc, gid)
    job = await _queue(ie, gid, timed_out)
    await _set_job(job["job_id"], updated_at=_ago(config.TRANSFER_QUEUE_TIMEOUT_SECS + 60))
    assert (await JobReaper().run_once())["timedOut"] >= 1
    assert timed_out in await svc.release_publishing(graph_id=gid)
    assert await _status(svc, timed_out) == "open"

    # A running job, however quiet, is still the draft's: takeover or the reaper ends it first.
    running = await _draft(svc, gid)
    job = await _queue(ie, gid, running)
    await lease_job(job["job_id"])
    await _set_job(job["job_id"], updated_at=_ago(24 * 3600))
    assert running not in await svc.release_publishing()
    assert await _status(svc, running) == "publishing"

    # A draft whose job ended, being queued again (its row locked, a new job not yet committed):
    # skipped, not waited on — after the wait, the new job would be invisible and the draft reopened.
    requeued = await _draft(svc, gid)
    job = await _queue(ie, gid, requeued)
    await _set_job(job["job_id"], status="failed")
    async with db.graphver_session() as s:
        await svc._lock_branch(s, gid, requeued)
        s.add(JobORM(job_type="publish", graph_id=gid, workspace_id="ws1", branch_id=requeued,
                     field_scope={"actor": "u", "message": "again"}, status="pending",
                     current_phase="queued"))
        await s.flush()
        assert await asyncio.wait_for(svc.release_publishing(branch_id=requeued), timeout=5) == []
    assert await svc.release_publishing(branch_id=requeued) == []
    assert await _status(svc, requeued) == "publishing"


def test_a_publish_that_did_not_land_hands_the_draft_back():
    _e2e(_release)


async def _blocked(task) -> None:
    await asyncio.sleep(_PAUSE)
    assert not task.done(), "the publish did not wait for the draft lock"


async def _save_in_flight(svc, _ie):
    gid = await _graph(svc)
    d = await svc.open_draft(graph_id=gid, owner="u")
    main = await svc.main_branch_id(gid)

    orig, race = svc._current_values, {}

    async def reading(s, graph_id, bid, ids):
        if "publish" not in race:
            race["publish"] = asyncio.create_task(svc.publish(
                graph_id=gid, branch_id=d, actor="u", message="publish"))
            await _blocked(race["publish"])
        return await orig(s, graph_id, bid, ids)

    svc._current_values = reading
    try:
        await svc.apply_ops(graph_id=gid, branch_id=d, actor="u", ops=[_upd("N", description="saved")])
    finally:
        svc._current_values = orig
        await asyncio.gather(*race.values(), return_exceptions=True)
    assert await race["publish"]
    assert (await svc.entity_value(graph_id=gid, branch_id=main, entity_id="N"))["description"] == "saved"
    assert await _status(svc, d) == "merged"


def test_a_publish_waits_for_a_save_in_flight_and_publishes_it():
    _e2e(_save_in_flight)


async def _staged_after_the_fold(svc, _ie):
    gid = await _graph(svc)
    d = await _draft(svc, gid, description="saved")
    main = await svc.main_branch_id(gid)

    orig, staged = svc._flush_pending_changes, []

    async def folding(**kwargs):
        out = await orig(**kwargs)
        if not staged:
            staged.append(await svc.stage_changes(graph_id=gid, branch_id=d, actor="u",
                                                  ops=[_upd("M", description="staged late")]))
        return out

    svc._flush_pending_changes = folding
    try:
        await svc.publish(graph_id=gid, branch_id=d, actor="u", message="publish")
    finally:
        svc._flush_pending_changes = orig
    assert staged
    assert (await svc.entity_value(graph_id=gid, branch_id=main, entity_id="M"))["description"] == "staged late"
    async with db.graphver_session() as s:
        left = await s.scalar(select(func.count()).select_from(WorkingChangeORM).where(
            WorkingChangeORM.branch_id == d, WorkingChangeORM.committed_into_commit_id.is_(None)))
    assert left == 0


def test_an_edit_staged_after_the_fold_is_published_not_dropped():
    _e2e(_staged_after_the_fold)
