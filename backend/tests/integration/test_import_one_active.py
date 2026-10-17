"""One import at a time on a draft — needs Postgres.

Two imports running on one draft interleave their windows, and a replace among them deletes what
the other is writing. So a second import onto a draft whose import is pending or running is
refused with ``JobActive`` (409 ``job_active``, naming that job), checked under the draft's lock so
two creates racing on it are settled even where a worker start left ``uq_jobs_ingest_active``
unbuilt; the index settles them too.

A job nothing will run does not hold the draft: the refusal applies the transfer lane's reaper
rules to that job first (never queued for an hour, or queued past the queue timeout), and a job
whose upload broke off inside the request is failed there and then. A running job whose worker
went quiet still holds it: it is taken over and resumed, not dead.
"""
import asyncio
import os
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select, text, update

from backend.app.api.v1.endpoints.versioning import _domain_errors, create_import
from backend.app.services.storage.object_store import LocalFsObjectStore
from backend.app.services.versioning import config, db, models
from backend.app.services.versioning.errors import JobActive
from backend.app.services.versioning.import_export.service import ImportExportService
from backend.app.services.versioning.models import BranchORM, JobORM
from backend.app.services.versioning.service import GraphVersioningService

pytestmark = pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"),
                                reason="set GRAPHVER_E2E=1 + a live Postgres to run")


def _ago(secs: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(seconds=secs)).isoformat()


async def _graph(svc):
    return (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(),
                                   workspace_id="ws1", actor="u"))["graph_id"]


def _create(ie, gid, branch_id=None):
    return ie.create_import_job(workspace_id="ws1", data_source_id=gid, graph_id=gid, actor="u",
                                import_format="ndjson", branch_id=branch_id)


async def _set(job_id, **values):
    async with db.graphver_session() as s:
        await s.execute(update(JobORM).where(JobORM.id == job_id).values(**values))


async def _jobs_on(branch_id):
    async with db.graphver_session() as s:
        return await s.scalar(select(func.count()).select_from(JobORM).where(
            JobORM.branch_id == branch_id))


async def _refused(ie, gid, branch_id, active):
    with pytest.raises(JobActive) as exc:
        await _create(ie, gid, branch_id)
    assert exc.value.job_id == active


def _e2e(coro_fn):
    async def run():
        await models.create_schema_and_partitions()
        try:
            svc = GraphVersioningService()
            await coro_fn(svc, ImportExportService(versioning=svc, store=object()))
        finally:
            await db.dispose_engine()
    asyncio.run(run())


async def _one_at_a_time(svc, ie):
    gid = await _graph(svc)
    first = await _create(ie, gid)
    draft = first["branch_id"]
    await _refused(ie, gid, draft, first["job_id"])
    assert await _jobs_on(draft) == 1, "no second job"

    with pytest.raises(HTTPException) as exc:               # what the routes answer
        with _domain_errors():
            await _create(ie, gid, draft)
    assert exc.value.status_code == 409
    assert (exc.value.detail["type"], exc.value.detail["jobId"]) == ("job_active", first["job_id"])
    assert first["job_id"] in exc.value.detail["message"]

    await _set(first["job_id"], status="running")
    await _refused(ie, gid, draft, first["job_id"])
    await _set(first["job_id"], status="completed")
    assert (await _create(ie, gid, draft))["branch_id"] == draft

    a, b = await _create(ie, gid), await _create(ie, gid)    # no branch: a draft each
    assert a["branch_id"] != b["branch_id"]


