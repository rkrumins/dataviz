"""The publication journey: a member asks, a publisher answers.

``workspace:view:publish`` is the right gate for exposing a view — and
read-only access to its data source — to the entire platform. But a
gate with nothing behind it is a dead end, and the goal is that any
workspace member can share their work with the wider world. So the
member who cannot publish can ask; whoever holds the permission
answers; and a workspace that doesn't want the ceremony sets
``publish_policy='open'`` and lets members publish directly.
"""
from __future__ import annotations

import pytest
from httpx import AsyncClient

from backend.app.db.models import ViewORM, WorkspaceORM
from backend.app.services.permission_service import PermissionClaims
from backend.tests.test_views_scoping_regressions import _auth, _user


WS = "ws_pubflow"

CREATOR = _user("usr_pf_creator")
ADMIN = _user("usr_pf_admin")
STRANGER = _user("usr_pf_stranger")

# Post-resolver shapes: the member holds the four view leaves (no
# publish); the admin bundle collapses to workspace:view:* (publish in).
MEMBER_CLAIMS = PermissionClaims(sid="s_pf_member", ws_perms={WS: (
    "workspace:view:create", "workspace:view:edit",
    "workspace:view:delete", "workspace:view:read",
)})
ADMIN_CLAIMS = PermissionClaims(sid="s_pf_admin", ws_perms={WS: (
    "workspace:admin", "workspace:view:*",
)})
EMPTY_CLAIMS = PermissionClaims(sid="s_pf_empty")


async def _seed(db_session, *, policy="request", visibility="workspace",
                view_id="view_pf"):
    ws = await db_session.get(WorkspaceORM, WS)
    if ws is None:
        db_session.add(WorkspaceORM(id=WS, name="Publish Flow", publish_policy=policy))
    else:
        ws.publish_policy = policy
    db_session.add(ViewORM(
        id=view_id, name=view_id, workspace_id=WS,
        visibility=visibility, created_by=CREATOR.id,
    ))
    await db_session.commit()
    return view_id


# ── the ask ──────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_member_requests_publication(test_client: AsyncClient, db_session):
    vid = await _seed(db_session)
    with _auth(user=CREATOR, claims=MEMBER_CLAIMS):
        r = await test_client.post(
            f"/api/v1/views/{vid}/publish-request",
            json={"note": "Needed by the finance readout"},
        )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["publishRequest"]["requestedBy"] == CREATOR.id
    assert body["publishRequest"]["note"] == "Needed by the finance readout"
    # Asking must not publish anything by itself.
    assert body["visibility"] == "workspace"


@pytest.mark.asyncio
async def test_envelope_offers_the_ask_to_a_member(test_client: AsyncClient, db_session):
    vid = await _seed(db_session)
    with _auth(user=CREATOR, claims=MEMBER_CLAIMS):
        r = await test_client.get(f"/api/v1/views/{vid}")
    access = r.json()["access"]
    assert access["canPublish"] is False
    assert access["canRequestPublish"] is True, "the tile must be a route, not a wall"
    assert access["canAnswerPublishRequest"] is False


@pytest.mark.asyncio
async def test_stranger_cannot_request(test_client: AsyncClient, db_session):
    vid = await _seed(db_session)
    with _auth(user=STRANGER, claims=EMPTY_CLAIMS):
        r = await test_client.post(f"/api/v1/views/{vid}/publish-request", json={})
    assert r.status_code in (403, 404)


@pytest.mark.asyncio
async def test_cannot_request_for_an_already_published_view(
    test_client: AsyncClient, db_session,
):
    vid = await _seed(db_session, visibility="enterprise")
    with _auth(user=CREATOR, claims=MEMBER_CLAIMS):
        r = await test_client.post(f"/api/v1/views/{vid}/publish-request", json={})
    assert r.status_code == 409


# ── the answer ───────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_admin_approves_and_the_view_publishes(
    test_client: AsyncClient, db_session,
):
    vid = await _seed(db_session)
    with _auth(user=CREATOR, claims=MEMBER_CLAIMS):
        await test_client.post(f"/api/v1/views/{vid}/publish-request", json={})
    with _auth(user=ADMIN, claims=ADMIN_CLAIMS):
        r = await test_client.post(f"/api/v1/views/{vid}/publish-request/approve")
        acts = await test_client.get(f"/api/v1/views/{vid}/activity")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["visibility"] == "enterprise"
    assert body.get("publishRequest") is None, "the request is answered and gone"
    actions = [a["action"] for a in acts.json()]
    assert "publish_requested" in actions
    assert "visibility_changed" in actions


