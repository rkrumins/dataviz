"""Provider assurance: derivation, and the escalation it blocks.

The pairing that motivates this: an unsigned ``custom_profile`` provider is
one admin action, and an IdP-group -> ``org_admin`` mapping is another.
Neither looks alarming alone. Together, anyone who can write a browser
storage key picks their own group list and the reconciler hands them the
platform. The refusal has to live where the two meet.
"""
from __future__ import annotations

import pytest

from backend.app.db.models import IdpGroupRoleMappingORM
from backend.app.db.repositories import (
    binding_repo,
    idp_group_mapping_repo,
    idp_provider_repo,
)
from backend.app.db.repositories.idp_group_mapping_repo import (
    ForbiddenSsoRoleError,
)
from backend.app.services.permission_service import reconcile_sso_targets
from backend.auth_service.providers.assurance import (
    ASSERTED,
    ASSURANCE_DESCRIPTIONS,
    ASSURANCE_ORDER,
    UNVERIFIED,
    VERIFIED,
    assurance_explained,
    assurance_for,
    at_least,
)

SECRET = "s" * 48


# ── Derivation ───────────────────────────────────────────────────────


@pytest.mark.parametrize("kind, settings, expected", [
    # Both verify a signature over the assertion before the mapper sees it.
    ("oidc", {}, VERIFIED),
    ("saml2", {}, VERIFIED),
    # A signed envelope is verified regardless of how it travelled.
    ("custom_profile",
     {"source": "local_storage", "payload_format": "jwt"}, VERIFIED),
    ("custom_profile", {"source": "cookie", "payload_format": "jwt"}, VERIFIED),
    # A proxy vouches; we cannot see whether it strips inbound copies.
    ("custom_profile",
     {"source": "header", "payload_format": "jwt"}, ASSERTED),
    # Unsigned is unverifiable however it arrived — including by header,
    # which must NOT be upgraded to 'asserted'.
    ("custom_profile",
     {"source": "cookie", "payload_format": "json", "trust_unsigned": True},
     UNVERIFIED),
    ("custom_profile",
     {"source": "header", "payload_format": "json", "trust_unsigned": True},
     UNVERIFIED),
    # trust_unsigned alone is enough, whatever the format claims.
    ("custom_profile",
     {"source": "cookie", "payload_format": "jwt", "trust_unsigned": "true"},
     UNVERIFIED),
    # Back-channel: verified on the transport in server mode, on the
    # signature in browser mode — whichever material carries it.
    ("backchannel", {}, VERIFIED),
    ("backchannel", {"exchange_mode": "server", "jwks_url": "https://gw/jwks"},
     VERIFIED),
    ("backchannel", {"exchange_mode": "browser", "jwks_url": "https://gw/jwks"},
     VERIFIED),
    ("backchannel",
     {"exchange_mode": "browser", "jwt_public_key": "-----BEGIN PUBLIC KEY-----"},
     VERIFIED),
    ("backchannel",
     {"exchange_mode": "browser", "jwt_shared_secret": "s3cr3t"}, VERIFIED),
    # The one unsigned variant: browser-written claims nobody verified.
    ("backchannel",
     {"exchange_mode": "browser", "trust_unsigned": True}, UNVERIFIED),
    ("backchannel",
     {"exchange_mode": "browser", "trust_unsigned": "true"}, UNVERIFIED),
    # Server + trust_unsigned cannot be built (validation refuses it);
    # were such a row seeded out of band, the transport basis stands.
    ("backchannel",
     {"exchange_mode": "server", "trust_unsigned": True}, VERIFIED),
    # tls_verify off: server mode's VERIFIED rests on the transport, and
    # with verification off anyone on the path can be the endpoint. Only
    # PASTED signing material survives an unverifiable channel — a JWKS
    # does not, because the key set itself arrives over that channel.
    ("backchannel",
     {"exchange_mode": "server", "tls_verify": False}, UNVERIFIED),
    ("backchannel",
     {"exchange_mode": "server", "tls_verify": "false"}, UNVERIFIED),
    ("backchannel",
     {"exchange_mode": "server", "tls_verify": False,
      "claims_format": "jwt", "jwks_url": "https://gw/jwks"}, UNVERIFIED),
    ("backchannel",
     {"exchange_mode": "server", "tls_verify": False, "claims_format": "jwt",
      "jwt_public_key": "-----BEGIN PUBLIC KEY-----"}, VERIFIED),
    ("backchannel",
     {"exchange_mode": "server", "tls_verify": False, "claims_format": "jwt",
      "jwt_shared_secret": "s3cr3t"}, VERIFIED),
    # A server row with pasted material but unsigned claims verifies
    # nothing — validation refuses saving it, and assurance fails closed.
    ("backchannel",
     {"exchange_mode": "server", "tls_verify": False,
      "jwt_public_key": "-----BEGIN PUBLIC KEY-----"}, UNVERIFIED),
    # Browser mode: pasted material's trust chain uses no server-side
    # TLS at all; a JWKS-verified row loses its key-source channel.
    ("backchannel",
     {"exchange_mode": "browser", "tls_verify": False,
      "jwt_shared_secret": "s3cr3t"}, VERIFIED),
    ("backchannel",
     {"exchange_mode": "browser", "tls_verify": False,
      "jwks_url": "https://gw/jwks"}, UNVERIFIED),
    # Explicit True and absent both keep today's ratings.
    ("backchannel",
     {"exchange_mode": "server", "tls_verify": True}, VERIFIED),
    # The dev mock signs its envelope, but it asserts whatever a developer
    # typed into a form. That is authorship, not identity proof.
    ("custom", {}, UNVERIFIED),
    # An unknown kind fails closed.
    ("something-new", {}, UNVERIFIED),
])
def test_assurance_derivation(kind, settings, expected):
    assert assurance_for(kind, settings) == expected