async def _without_the_index(svc, ie):
    """A worker start that skipped ``uq_jobs_ingest_active`` (imports still sharing a draft, or a
    busy table) leaves the rule to the draft's lock until a later start builds it."""
    async with db.get_engine().begin() as conn:
        await conn.execute(text(f'DROP INDEX "{models._SCHEMA}".uq_jobs_ingest_active'))
    try:
        gid = await _graph(svc)
        first = await _create(ie, gid)
        draft = first["branch_id"]
        await _refused(ie, gid, draft, first["job_id"])
        await _set(first["job_id"], status="completed")
        raced = await asyncio.gather(_create(ie, gid, draft), _create(ie, gid, draft),
                                     return_exceptions=True)
        assert sorted(type(r).__name__ for r in raced) == ["JobActive", "dict"], raced
        assert await _jobs_on(draft) == 2, "one import from the race"
        await _set(next(r for r in raced if isinstance(r, dict))["job_id"], status="completed")
        # One request sent twice at once is not another import: its key's index answers the second.
        raced = await asyncio.gather(*(ie.create_import_job(
            workspace_id="ws1", data_source_id=gid, graph_id=gid, actor="u", import_format="ndjson",
            branch_id=draft, idempotency_key="k_" + draft) for _ in range(2)), return_exceptions=True)
        assert sorted(type(r).__name__ for r in raced) == ["IntegrityError", "dict"], raced
    finally:
        await models.create_schema_and_partitions()        # and the index is built again


async def _a_job_nothing_will_run_lets_go(svc, ie):
    gid = await _graph(svc)
    cut_off = await _create(ie, gid)                         # its upload never finished
    await _set(cut_off["job_id"], created_at=_ago(config.JOB_NEVER_QUEUED_SECS + 60))
    after = await _create(ie, gid, cut_off["branch_id"])
    assert (await ie.get_job(cut_off["job_id"]))["errorMessage"] == config.JOB_NEVER_QUEUED

    await ie.start_import(after["job_id"])                   # queued, and no worker took it
    await _set(after["job_id"], updated_at=_ago(config.TRANSFER_QUEUE_TIMEOUT_SECS + 60))
    third = await _create(ie, gid, cut_off["branch_id"])
    assert (await ie.get_job(after["job_id"]))["errorMessage"] == config.JOB_NOT_STARTED

    # Running, its worker silent for an hour: it is taken over and resumed, so it still holds.
    await _set(third["job_id"], status="running", current_phase=None,
               started_at=_ago(3600), updated_at=_ago(3600))
    await _refused(ie, gid, cut_off["branch_id"], third["job_id"])


async def _a_retry_waits_its_turn(svc, ie):
    gid = await _graph(svc)
    failed = await _create(ie, gid)
    await _set(failed["job_id"], status="failed", error_message="boom")
    running = await _create(ie, gid, failed["branch_id"])
    with pytest.raises(JobActive) as exc:
        await ie.requeue_failed(failed["job_id"])
    assert exc.value.job_id == running["job_id"]
    assert (await ie.get_job(failed["job_id"]))["status"] == "failed"
    await _set(running["job_id"], status="completed")
    assert await ie.requeue_failed(failed["job_id"]) is True


class _CutOff:
    """A request whose body breaks off midway."""

    async def stream(self):
        yield b'{"kind": "node", "urn": "urn:a"}\n'
        raise ConnectionResetError("the client went away")


async def _a_broken_upload_lets_go(svc, ie, root):
    gid = await _graph(svc)
    ie = ImportExportService(versioning=svc, store=LocalFsObjectStore(root))
    draft = await svc.open_draft(graph_id=gid, owner="u")
    user = type("U", (), {"id": "u"})()
    with pytest.raises(ConnectionResetError):
        await create_import("ws1", gid, _CutOff(), format="ndjson", reconcile_mode="upsert",
                            branch_id=draft, view_id=None, idempotency_key=None, user=user,
                            claims=None, meta={"data_source_id": gid}, ie=ie, session=None)
    async with db.graphver_session() as s:
        (job_id,) = (await s.execute(select(JobORM.id).where(JobORM.branch_id == draft))).scalars()
    job = await ie.get_job(job_id)
    assert (job["status"], job["errorMessage"]) == ("failed", config.JOB_NEVER_QUEUED)
    assert (await _create(ie, gid, draft))["branch_id"] == draft


