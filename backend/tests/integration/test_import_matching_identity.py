"""Which node a row matched by a property (``identifier=prop.<name>``) is — Postgres.

Pins:
- A new node's urn another node holds refuses its row (``two_entities``, naming that node): a live
  node's, or one an earlier row of the file makes, in its window or an earlier one. The row with
  that node's entity_id changes its value.
- A draft behind main matches as it sees the graph: a node main deleted after the draft's base is
  still the draft's, matched and updated rather than made again over itself, keeping what the row
  doesn't carry; one main gave another value keeps its old one there. So too when main deletes it
  while the import runs, and another import catches the index up past that.
- A build of an index that ends after another build's catch-up moved the index past its own commit
  leaves no stale value: the catch-up after it applies the log again over its rows.
- A dry run against main reads main's index alone, no head of main, and a value only a deleted node
  held brings that node back, as an import does.
- A dry run refuses an edge whose end's value two nodes hold as ``duplicate_value``, as the import
  does, not ``end_not_found``.
- After a stale row's update kept the node's newer value of a cell left as exported, a later window
  finds the node by that newer value.
"""
import asyncio
import json
import os
import shutil
import tempfile

import pytest
from sqlalchemy import select

from backend.app.services.storage.object_store import LocalFsObjectStore, storage_key
from backend.app.services.versioning import config, db, models
from backend.app.services.versioning.import_export import keys as matching
from backend.app.services.versioning.import_export.import_worker import ImportWorker
from backend.app.services.versioning.import_export.service import ImportExportService
from backend.app.services.versioning.import_export.snapshot import open_snapshot
from backend.app.services.versioning.models import ImportRowORM, NodeVersionORM
from backend.app.services.versioning.service import GraphVersioningService

pytestmark = [pytest.mark.integration, pytest.mark.skipif(
    not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")]

ONTOLOGY = {"node_types": ["Table"], "edge_types": ["FLOWS"]}
KEY = "ext"
BY = f"prop.{KEY}"


async def _ontology(_ws, _ds):
    return ONTOLOGY


def _ndjson(lines) -> bytes:
    return ("\n".join(json.dumps(x) for x in lines) + "\n").encode()


def _node(value, **kw) -> dict:
    return {"kind": "node", f"prop.{KEY}": value, "entityType": "Table", **kw}


def _canvas(i: int, value: str) -> dict:
    """A node made on the canvas: a urn:uuid id of its own, holding ``value`` of the property."""
    eid = f"urn:uuid:0192f5a4-7b3c-7d2e-8f1a-2b3c4d5e{i:04d}"
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": eid, "entityType": "Table", "displayName": f"ui{i}",
                        "properties": {KEY: value}}}


async def _graph(svc) -> str:
    ds = "ds_" + os.urandom(4).hex()
    return (await svc.create_graph(data_source_id=ds, workspace_id="ws1", actor="u"))["graph_id"]


async def _import(ie, gid, lines, *, branch_id=None):
    """An import by the property: its job, and its rows by file row."""
    key = storage_key("ws1", gid, "job", f"{os.urandom(3).hex()}.ndjson")
    body = _ndjson(lines)

    async def _one():
        yield body
    await ie.store.put_stream(key, _one())
    job = await ie.create_import_job(workspace_id="ws1", data_source_id=gid, graph_id=gid,
                                     actor="u", import_format="ndjson", source_uri=key,
                                     reconcile_mode="upsert", identifier=BY, branch_id=branch_id)
    await ie.run_import(job["job_id"])
    async with db.graphver_session() as s:
        rows = {r.row_index: r for r in (await s.execute(select(ImportRowORM).where(
            ImportRowORM.job_id == job["job_id"]))).scalars()}
    return job, rows


async def _seed(svc, ie, gid, lines):
    """``lines`` imported and published: main holds them, and the property's index is built."""
    job, rows = await _import(ie, gid, lines)
    await svc.publish(graph_id=gid, branch_id=job["branch_id"], actor="u", message="seed")
    return [rows[i].matched_entity_id for i in range(len(lines))]


async def _validate(ie, gid, lines):
    out = await ie.validate_import(graph_id=gid, workspace_id="ws1", data_source_id=gid,
                                   branch_id=None, data=_ndjson(lines), import_format="ndjson",
                                   identifier=BY)
    return {r["rowIndex"]: r for r in out["rows"]}


