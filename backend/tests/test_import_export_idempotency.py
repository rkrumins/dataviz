"""An import or export sent again with its ``idempotencyKey`` answers with the job it started.

Pins, through the API: the key is its sender's (stored as ``<user id>:<key>``), so another caller's
job is never found by it; a second request with the key makes no second job and starts nothing
again; an import whose upload broke off is failed there and then, keyed or not, and the same key
takes it back (``reclaim_import``) with the new request's file and starts it, if the view it places
into is still the caller's to edit; an import still storing its file is answered as it is, storing
nothing; a finished job is answered as it is; a key that started the other kind of job is a 409;
and a request that loses the race to insert the key answers with the winner's job.
"""
from __future__ import annotations

from types import SimpleNamespace
from typing import Optional

import pytest
from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError

from backend.app.api.v1.endpoints import versioning as versioning_endpoints
from backend.app.api.v1.endpoints.versioning import (create_import, get_import_export_service,
                                                      get_versioning_service)
from backend.app.services.storage.object_store import LocalFsObjectStore
from backend.app.services.versioning.config import JOB_NEVER_QUEUED

URL = "/api/v1/ws1/versioning/graphs/g1"
ME = "usr_test000000"                                 # conftest's signed-in user


class _Versioning:
    async def get_graph(self, graph_id):
        return {"graph_id": graph_id, "workspace_id": "ws1", "data_source_id": "ds1", "provider_id": None}


class _Jobs:
    """Jobs as the import/export service keeps them: an idempotency key is unique on its graph."""

    def __init__(self, store):
        self.store = store
        self.jobs: dict = {}
        self.started: list = []
        self.abandoned: list = []
        self.reclaimed: list = []
        #: A job another request with the same key inserts just before the next one does.
        self.racer: Optional[dict] = None

    def seed(self, job_type, key, *, status="pending", phase="queued", error=None):
        job_id = f"vjob_{len(self.jobs) + 1}"
        self.jobs[job_id] = {
            "jobId": job_id, "jobType": job_type, "graphId": "g1", "key": key, "status": status,
            "phase": phase, "errorMessage": error, "branchId": "br_1",
            "sourceUri": f"ws1/ds1/g1/{job_id}/source.ndjson",
            "resultUri": f"ws1/ds1/g1/{job_id}/export.ndjson"}
        return job_id

    def _insert(self, job_type, kwargs):
        if self.racer is not None:
            self.jobs[self.racer["jobId"]], self.racer = self.racer, None
        key = kwargs.get("idempotency_key")
        if key and any(j["graphId"] == kwargs["graph_id"] and j["key"] == key for j in self.jobs.values()):
            raise IntegrityError("INSERT INTO graphver.jobs", {}, Exception("ix_jobs_idem_active"))
        job_id = self.seed(job_type, key, phase=None)
        return self.jobs[job_id]

    async def find_job(self, *, graph_id, idempotency_key):
        return next((dict(j) for j in self.jobs.values()
                     if j["graphId"] == graph_id and j["key"] == idempotency_key), None)

    async def create_import_job(self, **kwargs):
        job = self._insert("ingest", kwargs)
        return {"job_id": job["jobId"], "branch_id": job["branchId"], "source_uri": job["sourceUri"]}

    async def create_export_job(self, **kwargs):
        job = self._insert("export", kwargs)
        return {"job_id": job["jobId"], "result_uri": job["resultUri"]}

    async def _start(self, job_id):
        self.jobs[job_id]["phase"] = "queued"
        self.started.append(job_id)
        return "pending"

    start_import = start_export = _start

    async def abandon_unqueued(self, job_id):
        self.abandoned.append(job_id)
        job = self.jobs[job_id]
        if job["status"] == "pending" and job["phase"] is None:
            job.update(status="failed", errorMessage=JOB_NEVER_QUEUED)

    async def reclaim_import(self, job_id, *, actor, workspace_id):
        job = self.jobs[job_id]
        if (job["status"], job["phase"], job["errorMessage"]) != ("failed", None, JOB_NEVER_QUEUED):
            return False
        job.update(status="pending", errorMessage=None)
        self.reclaimed.append(job_id)
        return True


class _CutOff:
    """A request whose body breaks off midway."""

    async def stream(self):
        yield b"A\n"
        raise ConnectionResetError("the client went away")


