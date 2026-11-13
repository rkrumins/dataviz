"""The Import & Export API guide's walkthroughs, sent to the real routes — Postgres.

``docs/IMPORT_EXPORT_API.md`` walks a developer through exporting a graph, editing it offline and
importing it back, once for each ``identifier``. This sends the guide's requests over HTTP, runs
each job as the versioning worker's transfer lane runs it, and holds the routes to what the guide
shows:

* **By entity_id** (the default): a CSV export, edited offline — a cell changed, a property
  removed with ``\\N``, an added column filled, a node deleted with the rows of its edges, a node
  and an edge added — while a colleague changed two descriptions. The dry run and the import agree:
  the colleague's description stays, the cell both changed is refused (``changed_since_export``),
  and clearing that row's ``baseVersion`` overwrites it. Every entity keeps its id, a new row takes
  the id its urn derives, only the changed rows get a version, and the same file sent again writes
  nothing and publishes nothing.
* **By urn**: a catalog's nightly NDJSON snapshot, sent as a resumable upload and then as one
  request, replaced in full and published by the import itself. The dry run refuses a row with no
  urn (``no_key``); a node the snapshot leaves out is deleted with its edge; a request sent again
  with its ``idempotencyKey`` answers with its job; the same snapshot again writes nothing.
* **By prop.external_id**: an ERP's CSV with no urns. A dry run before the property is indexed is
  409 ``identifier_not_indexed``; the first import indexes it; a partial file changes only the
  columns it carries; a node made in the app since is found by its value, not made again; values
  resolve to ids without importing.
* **Edge cases**: every refusal a dry run gives; an edge row kept beside its node's delete, which
  the import refuses (``end_not_found``); a replace with a refused row, which deletes nothing; and
  the request refusals the guide lists.
"""
import asyncio
import csv
import io
import json
import os
import shutil
import tempfile

import pytest
from sqlalchemy import func, select

from backend.app.services.versioning import db, models

