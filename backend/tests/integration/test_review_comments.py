"""A review's discussion against Postgres: threads on a change, a field of it, or the review;
replies in order; who is told; counts per change; a thread outdated once its change is edited;
resolve and reopen; only an author edits, and an author or a manager deletes (the place stays)."""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.review_comments import CommentRefused, NotYours, ReviewComments
from backend.app.services.versioning.service import GraphVersioningService

CONT = ["CONTAINS"]


def _n(eid, name, desc=""):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": eid, "entityType": "Table", "displayName": name, "description": desc}}


def _u(eid, name, desc):
    return {"op": "update", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": eid, "entityType": "Table", "displayName": name, "description": desc}}


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    G = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="u")
    gid = G["graph_id"]
    await svc.apply_ops(graph_id=gid, actor="ana", message="seed", containment_edge_types=CONT,
                        ops=[_n("T1", "orders"), _n("T2", "sales")])
    d = await svc.open_draft(graph_id=gid, owner="ana")
    await svc.stage_changes(graph_id=gid, branch_id=d, actor="ana", ops=[_u("T1", "Orders", "Daily orders")])
    await svc.checkpoint(graph_id=gid, branch_id=d, actor="ana", containment_edge_types=CONT)
    pr_id = await svc.open_draft_mr(graph_id=gid, branch_id=d, actor="ana", title="Tidy")
    rc = ReviewComments()

    # A thread on a property of a change, mentioning someone; the review's author is told.
    t = await rc.post(pr_id=pr_id, actor="bo", body="  Why the new description?  ", entity_id="T1",
                      path="description", mentions=["cy", "bo", "cy"])
    assert t.comment["body"] == "Why the new description?" and t.comment["threadId"] == t.comment["id"]
    assert t.mentioned == ["cy"] and t.told == ["ana"]
    # A reply: on what its thread is on; the thread's people are told, not the replier.
    r = await rc.post(pr_id=pr_id, actor="ana", body="It was empty.", thread_id=t.comment["id"])
    assert (r.comment["entityId"], r.comment["path"]) == ("T1", "description")
    assert r.told == ["bo"]
    # A general comment.
    await rc.post(pr_id=pr_id, actor="cy", body="Looks good overall.")
    with pytest.raises(CommentRefused):
        await rc.post(pr_id=pr_id, actor="cy", body="   ")
    with pytest.raises(CommentRefused):
        await rc.post(pr_id=pr_id, actor="cy", body="x", thread_id="rc_nope")

    page = await rc.threads(pr_id=pr_id, entity_id="T1")
    assert page["total"] == 1
    [thread] = page["threads"]
    assert [x["body"] for x in thread["replies"]] == ["It was empty."] and thread["outdated"] is False
    assert (await rc.threads(pr_id=pr_id, general=True))["total"] == 1
    assert [x["id"] for x in (await rc.threads(pr_id=pr_id, thread_id=t.comment["id"]))["threads"]] == [t.comment["id"]]
    counts = await rc.counts(pr_id=pr_id)
    assert counts["entities"] == {"T1": {"open": 1, "total": 1}} and counts["general"] == {"open": 1, "total": 1}
    assert counts["open"] == 2

    # The author edits the change: the thread on it is outdated.
    await svc.stage_changes(graph_id=gid, branch_id=d, actor="ana", ops=[_u("T1", "Orders", "Daily customer orders")])
    await svc.checkpoint(graph_id=gid, branch_id=d, actor="ana", containment_edge_types=CONT)
    assert (await rc.threads(pr_id=pr_id, entity_id="T1"))["threads"][0]["outdated"] is True

    # Resolve, then reopen.
    await rc.resolve(pr_id=pr_id, thread_id=thread["id"], actor="bo", resolved=True)
    assert (await rc.counts(pr_id=pr_id))["entities"]["T1"] == {"open": 0, "total": 1}
    assert (await rc.threads(pr_id=pr_id, state="open"))["total"] == 1
    await rc.resolve(pr_id=pr_id, thread_id=thread["id"], actor="ana", resolved=False)
    assert (await rc.threads(pr_id=pr_id, state="resolved"))["total"] == 0

    # Only its author edits; its author or a manager deletes — and the reply keeps its place.
    with pytest.raises(NotYours):
        await rc.edit(pr_id=pr_id, comment_id=r.comment["id"], actor="bo", body="mine now")
    assert (await rc.edit(pr_id=pr_id, comment_id=r.comment["id"], actor="ana", body="It was blank."))["editedAt"]
    with pytest.raises(NotYours):
        await rc.delete(pr_id=pr_id, comment_id=r.comment["id"], actor="bo", may_moderate=False)
    await rc.delete(pr_id=pr_id, comment_id=r.comment["id"], actor="bo", may_moderate=True)
    [after] = (await rc.threads(pr_id=pr_id, entity_id="T1"))["threads"]
    assert after["replies"][0]["deleted"] is True and after["replies"][0]["body"] == ""

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_review_comments_e2e():
    asyncio.run(_run())
