"""Who reviews a review: people and groups, edited and asked again — needs Postgres.

* **A group asked:** any member reads the private draft under review and finds it in their queue;
  someone in no such group doesn't. A member's approval answers for the group (their groups looked
  up when it is given); whoever opened it can't approve it for their group where the policy says
  someone else approves.
* **Edited:** people and groups added and removed, each kind on its own, recorded in the review's
  events; a settled review's reviewers are refused.
* **Asked again:** the review is back in their queue though they reviewed it; someone not asked is
  refused.
* **Its history:** opened, asked, reviewed, edited, asked again and closed, in order.
* **Over HTTP:** the groups that can be asked, a group named on the review, an unknown group
  refused, who is told when a group is asked or asked again, and the history with its names.
"""
import asyncio
import os

import pytest
from sqlalchemy import select

from backend.app.services.versioning import db, models
from backend.app.services.versioning import service as service_mod
from backend.app.services.versioning.errors import DraftNotReadable, SelfReview
from backend.app.services.versioning.models import ReviewEventORM
from backend.app.services.versioning.service import GraphVersioningService, Viewer

from .test_versioning_pr_gate import _node

E2E = pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")


def _groups_of(monkeypatch, teams: dict) -> list:
    """The management DB's group lookup: ``teams`` maps a person to their groups. Returns who was looked up."""
    calls: list = []

    async def load(actor):
        calls.append(actor)
        return tuple(teams.get(actor, ()))
    monkeypatch.setattr(service_mod, "_load_actor_groups", load)
    return calls


async def _head(svc, gid, d):
    return next(b for b in (await svc.list_branches(graph_id=gid))[0] if b["branch_id"] == d)["head_commit_id"]


def _asked(pr):
    return {(r["type"], r["id"]): r for r in pr["review"]["reviewers"]}


async def _service_run(monkeypatch) -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    ws = "ws_" + os.urandom(4).hex()
    gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id=ws, actor="ana"))["graph_id"]
    fin = "grp_" + os.urandom(4).hex()
    _groups_of(monkeypatch, {"erin": [fin], "frank": [fin], "ana": [fin]})
    d = await svc.open_draft(graph_id=gid, owner="ana", visibility="private")
    await svc.stage_changes(graph_id=gid, branch_id=d, actor="ana", ops=[_node("G1")])
    await svc.checkpoint(graph_id=gid, branch_id=d, actor="ana")
    pr = await svc.open_draft_mr(graph_id=gid, branch_id=d, actor="ana", reviewers=["carol"], title="G1",
                                 reviewer_groups=[fin])
    meta = await svc.get_pr(pr)
    assert set(_asked(meta)) == {("user", "carol"), ("group", fin)} and meta["approval_status"] == "pending"

    def who(actor):
        return Viewer(actor=actor, can_manage=True, can_read=True)

    # A member of the group asked reads the private draft and finds the review in their queue.
    await svc.assert_branch_readable(graph_id=gid, branch_id=d, viewer=who("erin"))
    with pytest.raises(DraftNotReadable):
        await svc.assert_branch_readable(graph_id=gid, branch_id=d, viewer=who("gina"))
    assert pr in [p["pr_id"] for p in (await svc.list_pulls(target_graph_id=gid, viewer=who("erin")))]
    assert pr not in [p["pr_id"] for p in (await svc.list_pulls(target_graph_id=gid, viewer=who("gina")))]
    inbox = await svc.review_inbox(workspace_id=ws, viewer=who("erin"))
    assert [i["pr_id"] for i in inbox["items"]] == [pr]

    # Whoever opened it can't approve it for the group where someone else approves.
    with pytest.raises(SelfReview):
        await svc.approve_pr(pr_id=pr, actor="ana", self_approval=False,
                             expected_head_commit_id=await _head(svc, gid, d))
    # Erin's approval answers for the group: her groups are looked up as she gives it.
    meta = await svc.approve_pr(pr_id=pr, actor="erin", expected_head_commit_id=await _head(svc, gid, d))
    group = _asked(meta)[("group", fin)]
    assert (group["state"], group["by"]) == ("approved", "erin"), group
    assert meta["approval_status"] == "pending"                     # carol is still asked
    assert (await svc.review_inbox(workspace_id=ws, viewer=who("frank")))["items"] == []   # answered for

    # Edited: carol is no longer asked; the group's approval is all it needs.
    meta = await svc.update_pr(pr_id=pr, reviewers=[], actor="ana")
    assert set(_asked(meta)) == {("group", fin)} and meta["approval_status"] == "approved"
    meta = await svc.update_pr(pr_id=pr, reviewer_groups=[], reviewers=["dave"], actor="ana")
    assert set(_asked(meta)) == {("user", "dave")}
    meta = await svc.update_pr(pr_id=pr, reviewer_groups=[fin], actor="ana")    # people kept
    assert set(_asked(meta)) == {("user", "dave"), ("group", fin)}
    async with db.graphver_session() as s:
        kinds = [(e.kind, [x["id"] for x in e.subjects or ()]) for e in (await s.execute(
            select(ReviewEventORM).where(ReviewEventORM.pr_id == pr, ReviewEventORM.kind != "reviewed")
            .order_by(ReviewEventORM.created_at, ReviewEventORM.id))).scalars()]
    assert kinds == [("requested", ["carol", fin]), ("unrequested", ["carol"]), ("requested", ["dave"]),
                     ("unrequested", [fin]), ("requested", [fin])], kinds

    # Asked again: back in erin's queue though she approved; someone not asked is refused.
    await asyncio.sleep(0.01)
    await svc.re_request(pr_id=pr, groups=[fin], actor="ana")
    assert [i["pr_id"] for i in (await svc.review_inbox(workspace_id=ws, viewer=who("erin")))["items"]] == [pr]
    with pytest.raises(ValueError):
        await svc.re_request(pr_id=pr, users=["gina"], actor="ana")

    # Settled: its reviewers stay as they are.
    await svc.close_pr(pr_id=pr, actor="ana")
    with pytest.raises(ValueError):
        await svc.update_pr(pr_id=pr, reviewers=["carol"], actor="ana")
    with pytest.raises(ValueError):
        await svc.re_request(pr_id=pr, users=["dave"], actor="ana")

    # Its history, oldest first: opened, asked, reviewed, edited, asked again, closed.
    events = await svc.review_events(pr_id=pr)
    assert [e["kind"] for e in events] == ["opened", "requested", "reviewed", "unrequested", "requested",
                                           "unrequested", "requested", "re_requested", "closed"], events
    review = events[2]
    assert (review["actor"], review["verdict"], review["groups"]) == ("erin", "approve", [fin]), review


