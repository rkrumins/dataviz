"""SSO Phase 2 + Phase 3 — claim mapper, custom provider, refresh ceiling,
group target reconciliation, IdP-provider repo, multi-identity flow.

This file consolidates the Phase-2 tests onto the Phase-3 surface.
The Phase-3 specific additions (multi-IdP, group_membership target,
linking policy variants, link-intent flow) live in
``test_oidc_login_flow.py`` and ``test_sso_phase3.py``.
"""
from __future__ import annotations

import time

import pytest

from backend.auth_service.core import tokens as token_module
from backend.auth_service.interface import SsoReauthRequired
from backend.auth_service.providers.base import ProviderIdentity
from backend.auth_service.providers.claim_mapper import (
    apply_claim_mapping,
    ClaimMappingError,
)
from backend.auth_service.providers.custom import (
    CustomIdentityError,
    CustomIdentityProvider,
)
from backend.auth_service.providers.oidc import OidcProvider, OidcSettings


# ── Claim mapper extraction (replaces Phase 2 _extract_groups tests) ─


def _claims(**over) -> dict:
    base = {"sub": "u1", "email": "e@x.com", "given_name": "A", "family_name": "B"}
    base.update(over)
    return base


def test_extract_groups_list_form():
    out = apply_claim_mapping(_claims(groups=["Eng", "Admins"]),
                              kind="oidc", provider_slug="t")
    assert out.groups == ("Eng", "Admins")


def test_extract_groups_csv_string():
    out = apply_claim_mapping(_claims(groups=" Eng , Admins ,"),
                              kind="oidc", provider_slug="t")
    assert out.groups == ("Eng", "Admins")


def test_extract_groups_missing_returns_empty():
    out = apply_claim_mapping(_claims(), kind="oidc", provider_slug="t")
    assert out.groups == ()


def test_extract_groups_skips_non_strings():
    out = apply_claim_mapping(
        _claims(groups=["ok", 123, "", "  ", "Eng"]),
        kind="oidc", provider_slug="t",
    )
    assert out.groups == ("ok", "Eng")


def test_extract_auth_time_int_and_string():
    out = apply_claim_mapping(_claims(auth_time=1729712345),
                              kind="oidc", provider_slug="t")
    assert out.auth_time == 1729712345
    out = apply_claim_mapping(_claims(auth_time="1729712345"),
                              kind="oidc", provider_slug="t")
    assert out.auth_time == 1729712345
    out = apply_claim_mapping(_claims(), kind="oidc", provider_slug="t")
    assert out.auth_time is None


def test_claim_mapper_extras_land_on_attributes():
    out = apply_claim_mapping(
        _claims(department="Eng", employeeid="E-42"),
        kind="oidc", provider_slug="t",
        override={"extras": {
            "department": ["department"],
            "employee_id": ["employeeid"],
        }},
    )
    assert out.attributes == {"department": "Eng", "employee_id": "E-42"}


def test_claim_mapper_requires_external_id_and_email():
    with pytest.raises(ClaimMappingError):
        apply_claim_mapping({"sub": "u1"}, kind="oidc", provider_slug="t")
    with pytest.raises(ClaimMappingError):
        apply_claim_mapping({"email": "e@x.com"}, kind="oidc", provider_slug="t")


def test_claim_mapper_dotted_paths():
    out = apply_claim_mapping(
        {"profile": {"sub": "u1", "primary_email": "e@x.com",
                     "name": {"given": "Ann"}}},
        kind="oidc", provider_slug="t",
        override={
            "external_id": ["profile.sub"],
            "email": ["profile.primary_email"],
            "first_name": ["profile.name.given"],
        },
    )
    assert out.external_id == "u1"
    assert out.email == "e@x.com"
    assert out.first_name == "Ann"


# ── OIDC build_authorization wiring (max_age + prompt=login) ─────────


