"""SSO find-or-provision + identity-linking guardrails (Phase 3).

Exercises ``LocalIdentityService.complete_sso_login`` directly with a
verified ``ProviderIdentity`` (no IdP/network) against the per-test
SQLite DB. Phase 3 split SSO identity off the user row into the
``user_identities`` table — these tests assert the multi-identity
behaviour and the four ``linking_policy`` values.
"""
from __future__ import annotations

from contextlib import asynccontextmanager

import pytest

from backend.app.db.models import IdpProviderORM, UserIdentityORM
from backend.app.db.repositories import (
    idp_provider_repo,
    user_identity_repo,
    user_repo,
)
from backend.auth_service.interface import SSOAuthError
from backend.auth_service.providers.base import ProviderIdentity
from backend.auth_service.service import LocalIdentityService


def _identity(**over) -> ProviderIdentity:
    base = dict(
        provider="oidc",
        external_id="sub-1",
        email="alice@example.com",
        first_name="Alice",
        last_name="Smith",
        raw_claims={"email_verified": True},
    )
    base.update(over)
    return ProviderIdentity(**base)


@pytest.fixture()
async def provider(db_session):
    """Default OIDC provider used by the SSO login tests."""
    row = await idp_provider_repo.create_provider(
        db_session,
        slug="test-oidc",
        display_name="Test OIDC",
        kind="oidc",
        settings={
            "issuer": "https://idp.example.com",
            "client_id": "c", "client_secret": "s",
            "redirect_uri": "https://app/cb", "scopes": "openid email",
        },
        claim_mapping={},
        linking_policy="strict",
    )
    await db_session.flush()
    return row


@pytest.fixture()
def svc_and_events(db_session):
    events: list[tuple[str, dict]] = []

    @asynccontextmanager
    async def _factory():
        # Reuse the test session; the fixture owns commit/rollback.
        yield db_session

    async def _outbox(session, event_type, payload):
        events.append((event_type, payload))

    svc = LocalIdentityService(
        session_factory=_factory,
        user_repo=user_repo,
        user_identity_repo=user_identity_repo,
        refresh_store_factory=lambda s: None,
        outbox_emit=_outbox,
        claims_resolver=None,
    )
    return svc, events


async def _seed_local_user(db_session, *, email, status="active"):
    user = await user_repo.create_user(
        db_session,
        email=email,
        password_hash="argon2-placeholder",
        first_name="Local",
        last_name="User",
        status=status,
    )
    await db_session.flush()
    return user


# ── Provisioning + reuse ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_provisions_new_subject(svc_and_events, provider, db_session):
    svc, events = svc_and_events
    user, tokens = await svc.complete_sso_login(
        _identity(), provider_id=provider.id,
        provider_slug=provider.slug, linking_policy="strict",
    )

    assert user.email == "alice@example.com"
    identity = await user_identity_repo.get_by_subject(
        db_session, provider_id=provider.id, external_id="sub-1",
    )
    assert identity is not None
    assert identity.user_id == user.id
    assert tokens.access_token and tokens.refresh_token
    types = [e[0] for e in events]
    assert "user.sso_provisioned" in types
    assert "user.logged_in" in types


@pytest.mark.asyncio
async def test_returning_subject_is_reused(svc_and_events, provider, db_session):
    svc, events = svc_and_events
    existing_user = await user_repo.create_sso_user(
        db_session,
        email="bob@example.com",
        first_name="Bob",
        last_name="B",
        password_hash="x-disabled-password-x",
    )
    await user_identity_repo.create_identity(
        db_session,
        user_id=existing_user.id, provider_id=provider.id,
        external_id="sub-9", email_at_link="bob@example.com",
    )
    await db_session.flush()

    user, _ = await svc.complete_sso_login(
        _identity(external_id="sub-9", email="bob@example.com"),
        provider_id=provider.id, provider_slug=provider.slug,
    )
    assert user.id == existing_user.id
    types = [e[0] for e in events]
    assert "user.sso_provisioned" not in types


# ── Linking guardrails ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_strict_auto_links_verified_active_local(
    svc_and_events, provider, db_session,
):
    svc, events = svc_and_events
    local = await _seed_local_user(db_session, email="carol@example.com")

    user, _ = await svc.complete_sso_login(
        _identity(external_id="sub-c", email="carol@example.com",
                  raw_claims={"email_verified": True}),
        provider_id=provider.id, provider_slug=provider.slug,
        linking_policy="strict",
    )

    assert user.id == local.id
    # Identity row was added; password hash on UserORM is unchanged
    # in Phase 3 (linked accounts keep their password).
    identity = await user_identity_repo.get_by_subject(
        db_session, provider_id=provider.id, external_id="sub-c",
    )
    assert identity is not None
    assert "user.sso_linked" in [e[0] for e in events]


