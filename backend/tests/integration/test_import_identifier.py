"""What an import's rows find their entities by (``identifier``), and a recurring snapshot that keeps
every entity's id — Postgres.

Pins:
- A job keeps the identifier it was created with (``jobs.identity_strategy``, the job's
  ``identifier``), and its windows resolve by it. With ``urn``, a row named only by a qualifiedName
  or an identifier value is refused (``no_key``); the urn and the entity id find their node.
- The replace guard: a replace whose file names its entities by another key — it would delete the
  graph and make it again — is refused before it deletes anything, its rows left on the draft,
  however often it is imported into that draft; ``allowMassDelete`` lets it through, and the job's
  ``replaceGuard`` says which, with the counts and the limits. A replace whose first full window
  finds (almost) nothing stops there (``identifier_matched_nothing``).
- By a property (``prop.my_unique_id``): the first import builds its index, and each later one
  catches it up from main's log, so a node made or edited on the canvas is found by its value, never
  made again; a changed value is a new key; a value two nodes hold refuses its rows, naming both; a
  partial upsert by it changes only the fields its rows carry. A dry run waits for the first
  import to build the index; a graph matches by at most ``GRAPHVER_MAX_MATCHING_PROPERTIES``; a
  fork by none yet.
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
from backend.app.services.versioning.import_export.resolve import key_pointer_id, pointer_id
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


#: The property a connector keys its rows by when it names no urn (identifier=prop.my_unique_id).
KEY = "my_unique_id"
#: The identifier a snapshot's rows are built for (``_node``, ``_edge``).
_BY = {"identifier": "urn"}


def _urn(i: int) -> str:
    return f"urn:snap:{i}"


def _node(i: int, changed=()) -> dict:
    """Node ``i`` of the snapshot: ten properties, the ``changed`` ones given a new value. Keyed by
    its urn, or — by ``prop.my_unique_id`` — by that property alone, as a connector with no urns."""
    key = ({f"prop.{KEY}": f"K{i}"} if _BY["identifier"].startswith("prop.")
           else {"urn": _urn(i)})
    return {"kind": "node", **key, "entityType": "Table", "displayName": f"t{i}",
            **{f"prop.p{k}": f"v{i}-{k}" + ("-new" if k in changed else "") for k in range(10)}}


def _edge(i: int, j: int) -> dict:
    if _BY["identifier"].startswith("prop."):
        return {"kind": "edge", "edgeType": "LINEAGE", f"source.{KEY}": f"K{i}",
                f"target.{KEY}": f"K{j}"}
    return {"kind": "edge", "edgeType": "LINEAGE", "sourceUrn": _urn(i), "targetUrn": _urn(j)}


def _id(scope: str, i: int) -> str:
    """The id an import gives node ``i``: derived from its key, whichever the snapshot's is."""
    if _BY["identifier"].startswith("prop."):
        return key_pointer_id(scope, KEY, f"K{i}")
    return pointer_id(scope, _urn(i))


async def _import(ie, store, gid, lines, *, identifier, mode="upsert", branch_id=None,
                  allow_mass_delete=False):
    key = storage_key("ws1", gid, "job", f"{os.urandom(3).hex()}.ndjson")
    body = ("\n".join(json.dumps(x) for x in lines) + "\n").encode()

    async def _one():
        yield body
    await store.put_stream(key, _one())
    job = await ie.create_import_job(workspace_id="ws1", data_source_id=gid, graph_id=gid,
                                     actor="u", import_format="ndjson", source_uri=key,
                                     reconcile_mode=mode, identifier=identifier,
                                     branch_id=branch_id, allow_mass_delete=allow_mass_delete)
    summary = await ie.run_import(job["job_id"])
    return job, summary