@pytest.mark.asyncio
async def test_member_cannot_approve_their_own_request(
    test_client: AsyncClient, db_session,
):
    vid = await _seed(db_session)
    with _auth(user=CREATOR, claims=MEMBER_CLAIMS):
        await test_client.post(f"/api/v1/views/{vid}/publish-request", json={})
        r = await test_client.post(f"/api/v1/views/{vid}/publish-request/approve")
    assert r.status_code == 403
    row = await db_session.get(ViewORM, vid)
    await db_session.refresh(row)
    assert row.visibility == "workspace"


@pytest.mark.asyncio
async def test_deny_records_the_reason_and_keeps_visibility(
    test_client: AsyncClient, db_session,
):
    vid = await _seed(db_session)
    with _auth(user=CREATOR, claims=MEMBER_CLAIMS):
        await test_client.post(f"/api/v1/views/{vid}/publish-request", json={})
    with _auth(user=ADMIN, claims=ADMIN_CLAIMS):
        r = await test_client.post(
            f"/api/v1/views/{vid}/publish-request/deny",
            json={"reason": "Contains customer identifiers"},
        )
        acts = await test_client.get(f"/api/v1/views/{vid}/activity")
    assert r.status_code == 200, r.text
    assert r.json()["visibility"] == "workspace"
    assert r.json().get("publishRequest") is None
    denied = [a for a in acts.json() if a["action"] == "publish_denied"]
    assert denied and "customer identifiers" in denied[0]["summary"]


@pytest.mark.asyncio
async def test_answering_without_a_request_conflicts(
    test_client: AsyncClient, db_session,
):
    vid = await _seed(db_session)
    with _auth(user=ADMIN, claims=ADMIN_CLAIMS):
        r = await test_client.post(f"/api/v1/views/{vid}/publish-request/approve")
    assert r.status_code == 409


@pytest.mark.asyncio
async def test_requester_can_withdraw(test_client: AsyncClient, db_session):
    vid = await _seed(db_session)
    with _auth(user=CREATOR, claims=MEMBER_CLAIMS):
        await test_client.post(f"/api/v1/views/{vid}/publish-request", json={})
        r = await test_client.delete(f"/api/v1/views/{vid}/publish-request")
        after = await test_client.get(f"/api/v1/views/{vid}")
    assert r.status_code == 204
    assert after.json().get("publishRequest") is None


# ── the open-policy shortcut ─────────────────────────────────────────

@pytest.mark.asyncio
async def test_open_policy_lets_a_member_publish_directly(
    test_client: AsyncClient, db_session,
):
    vid = await _seed(db_session, policy="open")
    with _auth(user=CREATOR, claims=MEMBER_CLAIMS):
        r = await test_client.put(
            f"/api/v1/views/{vid}/visibility", json={"visibility": "enterprise"},
        )
        env = await test_client.get(f"/api/v1/views/{vid}")
    assert r.status_code == 200, r.text
    assert r.json()["visibility"] == "enterprise"
    # With no gate to route around, the envelope stops offering the ask.
    access = env.json()["access"]
    assert access["canPublish"] is True
    assert access["canRequestPublish"] is False


@pytest.mark.asyncio
async def test_open_policy_does_not_widen_who_may_touch_visibility(
    test_client: AsyncClient, db_session,
):
    """'open' says publishing isn't admin-only here — not that anyone
    may re-share someone else's view."""
    vid = await _seed(db_session, policy="open")
    with _auth(user=STRANGER, claims=EMPTY_CLAIMS):
        r = await test_client.put(
            f"/api/v1/views/{vid}/visibility", json={"visibility": "enterprise"},
        )
    assert r.status_code in (403, 404)


@pytest.mark.asyncio
async def test_request_policy_still_refuses_direct_publish(
    test_client: AsyncClient, db_session,
):
    vid = await _seed(db_session, policy="request")
    with _auth(user=CREATOR, claims=MEMBER_CLAIMS):
        r = await test_client.put(
            f"/api/v1/views/{vid}/visibility", json={"visibility": "enterprise"},
        )
    assert r.status_code == 403
