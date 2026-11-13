"""An import gives each new node one identity and finds what it names — needs Postgres.

The server decides a new node's identity: the deleted node its row's urn names brought back, else
an id derived from the row's urn (or its value of the data source's identifier property). The node
keeps the urn its row gives — its id when it gives none — and its identifier property holds the
urn. A row that gives nothing a later import could find it by (only the file's own entity_id, or
only a unique field's value) is refused rather than made again by every import. A row and an
edge's end name an existing node by its id, its urn, its identifier value or a field its type
matches imports by (a team's own key). Re-importing the same file updates what it created.
"""
import asyncio
import json
import os
import shutil
import tempfile
import uuid

import pytest

from backend.app.services.node_identity import ResolvedNodeIdentity
from backend.app.services.storage.object_store import LocalFsObjectStore, storage_key
from sqlalchemy import select

from backend.app.services.versioning import db, models
from backend.app.services.versioning.import_export.resolve import pointer_id
from backend.app.services.versioning.models import ImportRowORM
from backend.app.services.versioning.import_export.service import ImportExportService
from backend.app.services.versioning.service import GraphVersioningService

pytestmark = [pytest.mark.integration, pytest.mark.skipif(
    not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")]

CONT = ["CONTAINS"]
ONTOLOGY = {"node_types": ["Schema", "Table"], "edge_types": ["CONTAINS", "LINEAGE"],
            "keys": {"Table": ["sap_id"]}, "unique": {"Table": ["serial"]}}
IDENTITY = ResolvedNodeIdentity(identity_property="asset_id")


def _node(eid, urn, etype="Table", **props):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": urn, "entityType": etype, "displayName": urn.split(":")[-1],
                        **({"properties": props} if props else {})}}


FILE = [
    {"kind": "node", "urn": "urn:C", "entityType": "Table", "displayName": "C"},
    {"kind": "node", "entityType": "Table", "displayName": "N9", "prop.asset_id": "A-9"},
    {"kind": "node", "entity_id": "file-1", "entityType": "Table", "displayName": "F1"},
    {"kind": "node", "urn": "urn:D", "entityType": "Table", "displayName": "D back"},
    {"kind": "node", "entityType": "Table", "displayName": "K renamed", "prop.sap_id": "S-1"},
    {"kind": "node", "urn": "urn:X", "entityType": "Table", "displayName": "X", "prop.asset_id": "Y"},
    {"kind": "node", "entityType": "Table", "displayName": "U1", "prop.serial": "SN-1"},
    {"kind": "node", "entityType": "Table", "displayName": "U2", "prop.serial": "SN-1"},
    {"kind": "edge", "edgeType": "CONTAINS", "sourceUrn": "urn:P", "target_entity_id": "file-1"},
    {"kind": "edge", "edgeType": "LINEAGE", "source.sap_id": "S-1", "targetUrn": "urn:L"},
    {"kind": "edge", "edgeType": "LINEAGE", "source.asset_id": "A-9", "targetUrn": "urn:C"},
]


async def _ontology(_ws, _ds):
    return ONTOLOGY


async def _identity(_ws, _ds):
    return IDENTITY


