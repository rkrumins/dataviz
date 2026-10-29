"""PR approval + checks gate (P8) — needs Postgres.

A fork PR into a parent's main is gated by (1) every requested reviewer's approval
and (2) re-validation of the merged result against the *parent's* ontology. Both
are checked before any write; a no-reviewer PR over a clean ontology merges as
before.

An approval is bound to the head of the branch it was given on (doc 13 'Staleness'): a content
commit after it makes it stale, and the merge asks for it again; a pull that rewrote none of the
draft's own edits keeps it. Approving with the head the reviewer saw answers ``head_moved`` when the
draft has moved on since. Advancing main (publish, merge, revert, restore, sync) needs
``workspace:datasource:publish`` over HTTP, on top of manage.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.service import (
    AccessDenied,
    ApprovalRequired,
    GraphVersioningService,
    OntologyViolation,
)


async def _edit_publish(svc, gid, actor, ops, msg):
    d = await svc.open_draft(graph_id=gid, owner=actor)
    await svc.stage_changes(graph_id=gid, branch_id=d, actor=actor, ops=ops)
    await svc.checkpoint(graph_id=gid, branch_id=d, actor=actor)
    return await svc.publish(graph_id=gid, branch_id=d, actor=actor, message=msg)


def _node(eid, et="Dataset", **kw):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"displayName": eid, "entityType": et, **kw}}


def _upd(eid, **kw):
    return {"op": "update", "entity_kind": "node", "entity_id": eid,
            "payload": {"displayName": eid, "entityType": "Dataset", **kw}}


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    ds = lambda: "ds_" + os.urandom(4).hex()

    # ══ A. approval gate (parent has no ontology → checks always pass) ════
    P = await svc.create_graph(data_source_id=ds(), workspace_id="ws1", actor="alice")
    pg, pmain = P["graph_id"], P["main_branch_id"]
    await _edit_publish(svc, pg, "alice", [_node("A", f=1)], "seed")
    F = await svc.fork_graph(parent_graph_id=pg, workspace_id="ws1", actor="bob")
    await _edit_publish(svc, F["graph_id"], "bob", [_node("A", f=10)], "fork edit")

    pr = await svc.open_pr(source_graph_id=F["graph_id"], actor="bob", reviewers=["carol"])
    assert (await svc.get_pr(pr))["approval_status"] == "pending"
    # The merge route queues a merge job by the source's change count in the TARGET graph, which a
    # fork's main never has there: a fork PR always merges in the request, never through
    # create_publish_job (which would lock and hold a draft of the target graph).
    assert await svc.branch_change_count(graph_id=pg, branch_id=(await svc.get_pr(pr))["source_branch_id"]) == 0
    with pytest.raises(ApprovalRequired) as ei:                  # unapproved → blocked
        await svc.merge_pr(pr_id=pr, actor="dave", message="merge")
    assert ei.value.pending == ["carol"]
    with pytest.raises(AccessDenied):                            # author can't self-approve
        await svc.approve_pr(pr_id=pr, actor="bob")
    meta = await svc.approve_pr(pr_id=pr, actor="carol")
    assert meta["approval_status"] == "approved" and meta["status"] == "approved"
    assert await svc.merge_pr(pr_id=pr, actor="dave", message="merge")   # now allowed
    assert (await svc.materialize_state(graph_id=pg, branch_id=pmain))["nodes"]["A"]["f"] == 10
    assert (await svc.get_pr(pr))["checks_status"]["ontology"]["ok"] is True

    # ══ B. checks gate (parent enforces a strict Dataset-only ontology) ═══
    async with db.graphver_session() as s:
        await s.execute(__import__("sqlalchemy").text(
            "ALTER TABLE graphver.graphs ADD COLUMN IF NOT EXISTS ontology_spec jsonb"))
    Q = await svc.create_graph(data_source_id=ds(), workspace_id="ws1", actor="alice",
                               ontology_spec={"entityTypes": ["Dataset"]}, ontology_enforcement="strict")
    qg, qmain = Q["graph_id"], Q["main_branch_id"]
    await _edit_publish(svc, qg, "alice", [_node("A", et="Dataset", f=1)], "seed")

    # fork has no ontology, so it can stage an out-of-vocab type freely…
    Fbad = await svc.fork_graph(parent_graph_id=qg, workspace_id="ws1", actor="bob")
    await _edit_publish(svc, Fbad["graph_id"], "bob", [_node("X", et="Bad")], "bad type")
    prbad = await svc.open_pr(source_graph_id=Fbad["graph_id"], actor="bob")   # no reviewers
    with pytest.raises(OntologyViolation) as ev:                 # …but the gate rejects the merge
        await svc.merge_pr(pr_id=prbad, actor="alice", message="merge bad")
    assert any(v["entity_id"] == "X" for v in ev.value.violations)
    assert (await svc.materialize_state(graph_id=qg, branch_id=qmain))["nodes"].get("X") is None

    # a valid-type fork PR passes the gate and merges (no reviewers required)
    Fok = await svc.fork_graph(parent_graph_id=qg, workspace_id="ws1", actor="bob")
    await _edit_publish(svc, Fok["graph_id"], "bob", [_node("Y", et="Dataset")], "good type")
    prok = await svc.open_pr(source_graph_id=Fok["graph_id"], actor="bob")
    assert await svc.merge_pr(pr_id=prok, actor="alice", message="merge ok")
    assert "Y" in (await svc.materialize_state(graph_id=qg, branch_id=qmain))["nodes"]

    await db.dispose_engine()


async def _run_head_bound_approvals() -> None:
    from backend.app.services.versioning.errors import HeadMoved

    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    G = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="alice")
    gid = G["graph_id"]
    await _edit_publish(svc, gid, "alice", [_node("A", f=1), _node("B", f=1)], "seed")

    async def draft(owner, ops):
        d = await svc.open_draft(graph_id=gid, owner=owner)
        await svc.stage_changes(graph_id=gid, branch_id=d, actor=owner, ops=ops)
        await svc.checkpoint(graph_id=gid, branch_id=d, actor=owner)
        return d

    async def head(d):
        return next(b for b in (await svc.list_branches(graph_id=gid))[0] if b["branch_id"] == d)["head_commit_id"]

    async def reviewed(ops):
        d = await draft("alice", ops)
        mr = await svc.open_draft_mr(graph_id=gid, branch_id=d, actor="alice", reviewers=["carol"])
        await svc.approve_pr(pr_id=mr, actor="carol", expected_head_commit_id=await head(d))
        return d, mr

    # ── An edit after the approval makes it stale: the merge asks carol again ──
    d1, mr1 = await reviewed([_upd("A", f=2)])
    seen = await head(d1)
    await svc.stage_changes(graph_id=gid, branch_id=d1, actor="alice", ops=[_upd("A", f=3)])
    await svc.checkpoint(graph_id=gid, branch_id=d1, actor="alice")
    with pytest.raises(ApprovalRequired) as ei:
        await svc.merge_mr(mr_id=mr1, actor="alice", message="merge")
    assert ei.value.pending == ["carol"] and ei.value.stale == ["carol"]
    meta = await svc.get_pr(mr1)                       # the review shows it as wanted again
    assert meta["approval_status"] == "pending" and "carol" not in (meta["approved_by"] or []), meta
    # Approving what she saw before the edit is refused: the draft has moved on.
    with pytest.raises(HeadMoved) as hm:
        await svc.approve_pr(pr_id=mr1, actor="carol", expected_head_commit_id=seen)
    now = await head(d1)
    assert now != seen and hm.value.detail["headCommitId"] == now
    assert hm.value.detail["type"] == "head_moved" and hm.value.status_code == 409
    await svc.approve_pr(pr_id=mr1, actor="carol", expected_head_commit_id=now)
    assert await svc.merge_mr(mr_id=mr1, actor="alice", message="merge")

    # ── A pull that brings main's work in and rewrites none of the draft's edits keeps it ──
    d2, mr2 = await reviewed([_upd("A", f=4)])
    await _edit_publish(svc, gid, "erin", [_node("U", f=1)], "upstream")
    pulled = await svc.rebase_draft(graph_id=gid, branch_id=d2, actor="alice")
    assert pulled["clean"] is True and pulled["changes"] == {"create": 0, "update": 0, "delete": 0}
    assert (await svc.get_pr(mr2))["approval_status"] == "approved"
    assert await svc.merge_mr(mr_id=mr2, actor="alice", message="merge")

    # ── A pull whose resolution rewrites the draft's edit is content: it stales the approval ──
    d3, mr3 = await reviewed([_upd("B", f=30)])
    await _edit_publish(svc, gid, "erin", [_upd("B", f=40)], "upstream B")
    assert (await svc.rebase_draft(graph_id=gid, branch_id=d3, actor="alice"))["clean"] is False
    pulled = await svc.rebase_draft(graph_id=gid, branch_id=d3, actor="alice",
                                    resolutions={"B": {"displayName": "B", "entityType": "Dataset", "f": 40}})
    assert pulled["clean"] is True and pulled["changes"]["update"] == 1
    with pytest.raises(ApprovalRequired) as ei:
        await svc.merge_mr(mr_id=mr3, actor="alice", message="merge")
    assert ei.value.stale == ["carol"]

    # ── An approval with no recorded head (given before approvals were bound) is stale ──
    d4, mr4 = await reviewed([_node("L")])
    async with db.graphver_session() as s:
        await s.execute(__import__("sqlalchemy").text(
            "UPDATE graphver.merge_requests SET approvals = NULL WHERE id = :id"), {"id": mr4})
    with pytest.raises(ApprovalRequired) as ei:
        await svc.merge_mr(mr_id=mr4, actor="alice", message="merge")
    assert ei.value.stale == ["carol"]

    # ── A checkpoint that lands while the approval is being recorded is not approved with it ──
    # The approval records the head carol saw and that head's seq, never a later commit's.
    d5 = await draft("alice", [_upd("A", f=5)])
    mr5 = await svc.open_draft_mr(graph_id=gid, branch_id=d5, actor="alice", reviewers=["carol"])
    seen = await head(d5)
    next_seq, raced = svc._next_seq, []

    async def a_checkpoint_lands_first(s, graph_id, branch_id):
        if not raced:
            raced.append(1)
            await svc.stage_changes(graph_id=gid, branch_id=d5, actor="alice", ops=[_upd("A", f=6)])
            await svc.checkpoint(graph_id=gid, branch_id=d5, actor="alice")
        return await next_seq(s, graph_id, branch_id)
    svc._next_seq = a_checkpoint_lands_first
    try:
        await svc.approve_pr(pr_id=mr5, actor="carol", expected_head_commit_id=seen)
    finally:
        svc._next_seq = next_seq
    if not raced:                                      # the checkpoint lands just after, then
        await svc.stage_changes(graph_id=gid, branch_id=d5, actor="alice", ops=[_upd("A", f=6)])
        await svc.checkpoint(graph_id=gid, branch_id=d5, actor="alice")
    async with db.graphver_session() as s:
        rec = (await s.execute(__import__("sqlalchemy").text(
            "SELECT approvals->'carol' FROM graphver.merge_requests WHERE id = :id"), {"id": mr5})).scalar_one()
        seq = (await s.execute(__import__("sqlalchemy").text(
            "SELECT commit_seq FROM graphver.commits WHERE id = :id"), {"id": seen})).scalar_one()
    assert rec["headCommitId"] == seen and rec["headSeq"] == seq, rec
    meta = await svc.get_pr(mr5)
    assert meta["approval_status"] == "pending" and meta["stale_approved_by"] == ["carol"], meta
    assert meta["head_commit_id"] == await head(d5) != seen, meta

    # ── The draft's owner can't approve a review of it, any more than its author can ──
    from backend.app.services.versioning.errors import SelfReview
    d6 = await draft("bob", [_upd("B", f=6)])
    await svc.add_branch_member(graph_id=gid, branch_id=d6, subject_type="user", subject_id="alice",
                                role="editor", actor="bob")
    mr6 = await svc.open_draft_mr(graph_id=gid, branch_id=d6, actor="alice", reviewers=["bob", "carol"])
    for who in ("bob", "alice"):
        with pytest.raises(SelfReview) as sr:
            await svc.approve_pr(pr_id=mr6, actor=who)
        assert (sr.value.status_code, sr.value.detail["code"]) == (403, "self_review")
    assert (await svc.approve_pr(pr_id=mr6, actor="carol"))["approved_by"] == ["carol"]

    await db.dispose_engine()


def _publish_app():
    """The real routers, with the caller picked by ``X-User``: ``mia`` holds read and manage, as a
    workspace_member does; ``pat`` holds publish as well, as a workspace_publisher does."""
    from fastapi import Request
    from types import SimpleNamespace
    from backend.app.auth.dependencies import get_current_user, get_optional_user, get_permission_claims
    from backend.app.services.permission_service import PermissionClaims
    from .test_api_graph_draft_journey import _build_app

    app, G = _build_app()

    async def header_user(request: Request):
        uid = request.headers.get("X-User", "pat")
        return SimpleNamespace(id=uid, email=f"{uid}@example.com")

    async def claims(request: Request):
        perms = ("workspace:datasource:read", "workspace:datasource:manage")
        if request.headers.get("X-User", "pat") == "pat":
            perms += ("workspace:datasource:publish",)
        return PermissionClaims(sid="", global_perms=(), ws_perms={"ws1": perms})

    app.dependency_overrides[get_current_user] = header_user
    app.dependency_overrides[get_optional_user] = header_user
    app.dependency_overrides[get_permission_claims] = claims
    return app, G


async def _run_publish_permission() -> None:
    from httpx import ASGITransport, AsyncClient
    from .test_api_graph_draft_journey import _IMPORT_NDJSON, _StubCache, _StubManager

    await models.create_schema_and_partitions()
    app, G = _publish_app()
    orig_pm, orig_cache = G.provider_manager, G.get_graph_cache
    G.provider_manager = _StubManager()
    G.get_graph_cache = lambda: _StubCache()
    ds = "ds_" + os.urandom(4).hex()
    V1 = "/api/v1/ws1/versioning"
    mia, pat = {"X-User": "mia"}, {"X-User": "pat"}

    def needs_publish(r):
        assert r.status_code == 403, r.text
        assert r.json()["detail"]["permission"] == "workspace:datasource:publish", r.text

    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            r = await c.post(f"{V1}/graphs", json={"dataSourceId": ds, "workspaceId": "ws1"}, headers=pat)
            assert r.status_code == 201, r.text
            gid = r.json()["graphId"]
            r = await c.post(f"{V1}/graphs/{gid}/bulk-ingest", content=_IMPORT_NDJSON, headers=pat)
            assert r.status_code == 200, r.text
            seed = (await c.get(f"{V1}/graphs/{gid}/commits", headers=pat)).json()["commits"][0]["commit_id"]

            async def draft(who, eid):
                d = (await c.post(f"{V1}/graphs/{gid}/branches", json={}, headers=who)).json()["branchId"]
                ops = {"ops": [{"op": "create", "entityKind": "node", "entityId": eid,
                                "payload": {"urn": eid, "entityType": "Table", "displayName": eid}}]}
                assert (await c.post(f"{V1}/graphs/{gid}/branches/{d}/changes", json=ops, headers=who)).status_code == 200
                assert (await c.post(f"{V1}/graphs/{gid}/branches/{d}/commit", json={}, headers=who)).status_code == 200
                return d

            # Mia edits and raises a review, but nothing she does advances main.
            d = await draft(mia, "urn:t:mia")
            needs_publish(await c.post(f"{V1}/graphs/{gid}/branches/{d}/publish", json={"message": "m"}, headers=mia))
            r = await c.post(f"{V1}/graphs/{gid}/branches/{d}/merge-requests", json={}, headers=mia)
            assert r.status_code == 201, r.text
            mr = r.json()["prId"]
            needs_publish(await c.post(f"{V1}/merge-requests/{mr}/merge", json={"message": "m"}, headers=mia))
            needs_publish(await c.post(f"{V1}/graphs/{gid}/commits/{seed}/revert", json={}, headers=mia))
            needs_publish(await c.post(f"{V1}/graphs/{gid}/commits/{seed}/restore", json={}, headers=mia))
            needs_publish(await c.post(f"{V1}/graphs/{gid}/sync", content=_IMPORT_NDJSON, headers=mia))
            needs_publish(await c.post("/api/v1/ws1/graph/resync", params={"dataSourceId": ds}, headers=mia))
            assert (await c.get(f"{V1}/graphs/{gid}/commits", headers=pat)).json()["commits"][0]["commit_id"] == seed

            # Pat merges her review, publishes his own draft, and reverts and restores main.
            r = await c.post(f"{V1}/merge-requests/{mr}/merge", json={"message": "m"}, headers=pat)
            assert r.status_code == 200, r.text
            merged = r.json()["commitId"]
            d2 = await draft(pat, "urn:t:pat")
            r = await c.post(f"{V1}/graphs/{gid}/branches/{d2}/publish", json={"message": "p"}, headers=pat)
            assert r.status_code == 200, r.text
            r = await c.post(f"{V1}/graphs/{gid}/commits/{merged}/revert", json={}, headers=pat)
            assert r.status_code == 200, r.text
            r = await c.post(f"{V1}/graphs/{gid}/commits/{seed}/restore", json={}, headers=pat)
            assert r.status_code == 200, r.text
            r = await c.post(f"{V1}/graphs/{gid}/sync", content=_IMPORT_NDJSON, headers=pat)
            assert r.status_code == 200, r.text

            # Approving with the head the reviewer saw: 409 head_moved once the draft moved on.
            d3 = await draft(mia, "urn:t:mia2")
            r = await c.post(f"{V1}/graphs/{gid}/branches/{d3}/merge-requests",
                             json={"reviewers": ["pat"]}, headers=mia)
            assert r.status_code == 201, r.text
            mr3 = r.json()["prId"]
            r = await c.post(f"{V1}/merge-requests/{mr3}/approve", json={"expectedHeadCommitId": "c_old"}, headers=pat)
            assert r.status_code == 409 and r.json()["detail"]["type"] == "head_moved", r.text
            # The PR read carries the head to approve: the draft's head now.
            head = r.json()["detail"]["headCommitId"]
            r = await c.get(f"{V1}/merge-requests/{mr3}", headers=pat)
            assert r.status_code == 200 and head and r.json()["headCommitId"] == head, r.text
            # The draft's owner (mia raised it, too) is refused with a code that says why.
            r = await c.post(f"{V1}/merge-requests/{mr3}/approve", json={"expectedHeadCommitId": head}, headers=mia)
            assert r.status_code == 403 and r.json()["detail"]["code"] == "self_review", r.text
            r = await c.post(f"{V1}/merge-requests/{mr3}/approve", json={"expectedHeadCommitId": head}, headers=pat)
            assert r.status_code == 200 and r.json()["approvalStatus"] == "approved", r.text
            r = await c.post(f"{V1}/merge-requests/{mr3}/approve", headers=pat)      # no body: as before
            assert r.status_code == 200 and r.json()["approvalStatus"] == "approved", r.text
    finally:
        G.provider_manager, G.get_graph_cache = orig_pm, orig_cache
        await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_pr_gate_e2e():
    asyncio.run(_run())


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_an_approval_is_bound_to_the_head_it_was_given_on():
    asyncio.run(_run_head_bound_approvals())


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_advancing_main_needs_the_publish_permission(data_sources):
    asyncio.run(_run_publish_permission())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning PR approval + checks gate e2e: OK")
