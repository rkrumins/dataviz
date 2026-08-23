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

Refused outright on the self-service path — the person redeeming a token
is not the person who should be deciding an org's auth posture — and
gated behind an explicit, audited flag on the admin path, because
retiring SSO is a real thing organisations do.
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
        json={"token": token, "new_password": "An0ther!Str0ngPass#"},
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
        json={"token": token, "new_password": "An0ther!Str0ngPass#"},
    )
    assert res.status_code == 200, res.text


# ── Admin ────────────────────────────────────────────────────────────

async def test_admin_reset_is_refused_for_an_sso_only_account_by_default(
    test_client: AsyncClient, db_session: AsyncSession,
):
    user_id = await _sso_only_user(db_session, "fed-admin@corp.example")

    res = await test_client.post(
        f"/api/v1/admin/users/{user_id}/reset-password",
        json={"newPassword": "An0ther!Str0ngPass#"},
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
            "newPassword": "An0ther!Str0ngPass#",
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
            "newPassword": "An0ther!Str0ngPass#",
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
        json={"newPassword": "An0ther!Str0ngPass#"},
    )
    assert res.status_code == 200, res.text
