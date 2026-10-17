"""A view with its data, through the API: packaging views for export, and importing a package.

  * Export: one version-controlled data source; the request only seals the views, pins published
    data to its commit and queues a job (202) — the job builds the package (its views' file from
    the sealed versions, scoped by them; then the data). A ``requestId`` sent again answers with
    the same job. A package of one view's data holds that one view, and a view that places nothing
    has no data of its own to package.
  * Import: a package is uploaded in parts and checked by an inspect job; once checked it is
    described (with what its data holds by type, and the semantic layer here that is its own). Its
    data goes into a new draft of a version-controlled target by an import job that reads the
    upload in place — nothing is copied — once per target, and to as many targets as asked while
    the upload lasts; near its expiry it takes no new one. The view is then checked against that
    draft and staged into it, a new view claiming it.

Graph version control and the jobs are faked at their service boundary — the package's check runs
(view_transfer.package.inspect_upload) when the test lets the inspect slot take it. The format
itself is covered in test_view_transfer_package.py and, end to end, by the Postgres suite.
"""
from __future__ import annotations

import json

import pytest
from sqlalchemy.exc import IntegrityError

from backend.app.api.v1.endpoints.versioning import get_import_export_service, get_versioning_service
from backend.app.db.models import ViewORM
from backend.app.services.permission_service import PermissionClaims
from backend.app.services.storage.object_store import LocalFsObjectStore
from backend.app.services.versioning.import_export import uploads
from backend.app.services.versioning.service import AccessDenied
from backend.app.services.view_transfer import package
from backend.app.services.view_transfer.bundle import parse_bundle
from backend.tests.conftest import _FAKE_USER
from backend.tests.test_view_transfer_import import (  # noqa: F401 — graph is a fixture
    _as, _export, _user, _view, _workspace, graph,
)
from backend.tests.test_view_transfer_staging import _data_source, _Versioning as _StagingVersioning

pytestmark = pytest.mark.usefixtures("view_portability_enabled")  # the preview ships off

_TRANSFER = "/api/v1/views/transfer"


class _Versioning(_StagingVersioning):
    async def claim_draft(self, *, graph_id, branch_id, actor, view_id=None):
        draft = next((d for d in self.drafts if d["branch_id"] == branch_id), None)
        if draft is None or draft["graph_id"] != graph_id or draft["status"] != "open":
            raise ValueError("unknown branch")
        if draft["owner"] != actor:
            raise AccessDenied("someone else's")
        if view_id and draft["originating_view_id"] is None:
            draft["originating_view_id"] = view_id
        return {"branch_id": branch_id, "name": draft["name"], "originating_view_id": draft["originating_view_id"]}


