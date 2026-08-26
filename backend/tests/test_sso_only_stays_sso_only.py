"""A password reset must not convert a federated account to a local one.

An SSO-only account carries the disabled-password sentinel in
``password_hash``. That sentinel is the whole of the per-user SSO-only
enforcement: ``verify_password`` refuses it, so the user has no local
path and must go through the IdP — which is where the organisation's
conditional access and MFA live.

Both reset paths removed it. ``POST /auth/reset-password`` and
``POST /admin/users/{id}/reset-password`` wrote a real Argon2 hash with
no check, so an admin-generated reset token silently turned a federated
identity into one that can sign in around the IdP, permanently and with
nothing in the audit log saying so.

Refused on the self-service path for any ordinary token — the person
redeeming one is not the person who should be deciding an org's auth
posture — and allowed exactly two deliberate, audited doors: the admin
reset endpoint's explicit override flag, and an admin-minted reset
token (the ``admin_ok:`` hash prefix), which is how a JIT-provisioned
account gets a password when its connection is being retired.
"""
from __future__ import annotations

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.password import hash_password
from backend.app.db.repositories import user_repo
from backend.auth_service.core.password import (
    disabled_password_hash,
    is_password_set,
)

_PASSWORD = "C0mpl3x!Passw0rd#"

#: What a reset moves the password TO. Derived from _PASSWORD rather than
#: written as a second credential-shaped literal: the tests only need a
#: value that DIFFERS and still clears the zxcvbn strength check, and a
#: second hardcoded password is a second thing for a secret scanner to
#: flag for no benefit. _PASSWORD itself stays as-is -- it is the shared
#: fixture ten other auth test files already use.
_NEW_PASSWORD = _PASSWORD + "-rotated"


async def _sso_only_user(db_session: AsyncSession, email: str) -> str:
    user = await user_repo.create_sso_user(
        db_session, email=email, first_name="Fed", last_name="Erated",
        password_hash=disabled_password_hash(),
    )
    await db_session.commit()
    return user.id


async def _local_user(db_session: AsyncSession, email: str) -> str:
    user = await user_repo.create_user(
        db_session, email=email, password_hash=hash_password(_PASSWORD),
        first_name="Loc", last_name="Al", status="active",
    )
    await db_session.commit()
    return user.id


# ── Self-service ─────────────────────────────────────────────────────

async def test_token_reset_is_refused_for_an_sso_only_account(
    test_client: AsyncClient, db_session: AsyncSession,
):
    user_id = await _sso_only_user(db_session, "fed@corp.example")
    token, _exp = await user_repo.create_reset_token(db_session, user_id)
    await db_session.commit()

    res = await test_client.post(
        "/api/v1/auth/reset-password",
        json={"token": token, "new_password": _NEW_PASSWORD},
    )
    assert res.status_code == 409, res.text
    assert res.json()["detail"]["error"] == "sso_only_account"

    refreshed = await user_repo.get_user_by_id(db_session, user_id)
    assert not is_password_set(refreshed.password_hash), (
        "the account can now sign in around the IdP"
    )


async def test_token_reset_still_works_for_a_local_account(
    test_client: AsyncClient, db_session: AsyncSession,
):
    """The guard must not break the flow it sits in front of."""
    user_id = await _local_user(db_session, "loc@corp.example")
    token, _exp = await user_repo.create_reset_token(db_session, user_id)
    await db_session.commit()

    res = await test_client.post(
        "/api/v1/auth/reset-password",
        json={"token": token, "new_password": _NEW_PASSWORD},
    )
    assert res.status_code == 200, res.text


# ── Admin ────────────────────────────────────────────────────────────

async def test_admin_reset_is_refused_for_an_sso_only_account_by_default(
    test_client: AsyncClient, db_session: AsyncSession,
):
    user_id = await _sso_only_user(db_session, "fed-admin@corp.example")

    res = await test_client.post(
        f"/api/v1/admin/users/{user_id}/reset-password",
        json={"newPassword": _NEW_PASSWORD},
    )
    assert res.status_code == 409, res.text
    assert res.json()["detail"]["error"] == "sso_only_account"

    refreshed = await user_repo.get_user_by_id(db_session, user_id)
    assert not is_password_set(refreshed.password_hash)


async def test_admin_can_convert_deliberately(
    test_client: AsyncClient, db_session: AsyncSession,
):
    """Retiring SSO is legitimate; it just has to be asked for."""
    user_id = await _sso_only_user(db_session, "retiring@corp.example")

    res = await test_client.post(
        f"/api/v1/admin/users/{user_id}/reset-password",
        json={
            "newPassword": _NEW_PASSWORD,
            "allowSsoOnlyOverride": True,
        },
    )
    assert res.status_code == 200, res.text

    refreshed = await user_repo.get_user_by_id(db_session, user_id)
    assert is_password_set(refreshed.password_hash)