pytestmark = [pytest.mark.integration, pytest.mark.skipif(
    not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")]

WS = "ws1"
V1 = f"/api/v1/{WS}/versioning"
ONTOLOGY = {"node_types": ["Table"], "edge_types": ["FLOWS_TO"]}
_PUBLISHER = ("workspace:datasource:read", "workspace:datasource:manage",
              "workspace:datasource:publish")


async def _ontology(_ws, _ds):
    return ONTOLOGY


def _app(root):
    """The versioning routes, signed in as a publisher of ``ws1`` (``u_test``), with the API's own
    import service: its publish hook and node identity, the Export graph data switch on."""
    from backend.app.api.v1.endpoints import versioning as V
    from backend.app.services.storage.object_store import LocalFsObjectStore
    from backend.app.services.versioning.import_export.service import ImportExportService

    from .test_api_graph_draft_journey import _build_app

    app, graph_router = _build_app()
    ie = ImportExportService(versioning=V.get_versioning_service(), store=LocalFsObjectStore(root),
                             ontology_resolver=_ontology, publish_hook=V._publish_from_job,
                             identity_resolver=V._resolve_node_identity_for_import)
    app.dependency_overrides[V.get_import_export_service] = lambda: ie
    app.dependency_overrides[V._GATE_GRAPH_EXPORT] = lambda: None
    return app, graph_router, ie


async def _lane(ie, job_id: str) -> None:
    """Run a queued job as the transfer lane runs it: leased, then through its entry point."""
    from backend.app.services.versioning.import_export.import_worker import lease_job
    from backend.app.services.versioning.import_export.runner import TransferRunner
    await TransferRunner(lambda: ie).run_job(await lease_job(job_id))


def _ok(response, status: int = 200):
    assert response.status_code == status, (response.status_code, response.text)
    return response.json()


def _ndjson(*records) -> bytes:
    return "".join(json.dumps(r) + "\n" for r in records).encode()


def _csv(rows, columns) -> bytes:
    out = io.StringIO()
    writer = csv.DictWriter(out, fieldnames=columns, lineterminator="\n")
    writer.writeheader()
    writer.writerows({c: r.get(c, "") for c in columns} for r in rows)
    return out.getvalue().encode()


class _Guide:
    """The client, the import service, and what a walkthrough looks up on its graph."""

    def __init__(self, client, ie, svc):
        self.c, self.ie, self.svc = client, ie, svc

    async def graph(self) -> tuple:
        """A new graph, for a data source of its own."""
        ds = "ds_guide_" + os.urandom(4).hex()
        gid = (await self.svc.create_graph(data_source_id=ds, workspace_id=WS, actor="u_test"))["graph_id"]
        return ds, gid, await self.svc.identity_scope(gid)

    async def imported(self, gid: str, body: bytes, **params):
        """``POST …/imports``, the job run, then ``GET …/imports/{jobId}``."""
        job = _ok(await self.c.post(f"{V1}/graphs/{gid}/imports", params=params, content=body), 202)
        assert job["status"] == "pending", job
        await _lane(self.ie, job["jobId"])
        return job, _ok(await self.c.get(f"{V1}/graphs/{gid}/imports/{job['jobId']}"))

    async def published(self, gid: str, branch: str, message: str) -> dict:
        return _ok(await self.c.post(f"{V1}/graphs/{gid}/branches/{branch}/publish",
                                     json={"message": message}))

    async def published_itself(self, gid: str, job: dict) -> dict:
        """An ``autoPublish`` import's publish job, run, as ``GET …/publish-jobs/{jobId}`` says."""
        note = job["summary"]["publish"]
        assert note["state"] == "queued", job["summary"]
        await _lane(self.ie, note["jobId"])
        return _ok(await self.c.get(f"{V1}/graphs/{gid}/publish-jobs/{note['jobId']}"))

    async def dry_run(self, gid: str, body: bytes, status: int = 200, **params):
        return _ok(await self.c.post(f"{V1}/graphs/{gid}/imports/validate", params=params,
                                     content=body), status)

    async def main(self, gid: str) -> dict:
        """Main's live state: ``{entity id: payload}`` of nodes and of edges."""
        main_id = await self.svc.main_branch_id(gid)
        state = await self.svc.materialize_state(graph_id=gid, branch_id=main_id)
        return {**state["nodes"], **state["edges"]}

    async def versions(self, gid: str) -> dict:
        """``{entity id: how many versions main holds of it}``, nodes and edges."""
        from backend.app.services.versioning.models import EdgeVersionORM, NodeVersionORM
        main_id = await self.svc.main_branch_id(gid)
        out: dict = {}
        async with db.graphver_session() as s:
            for orm in (NodeVersionORM, EdgeVersionORM):
                out.update((await s.execute(
                    select(orm.entity_id, func.count()).where(orm.graph_id == gid, orm.branch_id == main_id)
                    .group_by(orm.entity_id))).all())
        return out


def _counts(summary: dict) -> dict:
    return {k: summary.get(k, 0) for k in ("new", "updated", "unchanged", "deleted", "invalid")}


def _codes(answer: dict) -> dict:
    """A dry run's or a preview's listed rows: ``{row index: (op, code)}``."""
    rows = answer.get("rows", answer.get("sample"))
    return {r["rowIndex"]: (r["op"], r["code"]) for r in rows}


# ── Walkthrough 1: by entity_id ─────────────────────────────────────────────────────────────────

SALES = {n: f"urn:acme:table:sales.{n}" for n in ("orders", "customers", "orders_2019", "refunds")}
_LOADED = [  # what a connector loaded by urn, before the walkthrough starts
    {"kind": "node", "urn": SALES["orders"], "entityType": "Table", "displayName": "orders",
     "qualifiedName": "sales.orders", "description": "One row per order", "prop.owner": "alice",
     "prop.tier": "gold"},
    {"kind": "node", "urn": SALES["customers"], "entityType": "Table", "displayName": "customers",
     "qualifiedName": "sales.customers", "description": "One row per customer", "prop.owner": "bob"},
    {"kind": "node", "urn": SALES["orders_2019"], "entityType": "Table", "displayName": "orders_2019",
     "qualifiedName": "sales.orders_2019", "description": "Orders placed before 2020",
     "prop.owner": "alice"},
    {"kind": "edge", "edgeType": "FLOWS_TO", "sourceUrn": SALES["customers"], "targetUrn": SALES["orders"]},
    {"kind": "edge", "edgeType": "FLOWS_TO", "sourceUrn": SALES["orders_2019"], "targetUrn": SALES["orders"]},
]


def _row(rows, **match) -> dict:
    return next(r for r in rows if all(r.get(k) == v for k, v in match.items()))


async def _by_entity_id(g: _Guide) -> dict:
    from backend.app.services.versioning.import_export.resolve import edge_pointer_id, pointer_id
    _ds, gid, scope = await g.graph()
    job, loaded = await g.imported(gid, _ndjson(*_LOADED), format="ndjson", identifier="urn")
    await g.published(gid, job["branchId"], "Load the sales tables")
    ids = {n: pointer_id(scope, urn) for n, urn in SALES.items()}

    # 1. Export, with an empty prop.domain column to fill.
    export = _ok(await g.c.post(f"{V1}/graphs/{gid}/exports",
                                params={"format": "csv", "props": "domain"}), 202)
    assert export["status"] == "pending", export
    await _lane(g.ie, export["jobId"])
    done = _ok(await g.c.get(f"{V1}/graphs/{gid}/exports/{export['jobId']}"))
    assert done["status"] == "completed" and done["kept"] is True, done
    assert (done["summary"]["nodes"], done["summary"]["edges"]) == (3, 2), done["summary"]
    download = await g.c.get(f"{V1}/graphs/{gid}/exports/{export['jobId']}/download")
    assert download.status_code == 200, download.text
    text = download.content.decode("utf-8-sig")
    columns = next(csv.reader([text.splitlines()[0]]))
    rows = list(csv.DictReader(io.StringIO(text)))
    assert columns[:3] == ["kind", "entity_id", "urn"] and columns[-1] == "_op", columns
    assert {"baseVersion", "source_entity_id", "targetUrn", "prop.domain", "prop.owner",
            "prop.tier"} <= set(columns), columns
    nodes = {r["urn"]: r for r in rows if r["kind"] == "node"}
    assert {u: r["entity_id"] for u, r in nodes.items()} == {
        SALES[n]: ids[n] for n in ("orders", "customers", "orders_2019")}, "the ids the load gave them"
    assert all(r["baseVersion"] for r in rows) and all(not r["prop.domain"] for r in rows)
    edge = edge_pointer_id(scope, ids["customers"], ids["orders"], "FLOWS_TO")
    assert _row(rows, kind="edge", source_entity_id=ids["customers"])["entity_id"] == edge

    # Meanwhile, a colleague changes two descriptions and publishes them.
    await g.svc.apply_ops(graph_id=gid, actor="colleague", message="Clarify descriptions", ops=[
        {"op": "update", "entity_kind": "node", "entity_id": ids["orders"],
         "payload": {"description": "One row per order, net of refunds"}},
        {"op": "update", "entity_kind": "node", "entity_id": ids["customers"],
         "payload": {"description": "Every customer we have billed"}}])

    # 2. Edit the file offline.
    orders = _row(rows, urn=SALES["orders"])
    orders.update({"prop.owner": "dana", "prop.tier": "\\N", "prop.domain": "sales"})
    _row(rows, urn=SALES["customers"])["description"] = "Customers who have placed an order"
    old = _row(rows, urn=SALES["orders_2019"])
    old["_op"] = "delete"
    rows = [r for r in rows if not (r["kind"] == "edge" and r["source_entity_id"] == old["entity_id"])]
    rows += [{"kind": "node", "urn": SALES["refunds"], "entityType": "Table", "displayName": "refunds",
              "qualifiedName": "sales.refunds", "description": "One row per refund",
              "prop.owner": "dana"},
             {"kind": "edge", "edgeType": "FLOWS_TO", "source_entity_id": ids["orders"],
              "targetUrn": SALES["refunds"]}]
    edited = _csv(rows, columns)

    # 3. The dry run: what the import would do, and nothing written.
    checked = await g.dry_run(gid, edited, format="csv")
    assert (checked["identifier"], checked["identifierSource"], checked["checkedAgainst"]) == (
        "entity_id", "platform", "main"), checked
    assert checked["summary"] == {"new": 2, "updated": 1, "unchanged": 1, "deleted": 1, "invalid": 1,
                                  "skipped": 0}, checked["summary"]
    refused = [r for r in checked["rows"] if r["op"] == "invalid"]
    assert [(r["matchedEntityId"], r["code"]) for r in refused] == [(ids["customers"], "changed_since_export")]
    assert refused[0]["reasons"][0].startswith("changed since you exported it: description"), refused
    new = {r["kind"]: r["matchedEntityId"] for r in checked["rows"] if r["op"] == "create"}
    assert new == {"node": ids["refunds"],
                   "edge": edge_pointer_id(scope, ids["orders"], ids["refunds"], "FLOWS_TO")}, new
    assert checked["unknownColumns"] == [] and not checked["rowsTruncated"]

    # 4. Import it: one request, into a draft of its own.
    job, got = await g.imported(gid, edited, format="csv")
    assert (got["status"], got["identifier"], got["importSettings"]["identifierSource"]) == (
        "completed", "entity_id", "platform"), got
    assert _counts(got["summary"]) == {"new": 2, "updated": 1, "unchanged": 1, "deleted": 1,
                                       "invalid": 1}, got["summary"]
    preview = _ok(await g.c.get(f"{V1}/graphs/{gid}/imports/{job['jobId']}/preview"))
    assert [(r["op"], r["code"]) for r in preview["sample"] if r["op"] == "invalid"] == [
        ("invalid", "changed_since_export")], preview["sample"]
    branch = job["branchId"]

    # 5. Keep your own description: the row again, its baseVersion cleared, into the same draft.
    mine = {**_row(rows, urn=SALES["customers"]), "baseVersion": ""}
    _job, fixed = await g.imported(gid, _csv([mine], columns), format="csv", branchId=branch)
    assert _job["branchId"] == branch and _counts(fixed["summary"]) == {
        "new": 0, "updated": 1, "unchanged": 0, "deleted": 0, "invalid": 0}, fixed["summary"]

    # 6. Review the draft, then publish it.
    review = _ok(await g.c.get(f"{V1}/graphs/{gid}/diff/summary", params={"branchId": branch}))
    assert (review["counts"]["added"], review["counts"]["modified"], review["counts"]["removed"]) == (
        2, 2, 2), review["counts"]               # orders_2019 went with the edge into orders
    landed = await g.published(gid, branch, "Sales tables: owners and refunds")
    assert landed["commitId"] and landed["status"] == "completed", landed

    state = await g.main(gid)
    assert state[ids["orders"]]["properties"] == {"owner": "dana", "domain": "sales", "name": "orders"}
    assert state[ids["orders"]]["description"] == "One row per order, net of refunds", "theirs, kept"
    assert state[ids["customers"]]["description"] == "Customers who have placed an order"
    assert ids["orders_2019"] not in state and ids["refunds"] in state
    assert state[ids["refunds"]]["urn"] == SALES["refunds"], "a new node keeps its urn"
    history = _ok(await g.c.get(f"{V1}/graphs/{gid}/entities/{ids['orders']}/history",
                                params={"scope": "published"}))
    assert len(history["versions"]) == 3, history          # loaded, the colleague's, yours
    before = await g.versions(gid)

    # 7. The same file again, publishing itself: nothing to write, nothing to publish.
    _job, again = await g.imported(gid, edited, format="csv", autoPublish="true")
    assert _counts(again["summary"]) == {"new": 0, "updated": 0, "unchanged": 6, "deleted": 0,
                                         "invalid": 0}, again["summary"]
    assert await g.versions(gid) == before, "a row that changes nothing writes nothing"
    mark = _ok(await g.c.get(f"{V1}/graphs/{gid}/watermark"))
    # Nothing committed: main's head, the commit and revision that hold the file's content.
    assert again["summary"]["publish"] == {"state": "unchanged", "commitId": landed["commitId"],
                                           "revisionId": mark["committed"]}, again["summary"]
    assert mark["committed"] == landed["revisionId"], (mark, landed)
    return {"gid": gid, "ids": ids, "scope": scope, "edge": edge, "loaded": loaded}


# ── Walkthrough 2: by urn ───────────────────────────────────────────────────────────────────────

SHOP = {n: f"urn:li:dataset:shop.{n}" for n in ("orders", "customers", "payments", "refunds", "invoices")}


def _shop_node(name: str, owner: str) -> dict:
    return {"kind": "node", "urn": SHOP[name], "entityType": "Table", "displayName": name,
            "prop.owner": owner}


def _shop_edge(source: str, target: str) -> dict:
    return {"kind": "edge", "edgeType": "FLOWS_TO", "sourceUrn": SHOP[source], "targetUrn": SHOP[target]}


NIGHT_1 = [_shop_node("orders", "alice"), _shop_node("customers", "bob"),
           _shop_node("payments", "carol"), _shop_edge("customers", "orders"),
           _shop_edge("payments", "orders")]
_INVOICES_NO_URN = {"kind": "node", "qualifiedName": "shop.invoices", "entityType": "Table",
                    "displayName": "invoices", "prop.owner": "carol"}
NIGHT_2 = [_shop_node("orders", "alice"), _shop_node("customers", "dana"), _shop_node("refunds", "carol"),
           _INVOICES_NO_URN, _shop_edge("customers", "orders"), _shop_edge("orders", "refunds")]
NIGHT_2_FIXED = [*NIGHT_2[:3], _shop_node("invoices", "carol"), *NIGHT_2[4:]]


async def _by_urn(g: _Guide) -> dict:
    from backend.app.services.versioning.import_export.resolve import edge_pointer_id, pointer_id
    ds, gid, scope = await g.graph()
    found = _ok(await g.c.get(f"{V1}/resolve", params={"dataSourceId": ds}))
    assert found["graphId"] == gid, found
    ids = {n: pointer_id(scope, urn) for n, urn in SHOP.items()}
    replace = {"identifier": "urn", "reconcileMode": "replace", "autoPublish": "true"}

    # Night 1, as a resumable upload: one part for a file this small.
    body = _ndjson(*NIGHT_1)
    upload = _ok(await g.c.post(f"{V1}/graphs/{gid}/imports/uploads",
                                json={"fileName": "catalog.ndjson", "size": len(body), "format": "ndjson"}), 201)
    assert (upload["parts"], upload["received"], upload["partBytes"]) == (1, [], 16 * 1024 * 1024), upload
    part = _ok(await g.c.put(f"{V1}/graphs/{gid}/imports/uploads/{upload['uploadId']}/parts/0",
                             content=body))
    assert (part["part"], part["size"], part["lastPart"]) == (0, len(body), 0), part
    status = _ok(await g.c.get(f"{V1}/graphs/{gid}/imports/uploads/{upload['uploadId']}"))
    assert status["received"] == [0], status
    job = _ok(await g.c.post(f"{V1}/graphs/{gid}/imports/uploads/{upload['uploadId']}/complete",
                             params=replace), 202)
    again = _ok(await g.c.post(f"{V1}/graphs/{gid}/imports/uploads/{upload['uploadId']}/complete",
                               params=replace), 202)
    assert again["jobId"] == job["jobId"], "an upload is imported once"
    await _lane(g.ie, job["jobId"])
    night_1 = _ok(await g.c.get(f"{V1}/graphs/{gid}/imports/{job['jobId']}"))
    assert (night_1["identifier"], _counts(night_1["summary"])) == ("urn", {
        "new": 5, "updated": 0, "unchanged": 0, "deleted": 0, "invalid": 0}), night_1
    landed = await g.published_itself(gid, night_1)
    assert landed["status"] == "completed" and landed["commitId"], landed
    state = await g.main(gid)
    assert {n: state[ids[n]]["urn"] for n in ("orders", "customers", "payments")} == {
        n: SHOP[n] for n in ("orders", "customers", "payments")}, "each keeps its urn, under its id"

    # Night 2: a dry run first. invoices has no urn.
    checked = await g.dry_run(gid, _ndjson(*NIGHT_2), format="ndjson", identifier="urn")
    assert (checked["identifier"], checked["identifierSource"]) == ("urn", "request"), checked
    assert _codes(checked)[3] == ("invalid", "no_key"), checked["rows"]
    assert checked["summary"]["invalid"] == 1, checked["summary"]

    # Fixed, and sent as one request with an idempotencyKey.
    key = {**replace, "format": "ndjson", "idempotencyKey": "catalog-2026-11-13"}
    job, night_2 = await g.imported(gid, _ndjson(*NIGHT_2_FIXED), **key)
    assert _counts(night_2["summary"]) == {"new": 3, "updated": 1, "unchanged": 2, "deleted": 2,
                                           "invalid": 0}, night_2["summary"]
    guard = night_2["summary"]["replaceGuard"]
    assert (guard["state"], guard["live"], guard["deletes"]) == ("passed", 5, 2), guard
    retried = _ok(await g.c.post(f"{V1}/graphs/{gid}/imports", params=key,
                                 content=_ndjson(*NIGHT_2_FIXED)), 202)
    assert (retried["jobId"], retried["branchId"]) == (job["jobId"], job["branchId"]), retried
    landed_2 = await g.published_itself(gid, night_2)
    assert landed_2["status"] == "completed", landed_2
    state = await g.main(gid)
    assert ids["payments"] not in state and state[ids["customers"]]["properties"]["owner"] == "dana"
    assert state[ids["refunds"]]["urn"] == SHOP["refunds"] and ids["invoices"] in state
    assert edge_pointer_id(scope, ids["payments"], ids["orders"], "FLOWS_TO") not in state
    assert edge_pointer_id(scope, ids["orders"], ids["refunds"], "FLOWS_TO") in state
    before = await g.versions(gid)

    # Night 3: the same catalog. Nothing changes, so nothing is written or published.
    _job, night_3 = await g.imported(gid, _ndjson(*NIGHT_2_FIXED), **{
        **key, "idempotencyKey": "catalog-2026-11-14"})
    assert _counts(night_3["summary"]) == {"new": 0, "updated": 0, "unchanged": 6, "deleted": 0,
                                           "invalid": 0}, night_3["summary"]
    note = night_3["summary"]["publish"]
    head = _ok(await g.c.get(f"{V1}/graphs/{gid}/watermark"))
    assert (note["state"], note["commitId"], note["revisionId"]) == (
        "unchanged", head["committedRevision"]["commitId"], head["committed"]), note
    assert await g.versions(gid) == before
    return {"gid": gid, "ids": ids}


# ── Walkthrough 3: by prop.external_id ──────────────────────────────────────────────────────────

ERP_COLUMNS = ["kind", "prop.external_id", "entityType", "displayName", "description", "prop.owner",
               "edgeType", "source.external_id", "target.external_id"]
ERP_1 = [
    {"kind": "node", "prop.external_id": "E-1001", "entityType": "Table", "displayName": "orders",
     "prop.owner": "alice"},
    {"kind": "node", "prop.external_id": "E-1002", "entityType": "Table", "displayName": "customers",
     "prop.owner": "bob"},
    {"kind": "node", "prop.external_id": "E-1003", "entityType": "Table", "displayName": "payments",
     "prop.owner": "carol"},
    {"kind": "edge", "edgeType": "FLOWS_TO", "source.external_id": "E-1002", "target.external_id": "E-1001"},
    {"kind": "edge", "edgeType": "FLOWS_TO", "source.external_id": "E-1003", "target.external_id": "E-1001"},
]
ERP_2 = [  # a partial file: each row, the external_id and what changed
    {"kind": "node", "prop.external_id": "E-1001", "prop.owner": "dana"},
    {"kind": "node", "prop.external_id": "E-1004", "description": "Refunds, from the ERP"},
    {"kind": "node", "prop.external_id": "E-1005", "entityType": "Table", "displayName": "invoices",
     "prop.owner": "carol"},
    {"kind": "edge", "edgeType": "FLOWS_TO", "source.external_id": "E-1001", "target.external_id": "E-1005"},
]
#: A node made in the app after the first import, holding E-1004.
MADE_IN_APP = "urn:uuid:0193a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b"


async def _by_property(g: _Guide) -> dict:
    from backend.app.services.versioning.import_export.resolve import edge_pointer_id, key_pointer_id
    _ds, gid, scope = await g.graph()
    by = {"identifier": "prop.external_id"}
    ids = {v: key_pointer_id(scope, "external_id", v) for v in ("E-1001", "E-1002", "E-1003", "E-1005")}

    settings = _ok(await g.c.get(f"{V1}/graphs/{gid}/import-settings"))
    assert (settings["effective"]["identifier"], settings["matchingProperties"],
            settings["maxMatchingProperties"]) == ("entity_id", [], 10), settings
    # A dry run by a property no import has matched by yet: the first import builds its index.
    early = await g.dry_run(gid, _csv(ERP_1, ERP_COLUMNS), status=409, format="csv", **by)
    assert early["detail"]["type"] == "identifier_not_indexed", early

    job, first = await g.imported(gid, _csv(ERP_1, ERP_COLUMNS), format="csv", **by)
    assert (first["identifier"], _counts(first["summary"])) == ("prop.external_id", {
        "new": 5, "updated": 0, "unchanged": 0, "deleted": 0, "invalid": 0}), first
    await g.published(gid, job["branchId"], "Load the ERP tables")
    state = await g.main(gid)
    for value in ("E-1001", "E-1002", "E-1003"):
        node = state[ids[value]]
        assert (node["urn"], node["properties"]["external_id"]) == (ids[value], value), node
    assert edge_pointer_id(scope, ids["E-1002"], ids["E-1001"], "FLOWS_TO") in state
    listed = _ok(await g.c.get(f"{V1}/graphs/{gid}/import-settings"))["matchingProperties"]
    assert [(p["name"], p["status"]) for p in listed] == [("external_id", "ready")], listed

    # In the app, someone adds refunds, with the ERP's id, and publishes it.
    await g.svc.apply_ops(graph_id=gid, actor="colleague", message="Add refunds", ops=[
        {"op": "create", "entity_kind": "node", "entity_id": MADE_IN_APP,
         "payload": {"urn": MADE_IN_APP, "entityType": "Table", "displayName": "refunds",
                     "properties": {"external_id": "E-1004", "owner": "erin"}}}])

    checked = await g.dry_run(gid, _csv(ERP_2, ERP_COLUMNS), format="csv", **by)
    assert checked["summary"] == {"new": 2, "updated": 2, "unchanged": 0, "deleted": 0, "invalid": 0,
                                  "skipped": 0}, checked["summary"]
    assert {r["matchedEntityId"] for r in checked["rows"] if r["op"] == "update"} == {
        ids["E-1001"], MADE_IN_APP}, "the node made in the app, found by its value"
    job, second = await g.imported(gid, _csv(ERP_2, ERP_COLUMNS), format="csv", **by)
    assert _counts(second["summary"]) == {"new": 2, "updated": 2, "unchanged": 0, "deleted": 0,
                                          "invalid": 0}, second["summary"]
    await g.published(gid, job["branchId"], "ERP: owners, refunds, invoices")
    state = await g.main(gid)
    assert state[ids["E-1001"]]["displayName"] == "orders", "a column the row leaves out stays"
    assert state[ids["E-1001"]]["properties"]["owner"] == "dana"
    assert state[MADE_IN_APP]["description"] == "Refunds, from the ERP"
    assert state[MADE_IN_APP]["properties"]["owner"] == "erin", "only the columns it carries"
    assert state[ids["E-1005"]]["properties"]["external_id"] == "E-1005"
    before = await g.versions(gid)

    _job, third = await g.imported(gid, _csv(ERP_2, ERP_COLUMNS), format="csv", **by)
    assert _counts(third["summary"]) == {"new": 0, "updated": 0, "unchanged": 4, "deleted": 0,
                                         "invalid": 0}, third["summary"]
    assert await g.versions(gid) == before, "the same file again writes nothing"

    resolved = _ok(await g.c.post(f"{V1}/graphs/{gid}/identities/resolve", json={
        "identifier": "prop.external_id", "values": ["E-1001", "E-1004", "E-9999"]}))
    assert [(r["status"], r["entityId"]) for r in resolved["results"]] == [
        ("found", ids["E-1001"]), ("found", MADE_IN_APP), ("none", None)], resolved
    return {"gid": gid, "ids": ids}


# ── Edge cases ──────────────────────────────────────────────────────────────────────────────────

async def _edge_cases(g: _Guide, sales: dict, shop: dict, erp: dict) -> None:
    gid, ids = sales["gid"], sales["ids"]
    # Refused rows, by entity_id. Each names something of its own, so none is a second row of
    # another's entity but the one that is meant to be.
    refusals = await g.dry_run(gid, _ndjson(
        {"kind": "node", "entityType": "Table", "displayName": "scratch"},
        {"kind": "node", "urn": "urn:acme:table:sales.returns", "displayName": "returns"},
        {"kind": "node", "urn": "urn:acme:table:sales.v_orders", "entityType": "View"},
        {"kind": "node", "urn": SALES["orders"], "entityType": "Table", "prop.owner": "erin"},
        {"kind": "node", "urn": SALES["orders"], "entityType": "Table", "prop.owner": "frank"},
        {"kind": "node", "entity_id": ids["refunds"], "urn": SALES["customers"], "entityType": "Table"},
        {"kind": "node", "urn": SALES["customers"], "_op": "remove"},
        {"kind": "edge", "edgeType": "FLOWS_TO", "sourceUrn": SALES["orders"],
         "targetUrn": "urn:acme:table:sales.nowhere"},
        {"kind": "edge", "entity_id": sales["edge"], "edgeType": "FLOWS_TO",
         "source_entity_id": ids["customers"], "target_entity_id": ids["refunds"]},
        {"kind": "edge", "sourceUrn": SALES["orders"], "targetUrn": SALES["customers"]},
    ), format="ndjson")
    assert _codes(refusals) == {
        0: ("invalid", "no_key"), 1: ("invalid", "missing_type"), 2: ("invalid", "invalid_type"),
        3: ("update", None), 4: ("invalid", "named_already"), 5: ("invalid", "two_entities"),
        6: ("invalid", "invalid_row"), 7: ("invalid", "end_not_found"), 8: ("invalid", "edge_moved"),
        9: ("invalid", "missing_type")}, refusals["rows"]

    # Rows that are not refused, and what they do.
    staging = "urn:uuid:0193a1b2-0000-7000-8000-00000000ab01"
    kept = await g.dry_run(gid, _ndjson(
        {"kind": "node", "urn": "urn:acme:table:sales.gone", "entityType": "Table", "_op": "delete"},
        {"kind": "node", "entity_id": staging, "entityType": "Table", "displayName": "from staging"},
        {"kind": "node", "entity_id": "new-1", "urn": "urn:acme:table:sales.returns",
         "entityType": "Table", "displayName": "returns"},
        {"kind": "edge", "edgeType": "FLOWS_TO", "source_entity_id": "new-1", "targetUrn": SALES["orders"]},
        {"kind": "node", "entity_id": ids["customers"], "urn": "urn:acme:table:sales.clients",
         "entityType": "Table", "displayName": "clients"},
    ), format="ndjson")
    assert kept["summary"] == {"new": 3, "updated": 1, "unchanged": 1, "deleted": 0, "invalid": 0,
                               "skipped": 0}, kept["summary"]
    assert kept["hints"][0].startswith("1 delete row finds nothing to delete"), kept["hints"]
    rows = {r["rowIndex"]: r for r in kept["rows"]}
    assert (rows[1]["op"], rows[1]["matchedEntityId"]) == ("create", staging), "a free urn:uuid is kept"
    assert rows[2]["op"] == "create" and rows[3]["op"] == "create", "new-1 links the edge to its node"
    assert (rows[4]["op"], rows[4]["matchedEntityId"]) == ("update", ids["customers"]), rows[4]
    assert "isn't stored: an import never changes a node's urn" in rows[4]["reasons"][0], rows[4]

    # By a property: a value two nodes hold, and a row whose id and value name two nodes.
    erp_gid, erp_ids = erp["gid"], erp["ids"]
    copy = "urn:uuid:0193a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a3c"
    await g.svc.apply_ops(graph_id=erp_gid, actor="colleague", message="Copy customers", ops=[
        {"op": "create", "entity_kind": "node", "entity_id": copy,
         "payload": {"urn": copy, "entityType": "Table", "displayName": "customers (copy)",
                     "properties": {"external_id": "E-1002"}}}])
    by_value = await g.dry_run(erp_gid, _ndjson(
        {"kind": "node", "prop.external_id": "E-1002", "prop.owner": "zoe"},
        {"kind": "node", "entity_id": erp_ids["E-1001"], "prop.external_id": "E-1003"},
        {"kind": "node", "urn": "urn:erp:table:ledger", "entityType": "Table"},
        {"kind": "edge", "edgeType": "FLOWS_TO", "source.external_id": "E-1001",
         "target.external_id": "E-9999"},
    ), format="ndjson", identifier="prop.external_id")
    assert _codes(by_value) == {0: ("invalid", "duplicate_value"), 1: ("invalid", "two_entities"),
                                2: ("invalid", "no_key"), 3: ("invalid", "end_not_found")}, by_value["rows"]
    assert copy in by_value["rows"][0]["reasons"][0] and erp_ids["E-1002"] in by_value["rows"][0]["reasons"][0]

    # A file that deletes a node but keeps the row of an edge on it: by the time the edge windows
    # run, the node is gone, so the edge row names an end that isn't there.
    _job, _kept = await g.imported(gid, _ndjson(
        {"kind": "node", "urn": SALES["refunds"], "entityType": "Table", "_op": "delete"},
        {"kind": "edge", "edgeType": "FLOWS_TO", "sourceUrn": SALES["orders"], "targetUrn": SALES["refunds"]},
    ), format="ndjson")
    preview = _ok(await g.c.get(f"{V1}/graphs/{gid}/imports/{_job['jobId']}/preview"))
    assert _codes(preview) == {0: ("delete", None), 1: ("invalid", "end_not_found")}, preview["sample"]

    # A replace with a refused row deletes nothing: its job fails, and its other rows wait on the draft.
    _job, failed = await g.imported(shop["gid"], _ndjson(*NIGHT_2), format="ndjson", identifier="urn",
                                    reconcileMode="replace")
    assert failed["status"] == "failed" and failed["errorMessage"].startswith("Nothing was deleted"), failed
    failure = failed["summary"]["failure"]
    assert (failure["code"], failure["action"]) == ("rows_refused", "fix_rows"), failed["summary"]

    # Requests refused before anything is made.
    bad = _ok(await g.c.post(f"{V1}/graphs/{gid}/imports", params={"format": "csv", "identifier": "external_id"},
                             content=b"kind\n"), 422)
    assert bad["detail"]["type"] == "invalid_identifier", bad
    own = _ok(await g.c.post(f"{V1}/graphs/{gid}/imports", params={"autoPublish": "true", "branchId": "br_x"},
                             content=b""), 422)
    assert own["detail"]["type"] == "auto_publish_needs_own_draft", own
    exported = _ok(await g.c.post(f"{V1}/graphs/{gid}/exports", params={"idempotencyKey": "k-2026-11-12"}), 202)
    reused = _ok(await g.c.post(f"{V1}/graphs/{gid}/imports", params={"idempotencyKey": "k-2026-11-12"},
                                content=_ndjson(_LOADED[0])), 409)
    assert reused["detail"]["type"] == "idempotency_key_reused", reused
    await _lane(g.ie, exported["jobId"])


async def guide(client, ie) -> None:
    """Every walkthrough of the guide, then its edge cases, through ``client``."""
    from backend.app.services.versioning.service import GraphVersioningService
    g = _Guide(client, ie, GraphVersioningService())
    sales = await _by_entity_id(g)
    shop = await _by_urn(g)
    erp = await _by_property(g)
    await _edge_cases(g, sales, shop, erp)


async def _publisher(_session, _user_id, *_args, **_kwargs):
    """``u_test`` still publishes in ``ws1`` when its import's publish job runs."""
    from backend.app.services.permission_service import PermissionClaims
    return PermissionClaims(sid="", ws_perms={WS: _PUBLISHER})


def test_the_import_guide_walkthroughs_do_what_the_guide_shows(monkeypatch, data_sources):
    from httpx import ASGITransport, AsyncClient

    from backend.app.services import permission_service

    from .test_api_graph_draft_journey import _StubCache, _StubManager

    monkeypatch.setattr(permission_service, "resolve", _publisher)

    async def run():
        await models.create_schema_and_partitions()
        root = tempfile.mkdtemp(prefix="import-guide-")
        app, graph_router, ie = _app(root)
        monkeypatch.setattr(graph_router, "provider_manager", _StubManager())
        monkeypatch.setattr(graph_router, "get_graph_cache", lambda: _StubCache())
        try:
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                await guide(client, ie)
        finally:
            shutil.rmtree(root, ignore_errors=True)
            await db.dispose_engine()
    asyncio.run(run())
