"""RBAC Phase 7 — enterprise hardening regression suite.

Covers:
  * session-kill fan-out on binding / role mutations
  * time-bound bindings (``expires_at`` + duration shortcuts)
  * the audit-log endpoint and its filters
  * workspace deletion cascading to scoped custom roles
"""
from __future__ import annotations

import json

import pytest
from httpx import AsyncClient

from backend.app.db.models import (
    GroupMemberORM,
    OutboxEventORM,
    RoleBindingORM,
    UserORM,
    WorkspaceORM,
)
from backend.app.db.repositories import (
    binding_repo, group_repo, role_repo, user_repo,
)
from backend.app.services.permission_service import resolve
from backend.app.services.revocation_service import (
    InMemoryBackend, RevocationService,
    configure_revocation_service, get_revocation_service,
    revoke_role_sessions, revoke_subject_sessions,
)


# ── helpers ──────────────────────────────────────────────────────────


async def _seed_user(db_session, *, user_id="usr_p7", email=None) -> str:
    email = email or f"{user_id}@example.com"
    db_session.add(UserORM(
        id=user_id, email=email, password_hash="x",
        first_name="P", last_name="7", status="active",
    ))
    await db_session.flush()
    return user_id


@pytest.fixture(autouse=True)
def _fresh_revocation_service():
    """Each test gets a clean in-memory backend so revoked-sid checks
    don't leak between cases."""
    configure_revocation_service(RevocationService(InMemoryBackend()))


# ── Session-kill fan-out ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_revoke_subject_sessions_user(db_session):
    """Direct user revoke marks the user's sids as revoked."""
    svc = get_revocation_service()
    await svc.record_session("usr_alice", "sess_a1")
    await svc.record_session("usr_alice", "sess_a2")

    n = await revoke_subject_sessions("user", "usr_alice")
    assert n == 1
    assert await svc.is_revoked("sess_a1")
    assert await svc.is_revoked("sess_a2")


@pytest.mark.asyncio
async def test_revoke_subject_sessions_group_fans_out(db_session):
    """Group revoke kills every member's sessions."""
    svc = get_revocation_service()
    alice = await _seed_user(db_session, user_id="usr_alice_g")
    bob = await _seed_user(db_session, user_id="usr_bob_g")
    g = await group_repo.create_group(db_session, name="ops")
    db_session.add(GroupMemberORM(group_id=g.id, user_id=alice))
    db_session.add(GroupMemberORM(group_id=g.id, user_id=bob))
    await db_session.flush()

    await svc.record_session(alice, "sess_alice")
    await svc.record_session(bob, "sess_bob")

    n = await revoke_subject_sessions("group", g.id, session=db_session)
    assert n == 2
    assert await svc.is_revoked("sess_alice")
    assert await svc.is_revoked("sess_bob")


@pytest.mark.asyncio
async def test_revoke_role_sessions_unions_direct_and_group(db_session):
    """A role update fans out to every direct AND group-mediated
    subject of that role, deduped by user."""
    svc = get_revocation_service()
    alice = await _seed_user(db_session, user_id="usr_role_a")
    bob = await _seed_user(db_session, user_id="usr_role_b")
    carol = await _seed_user(db_session, user_id="usr_role_c")

    # Custom role for the test so the audit doesn't fire on something
    # the test fixtures already use.
    db_session.add(_make_test_custom_role("acme_auditor"))
    await db_session.flush()

    # Alice direct, group for bob+carol.
    g = await group_repo.create_group(db_session, name="auditors")
    db_session.add(GroupMemberORM(group_id=g.id, user_id=bob))
    db_session.add(GroupMemberORM(group_id=g.id, user_id=carol))
    await db_session.flush()

    await binding_repo.create_binding(
        db_session, subject_type="user", subject_id=alice,
        role_name="acme_auditor", scope_type="workspace", scope_id="ws_X",
    )
    await binding_repo.create_binding(
        db_session, subject_type="group", subject_id=g.id,
        role_name="acme_auditor", scope_type="workspace", scope_id="ws_X",
    )

    for sid_user, sid in (
        (alice, "sess_alice_r"), (bob, "sess_bob_r"), (carol, "sess_carol_r"),
    ):
        await svc.record_session(sid_user, sid)

    n = await revoke_role_sessions("acme_auditor", session=db_session)
    # 3 distinct users (alice direct + bob+carol via group).
    assert n == 3
    for sid in ("sess_alice_r", "sess_bob_r", "sess_carol_r"):
        assert await svc.is_revoked(sid)


