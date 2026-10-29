"""The review inbox's ``status=open`` read — needs Postgres.

The inbox lists a data source's PRs newest first, a page at a time. Read unfiltered, a burst of
newer merged or closed PRs fills the page and an older PR still awaiting review drops out of the
inbox. ``status=open`` is the inbox's "open" in the review sense: every PR not yet merged or
closed, whatever its review state (mergeable, conflicts, approved). No PR is stored as plain
"open", so an exact match on it would list nothing.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.service import GraphVersioningService


def _node(eid):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"displayName": eid, "entityType": "Dataset"}}


async def _raise_pr(svc, gid, name):
    draft = await svc.open_draft(graph_id=gid, owner="alice", name=name)
    await svc.stage_changes(graph_id=gid, branch_id=draft, actor="alice", ops=[_node(name)])
    await svc.checkpoint(graph_id=gid, branch_id=draft, actor="alice")
    return await svc.open_draft_mr(graph_id=gid, branch_id=draft, actor="alice", title=name)


def _ids(rows):
    return [r["pr_id"] for r in rows]


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    ds_id = "ds_" + os.urandom(4).hex()
    G = await svc.create_graph(data_source_id=ds_id, workspace_id="ws1", actor="alice")
    gid = G["graph_id"]

    waiting = await _raise_pr(svc, gid, "waiting")             # oldest, still awaiting review
    approved = await _raise_pr(svc, gid, "approved")
    await svc.approve_pr(pr_id=approved, actor="mgr")
    closed = await _raise_pr(svc, gid, "closed")               # newest, already closed
    await svc.close_pr(pr_id=closed, actor="alice")
    assert (await svc.get_pr(waiting))["status"] in ("mergeable", "conflicts")
    assert (await svc.get_pr(approved))["status"] == "approved"

    # Unfiltered, a page the size of the closed backlog holds no PR that needs review.
    assert _ids(await svc.list_pulls(data_source_id=ds_id, limit=1)) == [closed]

    # status=open lists every PR not yet merged or closed, newest first, whatever its review state.
    assert _ids(await svc.list_pulls(data_source_id=ds_id, status="open")) == [approved, waiting]
    assert _ids(await svc.list_pulls(data_source_id=ds_id, status="open", offset=1)) == [waiting]
    assert await svc.count_pulls(data_source_id=ds_id, status="open") == 2

    # Every other status is still an exact match.
    assert _ids(await svc.list_pulls(data_source_id=ds_id, status="closed")) == [closed]
    assert _ids(await svc.list_pulls(data_source_id=ds_id, status="approved")) == [approved]

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_review_inbox_open_prs_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("review inbox status=open e2e: OK")
