"""A view with its data, through the API: packaging views for export, and importing a package.

  * Export: one version-controlled data source, the views sealed as for a view file, and an export
    job that packages them with the data (the bundle waits beside the job; the download is named
    for the package). A package of one view's data holds that one view.
  * Import: a package is verified and kept; its data goes into a new draft of the target (only a
    version-controlled one, only by the uploader, once); the view is then checked against that
    draft and staged into it, a new view claiming it.

Graph version control and the import/export jobs are faked at their service boundary; the package
format itself is covered in test_view_transfer_package.py and, end to end, by the Postgres suite.
"""
from __future__ import annotations

import json

import pytest

from backend.app.api.v1.endpoints.versioning import get_import_export_service, get_versioning_service
from backend.app.db.models import ViewORM
from backend.app.services.permission_service import PermissionClaims
from backend.app.services.storage.object_store import LocalFsObjectStore
from backend.app.services.versioning.service import AccessDenied
from backend.app.services.view_transfer import package
from backend.app.services.view_transfer.bundle import parse_bundle
from backend.tests.test_view_transfer_import import (  # noqa: F401 — graph is a fixture
    _as, _export, _user, _view, _workspace, graph,
)
from backend.tests.test_view_transfer_staging import _data_source, _Versioning as _StagingVersioning


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
    """The import/export jobs, recorded rather than run."""

    def __init__(self, store):
        self.store = store
        self.exports: list = []
        self.imports: list = []
        self.ran: list = []

    async def create_export_job(self, **kwargs):
        job_id = f"exp_{len(self.exports) + 1}"
        self.exports.append({"job_id": job_id, **kwargs})
        uri = f"{kwargs['workspace_id']}/{kwargs['data_source_id']}/{kwargs['graph_id']}/{job_id}/export.ndjson"
        return {"job_id": job_id, "result_uri": uri}

    async def create_import_job(self, **kwargs):
        job_id = f"imp_{len(self.imports) + 1}"
        self.imports.append({"job_id": job_id, **kwargs})
        uri = f"{kwargs['workspace_id']}/{kwargs['data_source_id']}/{kwargs['graph_id']}/{job_id}/source.ndjson"
        return {"job_id": job_id, "branch_id": kwargs["branch_id"], "source_uri": uri}

    async def run_export_safe(self, job_id):
        self.ran.append(job_id)

    async def run_import_safe(self, job_id):
        self.ran.append(job_id)


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


async def test_a_view_is_packaged_with_its_data_by_an_export_job(test_client, db_session, graph, services):
    versioning, jobs = services
    ws = await _workspace(test_client, "Dev")
    ds = await _data_source(db_session, ws)
    versioning.track(ws, ds)
    view_id = await _view(test_client, ws, dataSourceId=ds)

    resp = await test_client.post("/api/v1/views/transfer/packages", json={"views": [{"viewId": view_id}]})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["fileName"] == "finance-lineage.v1.view-package.zip"
    [job] = jobs.exports
    assert (job["graph_id"], job["scope_view_id"], job["branch_id"], job["export_format"]) == \
        (f"g_{ds}", view_id, None, "ndjson")
    assert job["package"] == {"fileName": body["fileName"], "scope": "view", "dataVersion": "published",
                              "views": 1, "bundleHash": body["bundleHash"]}
    assert jobs.ran == [job["job_id"]], "the export job was dispatched"
    stored = await _read(jobs.store, f"{ws}/{ds}/g_{ds}/{job['job_id']}/view-bundle.json")
    parsed = parse_bundle(stored)
    assert [v.raw["metadata"]["name"] for v in parsed.views] == ["Finance lineage"], \
        "the bundle waits beside the job"


