"""Regression tests for the auth-surface defect sweep.

Every test here pins a bug that was live on main and invisible to the suite.
Two of them exist because the suite had a *blind spot* rather than a gap:

* ``CSRFMiddleware`` was a no-op for every test, because the shared
  ``test_client`` fixture pre-seeds both halves of the double-submit. The
  ``csrf_client`` fixture removes them so the middleware actually runs.
* The 24h SSO re-auth path was only ever exercised against a stub identity
  repo that returned an already-materialised ``provider`` attribute, hiding a
  lazy-load that raises ``MissingGreenlet`` against the real ORM.

Keep both properties in mind before "simplifying" any of these to use the
default fixtures — the default fixtures are what missed the bugs.
"""
from __future__ import annotations

import time
from contextlib import asynccontextmanager

import pytest

from backend.app.db.repositories import (
    idp_provider_repo,
    user_identity_repo,
    user_repo,
)
from backend.app.db.repositories.idp_provider_repo import ProviderValidationError
from backend.auth_service.core.tokens import create_refresh_token
from backend.auth_service.interface import SsoReauthRequired
from backend.auth_service.providers import PROVIDER_BUILDERS
from backend.auth_service.providers.registry import (
    ProviderConfigSnapshot,
    ProviderRegistry,
    configure_registry,
)
from backend.auth_service.service import LocalIdentityService


@pytest.fixture()
async def registry(db_session):
    """Wire the process registry to the per-test session.

    Without it ``_resolve_provider`` raises RuntimeError and every slug route
    503s before reaching its handler — which would let a handler-level bug
    (like the metadata NameError) pass a test unnoticed.
    """
    class _Loader:
        @staticmethod
        def _snap(row):
            return ProviderConfigSnapshot(
                id=row.id, slug=row.slug, display_name=row.display_name,
                kind=row.kind, enabled=bool(row.enabled),
                priority=int(row.priority or 100),
                settings=idp_provider_repo.decrypt_settings(row.settings),
                claim_mapping=idp_provider_repo.parse_claim_mapping(row),
                linking_policy=row.linking_policy,
                button_label=row.button_label, button_icon=row.button_icon,
            )

        async def get_by_id(self, provider_id):
            row = await idp_provider_repo.get_provider(db_session, provider_id)
            return self._snap(row) if row is not None else None

        async def get_by_slug(self, slug):
            row = await idp_provider_repo.get_provider_by_slug(db_session, slug)
            return self._snap(row) if row is not None else None

        async def list_enabled(self):
            rows = await idp_provider_repo.list_providers(
                db_session, only_enabled=True,
            )
            return [self._snap(r) for r in rows]

    reg = ProviderRegistry(loader=_Loader(), builders=PROVIDER_BUILDERS,
                           ttl_seconds=0)
    configure_registry(reg)
    yield reg
    await reg.invalidate()


# ── CSRF: the IdP-callback surface must be reachable without a token ──


@pytest.mark.asyncio
async def test_acs_is_reachable_without_a_csrf_token(csrf_client):
    """The SAML ACS is an IdP-originated cross-site form POST. There is no
    page of ours in the loop to set ``X-CSRF-Token``, so a CSRF-gated ACS
    means SP-initiated SAML login can never complete.

    Asserting "not 403" rather than a success code: with no provider row the
    route legitimately 404s. What matters is that the *middleware* let it
    through to the handler.
    """
    resp = await csrf_client.post(
        "/api/v1/auth/some-idp/acs", data={"SAMLResponse": "x"},
    )
    assert resp.status_code != 403


@pytest.mark.asyncio
async def test_browser_profile_is_reachable_without_a_csrf_token(csrf_client):
    """``/portal-login`` posts here for a user who has no session yet, so no
    ``nx_csrf`` cookie exists to submit."""
    resp = await csrf_client.post(
        "/api/v1/auth/some-idp/browser-profile", json={"payload": "x"},
    )
    assert resp.status_code != 403