async def _run_job(ie, store, gid, lines, **kw):
    """An import run the way the transfer lane runs it, so a refusal fails the job: its row."""
    from backend.app.services.versioning.import_export.import_worker import lease_job
    key = storage_key("ws1", gid, "job", f"{os.urandom(3).hex()}.ndjson")
    body = ("\n".join(json.dumps(x) for x in lines) + "\n").encode()

    async def _one():
        yield body
    await store.put_stream(key, _one())
    kw.setdefault("reconcile_mode", "replace")
    job = await ie.create_import_job(workspace_id="ws1", data_source_id=gid, graph_id=gid,
                                     actor="u", import_format="ndjson", source_uri=key, **kw)
    lease = await lease_job(job["job_id"])
    await ie._run_safe(job["job_id"], lease, ie.run_import)
    return job, await ie.get_job(job["job_id"])


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
    _BY["identifier"] = identifier
    ds = "ds_" + os.urandom(4).hex()
    gid = (await svc.create_graph(data_source_id=ds, workspace_id="ws1", actor="u"))["graph_id"]
    scope = await svc.identity_scope(gid)
    first = [_node(i) for i in range(24)] + [_edge(i, i + 1) for i in range(23)]
    job, summary = await _snapshot(svc, ie, store, gid, first, identifier=identifier, mode="upsert")
    assert (summary["new"], summary["invalid"]) == (47, 0), summary
    assert (await ie.get_job(job["job_id"]))["identifier"] == identifier
    nodes, edges = await _versions(svc, gid)
    ids = {i: _id(scope, i) for i in range(24)}
    assert set(nodes) == set(ids.values()), "each node under the id its key derives"
    if identifier.startswith("prop."):           # no urn: its id; the key kept as a property
        assert all(nodes[ids[i]][-1][1]["urn"] == ids[i]
                   and nodes[ids[i]][-1][1]["properties"][KEY] == f"K{i}" for i in range(24))
    else:
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
        new = _id(scope, i)
        assert [op for op, _p in after[new]] == ["create"], after.get(new)
    assert {k: v for k, v in edges2.items() if k != (ids[0], _id(scope, 24))} == {
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


async def _guard(svc, ie, store, monkeypatch) -> None:
    _BY["identifier"] = "urn"                                 # rows keyed by urn
    monkeypatch.setattr(config, "IMPORT_REPLACE_GUARD_MIN_LIVE", 10)
    monkeypatch.setattr(config, "IMPORT_REPLACE_MIN_MATCH_FRACTION", 0)    # the guard, alone
    ds = "ds_" + os.urandom(4).hex()
    gid = (await svc.create_graph(data_source_id=ds, workspace_id="ws1", actor="u"))["graph_id"]
    await _snapshot(svc, ie, store, gid, [_node(i) for i in range(20)], identifier="urn",
                    mode="upsert")
    # A file whose rows name the same tables by another urn: by identifier=urn it matches nothing.
    other = [{**_node(i), "urn": f"urn:other:{i}"} for i in range(20)]
    job, got = await _run_job(ie, store, gid, other, identifier="urn")
    assert got["status"] == "failed" and got["summary"]["failure"]["code"] == "mass_delete_blocked"
    assert got["summary"]["failure"]["action"] == "allow_mass_delete"
    guard = got["summary"]["replaceGuard"]
    assert (guard["state"], guard["live"], guard["deletes"], guard["creates"]) == (
        "blocked", 20, 20, 20), guard
    assert guard["limits"] == {"minLive": 10, "deleteFraction": 0.5, "createFraction": 0.5}
    assert "Nothing was deleted" in got["errorMessage"] and "allowMassDelete" in got["errorMessage"]
    draft = job["branch_id"]
    async with svc._session() as s:
        live = [e for e, h in (await svc._head_index(s, gid, draft)).items() if h.live]
    assert len(live) == 20, "its rows are on the draft, and nothing was deleted"
    # Imported again into that draft — its rows there already — it is refused all the same.
    _job, again = await _run_job(ie, store, gid, other, identifier="urn", branch_id=draft)
    assert again["summary"]["replaceGuard"]["state"] == "blocked", again["summary"]
    # Sent with allowMassDelete, it deletes what the file leaves out.
    _job, allowed = await _run_job(ie, store, gid, other, identifier="urn", branch_id=draft,
                                   allow_mass_delete=True)
    assert allowed["status"] == "completed" and allowed["allowMassDelete"], allowed
    assert allowed["summary"]["replaceGuard"]["state"] == "overridden"
    assert allowed["summary"]["deleted"] == 20, allowed["summary"]

    # A replace whose first full window finds nothing stops there, before the rest of the file.
    monkeypatch.setattr(config, "IMPORT_REPLACE_MIN_MATCH_FRACTION", 0.05)
    monkeypatch.setattr(config, "IMPORT_COMMIT_WINDOW", 5)
    job, stopped = await _run_job(ie, store, gid, [{**_node(i), "urn": f"urn:third:{i}"}
                                                   for i in range(12)], identifier="urn")
    assert stopped["summary"]["failure"]["code"] == "identifier_matched_nothing", stopped["summary"]
    assert "identifier=urn" in stopped["errorMessage"]
    assert stopped["summary"]["new"] == 5, "only its first window is on the draft"


def _on_canvas(i: int, value: str) -> dict:
    """A node made on the canvas: a urn:uuid id of its own, holding ``value`` of the property."""
    eid = f"urn:uuid:0192f5a4-7b3c-7d2e-8f1a-2b3c4d5e{i:04d}"
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": eid, "entityType": "Table", "displayName": f"ui{i}",
                        "properties": {KEY: value}}}