@pytest.mark.asyncio
async def test_strict_rejects_unverified_email(svc_and_events, provider, db_session):
    svc, events = svc_and_events
    await _seed_local_user(db_session, email="dave@example.com")

    with pytest.raises(SSOAuthError):
        await svc.complete_sso_login(
            _identity(external_id="sub-d", email="dave@example.com",
                      raw_claims={"email_verified": False}),
            provider_id=provider.id, provider_slug=provider.slug,
            linking_policy="strict",
        )
    denied = [e for e in events if e[0] == "user.sso_link_denied"]
    assert denied
    assert "email_unverified" in denied[0][1]["deny_reasons"]


@pytest.mark.asyncio
async def test_strict_rejects_inactive_local(svc_and_events, provider, db_session):
    svc, events = svc_and_events
    await _seed_local_user(db_session, email="erin@example.com", status="pending")
    with pytest.raises(SSOAuthError):
        await svc.complete_sso_login(
            _identity(external_id="sub-e", email="erin@example.com",
                      raw_claims={"email_verified": True}),
            provider_id=provider.id, provider_slug=provider.slug,
            linking_policy="strict",
        )
    assert "user.sso_link_denied" in [e[0] for e in events]


@pytest.mark.asyncio
async def test_manual_only_rejects_all_collisions(
    svc_and_events, provider, db_session,
):
    """Even with email_verified=true, manual_only refuses the link."""
    svc, events = svc_and_events
    await _seed_local_user(db_session, email="mike@example.com")

    with pytest.raises(SSOAuthError):
        await svc.complete_sso_login(
            _identity(external_id="sub-m", email="mike@example.com",
                      raw_claims={"email_verified": True}),
            provider_id=provider.id, provider_slug=provider.slug,
            linking_policy="manual_only",
        )
    denied = [e for e in events if e[0] == "user.sso_link_denied"]
    assert denied and "policy:manual_only" in denied[0][1]["deny_reasons"]


@pytest.mark.asyncio
async def test_allow_verified_stacks_on_existing_sso(
    svc_and_events, provider, db_session,
):
    """allow_verified lets the second IdP link to a user who already
    has one SSO identity."""
    svc, events = svc_and_events
    other_provider = await idp_provider_repo.create_provider(
        db_session, slug="other-oidc", display_name="Other",
        kind="oidc", settings={"issuer": "https://other"},
        claim_mapping={}, linking_policy="strict",
    )
    # Seed a local user already linked to the FIRST provider.
    base = await _seed_local_user(db_session, email="nina@example.com")
    await user_identity_repo.create_identity(
        db_session, user_id=base.id, provider_id=provider.id,
        external_id="sub-n-first", email_at_link="nina@example.com",
    )
    await db_session.flush()

    # Now the second provider asserts the same email. Strict would
    # refuse (existing_has_identity); allow_verified accepts.
    user, _ = await svc.complete_sso_login(
        _identity(external_id="sub-n-second", email="nina@example.com",
                  raw_claims={"email_verified": True}),
        provider_id=other_provider.id, provider_slug=other_provider.slug,
        linking_policy="allow_verified",
    )
    assert user.id == base.id
    # Both identities now point at the same user.
    ids = await user_identity_repo.list_for_user(db_session, base.id)
    assert {i.provider_id for i in ids} == {provider.id, other_provider.id}


@pytest.mark.asyncio
async def test_inactive_sso_account_rejected(svc_and_events, provider, db_session):
    svc, _ = svc_and_events
    user = await user_repo.create_sso_user(
        db_session, email="frank@example.com",
        first_name="F", last_name="K",
        password_hash="x-disabled-password-x",
    )
    await user_identity_repo.create_identity(
        db_session, user_id=user.id, provider_id=provider.id,
        external_id="sub-f", email_at_link="frank@example.com",
    )
    user.status = "suspended"
    await db_session.flush()
    with pytest.raises(SSOAuthError):
        await svc.complete_sso_login(
            _identity(external_id="sub-f", email="frank@example.com"),
            provider_id=provider.id, provider_slug=provider.slug,
        )


# ── Link-intent flow (self-service) ─────────────────────────────────


@pytest.mark.asyncio
async def test_link_intent_binds_subject_to_intent_user(
    svc_and_events, provider, db_session,
):
    svc, events = svc_and_events
    # The user is already authenticated (e.g. via password). They
    # kicked off /me/identities/link/{slug}/start which set a signed
    # cookie carrying their user_id; the route hands link_intent_user_id
    # to complete_sso_login. The IdP then asserts a fresh subject.
    base = await _seed_local_user(db_session, email="paul@example.com")

    user, _ = await svc.complete_sso_login(
        _identity(external_id="sub-p", email="paul-at-corp@example.com",
                  raw_claims={"email_verified": True}),
        provider_id=provider.id, provider_slug=provider.slug,
        linking_policy="manual_only",  # policy explicitly forbids auto
        link_intent_user_id=base.id,
    )
    assert user.id == base.id
    ident = await user_identity_repo.get_by_subject(
        db_session, provider_id=provider.id, external_id="sub-p",
    )
    assert ident is not None and ident.user_id == base.id
    assert any(e[0] == "user.identity.linked" for e in events)
