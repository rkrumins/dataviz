"""
Phase 4 — API endpoint tests for /api/v1/auth/*.

Auth endpoints are public (no get_current_user dependency), so the
test_client's auth override does not interfere.  Rate limiting (slowapi)
may trigger 429 responses on repeated calls; tests are kept minimal to
avoid hitting the limit.
"""
import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.password import hash_password
from backend.app.db.repositories import user_repo


# ── helpers ────────────────────────────────────────────────────────────

async def _seed_active_user(session: AsyncSession, email: str = "alice@example.com", password: str = "Str0ng!Pass#2026") -> str:
    """Insert an active user directly via the repo and return the user id."""
    hashed = hash_password(password)
    user = await user_repo.create_user(
        session,
        email=email,
        password_hash=hashed,
        first_name="Alice",
        last_name="Tester",
        status="active",
    )
    await session.commit()
    return user.id


# ── POST /signup ──────────────────────────────────────────────────────

async def test_signup_valid(test_client: AsyncClient, db_session: AsyncSession):
    """Valid signup returns 201 with a confirmation message."""
    resp = await test_client.post(
        "/api/v1/auth/signup",
        json={
            "email": "newuser@example.com",
            "password": "C0mpl3x!Passw0rd#",
            "firstName": "New",
            "lastName": "User",
        },
    )
    assert resp.status_code == 201
    body = resp.json()
    assert "message" in body


async def test_signup_weak_password(test_client: AsyncClient):
    """A trivially weak password should be rejected with 422."""
    resp = await test_client.post(
        "/api/v1/auth/signup",
        json={
            "email": "weak@example.com",
            "password": "abc",
            "firstName": "Weak",
            "lastName": "Pass",
        },
    )
    # Pydantic min_length=8 triggers 422 before the endpoint even runs
    assert resp.status_code == 422


async def test_signup_duplicate_email(test_client: AsyncClient, db_session: AsyncSession):
    """Signup with an existing email still returns 201 (anti-enumeration)."""
    await _seed_active_user(db_session, email="dup@example.com")
    resp = await test_client.post(
        "/api/v1/auth/signup",
        json={
            "email": "dup@example.com",
            "password": "C0mpl3x!Passw0rd#",
            "firstName": "Dup",
            "lastName": "User",
        },
    )
    # The endpoint deliberately returns 201 even for duplicates
    assert resp.status_code == 201


# ── POST /login ───────────────────────────────────────────────────────

async def test_login_valid(test_client: AsyncClient, db_session: AsyncSession):
    """Login with correct credentials returns 200 with an access token."""
    password = "C0mpl3x!Passw0rd#"
    await _seed_active_user(db_session, email="login@example.com", password=password)
    resp = await test_client.post(
        "/api/v1/auth/login",
        json={"email": "login@example.com", "password": password},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert "accessToken" in body
    assert "user" in body
    assert body["user"]["email"] == "login@example.com"


async def test_login_wrong_password(test_client: AsyncClient, db_session: AsyncSession):
    """Login with wrong password returns 401."""
    await _seed_active_user(db_session, email="wrong@example.com")
    resp = await test_client.post(
        "/api/v1/auth/login",
        json={"email": "wrong@example.com", "password": "TotallyWr0ng!"},
    )
    assert resp.status_code == 401


async def test_login_nonexistent_user(test_client: AsyncClient):
    """Login for a non-existent email returns 401 (same as wrong password)."""
    resp = await test_client.post(
        "/api/v1/auth/login",
        json={"email": "ghost@example.com", "password": "Whatever1!"},
    )
    assert resp.status_code == 401


# ── POST /forgot-password ────────────────────────────────────────────

async def test_forgot_password_always_200(test_client: AsyncClient):
    """Forgot password returns 200 regardless of email existence."""
    resp = await test_client.post(
        "/api/v1/auth/forgot-password",
        json={"email": "anyone@example.com"},
    )
    assert resp.status_code == 200
    assert "message" in resp.json()


# ── POST /reset-password ─────────────────────────────────────────────

async def test_reset_password_invalid_token(test_client: AsyncClient):
    """Reset with an invalid token returns 400."""
    resp = await test_client.post(
        "/api/v1/auth/reset-password",
        json={"token": "bogus-token-123", "newPassword": "N3wStr0ng!Pass#"},
    )
    assert resp.status_code == 400


# ── Protected endpoint check ─────────────────────────────────────────

async def test_protected_endpoint_works_with_override(test_client: AsyncClient):
    """
    Confirm the test_client's auth override lets us reach a protected
    endpoint (e.g. list providers) without a real JWT.
    """
    resp = await test_client.get("/api/v1/admin/providers")
    assert resp.status_code == 200
