"""An import that publishes itself, end to end on Postgres: its file's deltas reach main.

The import runs as the transfer lane runs it, through the service the API builds
(``get_import_export_service``), so its publish goes through the hook every publish job takes.
The file's nodes and edges land on main, and its draft is merged. The same file sent again changes
nothing: nothing is published, and its empty draft is closed. A delta that deletes what an earlier
run deleted, beside a real change, still publishes itself: the delete is done already, not refused.
"""
import asyncio
import json
import os

import pytest

from backend.app.services.storage.object_store import storage_key
from backend.app.services.versioning import db, models

pytestmark = [pytest.mark.integration, pytest.mark.skipif(
    not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")]

_PUBLISHER = ("workspace:datasource:read", "workspace:datasource:manage", "workspace:datasource:publish")
_FILE = [
    {"kind": "node", "urn": "urn:t:orders", "entityType": "Table", "displayName": "orders"},
    {"kind": "node", "urn": "urn:t:revenue", "entityType": "Table", "displayName": "revenue"},
    {"kind": "node", "urn": "urn:t:legacy", "entityType": "Table", "displayName": "legacy"},
    {"kind": "edge", "edgeType": "FLOWS_TO", "sourceUrn": "urn:t:orders", "targetUrn": "urn:t:revenue"},
]
_DELETE_LEGACY = {"kind": "node", "urn": "urn:t:legacy", "entityType": "Table", "_op": "delete"}


async def _one(body):
    yield body


async def _run(monkeypatch) -> None:
    from backend.app.api.v1.endpoints.versioning import (
        get_import_export_service,
        get_versioning_service,
    )
    from backend.app.services import permission_service
    from backend.app.services.permission_service import PermissionClaims

    async def publisher(_session, _user_id, *_args, **_kwargs):      # alice publishes in ws1
        return PermissionClaims(sid="", ws_perms={"ws1": _PUBLISHER})

    monkeypatch.setattr(permission_service, "resolve", publisher)
    await models.create_schema_and_partitions()
    svc, ie = get_versioning_service(), get_import_export_service()
    ds = "ds_" + os.urandom(4).hex()
    gid = (await svc.create_graph(data_source_id=ds, workspace_id="ws1", actor="alice"))["graph_id"]
    main = await svc.main_branch_id(gid)

    async def imported(records):
        key = storage_key("ws1", ds, gid, "e2e", f"{os.urandom(3).hex()}.ndjson")
        await ie.store.put_stream(key, _one("".join(json.dumps(r) + "\n" for r in records).encode()))
        job = await ie.create_import_job(workspace_id="ws1", data_source_id=ds, graph_id=gid,
                                         actor="alice", import_format="ndjson", source_uri=key,
                                         auto_publish=True)
        await ie.run_import(job["job_id"])
        return job["branch_id"], (await ie.get_job(job["job_id"]))["summary"]

    async def published(summary):
        note = summary["publish"]
        assert note["state"] == "queued", summary
        result = await ie.run_publish(note["jobId"])
        assert result.get("commitId"), result

    async def names():
        state = await svc.materialize_state(graph_id=gid, branch_id=main)
        return sorted(n["displayName"] for n in state["nodes"].values()), len(state["edges"])

    draft, summary = await imported(_FILE)
    assert (summary["new"], summary["invalid"]) == (4, 0), summary
    await published(summary)
    assert await names() == (["legacy", "orders", "revenue"], 1)
    assert (await svc.branch_statuses([draft]))[draft] == "merged"

    again, summary = await imported(_FILE)
    assert summary["publish"] == {"state": "unchanged"}, summary
    assert (await svc.branch_statuses([again]))[again] == "abandoned"

    _draft, summary = await imported([_DELETE_LEGACY])
    await published(summary)
    _draft, summary = await imported([
        _DELETE_LEGACY,
        {"kind": "node", "urn": "urn:t:orders", "entityType": "Table", "displayName": "orders v2"},
    ])
    assert (summary["updated"], summary["unchanged"], summary["invalid"]) == (1, 1, 0), summary
    await published(summary)
    assert await names() == (["orders v2", "revenue"], 1)


def test_an_import_publishes_itself_onto_main(monkeypatch):
    async def run():
        try:
            await _run(monkeypatch)
        finally:
            await db.dispose_engine()
    asyncio.run(run())