async def _by_a_property(svc, ie, store, monkeypatch) -> None:
    from backend.app.services.versioning.import_export import keys as matching
    by = f"prop.{KEY}"
    _BY["identifier"] = by
    ds = "ds_" + os.urandom(4).hex()
    gid = (await svc.create_graph(data_source_id=ds, workspace_id="ws1", actor="u"))["graph_id"]
    scope = await svc.identity_scope(gid)
    # A dry run waits for an import to build the property's index.
    with pytest.raises(matching.NotIndexed):
        await ie.validate_import(graph_id=gid, workspace_id="ws1", data_source_id=gid, branch_id=None,
                                 data=json.dumps(_node(0)).encode(), import_format="ndjson",
                                 identifier=by)
    await _snapshot(svc, ie, store, gid, [_node(i) for i in range(4)], identifier=by, mode="upsert")

    # On the canvas, after the index was built: a node holding K-ui; node 1's value changed; and
    # two nodes holding K-dup.
    k1 = key_pointer_id(scope, KEY, "K1")
    await svc.apply_ops(graph_id=gid, actor="alice", message="canvas", ops=[
        _on_canvas(1, "K-ui"), _on_canvas(2, "K-dup"), _on_canvas(3, "K-dup"),
        {"op": "update", "entity_kind": "node", "entity_id": k1,
         "payload": {"properties": {KEY: "K1b"}}}])
    lines = [{**_node(0), "displayName": "zero"},                         # a partial upsert
             {"kind": "node", f"prop.{KEY}": "K-ui", "entityType": "Table", "prop.p0": "seen"},
             {"kind": "node", f"prop.{KEY}": "K1b", "entityType": "Table", "displayName": "one"},
             {"kind": "node", f"prop.{KEY}": "K1", "entityType": "Table", "displayName": "K1 again"},
             {"kind": "node", f"prop.{KEY}": "K-dup", "entityType": "Table", "displayName": "dup"}]
    job, summary = await _import(ie, store, gid, lines, identifier=by)
    async with db.graphver_session() as s:
        res = {r.row_index: r for r in (await s.execute(select(ImportRowORM).where(
            ImportRowORM.job_id == job["job_id"]))).scalars()}
    ui = _on_canvas(1, "K-ui")["entity_id"]
    assert (res[0].resolved_op, res[0].matched_entity_id) == ("update", _id(scope, 0))
    assert (res[1].resolved_op, res[1].matched_entity_id) == ("update", ui), "found, not made again"
    assert (res[2].resolved_op, res[2].matched_entity_id) == ("update", k1), "by its new value"
    assert res[3].resolved_op == "create" and res[3].matched_entity_id != k1, "an old value is new"
    assert (res[4].resolved_op, res[4].code) == ("invalid", "duplicate_value"), res[4].reasons
    assert _on_canvas(2, "")["entity_id"] in res[4].reasons[0]
    # Only the fields the rows carry: node 0's name; the canvas node's p0.
    async with svc._session() as s:
        values = await svc._current_values(s, gid, job["branch_id"], [_id(scope, 0), ui])
    v0, vui = values[_id(scope, 0)], values[ui]
    assert v0["displayName"] == "zero" and v0["properties"]["p1"] == "v0-1", v0
    assert vui["displayName"] == "ui1" and vui["properties"]["p0"] == "seen", vui
    assert vui["properties"][KEY] == "K-ui" and "p1" not in vui["properties"], vui
    # Now it is built, the dry run reads by it.
    out = await ie.validate_import(graph_id=gid, workspace_id="ws1", data_source_id=gid,
                                   branch_id=None, data=json.dumps(lines[1]).encode(),
                                   import_format="ndjson", identifier=by)
    assert out["summary"]["updated"] == 1 and out["identifier"] == by, out

    # At most GRAPHVER_MAX_MATCHING_PROPERTIES properties a graph; none on a fork yet.
    monkeypatch.setattr(config, "MAX_MATCHING_PROPERTIES", 1)
    _job, refused = await _run_job(ie, store, gid, [_node(5)], identifier="prop.other",
                                   reconcile_mode="upsert")
    assert refused["summary"]["failure"]["code"] == "too_many_matching_properties", refused
    fork = (await svc.fork_graph(parent_graph_id=gid, workspace_id="ws1", actor="u"))["graph_id"]
    _job, on_fork = await _run_job(ie, store, fork, [_node(6)], identifier=by,
                                   reconcile_mode="upsert")
    assert on_fork["summary"]["failure"]["code"] == "matching_property_on_fork", on_fork


def test_a_snapshot_replaced_every_run_keeps_every_id_and_writes_only_what_changed(monkeypatch):
    async def run():
        await models.create_schema_and_partitions()
        window, config.IMPORT_COMMIT_WINDOW = config.IMPORT_COMMIT_WINDOW, 7
        root = tempfile.mkdtemp(prefix="import-identifier-")
        try:
            svc = GraphVersioningService()
            ie = ImportExportService(versioning=svc, store=LocalFsObjectStore(root),
                                     ontology_resolver=_ontology, identity_resolver=_identity)
            for identifier in ("entity_id", "urn", f"prop.{KEY}"):
                await _recurring_snapshot(svc, ie, ie.store, identifier)
            await _by_urn_alone(svc, ie, ie.store)
            await _guard(svc, ie, ie.store, monkeypatch)
            await _by_a_property(svc, ie, ie.store, monkeypatch)
        finally:
            config.IMPORT_COMMIT_WINDOW = window
            shutil.rmtree(root, ignore_errors=True)
            await db.dispose_engine()
    asyncio.run(run())
