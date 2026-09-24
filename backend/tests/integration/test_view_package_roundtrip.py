"""A view's data travels in a package and lands in a draft — needs Postgres.

The package's data part is the data source's own export, packaged by the export job; read back,
it verifies; imported into another data source it lands in a draft (main untouched), adding and
updating only; and identity lookups on that draft see the entities it brought, so a view checked
against the draft finds them.
"""
import asyncio
import os
import tempfile

import pytest

from backend.app.providers.draft_overlay_provider import DraftOverlayProvider
from backend.app.providers.versioned_branch_provider import VersionedBranchProvider
from backend.app.services.storage.object_store import LocalFsObjectStore
from backend.app.services.versioning import db, models
from backend.app.services.versioning.import_export.service import ImportExportService
from backend.app.services.versioning.service import GraphVersioningService
from backend.app.services.view_transfer.package import file_chunks, read_package

BUNDLE = b'{"format": "view-bundle", "formatVersion": 1, "views": []}'


def _n(eid, etype="Table"):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": f"urn:{eid}", "entityType": etype, "displayName": eid}}


def _e(eid, s, t, etype="PRODUCES"):
    return {"op": "create", "entity_kind": "edge", "entity_id": eid,
            "payload": {"edgeType": etype, "sourceEntityId": s, "targetEntityId": t}}


async def _once(data: bytes):
    yield data


async def _run(root: str) -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    store = LocalFsObjectStore(root)
    ie = ImportExportService(versioning=svc, store=store)

    dev = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws_dev", actor="alice")
    await svc.apply_ops(graph_id=dev["graph_id"], actor="alice", message="seed",
                        ops=[_n("orders"), _n("revenue"), _e("feeds", "orders", "revenue")])

    # ── Export: the data, packaged with the view bundle beside the job ──────────
    created = await ie.create_export_job(
        workspace_id="ws_dev", data_source_id=dev["data_source_id"] if "data_source_id" in dev else "ds_dev",
        graph_id=dev["graph_id"], actor="alice",
        package={"fileName": "finance.v1.view-package.zip", "scope": "source", "dataVersion": "published",
                 "views": 1, "bundleHash": "sha256:bundle"})
    prefix = created["result_uri"].rsplit("/", 1)[0]
    await store.put_stream(f"{prefix}/view-bundle.json", _once(BUNDLE))
    summary = await ie.run_export(created["job_id"])
    job = await ie.get_job(created["job_id"])
    assert job["status"] == "completed" and job["resultUri"].endswith("view-package.zip")
    assert job["fileName"] == "finance.v1.view-package.zip" and summary["package"]["bytes"] > 0

    path = os.path.join(root, "copy.zip")
    with open(path, "wb") as f:
        async for chunk in store.open_stream(job["resultUri"]):
            f.write(chunk)
    parsed = read_package(path)
    assert parsed.verified and parsed.bundle == BUNDLE
    assert parsed.manifest["data"] == {"version": "published", "nodes": 2, "edges": 1}

    # ── Import: into another data source, in a draft ─────────────────────────────
    uat = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws_uat", actor="bob")
    uat_gid = uat["graph_id"]
    await svc.apply_ops(graph_id=uat_gid, actor="bob", message="seed", ops=[_n("orders")])
    draft = await svc.open_draft(graph_id=uat_gid, owner="bob", name="Import: Finance")
    job2 = await ie.create_import_job(workspace_id="ws_uat", data_source_id="ds_uat", graph_id=uat_gid,
                                      actor="bob", import_format="ndjson", branch_id=draft, reconcile_mode="upsert")
    await store.put_stream(job2["source_uri"], file_chunks(parsed.data_path))
    os.unlink(parsed.data_path)
    await ie.run_import(job2["job_id"])
    assert (await ie.get_job(job2["job_id"]))["status"] == "completed"

    main_id = await svc.main_branch_id(uat_gid)
    in_draft = await svc.materialize_state(graph_id=uat_gid, branch_id=draft)
    on_main = await svc.materialize_state(graph_id=uat_gid, branch_id=main_id)
    urns = lambda state: sorted(p.get("urn") for p in state["nodes"].values())  # noqa: E731
    assert urns(in_draft) == ["urn:orders", "urn:revenue"] and len(in_draft["edges"]) == 1
    assert urns(on_main) == ["urn:orders"], "nothing lands on main until the draft is published"

    # ── A view checked against the draft finds what the package brought ─────────
    base = VersionedBranchProvider(svc, graph_id=uat_gid, branch_id=main_id, actor="bob")
    overlay = DraftOverlayProvider(base, svc=svc, graph_id=uat_gid, branch_id=draft, actor="bob")
    found = await overlay.resolve_identities(["urn:orders", "urn:revenue", "urn:missing"])
    assert found["urn:revenue"] is not None and found["urn:revenue"]["type"] == "Table"
    assert found["urn:orders"] is not None and found["urn:missing"] is None
    plain = await base_lookup(base, ["urn:revenue"])
    assert plain["urn:revenue"] is None, "published main doesn't have it yet"

    await db.dispose_engine()


async def base_lookup(provider, urns):
    from backend.common.interfaces.provider import resolve_identities_by_query
    return await resolve_identities_by_query(provider, urns)


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_a_package_carries_the_data_into_a_draft():
    with tempfile.TemporaryDirectory() as root:
        asyncio.run(_run(root))
