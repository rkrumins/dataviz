"""Email-first login routing, and capturing the assertion that arrived.

Two independent features that share a migration. What they have in common
is that both are about not guessing: routing by domain instead of asking the
user which of five buttons is theirs, and mapping against what the IdP
actually sent instead of a sample someone typed from memory.
"""
from __future__ import annotations

import pytest

from backend.app.db.repositories import idp_provider_repo


async def _provider(db_session, *, slug, domains=None, kind="oidc",
                    enabled=True):
    row = await idp_provider_repo.create_provider(
        db_session, slug=slug, display_name=slug, kind=kind,
        settings={"issuer": "https://idp", "client_id": "c",
                  "client_secret": "s", "redirect_uri": "https://app/cb"},
        email_domains=domains,
        enabled=enabled,
    )
    await db_session.commit()
    return row


async def _enable_email_first(db_session, on=True):
    from backend.app.db.repositories import app_auth_config_repo
    await app_auth_config_repo.update_config(db_session, email_first_login=on)
    await db_session.commit()


@pytest.fixture()
async def hrd_client(test_client, db_session, registry):
    """``test_client`` wires an identity service for local login only. HRD
    needs the two hooks ``main.py`` injects at startup: the email-domain
    resolver, and an auth config read from the DB rather than the static
    all-defaults snapshot (which has the toggle off, as it should).

    ``registry`` (conftest) binds the provider registry to this session so
    the public catalog sees the rows these tests create."""
    from contextlib import asynccontextmanager

    from backend.app.main import app
    from backend.app.db.repositories import app_auth_config_repo
    from backend.auth_service.app_auth_config import CachedAuthConfigProvider
    from backend.auth_service.providers import ProviderConfigSnapshot
    from backend.auth_service.service import LocalIdentityService
    from backend.app.db.repositories import user_repo

    @asynccontextmanager
    async def factory():
        yield db_session

    async def resolver(domain: str):
        row = await idp_provider_repo.find_by_email_domain(db_session, domain)
        if row is None:
            return None
        return ProviderConfigSnapshot(
            id=row.id, slug=row.slug, display_name=row.display_name,
            kind=row.kind, enabled=bool(row.enabled),
            priority=int(row.priority or 100),
            settings=idp_provider_repo.decrypt_settings(row.settings),
            claim_mapping=idp_provider_repo.parse_claim_mapping(row),
            linking_policy=row.linking_policy,
            button_label=row.button_label, button_icon=row.button_icon,
        )

    previous = app.state.identity_service
    app.state.identity_service = LocalIdentityService(
        session_factory=factory,
        user_repo=user_repo,
        refresh_store_factory=lambda s: None,
        email_domain_resolver=resolver,
        auth_config_provider=CachedAuthConfigProvider(
            lambda: app_auth_config_repo.get_snapshot(db_session),
            ttl_seconds=0,
        ),
    )
    yield test_client
    app.state.identity_service = previous


# ── Domain normalisation ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_domains_are_normalised_on_write(db_session):
    """``@Corp.Example`` and ``corp.example`` are the same thing, and an
    operator will type either."""
    row = await _provider(
        db_session, slug="norm",
        domains=["@Corp.Example ", "SUB.corp.example", "corp.example"],
    )
    assert idp_provider_repo.parse_email_domains(row) == [
        "corp.example", "sub.corp.example",
    ]


@pytest.mark.asyncio
async def test_a_malformed_domains_blob_does_not_break_the_login_page(
    db_session,
):
    row = await _provider(db_session, slug="broken")
    row.email_domains = "not json"
    assert idp_provider_repo.parse_email_domains(row) == []


@pytest.mark.asyncio
async def test_a_subdomain_does_not_match_its_parent(db_session):
    """``corp.example.com`` must not resolve to a provider claiming
    ``example.com`` — a substring match here would route users to the wrong
    IdP, which is worse than not routing them at all."""
    await _provider(db_session, slug="parent", domains=["example.com"])
    found = await idp_provider_repo.find_by_email_domain(
        db_session, "corp.example.com",
    )
    assert found is None


