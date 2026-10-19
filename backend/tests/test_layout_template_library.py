"""The template library's discovery and governance: featured, favourites,
recently used, requests to offer a team's template to everyone, and a
workspace's default template.

* only a template manager features a template, and only one everyone can use;
* a favourite is the caller's alone, and can be dropped even without access;
* "recently used" is the caller's latest live view built from it;
* an owner asks for a team template to be offered to everyone, the managers
  hear about it and may read it until one of them answers, approving moves it
  to the organization (managers look after it from then on), and the requester
  hears the answer;
* a workspace's default must be a template every member can use.
"""
from __future__ import annotations

from sqlalchemy import select

from backend.app.db.models import (
    ContextModelORM, NotificationORM, PermissionORM, RoleBindingORM, RolePermissionORM,
)
from backend.tests.test_layout_templates import (  # noqa: F401
    MANAGE, URL, WS, WS_OTHER, _as, library,
)


async def _managers(session) -> None:
    """``usr_manager`` holds Manage templates through a global role, as in
    production — the conftest catalogue predates the permission."""
    session.add(PermissionORM(id=MANAGE, description="Curate templates.", category="system"))
    session.add(RolePermissionORM(role_name="org_admin", permission_id=MANAGE))
    session.add(RoleBindingORM(
        subject_type="user", subject_id="usr_manager", role_name="org_admin", scope_type="global",
    ))
    await session.flush()


async def _get(client, who, template_id):
    with _as(who):
        return await client.get(f"{URL}/{template_id}")


async def _notes(session, kind):
    rows = (await session.execute(select(NotificationORM).where(NotificationORM.kind == kind))).scalars().all()
    return sorted((n.user_id, n.title) for n in rows)


# ── Featured ─────────────────────────────────────────────────────────

async def test_only_a_manager_features_and_only_what_everyone_sees(test_client, db_session, library):
    with _as("manager"):
        featured = await test_client.put(f"{URL}/t_org/featured", json={"featured": True})
        builtin = await test_client.put(f"{URL}/t_builtin/featured", json={"featured": True})
    assert featured.status_code == 200 and featured.json()["featured"] is True
    assert builtin.json()["featured"] is True
    assert (await _get(test_client, "dave", "t_org")).json()["featured"] is True

    with _as("alice"):
        assert (await test_client.put(f"{URL}/t_org/featured", json={"featured": False})).status_code == 403
    with _as("wsadmin"):  # a workspace template is not everyone's
        assert (await test_client.put(f"{URL}/t_ws/featured", json={"featured": True})).status_code == 403


# ── Favourites and recently used ─────────────────────────────────────

async def test_a_favourite_is_the_callers_alone(test_client, db_session, library):
    with _as("alice"):
        assert (await test_client.post(f"{URL}/t_org/favourite")).json()["isFavourite"] is True
        assert (await test_client.post(f"{URL}/t_org/favourite")).status_code == 200  # again is fine
    assert (await _get(test_client, "alice", "t_org")).json()["isFavourite"] is True
    assert (await _get(test_client, "dave", "t_org")).json()["isFavourite"] is False
    with _as("alice"):
        assert (await test_client.delete(f"{URL}/t_org/favourite")).status_code == 204
    assert (await _get(test_client, "alice", "t_org")).json()["isFavourite"] is False
    with _as("dave"):  # not his to see
        assert (await test_client.post(f"{URL}/t_alice/favourite")).status_code == 404


async def test_recently_used_is_the_callers_latest_view_from_it(test_client, db_session, library):
    assert (await _get(test_client, "dave", "t_ws")).json()["lastUsedAt"] is None
    with _as("dave"):
        view = (await test_client.post("/api/v1/views/", json={
            "name": "From it", "workspaceId": WS, "viewType": "graph",
            "visibility": "workspace", "contextModelId": "t_ws",
        })).json()
    assert (await _get(test_client, "dave", "t_ws")).json()["lastUsedAt"] == view["createdAt"]
    assert (await _get(test_client, "alice", "t_ws")).json()["lastUsedAt"] is None


# ── Offering a team's template to everyone ───────────────────────────

