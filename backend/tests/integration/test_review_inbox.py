"""The review inbox — needs Postgres.

* **Queues, as each reader works them:** a reviewer's *needs review* holds what is asked of them and
  not reviewed as it is now (it comes back when the draft changes after their approval); an
  opener's own reviews are *waiting*, *sent back* or *ready*; an outsider sees them open, asked of
  no one in particular; merged and closed ones are *done*.
* **Unread:** what someone else did on a review the reader is part of, until they look at it.
* **Abandoning a draft closes its review.**
* **A fixed number of reads,** however many reviews.
* **Over HTTP:** the inbox, its counts, marking a review seen, and who is told what.
"""
import asyncio
import os

import pytest
from sqlalchemy import event

from backend.app.services.versioning import db, models
from backend.app.services.versioning.review_comments import ReviewComments
from backend.app.services.versioning.service import GraphVersioningService, Viewer

from .test_versioning_pr_gate import _node, _upd

E2E = pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")


async def _review(svc, gid, owner, reviewers, eid, visibility="private"):
    d = await svc.open_draft(graph_id=gid, owner=owner, visibility=visibility)
    await svc.stage_changes(graph_id=gid, branch_id=d, actor=owner, ops=[_node(eid)])
    await svc.checkpoint(graph_id=gid, branch_id=d, actor=owner)
    return d, await svc.open_draft_mr(graph_id=gid, branch_id=d, actor=owner, reviewers=reviewers, title=eid)


async def _head(svc, gid, d):
    return next(b for b in (await svc.list_branches(graph_id=gid))[0] if b["branch_id"] == d)["head_commit_id"]


def _queues(out):
    return {k: v for k, v in out["counts"].items() if v}


async def _service_run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    ws = "ws_" + os.urandom(4).hex()
    G = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id=ws, actor="ana")
    gid = G["graph_id"]
    r1d, r1 = await _review(svc, gid, "ana", ["carol"], "R1")              # waits on carol
    r2d, r2 = await _review(svc, gid, "ana", ["carol", "dave"], "R2")      # carol approves; dave not yet
    r3d, r3 = await _review(svc, gid, "ana", ["dave"], "R3", "public")     # dave sends it back; public
    _r4d, r4 = await _review(svc, gid, "carol", ["ana"], "R4")             # carol's own
    await svc.approve_pr(pr_id=r2, actor="carol", expected_head_commit_id=await _head(svc, gid, r2d))
    await svc.request_changes(pr_id=r3, actor="dave", reason="owner", expected_head_commit_id=await _head(svc, gid, r3d))

    def who(actor):
        return Viewer(actor=actor, can_manage=True, can_read=True)

    async def inbox(actor, queue="needs_review", **kw):
        out = await svc.review_inbox(workspace_id=ws, viewer=who(actor), queue=queue, **kw)
        return out, [i["pr_id"] for i in out["items"]]

    out, ids = await inbox("carol")
    # She sees what is asked of her, her own, and R3 (a public draft's); a private draft's review
    # asking others would be hidden from her.
    assert ids == [r1] and _queues(out) == {"needs_review": 1, "waiting": 1, "open": 4}, out["counts"]
    out, ids = await inbox("ana", "sent_back")
    assert ids == [r3] and _queues(out) == {"needs_review": 1, "waiting": 2, "sent_back": 1, "open": 4}
    out, ids = await inbox("ana", "waiting")
    assert set(ids) == {r1, r2}
    out, ids = await inbox("erin", "open")                                 # an outsider: the public one only
    assert ids == [r3] and _queues(out) == {"open": 1} and out["unread"]["open"] == 0

    # Ready once nothing but a merge is left.
    await svc.approve_pr(pr_id=r2, actor="dave", expected_head_commit_id=await _head(svc, gid, r2d))
    _, ids = await inbox("ana", "ready")
    assert ids == [r2]

    # Unread: carol was asked and hasn't looked; she looks; ana comments, and it is unread again.
    out, _ = await inbox("carol")
    assert out["unread"]["needs_review"] == 1 and out["items"][0]["unread"] is True
    await svc.mark_review_seen(pr_id=r1, user_id="carol")
    out, _ = await inbox("carol")
    assert out["unread"]["needs_review"] == 0 and out["items"][0]["unread"] is False
    await asyncio.sleep(0.01)
    await ReviewComments().post(pr_id=r1, actor="ana", body="Anything else?")
    out, _ = await inbox("carol")
    assert out["unread"]["needs_review"] == 1
    # Her own comments never make it unread to her.
    await svc.mark_review_seen(pr_id=r1, user_id="carol")
    await ReviewComments().post(pr_id=r1, actor="carol", body="Looking now")
    assert (await inbox("carol"))[0]["unread"]["needs_review"] == 0

    # Approved, it leaves her queue; the draft changes after, and it is back.
    await svc.approve_pr(pr_id=r1, actor="carol", expected_head_commit_id=await _head(svc, gid, r1d))
    assert (await inbox("carol"))[1] == []
    await svc.stage_changes(graph_id=gid, branch_id=r1d, actor="ana", ops=[_upd("R1", f=2)])
    await svc.checkpoint(graph_id=gid, branch_id=r1d, actor="ana")
    assert (await inbox("carol"))[1] == [r1]

    # Abandoning the draft closes its review: done, and nobody's to review.
    meta = await svc.abandon_draft(graph_id=gid, branch_id=r1d, actor="ana")
    assert meta["closed_review_id"] == r1
    assert (await inbox("carol"))[1] == []
    out, ids = await inbox("ana", "done")
    assert ids == [r1] and out["counts"]["done"] == 1
    # Filters: by text, by author.
    assert (await inbox("ana", "open", q="R3"))[1] == [r3]
    assert (await inbox("ana", "open", author="carol"))[1] == [r4]

    # A fixed number of reads, however many reviews (counts only).
    stmts = []
    eng = db.get_engine().sync_engine

    def count(*_a):
        stmts.append(1)
    event.listen(eng, "before_cursor_execute", count)
    try:
        await svc.review_inbox(workspace_id=ws, viewer=who("carol"), limit=0)
        few = len(stmts)
        for i in range(6):
            await _review(svc, gid, "ana", ["carol"], f"More{i}")
        stmts.clear()
        await svc.review_inbox(workspace_id=ws, viewer=who("carol"), limit=0)
        assert len(stmts) == few, (few, len(stmts))
    finally:
        event.remove(eng, "before_cursor_execute", count)