def test_defaults_match_the_provider_defaults():
    """An empty settings dict must derive the same level the provider
    itself would run with — jwt/cookie are the CustomProfileSettings
    defaults, so an unconfigured row reads as verified, not unverified."""
    assert assurance_for("custom_profile", {}) == VERIFIED
    assert assurance_for("custom_profile", None) == VERIFIED


def test_ordering_is_ranked_not_alphabetical():
    assert at_least(VERIFIED, UNVERIFIED)
    assert at_least(ASSERTED, UNVERIFIED)
    assert at_least(VERIFIED, VERIFIED)
    assert not at_least(ASSERTED, VERIFIED)
    assert not at_least(UNVERIFIED, ASSERTED)


def test_an_unknown_level_fails_closed():
    assert not at_least("wishful", VERIFIED)
    assert not at_least(VERIFIED, "wishful")


def test_every_level_has_an_explanation():
    """A new level must not ship without copy explaining it to an operator."""
    for level in ASSURANCE_ORDER:
        assert ASSURANCE_DESCRIPTIONS.get(level, "").strip()


@pytest.mark.parametrize("kind, settings, names", [
    # Each weak row names ITS cause and the change that fixes it — the
    # generic "anyone can be anyone" never said which switch was to blame.
    ("backchannel", {"exchange_mode": "browser", "trust_unsigned": True},
     ["Trust unsigned is on", "JWKS URL, public key or shared secret"]),
    ("backchannel", {"exchange_mode": "server", "tls_verify": False},
     ["TLS verification is off", "SSO_OUTBOUND_TLS_CA_CERTS"]),
    ("backchannel",
     {"exchange_mode": "browser", "tls_verify": False, "jwks_url": "https://gw/jwks"},
     ["TLS verification is off", "public key in place of its JWKS URL"]),
    ("custom_profile", {"source": "cookie", "payload_format": "json"},
     ["anyone able to set the cookie can sign in as anyone", "sign it as a JWT"]),
    ("custom_profile", {"source": "local_storage", "trust_unsigned": True},
     ["browser storage key"]),
    ("custom", {}, ["development sign-in"]),
    # A strong row says what stands behind it — for a server-mode gateway
    # that is the call itself, not a signature.
    ("backchannel", {}, ["over verified TLS"]),
    ("backchannel", {"exchange_mode": "browser", "jwks_url": "https://gw/jwks"},
     ["signature-checked"]),
])
def test_the_reason_names_this_rows_cause(kind, settings, names):
    level, reason = assurance_explained(kind, settings)
    assert level == assurance_for(kind, settings)
    for phrase in names:
        assert phrase in reason


# ── Write-time gate ──────────────────────────────────────────────────


async def _provider(db_session, *, slug, kind="custom_profile", **settings):
    base = {"source": "cookie", "source_key": "p", "payload_format": "jwt",
            "shared_secret": SECRET}
    base.update(settings)
    row = await idp_provider_repo.create_provider(
        db_session, slug=slug, display_name=slug, kind=kind,
        settings={} if kind in {"oidc", "saml2"} else base,
    )
    await db_session.flush()
    return row


