"""Export -> re-import round-trip (live Postgres): export IS a re-importable backup.

Seed graph A (2 nodes + a lineage edge), export it to an ndjson artifact, verify the artifact
carries the identity + qualified-name columns, then import that artifact into a FRESH graph B and
confirm B reconstructs the same nodes + edge on a draft — a faithful clone/restore driven entirely
by the exported file.
"""
import asyncio
import json
import os
import shutil
import tempfile

import pytest

from backend.app.services.storage.object_store import LocalFsObjectStore
from backend.app.services.versioning import db, models
from backend.app.services.versioning.import_export.service import ImportExportService
from backend.app.services.versioning.service import GraphVersioningService


def _n(eid, urn, qname, dn):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": urn, "entityType": "Table", "displayName": dn, "qualifiedName": qname}}


def _e(eid, s, t):
    return {"op": "create", "entity_kind": "edge", "entity_id": eid,
            "payload": {"edgeType": "LINEAGE", "sourceEntityId": s, "targetEntityId": t}}


async def _drain(aiter):
    out = b""
    async for c in aiter:
        out += c
    return out


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    A = await svc.create_graph(data_source_id="ds_A_" + os.urandom(4).hex(), workspace_id="ws1", actor="u")
    gA = A["graph_id"]
    await svc.apply_ops(graph_id=gA, actor="u", message="seed", ops=[
        _n("ent_A", "urn:A", "a", "A"), _n("ent_B", "urn:B", "b", "B"), _e("ev_1", "ent_A", "ent_B")])

    root = tempfile.mkdtemp(prefix="export-rt-")
    try:
        store = LocalFsObjectStore(root)
        ie = ImportExportService(versioning=svc, store=store)

        # ---- export A ----
        exp = await ie.create_export_job(
            workspace_id="ws1", data_source_id=A["graph_id"], graph_id=gA, actor="u",
            export_format="ndjson")
        summary = await ie.run_export(exp["job_id"])
        assert summary["nodes"] == 2 and summary["edges"] == 1 and summary["bytes"] > 0, summary

        # ---- the artifact carries identity + qualified names (re-importable) ----
        raw = (await _drain(store.open_stream(exp["result_uri"]))).decode()
        recs = [json.loads(l) for l in raw.splitlines() if l.strip()]
        nodes = [r for r in recs if r["kind"] == "node"]
        edges = [r for r in recs if r["kind"] == "edge"]
        assert {n["urn"] for n in nodes} == {"urn:A", "urn:B"}
        assert all("entity_id" in n and "qualifiedName" in n for n in nodes)
        assert edges[0]["sourceQualifiedName"] == "a" and edges[0]["targetQualifiedName"] == "b"

        # ---- clone: import the artifact into a FRESH graph B ----
        B = await svc.create_graph(data_source_id="ds_B_" + os.urandom(4).hex(), workspace_id="ws1", actor="u")
        gB = B["graph_id"]
        imp = await ie.create_import_job(
            workspace_id="ws1", data_source_id=B["graph_id"], graph_id=gB, actor="u",
            import_format="ndjson", source_uri=exp["result_uri"])
        s2 = await ie.run_import(imp["job_id"])
        assert s2 == {"new": 3, "updated": 0, "unchanged": 0, "deleted": 0, "invalid": 0}, s2

        delta = await svc.branch_overlay_delta(graph_id=gB, branch_id=imp["branch_id"])
        assert {n["urn"] for n in delta["nodesUpsert"]} == {"urn:A", "urn:B"}, delta
        assert len(delta["edgesUpsert"]) == 1 and delta["edgesUpsert"][0]["edgeType"] == "LINEAGE"
    finally:
        shutil.rmtree(root, ignore_errors=True)

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres")
def test_export_roundtrip_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("export -> re-import round-trip e2e: OK")
