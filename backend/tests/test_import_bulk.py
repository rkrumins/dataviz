"""A bulk import (``bulk=true``) at the routes: held to what a publish is, before anything is stored.

It opens no draft, places nothing and replaces nothing, and loads a graph's own published version,
not a fork's (422 each); it needs publish (403 ``publish_required``) and a policy that lets its
caller merge their own changes (409 ``review_required``); and one loads a graph at a time (409
``bulk_import_loading``, which names the import). Its discard is its starter's or a manager's, of a
bulk import only, before it lands; so is resuming one that failed. integration/test_import_bulk.py
runs the import itself on Postgres.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from backend.app.api.v1.endpoints import versioning as versioning_ep
from backend.app.auth.dependencies import get_permission_claims
from backend.app.services.permission_service import PermissionClaims
from backend.app.services.storage.object_store import LocalFsObjectStore
from backend.app.services.versioning.errors import BulkImportLoading
from backend.app.services.versioning.import_export import uploads


class _Graphs:
    def __init__(self, fork_of=None):
        self._fork_of = fork_of

    async def get_graph(self, graph_id):
        return {"graph_id": graph_id, "workspace_id": "ws1", "data_source_id": "ds1", "provider_id": None,
                "fork_parent_graph_id": self._fork_of}


class _Imports:
    def __init__(self, store):
        self.store = store
        self.created: list = []
        self.loading = None                  # (job id, status) of a bulk import loading the graph
        self.jobs: dict = {}
        self.discard = None                  # what discard_import answers, or the error it raises
        self.resumed = True                  # what resume_bulk_import answers

    async def create_import_job(self, **kwargs):
        self.created.append(kwargs)
        return {"job_id": f"vjob_{len(self.created)}", "branch_id": None if kwargs.get("bulk") else "br_1",
                "source_uri": kwargs.get("source_uri") or "ws1/ds1/g1/vjob/source.ndjson"}

    async def refuse_second_bulk(self, _graph_id):
        if self.loading:
            raise BulkImportLoading(*self.loading)

    async def find_job(self, **_kwargs):
        return None

    async def start_import(self, _job_id):
        return "pending"

    async def get_job(self, job_id):
        return self.jobs.get(job_id)

    async def resume_bulk_import(self, job_id, *, viewer):
        return self.resumed

    async def discard_import(self, job_id, *, viewer):
        if isinstance(self.discard, Exception):
            raise self.discard
        return self.discard


@pytest.fixture
def imports(tmp_path, monkeypatch):
    from backend.app.main import app

    monkeypatch.setattr(uploads, "PART_BYTES", 64)
    jobs = _Imports(LocalFsObjectStore(tmp_path))
    app.dependency_overrides[versioning_ep.get_versioning_service] = _Graphs
    app.dependency_overrides[versioning_ep.get_import_export_service] = lambda: jobs
    yield jobs
    for dependency in (versioning_ep.get_versioning_service, versioning_ep.get_import_export_service,
                       get_permission_claims):
        app.dependency_overrides.pop(dependency, None)


_IMPORTS = "/api/v1/ws1/versioning/graphs/g1/imports"


async def _completion(test_client) -> str:
    """An upload of one part, sent whole: its ``…/complete`` URL."""
    body = b'{"kind":"node","urn":"urn:a","entityType":"Table"}\n'
    up = (await test_client.post(f"{_IMPORTS}/uploads", json={
        "fileName": "f.ndjson", "size": len(body), "format": "ndjson"})).json()
    url = f"{_IMPORTS}/uploads/{up['uploadId']}"
    assert (await test_client.put(f"{url}/parts/0", content=body)).status_code == 200
    return f"{url}/complete"


async def test_asking_for_it_carries_it_to_the_job(test_client, imports):
    one = await test_client.post(_IMPORTS, params={"bulk": "true", "autoPublish": "true"}, content=b"{}\n")
    assert one.status_code == 202, one.text
    assert one.json()["branchId"] is None, "no draft"
    done = await test_client.post(await _completion(test_client), params={"bulk": "true"})
    assert done.status_code == 202, done.text
    assert [(job["bulk"], job["auto_publish"], job["draft_visibility"]) for job in imports.created] == [
        (True, False, None), (True, False, None)], "it lands itself: no publish of a draft to ask for"
    plain = await test_client.post(_IMPORTS, content=b"{}\n")
    assert plain.status_code == 202 and imports.created[-1]["bulk"] is False


@pytest.mark.parametrize("params, kind", [
    ({"branchId": "br_7"}, "bulk_needs_no_draft"),
    ({"viewId": "view_1"}, "bulk_places_nothing"),
    ({"reconcileMode": "replace"}, "bulk_adds_and_updates"),
])
async def test_it_opens_no_draft_places_nothing_and_replaces_nothing(test_client, imports, monkeypatch,
                                                                     params, kind):
    async def any_view(*_args):
        pass

    monkeypatch.setattr(versioning_ep, "_check_import_view", any_view)
    for url in (_IMPORTS, await _completion(test_client)):
        refused = await test_client.post(url, params={"bulk": "true", **params}, content=b"{}\n")
        assert refused.status_code == 422, refused.text
        assert refused.json()["detail"]["type"] == kind
    assert imports.created == []


async def test_it_loads_a_graphs_own_main_not_a_forks(test_client, imports, monkeypatch):
    from backend.app.main import app

    async def forks_on(_request):
        pass

    monkeypatch.setattr(versioning_ep, "fork_write_gate", forks_on)
    app.dependency_overrides[versioning_ep.get_versioning_service] = lambda: _Graphs(fork_of="g0")
    refused = await test_client.post(_IMPORTS, params={"bulk": "true"}, content=b"{}\n")
    assert refused.status_code == 422, refused.text
    assert refused.json()["detail"]["type"] == "bulk_not_on_a_fork"


async def test_it_needs_publish(test_client, imports):
    from backend.app.main import app

    url = await _completion(test_client)
    app.dependency_overrides[get_permission_claims] = lambda: PermissionClaims(
        sid="s", ws_perms={"ws1": ("workspace:datasource:read", "workspace:datasource:manage")})
    for target in (_IMPORTS, url):
        refused = await test_client.post(target, params={"bulk": "true"}, content=b"{}\n")
        assert refused.status_code == 403, refused.text
        assert refused.json()["detail"]["code"] == "publish_required"
        assert "bulk import" in refused.json()["detail"]["message"]
    assert imports.created == []


async def test_it_needs_a_policy_that_lets_you_merge_your_own_changes(test_client, imports, monkeypatch):
    async def reviewed(_session, _data_source_id):
        return SimpleNamespace(self_merge=False)

    monkeypatch.setattr(versioning_ep, "_drafts_policy_of", reviewed)
    refused = await test_client.post(_IMPORTS, params={"bulk": "true"}, content=b"{}\n")
    assert refused.status_code == 409, refused.text
    assert refused.json()["detail"]["type"] == "review_required"
    assert imports.created == []


async def test_one_loads_a_graph_at_a_time(test_client, imports):
    imports.loading = ("vjob_0", "running")
    refused = await test_client.post(_IMPORTS, params={"bulk": "true"}, content=b"{}\n")
    assert refused.status_code == 409, refused.text
    assert {k: refused.json()["detail"][k] for k in ("type", "jobId", "status", "retryable")} == {
        "type": "bulk_import_loading", "jobId": "vjob_0", "status": "running", "retryable": True}
    assert imports.created == []
    imports.loading = ("vjob_0", "failed")
    detail = (await test_client.post(_IMPORTS, params={"bulk": "true"}, content=b"{}\n")).json()["detail"]
    assert detail["retryable"] is False and "resume it or discard it" in detail["message"]


async def test_its_discard_answers_with_the_job(test_client, imports):
    url = f"{_IMPORTS}/vjob_1/discard"
    assert (await test_client.post(url)).status_code == 404, "no such import"
    imports.jobs["vjob_1"] = {"jobId": "vjob_1", "jobType": "ingest", "graphId": "g1", "status": "pending"}
    imports.discard = {"jobId": "vjob_1", "status": "pending", "discarding": True}
    done = await test_client.post(url)
    assert done.status_code == 200 and done.json()["jobId"] == "vjob_1", done.text
    imports.discard = {"jobId": "vjob_1", "status": "completed", "discarding": False}
    landed = await test_client.post(url)
    assert landed.status_code == 409 and landed.json()["detail"]["type"] == "bulk_import_landed"
    imports.discard = ValueError("only a bulk import is discarded")
    drafted = await test_client.post(url)
    assert drafted.status_code == 422 and drafted.json()["detail"]["type"] == "not_a_bulk_import"


async def test_a_failed_one_is_resumed(test_client, imports):
    url = f"{_IMPORTS}/vjob_1/resume"
    assert (await test_client.post(url)).status_code == 404, "no such import"
    imports.jobs["vjob_1"] = {"jobId": "vjob_1", "jobType": "ingest", "graphId": "g1", "status": "failed",
                              "bulk": False}
    drafted = await test_client.post(url)
    assert drafted.status_code == 422 and drafted.json()["detail"]["type"] == "not_a_bulk_import"
    imports.jobs["vjob_1"]["bulk"] = True
    assert (await test_client.post(url)).status_code == 200
    imports.resumed = False
    running = await test_client.post(url)
    assert running.status_code == 409 and running.json()["detail"]["type"] == "not_failed"