async def _no_publish_while_importing(svc, ie):
    gid = await _graph(svc)
    first = await _create(ie, gid)
    draft = first["branch_id"]
    await svc.apply_ops(graph_id=gid, branch_id=draft, actor="u", message="window", ops=[
        {"op": "create", "entity_kind": "node", "entity_id": "N",
         "payload": {"urn": "urn:N", "entityType": "Table", "displayName": "N"}}])
    mr = await svc.open_draft_mr(graph_id=gid, branch_id=draft, actor="u")
    publishes = [
        lambda: svc.publish(graph_id=gid, branch_id=draft, actor="u", message="m"),
        lambda: svc.publish(graph_id=gid, branch_id=draft, actor="u", message="m", queued=True),
        lambda: svc.merge_mr(mr_id=mr, actor="u", message="m"),
        lambda: ie.create_publish_job(workspace_id="ws1", data_source_id=gid, graph_id=gid,
                                      branch_id=draft, actor="u", message="m"),
    ]
    for status in ("pending", "running"):
        await _set(first["job_id"], status=status)
        for publish in publishes:
            with pytest.raises(JobActive) as exc:
                await publish()
            assert exc.value.job_id == first["job_id"]
    assert (await svc.branch_statuses([draft]))[draft] == "open", "not taken for a publish"
    await _set(first["job_id"], status="completed")
    assert await svc.publish(graph_id=gid, branch_id=draft, actor="u", message="m")


async def _a_finished_import_frees_the_draft(svc, ie):
    gid = await _graph(svc)
    first = await _create(ie, gid)
    look = ie._active_import

    async def unchecked(s, branch_id, key):     # an API pod from before the check: the index meets it
        return None
    ie._import_on = unchecked

    async def finished_meanwhile(branch_id):        # it finished between the insert and the look
        await _set(first["job_id"], status="completed")
        return await look(branch_id)
    ie._active_import = finished_meanwhile
    second = await _create(ie, gid, first["branch_id"])
    assert second["job_id"] != first["job_id"] and second["branch_id"] == first["branch_id"]


class _Body:
    async def stream(self):
        yield b'{"kind": "node", "urn": "urn:a"}\n'


async def _a_replayed_key_answers_with_its_import(svc, ie, root):
    gid = await _graph(svc)
    ie = ImportExportService(versioning=svc, store=LocalFsObjectStore(root))
    user = type("U", (), {"id": "u"})()

    def post(branch_id=None):
        return create_import("ws1", gid, _Body(), format="ndjson", reconcile_mode="upsert",
                             branch_id=branch_id, view_id=None, idempotency_key="k1", user=user,
                             claims=None, meta={"data_source_id": gid}, ie=ie, session=None)
    first = await post()
    same = (first["jobId"], first["branchId"], first["sourceUri"])
    again = await post()                                     # its answer was lost: sent again
    assert (again["jobId"], again["branchId"], again["sourceUri"]) == same
    again = await post(first["branchId"])                    # not "another import" on its draft
    assert (again["jobId"], again["status"]) == (first["jobId"], "pending")
    await _set(first["jobId"], status="completed")
    again = await post(first["branchId"])
    assert (again["jobId"], again["status"]) == (first["jobId"], "completed")
    async with db.graphver_session() as s:
        assert await s.scalar(select(func.count()).select_from(JobORM).where(JobORM.graph_id == gid)) == 1
        assert await s.scalar(select(func.count()).select_from(BranchORM).where(
            BranchORM.graph_id == gid, BranchORM.kind != "main")) == 1, "no draft opened per replay"


def test_a_draft_takes_one_import_at_a_time():
    _e2e(_one_at_a_time)


def test_a_draft_takes_one_import_at_a_time_without_its_index():
    _e2e(_without_the_index)


def test_a_job_nothing_will_run_never_holds_the_draft():
    _e2e(_a_job_nothing_will_run_lets_go)


def test_a_failed_import_is_retried_only_once_the_draft_is_free():
    _e2e(_a_retry_waits_its_turn)


def test_an_import_whose_upload_broke_off_frees_the_draft_at_once(tmp_path):
    _e2e(lambda svc, ie: _a_broken_upload_lets_go(svc, ie, tmp_path))


def test_a_draft_is_not_published_while_its_import_runs():
    _e2e(_no_publish_while_importing)


def test_an_import_that_finished_meanwhile_frees_the_draft():
    _e2e(_a_finished_import_frees_the_draft)


def test_a_replayed_idempotency_key_answers_with_its_import(tmp_path):
    _e2e(lambda svc, ie: _a_replayed_key_answers_with_its_import(svc, ie, tmp_path))