@pytest.mark.asyncio
@pytest.mark.parametrize("role, expected_guard", [
    # super_admin is refused outright by the Phase-0 forbidden-role guard,
    # whatever the provider's assurance — that check runs first by design,
    # so the earliest and bluntest refusal is the one the operator sees.
    ("super_admin", "may not auto-grant"),
    # org_admin is a legitimate SSO-granted role from a provider that can
    # prove identities. Here it is the assurance gate doing the refusing.
    ("org_admin", "assurance"),
])
async def test_platform_admin_refused_from_an_unverified_provider(
    db_session, role, expected_guard,
):
    provider = await _provider(
        db_session, slug=f"portal-{role.replace('_', '-')}",
        payload_format="json", trust_unsigned=True,
    )
    with pytest.raises(ForbiddenSsoRoleError, match=expected_guard):
        await idp_group_mapping_repo.create_role_binding_mapping(
            db_session, idp_group="Admins", role_name=role,
            scope_type="global", scope_id=None, provider_id=provider.id,
        )


@pytest.mark.asyncio
async def test_platform_admin_refused_from_a_header_sourced_provider(
    db_session,
):
    """'asserted' is better than 'unverified' and still not good enough to
    hand out the platform: a misconfigured proxy is indistinguishable from
    a correct one, from here."""
    provider = await _provider(
        db_session, slug="proxy-idp", source="header",
        source_key="X-Corp", trusted_proxy_acknowledged=True,
    )
    with pytest.raises(ForbiddenSsoRoleError, match="assurance"):
        await idp_group_mapping_repo.create_role_binding_mapping(
            db_session, idp_group="Admins", role_name="org_admin",
            scope_type="global", scope_id=None, provider_id=provider.id,
        )


@pytest.mark.asyncio
async def test_platform_admin_allowed_from_a_verified_provider(db_session):
    provider = await _provider(db_session, slug="entra-ok", kind="oidc")
    row = await idp_group_mapping_repo.create_role_binding_mapping(
        db_session, idp_group="Admins", role_name="org_admin",
        scope_type="global", scope_id=None, provider_id=provider.id,
    )
    assert row.role_name == "org_admin"


@pytest.mark.asyncio
async def test_ordinary_roles_are_unaffected_by_low_assurance(db_session):
    """The gate is about platform admin, not about distrusting the provider
    for everything — a low-assurance IdP mapping to a workspace role is a
    legitimate configuration and must keep working."""
    provider = await _provider(
        db_session, slug="portal-ws", payload_format="json",
        trust_unsigned=True,
    )
    row = await idp_group_mapping_repo.create_role_binding_mapping(
        db_session, idp_group="Eng", role_name="workspace_member",
        scope_type="workspace", scope_id="ws_1", provider_id=provider.id,
    )
    assert row.role_name == "workspace_member"


@pytest.mark.asyncio
async def test_platform_admin_refused_when_the_mapping_has_no_provider(
    db_session,
):
    """A provider-less mapping applies to every provider, including an
    unverified one added tomorrow. Resolving that to 'currently fine' would
    make the gate depend on configuration order."""
    with pytest.raises(ForbiddenSsoRoleError, match="every provider"):
        await idp_group_mapping_repo.create_role_binding_mapping(
            db_session, idp_group="Admins", role_name="org_admin",
            scope_type="global", scope_id=None, provider_id=None,
        )


# ── Reconciler mirror ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_reconciler_refuses_platform_admin_after_a_downgrade(
    db_session,
):
    """The case the write-time gate structurally cannot catch.

    The mapping is created while the provider is verified — entirely legal.
    An operator then flips the provider to unsigned. Nothing re-validates
    the existing mappings, so without the reconciler-side check the next
    login quietly grants platform admin from a provider that can no longer
    prove anyone's identity.
    """
    provider = await _provider(db_session, slug="drifting", kind="oidc")
    await idp_group_mapping_repo.create_role_binding_mapping(
        db_session, idp_group="Admins", role_name="org_admin",
        scope_type="global", scope_id=None, provider_id=provider.id,
    )
    await db_session.flush()

    # Downgrade: same row, now an unsigned custom_profile.
    await idp_provider_repo.update_provider(
        db_session, provider.id,
        settings={"source": "cookie", "source_key": "p",
                  "payload_format": "json", "trust_unsigned": True},
    )
    provider.kind = "custom_profile"
    await db_session.flush()

    out = await reconcile_sso_targets(
        db_session, user_id="usr_drift", idp_groups=["Admins"],
        provider_id=provider.id,
    )

    assert out["created"] == 0
    bindings = await binding_repo.list_for_subject(
        db_session, subject_type="user", subject_id="usr_drift",
    )
    assert [b.role_name for b in bindings] == []