def _run(body, *args):
    async def run():
        await models.create_schema_and_partitions()
        root = tempfile.mkdtemp(prefix="import-matching-")
        try:
            svc = GraphVersioningService()
            ie = ImportExportService(versioning=svc, store=LocalFsObjectStore(root),
                                     ontology_resolver=_ontology)
            await body(svc, ie, *args)
        finally:
            shutil.rmtree(root, ignore_errors=True)
            await db.dispose_engine()
    asyncio.run(run())


def test_a_new_nodes_urn_another_node_holds_refuses_its_row(monkeypatch):
    async def body(svc, ie):
        monkeypatch.setattr(config, "IMPORT_COMMIT_WINDOW", 3)
        gid = await _graph(svc)
        [orders] = await _seed(svc, ie, gid, [_node("E1", urn="urn:li:dataset:orders")])
        # The source system gave the asset another ext, and the file sends it beside the asset's
        # urn; then two new values with one urn, the second in row 1's window, the third after it.
        job, rows = await _import(ie, gid, [
            _node("E2", urn="urn:li:dataset:orders"), _node("A", urn="urn:li:x"),
            _node("B", urn="urn:li:x"), _node("C", urn="urn:li:x")])
        assert (rows[0].resolved_op, rows[0].code) == ("invalid", "two_entities"), rows[0].reasons
        assert orders in rows[0].reasons[0] and "entity_id" in rows[0].reasons[0], rows[0].reasons
        made = rows[1].matched_entity_id
        assert rows[1].resolved_op == "create"
        for i in (2, 3):
            assert (rows[i].code, made in rows[i].reasons[0]) == ("two_entities", True), rows[i].reasons
        # With its entity_id, the row changes the node's value.
        _job, again = await _import(ie, gid, [_node("E2", entity_id=orders, urn="urn:li:dataset:orders")],
                                    branch_id=job["branch_id"])
        assert (again[0].resolved_op, again[0].matched_entity_id) == ("update", orders)
    _run(body)


def test_a_draft_behind_main_matches_the_nodes_it_holds():
    async def body(svc, ie):
        gid = await _graph(svc)
        x, y = await _seed(svc, ie, gid, [_node("A", displayName="x", **{"prop.keep": "x1"}),
                                          _node("B", displayName="y")])
        draft = await svc.open_draft(graph_id=gid, owner="u")
        # After the draft's base, on main: x deleted, y given another value.
        await svc.apply_ops(graph_id=gid, actor="alice", message="canvas", ops=[
            {"op": "delete", "entity_kind": "node", "entity_id": x, "payload": None},
            {"op": "update", "entity_kind": "node", "entity_id": y,
             "payload": {"properties": {KEY: "B2"}}}])
        _job, rows = await _import(ie, gid, [_node("A", displayName="x again"),
                                             _node("B", displayName="y again"),
                                             _node("B2", displayName="new")], branch_id=draft)
        assert (rows[0].resolved_op, rows[0].matched_entity_id) == ("update", x), "x is the draft's"
        assert (rows[1].resolved_op, rows[1].matched_entity_id) == ("update", y), "y holds B there"
        assert rows[2].resolved_op == "create" and rows[2].matched_entity_id not in (x, y)
        async with svc._session() as s:
            values = await svc._current_values(s, gid, draft, [x])
        assert values[x]["displayName"] == "x again" and values[x]["properties"]["keep"] == "x1", values
    _run(body)


def test_a_node_main_deletes_while_an_import_runs_is_still_the_drafts(monkeypatch):
    async def body(svc, ie):
        monkeypatch.setattr(config, "IMPORT_COMMIT_WINDOW", 1)
        gid = await _graph(svc)
        [x] = await _seed(svc, ie, gid, [_node("A", displayName="x")])
        real = ImportWorker._apply_window
        windows = []

        async def apply_window(self, *args, **kw):
            await real(self, *args, **kw)
            windows.append(1)
            if len(windows) == 1:       # main deletes x, and another import catches the index up
                await svc.apply_ops(graph_id=gid, actor="alice", message="canvas", ops=[
                    {"op": "delete", "entity_kind": "node", "entity_id": x, "payload": None}])
                await matching.ensure(gid, KEY)
        monkeypatch.setattr(ImportWorker, "_apply_window", apply_window)
        _job, rows = await _import(ie, gid, [_node("Z", displayName="z"),
                                             _node("A", displayName="x again")])
        assert (rows[1].resolved_op, rows[1].matched_entity_id) == ("update", x), rows[1].reasons
    _run(body)


