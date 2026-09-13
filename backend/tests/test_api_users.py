"""
API endpoint tests for /api/v1/users/* and /api/v1/admin/users/*.

Tests the user profile (GET /me) and admin user management endpoints
using the test_client fixture which overrides auth and DB session.

Note: The test_client overrides get_current_user, require_admin, and get_optional_user
to return a fake user (usr_test000000). For admin endpoints that operate on *other*
users, we create additional users via the repo directly through the DB session.
"""
import pytest
from httpx import AsyncClient


# ── GET /users/me ─────────────────────────────────────────────────────

async def test_get_me_returns_profile(test_client: AsyncClient):
    """GET /users/me returns the current user's profile."""
    resp = await test_client.get("/api/v1/users/me")
    assert resp.status_code == 200
    body = resp.json()
    assert body["id"] == "usr_test000000"
    assert body["email"] == "test@example.com"


# ── GET /admin/users ──────────────────────────────────────────────────

async def test_list_users_empty(test_client: AsyncClient):
    """Admin list users returns a list (may be empty or contain the fake user)."""
    resp = await test_client.get("/api/v1/admin/users")
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)


async def test_list_users_with_status_filter(test_client: AsyncClient):
    """Admin list users can filter by status query param."""
    resp = await test_client.get("/api/v1/admin/users?status=active")
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)


async def test_list_users_with_pagination(test_client: AsyncClient):
    """Admin list users supports limit and offset."""
    resp = await test_client.get("/api/v1/admin/users?limit=10&offset=0")
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)


async def test_list_users_reports_sign_in_methods(test_client, db_session):
    """Each row says how the account signs in: a usable password, the
    linked IdPs (slug + display name + kind), and where the account came
    from — so the admin table can tell local from SSO at a glance."""
    from backend.app.db.repositories import (
        idp_provider_repo, user_identity_repo, user_repo,
    )
    from backend.auth_service.core.password import disabled_password_hash

    provider = await idp_provider_repo.create_provider(
        db_session, slug="corp-entra", display_name="Corporate Entra",
        kind="oidc", settings={},
    )
    sso_user = await user_repo.create_sso_user(
        db_session, email="sso.only@example.com", first_name="S",
        last_name="O", password_hash=disabled_password_hash(),
    )
    await user_identity_repo.create_identity(
        db_session, user_id=sso_user.id, provider_id=provider.id,
        external_id="ext-sso", email_at_link=sso_user.email,
    )
    local_user = await user_repo.create_user(
        db_session, email="local@example.com",
        password_hash="argon2-placeholder", first_name="L", last_name="U",
        status="active",
    )
    await db_session.commit()

    resp = await test_client.get("/api/v1/admin/users?limit=200")
    assert resp.status_code == 200
    rows = {u["email"]: u for u in resp.json()}

    sso_row = rows["sso.only@example.com"]
    assert sso_row["hasPassword"] is False
    assert [i["slug"] for i in sso_row["identities"]] == ["corp-entra"]
    assert sso_row["identities"][0]["displayName"] == "Corporate Entra"
    assert sso_row["identities"][0]["kind"] == "oidc"
    assert sso_row["identities"][0]["providerId"] == provider.id

    local_row = rows["local@example.com"]
    assert local_row["hasPassword"] is True
    assert local_row["identities"] == []
    assert local_user.id == local_row["id"]


