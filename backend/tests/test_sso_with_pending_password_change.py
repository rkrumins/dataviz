"""An account that signs in both ways, with its local password pending a change.

At an organisation that runs single sign-on, most people sign in through the
identity provider nearly every day. Some also hold a local password: one an
administrator set for them, or the starting password of a built-in
administrator who is linked to the IdP too. When that password has to be
replaced, the requirement is about the password — a session signed in WITH
it is held until it is changed, and a session signed in through the IdP
carries on, through every rotation, without being sent to the change screen.
"""
from __future__ import annotations

import secrets
from contextlib import asynccontextmanager

import pytest
from httpx import AsyncClient

from backend.app.auth.dependencies import (
    get_current_user, get_optional_user, get_permission_claims,
)
from backend.app.auth.password import hash_password
from backend.app.db.repositories import idp_provider_repo, user_identity_repo, user_repo
from backend.app.db.repositories.refresh_token_repo import make_refresh_store
from backend.auth_service.cookies import (
    ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME, REFRESH_COOKIE_NAME,
)
from backend.auth_service.core.tokens import decode_token
from backend.auth_service.csrf import CSRF_HEADER_NAME
from backend.auth_service.providers.base import ProviderIdentity
from backend.auth_service.service import LocalIdentityService

_EMAIL = "dana@example.com"
# Generated, not written down: nothing in the repository should look like a
# credential, even a test one.
_ADMIN_SET = "Aa1!" + secrets.token_urlsafe(18)


def _identity() -> ProviderIdentity:
    return ProviderIdentity(
        provider="oidc", external_id="dana-sub", email=_EMAIL,
        first_name="Dana", last_name="Scully",
        raw_claims={"email_verified": True},
    )


@pytest.fixture()
async def provider(db_session):
    row = await idp_provider_repo.create_provider(
        db_session, slug="corp-oidc", display_name="Corporate", kind="oidc",
        settings={
            "issuer": "https://idp.example.com", "client_id": "c",
            "client_secret": "s", "redirect_uri": "https://app/cb",
            "scopes": "openid email",
        },
        claim_mapping={}, linking_policy="strict",
    )
    await db_session.flush()
    return row


@pytest.fixture()
def svc(db_session):
    @asynccontextmanager
    async def _factory():
        yield db_session

    return LocalIdentityService(
        session_factory=_factory,
        user_repo=user_repo,
        user_identity_repo=user_identity_repo,
        refresh_store_factory=make_refresh_store,
        claims_resolver=None,
    )


@pytest.fixture()
async def dana(svc, provider, db_session):
    """Signs in with SSO; an administrator has since set her a password."""
    user, _ = await svc.complete_sso_login(
        _identity(), provider_id=provider.id, provider_slug=provider.slug,
        linking_policy="strict",
    )
    await user_repo.update_password(
        db_session, user.id, hash_password(_ADMIN_SET), must_change=True,
    )
    await db_session.commit()
    return user


async def _sso_session(svc, provider):
    return await svc.complete_sso_login(
        _identity(), provider_id=provider.id, provider_slug=provider.slug,
        linking_policy="strict",
    )


# ── What the sessions carry ──────────────────────────────────────────

async def test_signing_in_through_the_idp_is_not_held(svc, provider, dana):
    _, tokens = await _sso_session(svc, provider)
    claims = decode_token(tokens.access_token)
    assert claims["signin"] == "sso"
    assert "mcp" not in claims


async def test_signing_in_with_the_password_is_held(svc, dana):
    _, tokens = await svc.login(_EMAIL, _ADMIN_SET)
    claims = decode_token(tokens.access_token)
    assert claims["signin"] == "password"
    assert claims["mcp"] is True


async def test_rotation_keeps_the_way_each_session_signed_in(svc, provider, dana):
    _, sso = await _sso_session(svc, provider)
    _, password = await svc.login(_EMAIL, _ADMIN_SET)

    _, sso_next = await svc.refresh(sso.refresh_token)
    _, password_next = await svc.refresh(password.refresh_token)

    assert decode_token(sso_next.access_token)["signin"] == "sso"
    assert "mcp" not in decode_token(sso_next.access_token)
    assert decode_token(password_next.access_token)["signin"] == "password"
    assert decode_token(password_next.access_token)["mcp"] is True


# ── Through the API ──────────────────────────────────────────────────

@pytest.fixture()
async def app_client(test_client: AsyncClient, svc):
    """The real sign-in checks, and an identity service that knows SSO."""
    from backend.app.main import app

    for dep in (get_current_user, get_optional_user, get_permission_claims):
        app.dependency_overrides.pop(dep, None)
    previous = app.state.identity_service
    app.state.identity_service = svc
    yield test_client
    app.state.identity_service = previous


def _use_session(client: AsyncClient, tokens) -> None:
    for name in (ACCESS_COOKIE_NAME, REFRESH_COOKIE_NAME, CSRF_COOKIE_NAME):
        client.cookies.delete(name)
    client.cookies.set(ACCESS_COOKIE_NAME, tokens.access_token)
    client.cookies.set(REFRESH_COOKIE_NAME, tokens.refresh_token)
    client.cookies.set(CSRF_COOKIE_NAME, tokens.csrf_token)
    client.headers[CSRF_HEADER_NAME] = tokens.csrf_token


async def test_an_sso_session_works_and_is_not_sent_to_the_change_screen(
    app_client, svc, provider, dana,
):
    _, tokens = await _sso_session(svc, provider)
    _use_session(app_client, tokens)

    me = await app_client.get("/api/v1/auth/me")
    assert me.status_code == 200, me.text
    assert me.json()["passwordChangeRequired"] is False
    # The account's own flag still says the local password is pending.
    assert me.json()["user"]["mustChangePassword"] is True

    activity = await app_client.get("/api/v1/users/me/activity")
    assert activity.status_code == 200, activity.text


async def test_a_password_session_of_the_same_account_is_held(app_client, dana):
    signed_in = await app_client.post(
        "/api/v1/auth/login", json={"email": _EMAIL, "password": _ADMIN_SET},
    )
    assert signed_in.status_code == 200, signed_in.text
    assert signed_in.json()["passwordChangeRequired"] is True
    app_client.cookies.delete(CSRF_COOKIE_NAME)
    app_client.cookies.set(CSRF_COOKIE_NAME, signed_in.cookies[CSRF_COOKIE_NAME])
    app_client.headers[CSRF_HEADER_NAME] = signed_in.cookies[CSRF_COOKIE_NAME]

    held = await app_client.get("/api/v1/users/me/activity")
    assert held.status_code == 403
    assert held.json()["detail"]["error"] == "password_change_required"


async def test_the_password_can_be_replaced_from_an_sso_session(
    app_client, svc, provider, dana, db_session,
):
    """The way to clear it without ever signing in with it."""
    _, tokens = await _sso_session(svc, provider)
    _use_session(app_client, tokens)

    changed = await app_client.post("/api/v1/users/me/password", json={
        "currentPassword": _ADMIN_SET, "newPassword": "Bb2@" + secrets.token_urlsafe(18),
    })
    assert changed.status_code == 200, changed.text
    await db_session.refresh(await user_repo.get_user_by_id(db_session, dana.id))
    assert (await user_repo.get_user_by_id(db_session, dana.id)).must_change_password is False