@E2E
def test_the_inbox_queues_unread_and_abandon():
    try:
        asyncio.run(_service_run())
    finally:
        asyncio.run(db.dispose_engine())


async def _routes_run(monkeypatch) -> None:
    from httpx import ASGITransport, AsyncClient

    from backend.app.db.repositories import notification_repo

    from .test_api_graph_draft_journey import _StubCache, _StubManager
    from .test_private_draft_read import _app

    told = []

    async def notify(session, *, user_ids, kind, **kw):
        told.append((kind, sorted(u for u in user_ids if u != kw.get("actor_id"))))
        return len(told)
    monkeypatch.setattr(notification_repo, "notify", notify)
    read = []

    async def mark_read_for_resource(session, user_id, *, resource_type, resource_id):
        read.append((user_id, resource_type, resource_id))
        return 1
    monkeypatch.setattr(notification_repo, "mark_read_for_resource", mark_read_for_resource)

    await models.create_schema_and_partitions()
    app, G = _app()
    orig_pm, orig_cache = G.provider_manager, G.get_graph_cache
    G.provider_manager = _StubManager()
    G.get_graph_cache = lambda: _StubCache()
    svc = GraphVersioningService()
    ds = "ds_" + os.urandom(4).hex()
    gid = (await svc.create_graph(data_source_id=ds, workspace_id="ws1", actor="ana"))["graph_id"]
    V1 = "/api/v1/ws1/versioning"

    def h(user):
        return {"X-User": user, "X-Manage": "1", "X-Publish": "1"}
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            d = await svc.open_draft(graph_id=gid, owner="ana")
            await svc.stage_changes(graph_id=gid, branch_id=d, actor="ana", ops=[_node("H1")])
            await svc.checkpoint(graph_id=gid, branch_id=d, actor="ana")
            r = await c.post(f"{V1}/graphs/{gid}/branches/{d}/merge-requests", json={"reviewers": ["carol"], "title": "H1"},
                             headers=h("ana"))
            assert r.status_code == 201, r.text
            pr = r.json()["prId"]
            # Carol is told she is asked — and not told again that it is up for review.
            assert ("review.requested", ["carol"]) in told
            assert all("carol" not in to for kind, to in told if kind == "draft.sent_for_review")

            r = await c.get(f"{V1}/review-inbox", params={"dataSourceId": ds}, headers=h("carol"))
            assert r.status_code == 200, r.text
            body = r.json()
            assert [i["prId"] for i in body["items"]] == [pr] and body["queue"] == "needs_review"
            row = body["items"][0]
            assert row["unread"] is True and row["targetDataSourceId"] == ds and row["lastActivityAt"]
            assert row["review"]["you"]["needsReview"] is True
            r = await c.get(f"{V1}/review-inbox/counts", headers=h("carol"))
            assert r.status_code == 200 and r.json()["counts"]["needs_review"] >= 1, r.text
            r = await c.get(f"{V1}/review-inbox", params={"queue": "nope"}, headers=h("carol"))
            assert r.status_code == 422

            r = await c.post(f"{V1}/merge-requests/{pr}/seen", headers=h("carol"))
            assert r.status_code == 204, r.text
            assert read == [("carol", "review", pr)]
            r = await c.get(f"{V1}/review-inbox", params={"dataSourceId": ds}, headers=h("carol"))
            assert r.json()["items"][0]["unread"] is False

            # Carol's approval and comment tell ana; closing tells its people.
            head = (await c.get(f"{V1}/merge-requests/{pr}", headers=h("carol"))).json()["headCommitId"]
            told.clear()
            r = await c.post(f"{V1}/merge-requests/{pr}/reviews", json={"verdict": "comment", "body": "Why?"},
                             headers=h("carol"))
            assert r.status_code == 200 and ("review.commented", ["ana"]) in told, (r.text, told)
            r = await c.post(f"{V1}/merge-requests/{pr}/reviews", json={"verdict": "approve", "expectedHeadCommitId": head},
                             headers=h("carol"))
            assert r.status_code == 200 and ("review.approved", ["ana"]) in told, (r.text, told)
            told.clear()
            r = await c.post(f"{V1}/merge-requests/{pr}/close", headers=h("ana"))
            assert r.status_code == 200 and ("review.closed", ["carol"]) in told, (r.text, told)
    finally:
        G.provider_manager, G.get_graph_cache = orig_pm, orig_cache
        await db.dispose_engine()


@E2E
def test_the_inbox_over_http_and_who_is_told(data_sources, monkeypatch):
    asyncio.run(_routes_run(monkeypatch))