async def test_update_user_noop_response_carries_sign_in_fields(
    test_client, db_session,
):
    """Pins the per-user fallback in ``_admin_response``: a path that did
    NOT batch identities must still report them rather than describing an
    SSO account as local."""
    from backend.app.db.repositories import (
        idp_provider_repo, user_identity_repo, user_repo,
    )
    from backend.auth_service.core.password import disabled_password_hash

    provider = await idp_provider_repo.create_provider(
        db_session, slug="corp-okta", display_name="Corp Okta",
        kind="oidc", settings={},
    )
    user = await user_repo.create_sso_user(
        db_session, email="patched@example.com", first_name="P",
        last_name="U", password_hash=disabled_password_hash(),
    )
    await user_identity_repo.create_identity(
        db_session, user_id=user.id, provider_id=provider.id,
        external_id="ext-patch", email_at_link=user.email,
    )
    await db_session.commit()

    resp = await test_client.patch(
        f"/api/v1/admin/users/{user.id}", json={"firstName": "Patched"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["hasPassword"] is False
    assert [i["slug"] for i in body["identities"]] == ["corp-okta"]


# ── POST /admin/users/{user_id}/approve ───────────────────────────────

async def test_approve_user_not_found(test_client: AsyncClient):
    """Approving a non-existent user returns 404."""
    resp = await test_client.post("/api/v1/admin/users/usr_nonexistent/approve")
    assert resp.status_code == 404


async def test_approve_user(test_client: AsyncClient, db_session):
    """Approve a pending user sets status to active."""
    from backend.app.db.repositories import user_repo

    user = await user_repo.create_user(
        db_session,
        email="pending@example.com",
        password_hash="hash123",
        first_name="Pending",
        last_name="User",
    )

    resp = await test_client.post(f"/api/v1/admin/users/{user.id}/approve")
    assert resp.status_code == 200
    assert resp.json()["detail"] == "User approved"


async def test_approve_already_active_user(test_client: AsyncClient, db_session):
    """Approving a non-pending user returns 409."""
    from backend.app.db.repositories import user_repo

    user = await user_repo.create_user(
        db_session,
        email="active@example.com",
        password_hash="hash123",
        first_name="Active",
        last_name="User",
    )
    await user_repo.update_user_status(db_session, user.id, "active")

    resp = await test_client.post(f"/api/v1/admin/users/{user.id}/approve")
    assert resp.status_code == 409


# ── POST /admin/users/{user_id}/reject ────────────────────────────────

async def test_reject_user_not_found(test_client: AsyncClient):
    """Rejecting a non-existent user returns 404."""
    resp = await test_client.post("/api/v1/admin/users/usr_nonexistent/reject")
    assert resp.status_code == 404


async def test_reject_user(test_client: AsyncClient, db_session):
    """Reject a pending user."""
    from backend.app.db.repositories import user_repo

    user = await user_repo.create_user(
        db_session,
        email="reject@example.com",
        password_hash="hash123",
        first_name="Reject",
        last_name="User",
    )

    resp = await test_client.post(
        f"/api/v1/admin/users/{user.id}/reject",
        json={"rejectionReason": "Not approved"},
    )
    assert resp.status_code == 200
    assert resp.json()["detail"] == "User rejected"


async def test_reject_already_active_user(test_client: AsyncClient, db_session):
    """Rejecting a non-pending user returns 409."""
    from backend.app.db.repositories import user_repo

    user = await user_repo.create_user(
        db_session,
        email="reject_active@example.com",
        password_hash="hash123",
        first_name="Active",
        last_name="User",
    )
    await user_repo.update_user_status(db_session, user.id, "active")

    resp = await test_client.post(f"/api/v1/admin/users/{user.id}/reject")
    assert resp.status_code == 409


# ── PUT /admin/users/{user_id}/role ───────────────────────────────────

async def test_change_role_not_found(test_client: AsyncClient):
    """Changing role of non-existent user returns 404."""
    resp = await test_client.put(
        "/api/v1/admin/users/usr_nonexistent/role",
        json={"role": "super_admin"},
    )
    assert resp.status_code == 404


async def test_change_role(test_client: AsyncClient, db_session):
    """Change a user's role."""
    from backend.app.db.repositories import user_repo

    user = await user_repo.create_user(
        db_session,
        email="role_change@example.com",
        password_hash="hash123",
        first_name="Role",
        last_name="Change",
    )

    resp = await test_client.put(
        f"/api/v1/admin/users/{user.id}/role",
        json={"role": "super_admin"},
    )
    assert resp.status_code == 200
    assert "Role changed" in resp.json()["detail"]


async def test_change_role_writes_both_user_roles_and_role_bindings(
    test_client: AsyncClient, db_session,
):
    """Phase 6 regression: ``PUT /admin/users/{id}/role`` must keep
    ``user_roles`` and ``role_bindings`` in sync.

    Pre-fix: only ``user_roles`` was written; the legacy display field
    flipped to ``super_admin`` but the resolver returned empty claims
    because no ``role_bindings`` row existed. So
    ``requires("system:admin")`` 403'd a freshly-promoted admin.
    """
    from backend.app.db.repositories import user_repo, binding_repo
    from backend.app.services.permission_service import resolve

    user = await user_repo.create_user(
        db_session,
        email="dual_sync@example.com",
        password_hash="hash123",
        first_name="Dual",
        last_name="Sync",
    )

    resp = await test_client.put(
        f"/api/v1/admin/users/{user.id}/role",
        json={"role": "super_admin"},
    )
    assert resp.status_code == 200, resp.text

    # Legacy display table flipped.
    roles = await user_repo.get_user_roles(db_session, user.id)
    assert roles == ["super_admin"]

    # Canonical binding table flipped too.
    bindings = await binding_repo.list_for_subject(
        db_session, subject_type="user", subject_id=user.id,
    )
    globals_ = [
        b for b in bindings
        if b.scope_type == "global" and b.role_name == "super_admin"
    ]
    assert len(globals_) == 1, bindings

    # Resolver produces the real claim — system:admin is in
    # ``global_perms`` so subsequent ``requires("system:admin")``
    # checks pass instead of 403'ing.
    claims = await resolve(db_session, user.id)
    assert "system:admin" in claims.global_perms


async def test_change_role_rejects_workspace_template_role(
    test_client: AsyncClient, db_session,
):
    """Phase 6: workspace_admin / workspace_member / workspace_viewer
    are not assignable globally — they need a workspace context, and
    the resolver would drop their perms under the category × scope
    filter anyway. Returns 422 from the DTO validator."""
    from backend.app.db.repositories import user_repo

    user = await user_repo.create_user(
        db_session,
        email="rejected_role@example.com",
        password_hash="hash123",
        first_name="X", last_name="Y",
    )
    for bad_role in ("workspace_admin", "workspace_member", "workspace_viewer"):
        resp = await test_client.put(
            f"/api/v1/admin/users/{user.id}/role",
            json={"role": bad_role},
        )
        assert resp.status_code == 422, (bad_role, resp.text)


async def test_change_own_role_forbidden(test_client: AsyncClient):
    """Admin cannot change their own role — returns 403.

    The fake admin user (``usr_test000000``) is seeded by the
    ``test_client`` fixture, so we can hit the endpoint directly
    without any DB setup.
    """
    resp = await test_client.put(
        "/api/v1/admin/users/usr_test000000/role",
        json={"role": "org_admin"},
    )
    assert resp.status_code == 403


async def test_change_role_invalid_role(test_client: AsyncClient, db_session):
    """Invalid role value returns 422 (Pydantic validator rejects it)."""
    from backend.app.db.repositories import user_repo

    user = await user_repo.create_user(
        db_session,
        email="bad_role@example.com",
        password_hash="hash123",
        first_name="Bad",
        last_name="Role",
    )

    resp = await test_client.put(
        f"/api/v1/admin/users/{user.id}/role",
        json={"role": "superadmin"},
    )
    assert resp.status_code == 422


# ── POST /admin/users/{user_id}/suspend ───────────────────────────────

async def test_suspend_user_not_found(test_client: AsyncClient):
    """Suspending a non-existent user returns 404."""
    resp = await test_client.post("/api/v1/admin/users/usr_nonexistent/suspend")
    assert resp.status_code == 404


async def test_suspend_user(test_client: AsyncClient, db_session):
    """Suspend an active user."""
    from backend.app.db.repositories import user_repo

    user = await user_repo.create_user(
        db_session,
        email="suspend@example.com",
        password_hash="hash123",
        first_name="Suspend",
        last_name="Me",
    )
    await user_repo.update_user_status(db_session, user.id, "active")

    resp = await test_client.post(f"/api/v1/admin/users/{user.id}/suspend")
    assert resp.status_code == 200
    assert resp.json()["detail"] == "User suspended"


async def test_suspend_self_forbidden(test_client: AsyncClient):
    """Admin cannot suspend themselves — returns 403.

    Relies on the ``test_client`` fixture seeding the fake admin user
    (``usr_test000000``) so the endpoint's self-check can fire.
    """
    resp = await test_client.post("/api/v1/admin/users/usr_test000000/suspend")
    assert resp.status_code == 403


async def test_suspend_already_suspended_user(test_client: AsyncClient, db_session):
    """Suspending an already-suspended user returns 409."""
    from backend.app.db.repositories import user_repo

    user = await user_repo.create_user(
        db_session,
        email="already_suspended@example.com",
        password_hash="hash123",
        first_name="Already",
        last_name="Suspended",
    )
    await user_repo.update_user_status(db_session, user.id, "suspended")

    resp = await test_client.post(f"/api/v1/admin/users/{user.id}/suspend")
    assert resp.status_code == 409


# ── POST /admin/users/{user_id}/system-account ────────────────────────

async def test_mark_and_unmark_system_account(test_client: AsyncClient, db_session):
    """The break-glass flag round-trips, is reported on the response,
    and a repeat of the current state is a 409 (the suspend idiom)."""
    from backend.app.db.repositories import user_repo

    user = await user_repo.create_user(
        db_session,
        email="sysacct@example.com",
        password_hash="hash123",
        first_name="Sys",
        last_name="Acct",
    )
    await user_repo.update_user_status(db_session, user.id, "active")

    resp = await test_client.post(
        f"/api/v1/admin/users/{user.id}/system-account",
        json={"isSystemAccount": True},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["isSystemAccount"] is True

    resp = await test_client.post(
        f"/api/v1/admin/users/{user.id}/system-account",
        json={"isSystemAccount": True},
    )
    assert resp.status_code == 409

    resp = await test_client.post(
        f"/api/v1/admin/users/{user.id}/system-account",
        json={"isSystemAccount": False},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["isSystemAccount"] is False


async def test_system_account_not_found(test_client: AsyncClient):
    resp = await test_client.post(
        "/api/v1/admin/users/usr_nonexistent/system-account",
        json={"isSystemAccount": True},
    )
    assert resp.status_code == 404


async def test_unmark_refused_when_it_would_lock_out_the_admin(
    test_client: AsyncClient, db_session,
):
    """Passwords off + active super-admin with no SSO identity: the
    flag is the only thing keeping that admin able to sign in, so
    stripping it is refused with the same 409 the config PATCH uses."""
    from backend.app.db import models as m
    from backend.app.db.repositories import app_auth_config_repo, user_repo

    user = await user_repo.create_user(
        db_session,
        email="lastdoor@example.com",
        password_hash="hash123",
        first_name="Last",
        last_name="Door",
    )
    await user_repo.update_user_status(db_session, user.id, "active")
    await user_repo.set_system_account(db_session, user.id, True)
    db_session.add(m.RoleBindingORM(
        id=f"bnd_{user.id}", subject_type="user", subject_id=user.id,
        role_name="super_admin", scope_type="global", scope_id=None,
        granted_at="2024-01-01T00:00:00Z", source="local",
    ))
    await app_auth_config_repo.update_config(
        db_session, allow_local_login=False, updated_by="test",
    )
    await db_session.flush()

    resp = await test_client.post(
        f"/api/v1/admin/users/{user.id}/system-account",
        json={"isSystemAccount": False},
    )
    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"]["error"] == "would_lock_out_admin"

    # With passwords back on, the same unmark goes through.
    await app_auth_config_repo.update_config(
        db_session, allow_local_login=True, updated_by="test",
    )
    await db_session.flush()

    resp = await test_client.post(
        f"/api/v1/admin/users/{user.id}/system-account",
        json={"isSystemAccount": False},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["isSystemAccount"] is False


# ── POST /admin/users/{user_id}/reactivate ────────────────────────────

async def test_reactivate_user_not_found(test_client: AsyncClient):
    """Reactivating a non-existent user returns 404."""
    resp = await test_client.post("/api/v1/admin/users/usr_nonexistent/reactivate")
    assert resp.status_code == 404


async def test_reactivate_user(test_client: AsyncClient, db_session):
    """Reactivate a suspended user."""
    from backend.app.db.repositories import user_repo

    user = await user_repo.create_user(
        db_session,
        email="reactivate@example.com",
        password_hash="hash123",
        first_name="React",
        last_name="Ivate",
    )
    await user_repo.update_user_status(db_session, user.id, "suspended")

    resp = await test_client.post(f"/api/v1/admin/users/{user.id}/reactivate")
    assert resp.status_code == 200
    assert resp.json()["detail"] == "User reactivated"


async def test_reactivate_already_active_user(test_client: AsyncClient, db_session):
    """Reactivating an already-active user returns 409."""
    from backend.app.db.repositories import user_repo

    user = await user_repo.create_user(
        db_session,
        email="already_active@example.com",
        password_hash="hash123",
        first_name="Already",
        last_name="Active",
    )
    await user_repo.update_user_status(db_session, user.id, "active")

    resp = await test_client.post(f"/api/v1/admin/users/{user.id}/reactivate")
    assert resp.status_code == 409


# ── POST /admin/users/{user_id}/reset-password ────────────────────────

async def test_reset_password_not_found(test_client: AsyncClient):
    """Resetting password for non-existent user returns 404."""
    resp = await test_client.post(
        "/api/v1/admin/users/usr_nonexistent/reset-password",
        json={"newPassword": "StrongP@ss1234!"},
    )
    assert resp.status_code == 404


async def test_reset_password(test_client: AsyncClient, db_session):
    """Admin resets a user's password."""
    from backend.app.db.repositories import user_repo

    user = await user_repo.create_user(
        db_session,
        email="reset_pw@example.com",
        password_hash="hash123",
        first_name="Reset",
        last_name="PW",
    )

    resp = await test_client.post(
        f"/api/v1/admin/users/{user.id}/reset-password",
        json={"newPassword": "V3ryStr0ngP@ssw0rd!"},
    )
    assert resp.status_code == 200
    assert resp.json()["detail"] == "Password has been reset"


# ── POST /admin/users/{user_id}/generate-reset-token ──────────────────

async def test_generate_reset_token_not_found(test_client: AsyncClient):
    """Generating reset token for non-existent user returns 404."""
    resp = await test_client.post("/api/v1/admin/users/usr_nonexistent/generate-reset-token")
    assert resp.status_code == 404


async def test_generate_reset_token(test_client: AsyncClient, db_session):
    """Admin generates a reset token for a user."""
    from backend.app.db.repositories import user_repo

    user = await user_repo.create_user(
        db_session,
        email="gen_token@example.com",
        password_hash="hash123",
        first_name="Gen",
        last_name="Token",
    )

    resp = await test_client.post(f"/api/v1/admin/users/{user.id}/generate-reset-token")
    assert resp.status_code == 200
    body = resp.json()
    assert "resetToken" in body
    assert "expiresAt" in body


# ── Self-service: PATCH /users/me ─────────────────────────────────────

async def test_update_me_changes_names(test_client: AsyncClient):
    """A rename lands and is visible on the next read."""
    resp = await test_client.patch(
        "/api/v1/users/me",
        json={"firstName": "Renamed", "lastName": "Person"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["firstName"] == "Renamed"
    assert resp.json()["displayName"] == "Renamed Person"

    again = await test_client.get("/api/v1/users/me")
    assert again.json()["lastName"] == "Person"


async def test_update_me_trims_whitespace(test_client: AsyncClient):
    """Padding around a name is the client's, not part of the name."""
    resp = await test_client.patch(
        "/api/v1/users/me", json={"firstName": "  Trimmed  "},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["firstName"] == "Trimmed"


async def test_update_me_sets_and_clears_display_name(test_client: AsyncClient):
    """An empty display name is an instruction, not a mistake.

    Clearing the override has to fall back to first + last rather than
    blanking the account out of every list it appears in.
    """
    set_resp = await test_client.patch(
        "/api/v1/users/me", json={"displayName": "Just Rin"},
    )
    assert set_resp.status_code == 200, set_resp.text
    assert set_resp.json()["displayName"] == "Just Rin"

    cleared = await test_client.patch("/api/v1/users/me", json={"displayName": ""})
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["displayName"] == "Test User"


async def test_update_me_noop_returns_current_state(test_client: AsyncClient):
    """An empty body is a read, not a write."""
    resp = await test_client.patch("/api/v1/users/me", json={})
    assert resp.status_code == 200, resp.text
    assert resp.json()["id"] == "usr_test000000"


async def test_update_me_rejects_blank_name(test_client: AsyncClient):
    """A blank first name is a mistake — Pydantic catches it."""
    resp = await test_client.patch("/api/v1/users/me", json={"firstName": ""})
    assert resp.status_code == 422


async def test_update_me_records_who_did_it(test_client: AsyncClient, db_session):
    """``updated_by == user_id`` also describes an admin editing their
    own row. ``via`` is what tells the two apart."""
    import json as _json

    from sqlalchemy import select
    from backend.app.db.models import OutboxEventORM

    await test_client.patch("/api/v1/users/me", json={"firstName": "Audited"})

    rows = (await db_session.execute(
        select(OutboxEventORM).where(
            OutboxEventORM.event_type == "user.identity_updated",
        )
    )).scalars().all()
    assert rows, "expected an identity_updated event"
    payload = _json.loads(rows[-1].payload)
    assert payload["via"] == "self_service"
    assert rows[-1].aggregate_id == "usr_test000000"


# ── Self-service: POST /users/me/password ─────────────────────────────
#
# The fake user is seeded with ``password_hash="not-a-real-hash"``
# (conftest), which ``is_password_set`` reads as "has a password" and
# ``verify_password`` reads as "wrong" — so the wrong-password case
# needs no seeding at all. The rest go through ``_set_my_password``.

_STRONG = "C0mpl3x!Passw0rd#2026"


@pytest.fixture(autouse=True)
def _disable_users_rate_limit():
    """``/users/me/password`` is 5/minute and every test shares an IP."""
    from backend.app.api.v1.endpoints import users as _users_mod
    prev = _users_mod.limiter.enabled
    _users_mod.limiter.enabled = False
    yield
    _users_mod.limiter.enabled = prev


async def _set_my_password(db_session, password: str | None) -> None:
    """Give the fake user a real Argon2id hash, or the SSO-only sentinel."""
    from backend.app.db.repositories import user_repo
    from backend.auth_service.core.password import (
        disabled_password_hash, hash_password,
    )

    hashed = (
        hash_password(password) if password is not None
        else disabled_password_hash()
    )
    await user_repo.update_password(db_session, "usr_test000000", hashed)
    await db_session.flush()


async def test_change_password_wrong_current_is_403(test_client: AsyncClient):
    """403, not 401.

    The frontend treats 401 as a dead session — it silently refreshes,
    retries, then signs the user out. A typo in this field must not end
    the session it is trying to secure.
    """
    resp = await test_client.post(
        "/api/v1/users/me/password",
        json={"currentPassword": "whatever-is-wrong", "newPassword": _STRONG},
    )
    assert resp.status_code == 403, resp.text
    assert resp.json()["detail"] == "Current password is incorrect."


async def test_change_password_happy_path(test_client: AsyncClient, db_session):
    """The new password is what actually ends up on the row."""
    from backend.app.db.repositories import user_repo
    from backend.auth_service.core.password import verify_password

    await _set_my_password(db_session, "Old!Passw0rd#2026")

    resp = await test_client.post(
        "/api/v1/users/me/password",
        json={"currentPassword": "Old!Passw0rd#2026", "newPassword": _STRONG},
    )
    assert resp.status_code == 200, resp.text

    user = await user_repo.get_user_by_id(db_session, "usr_test000000")
    assert verify_password(_STRONG, user.password_hash)


async def test_change_password_weak_new_is_422(test_client: AsyncClient, db_session):
    """Same zxcvbn floor as every other password entry point."""
    await _set_my_password(db_session, "Old!Passw0rd#2026")
    resp = await test_client.post(
        "/api/v1/users/me/password",
        json={"currentPassword": "Old!Passw0rd#2026", "newPassword": "password1"},
    )
    assert resp.status_code == 422, resp.text


async def test_change_password_short_new_is_422(test_client: AsyncClient):
    """Caught by the DTO before the handler runs."""
    resp = await test_client.post(
        "/api/v1/users/me/password",
        json={"currentPassword": "anything", "newPassword": "short"},
    )
    assert resp.status_code == 422


async def test_change_password_sso_only_account_is_409(
    test_client: AsyncClient, db_session,
):
    """An SSO-only account has no password to be wrong about.

    Deliberately sends a wrong ``currentPassword`` too: the 409 has to
    win, or the user goes hunting for a credential that doesn't exist.
    """
    await _set_my_password(db_session, None)
    resp = await test_client.post(
        "/api/v1/users/me/password",
        json={"currentPassword": "definitely-wrong", "newPassword": _STRONG},
    )
    assert resp.status_code == 409, resp.text
    assert "identity provider" in resp.json()["detail"]


async def test_change_password_revokes_sessions(test_client: AsyncClient, db_session):
    """Changing the password has to actually sign the sessions out."""
    from backend.app.db.repositories import user_repo

    await _set_my_password(db_session, "Old!Passw0rd#2026")
    await test_client.post(
        "/api/v1/users/me/password",
        json={"currentPassword": "Old!Passw0rd#2026", "newPassword": _STRONG},
    )

    user = await user_repo.get_user_by_id(db_session, "usr_test000000")
    assert user.sessions_valid_from, "expected a revocation cutoff to be stamped"


async def test_change_password_clears_pending_reset(
    test_client: AsyncClient, db_session,
):
    """Fixing your own password retires the admin reset you asked for."""
    from backend.app.db.repositories import user_repo

    await _set_my_password(db_session, "Old!Passw0rd#2026")
    await user_repo.flag_reset_requested(db_session, "usr_test000000")
    assert await user_repo.has_pending_reset(db_session, "usr_test000000")

    await test_client.post(
        "/api/v1/users/me/password",
        json={"currentPassword": "Old!Passw0rd#2026", "newPassword": _STRONG},
    )
    assert not await user_repo.has_pending_reset(db_session, "usr_test000000")


async def test_change_password_clears_forced_rotation(
    test_client: AsyncClient, db_session,
):
    """The whole point of the forced-rotation flag is that rotating clears it."""
    from backend.app.db.repositories import user_repo

    await _set_my_password(db_session, "Old!Passw0rd#2026")
    await user_repo.set_must_change_password(db_session, "usr_test000000", True)

    await test_client.post(
        "/api/v1/users/me/password",
        json={"currentPassword": "Old!Passw0rd#2026", "newPassword": _STRONG},
    )
    user = await user_repo.get_user_by_id(db_session, "usr_test000000")
    assert user.must_change_password is False


# ── Self-service: sessions and activity ───────────────────────────────

async def test_revoke_my_sessions_stamps_cutoff(test_client: AsyncClient, db_session):
    from backend.app.db.repositories import user_repo

    resp = await test_client.post("/api/v1/users/me/sessions/revoke-all")
    assert resp.status_code == 200, resp.text

    user = await user_repo.get_user_by_id(db_session, "usr_test000000")
    assert user.sessions_valid_from


async def test_revoke_my_sessions_clears_this_devices_cookies(
    test_client: AsyncClient,
):
    """"This device included" has to include the cookies.

    Revoking server-side alone left the caller's browser holding a full
    set of session cookies for a session that no longer existed. The SPA
    read them, still believed it was signed in, and the login page
    offered "You're already signed in as …" — for the session the user
    had just destroyed. Reloading re-read the same cookies and said it
    again, so there was no way out of your own sign-out except clearing
    cookies by hand.
    """
    from backend.auth_service.cookies import (
        ACCESS_COOKIE_NAME,
        CSRF_COOKIE_NAME,
        REFRESH_COOKIE_NAME,
    )

    resp = await test_client.post("/api/v1/users/me/sessions/revoke-all")
    assert resp.status_code == 200, resp.text

    # A deletion is a Set-Cookie with an expiry in the past, so assert on
    # the header rather than on the client jar: the jar is where the
    # deletion *lands*, the header is where the server *states* it.
    cleared = "\n".join(resp.headers.get_list("set-cookie"))
    for name in (ACCESS_COOKIE_NAME, REFRESH_COOKIE_NAME, CSRF_COOKIE_NAME):
        assert name in cleared, (
            f"{name} was not cleared; the caller keeps a cookie for a "
            "session that no longer exists"
        )


async def test_changing_my_password_clears_this_devices_cookies(
    test_client: AsyncClient, db_session,
):
    """The same defect, found by sweeping for it rather than by report.

    Changing your own password revokes every session — the endpoint says
    so and the UI toast says "Sign in again" — and it left the caller's
    cookies in place exactly as revoke-all did. Both self-service
    callers shipped the bug independently, which is why the clearing now
    lives inside ``_revoke_my_every_session`` where it cannot be
    forgotten by a third one.
    """
    from backend.auth_service.cookies import (
        ACCESS_COOKIE_NAME,
        CSRF_COOKIE_NAME,
        REFRESH_COOKIE_NAME,
    )

    await _set_my_password(db_session, "Old!Passw0rd#2026")
    resp = await test_client.post(
        "/api/v1/users/me/password",
        json={
            "currentPassword": "Old!Passw0rd#2026",
            "newPassword": _STRONG,
        },
    )
    assert resp.status_code == 200, resp.text

    cleared = "\n".join(resp.headers.get_list("set-cookie"))
    for name in (ACCESS_COOKIE_NAME, REFRESH_COOKIE_NAME, CSRF_COOKIE_NAME):
        assert name in cleared, f"{name} survived a password change"


async def test_activity_lists_my_own_events(test_client: AsyncClient):
    """Own security history, newest first."""
    await test_client.patch("/api/v1/users/me", json={"firstName": "Active"})
    await test_client.post("/api/v1/users/me/sessions/revoke-all")

    resp = await test_client.get("/api/v1/users/me/activity")
    assert resp.status_code == 200, resp.text
    types = [row["eventType"] for row in resp.json()]
    assert "user.sessions_revoked_by_self" in types
    assert "user.identity_updated" in types


async def test_activity_excludes_other_peoples_events(
    test_client: AsyncClient, db_session,
):
    """It is *my* account activity, not a feed of everyone's."""
    from backend.app.db.repositories import user_repo

    await user_repo.create_outbox_event(
        db_session,
        event_type="user.password_changed",
        payload={"user_id": "usr_someone_else"},
        aggregate_type="user",
        aggregate_id="usr_someone_else",
    )
    await db_session.flush()

    resp = await test_client.get("/api/v1/users/me/activity")
    assert resp.status_code == 200, resp.text
    assert resp.json() == []
