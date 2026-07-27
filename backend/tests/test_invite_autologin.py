"""Phase 15 — an invited signup lands you inside the app, already signed in.

The invitee was pre-approved and pre-activated by the invite itself, so
bouncing them to a login form to retype the credentials they chose ten
seconds ago is friction that buys nothing.

Note what these tests can and cannot prove. The fixture wires the
IdentityService to the SAME session as the request (conftest), so the
explicit ``await session.commit()`` in ``_try_auto_sign_in`` is not
strictly required for them to pass — in production it is, because
``LocalIdentityService.login`` opens its own session and
``get_db_session`` commits only after the handler returns. That
asymmetry is exactly the kind of bug that ships green, so
``test_the_commit_before_login_is_not_accidental`` pins the ordering
directly rather than relying on behaviour the fixture papers over.
"""
from __future__ import annotations

import inspect

import pytest
from httpx import AsyncClient

from backend.app.db.repositories import user_repo

# Captured at import (collection time, before any test can rebind the
# module attribute) so the source assertion at the bottom of this file
# reads the real function rather than whatever a neighbouring test
# happened to leave in its place.
from backend.app.api.v1.endpoints.auth import (
    _try_auto_sign_in as _AUTO_SIGN_IN_AT_IMPORT,
)


@pytest.fixture(autouse=True)
def _disable_signup_rate_limit():
    from backend.app.api.v1.endpoints import auth as _auth_mod
    prev = _auth_mod.limiter.enabled
    _auth_mod.limiter.enabled = False
    yield
    _auth_mod.limiter.enabled = prev


PW = "Sup3r-Str0ng-Pw!9"


async def _mint(test_client, **body):
    return await test_client.post("/api/v1/admin/users/invite", json=body)


async def _signup(test_client, *, email, token=None):
    body = {
        "email": email, "password": PW,
        "firstName": "Auto", "lastName": "User",
    }
    if token:
        body["inviteToken"] = token
    return await test_client.post("/api/v1/auth/signup", json=body)


# ── the happy path ───────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_invited_signup_returns_a_session(test_client: AsyncClient, db_session):
    token = (await _mint(test_client)).json()["inviteToken"]

    r = await _signup(test_client, email="landed@example.com", token=token)
    assert r.status_code == 201, r.text

    body = r.json()
    assert body["autoSignedIn"] is True
    assert body["user"]["email"] == "landed@example.com"
    assert body["redirectTo"] == "/"

    # The three session cookies, same as a real login.
    names = {c for c in r.cookies}
    assert any("access" in n for n in names), names
    assert any("refresh" in n for n in names), names
    assert any("csrf" in n for n in names), names


@pytest.mark.asyncio
async def test_the_issued_session_actually_authenticates(test_client: AsyncClient):
    """A cookie that does not work is worse than no cookie."""
    token = (await _mint(test_client)).json()["inviteToken"]
    await _signup(test_client, email="works@example.com", token=token)

    me = await test_client.get("/api/v1/auth/me")
    assert me.status_code == 200, me.text
    assert me.json()["user"]["email"] == "works@example.com"


@pytest.mark.asyncio
async def test_a_workspace_invite_lands_you_in_that_workspace(
    test_client: AsyncClient, db_session,
):
    from backend.app.db.models import WorkspaceORM

    db_session.add(WorkspaceORM(id="ws_land", name="Landing"))
    await db_session.commit()

    token = (await _mint(
        test_client, role="workspace_member", workspaceId="ws_land",
    )).json()["inviteToken"]

    r = await _signup(test_client, email="scoped@example.com", token=token)
    assert r.json()["redirectTo"] == "/workspaces/ws_land"


# ── who must NOT get a session ───────────────────────────────────────


@pytest.mark.asyncio
async def test_an_uninvited_signup_is_never_signed_in(test_client: AsyncClient):
    """A self-registered account is `pending` and unapproved. Handing it
    a session would let it in before an admin had looked at it."""
    from backend.app.services import feature_flags as ff_mod

    original = ff_mod.feature_flags.is_enabled_self_session

    async def _stub(key: str, default: bool = False) -> bool:
        return True if key == "signupEnabled" else await original(key, default=default)

    ff_mod.feature_flags.is_enabled_self_session = _stub
    try:
        r = await _signup(test_client, email="stranger@example.com")
    finally:
        ff_mod.feature_flags.is_enabled_self_session = original

    assert r.status_code == 201, r.text
    body = r.json()
    assert body["autoSignedIn"] is False
    assert body["user"] is None
    assert "Awaiting administrator approval" in body["message"]
    assert not any("access" in c for c in r.cookies)


@pytest.mark.asyncio
async def test_a_refused_invite_creates_nothing_and_signs_in_nobody(
    test_client: AsyncClient, db_session,
):
    minted = (await _mint(test_client)).json()
    await test_client.post(f"/api/v1/admin/users/invites/{minted['inviteId']}/revoke")

    r = await _signup(test_client, email="nope@example.com", token=minted["inviteToken"])
    assert r.status_code == 400
    assert not any("access" in c for c in r.cookies)
    assert await user_repo.get_user_by_email(db_session, "nope@example.com") is None


# ── degrading gracefully ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_the_account_still_exists_when_auto_sign_in_fails(
    test_client: AsyncClient, db_session, monkeypatch,
):
    """SSO-only deployments refuse local login by design, and any other
    failure here is a convenience we can drop. What must never happen is
    losing the account — the invite has been consumed by then."""
    from backend.app.api.v1.endpoints import auth as auth_mod

    token = (await _mint(test_client)).json()["inviteToken"]

    async def _boom(*a, **kw):
        return False

    # monkeypatch, not manual save/restore: a rebinding that outlives the
    # test would poison every later signup in the run.
    monkeypatch.setattr(auth_mod, "_try_auto_sign_in", _boom)
    r = await _signup(test_client, email="degraded@example.com", token=token)

    assert r.status_code == 201, r.text
    assert r.json()["autoSignedIn"] is False
    assert "can now sign in" in r.json()["message"]

    user = await user_repo.get_user_by_email(db_session, "degraded@example.com")
    assert user is not None and user.status == "active"


def test_the_commit_before_login_is_not_accidental():
    """``login`` opens its own session; ``get_db_session`` commits only
    after the handler returns. Drop this commit and invited signups fail
    in production while the suite stays green — the fixture shares one
    session, so no behavioural test here can catch it. Pin the source.
    """
    src = inspect.getsource(_AUTO_SIGN_IN_AT_IMPORT)
    commit_at = src.index("await session.commit()")
    login_at = src.index("svc.login(")
    assert commit_at < login_at, (
        "session.commit() must precede svc.login(), or the login runs against "
        "a connection that cannot see the user just created"
    )
