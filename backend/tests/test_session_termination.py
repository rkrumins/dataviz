"""Ending a session must end the credential the caller is holding.

Three paths converged on the same gap. ``logout`` revoked the refresh
family and stopped there; the two password-reset paths updated the hash
and stopped there. All three read as "the session is over" and none of
them touched the ``sid`` tombstone that ``get_current_user`` actually
consults on every request — so the access token already issued kept
working until it expired.

The window is not small. It is ``JWT_EXPIRY_MINUTES +
CLOCK_SKEW_LEEWAY_SECONDS``, which the shipped compose file sets to an
hour. And for the reset paths it inverts the purpose of the flow: a
password reset is what somebody performs *because* they believe they are
compromised.

These drive the real HTTP endpoints through the app so the wiring is
part of what is under test — a service-level test would pass with the
``session_revoker`` unwired, which is precisely how ``session_killer``
came to exist while ``logout`` never called it.
"""
from __future__ import annotations

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.password import hash_password
from backend.app.db.repositories import user_repo
from backend.app.services import permission_service
from backend.app.services.revocation_service import get_revocation_service
from backend.auth_service.core.tokens import decode_token

_PASSWORD = "C0mpl3x!Passw0rd#"

#: What a reset moves the password TO. Derived from _PASSWORD rather than
#: written as a second credential-shaped literal: the tests only need a
#: value that DIFFERS and still clears the zxcvbn strength check, and a
#: second hardcoded password is a second thing for a secret scanner to
#: flag for no benefit. _PASSWORD itself stays as-is -- it is the shared
#: fixture ten other auth test files already use.
_NEW_PASSWORD = _PASSWORD + "-rotated"


@pytest.fixture()
def real_claims(test_client):
    """Give minted tokens a real ``sid``.

    ``conftest``'s service is built with no ``claims_resolver``, so login
    normally mints a token with no ``sid`` at all — and a token with no
    ``sid`` cannot demonstrate anything about ``sid`` tombstoning.
    Mirrors ``_resolve_claims`` in ``app/main.py``.
    """
    from backend.app.main import app

    svc = app.state.identity_service

    async def _resolve(session, user_id: str) -> dict:
        claims = await permission_service.resolve(session, user_id)
        await get_revocation_service().record_session(
            user_id, claims.sid, claims=claims.to_session_dict(),
        )
        return claims.to_jwt_dict()

    previous = svc._claims_resolver
    svc._claims_resolver = _resolve
    yield
    svc._claims_resolver = previous


@pytest.fixture()
def wire_session_revoker(test_client):
    """Wire the per-session revoker, as ``app/main.py`` does at startup.

    The conftest service omits it along with every other injected hook,
    so without this the logout path has nothing to call and the test
    would be asserting on production wiring it never exercised.
    """
    from backend.app.main import app

    svc = app.state.identity_service

    async def _revoke_one(sid: str) -> None:
        await get_revocation_service().revoke_session(sid)

    previous = getattr(svc, "_session_revoker", None)
    svc._session_revoker = _revoke_one
    yield
    svc._session_revoker = previous


async def _seed(db_session: AsyncSession, email: str) -> str:
    user = await user_repo.create_user(
        db_session,
        email=email,
        password_hash=hash_password(_PASSWORD),
        first_name="Sess",
        last_name="Ion",
        status="active",
    )
    await db_session.commit()
    return user.id


def _set_cookie(res, name: str) -> str | None:
    for header in res.headers.get_list("set-cookie"):
        if header.startswith(f"{name}="):
            return header.split(";", 1)[0][len(name) + 1:]
    return None


async def _login(client: AsyncClient, email: str) -> str:
    """Sign in and return the access JWT the server set.

    Login rotates ``nx_csrf``, so the header the client sends has to be
    re-pointed at the new cookie or every later write 403s. That is what
    the SPA does — ``fetchWithTimeout`` reads the cookie per request and
    echoes it — and the conftest client's fixed header does not.
    """
    res = await client.post(
        "/api/v1/auth/login", json={"email": email, "password": _PASSWORD},
    )
    assert res.status_code == 200, res.text

    csrf = _set_cookie(res, "nx_csrf")
    if csrf:
        client.headers["X-CSRF-Token"] = csrf

    access = _set_cookie(res, "nx_access")
    assert access, "login set no access cookie"
    return access


