"""
API endpoint tests for /api/v1/users/* and /api/v1/admin/users/*.

Tests the user profile (GET /me) and admin user management endpoints
using the test_client fixture which overrides auth and DB session.

Note: The test_client overrides get_current_user, require_admin, and get_optional_user
to return a fake user (usr_test000000). For admin endpoints that operate on *other*
users, we create additional users via the repo directly through the DB session.
"""
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
        json={"role": "admin"},
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
        json={"role": "admin"},
    )
    assert resp.status_code == 200
    assert "Role changed" in resp.json()["detail"]


async def test_change_own_role_forbidden(test_client: AsyncClient, db_session):
    """Admin cannot change their own role — returns 403."""
    from backend.app.db.repositories import user_repo
    # The fake admin user (usr_test000000) must exist in the DB for the endpoint
    # to reach the self-check (it does get_user_by_id first, returning 404 if missing).
    await user_repo.create_user(
        db_session, email="admin_self@example.com", password_hash="x",
        first_name="Admin", last_name="Self",
    )
    from backend.app.db.models import UserORM
    from sqlalchemy import update
    await db_session.execute(
        update(UserORM).where(UserORM.email == "admin_self@example.com")
        .values(id="usr_test000000", status="active")
    )
    await db_session.flush()

    resp = await test_client.put(
        "/api/v1/admin/users/usr_test000000/role",
        json={"role": "viewer"},
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


async def test_suspend_self_forbidden(test_client: AsyncClient, db_session):
    """Admin cannot suspend themselves — returns 403."""
    from backend.app.db.repositories import user_repo
    from backend.app.db.models import UserORM
    from sqlalchemy import update
    # Must persist fake admin user in DB for endpoint to reach the self-check.
    await user_repo.create_user(
        db_session, email="admin_suspend_self@example.com", password_hash="x",
        first_name="Admin", last_name="Self",
    )
    await db_session.execute(
        update(UserORM).where(UserORM.email == "admin_suspend_self@example.com")
        .values(id="usr_test000000", status="active")
    )
    await db_session.flush()

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
