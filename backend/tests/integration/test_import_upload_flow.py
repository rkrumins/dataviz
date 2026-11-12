"""A service's import, sent as the guide's "From your service" section sends it — Postgres.

``docs/IMPORT_EXPORT_API.md`` shows a service how to send a file and import it, by upsert and by
full replace, from curl, Python, Node.js and PowerShell. Each client makes the same requests, which
this sends to the real routes, running each job as the transfer lane runs it:

* **Upsert in one request**: ``POST …/imports`` with the file as its body, matched by urn, which
  publishes itself.
* **Upsert as an upload, in one go**: ``POST …/imports/uploads``, the whole file to part 0 (cut into
  its parts as it arrives: ``lastPart``), ``…/complete``: what the file names is written, and
  nothing it leaves out is deleted.
* **Full replace as an upload, resumed**: part 0 only, as if the connection dropped; ``GET`` the
  upload for what arrived; the rest of the file from part 1; ``…/complete`` with
  ``reconcileMode=replace``. What the snapshot leaves out is deleted with its edges, every kept
  node keeps its id, and completing again answers with the same import.
"""
import asyncio
import json
import os
import shutil
import tempfile

import pytest

from backend.app.services.versioning import db, models

from .test_import_guide_examples import V1, _Guide, _app, _lane, _ok, _publisher