def _oidc_provider_for_test() -> OidcProvider:
    return OidcProvider(
        OidcSettings(
            issuer="https://idp.example.com",
            client_id="c1", client_secret="s1",
            redirect_uri="https://app.example.com/cb",
            scopes="openid email profile",
        )
    )


@pytest.mark.asyncio
async def test_oidc_authorize_pins_max_age_to_ceiling(monkeypatch):
    provider = _oidc_provider_for_test()

    async def _meta():
        return {"authorization_endpoint": "https://idp.example.com/authorize"}

    monkeypatch.setattr(provider, "_discovery", _meta)
    url, _flow = await provider.build_authorization("/dash")
    assert "max_age=86400" in url
    assert "prompt=login" not in url


@pytest.mark.asyncio
async def test_oidc_authorize_force_reauth_adds_prompt(monkeypatch):
    provider = _oidc_provider_for_test()

    async def _meta():
        return {"authorization_endpoint": "https://idp.example.com/authorize"}

    monkeypatch.setattr(provider, "_discovery", _meta)
    url, _ = await provider.build_authorization("/dash", force_reauth=True)
    assert "prompt=login" in url
    assert "max_age=86400" in url


# ── Refresh JWT carries auth_time ───────────────────────────────────


def test_refresh_token_carries_auth_time():
    at = 1_700_000_000
    token, claims = token_module.create_refresh_token(
        user_id="u1", family_id="fam1", auth_time=at,
    )
    decoded = token_module.decode_refresh_token(token)
    assert decoded.auth_time == at
    assert claims.auth_time == at


def test_refresh_token_auth_time_optional():
    token, claims = token_module.create_refresh_token(
        user_id="u1", family_id="fam1",
    )
    decoded = token_module.decode_refresh_token(token)
    assert decoded.auth_time is None
    assert claims.auth_time is None


# ── Custom IdP envelope ─────────────────────────────────────────────


def test_custom_idp_happy_path():
    payload = {
        "external_id": "S-1-5-21-1001",
        "email": "Alice@CORP.example",
        "first_name": "Alice",
        "last_name": "Doe",
        "claims": {"dept": "Eng"},
        "groups": ["Admins", "Eng-All"],
        "auth_time": 1_729_712_345,
    }
    token = token_module.create_mock_identity_token(payload)
    identity = CustomIdentityProvider().fetch_identity(token)
    assert isinstance(identity, ProviderIdentity)
    assert identity.external_id == "S-1-5-21-1001"
    assert identity.email == "alice@corp.example"
    assert identity.first_name == "Alice"
    assert identity.groups == ("Admins", "Eng-All")
    assert identity.auth_time == 1_729_712_345


def test_custom_idp_rejects_tampered_envelope():
    payload = {"external_id": "x", "email": "y@y.com"}
    token = token_module.create_mock_identity_token(payload)
    tampered = token[:-2] + "AA"
    with pytest.raises(CustomIdentityError):
        CustomIdentityProvider().fetch_identity(tampered)


def test_custom_idp_rejects_missing_required_fields():
    token = token_module.create_mock_identity_token({"email": "x@x.com"})
    with pytest.raises(CustomIdentityError):
        CustomIdentityProvider().fetch_identity(token)


# ── LocalIdentityService.refresh — SSO daily ceiling ─────────────────


class _StubUserRepo:
    def __init__(self):
        from types import SimpleNamespace
        self._user = SimpleNamespace(
            id="usr_1",
            email="alice@example.com",
            first_name="Alice",
            last_name="Doe",
            status="active",
            deleted_at=None,
            created_at="",
            updated_at="",
            metadata_="{}",
            password_hash="x-disabled-password-x",
        )

    async def get_user_by_id(self, session, uid):
        return self._user if uid == "usr_1" else None

    async def get_user_roles(self, session, uid):
        return ["workspace_member"]