@pytest.mark.asyncio
async def test_reconciler_still_grants_ordinary_roles_from_a_weak_provider(
    db_session,
):
    provider = await _provider(
        db_session, slug="weak-but-useful", payload_format="json",
        trust_unsigned=True,
    )
    db_session.add(IdpGroupRoleMappingORM(
        provider_id=provider.id, idp_group="Eng",
        target_type="role_binding", role_name="workspace_member",
        scope_type="workspace", scope_id="ws_9", target_group_id=None,
        created_at="2026-01-01T00:00:00Z",
    ))
    await db_session.flush()

    out = await reconcile_sso_targets(
        db_session, user_id="usr_weak", idp_groups=["Eng"],
        provider_id=provider.id,
    )
    assert out["created"] == 1


@pytest.mark.asyncio
async def test_reconciler_fails_closed_on_an_unknown_provider(db_session):
    """No provider row means we cannot establish assurance, and "unknown"
    must behave like "weak" — this path only ever withholds a grant."""
    db_session.add(IdpGroupRoleMappingORM(
        provider_id="idp_vanished", idp_group="Admins",
        target_type="role_binding", role_name="org_admin",
        scope_type="global", scope_id=None, target_group_id=None,
        created_at="2026-01-01T00:00:00Z",
    ))
    await db_session.flush()

    out = await reconcile_sso_targets(
        db_session, user_id="usr_ghost", idp_groups=["Admins"],
        provider_id="idp_vanished",
    )
    assert out["created"] == 0


# ── Admin surface ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_admin_dto_exposes_assurance_with_an_explanation(
    test_client, db_session,
):
    await _provider(
        db_session, slug="shown", payload_format="json", trust_unsigned=True,
    )
    await db_session.commit()

    resp = await test_client.get("/api/v1/admin/idp-providers")
    assert resp.status_code == 200
    dto = next(p for p in resp.json() if p["slug"] == "shown")
    assert dto["assurance"] == UNVERIFIED
    assert "sign in as anyone" in dto["assuranceReason"]


# ── The unsigned backchannel row meets the same gates ────────────────

@pytest.mark.asyncio
async def test_platform_admin_refused_from_an_unsigned_backchannel_row(
    db_session,
):
    """The trust_unsigned browser posture accepts browser-written claims
    nobody verified — precisely the payload that must never carry a
    platform role. Same gate, same message as custom_profile."""
    provider = await idp_provider_repo.create_provider(
        db_session, slug="corp-unsigned", display_name="Corp (unsigned)",
        kind="backchannel",
        settings={
            "exchange_mode": "browser",
            "browser_exchange_url": "https://sso.corp.example/translate",
            "trust_unsigned": True,
        },
    )
    await db_session.flush()
    with pytest.raises(ForbiddenSsoRoleError, match="assurance"):
        await idp_group_mapping_repo.create_role_binding_mapping(
            db_session, idp_group="Admins", role_name="org_admin",
            scope_type="global", scope_id=None, provider_id=provider.id,
        )


@pytest.mark.asyncio
async def test_platform_admin_allowed_from_a_key_verified_backchannel_row(
    db_session,
):
    provider = await idp_provider_repo.create_provider(
        db_session, slug="corp-pem", display_name="Corp (pem)",
        kind="backchannel",
        settings={
            "exchange_mode": "browser",
            "browser_exchange_url": "https://sso.corp.example/translate",
            "jwt_public_key": "-----BEGIN PUBLIC KEY-----",
        },
    )
    await db_session.flush()
    row = await idp_group_mapping_repo.create_role_binding_mapping(
        db_session, idp_group="Admins", role_name="org_admin",
        scope_type="global", scope_id=None, provider_id=provider.id,
    )
    assert row.role_name == "org_admin"


