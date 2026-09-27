"""Publishing a draft too large to publish inside a request.

The squash holds every changed payload and hashes each; at 100k changes that is a gigabyte and many
seconds of the web process's event loop. Past ``SYNC_PUBLISH_MAX_CHANGES`` the publish — or the
merge of the draft's review — is queued as a job (202, the job to poll); smaller drafts publish in
the request as before. The job's status says what the request would have said: its commit, or the
refusal the route gives (``{status, detail}``), so the client raises the same errors either way.
"""
from __future__ import annotations

import pytest

from backend.app.api.v1.endpoints.versioning import get_import_export_service, get_versioning_service
from backend.app.services.versioning import config

BASE = "/api/v1/ws1/versioning"
CHANGES = {"br_small": 10, "br_big": 50_000}


class _Versioning:
    def __init__(self):
        self.published = []

    async def get_graph(self, graph_id):
        return {"graph_id": graph_id, "workspace_id": "ws1", "data_source_id": "ds1", "provider_id": None}

    async def branch_change_count(self, *, graph_id, branch_id):
        return CHANGES[branch_id]

    async def publish(self, **kw):
        self.published.append(kw)
        return "cmt_1"

    async def get_pr(self, pr_id):
        return {"pr_id": pr_id, "target_graph_id": "g1", "source_branch_id": "br_big", "actor": "someone"}


class _NoOperation:
    async def running(self, *, graph_id, branch_id):
        return None


class _Jobs:
    def __init__(self):
        self.created, self.started = [], []
        self.property_ops = _NoOperation()
        self.jobs = {
            "vjob_done": {"jobId": "vjob_done", "jobType": "publish", "graphId": "g1",
                          "status": "completed", "summary": {"commitId": "cmt_9"}},
            "vjob_refused": {"jobId": "vjob_refused", "jobType": "publish", "graphId": "g1",
                             "status": "failed", "errorMessage": "out of date", "summary": {"error": {
                                 "status": 409, "detail": {"type": "not_up_to_date", "behindBy": 2}}}},
            "vjob_export": {"jobId": "vjob_export", "jobType": "export", "graphId": "g1",
                            "status": "completed", "summary": {}},
        }

    async def create_publish_job(self, **kw):
        self.created.append(kw)
        return {"job_id": "vjob_new"}

    async def start_publish(self, job_id):
        self.started.append(job_id)
        return "pending"

    async def get_job(self, job_id):
        return self.jobs.get(job_id)


@pytest.fixture
def services():
    from backend.app.main import app

    svc, jobs = _Versioning(), _Jobs()
    app.dependency_overrides[get_versioning_service] = lambda: svc
    app.dependency_overrides[get_import_export_service] = lambda: jobs
    yield svc, jobs
    app.dependency_overrides.pop(get_versioning_service, None)
    app.dependency_overrides.pop(get_import_export_service, None)


async def test_a_small_draft_publishes_inside_the_request(test_client, services):
    svc, jobs = services
    r = await test_client.post(f"{BASE}/graphs/g1/branches/br_small/publish", json={"message": "m"})
    assert r.status_code == 200, r.text
    assert r.json() == {"commitId": "cmt_1"}
    assert len(svc.published) == 1 and jobs.created == []


async def test_a_large_draft_publishes_as_a_job(test_client, services):
    svc, jobs = services
    assert CHANGES["br_big"] > config.SYNC_PUBLISH_MAX_CHANGES
    r = await test_client.post(f"{BASE}/graphs/g1/branches/br_big/publish", json={"message": "big one"})
    assert r.status_code == 202, r.text
    assert r.json() == {"jobId": "vjob_new", "graphId": "g1", "status": "pending"}
    assert svc.published == [], "nothing is published inside the request"
    assert jobs.started == ["vjob_new"]
    (created,) = jobs.created
    assert (created["graph_id"], created["branch_id"], created["message"]) == ("g1", "br_big", "big one")
    assert created["merge_request_id"] is None


async def test_the_review_of_a_large_draft_merges_as_a_job(test_client, services):
    svc, jobs = services
    r = await test_client.post(f"{BASE}/merge-requests/mr_1/merge", json={"message": "ship it"})
    assert r.status_code == 202, r.text
    (created,) = jobs.created
    assert (created["graph_id"], created["branch_id"], created["merge_request_id"]) == ("g1", "br_big", "mr_1")


async def test_a_publish_job_says_what_the_request_would_have(test_client, services):
    done = await test_client.get(f"{BASE}/graphs/g1/publish-jobs/vjob_done")
    assert done.status_code == 200, done.text
    assert done.json() == {"jobId": "vjob_done", "graphId": "g1", "status": "completed",
                           "commitId": "cmt_9", "error": None}

    refused = await test_client.get(f"{BASE}/graphs/g1/publish-jobs/vjob_refused")
    assert refused.json()["status"] == "failed"
    assert refused.json()["error"] == {"status": 409, "detail": {"type": "not_up_to_date", "behindBy": 2}}

    for other in ("vjob_export", "vjob_missing"):
        assert (await test_client.get(f"{BASE}/graphs/g1/publish-jobs/{other}")).status_code == 404


async def test_a_refused_publish_job_keeps_a_bounded_refusal(monkeypatch):
    """A large draft can break the ontology on every entity it changes: 200k violations, 60 MB kept
    on the job and sent to the client, which shows the first two. The job keeps a hundred and the
    count."""
    from contextlib import asynccontextmanager

    from backend.app.api.v1.endpoints import versioning as ep
    from backend.app.services.versioning.service import OntologyViolation

    class _Refusing:
        async def get_graph(self, graph_id):
            return {"graph_id": graph_id, "workspace_id": "ws1", "data_source_id": "ds1"}

        async def publish(self, **kw):
            raise OntologyViolation([{"kind": "node", "entity_id": f"e{i}", "reason": f"bad {i}"} for i in range(250)])

    @asynccontextmanager
    async def _session():
        yield None

    async def _nothing(*_args):
        return None

    monkeypatch.setattr(ep, "get_versioning_service", lambda: _Refusing())
    monkeypatch.setattr("backend.app.db.engine.get_async_session", _session)
    monkeypatch.setattr(ep, "_live_containment_types", _nothing)
    monkeypatch.setattr(ep, "_rules_for_meta", _nothing)
    out = await ep._publish_from_job({"graphId": "g1", "branchId": "br_big", "actor": "a",
                                      "workspaceId": "ws1", "message": "m"})
    assert out["error"]["status"] == 422
    detail = out["error"]["detail"]
    assert detail["type"] == "ontology_violation" and detail["total"] == 250
    assert [v["reason"] for v in detail["violations"]] == [f"bad {i}" for i in range(100)]
