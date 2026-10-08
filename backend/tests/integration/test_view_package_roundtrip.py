"""A view's data travels in a package and lands in a draft — needs Postgres.

The export job writes the package once, to its own key, reading nothing back from the store: the
views' file, then the data streamed into it, and a manifest that says what the data holds. Uploaded
in parts somewhere else, a ``package_inspect`` job checks it; then an import job brings its data into
a draft of the target (main untouched), reading the upload in place — nothing copied — and another
target takes the same upload too. A sweep while an import is queued keeps the upload. Identity
lookups on the draft see the entities it brought, so a view checked against the draft finds them.
Older packages still import: one whose manifest never said what its data holds by type (counted
on inspection), and one in format 2, whose lines carry each payload whole (lossless).
"""
import asyncio
import json
import os
import tempfile
import time
import zipfile

import pytest

from backend.app.providers.draft_overlay_provider import DraftOverlayProvider
from backend.app.providers.versioned_branch_provider import VersionedBranchProvider
from backend.app.services.storage.object_store import LocalFsObjectStore
from backend.app.services.versioning import db, models
from backend.app.services.versioning.import_export import stream, uploads
from backend.app.services.versioning.import_export.service import ImportExportService
from backend.app.services.versioning.import_export.snapshot import open_snapshot
from backend.app.services.versioning.service import GraphVersioningService
from backend.app.services.view_transfer import package
from backend.app.services.view_transfer.package import DATA_PART, read_package, write_package
from backend.tests.test_view_transfer_package import BUNDLE


def _n(eid, etype="Table", **props):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": f"urn:{eid}", "entityType": etype, "displayName": eid, "properties": props}}


def _e(eid, s, t, etype="PRODUCES"):
    return {"op": "create", "entity_kind": "edge", "entity_id": eid,
            "payload": {"edgeType": etype, "sourceEntityId": s, "targetEntityId": t}}


class _Counted(LocalFsObjectStore):
    def __init__(self, root):
        super().__init__(root)
        self.puts, self.reads = [], 0

    async def put_stream(self, key, chunks):
        self.puts.append(key)
        return await super().put_stream(key, chunks)

    def open_stream(self, key, **kw):
        self.reads += 1
        return super().open_stream(key, **kw)


async def _bytes(chunks):
    return b"".join([c async for c in chunks])


async def _upload(store, ie, raw: bytes) -> str:
    """``raw`` uploaded in parts and checked by its inspect job; the upload's record key."""
    record = await uploads.create_package(store, owner="bob", file_name="p.zip", size=len(raw))
    for n in range(record["parts"]):
        start = n * record["partBytes"]

        async def part(data=raw[start:start + uploads.part_size(record, n)]):
            yield data
        await uploads.put_part(store, record, n, part())
    job_id, created = await ie.create_inspect_job(upload_id=record["uploadId"], source_uri=uploads.record_key(record))
    assert created
    await ie.run_inspect(job_id)
    assert (await ie.get_job(job_id))["status"] == "completed"
    record = await uploads.read_record(store, uploads.record_key(record))
    assert record["archive"]["member"] == DATA_PART, record
    return uploads.record_key(record)


async def _import(svc, ie, source, owner="bob"):
    """The upload's data into a new draft of a fresh graph, by an import job; the draft's state."""
    ds = "ds_" + os.urandom(4).hex()
    g = await svc.create_graph(data_source_id=ds, workspace_id="ws_uat", actor=owner)
    draft = await svc.open_draft(graph_id=g["graph_id"], owner=owner, name="Import")
    job = await ie.create_import_job(workspace_id="ws_uat", data_source_id=ds,
                                     graph_id=g["graph_id"], actor=owner, import_format="ndjson",
                                     source_uri=source, branch_id=draft, reconcile_mode="upsert")
    await ie.run_import(job["job_id"])
    assert (await ie.get_job(job["job_id"]))["status"] == "completed"
    return g, draft, await svc.materialize_state(graph_id=g["graph_id"], branch_id=draft)