async def test_what_a_package_refuses(test_client, db_session, graph, services, monkeypatch):
    versioning, jobs = services
    ws = await _workspace(test_client, "Dev")
    ds = await _data_source(db_session, ws)
    one = await _view(test_client, ws, dataSourceId=ds)
    two = await _view(test_client, ws, name="Second", dataSourceId=ds)
    url = "/api/v1/views/transfer/packages"

    resp = await test_client.post(url, json={"views": [{"viewId": one}]})
    assert resp.status_code == 422 and resp.json()["detail"]["type"] == "not_versioned"
    versioning.track(ws, ds)
    assert (await test_client.post(url, json={"views": [{"viewId": one}, {"viewId": two}]})).status_code == 422, \
        "one view's data holds one view"
    assert (await test_client.post(url, json={"views": [{"viewId": one}, {"viewId": two}],
                                              "scope": "source"})).status_code == 200
    resp = await test_client.post(url, json={"views": [{"viewId": one}], "dataVersion": "draft"})
    assert resp.status_code == 422 and "no draft" in resp.json()["detail"]

    import time

    from backend.app.services.feature_flags import feature_flags
    monkeypatch.setattr(feature_flags, "_cache", {**(feature_flags._cache or {}), "graphExportEnabled": False})
    monkeypatch.setattr(feature_flags, "_cache_ts", time.monotonic())
    assert (await test_client.post(url, json={"views": [{"viewId": one}]})).status_code == 403, \
        "the data can't leave when exporting graph data is off"


# ── Import ───────────────────────────────────────────────────────────────────


async def _package_file(test_client, view_id, tmp_path) -> bytes:
    """A package of the view: the real bundle, with some graph data."""
    store = LocalFsObjectStore(tmp_path / "pkg")

    async def _put(key, data):
        async def one():
            yield data
        await store.put_stream(key, one())

    await _put("p/view-bundle.json", await _export(test_client, view_id))
    await _put("p/export.ndjson", b'{"kind":"node","urn":"urn:a"}\n{"kind":"node","urn":"urn:new"}\n')
    await package.assemble(store, bundle_key="p/view-bundle.json", data_key="p/export.ndjson",
                           package_key="p/pkg.zip", manifest={"scope": "view", "data": {"version": "published"}})
    return await _read(store, "p/pkg.zip")


async def _inspect_package(client, raw):
    return await client.post("/api/v1/views/transfer/packages/inspect", content=raw,
                             headers={"content-type": "application/zip"})


