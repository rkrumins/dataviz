"""Phase 15 — redeeming an invite through SSO.

An invite used to mean one thing: choose a password. In a deployment with
``allow_local_login = false`` that asked the invitee to invent a password
login would refuse, and left them dependent on their IdP marking the
email verified for the account to be reachable at all.

The provider handshake proves who someone is; it knows nothing about the
invitation they were holding. So the invite rides through the SSO flow's
own ``next`` path and is settled by ``POST /auth/redeem-invite`` against
the session that handshake established. That split also keeps
``backend/auth_service`` free of the roles, groups and invite ledger that
live in ``backend/app`` — it may not import them, and this way it never
has to.
"""
from __future__ import annotations

import pytest
from httpx import AsyncClient

from backend.app.db.models import GroupORM, WorkspaceORM
from backend.app.db.repositories import binding_repo, group_repo, invite_repo


@pytest.fixture(autouse=True)
def _disable_rate_limit():
    from backend.app.api.v1.endpoints import auth as _auth_mod
    prev = _auth_mod.limiter.enabled
    _auth_mod.limiter.enabled = False
    yield
    _auth_mod.limiter.enabled = prev


# The conftest client is authenticated as this fixed user — standing in
# for whoever the SSO handshake just signed in.
SSO_USER_ID = "usr_test000000"
SSO_USER_EMAIL = "test@example.com"


async def _mint(test_client, **body):
    return await test_client.post("/api/v1/admin/users/invite", json=body)


async def _redeem(test_client, token):
    return await test_client.post(
        "/api/v1/auth/redeem-invite", json={"inviteToken": token},
    )


@pytest.mark.asyncio
async def test_redeeming_grants_the_role_and_lands_in_the_workspace(
    test_client: AsyncClient, db_session,
):
    db_session.add(WorkspaceORM(id="ws_sso", name="Finance"))
    await db_session.commit()

    minted = (await _mint(
        test_client, role="workspace_member", workspaceId="ws_sso",
    )).json()

    r = await _redeem(test_client, minted["inviteToken"])
    assert r.status_code == 200, r.text
    assert r.json()["applied"] is True
    assert r.json()["redirectTo"] == "/workspaces/ws_sso"

    bindings = await binding_repo.list_for_subject(
        db_session, subject_type="user", subject_id=SSO_USER_ID,
    )
    assert any(
        b.role_name == "workspace_member" and b.scope_id == "ws_sso"
        for b in bindings
    )


@pytest.mark.asyncio
async def test_redeeming_attaches_groups_and_spends_a_seat(
    test_client: AsyncClient, db_session,
):
    db_session.add(WorkspaceORM(id="ws_sso2", name="Ops"))
    db_session.add(GroupORM(id="grp_sso", name="Ops Team"))
    await db_session.commit()

    minted = (await _mint(
        test_client, role="workspace_member", workspaceId="ws_sso2",
        groupIds=["grp_sso"], allowShareableWithGroups=True, maxUses=2,
    )).json()

    assert (await _redeem(test_client, minted["inviteToken"])).status_code == 200

    assert "grp_sso" in await group_repo.get_user_groups(db_session, SSO_USER_ID)

    row = await invite_repo.get(db_session, minted["inviteId"])
    await db_session.refresh(row)
    assert row.use_count == 1

    history = await invite_repo.list_redemptions(db_session, minted["inviteId"])
    assert [h.user_id for h in history] == [SSO_USER_ID]