def _make_test_custom_role(name: str):
    """Build a workspace-template custom role row inline for tests
    that only need the row to exist (not for binding validation)."""
    from backend.app.db.models import RoleORM
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()
    return RoleORM(
        name=name, description=f"test role {name}",
        scope_type="global", scope_id=None,
        is_system=False, created_at=now, updated_at=now, created_by=None,
    )


# ── End-to-end via the FastAPI test client ──────────────────────────


@pytest.mark.asyncio
async def test_role_change_kills_existing_sessions(
    test_client: AsyncClient, db_session,
):
    """PUT /admin/users/{id}/role kills the target user's sessions
    so the new claim takes effect before the JWT expires."""
    svc = get_revocation_service()
    user = await user_repo.create_user(
        db_session,
        email="promote@example.com", password_hash="x",
        first_name="P", last_name="R",
    )
    await svc.record_session(user.id, "sess_pre_promote")

    resp = await test_client.put(
        f"/api/v1/admin/users/{user.id}/role",
        json={"role": "super_admin"},
    )
    assert resp.status_code == 200, resp.text
    assert await svc.is_revoked("sess_pre_promote")


@pytest.mark.asyncio
async def test_workspace_member_revoke_kills_sessions(
    test_client: AsyncClient, db_session,
):
    """Revoking a user's workspace binding via the admin endpoint
    kills their live sessions immediately."""
    svc = get_revocation_service()
    user = await user_repo.create_user(
        db_session,
        email="ws_revoke@example.com", password_hash="x",
        first_name="W", last_name="R",
    )
    db_session.add(WorkspaceORM(id="ws_revoke", name="Revoke"))
    await db_session.commit()
    await svc.record_session(user.id, "sess_pre_revoke")

    bind = await test_client.post(
        "/api/v1/admin/workspaces/ws_revoke/members",
        json={
            "subjectType": "user", "subjectId": user.id,
            "role": "workspace_member",
        },
    )
    assert bind.status_code == 201, bind.text
    binding_id = bind.json()["bindingId"]

    revoke = await test_client.delete(
        f"/api/v1/admin/workspaces/ws_revoke/members/{binding_id}",
    )
    assert revoke.status_code == 204, revoke.text
    assert await svc.is_revoked("sess_pre_revoke")


# ── Time-bound bindings ──────────────────────────────────────────────


def test_duration_shortcut_parses_24h():
    from backend.common.models.rbac import _parse_duration_to_expires_at
    from datetime import datetime, timezone
    ts = _parse_duration_to_expires_at("24h")
    delta = datetime.fromisoformat(ts) - datetime.now(timezone.utc)
    # within 5s of 24h
    assert 23 * 3600 + 50 < delta.total_seconds() < 24 * 3600 + 50


def test_duration_shortcut_rejects_garbage():
    from backend.common.models.rbac import _parse_duration_to_expires_at
    with pytest.raises(ValueError):
        _parse_duration_to_expires_at("yesterday")
    with pytest.raises(ValueError):
        _parse_duration_to_expires_at("0d")
    with pytest.raises(ValueError):
        _parse_duration_to_expires_at("400d")  # past the 365-day cap