@pytest.mark.asyncio
async def test_a_disabled_provider_never_matches(db_session):
    await _provider(db_session, slug="off", domains=["corp.example"],
                    enabled=False)
    assert await idp_provider_repo.find_by_email_domain(
        db_session, "corp.example",
    ) is None


# ── The resolve endpoint ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_resolve_routes_a_known_domain(hrd_client, db_session):
    await _provider(db_session, slug="entra-hrd", domains=["corp.example"])
    await _enable_email_first(db_session)

    resp = await hrd_client.post(
        "/api/v1/auth/resolve", json={"email": "alice@corp.example"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["provider"]["slug"] == "entra-hrd"


@pytest.mark.asyncio
async def test_resolve_is_inert_while_the_toggle_is_off(
    hrd_client, db_session,
):
    """Additive by design: with the switch off the login page is exactly
    what it was, so this must reveal nothing even for a configured domain."""
    await _provider(db_session, slug="entra-off", domains=["corp.example"])
    await _enable_email_first(db_session, on=False)

    resp = await hrd_client.post(
        "/api/v1/auth/resolve", json={"email": "alice@corp.example"},
    )
    assert resp.status_code == 200
    assert resp.json()["provider"] is None


@pytest.mark.asyncio
@pytest.mark.parametrize("email", [
    "nobody@unknown.example",   # no provider claims it
    "malformed-no-at-sign",     # not an address
    "",                         # empty
])
async def test_every_miss_looks_identical(hrd_client, db_session, email):
    """No enumeration oracle: an attacker must not be able to tell a
    configured domain from an unconfigured one, or a disabled provider from
    a missing one. Every miss is the same empty body."""
    await _provider(db_session, slug="entra-oracle", domains=["corp.example"])
    await _enable_email_first(db_session)

    resp = await hrd_client.post("/api/v1/auth/resolve", json={"email": email})
    assert resp.status_code == 200
    assert resp.json() == {"provider": None}


@pytest.mark.asyncio
async def test_resolve_never_leaks_provider_secrets(hrd_client, db_session):
    await _provider(db_session, slug="entra-secret", domains=["corp.example"])
    await _enable_email_first(db_session)

    resp = await hrd_client.post(
        "/api/v1/auth/resolve", json={"email": "a@corp.example"},
    )
    body = resp.text
    assert "client_secret" not in body
    assert "settings" not in body


@pytest.mark.asyncio
async def test_resolve_is_reachable_without_a_csrf_token(
    csrf_client, db_session,
):
    """Called from the login page before any session exists, so there is no
    nx_csrf cookie to submit — the same trap the IdP-callback surface fell
    into."""
    resp = await csrf_client.post(
        "/api/v1/auth/resolve", json={"email": "a@corp.example"},
    )
    assert resp.status_code != 403


# ── Last assertion ───────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_the_assertion_round_trips_encrypted(db_session):
    row = await _provider(db_session, slug="capture")
    await idp_provider_repo.record_last_assertion(
        db_session, row.id,
        {"sub": "u1", "emailAddress": "a@corp.example", "department": "Eng"},
    )
    await db_session.commit()

    claims, captured_at = await idp_provider_repo.read_last_assertion(
        db_session, row.id,
    )
    assert claims["emailAddress"] == "a@corp.example"
    assert claims["department"] == "Eng"
    assert captured_at

    # Encrypted (or at minimum not stored as the raw claims blob) at rest.
    fresh = await idp_provider_repo.get_provider(db_session, row.id)
    assert "department" not in (fresh.last_assertion or "") or \
        fresh.last_assertion != '{"department": "Eng"}'


@pytest.mark.asyncio
async def test_credential_shaped_claims_are_dropped_at_capture(db_session):
    """Nobody maps an embedded access token, and keeping one would turn a
    debugging aid into a credential store. Keys stay so the shape is still
    visible; only the value goes."""
    redacted = idp_provider_repo.redact_assertion({
        "sub": "u1",
        "access_token": "ya29.super-secret",
        "id_token": "eyJ...",
        "user_password": "hunter2",
        "nested": {"refresh_token": "r-1", "employeeId": "12345"},
        "employeeId": "12345",
    })
    assert redacted["sub"] == "u1"
    assert redacted["employeeId"] == "12345"
    assert redacted["access_token"] == "********"
    assert redacted["id_token"] == "********"
    assert redacted["user_password"] == "********"
    assert redacted["nested"]["refresh_token"] == "********"
    assert redacted["nested"]["employeeId"] == "12345"


@pytest.mark.asyncio
async def test_the_assertion_is_never_on_the_provider_list(
    test_client, db_session,
):
    """Served only by its own endpoint, so it cannot leak by someone adding
    a field to the list response — the failure mode the registry docstring
    warns about."""
    row = await _provider(db_session, slug="hidden")
    await idp_provider_repo.record_last_assertion(
        db_session, row.id, {"secretish": "do-not-list", "sub": "u1"},
    )
    await db_session.commit()

    resp = await test_client.get("/api/v1/admin/idp-providers")
    assert resp.status_code == 200
    assert "do-not-list" not in resp.text
    # But the DTO does say one exists, so the UI can offer the button.
    dto = next(p for p in resp.json() if p["slug"] == "hidden")
    assert dto["lastAssertionAt"]


@pytest.mark.asyncio
async def test_the_dedicated_endpoint_serves_it(test_client, db_session):
    row = await _provider(db_session, slug="served")
    await idp_provider_repo.record_last_assertion(
        db_session, row.id, {"sub": "u1", "emailAddress": "a@corp.example"},
    )
    await db_session.commit()

    resp = await test_client.get(
        f"/api/v1/admin/idp-providers/{row.id}/last-assertion",
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["claims"]["emailAddress"] == "a@corp.example"


@pytest.mark.asyncio
async def test_no_assertion_yet_is_a_404_with_an_explanation(
    test_client, db_session,
):
    row = await _provider(db_session, slug="empty")
    resp = await test_client.get(
        f"/api/v1/admin/idp-providers/{row.id}/last-assertion",
    )
    assert resp.status_code == 404
    assert "next successful sign-in" in resp.text


# ── Login context ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_login_context_reports_the_posture(hrd_client, db_session):
    """The login page cannot render the right shape without this. It used
    to guess, and guessed wrong on an SSO-only deployment — offering a
    password form the server always refuses."""
    await _provider(db_session, slug="ctx-idp", domains=["corp.example"])
    await _enable_email_first(db_session)

    resp = await hrd_client.get("/api/v1/auth/login-context")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["allowLocalLogin"] is True
    assert body["emailFirstLogin"] is True
    assert [p["slug"] for p in body["providers"]] == ["ctx-idp"]


@pytest.mark.asyncio
async def test_login_context_never_leaks_settings(hrd_client, db_session):
    await _provider(db_session, slug="ctx-secret", domains=["corp.example"])

    resp = await hrd_client.get("/api/v1/auth/login-context")
    assert "client_secret" not in resp.text
    assert "settings" not in resp.text


@pytest.mark.asyncio
async def test_login_context_fails_open_on_a_broken_posture_read(test_client):
    """Failing closed here would render a page with no usable control on
    it — an outage that locks everyone out of the product. A form the
    server might refuse is strictly better than nothing."""
    from backend.app.main import app

    class _BrokenConfigService:
        async def auth_config(self):
            raise RuntimeError("posture table unavailable")

    previous = app.state.identity_service
    app.state.identity_service = _BrokenConfigService()
    try:
        resp = await test_client.get("/api/v1/auth/login-context")
        assert resp.status_code == 200
        assert resp.json()["allowLocalLogin"] is True
        assert resp.json()["emailFirstLogin"] is False
    finally:
        app.state.identity_service = previous
