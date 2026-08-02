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


# ── audience: the number that makes a tier mean something ────────────

@pytest.mark.asyncio
async def test_view_reports_its_audience(test_client: AsyncClient, db_session):
    """'Everyone in Finance' means nothing until you know Finance is
    three people — and the sharer's browser can't count it, because the
    workspace list it holds is scoped to their own memberships."""
    from backend.app.db.models import GroupMemberORM, RoleBindingORM, UserORM
    from backend.app.db.repositories import group_repo

    vid = await _seed(db_session)
    for uid in ("usr_pf_m1", "usr_pf_m2", "usr_pf_m3"):
        db_session.add(UserORM(
            id=uid, email=f"{uid}@example.com", password_hash="x",
            first_name="M", last_name="X", status="active",
        ))
    # Two bound directly, one via a group — and one person bound twice,
    # who must still count once.
    db_session.add(RoleBindingORM(
        subject_type="user", subject_id="usr_pf_m1",
        role_name="workspace_member", scope_type="workspace", scope_id=WS,
    ))
    db_session.add(RoleBindingORM(
        subject_type="user", subject_id="usr_pf_m2",
        role_name="workspace_viewer", scope_type="workspace", scope_id=WS,
    ))
    group = await group_repo.create_group(db_session, name="Team PF")
    db_session.add(GroupMemberORM(group_id=group.id, user_id="usr_pf_m3"))
    db_session.add(GroupMemberORM(group_id=group.id, user_id="usr_pf_m1"))
    db_session.add(RoleBindingORM(
        subject_type="group", subject_id=group.id,
        role_name="workspace_member", scope_type="workspace", scope_id=WS,
    ))
    await db_session.commit()

    with _auth(user=ADMIN, claims=ADMIN_CLAIMS):
        r = await test_client.get(f"/api/v1/views/{vid}")
    audience = r.json()["audience"]
    assert audience["workspaceMemberCount"] == 3
    assert audience["explicitGrantCount"] == 0


# ── open by default, restricted where it matters ─────────────────────

@pytest.mark.asyncio
async def test_a_new_workspace_lets_members_publish(
    test_client: AsyncClient, db_session,
):
    """The posture, not a setting: a workspace nobody has configured
    lets its members share their work with the platform.

    Publishing shipped admin-only, which made the tier unreachable for
    almost everyone — a member could build a lineage view and have
    nobody to hand it to. What these views expose is metadata, so the
    default inverts and the control moves after the fact.
    """
    ws = WorkspaceORM(id="ws_pf_fresh", name="Untouched")
    db_session.add(ws)
    db_session.add(ViewORM(
        id="view_pf_fresh", name="Fresh", workspace_id="ws_pf_fresh",
        visibility="workspace", created_by=CREATOR.id,
    ))
    await db_session.commit()
    await db_session.refresh(ws)
    assert ws.publish_policy == "open", "the default IS the decision"

    claims = PermissionClaims(sid="s_pf_fresh", ws_perms={"ws_pf_fresh": (
        "workspace:view:create", "workspace:view:edit",
        "workspace:view:delete", "workspace:view:read",
    )})
    with _auth(user=CREATOR, claims=claims):
        r = await test_client.put(
            "/api/v1/views/view_pf_fresh/visibility",
            json={"visibility": "enterprise"},
        )
    assert r.status_code == 200, r.text
    assert r.json()["visibility"] == "enterprise"