class _StubUserIdentityRepo:
    def __init__(self, has_identity: bool):
        self._has = has_identity
        self.touched_ids: list[str] = []

    async def has_any_identity(self, session, user_id):
        return self._has

    async def list_for_user(self, session, user_id):
        if not self._has:
            return []
        from types import SimpleNamespace
        return [SimpleNamespace(
            id="uid_1",
            provider_id="idp_oidc_x",
            provider=SimpleNamespace(slug="default-oidc"),
            last_login_at="2026-05-20T00:00:00Z",
        )]

    async def touch_last_login(self, session, identity_id, *, metadata=None):
        self.touched_ids.append(identity_id)


class _NoopRefreshStore:
    revoked_family = None

    async def is_family_revoked(self, fam):
        return False

    async def claim_jti(self, jti, family_id, expires_at_iso, **successor):
        return True

    async def get_rotation(self, jti):
        return None

    async def revoke_family(self, family_id):
        self.revoked_family = family_id


class _NoopSession:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


def _session_factory():
    return _NoopSession()


@pytest.mark.asyncio
async def test_refresh_raises_sso_reauth_after_ceiling():
    from backend.auth_service.core.config import SSO_SESSION_MAX_AGE_SECONDS
    from backend.auth_service.service import LocalIdentityService

    stale_auth_time = int(time.time()) - (SSO_SESSION_MAX_AGE_SECONDS + 10)
    rt, _ = token_module.create_refresh_token(
        user_id="usr_1", family_id="fam1", auth_time=stale_auth_time,
    )
    killed: list[str] = []

    async def _killer(uid):
        killed.append(uid)

    store = _NoopRefreshStore()
    svc = LocalIdentityService(
        session_factory=_session_factory,
        user_repo=_StubUserRepo(),
        user_identity_repo=_StubUserIdentityRepo(has_identity=True),
        refresh_store_factory=lambda s: store,
        session_killer=_killer,
    )
    with pytest.raises(SsoReauthRequired) as exc_info:
        await svc.refresh(rt)
    # Provider slug comes from the user's most recent identity.
    assert exc_info.value.login_url.startswith(
        "/api/v1/auth/default-oidc/login"
    )
    assert "force=1" in exc_info.value.login_url
    assert killed == ["usr_1"]
    assert store.revoked_family == "fam1"


@pytest.mark.asyncio
async def test_refresh_succeeds_for_local_session():
    """A refresh JWT with ``auth_time IS NULL`` is treated as local
    (no IdP) regardless of how many SSO identities the user has."""
    from backend.auth_service.service import LocalIdentityService

    rt, _ = token_module.create_refresh_token(
        user_id="usr_1", family_id="fam1",
    )
    svc = LocalIdentityService(
        session_factory=_session_factory,
        user_repo=_StubUserRepo(),
        user_identity_repo=_StubUserIdentityRepo(has_identity=False),
        refresh_store_factory=lambda s: _NoopRefreshStore(),
    )
    user, _tokens = await svc.refresh(rt)
    assert user.id == "usr_1"


# ── Group->target reconciliation (Phase 3 — both target types) ──────


@pytest.mark.asyncio
async def test_reconcile_creates_revokes_reactivates(db_session):
    from backend.app.db.repositories import (
        binding_repo, idp_group_mapping_repo, idp_provider_repo,
    )
    from backend.app.services.permission_service import reconcile_sso_targets

    provider = await idp_provider_repo.create_provider(
        db_session, slug="entra", display_name="Entra",
        kind="oidc", settings={}, claim_mapping={},
    )
    await idp_group_mapping_repo.create_role_binding_mapping(
        db_session, idp_group="Eng",
        scope_type="workspace", scope_id="ws_1", role_name="workspace_member",
        provider_id=provider.id,
    )
    await idp_group_mapping_repo.create_role_binding_mapping(
        db_session, idp_group="Admins",
        scope_type="workspace", scope_id="ws_2", role_name="workspace_member",
        provider_id=provider.id,
    )

    out = await reconcile_sso_targets(
        db_session, user_id="usr_a", idp_groups=["Eng", "Admins"],
        provider_id=provider.id,
    )
    assert out["created"] == 2
    bindings = await binding_repo.list_for_subject(
        db_session, subject_type="user", subject_id="usr_a",
    )
    assert len(bindings) == 2
    assert all(getattr(b, "source", "local") == "sso" for b in bindings)

    out2 = await reconcile_sso_targets(
        db_session, user_id="usr_a", idp_groups=["Eng"],
        provider_id=provider.id,
    )
    assert out2["revoked"] == 1

    out3 = await reconcile_sso_targets(
        db_session, user_id="usr_a", idp_groups=["Eng", "Admins"],
        provider_id=provider.id,
    )
    assert out3["reactivated"] == 1