# ── logout ───────────────────────────────────────────────────────────

async def test_logout_tombstones_the_access_token_it_was_given(
    test_client: AsyncClient, db_session: AsyncSession,
    real_claims, wire_session_revoker,
):
    """The captured-token replay, end to end.

    Before the fix this sid was never tombstoned, so a token copied out
    of the browser before sign-out authenticated every request for the
    rest of its lifetime.
    """
    await _seed(db_session, "logout-sid@example.com")
    access = await _login(test_client, "logout-sid@example.com")
    sid = decode_token(access)["sid"]
    assert not await get_revocation_service().is_revoked(sid)

    res = await test_client.post("/api/v1/auth/logout")
    assert res.status_code == 200, res.text

    assert await get_revocation_service().is_revoked(sid), (
        "logout left the access token honoured until its own expiry"
    )


async def test_logout_without_an_access_cookie_still_succeeds(
    test_client: AsyncClient, db_session: AsyncSession,
    real_claims, wire_session_revoker,
):
    """Sign-out is idempotent and must not depend on the access cookie.

    A tab whose access cookie already expired still needs its refresh
    family revoked, so the tombstone step is best-effort rather than a
    precondition.
    """
    await _seed(db_session, "logout-noaccess@example.com")
    await _login(test_client, "logout-noaccess@example.com")
    test_client.cookies.delete("nx_access")

    res = await test_client.post("/api/v1/auth/logout")
    assert res.status_code == 200, res.text


# ── password reset ───────────────────────────────────────────────────

async def test_self_service_reset_revokes_every_existing_session(
    test_client: AsyncClient, db_session: AsyncSession, real_claims,
):
    """The remediation must actually evict whoever is already in."""
    user_id = await _seed(db_session, "reset-self@example.com")
    access = await _login(test_client, "reset-self@example.com")
    sid = decode_token(access)["sid"]

    token, _expires_at = await user_repo.create_reset_token(db_session, user_id)
    await db_session.commit()

    res = await test_client.post(
        "/api/v1/auth/reset-password",
        json={"token": token, "new_password": _NEW_PASSWORD},
    )
    assert res.status_code == 200, res.text

    assert await get_revocation_service().is_revoked(sid), (
        "the attacker's live session survived the victim's password reset"
    )
    refreshed = await user_repo.get_user_by_id(db_session, user_id)
    assert refreshed.sessions_valid_from is not None, (
        "no refresh cutoff stamped — the next rotation mints a fresh, "
        "untombstoned session and the reset is undone"
    )


async def test_admin_reset_revokes_every_existing_session(
    test_client: AsyncClient, db_session: AsyncSession, real_claims,
):
    user_id = await _seed(db_session, "reset-admin@example.com")
    access = await _login(test_client, "reset-admin@example.com")
    sid = decode_token(access)["sid"]

    res = await test_client.post(
        f"/api/v1/admin/users/{user_id}/reset-password",
        json={"new_password": _NEW_PASSWORD},
    )
    assert res.status_code == 200, res.text

    assert await get_revocation_service().is_revoked(sid)
    refreshed = await user_repo.get_user_by_id(db_session, user_id)
    assert refreshed.sessions_valid_from is not None


async def test_suspend_revokes_every_existing_session(
    test_client: AsyncClient, db_session: AsyncSession, real_claims,
):
    user_id = await _seed(db_session, "suspend-me@example.com")
    access = await _login(test_client, "suspend-me@example.com")
    sid = decode_token(access)["sid"]

    res = await test_client.post(f"/api/v1/admin/users/{user_id}/suspend")
    assert res.status_code == 200, res.text

    assert await get_revocation_service().is_revoked(sid)
