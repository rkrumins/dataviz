"""H1 regression: the ``allowLocalLogin=false`` self-lockout guard must
identify admins via the canonical ``role_bindings`` table (Phase 5+), not
the legacy ``user_roles`` row with ``role_name='admin'`` (which no longer
exists after the ``admin`` -> ``super_admin`` rename).

Before the fix, ``_admins_without_sso_identity`` matched zero users, so an
operator could disable local login with no SSO-linked super-admin and lock
everyone out. These tests pin the corrected behaviour.
"""
import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db import models as m


PATCH_PATH = "/api/v1/admin/sso/config"


async def _seed_super_admin(
    session: AsyncSession, *, user_id: str, email: str, with_identity: bool
) -> None:
    """Create an active super-admin bound via ``role_bindings`` (global),
    optionally with a linked SSO identity."""
    session.add(m.UserORM(
        id=user_id, email=email, password_hash="x",
        first_name="A", last_name="Dmin", status="active",
        created_at="2024-01-01T00:00:00Z", updated_at="2024-01-01T00:00:00Z",
    ))
    session.add(m.RoleBindingORM(
        id=f"bnd_{user_id}", subject_type="user", subject_id=user_id,
        role_name="super_admin", scope_type="global", scope_id=None,
        granted_at="2024-01-01T00:00:00Z", source="local",
    ))
    if with_identity:
        session.add(m.IdpProviderORM(
            id="idp_test01", slug="entra", display_name="Entra",
            kind="oidc", enabled=True,
        ))
        session.add(m.UserIdentityORM(
            id=f"uid_{user_id}", user_id=user_id, provider_id="idp_test01",
            external_id=f"ext_{user_id}", email_at_link=email,
        ))
    await session.commit()


@pytest.mark.asyncio
async def test_disabling_local_login_blocked_when_admin_lacks_sso(
    test_client: AsyncClient, db_session: AsyncSession
):
    await _seed_super_admin(
        db_session, user_id="usr_admin_no_sso",
        email="nosso@example.com", with_identity=False,
    )

    resp = await test_client.patch(PATCH_PATH, json={"allowLocalLogin": False})

    assert resp.status_code == 409, resp.text
    body = resp.json()["detail"]
    assert body["error"] == "would_lock_out_admin"
    offending_ids = {a["id"] for a in body["adminsWithoutSso"]}
    assert "usr_admin_no_sso" in offending_ids


@pytest.mark.asyncio
async def test_disabling_local_login_allowed_when_admin_has_sso(
    test_client: AsyncClient, db_session: AsyncSession
):
    await _seed_super_admin(
        db_session, user_id="usr_admin_sso",
        email="sso@example.com", with_identity=True,
    )

    resp = await test_client.patch(PATCH_PATH, json={"allowLocalLogin": False})

    assert resp.status_code == 200, resp.text
    assert resp.json()["allowLocalLogin"] is False


@pytest.mark.asyncio
async def test_system_account_admin_does_not_block_enforcement(
    test_client: AsyncClient, db_session: AsyncSession
):
    """A super-admin with no SSO identity but marked as a system account
    cannot be locked out by the switch — it keeps password sign-in — so
    the guard must not count it. Without this exemption a deployment
    whose only local admin is the seeded bootstrap account could never
    enforce SSO at all."""
    await _seed_super_admin(
        db_session, user_id="usr_admin_system",
        email="system@example.com", with_identity=False,
    )
    from backend.app.db.repositories import user_repo
    await user_repo.set_system_account(db_session, "usr_admin_system", True)
    await db_session.commit()

    resp = await test_client.patch(PATCH_PATH, json={"allowLocalLogin": False})

    assert resp.status_code == 200, resp.text
    assert resp.json()["allowLocalLogin"] is False
