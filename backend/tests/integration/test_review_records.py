"""Review records (``review_requests``, ``review_events``) and the rule — needs Postgres.

* **N of anyone's:** with ``requiredApprovals`` 2, two approvals that stand merge a review that
  asks three; one does not.
* **Several requests for changes** hold at once, and one commit by the author releases them all.
* **Withdrawing** takes back only your own verdict.
* **Open threads hold the merge** where the rule says, until they are resolved.
* **Carried over:** a review recorded in the columns that held its reviewers, approvals and
  request for changes reads the same once carried into the tables — twice over, and past a
  column holding JSON null.
* **Who is asked** is mirrored where the reads deciding who may see a private draft look.
* **Over HTTP:** ``POST …/reviews`` gives a verdict with a summary (a comment needs one), the
  review says where its reader stands (``review.you``), and ``DELETE …/reviews/mine`` takes it back.
"""
import asyncio
import os
from types import SimpleNamespace

import pytest
from sqlalchemy import text

from backend.app.services.versioning import db, models
from backend.app.services.versioning.errors import AccessDenied, ChangesRequested
from backend.app.services.versioning.review_comments import ReviewComments
from backend.app.services.versioning.review_state import ReviewRule
from backend.app.services.versioning.service import ApprovalRequired, GraphVersioningService, ThreadsOpen

from .test_versioning_pr_gate import _edit_publish, _node, _upd

E2E = pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")


