"""``GET /auth/{slug}/login`` for a back-channel row.

The route is a plain redirect flow with no handshake cookie, because
there is no handshake — the user is already signed in upstream and the
whole exchange happens server-to-server between this request and the
response to it.

What is worth pinning at this layer rather than at the provider's: that
nothing about the configuration reaches the browser, that a row nobody
published makes no outbound call at all, and that the failure a user
actually meets is generic while the reason is recorded.
"""
from __future__ import annotations

import re

import httpx
import pytest

from backend.app.db.repositories import idp_provider_repo
from backend.auth_service.providers import outbound
from backend.auth_service.providers.base import ProviderIdentity

_REAL_ASYNC_CLIENT = httpx.AsyncClient

CLAIMS = {
    "sub": "emp-1", "email": "alice@corp.example",
    "firstName": "Alice", "lastName": "Anders",
    "auth_time": 1_700_000_000,
}


async def _make_provider(db_session, *, lifecycle="live", **over):
    settings = {
        "token_source": "cookie", "token_source_key": "corp_session",
        "gateway_url": "https://gw.corp.example/redeem",
        "gateway_send_as": "cookie",
        "gateway_token_path": "access_token",
        "exchange_url": "https://gw.corp.example/userinfo",
        "gateway_headers": {"X-App-Id": "app-1", "X-App-Secret": "s3cr3t"},
    }
    settings.update(over)
    row = await idp_provider_repo.create_provider(
        db_session, slug="corp-gateway", display_name="Corporate Gateway",
        kind="backchannel", settings=settings, claim_mapping={},
        linking_policy="strict",
    )
    if lifecycle == "live":
        await idp_provider_repo.publish_provider(db_session, row.id)
    await db_session.commit()
    return row


def _stub_gateway(monkeypatch):
    """Answer both legs, and record that they were reached."""
    seen: list[httpx.Request] = []

    def _dispatch(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path.endswith("/redeem"):
            return httpx.Response(200, json={"access_token": "gw-token"})
        return httpx.Response(200, json=CLAIMS)

    monkeypatch.setattr(
        outbound.httpx, "AsyncClient",
        lambda **kw: _REAL_ASYNC_CLIENT(
            transport=httpx.MockTransport(_dispatch), **kw,
        ),
    )
    return seen


# ── the happy path ───────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_an_ambient_cookie_is_enough_to_sign_in(
    test_client, db_session, registry, sso_events, monkeypatch,
):
    seen = _stub_gateway(monkeypatch)
    await _make_provider(db_session)

    resp = await test_client.get(
        "/api/v1/auth/corp-gateway/login?next=/dashboard",
        cookies={"corp_session": "ambient-xyz"},
        follow_redirects=False,
    )
    assert resp.status_code == 302, resp.text
    assert resp.headers["location"] == "/dashboard"
    assert "nx_access" in resp.cookies
    assert [r.url.path for r in seen] == ["/redeem", "/userinfo"]


@pytest.mark.asyncio
async def test_a_hostile_next_cannot_send_the_user_off_site(
    test_client, db_session, registry, sso_events, monkeypatch,
):
    _stub_gateway(monkeypatch)
    await _make_provider(db_session)

    resp = await test_client.get(
        "/api/v1/auth/corp-gateway/login?next=https://evil.example/steal",
        cookies={"corp_session": "ambient-xyz"},
        follow_redirects=False,
    )
    assert resp.status_code == 302
    assert resp.headers["location"] == "/"


# ── failures the user meets ──────────────────────────────────────────

@pytest.mark.asyncio
async def test_no_ambient_cookie_bounces_without_calling_anyone(
    test_client, db_session, registry, monkeypatch,
):
    seen = _stub_gateway(monkeypatch)
    await _make_provider(db_session)

    resp = await test_client.get(
        "/api/v1/auth/corp-gateway/login", follow_redirects=False,
    )
    assert resp.status_code == 302
    location = resp.headers["location"]
    assert location.startswith("/login?")
    assert "sso_error=1" in location
    # Generic to the user, with a ref they can quote to an admin who can
    # look the real reason up.
    assert re.search(r"ref=[0-9a-f]{8}", location)
    assert seen == []


@pytest.mark.asyncio
async def test_an_upstream_failure_is_generic_to_the_user(
    test_client, db_session, registry, monkeypatch,
):
    """The gateway's own error text is not the user's business, and is
    not the browser's either."""
    monkeypatch.setattr(
        outbound.httpx, "AsyncClient",
        lambda **kw: _REAL_ASYNC_CLIENT(
            transport=httpx.MockTransport(
                lambda r: httpx.Response(500, content=b"INTERNAL DETAIL"),
            ), **kw,
        ),
    )
    await _make_provider(db_session)

    resp = await test_client.get(
        "/api/v1/auth/corp-gateway/login",
        cookies={"corp_session": "ambient-xyz"},
        follow_redirects=False,
    )
    assert resp.status_code == 302
    assert "INTERNAL DETAIL" not in resp.headers["location"]
    assert "nx_access" not in resp.cookies


# ── nothing about the row reaches the browser ────────────────────────

