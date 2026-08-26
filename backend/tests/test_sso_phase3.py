"""SSO Phase 3 — multi-IdP, configurable mapping, group-membership target,
multi-identity per user, link-intent flow.

The Phase 2 tests in ``test_sso_phase2.py`` cover the OIDC build /
claim-mapper / refresh-ceiling / role-binding-reconciliation that
survived Phase 3 unchanged. This file covers the new surface area.
"""
from __future__ import annotations

import json

import pytest

from backend.app.db.models import GroupMemberORM, GroupORM
from backend.app.db.repositories import (
    binding_repo,
    group_repo,
    idp_group_mapping_repo,
    idp_provider_repo,
    user_identity_repo,
    user_repo,
)
from backend.app.db.repositories.idp_group_mapping_repo import (
    MappingValidationError,
)
from backend.app.db.repositories.idp_provider_repo import (
    ProviderValidationError,
)
from backend.app.db.repositories.user_identity_repo import (
    LastAuthenticatorError,
)
from backend.app.services.permission_service import reconcile_sso_targets
from backend.auth_service.core.password import (
    disabled_password_hash,
    is_password_set,
)
from backend.auth_service.core.tokens import (
    create_link_intent_token,
    decode_link_intent_token,
)
from backend.auth_service.providers.claim_mapper import (
    DEFAULT_OIDC,
    DEFAULT_SAML,
    apply_claim_mapping,
    merge_mapping,
)


# ── idp_provider_repo CRUD + encryption boundary ────────────────────


@pytest.mark.asyncio
async def test_provider_create_round_trip(db_session):
    row = await idp_provider_repo.create_provider(
        db_session,
        slug="entra-staff",
        display_name="Corporate Entra ID",
        kind="oidc",
        settings={
            "issuer": "https://login.microsoftonline.com/tenant",
            "client_id": "abc", "client_secret": "S3CR3T",
            "redirect_uri": "https://app/cb",
        },
        claim_mapping={"groups": ["wids"], "extras": {"dept": ["department"]}},
    )
    # Settings are encrypted at rest. The column value is opaque; the
    # repo decoder restores the original dict.
    decoded = idp_provider_repo.decrypt_settings(row.settings)
    assert decoded["client_id"] == "abc"
    assert decoded["client_secret"] == "S3CR3T"

    fetched = await idp_provider_repo.get_provider(db_session, row.id)
    assert fetched is not None
    assert fetched.slug == "entra-staff"
    # claim_mapping is plain JSON, no encryption.
    assert idp_provider_repo.parse_claim_mapping(fetched) == {
        "groups": ["wids"], "extras": {"dept": ["department"]},
    }


@pytest.mark.asyncio
async def test_provider_redacts_secrets(db_session):
    row = await idp_provider_repo.create_provider(
        db_session, slug="test-redact", display_name="T", kind="oidc",
        settings={"issuer": "x", "client_id": "c", "client_secret": "abc123"},
    )
    decoded = idp_provider_repo.decrypt_settings(row.settings)
    redacted = idp_provider_repo.redact_settings(decoded)
    assert redacted["client_id"] == "c"
    assert redacted["client_secret"] == "********"


@pytest.mark.asyncio
async def test_provider_slug_validation(db_session):
    with pytest.raises(ProviderValidationError, match="slug"):
        await idp_provider_repo.create_provider(
            db_session, slug="A B C",  # uppercase + spaces
            display_name="X", kind="oidc", settings={},
        )


@pytest.mark.asyncio
async def test_provider_update_merges_settings(db_session):
    row = await idp_provider_repo.create_provider(
        db_session, slug="test-merge", display_name="T", kind="oidc",
        settings={"issuer": "x", "client_id": "c", "client_secret": "old"},
    )
    updated = await idp_provider_repo.update_provider(
        db_session, row.id, settings={"client_secret": "new"},
    )
    assert updated is not None
    decoded = idp_provider_repo.decrypt_settings(updated.settings)
    # ``issuer`` survived the partial update.
    assert decoded == {"issuer": "x", "client_id": "c", "client_secret": "new"}


# ── User identities (multi-identity + last-authenticator) ───────────