async def _service_run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    G = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="alice")
    gid = G["graph_id"]
    await _edit_publish(svc, gid, "alice", [_node("A", f=1), _node("B", f=1)], "seed")

    async def head(d):
        return next(b for b in (await svc.list_branches(graph_id=gid))[0] if b["branch_id"] == d)["head_commit_id"]

    async def edit(d, eid, f):
        await svc.stage_changes(graph_id=gid, branch_id=d, actor="alice", ops=[_upd(eid, f=f)])
        await svc.checkpoint(graph_id=gid, branch_id=d, actor="alice")

    async def review(reviewers=(), f=0):
        d = await svc.open_draft(graph_id=gid, owner="alice")
        await edit(d, "A", f)
        return d, await svc.open_draft_mr(graph_id=gid, branch_id=d, actor="alice", reviewers=list(reviewers))

    # ── N of anyone's: two of three approvals merge it under requiredApprovals 2 ──
    two = ReviewRule(required_approvals=2)
    d, mr = await review(["carol", "dave", "erin"], f=2)
    await svc.approve_pr(pr_id=mr, actor="carol", expected_head_commit_id=await head(d), rule=two)
    with pytest.raises(ApprovalRequired) as ei:
        await svc.merge_mr(mr_id=mr, actor="alice", message="m", rule=two)
    assert (ei.value.required, ei.value.have) == (2, 1)
    with pytest.raises(ApprovalRequired):                  # everyone asked, the built-in rule
        await svc.merge_mr(mr_id=mr, actor="alice", message="m")
    meta = await svc.approve_pr(pr_id=mr, actor="dave", expected_head_commit_id=await head(d), rule=two)
    states = {r["id"]: r["state"] for r in meta["review"]["reviewers"]}
    assert states == {"carol": "approved", "dave": "approved", "erin": "waiting"}, meta["review"]
    assert await svc.merge_mr(mr_id=mr, actor="alice", message="m", rule=two)

    # ── Two requests for changes hold at once; one commit by the author releases both ──
    d, mr = await review(f=3)
    for who, why in (("carol", "fix the tier"), ("dave", "and the owner")):
        await svc.submit_review(pr_id=mr, actor=who, verdict="request_changes", body=why,
                                expected_head_commit_id=await head(d))
    meta = await svc.get_pr(mr)
    held = {c["by"]: c for c in meta["review"]["changeRequests"]}
    assert set(held) == {"carol", "dave"} and all(c["holds"] for c in held.values())
    assert held["carol"]["reason"] == "fix the tier"
    with pytest.raises(ChangesRequested):
        await svc.merge_mr(mr_id=mr, actor="alice", message="m")
    await edit(d, "A", 4)
    meta = await svc.get_pr(mr)
    assert not any(c["holds"] for c in meta["review"]["changeRequests"]) and meta["changes_requested"] is None
    assert await svc.merge_mr(mr_id=mr, actor="alice", message="m")

    # ── Withdrawing takes back only your own verdict ──
    d, mr = await review(["carol"], f=5)
    await svc.request_changes(pr_id=mr, actor="carol", reason="not yet", expected_head_commit_id=await head(d))
    with pytest.raises(AccessDenied):
        await svc.withdraw_review(pr_id=mr, actor="dave")
    meta = await svc.withdraw_review(pr_id=mr, actor="carol")
    assert meta["review"]["changeRequests"] == [] and meta["review"]["reviewers"][0]["state"] == "waiting"
    meta = await svc.approve_pr(pr_id=mr, actor="carol", expected_head_commit_id=await head(d))
    assert meta["approval_status"] == "approved"
    meta = await svc.withdraw_review(pr_id=mr, actor="carol")
    assert meta["approval_status"] == "pending" and meta["approved_by"] is None
    # A comment is feedback, not a verdict: it neither approves nor holds the merge.
    meta = await svc.submit_review(pr_id=mr, actor="carol", verdict="comment", body="One question")
    assert meta["review"]["reviewers"][0]["state"] == "commented" and meta["approval_status"] == "pending"
    meta = await svc.approve_pr(pr_id=mr, actor="carol", expected_head_commit_id=await head(d))
    assert [r["verdict"] for r in meta["review"]["reviews"]] == ["approve"]       # the latest, per person

    # ── Open threads hold the merge where the rule says ──
    hold = ReviewRule(threads_hold=True)
    rc = ReviewComments()
    thread = (await rc.post(pr_id=mr, actor="carol", body="Why this owner?")).comment
    assert (await svc.get_pr(mr))["review"]["threads"]["open"] == 1
    with pytest.raises(ThreadsOpen) as to:
        await svc.merge_mr(mr_id=mr, actor="alice", message="m", rule=hold)
    assert to.value.count == 1
    await rc.resolve(pr_id=mr, thread_id=thread["id"], actor="alice", resolved=True)
    assert await svc.merge_mr(mr_id=mr, actor="alice", message="m", rule=hold)

    # ── Who is asked is mirrored where the private-draft reads look ──
    d, mr = await review(["carol", "dave"], f=6)
    await svc.update_pr(pr_id=mr, reviewers=["dave"], actor="alice")
    async with db.graphver_session() as s:
        mirrored = (await s.execute(text("SELECT reviewers FROM graphver.merge_requests WHERE id = :id"),
                                    {"id": mr})).scalar_one()
        kinds = (await s.execute(text("SELECT kind FROM graphver.review_events WHERE pr_id = :id "
                                      "ORDER BY created_at, id"), {"id": mr})).scalars().all()
    assert mirrored == ["dave"] and kinds == ["requested", "unrequested"]

    # ── Carried over from the columns: the same review, twice over, past a JSON null ──
    seen = await head(d)
    _d2, other = await review(f=7)
    async with db.graphver_session() as s:
        seq = (await s.execute(text("SELECT commit_seq FROM graphver.commits WHERE id = :id"), {"id": seen})).scalar_one()
        await s.execute(text("DELETE FROM graphver.review_events WHERE pr_id = :id"), {"id": mr})
        await s.execute(text("DELETE FROM graphver.review_requests WHERE pr_id = :id"), {"id": mr})
        await s.execute(text(
            "UPDATE graphver.merge_requests SET reviewers = CAST(:rv AS jsonb), "
            "approved_by = CAST(:ab AS jsonb), approvals = CAST(:ap AS jsonb), "
            "changes_requested = CAST(:cr AS jsonb) WHERE id = :id"), {
            "id": mr, "rv": '["carol", "dave"]', "ab": '["carol"]',
            "ap": f'{{"carol": {{"headCommitId": "{seen}", "headSeq": {seq}, "at": "2026-01-01T00:00:00"}}}}',
            "cr": f'{{"by": "dave", "reason": "the tier", "headCommitId": "{seen}", "headSeq": {seq}, '
                  f'"at": "2026-01-02T00:00:00"}}'})
        await s.execute(text("UPDATE graphver.merge_requests SET reviewers = 'null'::jsonb, "
                             "approved_by = 'null'::jsonb WHERE id = :id"), {"id": other})
        await s.commit()
    for _ in range(2):
        async with db.graphver_session() as s:
            await (await s.connection()).run_sync(models.ensure_review_records)
            await s.commit()
    meta = await svc.get_pr(mr)
    assert meta["approved_by"] == ["carol"] and meta["changes_requested"]["by"] == "dave", meta
    assert {r["id"]: r["state"] for r in meta["review"]["reviewers"]} == {
        "carol": "approved", "dave": "changes_requested"}
    async with db.graphver_session() as s:
        n = (await s.execute(text("SELECT count(*) FROM graphver.review_events WHERE pr_id = :id"),
                             {"id": mr})).scalar_one()
    assert n == 3                                      # asked, carol's approval, dave's request
    assert (await svc.get_pr(other))["review"]["reviewers"] == []


@E2E
def test_review_records_and_the_rule():
    try:
        asyncio.run(_service_run())
    finally:
        asyncio.run(db.dispose_engine())