async def _import(ie, store, gid, lines, branch_id=None):
    key = storage_key("ws1", gid, "job", f"{os.urandom(3).hex()}.ndjson")
    body = ("\n".join(json.dumps(x) for x in lines) + "\n").encode()

    async def _one():
        yield body
    await store.put_stream(key, _one())
    job = await ie.create_import_job(workspace_id="ws1", data_source_id=gid, graph_id=gid,
                                     actor="u", import_format="ndjson", source_uri=key,
                                     **({"branch_id": branch_id} if branch_id else {}))
    summary = await ie.run_import(job["job_id"])
    return job, summary, await ie.get_job(job["job_id"])


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(),
                                  workspace_id="ws1", actor="u"))["graph_id"]
    # main: schema P and table L as an import keyed them; table K made on the canvas (id == urn),
    # carrying a team key; and D, deleted since.
    await svc.apply_ops(graph_id=gid, actor="u", message="seed", containment_edge_types=CONT,
                        ops=[_node("ent_P", "urn:P", "Schema"), _node("ent_L", "urn:L"),
                             _node("urn:K", "urn:K", sap_id="S-1"), _node("ent_D", "urn:D")])
    await svc.apply_ops(graph_id=gid, actor="u", message="drop D",
                        ops=[{"op": "delete", "entity_kind": "node", "entity_id": "ent_D",
                              "payload": None}])
    root = tempfile.mkdtemp(prefix="import-identity-")
    try:
        store = LocalFsObjectStore(root)
        ie = ImportExportService(versioning=svc, store=store, ontology_resolver=_ontology,
                                 identity_resolver=_identity)
        job, summary, got = await _import(ie, store, gid, FILE)
        draft = job["branch_id"]
        async with db.graphver_session() as s:
            refused = dict((await s.execute(select(ImportRowORM.row_index, ImportRowORM.code).where(
                ImportRowORM.job_id == job["job_id"], ImportRowORM.resolved_op == "invalid"))).all())
        # file-1 is named only by the file's own id, U1 and U2 only by a unique field: neither
        # finds its node again, so neither is made; nor is the edge to file-1, which says that its
        # end's own row was refused (end_refused).
        assert refused == {2: "no_key", 6: "no_key", 7: "no_key", 8: "end_refused"}, (
            refused, got.get("summary"))
        scope = await svc.identity_scope(gid)
        c, a9, x = (pointer_id(scope, p) for p in ("urn:C", "A-9", "urn:X"))

        async with svc._session() as s:
            heads = await svc._head_index(s, gid, draft)
        live = {eid: h for eid, h in heads.items() if h.live and h.kind == "node"}

        async def value(eid):
            async with svc._session() as s:
                return (await svc._current_values(s, gid, draft, [eid])).get(eid)

        # A urn, an identifier value, both (urn:X beside asset_id Y): an id derived from the first;
        # the urn kept, or the id when there is none; the identifier property holding the urn.
        for eid, urn in ((c, "urn:C"), (a9, a9), (x, "urn:X")):
            v = await value(eid)
            assert v["urn"] == urn and v["properties"]["asset_id"] == urn, v
            assert uuid.UUID(eid[len("urn:uuid:"):]).version == 5
        # The urn only a deleted node held brings that node back — never a second urn:D.
        assert (await value("ent_D"))["urn"] == "urn:D" and "urn:D" not in live
        # A team key named the canvas node: renamed, its identity its own.
        k = await value("urn:K")
        assert k["displayName"] == "K renamed" and k["urn"] == "urn:K"
        assert not any(h.name in ("F1", "U1", "U2") for h in live.values()), "a refused row wrote"

        edges = {(h.src, h.tgt, h.type) for h in heads.values() if h.kind == "edge" and h.live}
        assert ("urn:K", "ent_L", "LINEAGE") in edges, edges      # by a team key
        assert (a9, c, "LINEAGE") in edges, edges                 # by the identifier value

        assert got["summary"]["invalid"] == summary["invalid"] == 4, got["summary"]

        # The same rows again (those that carry an identity): updated, never doubled.
        again = [line for line in FILE if line.get("urn") or line.get("prop.asset_id")
                 or line.get("prop.sap_id")]
        _job2, summary2, _ = await _import(ie, store, gid, again, branch_id=draft)
        assert summary2["new"] == 0, summary2
        async with svc._session() as s:
            heads2 = await svc._head_index(s, gid, draft)
        assert sum(1 for h in heads2.values() if h.live and h.kind == "node") == len(live)
    finally:
        shutil.rmtree(root, ignore_errors=True)
        await db.dispose_engine()


def test_an_import_gives_each_new_node_one_identity_and_finds_what_it_names():
    asyncio.run(_run())