async def _run(root: str, monkeypatch) -> None:
    await models.create_schema_and_partitions()
    monkeypatch.setattr(uploads, "PART_BYTES", 4096)
    svc = GraphVersioningService()
    store = _Counted(root)
    ie = ImportExportService(versioning=svc, store=store)

    dev_ds = "ds_" + os.urandom(4).hex()
    dev = await svc.create_graph(data_source_id=dev_ds, workspace_id="ws_dev", actor="alice")
    ops = ([_n(f"t{i:03d}", owner=f"team{i % 3}", schema={"cols": [i, i + 1]}) for i in range(120)]
           + [_n("revenue", "Metric")] + [_e(f"e{i:03d}", f"t{i:03d}", "revenue") for i in range(120)])
    await svc.apply_ops(graph_id=dev["graph_id"], actor="alice", message="seed", ops=ops)

    # ── Export: one write, to the attempt's own key, nothing read back ──────────
    async def bundle_of(_session, options, _ws, _ds):
        assert options["views"] == [{"viewId": "view_1", "version": 3}]
        return json.loads(BUNDLE), None

    monkeypatch.setattr(package, "build_bundle", bundle_of)
    created = await ie.create_export_job(
        workspace_id="ws_dev", data_source_id=dev_ds, graph_id=dev["graph_id"], actor="alice",
        as_of_seq=(await svc.get_graph(dev["graph_id"]))["main_head_commit_seq"],
        package={"fileName": "finance.v3.view-package.zip", "scope": "source", "dataVersion": "published",
                 "views": [{"viewId": "view_1", "version": 3}], "actor": "alice"})
    await svc.apply_ops(graph_id=dev["graph_id"], actor="alice", message="after the ask", ops=[_n("late")])
    store.puts.clear()
    summary = await ie.run_export(created["job_id"])
    job = await ie.get_job(created["job_id"])
    assert job["status"] == "completed" and job["resultUri"].endswith("/view-package.zip")
    assert store.puts == [job["resultUri"]] and store.reads == 0, "written once, never read back"
    assert job["fileName"] == "finance.v3.view-package.zip" and summary["package"]["bytes"] == summary["bytes"]
    assert job["package"]["views"] == [{"viewId": "view_1", "version": 3}] and "actor" not in job["package"]

    path = os.path.join(root, job["resultUri"])
    parsed = read_package(path)
    assert parsed.verified and json.loads(parsed.bundle) == json.loads(BUNDLE)
    assert parsed.manifest["formatVersion"] == 1
    assert parsed.manifest["data"] == {"version": "published", "nodes": 121, "edges": 120, "typeStats": {
        "nodeCount": 121, "edgeCount": 120, "entityTypeCounts": {"Table": 120, "Metric": 1},
        "edgeTypeCounts": {"PRODUCES": 120}}}, "pinned to the commit it was asked at: 'late' isn't in it"

    # ── Import: uploaded in parts, checked, then read in place into two targets ──
    with open(path, "rb") as f:
        raw = f.read()
    source = await _upload(store, ie, raw)
    before = sorted(os.listdir(os.path.join(root, source.rsplit("/", 1)[0])))
    assert {"inspect.json", "view-bundle.json", "upload.json"} <= set(before)

    uat_ds = "ds_" + os.urandom(4).hex()
    uat_gid = (await svc.create_graph(data_source_id=uat_ds, workspace_id="ws_uat", actor="bob"))["graph_id"]
    await svc.apply_ops(graph_id=uat_gid, actor="bob", message="seed", ops=[_n("t000")])
    draft = await svc.open_draft(graph_id=uat_gid, owner="bob", name="Import: Finance")
    queued = await ie.create_import_job(workspace_id="ws_uat", data_source_id=uat_ds,
                                        graph_id=uat_gid, actor="bob", import_format="ndjson",
                                        source_uri=source, branch_id=draft, reconcile_mode="upsert")
    await ie.start_import(queued["job_id"])

    # A sweep while the import is queued keeps its upload, however old.
    upload_dir = os.path.join(root, source.rsplit("/", 1)[0])
    past = time.time() - 3 * 86_400
    for name in os.listdir(upload_dir):
        os.utime(os.path.join(upload_dir, name), (past, past))
    pins = await uploads.jobs_input_prefixes()
    assert source.rsplit("/", 1)[0] in pins
    await store.sweep(older_than_hours=24, keep_prefixes=pins)
    await package.prune_uploads(store, keep_prefixes=pins)
    assert sorted(os.listdir(upload_dir)) == before

    await ie.run_import(queued["job_id"])
    assert (await ie.get_job(queued["job_id"]))["status"] == "completed"
    assert sorted(os.listdir(upload_dir)) == before, "read in place: nothing copied, nothing deleted"
    assert not [k for k in store.puts if k.endswith(("source.ndjson", "graph.ndjson"))]

    main_id = await svc.main_branch_id(uat_gid)
    in_draft = await svc.materialize_state(graph_id=uat_gid, branch_id=draft)
    on_main = await svc.materialize_state(graph_id=uat_gid, branch_id=main_id)
    assert len(in_draft["nodes"]) == 121 and len(in_draft["edges"]) == 120
    assert sorted(p.get("urn") for p in on_main["nodes"].values()) == ["urn:t000"], \
        "nothing lands on main until the draft is published"

    _g, _d, again = await _import(svc, ie, source)
    assert len(again["nodes"]) == 121 and len(again["edges"]) == 120, "another target, the same upload"

    # ── A view checked against the draft finds what the package brought ─────────
    base = VersionedBranchProvider(svc, graph_id=uat_gid, branch_id=main_id, actor="bob")
    overlay = DraftOverlayProvider(base, svc=svc, graph_id=uat_gid, branch_id=draft, actor="bob")
    found = await overlay.resolve_identities(["urn:t000", "urn:revenue", "urn:missing"])
    assert found["urn:revenue"] is not None and found["urn:revenue"]["type"] == "Metric"
    assert found["urn:t000"] is not None and found["urn:missing"] is None

    # ── Older packages: no typeStats (format 1), and format 2's native lines ─────
    async def written(data: bytes, version: int) -> bytes:
        async def chunks():
            yield data

        def manifest_of(parts):
            return {"format": "view-package", "formatVersion": version, "scope": "source", "parts": parts}
        return await _bytes(write_package(BUNDLE, chunks(), manifest_of))

    with zipfile.ZipFile(path) as z:
        v1_data = z.read(DATA_PART)
    v1 = await _upload(store, ie, await written(v1_data, 1))
    inspection = json.loads(await _bytes(store.open_stream(uploads.upload_key(
        {"uploadId": v1.split("/")[1]}, package.INSPECTION))))
    assert inspection["package"]["data"]["typeStats"]["entityTypeCounts"] == {"Table": 120, "Metric": 1}, \
        "counted on inspection when the manifest didn't say"

    snap = await open_snapshot(graph_id=dev["graph_id"])
    native = await _bytes(stream.native_pages(snap, stream.Selection.of()))
    _g, _d, v2_state = await _import(svc, ie, await _upload(store, ie, await written(native, 2)))
    dev_state = await svc.materialize_state(graph_id=dev["graph_id"], branch_id=dev["main_branch_id"])
    by_urn = lambda state: {p["urn"]: p for p in state["nodes"].values()}  # noqa: E731
    assert {u: p.get("properties") or {} for u, p in by_urn(v2_state).items()} == \
        {u: p.get("properties") or {} for u, p in by_urn(dev_state).items()}, "format 2 carries each payload whole"
    assert len(v2_state["edges"]) == 120

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_a_package_carries_the_data_into_a_draft(monkeypatch):
    with tempfile.TemporaryDirectory() as root:
        asyncio.run(_run(root, monkeypatch))
