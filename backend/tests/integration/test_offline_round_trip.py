"""Data managed offline — in Excel, or by a team's own script — comes back reconciled, and every
change in it is either made or refused with a reason — Postgres.

* **Excel.** An export opened in Excel and edited — a property changed, one added, one removed with
  ``\\N``, a name changed, a node and an edge added, an edge deleted — lands as exactly those
  changes. The same workbook sent again changes nothing.
* **A stale workbook.** One exported before a colleague's edits applies only its user's own cells
  and keeps the colleague's: a row whose cell both changed is refused naming the field, and a row
  only the colleague changed stays as they left it.
* **A script.** Rows naming their nodes by the source's own ids (``urn``, no ``baseVersion``) make
  them once; a run with one changed, one deleted and one new row makes just those; a ``replace``
  snapshot deletes what it left out.
* **Nothing silent.** A urn cell edited, an exported edge given a new end, and two rows for one
  node each come back with a reason.

Windows of two rows make every rule cross a window.
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
from backend.app.services.versioning.import_export.resolve import pointer_id
from backend.app.services.versioning.import_export.rowmodel import column_order
from backend.app.services.versioning.import_export.service import ImportExportService
from backend.app.services.versioning.import_export.xlsx_adapter import XlsxAdapter
from backend.app.services.versioning.models import ImportRowORM
from backend.app.services.versioning.service import GraphVersioningService

pytestmark = [pytest.mark.integration, pytest.mark.skipif(
    not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")]

ONTOLOGY = {"node_types": ["Table"], "edge_types": ["LINEAGE"]}
X, Y, Z, V = (f"urn:uuid:0192f5a4-7b3c-7d2e-8f1a-2b3c4d5e6f{n}" for n in ("a1", "a2", "a3", "a4"))


async def _ontology(_ws, _ds):
    return ONTOLOGY


def _node(eid, name, **props):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": eid, "entityType": "Table", "displayName": name,
                        "description": f"{name} d0", "properties": props}}


def _edge(eid, s, t):
    return {"op": "create", "entity_kind": "edge", "entity_id": eid,
            "payload": {"edgeType": "LINEAGE", "sourceEntityId": s, "targetEntityId": t}}


def _set(eid, **payload):
    return {"op": "update", "entity_kind": "node", "entity_id": eid, "payload": payload}


async def _one(body):
    yield body


async def _drain(chunks):
    out = b""
    async for c in chunks:
        out += c
    return out


class _Harness:
    def __init__(self, svc, root):
        self.svc = svc
        self.store = LocalFsObjectStore(root)
        self.ie = ImportExportService(versioning=svc, store=self.store, ontology_resolver=_ontology)

    async def graph(self, ops=()):
        self.ds = "ds_" + os.urandom(4).hex()
        self.gid = (await self.svc.create_graph(data_source_id=self.ds, workspace_id="ws1",
                                                actor="u"))["graph_id"]
        if ops:
            await self.svc.apply_ops(graph_id=self.gid, actor="u", message="seed", ops=list(ops))
        return self.gid

    async def export_xlsx(self):
        """Main, exported as Excel and read back as the rows a user would edit."""
        job = await self.ie.create_export_job(workspace_id="ws1", data_source_id=self.gid,
                                              graph_id=self.gid, actor="u", export_format="xlsx")
        await self.ie.run_export(job["job_id"])
        body = await _drain(self.store.open_stream(job["result_uri"]))
        return [rec async for rec in XlsxAdapter().parse(_one(body))]

    async def upload(self, body, fmt, branch_id=None, mode="upsert"):
        key = storage_key("ws1", self.gid, "job", f"{os.urandom(3).hex()}.{fmt}")
        await self.store.put_stream(key, _one(body))
        job = await self.ie.create_import_job(
            workspace_id="ws1", data_source_id=self.gid, graph_id=self.gid, actor="u",
            import_format=fmt, source_uri=key, reconcile_mode=mode,
            **({"branch_id": branch_id} if branch_id else {}))
        summary = await self.ie.run_import(job["job_id"])
        async with db.graphver_session() as s:
            rows = (await s.execute(select(ImportRowORM.row_index, ImportRowORM.resolved_op,
                                           ImportRowORM.reasons)
                                    .where(ImportRowORM.job_id == job["job_id"]))).all()
        return job["branch_id"], summary, {i: (op, reasons or []) for i, op, reasons in rows}

    async def upload_xlsx(self, records, **kw):
        body = await _drain(XlsxAdapter().write(_records(records), columns=column_order(records)))
        return await self.upload(body, "xlsx", **kw)

    async def upload_ndjson(self, lines, **kw):
        return await self.upload(("\n".join(json.dumps(x) for x in lines) + "\n").encode(),
                                 "ndjson", **kw)

    async def state(self, branch):
        """The draft as it reads: main, with the draft's changes over it."""
        got = await self.svc.materialize_state(graph_id=self.gid, branch_id=branch)
        return got["nodes"], {(e["sourceEntityId"], e["targetEntityId"])
                              for e in got["edges"].values()}


