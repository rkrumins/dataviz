"""What an import's rows find their entities by (``identifier``), and a recurring snapshot that keeps
every entity's id — Postgres.

Pins:
- A job keeps the identifier it was created with (``jobs.identity_strategy``, the job's
  ``identifier``), and its windows resolve by it. With ``urn``, a row named only by a qualifiedName
  or an identifier value is refused (``no_key``); the urn and the entity id find their node.
- A recurring snapshot, replaced in full and published each run, under each identifier:
  - every entity keeps its id, and so does every edge;
  - a changed entity gets exactly one new version, and it changes only the changed property;
  - an unchanged entity gets no version;
  - a new row is created, keeping its urn, under the id derived from it; a row left out is
    deleted;
  - the same snapshot sent again writes nothing at all;
  - a node and an edge a run deleted, sent again, come back under their own ids.
Windows of seven rows make every rule cross a window.
"""
import asyncio
import json
import os
import shutil
import tempfile

import pytest
from sqlalchemy import select

from backend.app.services.node_identity import ResolvedNodeIdentity
from backend.app.services.storage.object_store import LocalFsObjectStore, storage_key
from backend.app.services.versioning import config, db, models
from backend.app.services.versioning.import_export.resolve import pointer_id
from backend.app.services.versioning.import_export.service import ImportExportService
from backend.app.services.versioning.models import EdgeVersionORM, ImportRowORM, NodeVersionORM
from backend.app.services.versioning.service import GraphVersioningService