class _ImportExport:
    """The jobs, recorded rather than run — except a package's check, which runs as the inspect
    slot would, when the test says it gets its turn (:meth:`inspect_queued`)."""

    def __init__(self, store):
        self.store = store
        self.jobs: dict = {}
        self.keys: dict = {}
        self.ran: list = []
        #: The failed jobs queued again, in order.
        self.requeued: list = []

    def _add(self, prefix, kwargs, **row):
        key = (kwargs.get("graph_id"), kwargs.get("idempotency_key"))
        if key[1] and key in self.keys:
            raise IntegrityError("INSERT INTO jobs", {}, Exception("duplicate idempotency key"))
        job_id = f"{prefix}_{len(self.jobs) + 1}"
        self.jobs[job_id] = {"job_id": job_id, "status": "pending", **kwargs, **row}
        if key[1]:
            self.keys[key] = job_id
        return job_id

    def of(self, prefix):
        return [j for j in self.jobs.values() if j["job_id"].startswith(prefix)]

    async def create_export_job(self, **kwargs):
        job_id = self._add("exp", kwargs)
        uri = f"{kwargs['workspace_id']}/{kwargs['data_source_id']}/{kwargs['graph_id']}/{job_id}/export.ndjson"
        return {"job_id": job_id, "result_uri": uri}

    async def create_import_job(self, **kwargs):
        job_id = self._add("imp", kwargs)
        return {"job_id": job_id, "branch_id": kwargs["branch_id"], "source_uri": kwargs["source_uri"]}

    async def create_inspect_job(self, *, upload_id, source_uri):
        key = ("transfer-uploads", f"inspect:{upload_id}")
        if key in self.keys:
            return self.keys[key], False
        return self._add("ins", {"graph_id": key[0], "idempotency_key": key[1], "source_uri": source_uri}), True

    async def _start(self, job_id):
        self.ran.append(job_id)
        return "pending"

    start_export = start_import = start_inspect = _start

    async def inspect_queued(self):
        """The inspect slot takes the queued checks."""
        for job in self.of("ins"):
            if job["status"] == "pending" and job["job_id"] in self.ran:
                job["summary"] = await package.inspect_upload(self.store, job["source_uri"])
                job["status"] = "completed"

    async def requeue_failed(self, job_id):
        if self.jobs[job_id]["status"] != "failed":
            return False
        self.requeued.append(job_id)
        self.jobs[job_id]["status"] = "pending"
        return True

    async def find_job(self, *, graph_id, idempotency_key):
        job_id = self.keys.get((graph_id, idempotency_key))
        return await self.get_job(job_id) if job_id else None

    async def get_job(self, job_id):
        job = self.jobs.get(job_id)
        if job is None:
            return None
        pkg = job.get("package")
        return {"jobId": job_id, "status": job["status"], "graphId": job.get("graph_id"),
                "workspaceId": job.get("workspace_id"), "branchId": job.get("branch_id"),
                "sourceUri": job.get("source_uri"), "fileName": (pkg or {}).get("fileName"),
                "package": {k: v for k, v in pkg.items() if k != "actor"} if pkg else None,
                "phase": "verify", "progress": 40, "processed": 1, "total": 2, "errorMessage": None}


@pytest.fixture
def services(tmp_path):
    from backend.app.main import app

    versioning = _Versioning()
    jobs = _ImportExport(LocalFsObjectStore(tmp_path / "store"))
    app.dependency_overrides[get_versioning_service] = lambda: versioning
    app.dependency_overrides[get_import_export_service] = lambda: jobs
    yield versioning, jobs
    app.dependency_overrides.pop(get_versioning_service, None)
    app.dependency_overrides.pop(get_import_export_service, None)


async def _read(store, key):
    return b"".join([c async for c in store.open_stream(key)])


# ── Export ───────────────────────────────────────────────────────────────────


async def test_a_view_is_packaged_by_a_job_the_request_only_queues(test_client, db_session, graph, services, tmp_path):
    versioning, jobs = services
    ws = await _workspace(test_client, "Dev")
    ds = await _data_source(db_session, ws)
    versioning.track(ws, ds)
    versioning.graphs[ds]["main_head_commit_seq"] = 12
    view_id = await _view(test_client, ws, dataSourceId=ds)

    resp = await test_client.post(f"{_TRANSFER}/packages", json={"views": [{"viewId": view_id}]})
    assert resp.status_code == 202, resp.text
    body = resp.json()
    assert body == {"jobId": "exp_1", "graphId": f"g_{ds}", "workspaceId": ws,
                    "fileName": "finance-lineage.v1.view-package.zip", "status": "pending",
                    "views": [{"viewId": view_id, "version": 1}], "requestId": None}
    [job] = jobs.of("exp")
    assert (job["graph_id"], job["scope_view_id"], job["branch_id"], job["export_format"], job["as_of_seq"]) == \
        (f"g_{ds}", view_id, None, "ndjson", 12), "published data, pinned to the commit it stands at"
    assert job["package"] == {"fileName": body["fileName"], "scope": "view", "dataVersion": "published",
                              "views": body["views"], "actor": _FAKE_USER.id}
    assert jobs.ran == ["exp_1"], "the export job was queued"
    assert not (tmp_path / "store").exists(), "nothing is written in the request"

    # The job's first phase: the views' file, from the versions sealed for it; the view's data scoped
    # by the sealed version's own placements.
    bundle, scope = await package.build_bundle(db_session, job["package"], ws, ds)
    parsed = parse_bundle(json.dumps(bundle).encode())
    assert [v.raw["metadata"]["name"] for v in parsed.views] == ["Finance lineage"]
    assert parsed.views[0].raw["version"] == 1
    assert sorted(scope["assigned_urns"]) == ["urn:a", "urn:b", "urn:gone"]