@pytest.mark.asyncio
async def test_create_binding_with_expires_in(
    test_client: AsyncClient, db_session,
):
    """POST workspace member accepts ``expiresIn`` and surfaces the
    normalised ``expiresAt`` on the response."""
    user = await user_repo.create_user(
        db_session,
        email="exp_in@example.com", password_hash="x",
        first_name="E", last_name="I",
    )
    db_session.add(WorkspaceORM(id="ws_exp", name="Expires"))
    await db_session.commit()

    resp = await test_client.post(
        "/api/v1/admin/workspaces/ws_exp/members",
        json={
            "subjectType": "user", "subjectId": user.id,
            "role": "workspace_member", "expiresIn": "7d",
        },
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["expiresAt"] is not None
    # Verify the underlying binding really has expires_at set.
    from sqlalchemy import select
    row = (await db_session.execute(
        select(RoleBindingORM).where(RoleBindingORM.id == body["bindingId"])
    )).scalar_one()
    assert row.expires_at is not None


@pytest.mark.asyncio
async def test_create_binding_rejects_both_expires_fields(
    test_client: AsyncClient, db_session,
):
    user = await user_repo.create_user(
        db_session,
        email="both_exp@example.com", password_hash="x",
        first_name="B", last_name="X",
    )
    db_session.add(WorkspaceORM(id="ws_exp2", name="X"))
    await db_session.commit()

    resp = await test_client.post(
        "/api/v1/admin/workspaces/ws_exp2/members",
        json={
            "subjectType": "user", "subjectId": user.id,
            "role": "workspace_member",
            "expiresAt": "2099-01-01T00:00:00+00:00",
            "expiresIn": "7d",
        },
    )
    assert resp.status_code == 422, resp.text


@pytest.mark.asyncio
async def test_update_member_expiry_extends_then_clears(
    test_client: AsyncClient, db_session,
):
    """PUT /{binding}/expiry can extend (set), shorten (set), or
    clear (omit both). Clearing yields ``expiresAt: null``."""
    user = await user_repo.create_user(
        db_session,
        email="upd_exp@example.com", password_hash="x",
        first_name="U", last_name="E",
    )
    db_session.add(WorkspaceORM(id="ws_upd_exp", name="UpdExp"))
    await db_session.commit()

    bind = await test_client.post(
        "/api/v1/admin/workspaces/ws_upd_exp/members",
        json={
            "subjectType": "user", "subjectId": user.id,
            "role": "workspace_member", "expiresIn": "1h",
        },
    )
    assert bind.status_code == 201, bind.text
    binding_id = bind.json()["bindingId"]

    extend = await test_client.put(
        f"/api/v1/admin/workspaces/ws_upd_exp/members/{binding_id}/expiry",
        json={"expiresIn": "30d"},
    )
    assert extend.status_code == 200, extend.text
    extended_at = extend.json()["expiresAt"]
    assert extended_at is not None
    assert extended_at > bind.json()["expiresAt"]

    clear = await test_client.put(
        f"/api/v1/admin/workspaces/ws_upd_exp/members/{binding_id}/expiry",
        json={},
    )
    assert clear.status_code == 200, clear.text
    assert clear.json()["expiresAt"] is None


# ── Audit endpoint ───────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_audit_endpoint_lists_recent_events(
    test_client: AsyncClient, db_session,
):
    """End-to-end: create a few RBAC events, list via the endpoint."""
    user = await user_repo.create_user(
        db_session,
        email="audit_user@example.com", password_hash="x",
        first_name="A", last_name="U",
    )
    db_session.add(WorkspaceORM(id="ws_audit", name="Audit"))
    await db_session.commit()

    bind = await test_client.post(
        "/api/v1/admin/workspaces/ws_audit/members",
        json={
            "subjectType": "user", "subjectId": user.id,
            "role": "workspace_member",
        },
    )
    binding_id = bind.json()["bindingId"]
    await test_client.delete(
        f"/api/v1/admin/workspaces/ws_audit/members/{binding_id}",
    )

    resp = await test_client.get("/api/v1/admin/audit")
    assert resp.status_code == 200, resp.text
    events = resp.json()["events"]
    types = {e["eventType"] for e in events}
    assert "rbac.workspace.member_bound" in types
    assert "rbac.workspace.member_revoked" in types