@pytest.mark.asyncio
async def test_the_public_catalog_exposes_nothing_without_a_trigger(
    test_client, db_session, registry,
):
    """``_public_config`` sits next to a decrypted settings blob holding
    the gateway URLs and whatever credentials their headers carry. A row
    with no sign-in trigger needs the browser to know nothing at all, so
    it publishes nothing at all."""
    await _make_provider(db_session)

    resp = await test_client.get("/api/v1/auth/providers")
    entry = next(p for p in resp.json() if p["slug"] == "corp-gateway")
    assert entry.get("config") in (None, {})

    blob = resp.text
    for secret in ("s3cr3t", "gw.corp.example", "corp_session",
                   "X-App-Secret", "access_token"):
        assert secret not in blob, f"{secret!r} reached the login page"


@pytest.mark.asyncio
async def test_a_trigger_publishes_exactly_four_keys_and_no_others(
    test_client, db_session, registry,
):
    """The browser cannot make the authenticate call without the URL,
    the method and the headers, so those are published. Everything else
    in that settings blob is a server-side fact.

    Asserted by iterating the stored settings rather than by naming the
    forbidden keys: a denylist would publish the next setting somebody
    adds, which is exactly how this kind of leak happens.
    """
    await _make_provider(
        db_session,
        authenticate_url="https://sso.corp.example/authenticate",
        authenticate_method="POST",
        authenticate_headers={"X-App-Id": "app-1"},
    )

    resp = await test_client.get("/api/v1/auth/providers")
    entry = next(p for p in resp.json() if p["slug"] == "corp-gateway")
    config = entry.get("config") or {}

    assert set(config) == {
        "authenticateUrl", "authenticateMethod", "authenticateHeaders",
    }

    published = {"authenticate_url", "authenticate_method",
                 "authenticate_headers", "authenticate_token_path"}
    stored = await idp_provider_repo.get_provider_by_slug(
        db_session, "corp-gateway",
    )
    settings = idp_provider_repo.decrypt_settings(stored.settings)
    for key, value in settings.items():
        if key in published or not isinstance(value, str) or not value:
            continue
        assert value not in resp.text, (
            f"settings[{key!r}] = {value!r} reached the sign-in page"
        )


@pytest.mark.asyncio
async def test_turning_the_trigger_off_publishes_nothing(
    test_client, db_session, registry,
):
    """The off switch, enforced where it has to be.

    A browser that is told nothing makes no call, so publishing nothing
    IS the switch — there is no client-side flag to respect or forget to
    respect.
    """
    await _make_provider(
        db_session,
        authenticate_enabled=False,
        authenticate_url="https://sso.corp.example/authenticate",
        authenticate_headers={"X-App-Id": "app-1"},
    )

    resp = await test_client.get("/api/v1/auth/providers")
    entry = next(p for p in resp.json() if p["slug"] == "corp-gateway")
    assert entry.get("config") in (None, {})
    assert "sso.corp.example" not in resp.text


@pytest.mark.asyncio
async def test_turning_it_off_does_not_lose_the_configuration(
    test_client, db_session, registry,
):
    """Which is the whole reason it is a switch rather than clearing the
    URL. An operator turning the trigger off during an incident should
    not have to retype their integration to turn it back on."""
    await _make_provider(
        db_session,
        authenticate_enabled=False,
        authenticate_url="https://sso.corp.example/authenticate",
        authenticate_headers={"X-App-Id": "app-1"},
    )

    resp = await test_client.get("/api/v1/admin/idp-providers")
    row = next(p for p in resp.json() if p["slug"] == "corp-gateway")
    settings = row["settings"]
    stored = settings.get("authenticateUrl") or settings.get("authenticate_url")
    assert stored == "https://sso.corp.example/authenticate"


@pytest.mark.asyncio
async def test_the_gateway_credentials_never_reach_the_browser(
    test_client, db_session, registry,
):
    """``authenticate_headers`` is public by construction and sits beside
    two fields with almost the same name that must never be. Pinning the
    distinction, because an operator who types a credential into the
    wrong one has published it to every visitor of the sign-in page."""
    await _make_provider(
        db_session,
        authenticate_url="https://sso.corp.example/authenticate",
        authenticate_headers={"X-App-Id": "public-tracking-id"},
        gateway_headers={"X-App-Secret": "SERVER-SIDE-ONLY"},
        exchange_headers={"X-Other-Secret": "ALSO-SERVER-SIDE"},
    )

    resp = await test_client.get("/api/v1/auth/providers")
    assert "public-tracking-id" in resp.text
    assert "SERVER-SIDE-ONLY" not in resp.text
    assert "ALSO-SERVER-SIDE" not in resp.text


@pytest.mark.asyncio
async def test_the_admin_view_redacts_the_credential_headers(
    test_client, db_session, registry,
):
    """We cannot know which of an operator's own header names is the
    sensitive one, so the whole container is redacted rather than a
    guessed list of keys inside it."""
    await _make_provider(db_session)

    resp = await test_client.get("/api/v1/admin/idp-providers")
    row = next(p for p in resp.json() if p["slug"] == "corp-gateway")
    assert "s3cr3t" not in resp.text
    # The gateway URL is not a secret — an operator has to be able to
    # read back what they configured.
    assert row["settings"]["gatewayUrl" if "gatewayUrl" in row["settings"]
                            else "gateway_url"]