pytestmark = [pytest.mark.integration, pytest.mark.skipif(
    not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")]

PART = 5 * 1024 * 1024          # the smallest part an upload takes
#: A long description, so a few rows make a file of two parts.
PAD = "x" * (1300 * 1024)


def _table(name: str, *, description: str = "", extra: str = "") -> dict:
    row = {"kind": "node", "urn": f"urn:svc:{name}", "entityType": "Table", "displayName": name}
    if description or extra:
        row["description"] = description + extra
    return row


def _flow(source: str, target: str) -> dict:
    return {"kind": "edge", "edgeType": "FLOWS_TO", "sourceUrn": f"urn:svc:{source}",
            "targetUrn": f"urn:svc:{target}"}


def _file(*records) -> bytes:
    return "".join(json.dumps(r) + "\n" for r in records).encode()


async def _upload(c, gid: str, body: bytes) -> dict:
    """``POST …/imports/uploads``: the upload, split in 5 MiB parts."""
    return _ok(await c.post(f"{V1}/graphs/{gid}/imports/uploads", json={
        "fileName": "nightly.ndjson", "size": len(body), "format": "ndjson", "partBytes": PART}), 201)


async def _complete(c, ie, gid: str, upload_id: str, **params) -> dict:
    """``…/complete``, the import run, then ``GET …/imports/{jobId}``."""
    job = _ok(await c.post(f"{V1}/graphs/{gid}/imports/uploads/{upload_id}/complete",
                           params=params), 202)
    await _lane(ie, job["jobId"])
    return job, _ok(await c.get(f"{V1}/graphs/{gid}/imports/{job['jobId']}"))


async def _run(monkeypatch):
    from httpx import ASGITransport, AsyncClient

    from backend.app.services.versioning.service import GraphVersioningService

    from .test_api_graph_draft_journey import _StubCache, _StubManager

    await models.create_schema_and_partitions()
    root = tempfile.mkdtemp()
    app, graph_router, ie = _app(root)
    monkeypatch.setattr(graph_router, "provider_manager", _StubManager())
    monkeypatch.setattr(graph_router, "get_graph_cache", lambda: _StubCache())
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            g = _Guide(c, ie, GraphVersioningService())
            _ds, gid, _scope = await g.graph()

            # ── Upsert in one request ────────────────────────────────────────────────────────
            first = _file(_table("orders"), _table("customers"), _table("refunds"),
                          _flow("orders", "customers"), _flow("orders", "refunds"))
            _job, done = await g.imported(gid, first, format="ndjson", identifier="urn",
                                          autoPublish="true")
            assert done["status"] == "completed", done
            pub = await g.published_itself(gid, done)
            assert pub["status"] == "completed", json.dumps(pub)
            main = await g.main(gid)
            ids = {p["urn"]: eid for eid, p in main.items() if "urn" in p}
            assert set(ids) == {"urn:svc:orders", "urn:svc:customers", "urn:svc:refunds"}

            # ── Upsert as an upload, the whole file in one go ────────────────────────────────
            body = _file(_table("orders", description="Orders, one row each", extra=PAD),
                         _table("invoices", extra=PAD), _table("payments", extra=PAD),
                         _table("ledger", extra=PAD), _table("vendors", extra=PAD),
                         _flow("orders", "invoices"))
            assert len(body) > PART, "two parts"
            up = await _upload(c, gid, body)
            assert (up["parts"], up["received"]) == (2, [])
            put = _ok(await c.put(f"{V1}/graphs/{gid}/imports/uploads/{up['uploadId']}/parts/0",
                                  content=body, headers={"Content-Type": "application/octet-stream"}))
            assert (put["size"], put["lastPart"]) == (len(body), 1), put
            got = _ok(await c.get(f"{V1}/graphs/{gid}/imports/uploads/{up['uploadId']}"))
            assert got["received"] == [0, 1], got
            _job, done = await _complete(c, ie, gid, up["uploadId"], identifier="urn",
                                         autoPublish="true")
            assert done["status"] == "completed", done
            assert done["summary"]["deleted"] == 0, done["summary"]
            assert (await g.published_itself(gid, done))["status"] == "completed"
            main = await g.main(gid)
            urns = {p["urn"]: eid for eid, p in main.items() if "urn" in p}
            assert {"urn:svc:customers", "urn:svc:refunds"} <= set(urns), "an upsert deletes nothing"
            assert urns["urn:svc:orders"] == ids["urn:svc:orders"], "a node keeps its id"
            assert main[urns["urn:svc:orders"]]["description"].startswith("Orders, one row each")

            # ── Full replace as an upload, resumed after a dropped connection ────────────────
            nightly = _file(_table("orders", description="Orders", extra=PAD),
                            _table("customers", extra=PAD), _table("invoices", extra=PAD),
                            _table("payments", extra=PAD), _table("ledger", extra=PAD),
                            _flow("orders", "customers"), _flow("orders", "invoices"))
            assert len(nightly) > PART
            up = await _upload(c, gid, nightly)
            put = _ok(await c.put(f"{V1}/graphs/{gid}/imports/uploads/{up['uploadId']}/parts/0",
                                  content=nightly[:PART]))
            assert put["lastPart"] == 0
            got = _ok(await c.get(f"{V1}/graphs/{gid}/imports/uploads/{up['uploadId']}"))
            missing = sorted(set(range(got["parts"])) - set(got["received"]))
            assert missing == [1], got
            put = _ok(await c.put(f"{V1}/graphs/{gid}/imports/uploads/{up['uploadId']}/parts/{missing[0]}",
                                  content=nightly[missing[0] * PART:]))
            assert put["lastPart"] == got["parts"] - 1
            job, done = await _complete(c, ie, gid, up["uploadId"], reconcileMode="replace",
                                        identifier="urn", autoPublish="true")
            assert done["status"] == "completed", done
            assert done["summary"]["replaceGuard"]["state"] == "passed", done["summary"]
            assert (await g.published_itself(gid, done))["status"] == "completed"
            main = await g.main(gid)
            kept = {p["urn"]: eid for eid, p in main.items() if "urn" in p}
            assert set(kept) == {"urn:svc:orders", "urn:svc:customers", "urn:svc:invoices",
                                 "urn:svc:payments", "urn:svc:ledger"}, "refunds and vendors left out"
            assert kept["urn:svc:orders"] == ids["urn:svc:orders"]
            assert kept["urn:svc:customers"] == ids["urn:svc:customers"]
            edges = sorted((main[p["sourceEntityId"]]["urn"], main[p["targetEntityId"]]["urn"])
                           for p in main.values() if "sourceEntityId" in p)
            assert edges == [("urn:svc:orders", "urn:svc:customers"),
                             ("urn:svc:orders", "urn:svc:invoices")], edges
            again = _ok(await c.post(f"{V1}/graphs/{gid}/imports/uploads/{up['uploadId']}/complete",
                                     params={"reconcileMode": "replace", "identifier": "urn",
                                             "autoPublish": "true"}), 202)
            assert again["jobId"] == job["jobId"], "an upload is imported once"
    finally:
        shutil.rmtree(root, ignore_errors=True)
        await db.dispose_engine()


def test_a_service_upserts_and_replaces_as_the_guide_shows(monkeypatch, data_sources):
    from backend.app.services import permission_service

    # ``u_test`` publishes in ``ws1``, as a service's key with Publisher does, when its import's
    # publish job runs.
    monkeypatch.setattr(permission_service, "resolve", _publisher)
    asyncio.run(_run(monkeypatch))
