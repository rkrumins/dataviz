"""The keys a file carries find its entities, and importing a file again changes nothing — Postgres.

A row's urn, and its value of the data source's identifier property, point at its node: a node
that carries one as its urn, or one an earlier import made from it. A new node keeps the urn its
row gives, under an id derived from its first key (a ``urn:uuid:`` v5 of the graph's identity
scope, its data source, and the key), so the same file imported again finds every node it made;
the identifier property holds the urn, and an identifier value is a key, not stored. A file's own
``entity_id`` links its rows (an edge to a node) and nothing more, so a row named by nothing else
is refused (``no_key``) rather than made again by every import. A free ``urn:uuid:`` is kept as
the id. Properties are set by value, kept by a blank cell and removed by ``\\N``; a row is deleted
by its key. Windows of two rows make every rule cross a window.
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

from backend.app.services.versioning import config, db, models
from backend.app.services.versioning.import_export.import_worker import ImportWorker
from backend.app.services.versioning.models import ImportRowORM
from backend.app.services.versioning.import_export.resolve import pointer_id
from backend.app.services.versioning.import_export.service import ImportExportService
from backend.app.services.versioning.service import GraphVersioningService

pytestmark = [pytest.mark.integration, pytest.mark.skipif(
    not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")]

ONTOLOGY = {"node_types": ["Table"], "edge_types": ["LINEAGE"]}
IDENTITY = ResolvedNodeIdentity(identity_property="asset_id")
FREE = "urn:uuid:0192f5a4-7b3c-7d2e-8f1a-2b3c4d5e6f70"

FILE = [
    {"kind": "node", "urn": "urn:li:t1", "entityType": "Table", "displayName": "t1",
     "prop.asset_id": "A-1", "prop.owner": "a"},                    # a urn, and a second name
    {"kind": "node", "entityType": "Table", "displayName": "t2", "prop.asset_id": "A-2"},
    {"kind": "node", "entity_id": "f3", "entityType": "Table", "displayName": "t3"},  # file-local
    {"kind": "node", "urn": FREE, "entityType": "Table", "displayName": "t4"},
    {"kind": "edge", "edgeType": "LINEAGE", "sourceUrn": "urn:li:t1", "target.asset_id": "A-2"},
    {"kind": "edge", "edgeType": "LINEAGE", "source_entity_id": "f3", "targetUrn": "urn:li:t1"},
    {"kind": "edge", "edgeType": "LINEAGE", "source.asset_id": "A-1", "targetUrn": FREE},
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
    return job, summary


async def _refused(job_id):
    """``{row: code}`` of the rows an import refused."""
    async with db.graphver_session() as s:
        return dict((await s.execute(select(ImportRowORM.row_index, ImportRowORM.code).where(
            ImportRowORM.job_id == job_id, ImportRowORM.resolved_op == "invalid"))).all())


async def _state(svc, gid, draft):
    async with svc._session() as s:
        heads = await svc._head_index(s, gid, draft)
        nodes = [e for e, h in heads.items() if h.live and h.kind == "node"]
        values = await svc._current_values(s, gid, draft, nodes)
    edges = {(h.src, h.tgt) for h in heads.values() if h.live and h.kind == "edge"}
    return values, edges


async def _run(svc, root) -> None:
    ds = "ds_" + os.urandom(4).hex()
    gid = (await svc.create_graph(data_source_id=ds, workspace_id="ws1", actor="u"))["graph_id"]
    assert await svc.identity_scope(gid) == ds
    store = LocalFsObjectStore(root)
    ie = ImportExportService(versioning=svc, store=store, ontology_resolver=_ontology,
                             identity_resolver=_identity)
    t1, t2 = pointer_id(ds, "urn:li:t1"), pointer_id(ds, "A-2")

    job, summary = await _import(ie, store, gid, FILE)
    draft = job["branch_id"]
    # t3 is named only by the file's own id, and so is the edge from it: refused, rather than made
    # again by every import (and deleted by every replace).
    assert (summary["new"], summary["invalid"]) == (5, 2), summary
    assert await _refused(job["job_id"]) == {2: "no_key", 5: "end_not_found"}
    nodes, edges = await _state(svc, gid, draft)
    assert set(nodes) == {t1, t2, FREE}, nodes
    # t1 keeps its urn, and the identifier property holds it; a node with no urn of its own (t2,
    # named by its identifier value; a free urn:uuid) has its id as its urn.
    assert (nodes[t1]["urn"], nodes[t1]["properties"]["asset_id"]) == ("urn:li:t1", "urn:li:t1")
    for eid in (t2, FREE):
        assert nodes[eid]["urn"] == eid and nodes[eid]["properties"]["asset_id"] == eid, nodes[eid]
    assert uuid.UUID(t1[len("urn:uuid:"):]).version == 5
    assert not any({"A-1", "A-2"} & {v["urn"], v["properties"].get("asset_id")}
                   for v in nodes.values()), "an identifier value is a key: not stored"
    assert nodes[t1]["properties"]["owner"] == "a"
    assert edges == {(t1, t2), (t1, FREE)}, edges

    # The identity state a resumed run reads again: the second name a row gave its node.
    worker = ImportWorker(svc, store, ontology=ONTOLOGY, node_identity=IDENTITY)
    await worker._identity_state(job["job_id"], None, gid, draft)   # no team keys: no pass
    assert worker._created_from == {} and worker._aliases == {"A-1": t1}, (
        worker._created_from, worker._aliases)
    # Placements key each created node by the urn it was stored with.
    await worker._derive_facts(job["job_id"], gid, draft)
    assert {f["eid"]: f["urn"] for f in worker.created_node_facts} == {
        t1: "urn:li:t1", t2: t2, FREE: FREE}

    # The same file again changes nothing: every node and edge is found, the same rows refused.
    again_job, again = await _import(ie, store, gid, FILE, branch_id=draft)
    assert (again["new"], again["updated"], again["invalid"]) == (0, 0, 2), again
    assert await _refused(again_job["job_id"]) == {2: "no_key", 5: "end_not_found"}
    assert await _state(svc, gid, draft) == (nodes, edges)

    # Properties: set by value, kept by a blank, removed by \N; a delete and a create by pointer.
    _job, props = await _import(ie, store, gid, [
        {"kind": "node", "urn": "urn:li:t1", "entityType": "Table", "displayName": "",
         "prop.owner": "\\N", "prop.tier": "gold"},
        {"kind": "node", "urn": FREE.upper(), "entityType": "Table", "displayName": "t4 again"},
        {"kind": "node", "prop.asset_id": "A-2", "entityType": "Table", "_op": "delete"},
    ], branch_id=draft)
    assert (props["updated"], props["deleted"], props["new"]) == (2, 1, 0), props
    nodes3, _ = await _state(svc, gid, draft)
    assert nodes3[t1]["displayName"] == "t1" and "owner" not in nodes3[t1]["properties"]
    assert nodes3[t1]["properties"]["tier"] == "gold"
    assert nodes3[FREE]["displayName"] == "t4 again" and t2 not in nodes3
    _job, back = await _import(ie, store, gid, [
        {"kind": "node", "prop.asset_id": "A-2", "entityType": "Table", "displayName": "t2"}],
        branch_id=draft)
    nodes4, _ = await _state(svc, gid, draft)
    assert back["new"] == 1 and t2 in nodes4, "a re-created node takes its id back"

    # An export's rows name each node by its own id: edited and imported again, it updates.
    _job, edited = await _import(ie, store, gid, [
        {"kind": "node", "entity_id": t1, "urn": "urn:li:t1", "entityType": "Table",
         "displayName": "T1", "prop.asset_id": "urn:li:t1"}], branch_id=draft)
    nodes5, _ = await _state(svc, gid, draft)
    assert edited["updated"] == 1 and nodes5[t1]["displayName"] == "T1"

    # A fork shares its root's ids: an import into it derives them from the root's data source.
    fork = (await svc.fork_graph(parent_graph_id=gid, workspace_id="ws1", actor="u"))["graph_id"]
    assert await svc.identity_scope(fork) == ds


def test_file_ids_are_pointers_and_an_import_again_changes_nothing():
    async def run():
        await models.create_schema_and_partitions()
        window, config.IMPORT_COMMIT_WINDOW = config.IMPORT_COMMIT_WINDOW, 2
        root = tempfile.mkdtemp(prefix="import-pointers-")
        try:
            await _run(GraphVersioningService(), root)
        finally:
            config.IMPORT_COMMIT_WINDOW = window
            shutil.rmtree(root, ignore_errors=True)
            await db.dispose_engine()
    asyncio.run(run())