@pytest.mark.asyncio
async def test_sls_and_mock_are_reachable_without_a_csrf_token(csrf_client):
    for path in ("/api/v1/auth/some-idp/sls", "/api/v1/auth/some-idp/mock"):
        resp = await csrf_client.post(path, json={})
        assert resp.status_code != 403, path


@pytest.mark.asyncio
async def test_state_changing_admin_routes_still_require_csrf(csrf_client):
    """The guard on the guard: the exemption must not have widened. If this
    ever passes-through, the pattern has grown a prefix match."""
    resp = await csrf_client.post(
        "/api/v1/admin/idp-providers",
        json={"slug": "x", "displayName": "X", "kind": "oidc"},
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_sibling_sso_routes_still_require_csrf(csrf_client):
    """Only the four callback verbs are exempt — a neighbouring path under
    the same ``/auth/{slug}/`` prefix must not inherit the exemption."""
    resp = await csrf_client.post("/api/v1/auth/some-idp/callback", json={})
    assert resp.status_code == 403


# ── SAML handshake cookies survive a cross-site POST ─────────────────


def test_saml_and_link_intent_cookies_are_scoped_for_cross_site_post():
    """``SameSite=Lax`` is withheld on a cross-site POST navigation, which is
    exactly what the SAML ACS is. Under Lax the ACS never sees ``nx_saml``
    and fails with ``missing_flow_cookie`` on every IdP.

    ``SameSite=None`` requires ``Secure``; browsers reject the pair
    otherwise, so both attributes are asserted together.
    """
    from starlette.responses import Response

    from backend.auth_service.cookies import (
        set_link_intent_cookie,
        set_saml_cookie,
    )

    for setter in (set_saml_cookie, set_link_intent_cookie):
        response = Response()
        setter(response, "a-signed-token")
        header = response.headers["set-cookie"].lower()
        assert "samesite=none" in header, setter.__name__
        assert "secure" in header, setter.__name__


def test_oidc_cookie_keeps_the_default_same_site():
    """The OIDC callback is a cross-site *GET*, which Lax permits. It must
    not be dragged along into SameSite=None."""
    from starlette.responses import Response

    from backend.auth_service.cookies import set_oidc_cookie

    response = Response()
    set_oidc_cookie(response, "a-signed-token")
    assert "samesite=none" not in response.headers["set-cookie"].lower()


# ── 24h SSO re-auth against the real ORM ─────────────────────────────


@pytest.mark.asyncio
async def test_sso_reauth_resolves_the_provider_slug_from_the_real_orm(
    db_session, monkeypatch,
):
    """``_latest_identity_slug`` reads ``identity.provider.slug``. Against the
    real ORM that is a lazy relationship, and touching it on an AsyncSession
    raises ``MissingGreenlet`` — surfacing as a 500 from ``/auth/refresh``
    instead of the structured ``sso_reauth_required`` the frontend needs, in
    a loop the user cannot escape.

    Deliberately does NOT use the stub identity repo from
    ``test_sso_phase2``: the stub hands back a ``SimpleNamespace`` with
    ``provider`` already populated, which is precisely why this was missed.
    """
    monkeypatch.setattr(
        "backend.auth_service.service.SSO_SESSION_MAX_AGE_SECONDS", 1,
    )

    provider = await idp_provider_repo.create_provider(
        db_session,
        slug="entra-staff",
        display_name="Corporate Entra ID",
        kind="oidc",
        settings={"issuer": "https://idp", "client_id": "c",
                  "client_secret": "s", "redirect_uri": "https://app/cb"},
    )
    user = await user_repo.create_user(
        db_session, email="sso@corp.example", password_hash="x",
        first_name="S", last_name="O", status="active",
    )
    await user_identity_repo.create_identity(
        db_session, user_id=user.id, provider_id=provider.id,
        external_id="sub-1", email_at_link="sso@corp.example",
    )
    await db_session.commit()
    # Load-bearing: rows created in this session sit in SQLAlchemy's identity
    # map, and a lazy load satisfied from the map never touches IO — so
    # without this the test passes even with the eager load removed. Expunging
    # forces the real query path production takes.
    db_session.expunge_all()

    @asynccontextmanager
    async def _factory():
        yield db_session

    class _Store:
        """Minimal in-memory RefreshStore — the rotation bookkeeping is not
        what's under test here, the provider-slug lookup is."""
        async def is_family_revoked(self, *a, **k):
            return False

        async def is_jti_revoked(self, *a, **k):
            return False

        async def revoke_jti(self, *a, **k):
            return None

        async def revoke_family(self, *a, **k):
            return None

    svc = LocalIdentityService(
        session_factory=_factory,
        user_repo=user_repo,
        user_identity_repo=user_identity_repo,
        refresh_store_factory=lambda s: _Store(),
    )

    # A refresh token whose IdP-attested auth_time is already past the ceiling.
    token, _claims = create_refresh_token(
        user_id=user.id, family_id="fam-1", auth_time=int(time.time()) - 3600,
    )

    with pytest.raises(SsoReauthRequired) as exc:
        await svc.refresh(token)

    # The slug is what makes the bounce land on the right IdP; resolving it is
    # the exact step that used to blow up.
    assert exc.value.provider == "entra-staff"
    assert "entra-staff" in str(exc.value.login_url)


@pytest.mark.asyncio
async def test_list_for_user_eager_loads_the_provider(db_session):
    """Pins the fix at its source, so a future refactor of the repo can't
    quietly drop the eager load and reintroduce the 500 loop."""
    provider = await idp_provider_repo.create_provider(
        db_session, slug="okta-prod", display_name="Okta", kind="oidc",
        settings={"issuer": "https://idp", "client_id": "c",
                  "client_secret": "s", "redirect_uri": "https://app/cb"},
    )
    user = await user_repo.create_user(
        db_session, email="eager@corp.example", password_hash="x",
        first_name="E", last_name="L", status="active",
    )
    await user_identity_repo.create_identity(
        db_session, user_id=user.id, provider_id=provider.id,
        external_id="sub-9", email_at_link="eager@corp.example",
    )
    await db_session.commit()
    db_session.expunge_all()   # force a genuine load, not the identity map

    identities = await user_identity_repo.list_for_user(db_session, user.id)
    assert identities[0].provider.slug == "okta-prod"


# ── Rate limiting returns 429, not 500 ───────────────────────────────


def test_rate_limit_handler_has_a_limiter_to_read():
    """slowapi's 429 handler dereferences ``request.app.state.limiter``. With
    it unset the *handler* raises AttributeError, so a rate-limit breach
    returns a 500 with a stack trace instead of a 429 — on every rate-limited
    auth endpoint."""
    from backend.app.main import app
    from backend.auth_service.api.router import limiter as auth_limiter

    assert getattr(app.state, "limiter", None) is not None
    # Same instance the routes decorate with, so the limit that fired and the
    # headers on the response can't drift apart.
    assert app.state.limiter is auth_limiter


def test_auth_endpoints_share_one_limiter():
    from backend.app.api.v1.endpoints.auth import limiter as app_limiter
    from backend.auth_service.api.router import limiter as auth_limiter

    assert app_limiter is auth_limiter


# ── SAML SP metadata ─────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_saml_metadata_route_reaches_its_handler(
    test_client, db_session, registry,
):
    """``saml_metadata`` used ``request`` without declaring it, so this route
    raised NameError -> 500 on every call. It is the route an operator needs
    to register the SP at the IdP, so SAML onboarding could never start.

    Pointed at a real (non-SAML) row so the assertion is specific: reaching
    "Not a SAML provider" proves the handler executed past ``_resolve_provider``.
    A 500, or a 503 from an unconfigured registry, would not.
    """
    await idp_provider_repo.create_provider(
        db_session, slug="entra-md", display_name="Entra", kind="oidc",
        settings={"issuer": "https://idp", "client_id": "c",
                  "client_secret": "s", "redirect_uri": "https://app/cb"},
    )
    await db_session.commit()

    resp = await test_client.get("/api/v1/auth/entra-md/metadata")
    assert resp.status_code == 404
    assert "Not a SAML provider" in resp.text