async def _records(records):
    for rec in records:
        yield rec


def _row(records, **match):
    return next(r for r in records if all(r.get(k) == v for k, v in match.items()))


def _counts(summary):
    return {k: summary.get(k, 0) for k in ("new", "updated", "deleted", "unchanged", "invalid")}


async def _excel(h):
    await h.graph([_node(X, "orders", owner="alice", tier="gold"), _node(Y, "revenue", owner="bob"),
                   _node(Z, "legacy"), _edge("urn:uuid:0192f5a4-0000-7000-8000-0000000000e1", X, Y)])
    book = await h.export_xlsx()
    _row(book, kind="node", entity_id=X).update({"prop.owner": "dana", "prop.domain": "sales"})
    _row(book, kind="node", entity_id=Y)["prop.owner"] = "\\N"
    _row(book, kind="node", entity_id=Z)["displayName"] = "legacy, renamed"
    _row(book, kind="edge", source_entity_id=X)["_op"] = "delete"
    book += [{"kind": "node", "urn": "my:new-table", "entityType": "Table", "displayName": "new"},
             {"kind": "edge", "edgeType": "LINEAGE", "sourceUrn": X, "targetUrn": "my:new-table"}]

    draft, summary, _rows = await h.upload_xlsx(book)
    assert _counts(summary) == {"new": 2, "updated": 3, "deleted": 1, "unchanged": 0,
                                "invalid": 0}, summary
    nodes, edges = await h.state(draft)
    new = pointer_id(h.ds, "my:new-table")
    assert nodes[X]["properties"] == {"owner": "dana", "tier": "gold", "domain": "sales"}
    assert "owner" not in nodes[Y]["properties"] and nodes[Z]["displayName"] == "legacy, renamed"
    assert nodes[new]["displayName"] == "new" and edges == {(X, new)}, edges

    # The same workbook again, into the same draft: nothing changes. Its rows are stale now (the
    # draft moved past the versions they were exported at), and each cell its user changed holds
    # what the draft already has. The edge it deleted is gone, so its delete row finds nothing.
    _d, again, rows = await h.upload_xlsx(book, branch_id=draft)
    assert (again["new"], again["updated"], again["deleted"]) == (0, 0, 0), again
    assert [r for r in rows.values() if r[0] == "invalid"] == [("invalid", ["delete edge not found"])]
    assert await h.state(draft) == (nodes, edges)


async def _stale(h):
    await h.graph([_node(X, "orders", owner="alice"), _node(Y, "revenue"),
                   _node(V, "costs", owner="vic"), _node(Z, "legacy")])
    book = await h.export_xlsx()                                       # Monday's export
    await h.svc.apply_ops(graph_id=h.gid, actor="colleague", message="Tuesday", ops=[
        _set(X, properties={"owner": "bob"}), _set(Y, description="theirs"),
        _set(V, properties={"owner": "val"})])
    _row(book, kind="node", entity_id=X)["description"] = "mine"           # Wednesday, offline
    _row(book, kind="node", entity_id=Y)["description"] = "mine too"

    draft, summary, rows = await h.upload_xlsx(book)
    assert _counts(summary) == {"new": 0, "updated": 1, "deleted": 0, "unchanged": 2,
                                "invalid": 1}, summary
    nodes, _ = await h.state(draft)
    assert (nodes[X]["description"], nodes[X]["properties"]["owner"]) == ("mine", "bob")
    assert nodes[Y]["description"] == "theirs", "a cell both changed is not overwritten"
    assert nodes[V]["properties"]["owner"] == "val", "the colleague's edit is not reverted"
    (refused,) = [r for r in rows.values() if r[0] == "invalid"]
    assert refused[1][0].startswith("changed since you exported it: description"), refused


