"""Phase 2 SSO — SAML/custom providers, group->role reconcile, 24h re-auth.

Unit-level coverage that doesn't depend on a running SAML IdP. The
SAML provider's strict validation path is exercised in a separate
integration test (skipped here unless ``python3-saml`` + ``xmlsec1``
are installed). What we cover here:

  * OIDC group extraction across the claim shapes IdPs emit.
  * OIDC build_authorization wires max_age + prompt=login on force.
  * Refresh JWT carries ``auth_time`` through rotation.
  * CustomIdentityProvider: happy path + envelope rejection paths.
  * LocalIdentityService.refresh raises SsoReauthRequired when the IdP
    auth_time is older than the daily ceiling AND the user is SSO.
  * reconcile_sso_role_bindings: creates new sso-source bindings,
    soft-revokes bindings whose group is no longer asserted,
    reactivates expired ones, refuses system:admin.
  * idp_group_mapping_repo refuses to create a system:admin mapping.
"""
from __future__ import annotations

import os
import time

import pytest

from backend.auth_service.core import tokens as token_module
from backend.auth_service.interface import (
    InvalidRefreshToken,
    SsoReauthRequired,
)
from backend.auth_service.providers.base import ProviderIdentity
from backend.auth_service.providers.custom import (
    CustomIdentityError,
    CustomIdentityProvider,
)
from backend.auth_service.providers.oidc import (
    OidcProvider,
    OidcSettings,
    _extract_auth_time,
    _extract_groups,
)


# ── OIDC groups extraction ───────────────────────────────────────────


def test_extract_groups_list_form():
    g = _extract_groups({"groups": ["Eng", "DataViz-Admins"]})
    assert g == ("Eng", "DataViz-Admins")


def test_extract_groups_single_string():
    g = _extract_groups({"groups": "Eng"})
    assert g == ("Eng",)


def test_extract_groups_csv_string():
    g = _extract_groups({"groups": " Eng , DataViz-Admins ,"})
    assert g == ("Eng", "DataViz-Admins")


def test_extract_groups_missing_returns_empty():
    assert _extract_groups({}) == ()
    assert _extract_groups({"groups": None}) == ()
    assert _extract_groups({"other": ["x"]}) == ()


def test_extract_groups_skips_non_strings():
    g = _extract_groups({"groups": ["ok", 123, "", "  ", "Eng"]})
    assert g == ("ok", "Eng")


def test_extract_auth_time_int_and_string():
    assert _extract_auth_time({"auth_time": 1729712345}) == 1729712345
    assert _extract_auth_time({"auth_time": "1729712345"}) == 1729712345
    assert _extract_auth_time({}) is None
    assert _extract_auth_time({"auth_time": "garbage"}) is None


# ── OIDC build_authorization wiring (max_age + prompt=login) ─────────