async def test_a_request_reaches_the_managers_who_may_then_read_it(test_client, db_session, library):
    await _managers(db_session)
    assert (await _get(test_client, "manager", "t_alice")).status_code == 404

    with _as("alice"):
        asked = await test_client.post(f"{URL}/t_alice/promotion-request", json={"note": "Every team copies it"})
        again = await test_client.post(f"{URL}/t_alice/promotion-request")
    assert asked.status_code == 200
    assert asked.json()["promotionRequest"]["note"] == "Every team copies it"
    assert asked.json()["access"]["canRequestPromotion"] is False
    assert again.status_code == 409
    assert await _notes(db_session, "layout_template.promotion_requested") == [
        ("usr_manager", 'Offer "t_alice" to everyone?'),
    ]

    seen = await _get(test_client, "manager", "t_alice")
    assert seen.status_code == 200 and seen.json()["access"]["canDecidePromotion"] is True
    assert seen.json()["access"]["via"] == "request"
    with _as("manager"):
        pending = (await test_client.get(f"{URL}/promotion-requests")).json()["items"]
    assert {t["id"] for t in pending} == {"t_alice", "t_requested"}  # the fixture's own request too
    with _as("dave"):
        assert (await test_client.get(f"{URL}/promotion-requests")).status_code == 403


async def test_approving_moves_it_to_everyone_and_tells_the_requester(test_client, db_session, library):
    await _managers(db_session)
    with _as("alice"):
        await test_client.post(f"{URL}/t_ws/promotion-request")
    with _as("alice"):  # asking is not answering
        assert (await test_client.post(f"{URL}/t_ws/promotion-request/approve")).status_code == 403
    with _as("manager"):
        approved = await test_client.post(f"{URL}/t_ws/promotion-request/approve", json={"note": "Welcome"})
    assert approved.status_code == 200
    body = approved.json()
    assert (body["visibility"], body["workspaceId"], body["promotionRequest"]) == ("enterprise", None, None)
    assert (await _get(test_client, "outsider", "t_ws")).status_code == 200  # everyone's now
    assert (await _get(test_client, "alice", "t_ws")).json()["access"]["canEdit"] is False  # the managers'
    assert await _notes(db_session, "layout_template.promotion_approved") == [
        ("usr_alice", '"t_ws" is now offered to everyone'),
    ]


async def test_declining_or_withdrawing_leaves_it_where_it_was(test_client, db_session, library):
    await _managers(db_session)
    with _as("alice"):
        await test_client.post(f"{URL}/t_alice/promotion-request")
    with _as("manager"):
        declined = await test_client.post(f"{URL}/t_alice/promotion-request/decline", json={"note": "Too specific"})
        twice = await test_client.post(f"{URL}/t_alice/promotion-request/decline")
    assert declined.json()["visibility"] == "private"
    assert twice.status_code == 404  # no longer theirs to read
    assert (await _get(test_client, "manager", "t_alice")).status_code == 404
    rows = (await db_session.execute(
        select(NotificationORM).where(NotificationORM.kind == "layout_template.promotion_declined")
    )).scalars().all()
    assert [(n.user_id, n.body) for n in rows] == [("usr_alice", "Too specific")]

    with _as("alice"):
        await test_client.post(f"{URL}/t_shared/promotion-request")
        assert (await test_client.delete(f"{URL}/t_shared/promotion-request")).status_code == 204
    assert (await db_session.get(ContextModelORM, "t_shared")).promotion_requested_at is None


async def test_who_may_ask(test_client, db_session, library):
    with _as("dave"):  # a member reads the workspace template, but may not change its audience
        assert (await test_client.post(f"{URL}/t_ws/promotion-request")).status_code == 403
    with _as("manager"):  # a manager moves an organization template, nothing to ask
        assert (await test_client.post(f"{URL}/t_org/promotion-request")).status_code == 403


# ── A workspace's default ────────────────────────────────────────────

async def test_a_workspace_default_is_one_every_member_can_use(test_client, db_session, library):
    url = f"/api/v1/admin/workspaces/{WS}"
    with _as("sysadmin"):
        for refused in ("t_alice", "t_ws_other", "t_builtin_hidden", "t_deleted", "missing"):
            resp = await test_client.put(url, json={"defaultLayoutTemplateId": refused})
            assert resp.status_code == 422, refused
        ok = await test_client.put(url, json={"defaultLayoutTemplateId": "t_ws"})
    assert ok.status_code == 200 and ok.json()["defaultLayoutTemplateId"] == "t_ws"

    member = (await _get(test_client, "dave", "t_ws")).json()
    assert member["defaultFor"] == [{"workspaceId": WS, "workspaceName": "Finance"}]
    assert (await _get(test_client, "outsider", "t_org")).json()["defaultFor"] == []

    with _as("sysadmin"):
        cleared = await test_client.put(url, json={"defaultLayoutTemplateId": ""})
        other = await test_client.put(f"/api/v1/admin/workspaces/{WS_OTHER}", json={"defaultLayoutTemplateId": "t_org"})
    assert cleared.json()["defaultLayoutTemplateId"] is None
    assert other.json()["defaultLayoutTemplateId"] == "t_org"
    with _as("dave"):  # setting it is the workspace admin's
        assert (await test_client.put(url, json={"defaultLayoutTemplateId": "t_org"})).status_code == 403
