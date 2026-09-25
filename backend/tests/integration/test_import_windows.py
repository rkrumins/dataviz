"""An import worked a window at a time (live Postgres), with windows of two rows.

The importer resolves and builds every node window, then every edge window, each against the draft
as the windows before it left it, and looks up only what the window's rows name. Proven here on
files that span several windows:

* an edge finds a node a LATER row creates, by urn and by qualifiedName, and an existing edge is
  matched, not duplicated; the tally is what the rows did;
* replace deletes every entity no row matched (edges first) and nothing else;
* a view-scoped replace deletes only the view's own entities;
* a finished import's staged rows are swept once they are old enough;
* a file uploaded in parts imports as the one file it is.
"""
import asyncio
import json
import os
import shutil
import tempfile

import pytest

from backend.app.services.storage.object_store import LocalFsObjectStore, storage_key
from backend.app.services.versioning import config, models
from backend.app.services.versioning.import_export.import_worker import ImportWorker
from backend.app.services.versioning.import_export.service import ImportExportService
from backend.app.services.versioning.service import GraphVersioningService


def _node(eid, urn, qname, name="n"):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": urn, "entityType": "Table", "displayName": name, "qualifiedName": qname}}


def _edge(eid, src, tgt, etype="LINEAGE"):
    return {"op": "create", "entity_kind": "edge", "entity_id": eid,
            "payload": {"edgeType": etype, "sourceEntityId": src, "targetEntityId": tgt}}


async def _graph(svc, ops):
    G = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="u")
    await svc.apply_ops(graph_id=G["graph_id"], actor="u", message="seed", ops=ops)
    return G["graph_id"]


async def _import(ie, store, gid, lines, *, mode="upsert", scope=None, branch_id=None):
    key = storage_key("ws1", gid, os.urandom(4).hex(), "source.ndjson")

    async def body():
        yield ("\n".join(json.dumps(x) for x in lines) + "\n").encode()

    await store.put_stream(key, body())
    job = await ie.create_import_job(workspace_id="ws1", data_source_id=gid, graph_id=gid, actor="u",
                                     import_format="ndjson", source_uri=key, reconcile_mode=mode,
                                     branch_id=branch_id)
    summary = await ImportWorker(ie._svc, store, scope=scope).run(job["job_id"])
    return job["branch_id"], summary


async def _state(svc, gid, branch_id):
    """Live nodes (urn -> displayName) and edges ((source urn, target urn, type)) of the draft."""
    state = await svc.materialize_state(graph_id=gid, branch_id=branch_id)
    urn = {eid: p.get("urn") for eid, p in state["nodes"].items()}
    nodes = {p.get("urn"): p.get("displayName") for p in state["nodes"].values()}
    edges = {(urn.get(p["sourceEntityId"]), urn.get(p["targetEntityId"]), p["edgeType"])
             for p in state["edges"].values()}
    return nodes, edges