@E2E
def test_group_reviewers_edited_and_asked_again(monkeypatch):
    try:
        asyncio.run(_service_run(monkeypatch))
    finally:
        asyncio.run(db.dispose_engine())


async def _routes_run(monkeypatch) -> None:
    from types import SimpleNamespace

    from httpx import ASGITransport, AsyncClient

    from backend.app.api.v1.endpoints import versioning as routes
    from backend.app.db.engine import get_async_session
    from backend.app.db.repositories import group_repo, notification_repo

    from .test_api_graph_draft_journey import _StubCache, _StubManager
    from .test_private_draft_read import _app

    told = []

    async def notify(session, *, user_ids, kind, **kw):
        told.append((kind, sorted(u for u in user_ids if u != kw.get("actor_id"))))
        return len(told)
    monkeypatch.setattr(notification_repo, "notify", notify)

    tag = os.urandom(3).hex()
    async with get_async_session() as ms:
        fin = await group_repo.create_group(ms, f"Finance stewards {tag}")
        ops = await group_repo.create_group(ms, f"Ops {tag}")          # not bound to review here
        fin_id, ops_id = fin.id, ops.id
    # Its members (who aren't users of this database): erin and frank.
    members = {fin_id: ["erin", "frank"]}
    _groups_of(monkeypatch, {"erin": [fin_id], "frank": [fin_id]})

    async def list_group_members(_s, gid):
        return [SimpleNamespace(user_id=u) for u in members.get(gid, ())]

    async def count_members_batch(_s, gids):
        return {g: len(members[g]) for g in gids if g in members}
    monkeypatch.setattr(group_repo, "list_group_members", list_group_members)
    monkeypatch.setattr(group_repo, "count_members_batch", count_members_batch)

    async def bindings(_session, _ws):
        return [SimpleNamespace(subject_type="group", subject_id=fin_id, role_name="editor")]
    monkeypatch.setattr(routes, "_reviewing_bindings", bindings)

    await models.create_schema_and_partitions()
    app, G = _app()
    orig_pm, orig_cache = G.provider_manager, G.get_graph_cache
    G.provider_manager = _StubManager()
    G.get_graph_cache = lambda: _StubCache()
    svc = GraphVersioningService()
    gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="ana"))["graph_id"]
    V1 = "/api/v1/ws1/versioning"

    def h(user):
        return {"X-User": user, "X-Manage": "1"}
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            r = await c.get(f"{V1}/reviewer-groups", headers=h("ana"))
            assert r.status_code == 200, r.text
            assert r.json() == [{"groupId": fin_id, "name": f"Finance stewards {tag}", "description": None,
                                 "memberCount": 2}]

            d = await svc.open_draft(graph_id=gid, owner="ana")
            await svc.stage_changes(graph_id=gid, branch_id=d, actor="ana", ops=[_node("H1")])
            await svc.checkpoint(graph_id=gid, branch_id=d, actor="ana")
            r = await c.post(f"{V1}/graphs/{gid}/branches/{d}/merge-requests",
                             json={"title": "H1", "reviewerGroups": [ops_id]}, headers=h("ana"))
            assert r.status_code == 422 and r.json()["detail"]["type"] == "unknown_group", r.text
            r = await c.post(f"{V1}/graphs/{gid}/branches/{d}/merge-requests",
                             json={"title": "H1", "reviewers": ["carol"], "reviewerGroups": [fin_id]},
                             headers=h("ana"))
            assert r.status_code == 201, r.text
            pr = r.json()["prId"]
            # Carol and the group's members are told they are asked; not again that it is up for review.
            assert ("review.requested", ["carol", "erin", "frank"]) in told, told
            assert all(not {"carol", "erin"} & set(to) for kind, to in told if kind == "draft.sent_for_review")

            told.clear()
            r = await c.put(f"{V1}/merge-requests/{pr}/reviewers", json={"users": ["dave"]}, headers=h("ana"))
            assert r.status_code == 200, r.text
            body = r.json()
            assert {(x["type"], x["id"]) for x in body["review"]["reviewers"]} == {("user", "dave"), ("group", fin_id)}
            assert next(x for x in body["review"]["reviewers"] if x["type"] == "group")["name"] == f"Finance stewards {tag}"
            assert told == [("review.requested", ["dave"])], told
            r = await c.put(f"{V1}/merge-requests/{pr}/reviewers", json={"groups": [fin_id, ops_id]}, headers=h("ana"))
            assert r.status_code == 422 and r.json()["detail"]["groups"] == [ops_id], r.text

            # A member reads it, approves it for the group.
            r = await c.get(f"{V1}/merge-requests/{pr}", headers=h("erin"))
            assert r.status_code == 200, r.text
            r = await c.post(f"{V1}/merge-requests/{pr}/reviews",
                             json={"verdict": "approve", "expectedHeadCommitId": r.json()["headCommitId"]},
                             headers=h("erin"))
            assert r.status_code == 200, r.text
            group = next(x for x in r.json()["review"]["reviewers"] if x["type"] == "group")
            assert (group["state"], group["by"]) == ("approved", "erin")

            told.clear()
            r = await c.post(f"{V1}/merge-requests/{pr}/reviewers/re-request", json={"groups": [fin_id]},
                             headers=h("ana"))
            assert r.status_code == 200 and told == [("review.requested", ["erin", "frank"])], (r.text, told)
            r = await c.get(f"{V1}/merge-requests/{pr}/events", headers=h("ana"))
            assert r.status_code == 200, r.text
            history = r.json()
            assert [e["kind"] for e in history["events"]][-1] == "re_requested", history
            assert history["groupNames"] == {fin_id: f"Finance stewards {tag}"}, history
            r = await c.post(f"{V1}/pulls/{pr}/reviewers/re-request", json={"users": ["gina"]}, headers=h("ana"))
            assert r.status_code in (400, 404, 422), r.text
            r = await c.put(f"{V1}/merge-requests/{pr}/reviewers", json={"users": []}, headers={"X-User": "erin"})
            assert r.status_code == 403, r.text
    finally:
        G.provider_manager, G.get_graph_cache = orig_pm, orig_cache
        async with get_async_session() as ms:
            for g in (fin_id, ops_id):
                await group_repo.soft_delete_group(ms, g)
        await db.dispose_engine()


@E2E
def test_group_reviewers_over_http(data_sources, monkeypatch):
    asyncio.run(_routes_run(monkeypatch))