# ── custom_profile self-service linking ──────────────────────────────


@pytest.mark.asyncio
async def test_custom_profile_can_start_a_self_service_link(
    test_client, db_session,
):
    """The SSO callback already honours a link intent for custom_profile, but
    the endpoint that *sets* the intent rejected the kind — so the feature was
    implemented and unreachable."""
    await idp_provider_repo.create_provider(
        db_session,
        slug="corp-portal",
        display_name="Corporate Portal",
        kind="custom_profile",
        settings={"source": "cookie", "source_key": "corp_profile",
                  "shared_secret": "s" * 48},
    )
    await db_session.commit()

    resp = await test_client.post(
        "/api/v1/me/identities/link/corp-portal/start",
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["providerKind"] == "custom_profile"
    assert body["loginUrl"] == "/api/v1/auth/corp-portal/login?next=/me/identities"


# ── Redaction marker must never be stored as a real secret ───────────


@pytest.mark.asyncio
async def test_patching_back_a_redacted_secret_is_refused(db_session):
    """``redact_settings`` puts ``********`` on the wire and
    ``update_provider`` MERGES, so a plain GET-mutate-PATCH round-trip from a
    script would overwrite the real secret with the mask and brick the IdP.
    The admin UI strips it client-side; that is not an invariant.
    """
    row = await idp_provider_repo.create_provider(
        db_session, slug="entra", display_name="Entra", kind="oidc",
        settings={"issuer": "https://idp", "client_id": "c",
                  "client_secret": "the-real-secret",
                  "redirect_uri": "https://app/cb"},
    )
    await db_session.flush()

    redacted = idp_provider_repo.redact_settings(
        idp_provider_repo.decrypt_settings(row.settings)
    )
    assert redacted["client_secret"] == "********"

    with pytest.raises(ProviderValidationError, match="redaction marker"):
        await idp_provider_repo.update_provider(
            db_session, row.id, display_name="Renamed", settings=redacted,
        )

    # And the stored secret is untouched.
    fresh = await idp_provider_repo.get_provider(db_session, row.id)
    assert idp_provider_repo.decrypt_settings(fresh.settings)["client_secret"] \
        == "the-real-secret"


@pytest.mark.asyncio
async def test_omitting_a_secret_keeps_it_and_sending_one_rotates_it(db_session):
    """The two legitimate paths must both still work — the guard rejects only
    the marker, not every secret write."""
    row = await idp_provider_repo.create_provider(
        db_session, slug="entra2", display_name="Entra", kind="oidc",
        settings={"issuer": "https://idp", "client_id": "c",
                  "client_secret": "original", "redirect_uri": "https://app/cb"},
    )
    await db_session.flush()

    await idp_provider_repo.update_provider(
        db_session, row.id, settings={"issuer": "https://idp2"},
    )
    kept = idp_provider_repo.decrypt_settings(
        (await idp_provider_repo.get_provider(db_session, row.id)).settings
    )
    assert kept["client_secret"] == "original"
    assert kept["issuer"] == "https://idp2"

    await idp_provider_repo.update_provider(
        db_session, row.id, settings={"client_secret": "rotated"},
    )
    rotated = idp_provider_repo.decrypt_settings(
        (await idp_provider_repo.get_provider(db_session, row.id)).settings
    )
    assert rotated["client_secret"] == "rotated"


@pytest.mark.asyncio
async def test_creating_with_the_marker_is_refused(db_session):
    """Cloning a provider by GET-then-POST is the other route to the same
    corruption."""
    with pytest.raises(ProviderValidationError, match="redaction marker"):
        await idp_provider_repo.create_provider(
            db_session, slug="cloned", display_name="Cloned", kind="oidc",
            settings={"issuer": "https://idp", "client_secret": "********"},
        )


# ── Master kill-switch must fail closed ──────────────────────────────


@pytest.mark.asyncio
async def test_sso_kill_switch_fails_closed_on_a_broken_config_provider(
    test_client,
):
    """``_require_sso_enabled`` used to wrap the *await* in
    ``except AttributeError``, so an AttributeError raised inside
    ``auth_config()`` read as "SSO is enabled". An operator turns SSO off, a
    partly-broken config provider swallows it, and every ``/auth/{slug}/*``
    route stays live.

    The route must now surface the error rather than silently continuing.
    """
    from backend.app.main import app

    class _BrokenConfigService:
        async def auth_config(self):
            raise AttributeError("'NoneType' object has no attribute 'sso_enabled'")

    previous = app.state.identity_service
    app.state.identity_service = _BrokenConfigService()
    try:
        resp = await test_client.get("/api/v1/auth/some-idp/login")
        # Anything but a 302 into the SSO flow. A 500 is honest here; a
        # working login page is not.
        assert resp.status_code >= 400
    finally:
        app.state.identity_service = previous


@pytest.mark.asyncio
async def test_legacy_service_without_auth_config_still_works(
    test_client, registry,
):
    """The compatibility path the old ``except AttributeError`` existed for:
    a service that genuinely has no ``auth_config`` attribute is treated as
    "SSO enabled", not as an error."""
    from backend.app.main import app

    class _LegacyService:
        pass

    previous = app.state.identity_service
    app.state.identity_service = _LegacyService()
    try:
        resp = await test_client.get("/api/v1/auth/no-such-idp/login")
        # Reached provider resolution and 404'd there — not a config error.
        assert resp.status_code == 404
    finally:
        app.state.identity_service = previous


# ── buttonIcon must be renderable, not just storable ─────────────────


@pytest.mark.parametrize("icon", [
    "https://cdn.example.com/logo.png",
    "http://intranet/logo.png",
    "//cdn.example.com/logo.png",     # protocol-relative is still remote
])
@pytest.mark.asyncio
async def test_a_remote_button_icon_is_refused(db_session, icon):
    """The app serves ``img-src 'self' data: blob:``, so a remote icon is
    blocked by the browser and renders as a broken image with nothing
    explaining why. Refusing it here is the only place we can say so.

    It is also a privacy leak: the login page is anonymous, so a remote
    icon hands a third party the IP of everyone who loads it.
    """
    with pytest.raises(idp_provider_repo.ProviderValidationError) as exc:
        await idp_provider_repo.create_provider(
            db_session, slug="icon-remote", display_name="X", kind="oidc",
            settings={"issuer": "https://idp"}, button_icon=icon,
        )
    assert "Content-Security-Policy" in str(exc.value)


@pytest.mark.parametrize("icon", [
    "data:image/svg+xml;base64,PHN2Zy8+",
    "data:image/png;base64,iVBORw0KGgo=",
    "/static/idp/entra.svg",
    None,
])
@pytest.mark.asyncio
async def test_a_renderable_button_icon_is_accepted(db_session, icon):
    row = await idp_provider_repo.create_provider(
        db_session, slug=f"icon-ok-{abs(hash(icon)) % 1000}",
        display_name="X", kind="oidc",
        settings={"issuer": "https://idp"}, button_icon=icon,
    )
    assert row.button_icon == (icon or None)


@pytest.mark.asyncio
async def test_the_update_path_is_guarded_too(db_session):
    """Create and update are separate entry points; a guard on one is not
    a guard."""
    row = await idp_provider_repo.create_provider(
        db_session, slug="icon-update", display_name="X", kind="oidc",
        settings={"issuer": "https://idp"},
    )
    with pytest.raises(idp_provider_repo.ProviderValidationError):
        await idp_provider_repo.update_provider(
            db_session, row.id, button_icon="https://cdn.example.com/x.png",
        )