@pytest.mark.asyncio
async def test_reconciler_refuses_a_privileged_mapping_inserted_out_of_band(
    db_session,
):
    """The write-time guard is not the only line of defence, and must not be.

    A ``super_admin`` mapping created before that guard was corrected — or
    inserted straight into the table — would otherwise grant platform admin
    on the very next SSO login. The reconciler re-checks, so an existing bad
    row is inert rather than live.
    """
    from backend.app.db.models import IdpGroupRoleMappingORM
    from backend.app.db.repositories import binding_repo, idp_provider_repo
    from backend.app.services.permission_service import reconcile_sso_targets

    provider = await idp_provider_repo.create_provider(
        db_session, slug="entra-oob", display_name="Entra",
        kind="oidc", settings={}, claim_mapping={},
    )
    # Bypass create_role_binding_mapping entirely — that is the point.
    db_session.add(IdpGroupRoleMappingORM(
        provider_id=provider.id,
        idp_group="Admins",
        target_type="role_binding",
        role_name="super_admin",
        scope_type="global",
        scope_id=None,
        target_group_id=None,
        created_at="2026-01-01T00:00:00Z",
    ))
    await db_session.flush()

    out = await reconcile_sso_targets(
        db_session, user_id="usr_oob", idp_groups=["Admins"],
        provider_id=provider.id,
    )

    assert out["created"] == 0
    bindings = await binding_repo.list_for_subject(
        db_session, subject_type="user", subject_id="usr_oob",
    )
    assert [b.role_name for b in bindings] == []


@pytest.mark.asyncio
async def test_mapping_repo_validates_role_existence(db_session):
    from backend.app.db.repositories import idp_group_mapping_repo
    from backend.app.db.repositories.idp_group_mapping_repo import (
        ForbiddenSsoRoleError, MappingValidationError,
    )
    # Forbidden: the legacy literal. ``system:admin`` is a permission id,
    # not a role name, so this never actually protected anything — but a
    # caller may still send it and must not fall through to "does not exist".
    with pytest.raises(ForbiddenSsoRoleError):
        await idp_group_mapping_repo.create_role_binding_mapping(
            db_session, idp_group="X",
            scope_type="global", scope_id=None, role_name="system:admin",
        )
    # Forbidden: the role that actually carries platform admin. This is the
    # one that mattered — ``super_admin`` is a real, global, bindable role,
    # so it passed every check in this validator and created a mapping that
    # auto-granted full platform admin to an IdP group. Only a filter in the
    # admin UI stood in the way, and the endpoint is reachable without it.
    with pytest.raises(ForbiddenSsoRoleError):
        await idp_group_mapping_repo.create_role_binding_mapping(
            db_session, idp_group="X",
            scope_type="global", scope_id=None, role_name="super_admin",
        )
    # Unknown role -> 400 (validates against canonical roles table).
    with pytest.raises(MappingValidationError, match="does not exist"):
        await idp_group_mapping_repo.create_role_binding_mapping(
            db_session, idp_group="X",
            scope_type="global", scope_id=None, role_name="nope-typo",
        )