async def _windows(svc, ie, store) -> None:
    gid = await _graph(svc, [_node("ent_A", "urn:A", "a", "A"), _node("ent_B", "urn:B", "b", "B"),
                             _edge("edg_AB", "ent_A", "ent_B")])
    lines = [
        {"kind": "edge", "edgeType": "LINEAGE", "sourceQualifiedName": "d", "targetUrn": "urn:E"},
        {"kind": "node", "urn": "urn:A", "entityType": "Table", "displayName": "A2", "qualifiedName": "a"},
        {"kind": "node", "urn": "urn:D", "entityType": "Table", "displayName": "D", "qualifiedName": "d"},
        {"kind": "edge", "edgeType": "LINEAGE", "sourceUrn": "urn:A", "targetUrn": "urn:B"},
        {"kind": "node", "urn": "urn:B", "entityType": "Table", "displayName": "B", "qualifiedName": "b"},
        {"kind": "node", "urn": "urn:E", "entityType": "Table", "displayName": "E", "qualifiedName": "e"},
        {"kind": "edge", "edgeType": "LINEAGE", "sourceQualifiedName": "a", "targetQualifiedName": "d"},
        {"kind": "edge", "edgeType": "LINEAGE", "sourceUrn": "urn:X", "targetUrn": "urn:A"},
    ]
    branch_id, summary = await _import(ie, store, gid, lines)
    # new: D, E, d->E (both its ends made by later rows), a->d; updated: A; unchanged: B, A->B;
    # invalid: the edge from a node nowhere to be found.
    assert summary == {"new": 4, "updated": 1, "unchanged": 2, "deleted": 0, "invalid": 1}, summary
    nodes, edges = await _state(svc, gid, branch_id)
    assert nodes == {"urn:A": "A2", "urn:B": "B", "urn:D": "D", "urn:E": "E"}, nodes
    assert edges == {("urn:A", "urn:B", "LINEAGE"), ("urn:D", "urn:E", "LINEAGE"),
                     ("urn:A", "urn:D", "LINEAGE")}, edges

    # The same file again, onto the same draft: every row is now unchanged, nothing is duplicated.
    _, again = await _import(ie, store, gid, lines, branch_id=branch_id)
    assert again == {"new": 0, "updated": 0, "unchanged": 7, "deleted": 0, "invalid": 1}, again
    assert await _state(svc, gid, branch_id) == (nodes, edges)


async def _replace(svc, ie, store) -> None:
    gid = await _graph(svc, [
        _node("ent_A", "urn:A", "a"), _node("ent_B", "urn:B", "b"), _node("ent_C", "urn:C", "c"),
        _edge("edg_AB", "ent_A", "ent_B"), _edge("edg_BC", "ent_B", "ent_C")])
    branch_id, summary = await _import(ie, store, gid, [
        {"kind": "node", "urn": "urn:A", "entityType": "Table", "displayName": "n", "qualifiedName": "a"},
        {"kind": "node", "urn": "urn:B", "entityType": "Table", "displayName": "n", "qualifiedName": "b"},
        {"kind": "node", "urn": "urn:D", "entityType": "Table", "displayName": "n", "qualifiedName": "d"},
        {"kind": "edge", "edgeType": "LINEAGE", "sourceUrn": "urn:A", "targetUrn": "urn:B"},
    ], mode="replace")
    # C and B->C were in the graph and in no row: deleted. D is new; the rest unchanged.
    assert summary == {"new": 1, "updated": 0, "unchanged": 3, "deleted": 2, "invalid": 0}, summary
    nodes, edges = await _state(svc, gid, branch_id)
    assert set(nodes) == {"urn:A", "urn:B", "urn:D"}, nodes
    assert edges == {("urn:A", "urn:B", "LINEAGE")}, edges


async def _view_replace(svc, ie, store) -> None:
    gid = await _graph(svc, [
        _node("ent_A", "urn:A", "a"), _node("ent_B", "urn:B", "b"), _node("ent_C", "urn:C", "c"),
        _node("ent_X", "urn:X", "x"),
        _edge("edg_AB", "ent_A", "ent_B", "CONTAINS"), _edge("edg_BC", "ent_B", "ent_C", "CONTAINS"),
        _edge("edg_XA", "ent_X", "ent_A")])
    scope = {"assigned_urns": ["urn:A"], "inherit_urns": ["urn:A"], "containment_types": ["CONTAINS"]}
    branch_id, summary = await _import(ie, store, gid, [
        {"kind": "node", "urn": "urn:A", "entityType": "Table", "displayName": "n", "qualifiedName": "a"},
        {"kind": "node", "urn": "urn:B", "entityType": "Table", "displayName": "n", "qualifiedName": "b"},
        {"kind": "edge", "edgeType": "CONTAINS", "sourceUrn": "urn:A", "targetUrn": "urn:B"},
    ], mode="replace", scope=scope)
    # The view holds A, B and C (A's containment subtree): C and B->C go; X and X->A are not the view's.
    assert summary["deleted"] == 2, summary
    nodes, edges = await _state(svc, gid, branch_id)
    assert set(nodes) == {"urn:A", "urn:B", "urn:X"}, nodes
    assert edges == {("urn:A", "urn:B", "CONTAINS"), ("urn:X", "urn:A", "LINEAGE")}, edges


