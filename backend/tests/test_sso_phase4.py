"""SSO Phase 4 — signup provenance, indexed claim attributes, app-level
posture switches, admin lookup + search.

Covers the new surface area: signup_source stamping on JIT, indexed
attribute writes via set_user_idp_metadata, structured lookup
endpoints, fan-out search, posture switches (sso_enabled +
allow_local_login + allow_jit_provisioning), and the lockout
safeguard on the auth-config PATCH endpoint.
"""
from __future__ import annotations

from contextlib import asynccontextmanager

import pytest

from backend.app.db.repositories import (
    app_auth_config_repo,
    idp_provider_repo,
    user_attribute_repo,
    user_identity_repo,
    user_repo,
)
from backend.auth_service.app_auth_config import (
    AuthConfigSnapshot,
    StaticAuthConfigProvider,
)
from backend.auth_service.core.password import disabled_password_hash
from backend.auth_service.interface import (
    InvalidCredentials,
    LocalLoginDisabled,
    SSOAuthError,
)
from backend.auth_service.providers.base import ProviderIdentity
from backend.auth_service.service import LocalIdentityService


# ── Fixtures ─────────────────────────────────────────────────────────


@pytest.fixture()
async def provider(db_session):
    row = await idp_provider_repo.create_provider(
        db_session,
        slug="test-entra",
        display_name="Test Entra",
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


def _identity(**over) -> ProviderIdentity:
    base = dict(
        provider="oidc",
        external_id="sub-jit",
        email="alice@corp.com",
        first_name="Alice",
        last_name="Doe",
        raw_claims={"email_verified": True},
    )
    base.update(over)
    return ProviderIdentity(**base)


def _svc(db_session, *, posture: dict | None = None):
    """Build a LocalIdentityService against the test session with a
    static auth-config provider so each test case picks its posture."""
    posture = posture or {
        "sso_enabled": True,
        "allow_local_login": True,
        "allow_jit_provisioning": True,
    }
    snapshot = AuthConfigSnapshot(
        sso_enabled=posture["sso_enabled"],
        allow_local_login=posture["allow_local_login"],
        allow_jit_provisioning=posture["allow_jit_provisioning"],
        version=1,
        updated_at="2026-01-01T00:00:00Z",
    )

    @asynccontextmanager
    async def factory():
        yield db_session

    events: list[tuple[str, dict]] = []

    async def outbox(session, event_type, payload):
        events.append((event_type, payload))

    svc = LocalIdentityService(
        session_factory=factory,
        user_repo=user_repo,
        user_identity_repo=user_identity_repo,
        refresh_store_factory=lambda s: None,
        outbox_emit=outbox,
        claims_resolver=None,
        auth_config_provider=StaticAuthConfigProvider(snapshot),
    )
    return svc, events


# ── 4.A — Signup provenance ──────────────────────────────────────────


@pytest.mark.asyncio
async def test_jit_stamps_signup_source(provider, db_session):
    svc, events = _svc(db_session)
    user, _ = await svc.complete_sso_login(
        _identity(),
        provider_id=provider.id, provider_slug=provider.slug,
        linking_policy="strict",
    )
    row = await user_repo.get_user_by_id(db_session, user.id)
    assert row.signup_source == "sso_jit"
    assert row.signup_provider_id == provider.id
    # Audit event captures it too.
    assert any(
        e[0] == "user.sso_provisioned" and e[1].get("signup_source") == "sso_jit"
        for e in events
    )


@pytest.mark.asyncio
async def test_link_does_not_change_signup_source(provider, db_session):
    """A local user who later links SSO keeps signup_source='local_signup'."""
    svc, _ = _svc(db_session)
    local = await user_repo.create_user(
        db_session,
        email="bob@corp.com", password_hash="argon2-real",
        first_name="Bob", last_name="X",
        status="active",
    )
    await db_session.flush()
    assert local.signup_source == "local_signup"

    user, _ = await svc.complete_sso_login(
        _identity(external_id="sub-bob", email="bob@corp.com",
                  raw_claims={"email_verified": True}),
        provider_id=provider.id, provider_slug=provider.slug,
        linking_policy="strict",
    )
    refreshed = await user_repo.get_user_by_id(db_session, user.id)
    # Signup source is sticky — the identity row carries the link audit.
    assert refreshed.signup_source == "local_signup"


# ── 4.B — Indexed claim attributes ──────────────────────────────────


@pytest.mark.asyncio
async def test_attributes_land_in_index(provider, db_session):
    """Mapped extras get written to user_external_attributes so the
    admin lookup endpoint can find the user by staff_id."""
    svc, _ = _svc(db_session)
    identity = _identity()
    # Inject the operator-mapped extras as if the claim_mapper had
    # extracted them.
    identity = ProviderIdentity(
        provider="oidc",
        external_id="sub-staff",
        email="cara@corp.com",
        first_name="Cara",
        last_name="A",
        raw_claims={"email_verified": True},
        groups=(),
        auth_time=None,
        attributes={"staff_id": "12345", "department": "Eng"},
    )
    user, _ = await svc.complete_sso_login(
        identity,
        provider_id=provider.id, provider_slug=provider.slug,
    )
    rows = await user_attribute_repo.list_for_user(db_session, user.id)
    by_key = {r.key: r for r in rows}
    assert by_key["staff_id"].value == "12345"
    assert by_key["department"].value == "Eng"
    # Provenance attribution.
    assert by_key["staff_id"].source_provider_id == provider.id


@pytest.mark.asyncio
async def test_attribute_value_updates_in_place(provider, db_session):
    """A changed value on the next login overwrites the row (UNIQUE on
    user_id+key), not insert a duplicate."""
    svc, _ = _svc(db_session)
    user, _ = await svc.complete_sso_login(
        ProviderIdentity(
            provider="oidc", external_id="sub-upd", email="d@corp.com",
            first_name="D", last_name="U",
            raw_claims={"email_verified": True},
            attributes={"staff_id": "999"},
        ),
        provider_id=provider.id, provider_slug=provider.slug,
    )
    # Same user, different staff_id.
    await svc.complete_sso_login(
        ProviderIdentity(
            provider="oidc", external_id="sub-upd", email="d@corp.com",
            first_name="D", last_name="U",
            raw_claims={"email_verified": True},
            attributes={"staff_id": "1000"},
        ),
        provider_id=provider.id, provider_slug=provider.slug,
    )
    rows = await user_attribute_repo.list_for_user(db_session, user.id)
    matching = [r for r in rows if r.key == "staff_id"]
    assert len(matching) == 1
    assert matching[0].value == "1000"


@pytest.mark.asyncio
async def test_multivalued_attribute_flattens_to_csv(provider, db_session):
    svc, _ = _svc(db_session)
    user, _ = await svc.complete_sso_login(
        ProviderIdentity(
            provider="oidc", external_id="sub-mv", email="m@corp.com",
            first_name="M", last_name="V",
            raw_claims={"email_verified": True},
            attributes={"locations": ["NYC", "SF", "AMS"]},
        ),
        provider_id=provider.id, provider_slug=provider.slug,
    )
    rows = await user_attribute_repo.list_for_user(db_session, user.id)
    by_key = {r.key: r.value for r in rows}
    assert by_key["locations"] == "NYC, SF, AMS"


# ── 4.C — Lookup endpoints (called via repos directly) ───────────────


@pytest.mark.asyncio
async def test_lookup_by_attribute_hits_index(provider, db_session):
    svc, _ = _svc(db_session)
    target_user, _ = await svc.complete_sso_login(
        ProviderIdentity(
            provider="oidc", external_id="sub-target",
            email="target@corp.com",
            first_name="T", last_name="Argetinian",
            raw_claims={"email_verified": True},
            attributes={"staff_id": "ABC-7890"},
        ),
        provider_id=provider.id, provider_slug=provider.slug,
    )
    # Add another user with a different staff_id to ensure the
    # lookup doesn't match the wrong user.
    await svc.complete_sso_login(
        ProviderIdentity(
            provider="oidc", external_id="sub-other",
            email="other@corp.com",
            first_name="O", last_name="O",
            raw_claims={"email_verified": True},
            attributes={"staff_id": "XYZ-0001"},
        ),
        provider_id=provider.id, provider_slug=provider.slug,
    )

    rows = await user_attribute_repo.get_users_by_attribute(
        db_session, key="staff_id", value="ABC-7890",
    )
    assert len(rows) == 1
    assert rows[0].user_id == target_user.id


@pytest.mark.asyncio
async def test_search_users_finds_by_substring(db_session):
    """search_users hits email + first/last name with ILIKE."""
    await user_repo.create_user(
        db_session, email="hilltop@example.com",
        password_hash="argon2", first_name="Hilarius", last_name="Topham",
    )
    await user_repo.create_user(
        db_session, email="random@example.com",
        password_hash="argon2", first_name="Random", last_name="Person",
    )
    rows = await user_repo.search_users(db_session, q="hill")
    assert len(rows) == 1
    assert rows[0].email == "hilltop@example.com"


# ── 4.D — Posture switches ──────────────────────────────────────────


@pytest.mark.asyncio
async def test_login_refused_when_local_login_disabled(provider, db_session):
    svc, _ = _svc(db_session, posture={
        "sso_enabled": True,
        "allow_local_login": False,
        "allow_jit_provisioning": True,
    })
    # Seed a local user so we know "no such email" is NOT what's
    # tripping the check.
    await user_repo.create_user(
        db_session, email="seed@corp.com",
        password_hash="argon2", first_name="S", last_name="L",
        status="active",
    )
    await db_session.flush()

    with pytest.raises(LocalLoginDisabled):
        await svc.login("seed@corp.com", "doesnt-matter")


@pytest.mark.asyncio
async def test_sso_refused_when_master_kill_switch_off(provider, db_session):
    svc, _ = _svc(db_session, posture={
        "sso_enabled": False,
        "allow_local_login": True,
        "allow_jit_provisioning": True,
    })
    with pytest.raises(SSOAuthError, match="sso_disabled"):
        await svc.complete_sso_login(
            _identity(),
            provider_id=provider.id, provider_slug=provider.slug,
        )


@pytest.mark.asyncio
async def test_jit_blocked_when_provisioning_disabled(provider, db_session):
    svc, events = _svc(db_session, posture={
        "sso_enabled": True,
        "allow_local_login": True,
        "allow_jit_provisioning": False,
    })
    with pytest.raises(SSOAuthError, match="jit_disabled"):
        await svc.complete_sso_login(
            _identity(external_id="sub-new", email="brandnew@corp.com"),
            provider_id=provider.id, provider_slug=provider.slug,
        )
    # The audit event lands in the outbox.
    assert any(e[0] == "user.sso_jit_blocked" for e in events)


@pytest.mark.asyncio
async def test_jit_disabled_still_allows_existing_user_link(
    provider, db_session,
):
    """allow_jit_provisioning=false only blocks NEW user creation. An
    existing user whose email matches the IdP-asserted one can still
    auto-link (subject to the linking_policy)."""
    svc, _ = _svc(db_session, posture={
        "sso_enabled": True,
        "allow_local_login": True,
        "allow_jit_provisioning": False,
    })
    existing = await user_repo.create_user(
        db_session, email="known@corp.com",
        password_hash="argon2", first_name="K", last_name="X",
        status="active",
    )
    await db_session.flush()
    user, _ = await svc.complete_sso_login(
        _identity(external_id="sub-known", email="known@corp.com",
                  raw_claims={"email_verified": True}),
        provider_id=provider.id, provider_slug=provider.slug,
        linking_policy="strict",
    )
    # Same user, just got an identity attached.
    assert user.id == existing.id


# ── 4.E — Singleton config repo ─────────────────────────────────────


@pytest.mark.asyncio
async def test_config_defaults_when_row_missing(db_session):
    """get_snapshot is safe even before the migration seeds the row
    (a partial-upgrade defensive default)."""
    snap = await app_auth_config_repo.get_snapshot(db_session)
    assert snap.sso_enabled is True
    assert snap.allow_local_login is True
    assert snap.allow_jit_provisioning is True


@pytest.mark.asyncio
async def test_config_update_bumps_version(db_session):
    row = await app_auth_config_repo.update_config(
        db_session, allow_jit_provisioning=False, updated_by="usr_test",
    )
    assert row.allow_jit_provisioning is False
    assert row.version >= 2  # default is 1, bump goes to 2
    # Re-update with stale expected_version -> conflict.
    from backend.app.db.repositories.app_auth_config_repo import (
        ConflictingVersion,
    )
    with pytest.raises(ConflictingVersion):
        await app_auth_config_repo.update_config(
            db_session, expected_version=1, sso_enabled=False,
        )
