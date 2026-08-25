"""The flow as described, end to end, including what happens next.

    POST auth.corporate.com/authenticate   -> a token (and a cookie)
    POST auth.corporate.com/authgateway    -> the identity
         session cookie + the token in the body under a key we define

Sign-in was never the hard part. What broke was everything after it: the
liveness check re-presents the upstream session on every rotation, and
when the row named no cookie to re-present it read `None`, concluded the
session had been revoked, and killed it — refresh family and all. A user
signed in, worked for one access lifetime, and was thrown out. Every
time.

So the assertion this file exists for is the last one: **the refresh
succeeds**. The rest is here to prove the refresh is not succeeding
because the sign-in silently did nothing.
"""
from __future__ import annotations

import time

import httpx
import pytest

from backend.app.db.repositories import idp_provider_repo
from backend.auth_service.providers import outbound

_REAL_ASYNC_CLIENT = httpx.AsyncClient

#: Recent on purpose. A fixed timestamp made the first run of this file
#: fail on the 24h SSO re-auth ceiling rather than on anything it was
#: testing — which was the ceiling working, and worth keeping visible:
#: it applies to this kind exactly as it does to the others.
IDENTITY = {
    "sub": "emp-100482",
    "email": "ada.lovelace@corporate.com",
    "firstName": "Ada",
    "lastName": "Lovelace",
    "groups": ["engineering"],
    "auth_time": int(time.time()),
}


async def _make(db_session, **over):
    settings = {
        # What /authenticate leaves behind, and what every later request
        # carries. Naming it is what buys the liveness check back.
        "token_source": "cookie",
        "token_source_key": "CORPSESSION",
        # The browser calls this one; Kerberos is answered inside it.
        "authenticate_url": "https://auth.corporate.com/authenticate",
        "authenticate_method": "POST",
        "authenticate_headers": {"X-App-ID": "app-1"},
        # We call this one, with the session cookie AND the token in the
        # body under the key they chose.
        "gateway_url": "https://auth.corporate.com/authgateway",
        "gateway_method": "POST",
        "gateway_send_as": "body",
        "gateway_body_field": "token",
        "gateway_send_ambient_cookie": True,
        # It answers with the identity, not another token.
        "exchange_url": "",
        "gateway_token_path": "",
    }
    settings.update(over)
    row = await idp_provider_repo.create_provider(
        db_session, slug="corp-gateway", display_name="Corporate Gateway",
        kind="backchannel", settings=settings, claim_mapping={},
        linking_policy="strict",
    )
    await idp_provider_repo.publish_provider(db_session, row.id)
    await db_session.commit()
    return row


def _stub(monkeypatch):
    seen: list[httpx.Request] = []

    def _dispatch(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=IDENTITY)

    monkeypatch.setattr(
        outbound.httpx, "AsyncClient",
        lambda **kw: _REAL_ASYNC_CLIENT(
            transport=httpx.MockTransport(_dispatch), **kw,
        ),
    )
    return seen


@pytest.mark.asyncio
async def test_the_gateway_gets_the_cookie_and_the_token_together(
    test_client, db_session, registry, sso_events, monkeypatch,
):
    """A gateway can authenticate the caller by cookie and still expect
    the token in the body. One carrier could not express that."""
    import json as _json

    seen = _stub(monkeypatch)
    await _make(db_session)

    resp = await test_client.get(
        "/api/v1/auth/corp-gateway/login?next=/dashboard",
        cookies={"CORPSESSION": "session-abc"},
        follow_redirects=False,
    )
    assert resp.status_code == 302, resp.text

    call = seen[0]
    assert call.url.path == "/authgateway"
    assert _json.loads(call.content) == {"token": "session-abc"}
    assert "CORPSESSION=session-abc" in call.headers.get("cookie", "")