@pytest.mark.asyncio
async def test_user_can_link_multiple_identities(db_session):
    p1 = await idp_provider_repo.create_provider(
        db_session, slug="entra", display_name="Entra", kind="oidc",
        settings={},
    )
    p2 = await idp_provider_repo.create_provider(
        db_session, slug="auth0", display_name="Auth0", kind="oidc",
        settings={},
    )
    user = await user_repo.create_sso_user(
        db_session, email="multi@x.com", first_name="M", last_name="X",
        password_hash=disabled_password_hash(),
    )
    await user_identity_repo.create_identity(
        db_session, user_id=user.id, provider_id=p1.id, external_id="ext-1",
    )
    await user_identity_repo.create_identity(
        db_session, user_id=user.id, provider_id=p2.id, external_id="ext-2",
    )
    identities = await user_identity_repo.list_for_user(db_session, user.id)
    assert {i.provider_id for i in identities} == {p1.id, p2.id}


@pytest.mark.asyncio
async def test_unlink_refuses_last_authenticator(db_session):
    p1 = await idp_provider_repo.create_provider(
        db_session, slug="solo", display_name="S", kind="oidc", settings={},
    )
    user = await user_repo.create_sso_user(
        db_session, email="solo@x.com", first_name="S", last_name="O",
        password_hash=disabled_password_hash(),
    )
    ident = await user_identity_repo.create_identity(
        db_session, user_id=user.id, provider_id=p1.id, external_id="ext-1",
    )
    # No password, no other identities -> refuse.
    with pytest.raises(LastAuthenticatorError):
        await user_identity_repo.delete_identity(
            db_session, identity_id=ident.id, enforce_last_authenticator=True,
        )


@pytest.mark.asyncio
async def test_unlink_succeeds_when_password_set(db_session):
    p1 = await idp_provider_repo.create_provider(
        db_session, slug="dup", display_name="D", kind="oidc", settings={},
    )
    user = await user_repo.create_user(
        db_session, email="pw@x.com", password_hash="argon2-real-hash",
        first_name="P", last_name="W",
    )
    ident = await user_identity_repo.create_identity(
        db_session, user_id=user.id, provider_id=p1.id, external_id="ext-1",
    )
    # Has password -> unlink OK.
    await user_identity_repo.delete_identity(
        db_session, identity_id=ident.id, enforce_last_authenticator=True,
    )
    assert (
        await user_identity_repo.get_by_id(db_session, ident.id)
    ) is None


@pytest.mark.asyncio
async def test_disabled_sentinel_round_trip():
    sentinel = disabled_password_hash()
    assert is_password_set(sentinel) is False
    assert is_password_set("argon2-something") is True
    assert is_password_set(None) is False
    assert is_password_set("") is False


# ── Group-membership target reconciler ──────────────────────────────


@pytest.mark.asyncio
async def test_reconcile_creates_group_membership(db_session):
    provider = await idp_provider_repo.create_provider(
        db_session, slug="entra-staff", display_name="Entra",
        kind="oidc", settings={},
    )
    group = await group_repo.create_group(
        db_session, name="Engineers", description="Eng team",
    )
    await idp_group_mapping_repo.create_group_membership_mapping(
        db_session, idp_group="engineering",
        target_group_id=group.id, provider_id=provider.id,
    )
    user = await user_repo.create_sso_user(
        db_session, email="e@x.com", first_name="E", last_name="X",
        password_hash=disabled_password_hash(),
    )
    out = await reconcile_sso_targets(
        db_session, user_id=user.id, idp_groups=["engineering"],
        provider_id=provider.id,
    )
    assert out["memberships_added"] == 1
    # Removing the group on next login removes the membership.
    out2 = await reconcile_sso_targets(
        db_session, user_id=user.id, idp_groups=[],
        provider_id=provider.id,
    )
    assert out2["memberships_removed"] == 1


@pytest.mark.asyncio
async def test_reconcile_preserves_manual_group_memberships(db_session):
    """Memberships added manually (source='local') must NOT be revoked
    even when the SSO assertion stops including the group."""
    provider = await idp_provider_repo.create_provider(
        db_session, slug="test-preserve", display_name="P", kind="oidc", settings={},
    )
    group = await group_repo.create_group(db_session, name="Manual", description="")
    user = await user_repo.create_sso_user(
        db_session, email="m@x.com", first_name="M", last_name="X",
        password_hash=disabled_password_hash(),
    )
    # Manual add (source defaults to 'local').
    db_session.add(GroupMemberORM(
        group_id=group.id, user_id=user.id, added_by="admin",
    ))
    await db_session.flush()

    # SSO never asserted the group, reconciler shouldn't touch it.
    out = await reconcile_sso_targets(
        db_session, user_id=user.id, idp_groups=[], provider_id=provider.id,
    )
    assert out["memberships_removed"] == 0
    from sqlalchemy import select
    member = (await db_session.execute(
        select(GroupMemberORM).where(
            GroupMemberORM.user_id == user.id,
            GroupMemberORM.group_id == group.id,
        )
    )).scalar_one_or_none()
    assert member is not None