@pytest.mark.asyncio
async def test_audit_endpoint_event_type_prefix_filter(
    test_client: AsyncClient, db_session,
):
    """``eventType=rbac.role.*`` returns only role events."""
    # Emit a mix.
    await user_repo.create_outbox_event(
        db_session, event_type="rbac.role.updated",
        payload={"name": "x", "actor_id": "usr_a"},
    )
    await user_repo.create_outbox_event(
        db_session, event_type="rbac.workspace.member_bound",
        payload={"workspace_id": "ws", "actor_id": "usr_a"},
    )
    await user_repo.create_outbox_event(
        db_session, event_type="user.created",
        payload={"user_id": "usr_z"},
    )
    await db_session.commit()

    resp = await test_client.get(
        "/api/v1/admin/audit", params={"eventType": "rbac.role.*"},
    )
    assert resp.status_code == 200
    types = {e["eventType"] for e in resp.json()["events"]}
    assert types == {"rbac.role.updated"}


@pytest.mark.asyncio
async def test_audit_endpoint_target_user_filter(
    test_client: AsyncClient, db_session,
):
    """``targetUserId=alice`` only returns events whose payload
    references alice."""
    await user_repo.create_outbox_event(
        db_session, event_type="user.role_changed",
        payload={"user_id": "usr_alice", "new_role": "super_admin"},
    )
    await user_repo.create_outbox_event(
        db_session, event_type="user.role_changed",
        payload={"user_id": "usr_bob", "new_role": "org_admin"},
    )
    await db_session.commit()

    resp = await test_client.get(
        "/api/v1/admin/audit", params={"targetUserId": "usr_alice"},
    )
    assert resp.status_code == 200
    events = resp.json()["events"]
    assert len(events) == 1
    assert events[0]["targetUserId"] == "usr_alice"


# ── Workspace deletion cascade ───────────────────────────────────────


@pytest.mark.asyncio
async def test_workspace_delete_cascades_custom_roles_and_bindings(
    test_client: AsyncClient, db_session,
):
    """DELETE /admin/workspaces/{id} drops:
      * every binding scoped to that workspace
      * every custom role scoped to that workspace
    and emits ``rbac.workspace.roles_cascaded`` with both lists."""
    from sqlalchemy import select
    from backend.app.db.models import RoleORM, WorkspaceORM
    # Seed: a workspace, a workspace-scoped custom role, a binding.
    db_session.add(WorkspaceORM(id="ws_purge", name="Purge"))
    # Ensure the workspace exists in the canonical workspace_repo
    # before role binding tries to scope to it. Same pattern as
    # other Phase 7 tests above.
    await db_session.commit()

    # Seed a workspace-scoped custom role directly to side-step the
    # admin endpoint's permission seeding requirements.
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()
    db_session.add(RoleORM(
        name="purge_role", description="cascade test role",
        scope_type="workspace", scope_id="ws_purge",
        is_system=False, created_at=now, updated_at=now, created_by=None,
    ))
    await db_session.commit()

    # Bind a workspace-template (workspace_member) so the cascade
    # delete_scope_bindings has something to wipe.
    user = await user_repo.create_user(
        db_session,
        email="purge_user@example.com", password_hash="x",
        first_name="P", last_name="U",
    )
    bind = await test_client.post(
        "/api/v1/admin/workspaces/ws_purge/members",
        json={
            "subjectType": "user", "subjectId": user.id,
            "role": "workspace_member",
        },
    )
    assert bind.status_code == 201, bind.text

    # Now nuke the workspace.
    nuke = await test_client.delete("/api/v1/admin/workspaces/ws_purge")
    assert nuke.status_code == 204, nuke.text

    # Both binding and custom role are gone.
    bindings = (await db_session.execute(
        select(RoleBindingORM).where(RoleBindingORM.scope_id == "ws_purge")
    )).scalars().all()
    assert bindings == []
    roles = (await db_session.execute(
        select(RoleORM).where(RoleORM.scope_id == "ws_purge")
    )).scalars().all()
    assert roles == []

    # Audit event was emitted listing the cascade.
    audit = await test_client.get(
        "/api/v1/admin/audit",
        params={"eventType": "rbac.workspace.roles_cascaded"},
    )
    events = audit.json()["events"]
    assert len(events) == 1
    payload = events[0]["payload"]
    assert payload["workspace_id"] == "ws_purge"
    assert "purge_role" in payload["roles_removed"]