pytestmark = [pytest.mark.integration, pytest.mark.skipif(
    not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")]

ONTOLOGY = {"node_types": ["Table"], "edge_types": ["LINEAGE"]}
IDENTITY = ResolvedNodeIdentity(identity_property="asset_id")


async def _ontology(_ws, _ds):
    return ONTOLOGY


async def _identity(_ws, _ds):
    return IDENTITY


def _urn(i: int) -> str:
    return f"urn:snap:{i}"


def _node(i: int, changed=()) -> dict:
    """Node ``i`` of the snapshot: ten properties, the ``changed`` ones given a new value."""
    return {"kind": "node", "urn": _urn(i), "entityType": "Table", "displayName": f"t{i}",
            **{f"prop.p{k}": f"v{i}-{k}" + ("-new" if k in changed else "") for k in range(10)}}


def _edge(i: int, j: int) -> dict:
    return {"kind": "edge", "edgeType": "LINEAGE", "sourceUrn": _urn(i), "targetUrn": _urn(j)}


async def _import(ie, store, gid, lines, *, identifier, mode="upsert"):
    key = storage_key("ws1", gid, "job", f"{os.urandom(3).hex()}.ndjson")
    body = ("\n".join(json.dumps(x) for x in lines) + "\n").encode()

    async def _one():
        yield body
    await store.put_stream(key, _one())
    job = await ie.create_import_job(workspace_id="ws1", data_source_id=gid, graph_id=gid,
                                     actor="u", import_format="ndjson", source_uri=key,
                                     reconcile_mode=mode, identifier=identifier)
    summary = await ie.run_import(job["job_id"])
    return job, summary


async def _versions(svc, gid):
    """Main's versions: ``{node id: [(op, payload)]}`` in commit order, and ``{(source, target):
    edge id}`` of its live edges."""
    main = await svc.main_branch_id(gid)
    async with db.graphver_session() as s:
        rows = (await s.execute(
            select(NodeVersionORM.entity_id, NodeVersionORM.op, NodeVersionORM.payload)
            .where(NodeVersionORM.graph_id == gid, NodeVersionORM.branch_id == main)
            .order_by(NodeVersionORM.commit_seq))).all()
        edges = (await s.execute(
            select(EdgeVersionORM.entity_id, EdgeVersionORM.op, EdgeVersionORM.source_entity_id,
                   EdgeVersionORM.target_entity_id)
            .where(EdgeVersionORM.graph_id == gid, EdgeVersionORM.branch_id == main)
            .order_by(EdgeVersionORM.commit_seq))).all()
    nodes: dict = {}
    for eid, op, payload in rows:
        nodes.setdefault(eid, []).append((op, payload))
    last: dict = {}                              # an edge's last op, at the ends it was made with
    for eid, op, src, tgt in edges:
        ends = last.get(eid, (None, src, tgt))[1:]
        last[eid] = (op, *ends)
    return nodes, {(src, tgt): eid for eid, (op, src, tgt) in last.items() if op != "delete"}


async def _snapshot(svc, ie, store, gid, lines, *, identifier, mode="replace"):
    job, summary = await _import(ie, store, gid, lines, identifier=identifier, mode=mode)
    if any(summary.get(k) for k in ("new", "updated", "deleted")):
        await svc.publish(graph_id=gid, branch_id=job["branch_id"], actor="u", message="snapshot")
    return job, summary


async def _recurring_snapshot(svc, ie, store, identifier: str) -> None:
    ds = "ds_" + os.urandom(4).hex()
    gid = (await svc.create_graph(data_source_id=ds, workspace_id="ws1", actor="u"))["graph_id"]
    scope = await svc.identity_scope(gid)
    first = [_node(i) for i in range(24)] + [_edge(i, i + 1) for i in range(23)]
    job, summary = await _snapshot(svc, ie, store, gid, first, identifier=identifier, mode="upsert")
    assert (summary["new"], summary["invalid"]) == (47, 0), summary
    assert (await ie.get_job(job["job_id"]))["identifier"] == identifier
    nodes, edges = await _versions(svc, gid)
    ids = {i: pointer_id(scope, _urn(i)) for i in range(24)}
    assert set(nodes) == set(ids.values()), "each node under the id its urn derives"
    assert all(nodes[ids[i]][-1][1]["urn"] == _urn(i) for i in range(24)), "its urn as given"

    # The next run: 3 nodes changed in one of ten properties, 3 new ones, node 23 gone (and its
    # edge), a new edge to a new node.
    second = ([_node(i, changed=(3,) if i < 3 else ()) for i in range(23)]
              + [_node(i) for i in (24, 25, 26)]
              + [_edge(i, i + 1) for i in range(22)] + [_edge(0, 24)])
    _job, summary = await _snapshot(svc, ie, store, gid, second, identifier=identifier)
    assert (summary["new"], summary["updated"], summary["invalid"]) == (4, 3, 0), summary
    assert summary["deleted"] == 2, summary                   # node 23 and the edge into it
    after, edges2 = await _versions(svc, gid)
    for i in range(23):
        history = after[ids[i]]
        if i < 3:
            assert [op for op, _p in history] == ["create", "update"], history
            before, now = history[0][1]["properties"], history[1][1]["properties"]
            assert {k for k in before if before[k] != now.get(k)} == {"p3"}, (before, now)
        else:
            assert len(history) == 1, f"node {i} is unchanged, so it has no new version"
    assert [op for op, _p in after[ids[23]]] == ["create", "delete"]
    for i in (24, 25, 26):
        new = pointer_id(scope, _urn(i))
        assert [op for op, _p in after[new]] == ["create"] and after[new][0][1]["urn"] == _urn(i)
    assert {k: v for k, v in edges2.items() if k != (ids[0], pointer_id(scope, _urn(24)))} == {
        k: v for k, v in edges.items() if k != (ids[22], ids[23])}, "every edge keeps its id"

    # The same snapshot again writes nothing.
    _job, summary = await _snapshot(svc, ie, store, gid, second, identifier=identifier)
    assert (summary["new"], summary["updated"], summary["deleted"], summary["invalid"]) == (
        0, 0, 0, 0), summary
    assert await _versions(svc, gid) == (after, edges2)

    # Node 23 and its edge back: each resumes its history under its own id, no second entity.
    _job, summary = await _snapshot(svc, ie, store, gid, second + [_node(23), _edge(22, 23)],
                                    identifier=identifier)
    assert (summary["new"], summary["invalid"]) == (2, 0), summary
    back, edges3 = await _versions(svc, gid)
    assert [op for op, _p in back[ids[23]]] == ["create", "delete", "create"], back[ids[23]]
    assert edges3[(ids[22], ids[23])] == edges[(ids[22], ids[23])], "the edge's own id again"


async def _by_urn_alone(svc, ie, store) -> None:
    ds = "ds_" + os.urandom(4).hex()
    gid = (await svc.create_graph(data_source_id=ds, workspace_id="ws1", actor="u"))["graph_id"]
    await svc.apply_ops(graph_id=gid, actor="u", message="seed", ops=[
        {"op": "create", "entity_kind": "node", "entity_id": "ent_A",
         "payload": {"urn": "urn:A", "entityType": "Table", "displayName": "A",
                     "qualifiedName": "db.a"}}])
    lines = [{"kind": "node", "urn": "urn:A", "entityType": "Table", "displayName": "A by urn"},
             {"kind": "node", "entity_id": "ent_A", "entityType": "Table", "displayName": "A by id"},
             {"kind": "node", "qualifiedName": "db.a", "entityType": "Table", "displayName": "q"},
             {"kind": "node", "entityType": "Table", "displayName": "i", "prop.asset_id": "X-1"}]
    job, summary = await _import(ie, store, gid, lines, identifier="urn")
    async with db.graphver_session() as s:
        rows = dict((await s.execute(select(ImportRowORM.row_index, ImportRowORM.code).where(
            ImportRowORM.job_id == job["job_id"], ImportRowORM.resolved_op == "invalid"))).all())
    # The first two rows both name A (a second, differing row for it is refused as such).
    assert rows == {1: "named_already", 2: "no_key", 3: "no_key"}, rows
    assert (await ie.get_job(job["job_id"]))["identifier"] == "urn"


def test_a_snapshot_replaced_every_run_keeps_every_id_and_writes_only_what_changed():
    async def run():
        await models.create_schema_and_partitions()
        window, config.IMPORT_COMMIT_WINDOW = config.IMPORT_COMMIT_WINDOW, 7
        root = tempfile.mkdtemp(prefix="import-identifier-")
        try:
            svc = GraphVersioningService()
            ie = ImportExportService(versioning=svc, store=LocalFsObjectStore(root),
                                     ontology_resolver=_ontology, identity_resolver=_identity)
            for identifier in ("entity_id", "urn"):
                await _recurring_snapshot(svc, ie, ie.store, identifier)
            await _by_urn_alone(svc, ie, ie.store)
        finally:
            config.IMPORT_COMMIT_WINDOW = window
            shutil.rmtree(root, ignore_errors=True)
            await db.dispose_engine()
    asyncio.run(run())
