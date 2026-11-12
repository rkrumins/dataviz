"""A replace with a refused row, held and then sent on within a budget — Postgres.

A nightly snapshot names tables a and b, brings d, and leaves c out; its row for b gives a type the
data source doesn't have, so it is refused. Sent as it is, the replace deletes nothing and fails,
and its job says which row was refused and why (``summary.refused``, the error message). Sent again
with ``maxRefusedRows=-1``, it replaces with the rows that applied: c is deleted, d made, and b —
named by the refused row — kept; it publishes itself, saying how many rows it went on without.
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


def _table(name: str, entity_type: str = "Table") -> dict:
    return {"kind": "node", "urn": f"urn:svc:{name}", "entityType": entity_type, "displayName": name}


def _file(*records) -> bytes:
    return "".join(json.dumps(r) + "\n" for r in records).encode()


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
            _job, done = await g.imported(gid, _file(_table("a"), _table("b"), _table("c")),
                                          identifier="urn", autoPublish="true")
            assert (await g.published_itself(gid, done))["status"] == "completed"
            ids = {p["urn"]: eid for eid, p in (await g.main(gid)).items() if "urn" in p}

            nightly = _file(_table("a"), _table("b", "Dashboard"), _table("d"))
            # ── As it is: held, saying which row and why ─────────────────────────────────────────
            _job, held = await g.imported(gid, nightly, identifier="urn", reconcileMode="replace",
                                          autoPublish="true")
            assert held["status"] == "failed", held
            assert held["summary"]["failure"]["code"] == "rows_refused"
            refused = held["summary"]["refused"]
            assert (refused["total"], refused["byCode"]) == (1, {"invalid_type": 1}), refused
            (row,) = refused["rows"]
            assert (row["rowIndex"], row["kind"], row["label"], row["code"]) == (1, "node", "b", "invalid_type")
            assert "Dashboard" in row["reason"], row
            message = held["errorMessage"]
            assert message.startswith("Nothing was deleted: 1 row(s) of the file were refused"), message
            assert "1 invalid_type" in message and "rowIndex 1 (b): invalid_type" in message
            assert "maxRefusedRows" in message
            assert set(ids) <= {p.get("urn") for p in (await g.main(gid)).values()}, "nothing deleted"

            # ── Sent on without it: replaced with the rows that applied ──────────────────────────
            _job, done = await g.imported(gid, nightly, identifier="urn", reconcileMode="replace",
                                          autoPublish="true", maxRefusedRows="-1")
            assert done["status"] == "completed", done
            assert done["importSettings"]["maxRefusedRows"] == "-1"
            assert (done["summary"]["invalid"], done["summary"]["refused"]["byCode"]) == (1, {"invalid_type": 1})
            assert done["summary"]["publish"]["refusedRows"] == 1
            assert (await g.published_itself(gid, done))["status"] == "completed"
            main = {p["urn"]: eid for eid, p in (await g.main(gid)).items() if "urn" in p}
            assert set(main) == {"urn:svc:a", "urn:svc:b", "urn:svc:d"}, "c deleted; b kept: a refused row named it"
            assert (main["urn:svc:a"], main["urn:svc:b"]) == (ids["urn:svc:a"], ids["urn:svc:b"])
    finally:
        shutil.rmtree(root, ignore_errors=True)
        await db.dispose_engine()


def test_a_replace_holds_on_a_refused_row_and_says_why_then_goes_on_within_its_budget(monkeypatch, data_sources):
    from backend.app.services import permission_service

    monkeypatch.setattr(permission_service, "resolve", _publisher)
    asyncio.run(_run(monkeypatch))