@pytest.fixture
def jobs(tmp_path):
    from backend.app.main import app

    jobs = _Jobs(LocalFsObjectStore(tmp_path))
    app.dependency_overrides[get_versioning_service] = _Versioning
    app.dependency_overrides[get_import_export_service] = lambda: jobs
    yield jobs
    app.dependency_overrides.pop(get_versioning_service, None)
    app.dependency_overrides.pop(get_import_export_service, None)


async def _stored(jobs, job_id) -> bytes:
    return b"".join([c async for c in jobs.store.open_stream(jobs.jobs[job_id]["sourceUri"])])


async def test_an_import_sent_again_answers_with_the_job_it_started(test_client, jobs):
    first = await test_client.post(f"{URL}/imports", params={"idempotencyKey": "nightly-1"}, content=b"A\n")
    assert first.status_code == 202, first.text
    job_id = first.json()["jobId"]
    assert jobs.jobs[job_id]["key"] == f"{ME}:nightly-1", "the key is stored as its sender's"

    again = await test_client.post(f"{URL}/imports", params={"idempotencyKey": "nightly-1"}, content=b"B\n")
    assert again.status_code == 202, again.text
    assert again.json() == first.json()
    assert len(jobs.jobs) == 1 and jobs.started == [job_id], "no second job, and nothing started twice"
    assert await _stored(jobs, job_id) == b"A\n", "the file the job started with is kept"


async def test_another_callers_job_is_never_found_by_the_same_key(test_client, jobs):
    theirs = jobs.seed("ingest", "usr_someone_else:nightly-1")
    mine = await test_client.post(f"{URL}/imports", params={"idempotencyKey": "nightly-1"}, content=b"A\n")
    assert mine.status_code == 202, mine.text
    assert mine.json()["jobId"] != theirs and len(jobs.jobs) == 2


async def test_an_import_whose_file_never_arrived_takes_this_requests_file(test_client, jobs):
    # As a request that broke off leaves it: failed there and then, with no phase.
    job_id = jobs.seed("ingest", f"{ME}:nightly-1", status="failed", phase=None, error=JOB_NEVER_QUEUED)
    r = await test_client.post(f"{URL}/imports", params={"idempotencyKey": "nightly-1"}, content=b"A\n")
    assert r.status_code == 202, r.text
    assert r.json()["jobId"] == job_id and jobs.reclaimed == jobs.started == [job_id]
    assert await _stored(jobs, job_id) == b"A\n"


async def test_an_import_is_taken_back_only_into_a_view_the_caller_can_still_edit(
        test_client, jobs, monkeypatch):
    job_id = jobs.seed("ingest", f"{ME}:nightly-1", status="failed", phase=None, error=JOB_NEVER_QUEUED)
    jobs.jobs[job_id]["scopeViewId"] = "view_1"

    async def check(session, ws_id, view_id, user, claims):     # view_1 is no longer theirs to edit
        if view_id == "view_1":
            raise HTTPException(status_code=403, detail="Missing permission: workspace:view:edit")
    monkeypatch.setattr(versioning_endpoints, "_check_import_view", check)
    r = await test_client.post(f"{URL}/imports", params={"idempotencyKey": "nightly-1"}, content=b"A\n")
    assert r.status_code == 403, r.text
    assert jobs.reclaimed == jobs.started == [] and jobs.jobs[job_id]["status"] == "failed"
    assert not (await jobs.store.stat(jobs.jobs[job_id]["sourceUri"])).exists


@pytest.mark.parametrize("how", ["sent again", "raced"])
async def test_an_import_still_storing_its_file_is_answered_as_it_is(test_client, jobs, how):
    uri = "ws1/ds1/g1/vjob_winner/source.ndjson"
    winner = {"jobId": "vjob_winner", "jobType": "ingest", "graphId": "g1", "key": f"{ME}:nightly-1",
              "status": "pending", "phase": None, "errorMessage": None, "branchId": "br_9",
              "sourceUri": uri, "resultUri": None}
    if how == "sent again":
        jobs.jobs["vjob_winner"] = winner
    else:
        jobs.racer = winner
    r = await test_client.post(f"{URL}/imports", params={"idempotencyKey": "nightly-1"}, content=b"B\n")
    assert r.status_code == 202, r.text
    assert (r.json()["jobId"], r.json()["status"]) == ("vjob_winner", "pending")
    assert jobs.started == jobs.reclaimed == [], "its own request stores its file and starts it"
    assert not (await jobs.store.stat(uri)).exists, "nothing written into the file being stored"