async def _script(h):
    await h.graph()
    run = [{"kind": "node", "urn": f"src:{n}", "entityType": "Table", "displayName": n,
            "prop.owner": "team"} for n in ("a", "b", "c", "e")]
    run += [{"kind": "edge", "edgeType": "LINEAGE", "sourceUrn": "src:a", "targetUrn": "src:b"},
            {"kind": "edge", "edgeType": "LINEAGE", "sourceUrn": "src:b", "targetUrn": "src:c"}]
    draft, first, _ = await h.upload_ndjson(run)
    assert _counts(first)["new"] == 6 and first["invalid"] == 0, first
    _d, again, _ = await h.upload_ndjson(run, branch_id=draft)
    assert _counts(again) == {"new": 0, "updated": 0, "deleted": 0, "unchanged": 6,
                              "invalid": 0}, again

    delta = [{"kind": "node", "urn": "src:a", "entityType": "Table", "prop.owner": "data"},
             {"kind": "node", "urn": "src:e", "entityType": "Table", "_op": "delete"},
             {"kind": "node", "urn": "src:d", "entityType": "Table", "displayName": "d"},
             {"kind": "edge", "edgeType": "LINEAGE", "sourceUrn": "src:a", "targetUrn": "src:d"}]
    _d, changes, _ = await h.upload_ndjson(delta, branch_id=draft)
    assert _counts(changes) == {"new": 2, "updated": 1, "deleted": 1, "unchanged": 0,
                                "invalid": 0}, changes
    nodes, _ = await h.state(draft)
    a, d, e = (pointer_id(h.ds, f"src:{n}") for n in ("a", "d", "e"))
    assert nodes[a]["properties"]["owner"] == "data" and d in nodes and e not in nodes

    snapshot = [r for r in run if r.get("urn") in ("src:a", "src:b") or
                (r["kind"] == "edge" and r["targetUrn"] == "src:b")] + delta[2:]
    _d, replaced, _ = await h.upload_ndjson(snapshot, branch_id=draft, mode="replace")
    nodes, edges = await h.state(draft)
    b = pointer_id(h.ds, "src:b")
    assert set(nodes) == {a, b, d} and edges == {(a, b), (a, d)}, (nodes.keys(), edges)
    assert replaced["deleted"] == 2, replaced                      # src:c, and the edge to it


async def _nothing_silent(h):
    e1 = "urn:uuid:0192f5a4-0000-7000-8000-0000000000e2"
    await h.graph([_node(X, "orders"), _node(Y, "revenue"), _node(Z, "legacy"), _edge(e1, X, Y)])
    book = await h.export_xlsx()
    x = _row(book, kind="node", entity_id=X)
    x.update({"urn": "urn:li:renamed", "displayName": "orders v2"})
    _row(book, kind="edge", entity_id=e1).update({"target_entity_id": Z, "targetUrn": Z})
    book.insert(len([r for r in book if r["kind"] == "node"]),       # last on the Nodes sheet
                {**x, "urn": X, "displayName": "orders v3"})        # a copy of X's row

    _draft, summary, rows = await h.upload_xlsx(book)
    reasons = [r[1] for r in rows.values() if r[1]]
    assert any("urn 'urn:li:renamed' isn't stored" in why for r in reasons for why in r), reasons
    assert any("differ from edge" in r[0] for r in reasons), reasons
    assert any("of this file already names this node" in r[0] for r in reasons), reasons
    assert summary["invalid"] == 2 and summary["updated"] == 1, summary


@pytest.mark.parametrize("scenario", [_excel, _stale, _script, _nothing_silent],
                         ids=["excel", "stale-workbook", "script", "nothing-silent"])
def test_offline_edits_come_back_reconciled(scenario):
    async def run():
        await models.create_schema_and_partitions()
        window, config.IMPORT_COMMIT_WINDOW = config.IMPORT_COMMIT_WINDOW, 2
        root = tempfile.mkdtemp(prefix="offline-round-trip-")
        try:
            await scenario(_Harness(GraphVersioningService(), root))
        finally:
            config.IMPORT_COMMIT_WINDOW = window
            shutil.rmtree(root, ignore_errors=True)
            await db.dispose_engine()
    asyncio.run(run())