@pytest.mark.asyncio
async def test_the_gateways_answer_becomes_the_applications_claims(
    test_client, db_session, registry, sso_events, monkeypatch,
):
    """No second call: this gateway returns the identity, so there is no
    token to point `gateway_token_path` at — and the field is blank."""
    from sqlalchemy import select
    from backend.app.db import models as _models

    seen = _stub(monkeypatch)
    await _make(db_session)

    resp = await test_client.get(
        "/api/v1/auth/corp-gateway/login",
        cookies={"CORPSESSION": "session-abc"},
        follow_redirects=False,
    )
    assert resp.status_code == 302
    assert len(seen) == 1, "a second leg was called when none is configured"
    assert "nx_access" in resp.cookies

    user = (await db_session.execute(
        select(_models.UserORM).where(
            _models.UserORM.email == "ada.lovelace@corporate.com")
    )).scalar_one_or_none()
    assert user is not None, "the identity did not reach the user table"
    assert user.first_name == "Ada"


@pytest.mark.asyncio
async def test_the_session_survives_a_refresh(
    test_client, db_session, registry, sso_events, monkeypatch,
):
    """THE assertion. Before the fix this signed the user out, revoked
    their refresh family and killed every live session — one access
    lifetime after they signed in, and again every time they signed back
    in."""
    _stub(monkeypatch)
    await _make(db_session)

    signin = await test_client.get(
        "/api/v1/auth/corp-gateway/login",
        cookies={"CORPSESSION": "session-abc"},
        follow_redirects=False,
    )
    assert signin.status_code == 302
    jar = {k: v for k, v in signin.cookies.items()}
    assert "nx_refresh" in jar

    refreshed = await test_client.post(
        "/api/v1/auth/refresh",
        cookies={**jar, "CORPSESSION": "session-abc"},
    )
    assert refreshed.status_code == 200, refreshed.text
    assert refreshed.json()["user"]["email"] == "ada.lovelace@corporate.com"


@pytest.mark.asyncio
async def test_it_still_ends_when_the_upstream_session_does(
    test_client, db_session, registry, sso_events, monkeypatch,
):
    """The other half of the same property, and the reason the check is
    worth having: naming the cookie means signing out of the portal
    signs the user out here."""
    _stub(monkeypatch)
    await _make(db_session)

    signin = await test_client.get(
        "/api/v1/auth/corp-gateway/login",
        cookies={"CORPSESSION": "session-abc"},
        follow_redirects=False,
    )
    jar = {k: v for k, v in signin.cookies.items()}

    # The corporate session is gone; the cookie no longer arrives.
    refreshed = await test_client.post("/api/v1/auth/refresh", cookies=jar)
    assert refreshed.status_code == 401
    assert refreshed.json()["detail"]["error"] == "sso_reauth_required"


@pytest.mark.asyncio
async def test_the_daily_re_auth_ceiling_applies_to_this_kind_too(
    test_client, db_session, registry, sso_events, monkeypatch,
):
    """Discovered by writing this file: the first version used a fixed
    `auth_time` and failed here rather than where it was looking. That
    was the ceiling working, and it is worth an assertion of its own —
    a session cannot outrun it by being back-channel, and an operator
    turning `require_auth_time` off quietly disables it for everyone on
    the connection.
    """
    stale = dict(IDENTITY, auth_time=int(time.time()) - 60 * 60 * 48)

    def _dispatch(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=stale)

    monkeypatch.setattr(
        outbound.httpx, "AsyncClient",
        lambda **kw: _REAL_ASYNC_CLIENT(
            transport=httpx.MockTransport(_dispatch), **kw,
        ),
    )
    await _make(db_session)

    signin = await test_client.get(
        "/api/v1/auth/corp-gateway/login",
        cookies={"CORPSESSION": "session-abc"},
        follow_redirects=False,
    )
    jar = {k: v for k, v in signin.cookies.items()}

    refreshed = await test_client.post(
        "/api/v1/auth/refresh",
        cookies={**jar, "CORPSESSION": "session-abc"},
    )
    assert refreshed.status_code == 401
    assert refreshed.json()["detail"]["error"] == "sso_reauth_required"