async def test_a_package_asked_for_again_is_the_same_job(test_client, db_session, graph, services):
    versioning, jobs = services
    ws = await _workspace(test_client, "Dev")
    ds = await _data_source(db_session, ws)
    versioning.track(ws, ds)
    view_id = await _view(test_client, ws, dataSourceId=ds)
    ask = {"views": [{"viewId": view_id}], "scope": "source", "requestId": "req_0123456789"}

    first = await test_client.post(f"{_TRANSFER}/packages", json=ask)
    again = await test_client.post(f"{_TRANSFER}/packages", json=ask)
    assert first.status_code == again.status_code == 202
    assert again.json() == first.json() and first.json()["requestId"] == "req_0123456789"
    assert len(jobs.of("exp")) == 1 and jobs.ran == ["exp_1"]
    assert jobs.of("exp")[0]["idempotency_key"] == "package:req_0123456789"


async def test_what_a_package_refuses(test_client, db_session, graph, services, monkeypatch):
    versioning, jobs = services
    ws = await _workspace(test_client, "Dev")
    ds = await _data_source(db_session, ws)
    one = await _view(test_client, ws, dataSourceId=ds)
    two = await _view(test_client, ws, name="Second", dataSourceId=ds)
    url = f"{_TRANSFER}/packages"

    resp = await test_client.post(url, json={"views": [{"viewId": one}]})
    assert resp.status_code == 422 and resp.json()["detail"]["type"] == "not_versioned"
    versioning.track(ws, ds)
    assert (await test_client.post(url, json={"views": [{"viewId": one}, {"viewId": two}]})).status_code == 422, \
        "one view's data holds one view"
    assert (await test_client.post(url, json={"views": [{"viewId": one}, {"viewId": two}],
                                              "scope": "source"})).status_code == 202
    resp = await test_client.post(url, json={"views": [{"viewId": one}], "dataVersion": "draft"})
    assert resp.status_code == 422 and "no draft" in resp.json()["detail"]

    resp = await test_client.post("/api/v1/views/", json={
        "name": "Rules only", "workspaceId": ws, "viewType": "reference", "dataSourceId": ds,
        "config": {"layout": {"type": "reference", "referenceLayout": {"layers": []}}}})
    empty = resp.json()["id"]
    resp = await test_client.post(url, json={"views": [{"viewId": empty}]})
    assert resp.status_code == 422 and resp.json()["detail"] == package.NO_PLACEMENTS, \
        "no placements: no data of its own (never the whole source in its name)"
    assert (await test_client.post(url, json={"views": [{"viewId": empty}], "scope": "source"})).status_code == 202

    import time

    from backend.app.services.feature_flags import feature_flags
    monkeypatch.setattr(feature_flags, "_cache", {**(feature_flags._cache or {}), "graphExportEnabled": False})
    monkeypatch.setattr(feature_flags, "_cache_ts", time.monotonic())
    assert (await test_client.post(url, json={"views": [{"viewId": one}]})).status_code == 403, \
        "the data can't leave when exporting graph data is off"


# ── Import ───────────────────────────────────────────────────────────────────