async def _sweep(svc, ie, store) -> None:
    """A finished import's staged rows are swept once it is STAGING_GC_DAYS old, a batch at a time;
    a recent one's and a running one's stay."""
    from sqlalchemy import func, select, update

    from backend.app.services.versioning import db
    from backend.app.services.versioning.import_export.import_worker import sweep_staged_rows
    from backend.app.services.versioning.models import ImportRowORM, JobORM

    gid = await _graph(svc, [_node("ent_A", "urn:A", "a")])
    lines = [{"kind": "node", "urn": f"urn:s{i}", "entityType": "Table", "displayName": "s"} for i in range(5)]
    jobs = []
    for _ in range(3):
        await _import(ie, store, gid, lines)
        jobs.append((await ie.list_jobs(graph_id=gid, job_type="ingest", limit=1))[0]["jobId"])
    old, recent, running = jobs

    async with db.graphver_session() as s:
        await s.execute(update(JobORM).where(JobORM.id.in_([old, running]))
                        .values(completed_at="2000-01-01T00:00:00+00:00"))
        await s.execute(update(JobORM).where(JobORM.id == running).values(status="running"))

    async def staged(job_id):
        async with db.graphver_session() as s:
            return (await s.execute(select(func.count()).where(ImportRowORM.job_id == job_id))).scalar_one()

    assert [await staged(j) for j in jobs] == [5, 5, 5]
    assert await sweep_staged_rows(older_than_days=7, batch=2) >= 5
    assert [await staged(j) for j in jobs] == [0, 5, 5]


async def _parts(svc, ie, store) -> None:
    """A file uploaded in parts (resumable upload) is imported as the one file it is, even with
    rows split across parts."""
    from backend.app.services.versioning.import_export import uploads

    gid = await _graph(svc, [_node("ent_A", "urn:A", "a")])
    data = ("\n".join(json.dumps({"kind": "node", "urn": f"urn:p{i}", "entityType": "Table",
                                   "displayName": f"p{i}"}) for i in range(9)) + "\n").encode()
    record = await uploads.create(store, workspace_id="ws1", data_source_id=gid, graph_id=gid, owner="u",
                                  file_name="parts.ndjson", size=len(data), fmt="ndjson")
    step = record["partBytes"]
    for n in reversed(range(record["parts"])):
        async def body(n=n):
            yield data[n * step:(n + 1) * step]
        await uploads.put_part(store, record, n, body())
    job = await ie.create_import_job(workspace_id="ws1", data_source_id=gid, graph_id=gid, actor="u",
                                     import_format="ndjson", source_uri=uploads.record_key(record))
    summary = await ImportWorker(ie._svc, store).run(job["job_id"])
    assert record["parts"] > 3 and summary["new"] == 9 and summary["invalid"] == 0, (record["parts"], summary)


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    root = tempfile.mkdtemp(prefix="import-windows-")
    try:
        store = LocalFsObjectStore(root)
        ie = ImportExportService(versioning=svc, store=store)
        await _windows(svc, ie, store)
        await _replace(svc, ie, store)
        await _view_replace(svc, ie, store)
        await _sweep(svc, ie, store)
        await _parts(svc, ie, store)
    finally:
        shutil.rmtree(root, ignore_errors=True)


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres")
def test_import_windows_e2e(monkeypatch):
    from backend.app.services.versioning.import_export import uploads

    monkeypatch.setattr(config, "IMPORT_COMMIT_WINDOW", 2)
    monkeypatch.setattr(uploads, "PART_BYTES", 100)          # rows straddle the parts
    asyncio.run(_run())