@pytest.mark.asyncio
async def test_the_flow_works_when_the_gateway_answers_with_a_jwt(
    test_client, db_session, registry, sso_events, monkeypatch,
):
    """The described corporate translate shape, verbatim: the session
    cookie goes out, a JWT comes back as the whole body, and its payload
    — not a JSON envelope — is the identity that lands on the profile."""
    import jwt as pyjwt

    token = pyjwt.encode(IDENTITY, "unverified-decode", algorithm="HS256")

    def _dispatch(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, content=token.encode(),
            headers={"content-type": "application/jwt"},
        )

    monkeypatch.setattr(
        outbound.httpx, "AsyncClient",
        lambda **kw: _REAL_ASYNC_CLIENT(
            transport=httpx.MockTransport(_dispatch), **kw,
        ),
    )
    await _make(db_session, claims_format="jwt")

    resp = await test_client.get(
        "/api/v1/auth/corp-gateway/login?next=/dashboard",
        cookies={"CORPSESSION": "session-abc"},
        follow_redirects=False,
    )
    assert resp.status_code == 302, resp.text
    assert "nx_access" in resp.cookies

    from sqlalchemy import select
    from backend.app.db.models import UserORM
    row = (await db_session.execute(
        select(UserORM).where(UserORM.email == "ada.lovelace@corporate.com"),
    )).scalar_one()
    assert row.first_name == "Ada"


@pytest.mark.asyncio
async def test_the_reauth_envelope_carries_what_the_recovery_needs(
    test_client, db_session, registry, sso_events, monkeypatch,
):
    """The silent re-initiation keys on two fields: the provider slug —
    to find the trigger and re-run the browser's half — and a same-origin
    login_url as the fallback. An envelope missing either downgrades the
    behind-the-scenes recovery to a visible bounce."""
    _stub(monkeypatch)
    await _make(db_session)

    signin = await test_client.get(
        "/api/v1/auth/corp-gateway/login",
        cookies={"CORPSESSION": "session-abc"},
        follow_redirects=False,
    )
    jar = {k: v for k, v in signin.cookies.items()}

    refreshed = await test_client.post("/api/v1/auth/refresh", cookies=jar)
    assert refreshed.status_code == 401
    detail = refreshed.json()["detail"]
    assert detail["error"] == "sso_reauth_required"
    assert detail["provider"] == "corp-gateway"
    assert detail["login_url"].startswith("/api/v1/auth/corp-gateway/login")


@pytest.mark.asyncio
async def test_signing_in_again_after_expiry_lands_on_the_same_profile(
    test_client, db_session, registry, sso_events, monkeypatch,
):
    """The round trip the silent recovery automates, proven at the HTTP
    layer: expire upstream, get thrown out, present a fresh corporate
    session through the JSON entry point — the one the recovery posts to
    — and come back as the same person, not a duplicate."""
    from sqlalchemy import func, select
    from backend.app.db.models import UserORM

    _stub(monkeypatch)
    await _make(db_session)

    first = await test_client.get(
        "/api/v1/auth/corp-gateway/login",
        cookies={"CORPSESSION": "session-abc"},
        follow_redirects=False,
    )
    jar = {k: v for k, v in first.cookies.items()}

    # Upstream ends; the next rotation throws the session out.
    expired = await test_client.post("/api/v1/auth/refresh", cookies=jar)
    assert expired.status_code == 401

    # The recovery's leg: a fresh corporate session, the empty-body JSON
    # entry point, no navigation.
    again = await test_client.post(
        "/api/v1/auth/corp-gateway/backchannel",
        json={},
        cookies={"CORPSESSION": "session-def"},
    )
    assert again.status_code == 200, again.text
    assert again.json()["user"]["email"] == "ada.lovelace@corporate.com"
    assert "nx_access" in again.headers.get("set-cookie", "")

    count = (await db_session.execute(
        select(func.count()).select_from(UserORM).where(
            UserORM.email == "ada.lovelace@corporate.com",
        ),
    )).scalar_one()
    assert count == 1