@pytest.mark.asyncio
async def test_reconciler_withholds_platform_roles_from_unsigned_backchannel(
    db_session,
):
    """The reconcile-time half: a mapping written while the row verified
    stops granting the moment the posture drops to trust_unsigned."""
    provider = await idp_provider_repo.create_provider(
        db_session, slug="corp-drift", display_name="Corp (drift)",
        kind="backchannel",
        settings={
            "exchange_mode": "browser",
            "browser_exchange_url": "https://sso.corp.example/translate",
            "jwks_url": "https://sso.corp.example/jwks",
        },
    )
    await db_session.flush()
    await idp_group_mapping_repo.create_role_binding_mapping(
        db_session, idp_group="Admins", role_name="org_admin",
        scope_type="global", scope_id=None, provider_id=provider.id,
    )
    await db_session.flush()

    await idp_provider_repo.update_provider(
        db_session, provider.id,
        settings={
            "exchange_mode": "browser",
            "browser_exchange_url": "https://sso.corp.example/translate",
            "trust_unsigned": True,
        },
    )
    await db_session.flush()

    out = await reconcile_sso_targets(
        db_session, user_id="usr_bc_drift", idp_groups=["Admins"],
        provider_id=provider.id,
    )
    assert out["created"] == 0
    bindings = await binding_repo.list_for_subject(
        db_session, subject_type="user", subject_id="usr_bc_drift",
    )
    assert [b.role_name for b in bindings] == []


# ── An unverified connection never claims a Super Admin ──────────────
#
# Its claims are whatever the sender wrote, ``email_verified`` included.
# Linking by email would hand the break-glass account or any Super Admin to
# anyone able to reach the sign-in endpoint with a hand-written payload.
# Every other account still links — an org admin's included — so an
# unsigned connection keeps working for the people it was trusted for.


def _sso_service(db_session, *, checks_admins=True):
    from contextlib import asynccontextmanager

    from backend.app.db.repositories import user_identity_repo, user_repo
    from backend.app.db.repositories.refresh_token_repo import make_refresh_store
    from backend.auth_service.service import LocalIdentityService

    @asynccontextmanager
    async def factory():
        yield db_session

    async def is_super_admin(session, user_id):
        return user_id in await binding_repo.super_admin_user_ids(session)

    return LocalIdentityService(
        session_factory=factory, user_repo=user_repo,
        user_identity_repo=user_identity_repo,
        refresh_store_factory=make_refresh_store,
        super_admin_checker=is_super_admin if checks_admins else None,
    )


def _claims(email, sub):
    from backend.auth_service.providers.base import ProviderIdentity
    return ProviderIdentity(
        provider="backchannel", external_id=sub, email=email,
        first_name="Not", last_name="Them", raw_claims={"email_verified": True},
    )


async def _gateway_row(db_session, slug):
    row = await idp_provider_repo.create_provider(
        db_session, slug=slug, display_name=slug, kind="backchannel",
        settings={"exchange_mode": "browser",
                  "browser_exchange_url": "https://sso.corp.example/translate",
                  "trust_unsigned": True},
    )
    await db_session.flush()
    return row


async def _local_account(db_session, email, *, system=False, role=None):
    from datetime import datetime, timezone

    from backend.app.db.models import RoleBindingORM
    from backend.app.db.repositories import user_repo
    user = await user_repo.create_user(
        db_session, email=email, password_hash="x", first_name="Local",
        last_name="Account", status="active",
    )
    user.is_system_account = system
    if role:
        db_session.add(RoleBindingORM(
            id=f"bnd_{user.id}", subject_type="user", subject_id=user.id,
            role_name=role, scope_type="global", scope_id=None,
            granted_at=datetime.now(timezone.utc).isoformat(), source="local",
        ))
    await db_session.flush()
    return user


@pytest.mark.asyncio
async def test_an_unverified_connection_cannot_claim_the_break_glass_account(db_session):
    from backend.auth_service.interface import SSOAuthError
    gw = await _gateway_row(db_session, "unsigned-gw")
    await _local_account(db_session, "glass@corp.example", system=True)
    svc = _sso_service(db_session)

    with pytest.raises(SSOAuthError) as err:
        await svc.complete_sso_login(
            _claims("glass@corp.example", "forged-1"), provider_id=gw.id,
            linking_policy="strict", assurance=UNVERIFIED,
        )
    assert str(err.value) == "unsafe_auto_link"
    assert "unverified_connection" in err.value.deny_reasons

    # The rehearsal says the same, from the same decision.
    preview = await svc.preview_sso_login(
        _claims("glass@corp.example", "forged-1"), provider_id=gw.id,
        linking_policy="strict", assurance=UNVERIFIED,
    )
    assert preview["action"] == "rejected"
    assert "unverified_connection" in preview["deny_reasons"]