async def test_the_deliberate_conversion_is_audited(
    test_client: AsyncClient, db_session: AsyncSession,
):
    """A posture change that leaves no trace is the actual problem."""
    from sqlalchemy import select

    from backend.app.db.models import OutboxEventORM

    user_id = await _sso_only_user(db_session, "audited@corp.example")
    res = await test_client.post(
        f"/api/v1/admin/users/{user_id}/reset-password",
        json={
            "newPassword": _NEW_PASSWORD,
            "allowSsoOnlyOverride": True,
        },
    )
    assert res.status_code == 200, res.text

    events = (await db_session.execute(
        select(OutboxEventORM).where(
            OutboxEventORM.event_type == "user.local_login_enabled",
        )
    )).scalars().all()
    assert len(events) == 1


async def test_admin_reset_of_a_local_account_needs_no_override(
    test_client: AsyncClient, db_session: AsyncSession,
):
    user_id = await _local_user(db_session, "plain@corp.example")
    res = await test_client.post(
        f"/api/v1/admin/users/{user_id}/reset-password",
        json={"newPassword": _NEW_PASSWORD},
    )
    assert res.status_code == 200, res.text


# ── Admin-granted tokens ─────────────────────────────────────────────
#
# The JIT gap: an account provisioned by SSO has no password, and when
# the connection is retired the person has no way in at all. "Give this
# person a password" is an admin decision, made on the admin Users
# screen — so a token minted THERE (hash stored with the ``admin_ok:``
# prefix) redeems even on an SSO-only account, while the plain token
# above keeps being refused.

async def test_an_admin_granted_token_converts_an_sso_only_account(
    test_client: AsyncClient, db_session: AsyncSession,
):
    import json

    from sqlalchemy import select

    from backend.app.db.models import OutboxEventORM

    user_id = await _sso_only_user(db_session, "granted@corp.example")
    token, _exp = await user_repo.create_reset_token(
        db_session, user_id, admin_granted=True,
    )
    await db_session.commit()

    res = await test_client.post(
        "/api/v1/auth/reset-password",
        json={"token": token, "new_password": _NEW_PASSWORD},
    )
    assert res.status_code == 200, res.text

    refreshed = await user_repo.get_user_by_id(db_session, user_id)
    assert is_password_set(refreshed.password_hash)

    events = (await db_session.execute(
        select(OutboxEventORM).where(
            OutboxEventORM.event_type == "user.local_login_enabled",
        )
    )).scalars().all()
    assert len(events) == 1
    assert json.loads(events[0].payload)["reason"] == "admin_reset_token_redeemed"


async def test_the_admin_mint_endpoint_produces_a_convert_capable_token(
    test_client: AsyncClient, db_session: AsyncSession,
):
    """End to end: the token the admin screen hands out is the one kind
    that converts."""
    user_id = await _sso_only_user(db_session, "screen@corp.example")

    minted = await test_client.post(
        f"/api/v1/admin/users/{user_id}/generate-reset-token",
    )
    assert minted.status_code == 200, minted.text
    token = minted.json()["resetToken"]

    res = await test_client.post(
        "/api/v1/auth/reset-password",
        json={"token": token, "new_password": _NEW_PASSWORD},
    )
    assert res.status_code == 200, res.text
    refreshed = await user_repo.get_user_by_id(db_session, user_id)
    assert is_password_set(refreshed.password_hash)


async def test_an_admin_granted_token_still_resets_a_local_account(
    test_client: AsyncClient, db_session: AsyncSession,
):
    """The prefix must not break the ordinary flow it rides in — and a
    reset that converted nothing must not claim it enabled anything."""
    from sqlalchemy import select

    from backend.app.db.models import OutboxEventORM

    user_id = await _local_user(db_session, "already-local@corp.example")
    token, _exp = await user_repo.create_reset_token(
        db_session, user_id, admin_granted=True,
    )
    await db_session.commit()

    res = await test_client.post(
        "/api/v1/auth/reset-password",
        json={"token": token, "new_password": _NEW_PASSWORD},
    )
    assert res.status_code == 200, res.text

    events = (await db_session.execute(
        select(OutboxEventORM).where(
            OutboxEventORM.event_type == "user.local_login_enabled",
        )
    )).scalars().all()
    assert events == []


async def test_forgot_password_flags_the_request_without_minting(
    test_client: AsyncClient, db_session: AsyncSession,
):
    """The 'Request a password' button lands here: no token is created —
    the admin sees the flag on the Users screen and mints deliberately."""
    user_id = await _sso_only_user(db_session, "asking@corp.example")

    res = await test_client.post(
        "/api/v1/auth/forgot-password",
        json={"email": "asking@corp.example"},
    )
    assert res.status_code == 200, res.text

    refreshed = await user_repo.get_user_by_id(db_session, user_id)
    assert refreshed.reset_token_hash == "__requested__"