def _oidc_provider_for_test() -> OidcProvider:
    return OidcProvider(
        OidcSettings(
            enabled=True,
            issuer="https://idp.example.com",
            client_id="c1",
            client_secret="s1",
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
    # SSO_SESSION_MAX_AGE_SECONDS defaults to 24h = 86400
    assert "max_age=86400" in url
    # prompt=login is only added on force_reauth=True
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


# ── Refresh JWT carries auth_time through rotation ───────────────────


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


# ── Custom IdP envelope handling ─────────────────────────────────────


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
    assert identity.provider == "custom"
    assert identity.external_id == "S-1-5-21-1001"
    assert identity.email == "alice@corp.example"  # normalised
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
    with pytest.raises(CustomIdentityError, match="missing_external_id"):
        CustomIdentityProvider().fetch_identity(token)


def test_custom_idp_rejects_bad_groups():
    token = token_module.create_mock_identity_token({
        "external_id": "x", "email": "y@y.com", "groups": "not-a-list",
    })
    with pytest.raises(CustomIdentityError, match="groups_must_be_list"):
        CustomIdentityProvider().fetch_identity(token)


# ── LocalIdentityService.refresh — SSO daily ceiling ─────────────────


class _StubUserRepo:
    """Just enough of user_repo to drive ``refresh`` in this test."""

    def __init__(self, *, auth_provider: str = "oidc"):
        from types import SimpleNamespace
        self._user = SimpleNamespace(
            id="usr_1",
            email="alice@example.com",
            first_name="Alice",
            last_name="Doe",
            status="active",
            auth_provider=auth_provider,
            deleted_at=None,
            created_at="",
            updated_at="",
        )

    async def get_user_by_id(self, session, uid):
        return self._user if uid == "usr_1" else None

    async def get_user_roles(self, session, uid):
        return ["user"]


class _NoopRefreshStore:
    async def is_jti_revoked(self, jti):
        return False

    async def is_family_revoked(self, fam):
        return False

    async def revoke_jti(self, jti, family_id, expires_at_iso):
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

    # auth_time set so we're already past the ceiling.
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
        user_repo=_StubUserRepo(auth_provider="oidc"),
        refresh_store_factory=lambda s: store,
        session_killer=_killer,
    )
    with pytest.raises(SsoReauthRequired) as exc_info:
        await svc.refresh(rt)
    assert exc_info.value.provider == "oidc"
    assert exc_info.value.login_url.startswith("/api/v1/auth/oidc/login")
    assert "force=1" in exc_info.value.login_url
    assert killed == ["usr_1"]
    assert store.revoked_family == "fam1"


@pytest.mark.asyncio
async def test_refresh_succeeds_for_local_past_ceiling():
    """Local password sessions are exempt from the SSO ceiling."""
    from backend.auth_service.service import LocalIdentityService

    rt, _ = token_module.create_refresh_token(
        user_id="usr_1", family_id="fam1", auth_time=1,  # ancient
    )
    svc = LocalIdentityService(
        session_factory=_session_factory,
        user_repo=_StubUserRepo(auth_provider="local"),
        refresh_store_factory=lambda s: _NoopRefreshStore(),
    )
    # Should NOT raise SsoReauthRequired (local user); succeeds normally.
    user, _tokens = await svc.refresh(rt)
    assert user.id == "usr_1"


@pytest.mark.asyncio
async def test_refresh_no_auth_time_no_ceiling():
    """No auth_time means we don't know when the IdP last authenticated
    — don't punish the user. The /login path that created the family
    is responsible for stamping auth_time; absence is a degraded but
    safe state."""
    from backend.auth_service.service import LocalIdentityService

    rt, _ = token_module.create_refresh_token(
        user_id="usr_1", family_id="fam1",  # auth_time omitted
    )
    svc = LocalIdentityService(
        session_factory=_session_factory,
        user_repo=_StubUserRepo(auth_provider="oidc"),
        refresh_store_factory=lambda s: _NoopRefreshStore(),
    )
    user, _tokens = await svc.refresh(rt)
    assert user.id == "usr_1"


# ── Group->role reconciler + admin mapping repo ──────────────────────


@pytest.mark.asyncio
async def test_reconcile_creates_revokes_reactivates(db_session):
    from backend.app.db.models import RoleBindingORM
    from backend.app.db.repositories import binding_repo, idp_group_mapping_repo
    from backend.app.services.permission_service import (
        reconcile_sso_role_bindings,
    )

    # Seed two mappings: group "Eng" -> user@ws1; group "Admins" -> user@ws2.
    await idp_group_mapping_repo.create_mapping(
        db_session, idp_group="Eng",
        scope_type="workspace", scope_id="ws_1", role_name="user",
    )
    await idp_group_mapping_repo.create_mapping(
        db_session, idp_group="Admins",
        scope_type="workspace", scope_id="ws_2", role_name="user",
    )

    # First login: user is in both groups -> both bindings created.
    out = await reconcile_sso_role_bindings(
        db_session, user_id="usr_a", idp_groups=["Eng", "Admins"],
    )
    assert out["created"] == 2
    bindings = await binding_repo.list_for_subject(
        db_session, subject_type="user", subject_id="usr_a",
    )
    assert len(bindings) == 2
    assert all(getattr(b, "source", "local") == "sso" for b in bindings)
    assert all(b.expires_at is None for b in bindings)

    # Second login: user is no longer in "Admins" -> that binding is
    # soft-revoked (expires_at=now). The other reactivates / stays.
    out2 = await reconcile_sso_role_bindings(
        db_session, user_id="usr_a", idp_groups=["Eng"],
    )
    assert out2["revoked"] == 1
    bindings = await binding_repo.list_for_subject(
        db_session, subject_type="user", subject_id="usr_a",
    )
    expired = [b for b in bindings if b.expires_at is not None]
    assert len(expired) == 1
    assert expired[0].role_name == "user"
    assert expired[0].scope_id == "ws_2"

    # Third login: user is back in "Admins" -> reactivated.
    out3 = await reconcile_sso_role_bindings(
        db_session, user_id="usr_a", idp_groups=["Eng", "Admins"],
    )
    assert out3["reactivated"] == 1


@pytest.mark.asyncio
async def test_reconcile_skips_system_admin_mapping_at_apply_time(db_session):
    """Even if a mapping somehow points at system:admin (e.g. inserted
    out-of-band), the reconciler must skip it loudly."""
    from sqlalchemy import insert
    from backend.app.db.models import IdpGroupRoleMappingORM
    from backend.app.db.repositories import binding_repo
    from backend.app.services.permission_service import (
        reconcile_sso_role_bindings,
    )
    from datetime import datetime, timezone

    # Bypass the repo's write-time refusal by inserting directly.
    await db_session.execute(
        insert(IdpGroupRoleMappingORM).values(
            id="igrm_x", idp_group="EvilGroup",
            scope_type="global", scope_id=None, role_name="system:admin",
            created_at=datetime.now(timezone.utc).isoformat(), created_by=None,
        )
    )
    out = await reconcile_sso_role_bindings(
        db_session, user_id="usr_b", idp_groups=["EvilGroup"],
    )
    # Mapping matched, but creation refused at apply-time.
    assert out["mappings_matched"] == 1
    assert out["created"] == 0
    bindings = await binding_repo.list_for_subject(
        db_session, subject_type="user", subject_id="usr_b",
    )
    assert bindings == []


@pytest.mark.asyncio
async def test_mapping_repo_refuses_system_admin(db_session):
    from backend.app.db.repositories import idp_group_mapping_repo
    from backend.app.db.repositories.idp_group_mapping_repo import (
        ForbiddenSsoRoleError,
    )
    with pytest.raises(ForbiddenSsoRoleError):
        await idp_group_mapping_repo.create_mapping(
            db_session, idp_group="X",
            scope_type="global", scope_id=None, role_name="system:admin",
        )


@pytest.mark.asyncio
async def test_mapping_repo_validates_scope_consistency(db_session):
    from backend.app.db.repositories import idp_group_mapping_repo
    with pytest.raises(ValueError, match="scope_id"):
        await idp_group_mapping_repo.create_mapping(
            db_session, idp_group="X",
            scope_type="workspace", scope_id=None, role_name="user",
        )


# ── Custom-IdP route gating ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_custom_routes_404_when_disabled(test_client):
    """With AUTH_CUSTOM_PROVIDER_ENABLED=false the routes 404."""
    # Conftest's process bootstraps the app with no env override for
    # AUTH_CUSTOM_PROVIDER_ENABLED, so the routes must be 404.
    res = await test_client.get("/api/v1/auth/custom/login")
    assert res.status_code == 404


# ── Auth-provider CHECK includes 'custom' ────────────────────────────


@pytest.mark.asyncio
async def test_users_auth_provider_accepts_custom(db_session):
    """The Phase-2 migration relaxed the CHECK to include 'custom'."""
    from backend.app.db.models import UserORM
    db_session.add(UserORM(
        id="usr_test_custom",
        email="test-custom@example.com",
        password_hash="x" * 96,
        first_name="T", last_name="C",
        status="active",
        auth_provider="custom",
        external_id="ext-1",
    ))
    await db_session.flush()
    # If the CHECK still excluded 'custom', flush would raise.


# Mark the SAML provider-import test as conditional on the library
# being installed. The viz image installs it; non-viz images do not,
# and CI may skip when xmlsec1 isn't available.
@pytest.mark.skipif(
    not os.environ.get("PYTHON3_SAML_AVAILABLE", "")
    and __import__("backend.auth_service.providers", fromlist=["SAML_AVAILABLE"]).SAML_AVAILABLE is False,
    reason="python3-saml not installed in this environment",
)
def test_saml_provider_disabled_self_reports():
    from backend.auth_service.providers import SamlProvider, load_saml_settings  # type: ignore
    provider = SamlProvider(load_saml_settings())
    # No config -> provider self-reports disabled.
    assert provider.enabled is False