@pytest.mark.asyncio
async def test_an_account_that_already_has_access_is_not_regranted(
    test_client: AsyncClient, db_session,
):
    """An invite is an onboarding instrument. Letting a forwarded link
    add grants to an established account would turn every shareable
    invite into an escalation path — and it would diverge from the
    password route, which can only ever create a NEW account."""
    db_session.add(WorkspaceORM(id="ws_prior", name="Prior"))
    db_session.add(WorkspaceORM(id="ws_new", name="New"))
    await db_session.commit()
    await binding_repo.create_binding(
        db_session,
        subject_type="user", subject_id=SSO_USER_ID,
        role_name="workspace_viewer",
        scope_type="workspace", scope_id="ws_prior",
        granted_by=None,
    )
    await db_session.commit()

    minted = (await _mint(
        test_client, role="workspace_member", workspaceId="ws_new",
    )).json()

    r = await _redeem(test_client, minted["inviteToken"])
    assert r.status_code == 200, r.text
    assert r.json()["applied"] is False

    bindings = await binding_repo.list_for_subject(
        db_session, subject_type="user", subject_id=SSO_USER_ID,
    )
    assert not any(b.scope_id == "ws_new" for b in bindings)

    # And the seat was not spent on a no-op.
    row = await invite_repo.get(db_session, minted["inviteId"])
    await db_session.refresh(row)
    assert row.use_count == 0


@pytest.mark.asyncio
async def test_an_email_pin_is_enforced_on_the_sso_route_too(
    test_client: AsyncClient, db_session,
):
    """The pin governs the identity that arrives, whatever door it used."""
    minted = (await _mint(test_client, email="someone-else@example.com")).json()

    r = await _redeem(test_client, minted["inviteToken"])
    assert r.status_code == 400
    assert "different email" in r.json()["detail"]

    bindings = await binding_repo.list_for_subject(
        db_session, subject_type="user", subject_id=SSO_USER_ID,
    )
    assert bindings == []


@pytest.mark.asyncio
async def test_a_domain_restriction_is_enforced_on_the_sso_route_too(
    test_client: AsyncClient,
):
    minted = (await _mint(test_client, emailDomain="notourdomain.com")).json()

    r = await _redeem(test_client, minted["inviteToken"])
    assert r.status_code == 400
    assert "domain" in r.json()["detail"].lower()


@pytest.mark.asyncio
async def test_the_pinned_address_matching_the_signed_in_user_is_accepted(
    test_client: AsyncClient, db_session,
):
    db_session.add(WorkspaceORM(id="ws_pin", name="Pinned"))
    await db_session.commit()
    minted = (await _mint(
        test_client, role="workspace_member", workspaceId="ws_pin",
        email=SSO_USER_EMAIL,
    )).json()

    r = await _redeem(test_client, minted["inviteToken"])
    assert r.status_code == 200, r.text
    assert r.json()["applied"] is True


@pytest.mark.asyncio
async def test_revoked_expired_and_superseded_links_are_all_refused(
    test_client: AsyncClient, db_session,
):
    revoked = (await _mint(test_client)).json()
    await test_client.post(
        f"/api/v1/admin/users/invites/{revoked['inviteId']}/revoke"
    )
    r = await _redeem(test_client, revoked["inviteToken"])
    assert r.status_code == 400 and "revoked" in r.json()["detail"].lower()

    rotated = (await _mint(test_client)).json()
    await test_client.post(
        f"/api/v1/admin/users/invites/{rotated['inviteId']}/regenerate",
        json={"expiresInHours": 72},
    )
    r = await _redeem(test_client, rotated["inviteToken"])
    assert r.status_code == 400 and "replaced" in r.json()["detail"]


@pytest.mark.asyncio
async def test_the_kill_switch_covers_the_sso_route(test_client: AsyncClient):
    """A door added later must not become the one the switch forgot."""
    from backend.app.services import feature_flags as ff_mod

    minted = (await _mint(test_client)).json()
    original = ff_mod.feature_flags.is_enabled_self_session

    async def _off(key, default=False):
        return False if key == "inviteLinksEnabled" else await original(key, default=default)

    ff_mod.feature_flags.is_enabled_self_session = _off
    try:
        r = await _redeem(test_client, minted["inviteToken"])
    finally:
        ff_mod.feature_flags.is_enabled_self_session = original

    assert r.status_code == 400
    assert "turned off" in r.json()["detail"]


@pytest.mark.asyncio
async def test_a_garbage_token_is_refused(test_client: AsyncClient):
    r = await _redeem(test_client, "not-a-token")
    assert r.status_code == 400
