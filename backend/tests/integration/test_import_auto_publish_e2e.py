"""An import that publishes itself, end to end on Postgres: its file's deltas reach main.

The import runs as the transfer lane runs it, through the service the API builds
(``get_import_export_service``), so its publish goes through the hook every publish job takes.
The file's nodes and edges land on main, and its draft is merged. The same file sent again changes
nothing: nothing is committed, and its empty draft is closed — the import says ``unchanged``, names
no commit, and gives the revision of main that holds its content. Its publish, once the job ends,
is noted on the import itself (``published``, with the commit and revision). The same snapshot
imported into two drafts at once: the first publishes; the second, pulling main, finds it holds
its changes, and ends ``unchanged`` — main's head and commits as they were. A delta that deletes
what an earlier run deleted, beside a real change, still publishes itself: the delete is done
already, not refused.
"""
import asyncio
import json
import os

import pytest

from sqlalchemy import func, select

from backend.app.services.storage.object_store import storage_key
from backend.app.services.versioning import db, models
from backend.app.services.versioning.models import CommitORM, GraphORM

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
        imported.last = job["job_id"]
        return job["branch_id"], (await ie.get_job(job["job_id"]))["summary"]

    async def published(summary, job_id=None, outcome="published"):
        """Run the import's publish job; the import then says how it ended, as the job does."""
        note = summary["publish"]
        assert note["state"] == "queued", summary
        result = await ie.run_publish(note["jobId"])
        assert result["outcome"] == outcome and bool(result["commitId"]) == (outcome == "published"), result
        ended = (await ie.get_job(job_id or imported.last))["summary"]["publish"]
        assert {k: ended[k] for k in ("state", "jobId", "commitId", "revisionId")} == {
            "state": outcome, "jobId": note["jobId"], "commitId": result["commitId"],
            "revisionId": result["revisionId"]}, ended
        return ended

    async def main_now():
        """Main's head and how many commits main holds: what a publish that commits would move. (A
        draft's own commits — a pull onto an import's draft — aren't main's.)"""
        async with db.graphver_session() as s:
            head = (await s.get(GraphORM, gid)).main_head_commit_seq
            commits = await s.scalar(select(func.count()).select_from(CommitORM).where(
                CommitORM.graph_id == gid, CommitORM.branch_id == main))
        return head, commits

    async def names():
        state = await svc.materialize_state(graph_id=gid, branch_id=main)
        return sorted(n["displayName"] for n in state["nodes"].values()), len(state["edges"])

    draft, summary = await imported(_FILE)
    assert (summary["new"], summary["invalid"]) == (4, 0), summary
    await published(summary)
    assert await names() == (["legacy", "orders", "revenue"], 1)
    assert (await svc.branch_statuses([draft]))[draft] == "merged"

    before = await main_now()
    again, summary = await imported(_FILE)
    assert summary["publish"] == {"state": "unchanged", "commitId": None, "revisionId": before[0]}, summary
    assert (await svc.branch_statuses([again]))[again] == "abandoned"
    assert await main_now() == before, "nothing committed: main's head and commits as they were"

    # The same snapshot into two drafts at once: the first publishes; the second pulls main, finds
    # it holds its changes, and commits nothing.
    twin = [{"kind": "node", "urn": "urn:t:ledger", "entityType": "Table", "displayName": "ledger"}]
    _first, first = await imported(twin)
    first_job = imported.last
    _second, second = await imported(twin)
    second_job = imported.last
    landed = await published(first, first_job)
    before = await main_now()
    ended = await published(second, second_job, outcome="unchanged")
    assert (ended["commitId"], ended["revisionId"], ended["pulls"]) == (None, landed["revisionId"], 1), ended
    assert await main_now() == before, "the second committed nothing"

    _draft, summary = await imported([_DELETE_LEGACY])
    await published(summary)
    _draft, summary = await imported([
        _DELETE_LEGACY,
        {"kind": "node", "urn": "urn:t:orders", "entityType": "Table", "displayName": "orders v2"},
    ])
    assert (summary["updated"], summary["unchanged"], summary["invalid"]) == (1, 1, 0), summary
    await published(summary)
    assert await names() == (["ledger", "orders v2", "revenue"], 1)


def test_an_import_publishes_itself_onto_main(monkeypatch):
    async def run():
        try:
            await _run(monkeypatch)
        finally:
            await db.dispose_engine()
    asyncio.run(run())
