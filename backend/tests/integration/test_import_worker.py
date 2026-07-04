"""ImportWorker end-to-end (live Postgres): a file becomes reviewable changes on a draft branch.

Proves the core thesis — bulk import is the manual edit flow at scale. Seed ``main`` with node A,
upload an ndjson file that (1) renames A, (2) creates node B, (3) links A->B, then run the import.
The changes must land on a DRAFT (main untouched) and show up in ``branch_overlay_delta`` exactly
as a hand-edited draft would: A updated, B created, edge added — matched by urn/qualifiedName so
the re-import UPDATES A rather than duplicating it.
"""
import asyncio
import json
import os
import shutil
import tempfile

import pytest

from backend.app.services.storage.object_store import LocalFsObjectStore, storage_key
from backend.app.services.versioning import db, models
from backend.app.services.versioning.import_export.service import ImportExportService
from backend.app.services.versioning.service import GraphVersioningService


def _n(eid, urn, qname, dn, etype="Table"):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": urn, "entityType": etype, "displayName": dn, "qualifiedName": qname}}


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    G = await svc.create_graph(
        data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="u")
    gid = G["graph_id"]
    # main: node A (qualifiedName "a")
    await svc.apply_ops(graph_id=gid, actor="u", message="seed",
                        ops=[_n("ent_A", "urn:A", "a", "A")])

    root = tempfile.mkdtemp(prefix="import-e2e-")
    try:
        store = LocalFsObjectStore(root)
        key = storage_key("ws1", G["graph_id"], "job", "source.ndjson")
        lines = [
            {"kind": "node", "urn": "urn:A", "entityType": "Table", "displayName": "A renamed"},
            {"kind": "node", "urn": "urn:B", "entityType": "Table", "displayName": "B",
             "qualifiedName": "b"},
            {"kind": "edge", "edgeType": "LINEAGE", "sourceQualifiedName": "a",
             "targetQualifiedName": "b"},
        ]
        body = ("\n".join(json.dumps(x) for x in lines) + "\n").encode()

        async def _one():
            yield body
        await store.put_stream(key, _one())

        ie = ImportExportService(versioning=svc, store=store)
        job = await ie.create_import_job(
            workspace_id="ws1", data_source_id=G["graph_id"], graph_id=gid, actor="u",
            import_format="ndjson", source_uri=key)
        branch_id = job["branch_id"]

        summary = await ie.run_import(job["job_id"])
        assert summary == {"new": 2, "updated": 1, "deleted": 0, "invalid": 0}, summary

        # main is untouched — the import lives on a draft
        delta = await svc.branch_overlay_delta(graph_id=gid, branch_id=branch_id)
        upsert_urns = {n["urn"] for n in delta["nodesUpsert"]}
        assert {"urn:A", "urn:B"} <= upsert_urns, delta
        assert "urn:B" in delta["nodesNew"], delta                 # B created on the draft
        a = next(n for n in delta["nodesUpsert"] if n["urn"] == "urn:A")
        assert a["displayName"] == "A renamed"                     # A updated, not duplicated

        # edge A->B created (branch_overlay_delta reports endpoints as entity_ids)
        b_eid = next(n["entityId"] for n in delta["nodesUpsert"] if n["urn"] == "urn:B")
        edges = [(e["sourceUrn"], e["targetUrn"], e["edgeType"]) for e in delta["edgesUpsert"]]
        assert ("ent_A", b_eid, "LINEAGE") in edges, delta

        # job records the tally + terminal state
        got = await ie.get_job(job["job_id"])
        assert got["status"] == "completed" and got["summary"]["updated"] == 1

        # re-import the SAME file onto the SAME draft is a no-op diff (idempotent upsert)
        job2 = await ie.create_import_job(
            workspace_id="ws1", data_source_id=G["graph_id"], graph_id=gid, actor="u",
            import_format="ndjson", source_uri=key, branch_id=branch_id)
        summary2 = await ie.run_import(job2["job_id"])
        assert summary2["invalid"] == 0 and summary2["new"] == 0, summary2  # A,B,edge all matched now
    finally:
        shutil.rmtree(root, ignore_errors=True)

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres")
def test_import_worker_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("import worker e2e: OK")
