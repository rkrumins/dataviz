"""What an imported delete takes with it — Postgres.

A row's ``_op=delete`` deletes the node, the edges on it, and what it contains (its containment
subtree, by the ontology's containment types), as a delete on the canvas does. A replace deletes
what its file leaves out, and nothing the file names goes with an absent container: a child a row
names stays, without its parent.
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

pytestmark = pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"),
                                reason="set GRAPHVER_E2E=1 + a live Postgres to run")

P = "urn:uuid:0193a1b2-0000-7000-8000-0000000000c1"
C = "urn:uuid:0193a1b2-0000-7000-8000-0000000000c2"
G = "urn:uuid:0193a1b2-0000-7000-8000-0000000000c4"


async def _ontology(_ws, _ds):
    return {"node_types": ["Schema", "Table", "Column"], "edge_types": ["CONTAINS"],
            "containment": ["CONTAINS"]}


def _node(eid, urn, etype):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": urn, "entityType": etype, "displayName": urn}}


def _contains(eid, parent, child):
    return {"op": "create", "entity_kind": "edge", "entity_id": eid,
            "payload": {"edgeType": "CONTAINS", "sourceEntityId": parent, "targetEntityId": child}}


async def _setup():
    """A schema that contains a table, which contains a column, on main."""
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    root = tempfile.mkdtemp()
    ie = ImportExportService(versioning=svc, store=LocalFsObjectStore(root), ontology_resolver=_ontology)
    ds = "ds_delsub_" + os.urandom(4).hex()
    gid = (await svc.create_graph(data_source_id=ds, workspace_id="ws1", actor="u"))["graph_id"]
    await svc.apply_ops(graph_id=gid, actor="u", message="seed", containment_edge_types=["CONTAINS"],
                        ops=[_node(P, "urn:p", "Schema"), _node(C, "urn:c", "Table"),
                             _node(G, "urn:g", "Column"),
                             _contains("urn:uuid:0193a1b2-0000-7000-8000-0000000000c3", P, C),
                             _contains("urn:uuid:0193a1b2-0000-7000-8000-0000000000c5", C, G)])
    return svc, ie, root, ds, gid


async def _import(ie, ds, gid, rows, **kw):
    body = "".join(json.dumps(r) + "\n" for r in rows).encode()
    key = storage_key("ws1", ds, gid, "job", os.urandom(4).hex() + ".ndjson")

    async def one():
        yield body
    await ie.store.put_stream(key, one())
    job = await ie.create_import_job(workspace_id="ws1", data_source_id=ds, graph_id=gid, actor="u",
                                     import_format="ndjson", source_uri=key, **kw)
    await ie.run_import(job["job_id"])
    return job


async def _run_a_deleted_node_takes_what_it_contains():
    svc, ie, root, ds, gid = await _setup()
    try:
        job = await _import(ie, ds, gid, [
            {"kind": "node", "urn": "urn:p", "entityType": "Schema", "_op": "delete"}])
        draft = await svc.materialize_state(graph_id=gid, branch_id=job["branch_id"])
        assert sorted(draft["nodes"]) == [], draft["nodes"]
        assert draft["edges"] == {}, draft["edges"]
    finally:
        shutil.rmtree(root, ignore_errors=True)
        await db.dispose_engine()


def test_a_deleted_node_takes_what_it_contains():
    asyncio.run(_run_a_deleted_node_takes_what_it_contains())


async def _run_a_replace_keeps_a_child_its_file_names():
    svc, ie, root, ds, gid = await _setup()
    try:
        job = await _import(ie, ds, gid, [
            {"kind": "node", "entity_id": C, "urn": "urn:c", "entityType": "Table"},
            {"kind": "node", "entity_id": G, "urn": "urn:g", "entityType": "Column"},
            {"kind": "edge", "edgeType": "CONTAINS", "source_entity_id": C, "target_entity_id": G},
        ], reconcile_mode="replace")
        draft = await svc.materialize_state(graph_id=gid, branch_id=job["branch_id"])
        assert sorted(draft["nodes"]) == sorted([C, G]), draft["nodes"]
        assert [e["targetEntityId"] for e in draft["edges"].values()] == [G], draft["edges"]
    finally:
        shutil.rmtree(root, ignore_errors=True)
        await db.dispose_engine()


def test_a_replace_keeps_a_child_its_file_names():
    asyncio.run(_run_a_replace_keeps_a_child_its_file_names())