def _post_directly(jobs, key):
    return create_import("ws1", "g1", _CutOff(), format="ndjson", reconcile_mode="upsert",
                         branch_id=None, view_id=None, idempotency_key=key, user=SimpleNamespace(id=ME),
                         claims=None, meta={"data_source_id": "ds1"}, ie=jobs, session=None)


async def test_a_keyed_upload_that_broke_off_is_taken_back_by_its_retry(test_client, jobs):
    with pytest.raises(ConnectionResetError):
        await _post_directly(jobs, "nightly-1")
    (job_id,) = jobs.jobs
    assert jobs.abandoned == [job_id], "failed there and then: its draft takes the next import now"

    r = await test_client.post(f"{URL}/imports", params={"idempotencyKey": "nightly-1"}, content=b"A\n")
    assert r.status_code == 202, r.text
    assert r.json()["jobId"] == job_id and jobs.started == [job_id]
    assert await _stored(jobs, job_id) == b"A\n"


async def test_an_unkeyed_upload_that_broke_off_is_failed_at_once(jobs):
    with pytest.raises(ConnectionResetError):
        await _post_directly(jobs, None)
    (job_id,) = jobs.jobs
    assert jobs.abandoned == [job_id]


async def test_a_finished_job_is_answered_as_it_is(test_client, jobs):
    job_id = jobs.seed("ingest", f"{ME}:nightly-1", status="completed", phase="done")
    r = await test_client.post(f"{URL}/imports", params={"idempotencyKey": "nightly-1"}, content=b"A\n")
    assert r.status_code == 202 and r.json()["jobId"] == job_id and r.json()["status"] == "completed"
    assert jobs.started == []


async def test_a_key_that_started_the_other_kind_of_job_is_refused(test_client, jobs):
    jobs.seed("export", f"{ME}:nightly-1")
    r = await test_client.post(f"{URL}/imports", params={"idempotencyKey": "nightly-1"}, content=b"A\n")
    assert r.status_code == 409 and r.json()["detail"]["type"] == "idempotency_key_reused", r.text

    jobs.seed("ingest", f"{ME}:load-2")
    r = await test_client.post(f"{URL}/exports", params={"idempotencyKey": "load-2"})
    assert r.status_code == 409 and r.json()["detail"]["type"] == "idempotency_key_reused", r.text


async def test_a_request_that_loses_the_race_answers_with_the_winners_job(test_client, jobs):
    jobs.racer = {"jobId": "vjob_winner", "jobType": "ingest", "graphId": "g1", "key": f"{ME}:nightly-1",
                  "status": "pending", "phase": "queued", "branchId": "br_9",
                  "sourceUri": "ws1/ds1/g1/vjob_winner/source.ndjson", "resultUri": None}
    r = await test_client.post(f"{URL}/imports", params={"idempotencyKey": "nightly-1"}, content=b"A\n")
    assert r.status_code == 202, r.text
    assert r.json()["jobId"] == "vjob_winner" and r.json()["branchId"] == "br_9"
    assert jobs.started == [], "the winner started its own job"


async def test_an_export_sent_again_answers_with_the_job_it_started(test_client, jobs):
    first = await test_client.post(f"{URL}/exports", params={"idempotencyKey": "backup-1"})
    assert first.status_code == 202, first.text
    again = await test_client.post(f"{URL}/exports", params={"idempotencyKey": "backup-1"})
    assert again.json() == first.json() and len(jobs.jobs) == 1 and len(jobs.started) == 1

    stalled = jobs.seed("export", f"{ME}:backup-2", phase=None)
    r = await test_client.post(f"{URL}/exports", params={"idempotencyKey": "backup-2"})
    assert r.json()["jobId"] == stalled and stalled in jobs.started, "an export never queued is started"


async def test_without_a_key_every_request_is_its_own_job(test_client, jobs):
    for _ in range(2):
        assert (await test_client.post(f"{URL}/imports", content=b"A\n")).status_code == 202
    assert len(jobs.jobs) == 2 and all(j["key"] is None for j in jobs.jobs.values())