_DATA = b'{"kind":"node","urn":"urn:a","entityType":"dataset"}\n{"kind":"node","urn":"urn:new","entityType":"dataset"}\n'


async def _package_file(test_client, view_id) -> bytes:
    """A package of the view: the real bundle, with some graph data, as an export job writes one."""
    async def data():
        yield _DATA

    def manifest_of(found):
        return {"format": "view-package", "formatVersion": 1, "scope": "view",
                "data": {"version": "published", "nodes": 2, "edges": 0}, "parts": found}

    bundle = await _export(test_client, view_id)
    return b"".join([c async for c in package.write_package(bundle, data(), manifest_of)])


async def _upload(client, raw: bytes, *, complete: bool = True) -> str:
    created = await client.post(f"{_TRANSFER}/packages/uploads", json={"fileName": "p.zip", "size": len(raw)})
    assert created.status_code == 201, created.text
    up = created.json()
    for n in reversed(range(up["parts"])):
        part = raw[n * up["partBytes"]:(n + 1) * up["partBytes"]]
        assert (await client.put(f"{_TRANSFER}/packages/uploads/{up['uploadId']}/parts/{n}",
                                 content=part)).status_code == 200
    if complete:
        assert (await client.post(f"{_TRANSFER}/packages/uploads/{up['uploadId']}/complete")).status_code == 202
    return up["uploadId"]


@pytest.fixture
def small_parts(monkeypatch):
    monkeypatch.setattr(uploads, "PART_BYTES", 1024)