@pytest.mark.asyncio
async def test_a_restricted_source_still_needs_a_publisher(
    test_client: AsyncClient, db_session,
):
    """Restriction belongs to the source, not the workspace.

    Publishing exposes read-only access to the whole source behind the
    view — so the HR warehouse can carry a gate without dragging every
    workspace that happens to contain it back to admin-only.
    """
    from backend.app.db.models import ProviderORM, WorkspaceDataSourceORM

    db_session.add(WorkspaceORM(id="ws_pf_restr", name="Open WS", publish_policy="open"))
    db_session.add(ProviderORM(id="prov_pf", name="P", provider_type="falkordb"))
    db_session.add(WorkspaceDataSourceORM(
        id="ds_pf_restr", workspace_id="ws_pf_restr", provider_id="prov_pf",
        graph_name="g", label="People", is_primary=True, is_restricted=True,
    ))
    db_session.add(ViewORM(
        id="view_pf_restr", name="Restricted", workspace_id="ws_pf_restr",
        data_source_id="ds_pf_restr", visibility="workspace", created_by=CREATOR.id,
    ))
    await db_session.commit()

    claims = PermissionClaims(sid="s_pf_restr", ws_perms={"ws_pf_restr": (
        "workspace:view:create", "workspace:view:edit",
        "workspace:view:delete", "workspace:view:read",
    )})
    with _auth(user=CREATOR, claims=claims):
        r = await test_client.put(
            "/api/v1/views/view_pf_restr/visibility",
            json={"visibility": "enterprise"},
        )
        env = await test_client.get("/api/v1/views/view_pf_restr")
    assert r.status_code == 403, r.text
    # And the envelope offers the way through, so the UI isn't a wall.
    access = env.json()["access"]
    assert access["canPublish"] is False
    assert access["canRequestPublish"] is True


@pytest.mark.asyncio
async def test_creating_over_a_restricted_source_cannot_publish(
    test_client: AsyncClient, db_session,
):
    """The create path enforces the same rule the visibility path does —
    otherwise the gate is one POST away from irrelevant."""
    from backend.app.db.models import ProviderORM, WorkspaceDataSourceORM

    db_session.add(WorkspaceORM(id="ws_pf_cr", name="Open WS", publish_policy="open"))
    db_session.add(ProviderORM(id="prov_pf_cr", name="P", provider_type="falkordb"))
    db_session.add(WorkspaceDataSourceORM(
        id="ds_pf_cr", workspace_id="ws_pf_cr", provider_id="prov_pf_cr",
        graph_name="g", label="People", is_primary=True, is_restricted=True,
    ))
    await db_session.commit()

    claims = PermissionClaims(sid="s_pf_cr", ws_perms={"ws_pf_cr": (
        "workspace:view:create", "workspace:view:read",
    )})
    with _auth(user=CREATOR, claims=claims):
        r = await test_client.post("/api/v1/views/", json={
            "name": "Over restricted", "workspaceId": "ws_pf_cr",
            "dataSourceId": "ds_pf_cr", "viewType": "custom",
            "visibility": "enterprise",
        })
    assert r.status_code == 403, r.text


@pytest.mark.asyncio
async def test_publishing_tells_whoever_governs_the_workspace(
    test_client: AsyncClient, db_session,
):
    """Open publishing without a backstop is unsupervised publishing.

    The admin didn't approve this one, so the only way they learn it
    happened is being told — and the notification has to say where the
    undo lives.
    """
    from backend.app.db.models import RoleBindingORM, UserORM
    from backend.app.db.repositories import notification_repo

    vid = await _seed(db_session, policy="open", view_id="view_pf_notify")
    db_session.add(UserORM(
        id=ADMIN.id, email="pf_admin@example.com", password_hash="x",
        first_name="A", last_name="D", status="active",
    ))
    db_session.add(RoleBindingORM(
        subject_type="user", subject_id=ADMIN.id,
        role_name="workspace_admin", scope_type="workspace", scope_id=WS,
    ))
    await db_session.commit()

    with _auth(user=CREATOR, claims=MEMBER_CLAIMS):
        r = await test_client.put(
            f"/api/v1/views/{vid}/visibility", json={"visibility": "enterprise"},
        )
    assert r.status_code == 200, r.text

    inbox = await notification_repo.list_for_user(db_session, ADMIN.id)
    published = [n for n in inbox if n.kind == "view.published"]
    assert published, "the workspace admin has to hear about it"
    assert "unpublish" in (published[0].body or "").lower()
    assert published[0].link == f"/views/{vid}"