@pytest.mark.asyncio
async def test_an_unverified_connection_cannot_claim_a_super_admin(db_session):
    from backend.auth_service.interface import SSOAuthError
    gw = await _gateway_row(db_session, "unsigned-gw")
    await _local_account(db_session, "boss@corp.example", role="super_admin")

    with pytest.raises(SSOAuthError) as err:
        await _sso_service(db_session).complete_sso_login(
            _claims("boss@corp.example", "forged-2"), provider_id=gw.id,
            linking_policy="strict", assurance=UNVERIFIED,
        )
    assert "unverified_connection" in err.value.deny_reasons


@pytest.mark.asyncio
async def test_an_unverified_connection_links_an_org_admin(db_session):
    """An org admin runs workspaces, not the platform: no SSO settings, no
    user management. Their first sign-in through the gateway links their
    account like anyone else's."""
    gw = await _gateway_row(db_session, "unsigned-gw")
    org_admin = await _local_account(db_session, "ops@corp.example", role="org_admin")

    user, _ = await _sso_service(db_session).complete_sso_login(
        _claims("ops@corp.example", "emp-ops"), provider_id=gw.id,
        linking_policy="strict", assurance=UNVERIFIED,
    )
    assert user.id == org_admin.id


@pytest.mark.asyncio
async def test_an_unverified_connection_still_links_an_ordinary_account(db_session):
    """Someone who had a local account signs in through the unsigned
    gateway for the first time: same account, now linked."""
    gw = await _gateway_row(db_session, "unsigned-gw")
    local = await _local_account(db_session, "member@corp.example")

    user, _ = await _sso_service(db_session).complete_sso_login(
        _claims("member@corp.example", "emp-7"), provider_id=gw.id,
        linking_policy="strict", assurance=UNVERIFIED,
    )
    assert user.id == local.id


@pytest.mark.asyncio
@pytest.mark.parametrize("system, role", [(True, None), (False, "super_admin")])
async def test_the_operator_can_let_an_unverified_connection_link_administrators(
    db_session, system, role,
):
    """``link_admin_accounts`` on the connection: every existing account
    links, Super Admins and break-glass included — the operator's call."""
    gw = await _gateway_row(db_session, "trusted-unsigned-gw")
    admin = await _local_account(
        db_session, "chief@corp.example", system=system, role=role,
    )
    svc = _sso_service(db_session)

    user, _ = await svc.complete_sso_login(
        _claims("chief@corp.example", "emp-chief"), provider_id=gw.id,
        linking_policy="strict", assurance=UNVERIFIED, link_admin_accounts=True,
    )
    assert user.id == admin.id


@pytest.mark.asyncio
async def test_without_an_answer_every_account_counts_as_a_super_admin(db_session):
    """Nothing wired to say who the Super Admins are: fail closed."""
    from backend.auth_service.interface import SSOAuthError
    gw = await _gateway_row(db_session, "unsigned-gw")
    await _local_account(db_session, "plain@corp.example")

    with pytest.raises(SSOAuthError):
        await _sso_service(db_session, checks_admins=False).complete_sso_login(
            _claims("plain@corp.example", "emp-8"), provider_id=gw.id,
            linking_policy="strict", assurance=UNVERIFIED,
        )


@pytest.mark.asyncio
async def test_a_verified_connection_still_links_an_administrator(db_session):
    gw = await _gateway_row(db_session, "signed-gw")
    glass = await _local_account(db_session, "linked@corp.example", system=True)

    user, _ = await _sso_service(db_session).complete_sso_login(
        _claims("linked@corp.example", "emp-1"), provider_id=gw.id,
        linking_policy="strict", assurance=VERIFIED,
    )
    assert user.id == glass.id


@pytest.mark.asyncio
async def test_an_unverified_connection_still_serves_its_own_people(db_session):
    """New accounts, and accounts already linked to it, are unaffected."""
    gw = await _gateway_row(db_session, "own-gw")
    svc = _sso_service(db_session)

    first, _ = await svc.complete_sso_login(
        _claims("new@corp.example", "emp-new"), provider_id=gw.id,
        assurance=UNVERIFIED,
    )
    again, _ = await svc.complete_sso_login(
        _claims("new@corp.example", "emp-new"), provider_id=gw.id,
        assurance=UNVERIFIED,
    )
    assert again.id == first.id