async def test_a_package_brings_its_data_into_a_draft_and_the_view_follows(
        test_client, db_session, graph, services, tmp_path):
    versioning, jobs = services
    dev, uat = await _workspace(test_client, "Dev"), await _workspace(test_client, "UAT")
    ds = await _data_source(db_session, uat)
    versioning.track(uat, ds)
    raw = await _package_file(test_client, await _view(test_client, dev), tmp_path)

    inspected = await _inspect_package(test_client, raw)
    assert inspected.status_code == 200, inspected.text
    body = inspected.json()
    upload = body["uploadId"]
    assert body["package"]["integrity"] == "verified" and body["package"]["scope"] == "view"
    assert [v["metadata"]["name"] for v in body["views"]] == ["Finance lineage"]
    assert all("versioned" in s for items in body["targetSuggestions"].values() for s in items)

    url = f"/api/v1/views/transfer/packages/{upload}/data"
    data = await test_client.post(url, json={"workspaceId": uat, "dataSourceId": ds})
    assert data.status_code == 200, data.text
    started = data.json()
    [draft] = versioning.drafts
    assert (draft["branch_id"], draft["name"], draft["originating_view_id"]) == \
        (started["branchId"], "Import: Finance lineage", None)
    [job] = jobs.imports
    assert (job["branch_id"], job["reconcile_mode"], job["import_format"], job["idempotency_key"]) == \
        (started["branchId"], "upsert", "ndjson", upload), "adds and updates only, once per upload"
    assert b"urn:new" in await _read(jobs.store, f"{uat}/{ds}/g_{ds}/{job['job_id']}/source.ndjson")
    again = await test_client.post(url, json={"workspaceId": uat, "dataSourceId": ds})
    assert again.json() == started and len(jobs.imports) == 1, "asking again answers with the same job"
    other = await _data_source(db_session, uat, graph_name="elsewhere")
    versioning.track(uat, other)
    elsewhere = await test_client.post(url, json={"workspaceId": uat, "dataSourceId": other})
    assert elsewhere.status_code == 409 and "Import: Finance lineage" in elsewhere.json()["detail"], \
        "the data already went with the first job: somewhere else needs the file again"
    assert len(jobs.imports) == 1 and len(versioning.drafts) == 1

    # The view is checked against the draft, then staged into it: a new view claims the draft.
    view = body["views"][0]
    target = {"workspaceId": uat, "dataSourceId": ds, "branchId": started["branchId"]}
    graph.branches.clear()
    checked = await test_client.post("/api/v1/views/transfer/reconcile", json={"views": [{
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
    assert (await test_client.post("/api/v1/views/transfer/import",
                                   json={**request, "stage": False})).status_code == 422, \
        "a view checked against a draft goes into it"
    staged = await test_client.post("/api/v1/views/transfer/import", json=request)
    assert staged.status_code == 200, staged.text
    result = staged.json()
    assert result["staged"] == {"branchId": started["branchId"]}
    assert len(versioning.drafts) == 1 and draft["originating_view_id"] == result["viewId"], \
        "the new view went into the data's draft, and made it its own"
    row = await db_session.get(ViewORM, result["viewId"])
    assert row.draft_branch_id == started["branchId"]


async def test_a_package_upload_is_the_uploaders_and_needs_version_control(
        test_client, db_session, graph, services, tmp_path):
    versioning, jobs = services
    dev, uat = await _workspace(test_client, "Dev"), await _workspace(test_client, "UAT")
    ds = await _data_source(db_session, uat)
    view_id = await _view(test_client, dev)

    view_file = await _export(test_client, view_id)
    resp = await _inspect_package(test_client, view_file)
    assert resp.status_code == 422 and resp.json()["detail"]["code"] == "view_file"
    raw = await _package_file(test_client, view_id, tmp_path)
    resp = await test_client.post("/api/v1/views/transfer/inspect", content=raw,
                                  headers={"content-type": "application/zip"})
    assert resp.status_code == 422 and resp.json()["detail"]["code"] == "package", "each file to its journey"

    upload = (await _inspect_package(test_client, raw)).json()["uploadId"]
    url = f"/api/v1/views/transfer/packages/{upload}/data"
    resp = await test_client.post(url, json={"workspaceId": uat, "dataSourceId": ds})
    assert resp.status_code == 422 and resp.json()["detail"]["type"] == "not_versioned"

    versioning.track(uat, ds)
    someone = PermissionClaims(sid="s_other", ws_perms={uat: ("workspace:datasource:manage",)})
    with _as(_user("usr_other"), someone):
        assert (await test_client.post(url, json={"workspaceId": uat, "dataSourceId": ds})).status_code == 404
    assert (await test_client.post("/api/v1/views/transfer/packages/up_nope/data",
                                   json={"workspaceId": uat, "dataSourceId": ds})).status_code == 404
    assert not jobs.imports and not versioning.drafts


async def test_day_old_uploads_are_pruned(tmp_path):
    import os
    import time

    store = LocalFsObjectStore(tmp_path / "store")

    async def one():
        yield b"{}"
    await store.put_stream("transfer-uploads/up_old/upload.json", one())
    await store.put_stream("transfer-uploads/up_new/upload.json", one())
    old = tmp_path / "store" / "transfer-uploads" / "up_old"
    past = time.time() - 2 * 86_400
    os.utime(old, (past, past))
    assert await package.prune_uploads(store) == 1
    assert sorted(p.name for p in (tmp_path / "store" / "transfer-uploads").iterdir()) == ["up_new"]
    assert json.loads(b"{}") == {}