async def test_a_package_is_uploaded_in_parts_checked_by_a_job_and_described(
        test_client, db_session, graph, services, small_parts):
    versioning, jobs = services
    dev, uat = await _workspace(test_client, "Dev"), await _workspace(test_client, "UAT")
    ds = await _data_source(db_session, uat)
    versioning.track(uat, ds)
    raw = await _package_file(test_client, await _view(test_client, dev))

    created = await test_client.post(f"{_TRANSFER}/packages/uploads", json={"fileName": "p.zip", "size": len(raw)})
    up = created.json()
    assert (up["status"], up["received"], up["partBytes"]) == ("uploading", [], 1024)
    assert up["parts"] == -(-len(raw) // 1024) > 1 and up["expiresAt"]
    url = f"{_TRANSFER}/packages/uploads/{up['uploadId']}"
    for n in range(1, up["parts"]):
        assert (await test_client.put(f"{url}/parts/{n}", content=raw[n * 1024:(n + 1) * 1024])).status_code == 200
    early = await test_client.post(f"{url}/complete")
    assert early.status_code == 409 and early.json()["detail"]["type"] == "parts_missing"
    assert early.json()["detail"]["missing"] == [0]
    assert (await test_client.put(f"{url}/parts/0", content=raw[:1024])).status_code == 200
    assert (await test_client.get(url)).json()["received"] == list(range(up["parts"]))

    done = await test_client.post(f"{url}/complete")
    assert done.status_code == 202 and done.json() == {"uploadId": up["uploadId"], "jobId": "ins_1",
                                                       "status": "inspecting"}
    assert (await test_client.post(f"{url}/complete")).json()["jobId"] == "ins_1", "asking again: the same check"
    assert len(jobs.of("ins")) == 1 and set(jobs.ran) == {"ins_1"}
    assert (await test_client.put(f"{url}/parts/0", content=raw[:1024])).status_code == 409, \
        "what is checked is what is imported"
    waiting = (await test_client.get(url)).json()
    assert (waiting["status"], waiting["jobId"], waiting["phase"], waiting["progress"]) == \
        ("inspecting", "ins_1", "verify", 40)
    not_yet = await test_client.get(f"{_TRANSFER}/packages/{up['uploadId']}")
    assert not_yet.status_code == 409 and not_yet.json()["detail"] == {
        "type": "not_ready", "status": "inspecting", "jobId": "ins_1"}

    await jobs.inspect_queued()
    assert (await test_client.get(url)).json()["status"] == "ready"
    described = await test_client.get(f"{_TRANSFER}/packages/{up['uploadId']}")
    assert described.status_code == 200, described.text
    body = described.json()
    assert body["uploadId"] == up["uploadId"] and body["expiresAt"] == up["expiresAt"]
    assert body["package"]["integrity"] == "verified" and body["package"]["scope"] == "view"
    assert body["package"]["data"]["typeStats"] == {"nodeCount": 2, "edgeCount": 0,
                                                    "entityTypeCounts": {"dataset": 2}, "edgeTypeCounts": {}}
    assert [v["metadata"]["name"] for v in body["views"]] == ["Finance lineage"]
    assert "id" in body["bundle"]["sources"]["s1"]["ontology"]
    assert body["ontologyMatch"] == {"s1": {"exact": None, "drift": False, "sameEnvironment": False}}
    assert all("versioned" in s for items in body["targetSuggestions"].values() for s in items)
    assert body["identityMatches"] is not None


async def test_a_completion_that_died_half_way_is_finished_by_the_next(
        test_client, db_session, graph, services, small_parts):
    """The first completion created the check and died before recording it on the upload or
    queuing it: the upload still reads ``uploading``, and no worker claims a job never queued.
    Completing again finishes both steps."""
    _versioning, jobs = services
    upload = await _upload(test_client, b"PK\x03\x04 not really a zip, " * 100, complete=False)
    job_id, created = await jobs.create_inspect_job(
        upload_id=upload, source_uri=uploads.record_key({"uploadId": upload}))
    assert created and jobs.ran == []
    url = f"{_TRANSFER}/packages/uploads/{upload}"
    assert (await test_client.get(url)).json()["status"] == "uploading"

    again = await test_client.post(f"{url}/complete")
    assert again.status_code == 202 and again.json()["jobId"] == job_id
    assert jobs.ran == [job_id], "queued at last"
    assert (await test_client.get(url)).json()["jobId"] == job_id, "and recorded on the upload"
    await jobs.inspect_queued()
    assert (await test_client.get(url)).json()["status"] == "invalid"


async def test_a_file_that_is_no_package_is_said_so(test_client, db_session, graph, services, small_parts):
    _versioning, jobs = services
    upload = await _upload(test_client, b"PK\x03\x04 not really a zip, " * 100)
    await jobs.inspect_queued()
    state = (await test_client.get(f"{_TRANSFER}/packages/uploads/{upload}")).json()
    assert state["status"] == "invalid" and state["error"]["code"] == "not_a_package"
    resp = await test_client.get(f"{_TRANSFER}/packages/{upload}")
    assert resp.status_code == 422 and resp.json()["detail"]["type"] == "invalid_package"


async def test_a_packages_data_is_imported_where_it_is_into_any_target(
        test_client, db_session, graph, services, tmp_path, small_parts):
    versioning, jobs = services
    dev, uat = await _workspace(test_client, "Dev"), await _workspace(test_client, "UAT")
    ds = await _data_source(db_session, uat)
    versioning.track(uat, ds)
    upload = await _upload(test_client, await _package_file(test_client, await _view(test_client, dev)),
                           complete=False)
    url = f"{_TRANSFER}/packages/{upload}/data"
    early = await test_client.post(url, json={"workspaceId": uat, "dataSourceId": ds})
    assert early.status_code == 409 and early.json()["detail"]["type"] == "not_inspected"
    assert (await test_client.post(f"{_TRANSFER}/packages/uploads/{upload}/complete")).status_code == 202
    early = await test_client.post(url, json={"workspaceId": uat, "dataSourceId": ds})
    assert early.status_code == 409 and early.json()["detail"]["status"] == "inspecting"
    await jobs.inspect_queued()
    body = (await test_client.get(f"{_TRANSFER}/packages/{upload}")).json()

    stored = sorted(p.relative_to(tmp_path) for p in (tmp_path / "store").rglob("*") if p.is_file())
    data = await test_client.post(url, json={"workspaceId": uat, "dataSourceId": ds})
    assert data.status_code == 200, data.text
    started = data.json()
    [draft] = versioning.drafts
    assert (draft["branch_id"], draft["name"], draft["originating_view_id"]) == \
        (started["branchId"], "Import: Finance lineage", None)
    [job] = jobs.of("imp")
    record_key = f"transfer-uploads/{upload}/upload.json"
    assert (job["branch_id"], job["reconcile_mode"], job["import_format"], job["idempotency_key"],
            job["source_uri"]) == (started["branchId"], "upsert", "ndjson", f"pkgdata:{upload}:-", record_key), \
        "adds and updates only, once per upload and target, reading the upload itself"
    assert sorted(p.relative_to(tmp_path) for p in (tmp_path / "store").rglob("*") if p.is_file()) == stored, \
        "nothing copied, nothing deleted"
    imported = b"".join([c async for c in uploads.open_source(jobs.store, job["source_uri"])])
    assert imported == _DATA, "the job reads the package's data part where it is"

    again = await test_client.post(url, json={"workspaceId": uat, "dataSourceId": ds})
    assert again.json() == started and len(jobs.of("imp")) == 1, "asking again answers with the same job"
    other = await _data_source(db_session, uat, graph_name="elsewhere")
    versioning.track(uat, other)
    elsewhere = await test_client.post(url, json={"workspaceId": uat, "dataSourceId": other})
    assert elsewhere.status_code == 200, elsewhere.text
    assert elsewhere.json()["graphId"] == f"g_{other}" and elsewhere.json()["jobId"] != started["jobId"]
    assert len(jobs.of("imp")) == 2 and len(versioning.drafts) == 2, "another target: its own draft and job"

    # Only a job that failed is queued again when asked — the same job, to resume into the same
    # draft from the same upload. One still queued or running is never queued twice.
    for status in ("pending", "running", "completed"):
        jobs.jobs[job["job_id"]]["status"] = status
        assert (await test_client.post(url, json={"workspaceId": uat, "dataSourceId": ds})).json() == started
    assert jobs.requeued == []
    jobs.jobs[job["job_id"]]["status"] = "failed"
    retried = await test_client.post(url, json={"workspaceId": uat, "dataSourceId": ds})
    assert retried.status_code == 200, retried.text
    assert retried.json() == started and jobs.requeued == [job["job_id"]]
    assert len(jobs.of("imp")) == 2 and len(versioning.drafts) == 2, "no new job, no new draft"

    # The view is checked against the draft, then staged into it: a new view claims the draft.
    view = body["views"][0]
    target = {"workspaceId": uat, "dataSourceId": ds, "branchId": started["branchId"]}
    graph.branches.clear()
    checked = await test_client.post(f"{_TRANSFER}/reconcile", json={"views": [{
        "key": "0", "portableId": view["portableId"], "definition": view["definition"],
        "viewType": view["metadata"]["viewType"], "manifest": view["manifest"],
        "history": [h["hash"] for h in view["history"]], "target": target, "action": "create",
    }]})
    assert checked.status_code == 200, checked.text
    assert graph.branches == [started["branchId"]], "the lookup read the draft"

    request = {
        "action": "create", "target": target, "metadata": view["metadata"], "definition": view["definition"],
        "origin": {"portableId": view["portableId"]}, "manifest": view["manifest"], "history": view["history"],
        "stage": True,
    }
    assert (await test_client.post(f"{_TRANSFER}/import", json={**request, "stage": False})).status_code == 422, \
        "a view checked against a draft goes into it"
    staged = await test_client.post(f"{_TRANSFER}/import", json=request)
    assert staged.status_code == 200, staged.text
    result = staged.json()
    assert result["staged"] == {"branchId": started["branchId"]}
    assert draft["originating_view_id"] == result["viewId"], "the new view went into the data's draft"
    row = await db_session.get(ViewORM, result["viewId"])
    assert row.draft_branch_id == started["branchId"]


async def test_an_upload_near_its_expiry_takes_no_new_import(
        test_client, db_session, graph, services, small_parts, monkeypatch):
    versioning, jobs = services
    dev, uat = await _workspace(test_client, "Dev"), await _workspace(test_client, "UAT")
    ds, other = await _data_source(db_session, uat), await _data_source(db_session, uat, graph_name="b")
    versioning.track(uat, ds)
    versioning.track(uat, other)
    upload = await _upload(test_client, await _package_file(test_client, await _view(test_client, dev)))
    await jobs.inspect_queued()
    url = f"{_TRANSFER}/packages/{upload}/data"
    started = (await test_client.post(url, json={"workspaceId": uat, "dataSourceId": ds})).json()

    monkeypatch.setattr(uploads, "PACKAGE_TTL_SECONDS", 1800)        # half an hour left
    late = await test_client.post(url, json={"workspaceId": uat, "dataSourceId": other})
    assert late.status_code == 410 and late.json()["detail"]["type"] == "upload_expired"
    assert (await test_client.post(url, json={"workspaceId": uat, "dataSourceId": ds})).json() == started, \
        "the import it already has still answers"


async def test_a_package_sent_whole_is_uploaded_and_checked(test_client, db_session, graph, services):
    _versioning, jobs = services
    dev = await _workspace(test_client, "Dev")
    view_id = await _view(test_client, dev)
    raw = await _package_file(test_client, view_id)

    resp = await test_client.post(f"{_TRANSFER}/packages/inspect", content=raw,
                                  headers={"content-type": "application/zip"})
    assert resp.status_code == 202, resp.text
    upload = resp.json()["uploadId"]
    assert resp.json() == {"uploadId": upload, "jobId": "ins_1"}
    await jobs.inspect_queued()
    assert (await test_client.get(f"{_TRANSFER}/packages/{upload}")).status_code == 200

    view_file = await _export(test_client, view_id)
    resp = await test_client.post(f"{_TRANSFER}/packages/inspect", content=view_file,
                                  headers={"content-type": "application/zip"})
    assert resp.status_code == 422 and resp.json()["detail"]["code"] == "view_file"
    resp = await test_client.post(f"{_TRANSFER}/inspect", content=raw, headers={"content-type": "application/zip"})
    assert resp.status_code == 422 and resp.json()["detail"]["code"] == "package", "each file to its journey"


async def test_a_package_upload_is_the_uploaders_and_needs_version_control(
        test_client, db_session, graph, services, small_parts):
    versioning, jobs = services
    dev, uat = await _workspace(test_client, "Dev"), await _workspace(test_client, "UAT")
    ds = await _data_source(db_session, uat)
    upload = await _upload(test_client, await _package_file(test_client, await _view(test_client, dev)))
    await jobs.inspect_queued()
    url = f"{_TRANSFER}/packages/{upload}/data"

    resp = await test_client.post(url, json={"workspaceId": uat, "dataSourceId": ds})
    assert resp.status_code == 422 and resp.json()["detail"]["type"] == "not_versioned"
    versioning.track(uat, ds)
    someone = PermissionClaims(sid="s_other", ws_perms={uat: ("workspace:datasource:manage",)})
    # Someone else's upload reads as one that is gone — the same answer either way: 410 where the
    # package is read (the wizard asks for the file again), 404 on the upload's own routes.
    with _as(_user("usr_other"), someone):
        resp = await test_client.post(url, json={"workspaceId": uat, "dataSourceId": ds})
        assert resp.status_code == 410 and resp.json()["detail"]["type"] == "upload_expired"
        assert (await test_client.get(f"{_TRANSFER}/packages/{upload}")).status_code == 410
        assert (await test_client.get(f"{_TRANSFER}/packages/uploads/{upload}")).status_code == 404
    assert (await test_client.post(f"{_TRANSFER}/packages/up_nope/data",
                                   json={"workspaceId": uat, "dataSourceId": ds})).status_code == 410
    too_big = await test_client.post(f"{_TRANSFER}/packages/uploads",
                                     json={"fileName": "p.zip", "size": uploads.MAX_BYTES + 1})
    assert too_big.status_code == 413
    assert not jobs.of("imp") and not versioning.drafts


# ── The semantic layer a package's source matches here ───────────────────────


async def test_a_source_matches_its_own_semantic_layer_only_in_its_own_environment(db_session, monkeypatch):
    """Same environment (both named, and equal): the bundle's ontology id names the semantic layer
    here, if it still exists and the caller can see it; a changed definition digest is drift — the
    gap-filled digest is not (it differs whenever the exporting graph held a type outside its
    ontology). Anywhere else, no match — ids and digests mean nothing across environments."""
    from backend.app.db.models import OntologyORM, ProviderORM, WorkspaceDataSourceORM, WorkspaceORM
    from backend.app.services.view_transfer import export, sources

    ws = WorkspaceORM(name="UAT")
    finance = OntologyORM(name="Finance", version=3,
                          containment_edge_types='["CONTAINS"]', entity_type_definitions='{"Table": {}}')
    gone = OntologyORM(name="Old", deleted_at="2026-01-01T00:00:00+00:00")
    hidden = OntologyORM(name="Someone else's")
    provider = ProviderORM(name="falkor", provider_type="falkordb")
    db_session.add_all([ws, finance, gone, hidden, provider])
    await db_session.flush()
    db_session.add(WorkspaceDataSourceORM(workspace_id=ws.id, provider_id=provider.id, graph_name="g",
                                          ontology_id=finance.id))
    db_session.add(WorkspaceDataSourceORM(workspace_id=ws.id, provider_id=provider.id, graph_name="h",
                                          ontology_id=gone.id))
    await db_session.flush()
    digest = await sources.definition_digest(db_session, finance.id)
    assert digest and digest == await sources.definition_digest(db_session, finance.id)
    member = PermissionClaims(sid="s1", ws_perms={ws.id: ("workspace:datasource:read",)})
    described = {"same": {"ontology": {"id": finance.id, "digest": "gap-filled",
                                       "definitionDigest": digest}},
                 "drifted": {"ontology": {"id": finance.id, "definitionDigest": "an older digest"}},
                 "deleted": {"ontology": {"id": gone.id}}, "unseen": {"ontology": {"id": hidden.id}},
                 "unnamed": {"ontology": {}}}
    exact = {"ontologyId": finance.id, "name": "Finance", "version": 3}

    monkeypatch.setattr(export, "environment_id", lambda: "uat")
    assert await sources.ontology_match(db_session, member, described, "uat") == {
        "same": {"exact": exact, "drift": False, "sameEnvironment": True},
        "drifted": {"exact": exact, "drift": True, "sameEnvironment": True},
        "deleted": {"exact": None, "drift": False, "sameEnvironment": True},
        "unseen": {"exact": None, "drift": False, "sameEnvironment": True},
        "unnamed": {"exact": None, "drift": False, "sameEnvironment": True},
    }
    admin = PermissionClaims(sid="s2", global_perms=("system:admin",))
    assert (await sources.ontology_match(db_session, admin, described, "uat"))["unseen"]["exact"]["name"] == \
        "Someone else's"
    elsewhere = {"exact": None, "drift": False, "sameEnvironment": False}
    for made_in, here in (("prod", "uat"), (None, "uat"), ("uat", None), (None, None)):
        monkeypatch.setattr(export, "environment_id", lambda here=here: here)
        assert (await sources.ontology_match(db_session, admin, described, made_in))["same"] == elsewhere