def test_a_build_ending_after_another_builds_catch_up_leaves_no_stale_value(monkeypatch):
    async def body(svc, ie):
        gid = await _graph(svc)
        node = _canvas(1, "v1")
        x = node["entity_id"]
        await svc.apply_ops(graph_id=gid, actor="alice", message="canvas", ops=[node])
        before = (await open_snapshot(graph_id=gid)).as_of_seq
        await svc.apply_ops(graph_id=gid, actor="alice", message="canvas", ops=[
            {"op": "update", "entity_kind": "node", "entity_id": x,
             "payload": {"properties": {KEY: "v2"}}}])
        real = matching.open_snapshot

        async def slower(**_kw):
            """A build that read main before x's change, and wrote its page only after another
            build ended and caught the index up past it."""
            snap = await real(graph_id=gid, as_of_seq=before)
            pages = snap.iter_live

            async def iter_live(kind, payload=False, limit=None):
                await matching._catch_up(gid, KEY)
                async for page in pages(kind, payload, limit):
                    yield page
            snap.iter_live = iter_live
            return snap
        monkeypatch.setattr(matching, "open_snapshot", slower)
        await matching.ensure(gid, KEY)
        assert await matching.lookup(gid, KEY, ["v1", "v2"]) == {"v2": [(x, True)]}
    _run(body)


def test_a_dry_run_against_main_reads_mains_index_alone(monkeypatch):
    async def body(svc, ie):
        gid = await _graph(svc)
        [a] = await _seed(svc, ie, gid, [_node("A", displayName="a")])
        gone = _canvas(1, "GONE")
        await svc.apply_ops(graph_id=gid, actor="alice", message="canvas", ops=[gone])
        await svc.apply_ops(graph_id=gid, actor="alice", message="canvas", ops=[
            {"op": "delete", "entity_kind": "node", "entity_id": gone["entity_id"], "payload": None}])
        read = []
        real = matching.draft_values

        async def spy(graph_id, branch_id, name):
            read.append(branch_id)
            return await real(graph_id, branch_id, name)
        monkeypatch.setattr(matching, "draft_values", spy)
        rows = await _validate(ie, gid, [_node("GONE", displayName="back"),
                                         _node("A", displayName="a2")])
        assert read == [], "main's index is main's view: no head of main is read"
        assert (rows[0]["op"], rows[0]["matchedEntityId"]) == ("create", gone["entity_id"]), rows[0]
        assert (rows[1]["op"], rows[1]["matchedEntityId"]) == ("update", a), rows[1]
    _run(body)


def test_a_dry_run_refuses_an_edge_whose_end_two_nodes_hold_as_the_import_does():
    async def body(svc, ie):
        gid = await _graph(svc)
        await _seed(svc, ie, gid, [_node("T", displayName="t")])
        await svc.apply_ops(graph_id=gid, actor="alice", message="canvas",
                            ops=[_canvas(2, "DUP"), _canvas(3, "DUP")])
        rows = await _validate(ie, gid, [{"kind": "edge", "edgeType": "FLOWS",
                                          f"source.{KEY}": "DUP", f"target.{KEY}": "T"}])
        assert (rows[0]["op"], rows[0]["code"]) == ("invalid", "duplicate_value"), rows[0]
    _run(body)


def test_a_stale_rows_update_leaves_the_node_found_by_the_value_it_keeps(monkeypatch):
    async def body(svc, ie):
        monkeypatch.setattr(config, "IMPORT_COMMIT_WINDOW", 1)
        gid = await _graph(svc)
        [x] = await _seed(svc, ie, gid, [_node("A", displayName="x", **{"prop.colour": "red"})])
        async with db.graphver_session() as s:
            exported = await s.scalar(select(NodeVersionORM.content_hash).where(
                NodeVersionORM.graph_id == gid, NodeVersionORM.entity_id == x)
                .order_by(NodeVersionORM.commit_seq.desc()).limit(1))
        await svc.apply_ops(graph_id=gid, actor="alice", message="canvas", ops=[
            {"op": "update", "entity_kind": "node", "entity_id": x,
             "payload": {"properties": {KEY: "B"}}}])
        # The exported row, its ext left as exported and its colour edited; then, a window later,
        # a row naming x by the value it now holds.
        _job, rows = await _import(ie, gid, [
            _node("A", entity_id=x, baseVersion=exported, displayName="x", **{"prop.colour": "blue"}),
            _node("B", displayName="x")])
        assert (rows[0].resolved_op, rows[0].matched_entity_id) == ("update", x), rows[0].reasons
        assert (rows[1].resolved_op, rows[1].matched_entity_id) == ("unchanged", x), (
            rows[1].resolved_op, rows[1].reasons)
    _run(body)
