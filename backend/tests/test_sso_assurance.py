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
from backend.common.assurance import (
    ASSERTED,
    ASSURANCE_DESCRIPTIONS,
    ASSURANCE_ORDER,
    UNVERIFIED,
    VERIFIED,
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
