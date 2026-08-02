"""Notifications close the loop on every sharing flow.

Before this, each of these moments was recorded faithfully somewhere
nobody looks: a view shared with you, a publication request waiting on
an admin, the answer to the request you filed. Sharing is only as good
as the moment the other person finds out.
"""
from __future__ import annotations

import pytest
from httpx import AsyncClient

from backend.app.db.models import (
    GroupMemberORM,
    RoleBindingORM,
    RolePermissionORM,
    UserORM,
    ViewORM,
    WorkspaceORM,
)
from backend.app.db.repositories import group_repo
from backend.app.services.permission_service import PermissionClaims
from backend.tests.test_views_scoping_regressions import _auth, _user


WS = "ws_notify"

CREATOR = _user("usr_nt_creator")
ADMIN = _user("usr_nt_admin")
GRANTEE = _user("usr_nt_grantee")

MEMBER_CLAIMS = PermissionClaims(sid="s_nt_member", ws_perms={WS: (
    "workspace:view:create", "workspace:view:edit",
    "workspace:view:delete", "workspace:view:read",
)})
ADMIN_CLAIMS = PermissionClaims(sid="s_nt_admin", ws_perms={WS: (
    "workspace:admin", "workspace:view:*",
)})
EMPTY_CLAIMS = PermissionClaims(sid="s_nt_empty")


async def _seed(db_session, *, view_id="view_nt"):
    if (await db_session.get(WorkspaceORM, WS)) is None:
        db_session.add(WorkspaceORM(id=WS, name="Notify WS"))
    for u in (CREATOR, ADMIN, GRANTEE):
        if (await db_session.get(UserORM, u.id)) is None:
            db_session.add(UserORM(
                id=u.id, email=u.email, password_hash="x",
                first_name="N", last_name="T", status="active",
            ))
    # The admin is bound to the workspace, which is how the queue finds them.
    db_session.add(RoleBindingORM(
        subject_type="user", subject_id=ADMIN.id,
        role_name="workspace_admin", scope_type="workspace", scope_id=WS,
    ))
    db_session.add(ViewORM(
        id=view_id, name="Quarterly lineage", workspace_id=WS,
        visibility="workspace", created_by=CREATOR.id,
    ))
    await db_session.commit()
    return view_id


async def _bell(client) -> dict:
    r = await client.get("/api/v1/me/notifications")
    assert r.status_code == 200, r.text
    return r.json()


# ── the ask reaches whoever can answer it ────────────────────────────

@pytest.mark.asyncio
async def test_publish_request_notifies_the_admin(
    test_client: AsyncClient, db_session,
):
    vid = await _seed(db_session)
    with _auth(user=CREATOR, claims=MEMBER_CLAIMS):
        await test_client.post(
            f"/api/v1/views/{vid}/publish-request",
            json={"note": "Needed for the board pack"},
        )
    with _auth(user=ADMIN, claims=ADMIN_CLAIMS):
        bell = await _bell(test_client)
    assert bell["unread"] == 1
    entry = bell["items"][0]
    assert entry["kind"] == "view.publish_requested"
    assert "Quarterly lineage" in entry["title"]
    assert entry["body"] == "Needed for the board pack"
    assert entry["link"] == f"/views/{vid}"
    assert entry["actorId"] == CREATOR.id


@pytest.mark.asyncio
async def test_requester_is_not_notified_of_their_own_request(
    test_client: AsyncClient, db_session,
):
    """Being told what you just did is noise."""
    vid = await _seed(db_session)
    with _auth(user=CREATOR, claims=MEMBER_CLAIMS):
        await test_client.post(f"/api/v1/views/{vid}/publish-request", json={})
        bell = await _bell(test_client)
    assert bell["unread"] == 0


# ── the answer reaches whoever asked ─────────────────────────────────

@pytest.mark.asyncio
async def test_approval_notifies_the_requester(
    test_client: AsyncClient, db_session,
):
    vid = await _seed(db_session)
    with _auth(user=CREATOR, claims=MEMBER_CLAIMS):
        await test_client.post(f"/api/v1/views/{vid}/publish-request", json={})
    with _auth(user=ADMIN, claims=ADMIN_CLAIMS):
        await test_client.post(f"/api/v1/views/{vid}/publish-request/approve")
    with _auth(user=CREATOR, claims=MEMBER_CLAIMS):
        bell = await _bell(test_client)
    kinds = [i["kind"] for i in bell["items"]]
    assert "view.publish_approved" in kinds