# ── Phase 8 — audit severity / summary / category filter ───────────


@pytest.mark.asyncio
async def test_audit_response_includes_severity_and_summary(
    test_client: AsyncClient, db_session,
):
    """Every audit row carries a ``severity`` + human ``summary``
    derived from the event_type catalogue. A role-change event
    surfaces ``critical`` severity and the new role in the summary."""
    await user_repo.create_outbox_event(
        db_session, event_type="user.role_changed",
        payload={
            "user_id": "usr_alice", "new_role": "super_admin",
            "changed_by": "usr_admin",
        },
    )
    await db_session.commit()

    resp = await test_client.get(
        "/api/v1/admin/audit",
        params={"eventType": "user.role_changed"},
    )
    assert resp.status_code == 200
    ev = resp.json()["events"][0]
    assert ev["severity"] == "critical"
    assert "super_admin" in ev["summary"]


@pytest.mark.asyncio
async def test_audit_category_security_hides_login_noise(
    test_client: AsyncClient, db_session,
):
    """The default ``category=security`` filter drops noisy events
    so the audit page surfaces real RBAC signal by default."""
    # Mix of noisy + meaningful events.
    await user_repo.create_outbox_event(
        db_session, event_type="user.logged_in",
        payload={"user_id": "usr_alice"},
    )
    await user_repo.create_outbox_event(
        db_session, event_type="user.access_denied",
        payload={"user_id": "usr_alice", "permission": "x"},
    )
    await user_repo.create_outbox_event(
        db_session, event_type="user.role_changed",
        payload={"user_id": "usr_alice", "new_role": "org_admin"},
    )
    await db_session.commit()

    # Default — security only.
    resp_sec = await test_client.get("/api/v1/admin/audit")
    sec_types = {e["eventType"] for e in resp_sec.json()["events"]}
    assert "user.role_changed" in sec_types
    assert "user.logged_in" not in sec_types
    assert "user.access_denied" not in sec_types

    # Override — everything.
    resp_all = await test_client.get(
        "/api/v1/admin/audit", params={"category": "all"},
    )
    all_types = {e["eventType"] for e in resp_all.json()["events"]}
    assert {"user.logged_in", "user.access_denied", "user.role_changed"} <= all_types


@pytest.mark.asyncio
async def test_audit_summary_handles_unknown_event_type(
    test_client: AsyncClient, db_session,
):
    """An event type not in the catalogue still renders — severity
    defaults to ``info`` and summary falls back to the raw type."""
    await user_repo.create_outbox_event(
        db_session, event_type="rbac.workspace.totally_made_up",
        payload={"x": 1},
    )
    await db_session.commit()

    resp = await test_client.get(
        "/api/v1/admin/audit",
        params={"eventType": "rbac.workspace.totally_made_up"},
    )
    assert resp.status_code == 200
    ev = resp.json()["events"][0]
    assert ev["severity"] == "info"
    assert ev["summary"] == "rbac.workspace.totally_made_up"


@pytest.mark.asyncio
async def test_audit_endpoint_event_types_list(
    test_client: AsyncClient, db_session,
):
    """GET /event-types returns the distinct event types in the
    RBAC + user namespace."""
    await user_repo.create_outbox_event(
        db_session, event_type="rbac.role.updated", payload={"actor_id": "x"},
    )
    await user_repo.create_outbox_event(
        db_session, event_type="rbac.workspace.member_bound",
        payload={"actor_id": "x"},
    )
    await db_session.commit()

    resp = await test_client.get("/api/v1/admin/audit/event-types")
    assert resp.status_code == 200
    types = set(resp.json())
    assert {"rbac.role.updated", "rbac.workspace.member_bound"} <= types
