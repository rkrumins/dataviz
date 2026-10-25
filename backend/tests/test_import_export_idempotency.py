"""An import or export sent again with its ``idempotencyKey`` answers with the job it started.

Pins, through the API: the key is its sender's (stored as ``<user id>:<key>``), so another caller's
job is never found by it; a second request with the key makes no second job and starts nothing
again; a job whose file never arrived — the first request failed on the way — takes the new
request's file and starts; a finished job is answered as it is; a key that started the other kind
of job is a 409; and a request that loses the race to insert the key answers with the winner's job.
"""
from __future__ import annotations

from typing import Optional

import pytest
from sqlalchemy.exc import IntegrityError

from backend.app.api.v1.endpoints.versioning import get_import_export_service, get_versioning_service
from backend.app.services.storage.object_store import LocalFsObjectStore

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
        #: A job another request with the same key inserts just before the next one does.
        self.racer: Optional[dict] = None

    def seed(self, job_type, key, *, status="pending", phase="queued"):
        job_id = f"vjob_{len(self.jobs) + 1}"
        self.jobs[job_id] = {
            "jobId": job_id, "jobType": job_type, "graphId": "g1", "key": key, "status": status,
            "phase": phase, "branchId": "br_1", "sourceUri": f"ws1/ds1/g1/{job_id}/source.ndjson",
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
    job_id = jobs.seed("ingest", f"{ME}:nightly-1", phase=None)
    r = await test_client.post(f"{URL}/imports", params={"idempotencyKey": "nightly-1"}, content=b"A\n")
    assert r.status_code == 202, r.text
    assert r.json()["jobId"] == job_id and jobs.started == [job_id]
    assert await _stored(jobs, job_id) == b"A\n"


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