@pytest.mark.asyncio
async def test_mapping_repo_refuses_protected_group(db_session):
    group = await group_repo.create_group(
        db_session, name="Sensitive", description="",
    )
    group.is_protected = True
    await db_session.flush()
    with pytest.raises(MappingValidationError, match="protected"):
        await idp_group_mapping_repo.create_group_membership_mapping(
            db_session, idp_group="x", target_group_id=group.id,
        )


# ── Link-intent token ──────────────────────────────────────────────


def test_link_intent_round_trip():
    token = create_link_intent_token(user_id="usr_1", provider_id="idp_1")
    payload = decode_link_intent_token(token)
    assert payload["user_id"] == "usr_1"
    assert payload["provider_id"] == "idp_1"


def test_link_intent_tampered_rejected():
    import jwt as pyjwt
    token = create_link_intent_token(user_id="usr_1", provider_id="idp_1")
    with pytest.raises(pyjwt.InvalidTokenError):
        decode_link_intent_token(token[:-2] + "AA")


# ── Claim mapper merge defaults ─────────────────────────────────────


def test_merge_mapping_keeps_defaults_for_unset_keys():
    override = {"groups": ["custom_groups"]}
    merged = merge_mapping("oidc", override)
    # groups overridden, others fall back to defaults.
    assert merged["groups"] == ["custom_groups"]
    assert merged["external_id"] == DEFAULT_OIDC["external_id"]
    assert merged["email"] == DEFAULT_OIDC["email"]


def test_merge_mapping_extras_are_layered():
    """Operator-defined extras land in the dict alongside any
    defaults — useful when we ship default extras in the future."""
    merged = merge_mapping("saml2", {"extras": {"emp_id": ["employeeid"]}})
    assert merged["extras"] == {"emp_id": ["employeeid"]}


def test_merge_mapping_unknown_kind_falls_back():
    merged = merge_mapping("nonsense", {"email": ["primary_email"]})
    # No crash; we get the custom defaults overlaid with the override.
    assert merged["email"] == ["primary_email"]


# ── Provider listing returns enabled only (ordering) ────────────────


@pytest.mark.asyncio
async def test_list_providers_ordered_by_priority(db_session):
    await idp_provider_repo.create_provider(
        db_session, slug="prio-hi", display_name="HiPrio", kind="oidc",
        settings={}, priority=10,
    )
    await idp_provider_repo.create_provider(
        db_session, slug="prio-lo", display_name="LoPrio", kind="oidc",
        settings={}, priority=999,
    )
    listing = await idp_provider_repo.list_providers(db_session)
    slugs = [r.slug for r in listing]
    assert slugs.index("prio-hi") < slugs.index("prio-lo")


@pytest.mark.asyncio
async def test_list_for_users_batches_a_page(db_session):
    """The admin user list resolves a whole page's identities in ONE
    query — per-row lookups would be fifty queries per page."""
    p1 = await idp_provider_repo.create_provider(
        db_session, slug="batch-a", display_name="A", kind="oidc",
        settings={},
    )
    p2 = await idp_provider_repo.create_provider(
        db_session, slug="batch-b", display_name="B", kind="saml2",
        settings={},
    )
    both = await user_repo.create_sso_user(
        db_session, email="both@batch.example", first_name="B",
        last_name="L", password_hash=disabled_password_hash(),
    )
    one = await user_repo.create_sso_user(
        db_session, email="one@batch.example", first_name="O",
        last_name="L", password_hash=disabled_password_hash(),
    )
    none = await user_repo.create_sso_user(
        db_session, email="none@batch.example", first_name="N",
        last_name="L", password_hash=disabled_password_hash(),
    )
    for uid, pid, ext in [
        (both.id, p1.id, "e1"), (both.id, p2.id, "e2"), (one.id, p1.id, "e3"),
    ]:
        await user_identity_repo.create_identity(
            db_session, user_id=uid, provider_id=pid, external_id=ext,
            email_at_link=None,
        )
    await db_session.commit()

    grouped = await user_identity_repo.list_for_users(
        db_session, [both.id, one.id, none.id],
    )
    assert sorted(i.provider.slug for i in grouped[both.id]) == [
        "batch-a", "batch-b",
    ]
    assert [i.provider.slug for i in grouped[one.id]] == ["batch-a"]
    # No identities = no key; and ``.provider`` was eager-loaded (no
    # MissingGreenlet on access above).
    assert none.id not in grouped
    assert await user_identity_repo.list_for_users(db_session, []) == {}
