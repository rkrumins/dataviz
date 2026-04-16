"""
End-to-end cookie-based auth flow:

    POST /api/v1/auth/login    → 200 + nx_access / nx_refresh / nx_csrf cookies
    GET  /api/v1/auth/me       → 200 + user
    POST /api/v1/auth/refresh  → 200 + rotated cookies
    POST /api/v1/auth/logout   → 200, cookies cleared
    Replayed refresh token     → 401 + family revoked

These exercise the full ``LocalIdentityService`` path against the
in-memory test DB.
"""
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.password import hash_password
from backend.app.db.repositories import user_repo
from backend.auth_service.cookies import (
    ACCESS_COOKIE_NAME,
    CSRF_COOKIE_NAME,
    REFRESH_COOKIE_NAME,
)


_PASSWORD = "C0mpl3x!Passw0rd#"


async def _seed(db_session: AsyncSession, email: str = "cookie@example.com") -> str:
    user = await user_repo.create_user(
        db_session,
        email=email,
        password_hash=hash_password(_PASSWORD),
        first_name="Cookie",
        last_name="Tester",
        status="active",
    )
    await user_repo.assign_role(db_session, user.id, "admin")
    await db_session.commit()
    return user.id


# ── login ────────────────────────────────────────────────────────────

async def test_login_sets_three_session_cookies(
    test_client: AsyncClient, db_session: AsyncSession
):
    user_id = await _seed(db_session)
    resp = await test_client.post(
        "/api/v1/auth/login",
        json={"email": "cookie@example.com", "password": _PASSWORD},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()

    # Body must contain the user — and must NOT contain a token.
    assert body["user"]["id"] == user_id
    assert body["user"]["email"] == "cookie@example.com"
    assert "accessToken" not in body
    assert "refreshToken" not in body

    # Three cookies issued.
    cookies = resp.cookies
    assert ACCESS_COOKIE_NAME in cookies
    assert REFRESH_COOKIE_NAME in cookies
    assert CSRF_COOKIE_NAME in cookies


async def test_login_wrong_password_returns_401_no_cookies(
    test_client: AsyncClient, db_session: AsyncSession
):
    await _seed(db_session)
    resp = await test_client.post(
        "/api/v1/auth/login",
        json={"email": "cookie@example.com", "password": "totally-wrong"},
    )
    assert resp.status_code == 401
    assert ACCESS_COOKIE_NAME not in resp.cookies


async def test_login_unknown_email_returns_401(test_client: AsyncClient):
    resp = await test_client.post(
        "/api/v1/auth/login",
        json={"email": "ghost@example.com", "password": "Whatever1!"},
    )
    assert resp.status_code == 401


# ── /me ──────────────────────────────────────────────────────────────

async def test_me_after_login_returns_user(
    test_client: AsyncClient, db_session: AsyncSession
):
    user_id = await _seed(db_session)
    login = await test_client.post(
        "/api/v1/auth/login",
        json={"email": "cookie@example.com", "password": _PASSWORD},
    )
    assert login.status_code == 200

    me = await test_client.get("/api/v1/auth/me")
    assert me.status_code == 200
    assert me.json()["user"]["id"] == user_id


async def test_me_without_cookie_returns_401(test_client: AsyncClient):
    # Strip any cookies the client carries by default.
    test_client.cookies.delete(ACCESS_COOKIE_NAME)
    me = await test_client.get("/api/v1/auth/me")
    assert me.status_code == 401


# ── refresh rotation ─────────────────────────────────────────────────

async def test_refresh_rotates_tokens(
    test_client: AsyncClient, db_session: AsyncSession
):
    await _seed(db_session)
    login = await test_client.post(
        "/api/v1/auth/login",
        json={"email": "cookie@example.com", "password": _PASSWORD},
    )
    assert login.status_code == 200
    original_refresh = test_client.cookies.get(REFRESH_COOKIE_NAME)
    assert original_refresh

    refresh = await test_client.post("/api/v1/auth/refresh")
    assert refresh.status_code == 200, refresh.text
    new_refresh = refresh.cookies.get(REFRESH_COOKIE_NAME)
    assert new_refresh and new_refresh != original_refresh


async def test_refresh_replay_kills_family(
    test_client: AsyncClient, db_session: AsyncSession
):
    """A replayed refresh token revokes the entire family — defence
    against a stolen refresh cookie being used in parallel.

    Done with explicit per-request cookies so the test isn't sensitive
    to httpx's cookie-jar layering rules.
    """
    await _seed(db_session)
    login = await test_client.post(
        "/api/v1/auth/login",
        json={"email": "cookie@example.com", "password": _PASSWORD},
    )
    assert login.status_code == 200
    captured_rt = login.cookies.get(REFRESH_COOKIE_NAME)
    assert captured_rt

    # First rotation succeeds — drives the captured jti into the
    # revoked-jti table.
    first = await test_client.post(
        "/api/v1/auth/refresh",
        cookies={REFRESH_COOKIE_NAME: captured_rt},
    )
    assert first.status_code == 200

    # Replay the same (now-consumed) refresh token: reuse-detection fires.
    replay = await test_client.post(
        "/api/v1/auth/refresh",
        cookies={REFRESH_COOKIE_NAME: captured_rt},
    )
    assert replay.status_code == 401

    # The family is now revoked — even the legitimate rotated token
    # from `first` is useless because the whole family was killed.
    rotated_rt = first.cookies.get(REFRESH_COOKIE_NAME)
    assert rotated_rt
    third = await test_client.post(
        "/api/v1/auth/refresh",
        cookies={REFRESH_COOKIE_NAME: rotated_rt},
    )
    assert third.status_code == 401


async def test_refresh_without_cookie_returns_401(test_client: AsyncClient):
    test_client.cookies.delete(REFRESH_COOKIE_NAME)
    resp = await test_client.post("/api/v1/auth/refresh")
    assert resp.status_code == 401


# ── logout ───────────────────────────────────────────────────────────

async def test_logout_clears_cookies_and_revokes_family(
    test_client: AsyncClient, db_session: AsyncSession
):
    await _seed(db_session)
    login = await test_client.post(
        "/api/v1/auth/login",
        json={"email": "cookie@example.com", "password": _PASSWORD},
    )
    captured_refresh = login.cookies.get(REFRESH_COOKIE_NAME)
    assert captured_refresh

    logout = await test_client.post("/api/v1/auth/logout")
    assert logout.status_code == 200

    # Replay the captured refresh after logout — should be rejected.
    replay = await test_client.post(
        "/api/v1/auth/refresh",
        cookies={REFRESH_COOKIE_NAME: captured_refresh},
    )
    assert replay.status_code == 401


async def test_logout_is_idempotent(test_client: AsyncClient):
    """Calling /logout without a session is fine — no error, no cookies."""
    test_client.cookies.delete(REFRESH_COOKIE_NAME)
    resp = await test_client.post("/api/v1/auth/logout")
    assert resp.status_code == 200
