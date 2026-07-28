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
from backend.auth_service.core.config import JWT_AUDIENCE, JWT_ISSUER
from backend.auth_service.core.tokens import create_access_token


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
    await user_repo.assign_role(db_session, user.id, "super_admin")
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


# ── foreign sessions (cross-environment / rotated key) ───────────────
#
# The reported production failure: a cookie minted by a DIFFERENT
# deployment reaches this one. Because both used identical cookie names
# and identical iss/aud, the receiving side could only report
# "Signature verification failed" — and, crucially, never evicted the
# cookie, so the browser re-presented it on every request and the user
# ping-ponged between the app and /login forever.

def _foreign_token(audience_suffix: str = "") -> str:
    """A structurally valid token signed by a key we do not hold."""
    import jwt as pyjwt
    from datetime import datetime, timedelta, timezone

    now = datetime.now(timezone.utc)
    return pyjwt.encode(
        {
            "sub": "someone-from-another-environment",
            "email": "a@b.c",
            "role": "user",
            "iss": JWT_ISSUER,
            "aud": JWT_AUDIENCE + audience_suffix,
            "iat": now,
            "exp": now + timedelta(hours=1),
        },
        "a-completely-different-signing-key-" + "z" * 32,
        algorithm="HS256",
        headers={"kid": "deadbeef"},
    )


async def test_foreign_access_cookie_is_evicted_not_looped(
    test_client: AsyncClient,
):
    """A foreign access cookie must be cleared, not merely rejected.

    Rejecting without evicting is what makes the login loop permanent:
    the cookie survives, so the very next request repeats the 401.
    """
    test_client.cookies.clear()
    resp = await test_client.get(
        "/api/v1/auth/me", cookies={ACCESS_COOKIE_NAME: _foreign_token()}
    )
    assert resp.status_code == 401
    assert resp.json()["detail"]["error"] == "session_foreign"

    set_cookies = resp.headers.get_list("set-cookie")
    assert any(h.startswith(f"{ACCESS_COOKIE_NAME}=") for h in set_cookies), set_cookies
    # Deleted, not re-set: an eviction carries an immediate expiry.
    evictions = [h for h in set_cookies if h.startswith(f"{ACCESS_COOKIE_NAME}=")]
    assert all(
        "Max-Age=0" in h or "01 Jan 1970" in h for h in evictions
    ), evictions


async def test_foreign_refresh_cookie_reports_session_foreign(
    test_client: AsyncClient,
):
    """/refresh must tell the client to stop refreshing.

    Without the marker the frontend keeps retrying a token that can
    never verify here.
    """
    test_client.cookies.clear()
    resp = await test_client.post(
        "/api/v1/auth/refresh",
        cookies={REFRESH_COOKIE_NAME: _foreign_token(":refresh")},
    )
    assert resp.status_code == 401
    assert resp.json()["detail"]["error"] == "session_foreign"


async def test_expired_cookie_is_not_treated_as_foreign(
    test_client: AsyncClient,
):
    """Ordinary expiry must keep the silent-refresh path.

    If expiry were classified as foreign, every user would be forced to
    re-login each time the 5-minute access token lapsed.
    """
    from datetime import datetime, timedelta, timezone

    # Mint through the app's own signing path and just backdate ``exp``
    # (``extra`` is merged last, so it overrides). Signing by hand here
    # would need the secret, and reading it at call time can pick up a
    # module another test reloaded — making this test fail for a reason
    # that has nothing to do with expiry.
    past = datetime.now(timezone.utc) - timedelta(hours=1)
    stale = create_access_token(
        "u1", "a@b.c", "user", extra={"exp": past},
    )
    test_client.cookies.clear()
    resp = await test_client.get(
        "/api/v1/auth/me", cookies={ACCESS_COOKIE_NAME: stale}
    )
    assert resp.status_code == 401
    assert resp.json()["detail"] == "Not authenticated"


async def test_diagnostics_reports_a_foreign_cookie(test_client: AsyncClient):
    """The operator-facing explanation of the failure."""
    test_client.cookies.clear()
    resp = await test_client.get(
        "/api/v1/auth/diagnostics",
        cookies={ACCESS_COOKIE_NAME: _foreign_token()},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert "foreign" in body["sessionCookiesPresented"]["access"]
    assert body["activeKid"] in body["acceptedKids"]
    # No key material is ever exposed.
    assert "secret" not in resp.text.lower()