async def _routes_run(monkeypatch) -> None:
    from httpx import ASGITransport, AsyncClient

    from backend.app.services import drafts_policy

    from .test_api_graph_draft_journey import _IMPORT_NDJSON, _StubCache, _StubManager
    from .test_private_draft_read import _app

    await models.create_schema_and_partitions()
    app, G = _app()
    orig_pm, orig_cache = G.provider_manager, G.get_graph_cache
    G.provider_manager = _StubManager()
    G.get_graph_cache = lambda: _StubCache()
    ds = "ds_" + os.urandom(4).hex()
    V1, GP = "/api/v1/ws1/versioning", "/api/v1/ws1/graph"

    def h(user: str) -> dict:
        return {"X-User": user, "X-Manage": "1", "X-Publish": "1"}

    async def load(_session, _ds):
        return drafts_policy.resolve(None, SimpleNamespace(review_required_approvals=1))
    monkeypatch.setattr(drafts_policy, "load", load)
    try:
        c = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
        async with c:
            r = await c.post(f"{V1}/graphs", json={"dataSourceId": ds, "workspaceId": "ws1"}, headers=h("alice"))
            gid = r.json()["graphId"]
            r = await c.post(f"{V1}/graphs/{gid}/bulk-ingest", content=_IMPORT_NDJSON, headers=h("alice"))
            assert r.status_code == 200, r.text
            B = f"{V1}/graphs/{gid}/branches"
            d = (await c.post(B, json={"visibility": "public"}, headers=h("alice"))).json()["branchId"]
            save = {"ops": [{"op": "update", "kind": "node", "id": "urn:t:child", "payload": {"description": "x"}}]}
            r = await c.post(f"{GP}/changes", params={"dataSourceId": ds, "branchId": d}, json=save,
                             headers=h("alice"))
            assert r.status_code == 200, r.text
            r = await c.post(f"{B}/{d}/merge-requests", json={"reviewers": ["dave", "erin"]}, headers=h("alice"))
            assert r.status_code == 201, r.text
            pr = r.json()["prId"]
            R = f"{V1}/merge-requests/{pr}/reviews"

            r = await c.get(f"{V1}/merge-requests/{pr}", headers=h("dave"))
            body = r.json()
            assert body["review"]["requiredApprovals"] == 1 and body["review"]["you"]["needsReview"] is True
            head = body["headCommitId"]
            r = await c.post(R, json={"verdict": "comment", "body": "  "}, headers=h("dave"))
            assert (r.status_code, r.json()["detail"]["type"]) == (422, "summary_required"), r.text
            r = await c.post(R, json={"verdict": "comment", "body": "Is the owner right?"}, headers=h("dave"))
            assert r.status_code == 200 and r.json()["approvalStatus"] == "pending", r.text
            r = await c.post(R, json={"verdict": "approve", "body": "Looks right", "expectedHeadCommitId": head},
                             headers=h("dave"))
            assert r.status_code == 200, r.text
            # One of two asked approved, and one is all the data source's rule needs.
            assert r.json()["approvalStatus"] == "approved" and r.json()["status"] == "approved", r.text
            assert r.json()["review"]["approvals"] == {"required": 1, "have": 1, "satisfied": True}
            you = (await c.get(f"{V1}/merge-requests/{pr}", headers=h("dave"))).json()["review"]["you"]
            assert (you["verdict"], you["needsReview"], you["updatedSinceReviewed"]) == ("approve", False, False)
            r = await c.post(R, json={"verdict": "approve", "expectedHeadCommitId": "c_old"}, headers=h("erin"))
            assert (r.status_code, r.json()["detail"]["type"]) == (409, "head_moved"), r.text
            r = await c.delete(f"{R}/mine", headers=h("dave"))
            assert r.status_code == 200 and r.json()["approvalStatus"] == "pending", r.text
            r = await c.post(R, json={"verdict": "request_changes", "body": "Owner is wrong",
                                      "expectedHeadCommitId": head}, headers=h("erin"))
            assert r.status_code == 200, r.text
            assert r.json()["review"]["changeRequests"][0]["by"] == "erin"
            r = await c.post(R, json={"verdict": "approve", "expectedHeadCommitId": head}, headers=h("dave"))
            r = await c.post(f"{V1}/merge-requests/{pr}/merge", json={"message": "m"}, headers=h("alice"))
            assert (r.status_code, r.json()["detail"]["type"]) == (409, "changes_requested"), r.text
    finally:
        G.provider_manager, G.get_graph_cache = orig_pm, orig_cache
        await db.dispose_engine()


@E2E
def test_reviews_over_http(data_sources, monkeypatch):
    asyncio.run(_routes_run(monkeypatch))