@pytest.mark.asyncio
async def test_decline_notifies_the_requester_with_the_reason(
    test_client: AsyncClient, db_session,
):
    vid = await _seed(db_session)
    with _auth(user=CREATOR, claims=MEMBER_CLAIMS):
        await test_client.post(f"/api/v1/views/{vid}/publish-request", json={})
    with _auth(user=ADMIN, claims=ADMIN_CLAIMS):
        await test_client.post(
            f"/api/v1/views/{vid}/publish-request/deny",
            json={"reason": "Contains customer identifiers"},
        )
    with _auth(user=CREATOR, claims=MEMBER_CLAIMS):
        bell = await _bell(test_client)
    denied = [i for i in bell["items"] if i["kind"] == "view.publish_denied"]
    assert denied and denied[0]["body"] == "Contains customer identifiers"


# ── being shared with is the moment that matters most ────────────────

@pytest.mark.asyncio
async def test_sharing_notifies_the_person(test_client: AsyncClient, db_session):
    vid = await _seed(db_session)
    with _auth(user=CREATOR, claims=MEMBER_CLAIMS):
        r = await test_client.post(
            f"/api/v1/views/{vid}/grants",
            json={"subjectType": "user", "subjectId": GRANTEE.id, "role": "viewer"},
        )
        assert r.status_code == 201, r.text
    with _auth(user=GRANTEE, claims=EMPTY_CLAIMS):
        bell = await _bell(test_client)
    assert bell["unread"] == 1
    assert bell["items"][0]["kind"] == "view.shared"
    assert bell["items"][0]["link"] == f"/views/{vid}"


@pytest.mark.asyncio
async def test_sharing_with_a_group_notifies_its_members(
    test_client: AsyncClient, db_session,
):
    vid = await _seed(db_session)
    group = await group_repo.create_group(db_session, name="Analysts")
    db_session.add(GroupMemberORM(group_id=group.id, user_id=GRANTEE.id))
    await db_session.commit()
    with _auth(user=CREATOR, claims=MEMBER_CLAIMS):
        await test_client.post(
            f"/api/v1/views/{vid}/grants",
            json={"subjectType": "group", "subjectId": group.id, "role": "viewer"},
        )
    with _auth(user=GRANTEE, claims=EMPTY_CLAIMS):
        bell = await _bell(test_client)
    assert [i["kind"] for i in bell["items"]] == ["view.shared"]


# ── the bell itself ──────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_notifications_are_per_user(test_client: AsyncClient, db_session):
    vid = await _seed(db_session)
    with _auth(user=CREATOR, claims=MEMBER_CLAIMS):
        await test_client.post(
            f"/api/v1/views/{vid}/grants",
            json={"subjectType": "user", "subjectId": GRANTEE.id, "role": "viewer"},
        )
    # The admin had nothing shared with them.
    with _auth(user=ADMIN, claims=ADMIN_CLAIMS):
        bell = await _bell(test_client)
    assert [i for i in bell["items"] if i["kind"] == "view.shared"] == []


@pytest.mark.asyncio
async def test_mark_read_clears_the_badge(test_client: AsyncClient, db_session):
    vid = await _seed(db_session)
    with _auth(user=CREATOR, claims=MEMBER_CLAIMS):
        await test_client.post(
            f"/api/v1/views/{vid}/grants",
            json={"subjectType": "user", "subjectId": GRANTEE.id, "role": "viewer"},
        )
    with _auth(user=GRANTEE, claims=EMPTY_CLAIMS):
        before = await _bell(test_client)
        assert before["unread"] == 1
        after = await test_client.post("/api/v1/me/notifications/read", json={})
    assert after.status_code == 200
    assert after.json()["unread"] == 0


@pytest.mark.asyncio
async def test_cannot_mark_someone_elses_notification_read(
    test_client: AsyncClient, db_session,
):
    vid = await _seed(db_session)
    with _auth(user=CREATOR, claims=MEMBER_CLAIMS):
        await test_client.post(
            f"/api/v1/views/{vid}/grants",
            json={"subjectType": "user", "subjectId": GRANTEE.id, "role": "viewer"},
        )
    with _auth(user=GRANTEE, claims=EMPTY_CLAIMS):
        theirs = (await _bell(test_client))["items"][0]["id"]
    with _auth(user=ADMIN, claims=ADMIN_CLAIMS):
        await test_client.post(
            "/api/v1/me/notifications/read", json={"ids": [theirs]},
        )
    with _auth(user=GRANTEE, claims=EMPTY_CLAIMS):
        still = await _bell(test_client)
    assert still["unread"] == 1


@pytest.mark.asyncio
async def test_bell_requires_authentication(test_client: AsyncClient, db_session):
    await _seed(db_session)
    with _auth(user=None, claims=None):
        r = await test_client.get("/api/v1/me/notifications")
    assert r.status_code == 401
