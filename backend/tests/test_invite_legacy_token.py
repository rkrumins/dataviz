"""Phase 15 — tokens minted before the invite ledger existed still work.

Every invite already in someone's inbox on deploy day is a bare signed
JWT with no ``jti`` and no row in ``invites``. Nothing can be looked up
for them, so they keep their original self-contained behaviour: the
payload is the grant, and there is no revocation or seat cap to apply.

This path retires itself — ``CreateInviteRequest.expires_in_hours`` is
capped at 2160 (90 days), so the last legacy token is dead 90 days
after this ships and the branch can be deleted. Until then this file is
the gate that stops it rotting.
"""
from __future__ import annotations

import pytest
from httpx import AsyncClient

from backend.app.db.repositories import binding_repo, user_repo
from backend.auth_service.core.tokens import create_invite_token


@pytest.fixture(autouse=True)
def _disable_signup_rate_limit():
    from backend.app.api.v1.endpoints import auth as _auth_mod
    prev = _auth_mod.limiter.enabled
    _auth_mod.limiter.enabled = False
    yield
    _auth_mod.limiter.enabled = prev


PW = "Sup3r-Str0ng-Pw!9"


async def _signup(test_client, *, email, token):
    return await test_client.post("/api/v1/auth/signup", json={
        "email": email, "password": PW,
        "firstName": "Legacy", "lastName": "User",
        "inviteToken": token,
    })


def test_a_token_minted_without_a_jti_has_no_jti():
    """Guards the omit-when-None behaviour that makes old tokens valid:
    if `jti` ever became unconditional, every outstanding invite would
    start resolving against a row that does not exist."""
    from backend.app.auth.jwt import decode_invite_token

    token, _ = create_invite_token(role=None, created_by="admin_1")
    assert "jti" not in decode_invite_token(token)


@pytest.mark.asyncio
async def test_legacy_token_still_verifies(test_client: AsyncClient):
    token, _ = create_invite_token(role=None, created_by="admin_1")

    r = await test_client.get(f"/api/v1/auth/verify-invite?token={token}")
    assert r.status_code == 200
    body = r.json()
    assert body["valid"] is True
    assert body["reason"] is None


@pytest.mark.asyncio
async def test_legacy_token_still_activates_and_grants_its_role(
    test_client: AsyncClient, db_session,
):
    from backend.app.db.models import WorkspaceORM

    db_session.add(WorkspaceORM(id="ws_legacy", name="Legacy"))
    await db_session.commit()

    token, _ = create_invite_token(
        role="workspace_member", created_by="admin_1", workspace_id="ws_legacy",
    )
    r = await _signup(test_client, email="legacy@example.com", token=token)
    assert r.status_code == 201, r.text

    user = await user_repo.get_user_by_email(db_session, "legacy@example.com")
    assert user.status == "active"

    bindings = await binding_repo.list_for_subject(
        db_session, subject_type="user", subject_id=user.id,
    )
    assert any(
        b.role_name == "workspace_member" and b.scope_id == "ws_legacy"
        for b in bindings
    )


@pytest.mark.asyncio
async def test_legacy_token_honours_its_email_pin(test_client: AsyncClient, db_session):
    token, _ = create_invite_token(
        role=None, created_by="admin_1", email="pinned@example.com",
    )

    wrong = await _signup(test_client, email="someone@example.com", token=token)
    assert wrong.status_code == 400
    assert await user_repo.get_user_by_email(db_session, "someone@example.com") is None

    right = await _signup(test_client, email="pinned@example.com", token=token)
    assert right.status_code == 201, right.text


@pytest.mark.asyncio
async def test_legacy_token_is_unlimited_and_unrevokable(
    test_client: AsyncClient, db_session,
):
    """Not a feature — a statement of the limitation. There is no row to
    cap or revoke, which is exactly why the ledger exists and why this
    branch has an expiry date."""
    token, _ = create_invite_token(role=None, created_by="admin_1")

    for i in range(3):
        r = await _signup(test_client, email=f"legacy-many{i}@example.com", token=token)
        assert r.status_code == 201


@pytest.mark.asyncio
async def test_a_signed_token_whose_row_is_gone_is_refused(
    test_client: AsyncClient, db_session,
):
    """A jti pointing at nothing is NOT treated as legacy. The token
    asserts a ledger row; if that row cannot be found the invite is
    unverifiable, and falling back to "trust the payload" would hand
    anyone who deleted a row an uncapped, unrevokable link."""
    token, _ = create_invite_token(
        role=None, created_by="admin_1", jti="inv_doesnotexist",
    )

    v = await test_client.get(f"/api/v1/auth/verify-invite?token={token}")
    assert v.json()["valid"] is False
    assert v.json()["reason"] == "invalid"

    r = await _signup(test_client, email="ghost@example.com", token=token)
    assert r.status_code == 400
    assert await user_repo.get_user_by_email(db_session, "ghost@example.com") is None
