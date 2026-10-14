"""People who sign in through an Enterprise gateway make API keys — with no
administrator switch, and never on a company session the gateway no longer
vouches for.

A gateway rarely says when its person entered a credential, so its sign-in is
never "proven" the way an OIDC or SAML one is. Creating or rotating a key asks
the gateway the session came from instead:

* server exchange — the company session reaches this server: the gateway is
  asked, on the create or rotate request itself, whether it is still live.
  Confirmed mints; ended or absent sends the person to sign in through it
  again; no answer mints nothing (503) — it fails closed;
* browser exchange — only the browser holds the company session: a sign-in
  through the gateway in the last few minutes is the gateway's answer; an
  older session is sent through it again, and comes back able to.

Through the real routes — the gateway sign-ins, and the create, rotate and
options routes — against stubbed gateways.
"""
from __future__ import annotations

import json
import time
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import httpx
import pytest
from sqlalchemy import func, select

from backend.app.api.v1.endpoints import api_keys as api_keys_endpoints
from backend.app.db.models import ApiKeyORM, OutboxEventORM, UserIdentityORM
from backend.app.db.repositories import idp_provider_repo
from backend.auth_service.cookies import CSRF_COOKIE_NAME
from backend.auth_service.csrf import CSRF_HEADER_NAME
from backend.auth_service.providers import outbound
from backend.tests.test_sso_backchannel_browser_exchange import (
    _REAL_ASYNC_CLIENT,
    _assertion,
    _jwk,
    _make_row,
)
from tests.common.api_key_world import (
    OWNER,
    api_key_app,
    confirmed_down,
    days_ago,
    error,
    mint,
)

GATEWAY_LOGIN = "/api/v1/auth/corp-gateway/login?next=/me/api-keys&force=1"
BROWSER_LOGIN = "/api/v1/auth/corp-browser/login?next=/me/api-keys&force=1"

#: What the server-mode gateway says about its person: the key owner, last
#: through the company portal two hours ago — long before the window a
#: proven sign-in would need, which a live gateway does not.
CLAIMS = {
    "sub": "emp-owner", "email": f"{OWNER}@example.com",
    "firstName": "Key", "lastName": "Owner",
    "lastLogin": int(time.time()) - 7200,
}


class _Gateway:
    """The company gateway: one stub for its sign-ins, its liveness checks
    and its signing keys. ``answer`` is what ``/redeem`` says next."""

    def __init__(self, monkeypatch):
        self.answer: object = 200
        self.redeemed = 0

        def _dispatch(request: httpx.Request) -> httpx.Response:
            path = request.url.path
            if path.endswith("/redeem"):
                self.redeemed += 1
                if self.answer == "timeout":
                    raise httpx.ConnectTimeout("no answer", request=request)
                if self.answer != 200:
                    return httpx.Response(self.answer)
                return httpx.Response(200, json={"access_token": "gw-token"})
            if path.endswith("/userinfo"):
                return httpx.Response(200, json=CLAIMS)
            return httpx.Response(200, json={"keys": [_jwk()]})

        monkeypatch.setattr(
            outbound.httpx, "AsyncClient",
            lambda **kw: _REAL_ASYNC_CLIENT(transport=httpx.MockTransport(_dispatch), **kw),
        )


@pytest.fixture()
async def client(db_session, monkeypatch, registry):
    async with api_key_app(db_session, monkeypatch) as http:
        yield http
    api_keys_endpoints.limiter.reset()


@pytest.fixture()
def gateway(monkeypatch):
    return _Gateway(monkeypatch)


async def _server_gateway(db_session) -> str:
    row = await idp_provider_repo.create_provider(
        db_session, slug="corp-gateway", display_name="Corporate Gateway",
        kind="backchannel", claim_mapping={}, linking_policy="strict",
        settings={
            "token_source": "cookie", "token_source_key": "corp_session",
            "gateway_url": "https://gw.corp.example/redeem", "gateway_send_as": "cookie",
            "gateway_token_path": "access_token",
            "exchange_url": "https://gw.corp.example/userinfo",
        },
    )
    await idp_provider_repo.publish_provider(db_session, row.id)
    await db_session.commit()
    return row.id


async def _sign_in_through_the_gateway(client) -> dict:
    """Sign in as the key owner the way a gateway user does: the company
    session cookie on the request, redeemed server to server."""
    client.cookies.set("corp_session", "ambient-xyz")
    signed_in = await client.get(
        "/api/v1/auth/corp-gateway/login?next=/me/api-keys", follow_redirects=False,
    )
    assert signed_in.status_code == 302, signed_in.text
    return {CSRF_HEADER_NAME: client.cookies[CSRF_COOKIE_NAME]}


def _draft(**overrides) -> dict:
    expires = (datetime.now(timezone.utc) + timedelta(days=30)).isoformat()
    return {
        "name": "nightly sync", "permissions": {"views": "read", "data": "none"},
        "resources": "all", "expiresAt": expires, **overrides,
    }


async def _keys(db_session) -> int:
    return (await db_session.execute(select(func.count()).select_from(ApiKeyORM))).scalar()


async def _confirmed_by(db_session, event_type: str) -> list:
    rows = (await db_session.execute(
        select(OutboxEventORM).where(OutboxEventORM.event_type == event_type)
    )).scalars().all()
    return [json.loads(r.payload).get("step_up") for r in rows]


# ── Server exchange: the gateway is asked ───────────────────────────


async def test_a_gateway_that_vouches_for_the_company_session_mints_a_key(
    client, db_session, gateway,
):
    await _server_gateway(db_session)
    headers = await _sign_in_through_the_gateway(client)

    # The form offers "Create key" outright: the gateway is asked on submit,
    # not before.
    asked = gateway.redeemed
    options = (await client.get("/api/v1/me/api-keys/options")).json()
    assert options["stepUp"] == {"method": "sso", "fresh": True}
    assert options["stepUpAvailable"] is True
    assert options["ssoSignInUrl"] == GATEWAY_LOGIN
    assert gateway.redeemed == asked

    created = await client.post("/api/v1/me/api-keys", json=_draft(), headers=headers)
    assert created.status_code == 201, created.text
    assert gateway.redeemed == asked + 1
    assert await _confirmed_by(db_session, "identity.api_key.created") == ["gateway_live"]


async def test_a_company_session_that_ended_sends_the_person_to_sign_in_again(
    client, db_session, gateway,
):
    await _server_gateway(db_session)
    headers = await _sign_in_through_the_gateway(client)

    # Signed out of the company portal: the cookie is gone.
    client.cookies.delete("corp_session")
    absent = await client.post("/api/v1/me/api-keys", json=_draft(), headers=headers)
    # The gateway says it has ended.
    client.cookies.set("corp_session", "ambient-xyz")
    gateway.answer = 401
    ended = await client.post("/api/v1/me/api-keys", json=_draft(), headers=headers)

    for refused in (absent, ended):
        assert refused.status_code == 403, refused.text
        detail = refused.json()["detail"]
        assert (detail["error"], detail["method"]) == ("step_up_required", "sso")
        assert detail["loginUrl"] == GATEWAY_LOGIN
    assert await _keys(db_session) == 0


@pytest.mark.parametrize("silence", [503, "timeout"])
async def test_a_gateway_that_does_not_answer_mints_nothing(
    client, db_session, gateway, silence,
):
    """Unlike a renewal, which a gateway blip must not end, a step-up has no
    grace: nothing is minted on a question nobody answered."""
    await _server_gateway(db_session)
    headers = await _sign_in_through_the_gateway(client)
    gateway.answer = silence
    refused = await client.post("/api/v1/me/api-keys", json=_draft(), headers=headers)
    assert refused.status_code == 503, refused.text
    assert error(refused) == "gateway_unreachable"
    assert refused.headers["retry-after"] == "30"
    assert await _keys(db_session) == 0


async def test_while_the_gateway_is_confirmed_down_nothing_waits_on_it(
    client, db_session, gateway,
):
    """Once the prober has confirmed the gateway down, a step-up that would
    ask it is answered at once — 503, try again later — rather than holding
    the request, and a database connection, for the gateway's deadline; and
    nobody is sent to sign in through it. The form says so up front. Once it
    is back, the same request mints."""
    gateway_id = await _server_gateway(db_session)
    headers = await _sign_in_through_the_gateway(client)
    down = await confirmed_down(db_session, gateway_id)
    asked = gateway.redeemed

    options = (await client.get("/api/v1/me/api-keys/options")).json()
    assert (options["stepUpAvailable"], options["stepUpReason"]) == (False, "idp_unreachable")
    assert options["ssoSignInUrl"] is None

    refused = await client.post("/api/v1/me/api-keys", json=_draft(), headers=headers)
    assert refused.status_code == 503, refused.text
    detail = refused.json()["detail"]
    assert (detail["error"], detail["reason"]) == ("idp_unreachable", "idp_unreachable")
    assert "loginUrl" not in detail
    assert refused.headers["retry-after"] == "60"
    assert gateway.redeemed == asked
    assert await _keys(db_session) == 0

    await db_session.delete(down)
    await db_session.commit()
    created = await client.post("/api/v1/me/api-keys", json=_draft(), headers=headers)
    assert created.status_code == 201, created.text


async def test_rotating_and_renewing_ask_the_gateway_too(client, db_session, gateway):
    await _server_gateway(db_session)
    headers = await _sign_in_through_the_gateway(client)
    key = (await client.post("/api/v1/me/api-keys", json=_draft(), headers=headers)).json()["key"]

    rotate = f"/api/v1/me/api-keys/{key['id']}/rotate"
    gateway.answer = 401
    refused = await client.post(rotate, json={}, headers=headers)
    assert refused.status_code == 403 and error(refused) == "step_up_required"

    gateway.answer = 200
    rotated = await client.post(rotate, json={}, headers=headers)
    assert rotated.status_code == 200, rotated.text
    assert await _confirmed_by(db_session, "identity.api_key.rotated") == ["gateway_live"]


async def test_the_session_is_checked_against_its_own_gateway(client, db_session, gateway):
    """Someone who also has an OIDC identity, signed in through it more
    recently, is still asked about the gateway their session came from."""
    await _server_gateway(db_session)
    headers = await _sign_in_through_the_gateway(client)
    oidc = await idp_provider_repo.create_provider(
        db_session, slug="corp-oidc", display_name="Corp OIDC", kind="oidc",
        settings={}, claim_mapping={}, linking_policy="strict",
    )
    db_session.add(UserIdentityORM(
        user_id=OWNER, provider_id=oidc.id, external_id="oidc-owner",
        last_login_at=(datetime.now(timezone.utc) + timedelta(minutes=1)).isoformat(),
    ))
    await db_session.commit()

    gateway.answer = 401
    refused = await client.post("/api/v1/me/api-keys", json=_draft(), headers=headers)
    assert refused.json()["detail"]["loginUrl"] == GATEWAY_LOGIN


async def test_signing_in_through_the_gateway_resumes_paused_keys(client, db_session, gateway):
    """Keys pause when their owner has not signed in through their provider
    for the window. A gateway user signs in through it at least daily — the
    silent re-sign-in at the session ceiling — and each sign-in is what
    "Sign in to resume" sends them to: the key works again at once."""
    await _server_gateway(db_session)
    await _sign_in_through_the_gateway(client)
    key = await mint(db_session, views="read")
    identity = (await db_session.execute(
        select(UserIdentityORM).where(UserIdentityORM.user_id == OWNER)
    )).scalar_one()
    identity.last_login_at = days_ago(40)
    await db_session.commit()

    client.cookies.clear()
    paused = await client.get("/api/v1/views/v_a_mine", headers=key.headers)
    assert paused.status_code == 401 and error(paused) == "owner_reauth_required"

    await _sign_in_through_the_gateway(client)
    await db_session.refresh(identity)
    assert identity.last_login_at > days_ago(1)
    client.cookies.clear()
    resumed = await client.get("/api/v1/views/v_a_mine", headers=key.headers)
    assert resumed.status_code == 200, resumed.text


# ── Browser exchange: a sign-in through it is its answer ────────────


async def _sign_in_in_the_browser(client, *, jti: str) -> dict:
    """Sign in the way a browser-exchange gateway user does: the browser
    fetches a signed assertion from the gateway and posts it here."""
    signed_in = await client.post(
        "/api/v1/auth/corp-browser/backchannel",
        json={"assertion": _assertion(jti=jti, email=f"{OWNER}@example.com")},
    )
    assert signed_in.status_code == 200, signed_in.text
    return {CSRF_HEADER_NAME: client.cookies[CSRF_COOKIE_NAME]}


async def test_a_browser_gateway_sign_in_minutes_ago_mints_and_an_older_one_signs_in_again(
    client, db_session, gateway, monkeypatch,
):
    await _make_row(db_session)
    headers = await _sign_in_in_the_browser(client, jti="first")

    options = (await client.get("/api/v1/me/api-keys/options")).json()
    assert options["stepUp"] == {"method": "sso", "fresh": True}

    # Two hours on, the same session is sent through the gateway again…
    real = time.time
    with monkeypatch.context() as later:
        later.setattr(api_keys_endpoints, "time", SimpleNamespace(time=lambda: real() + 7200))
        options = (await client.get("/api/v1/me/api-keys/options")).json()
        assert options["stepUp"] == {"method": "sso", "fresh": False}
        assert options["stepUpAvailable"] is True
        stale = await client.post("/api/v1/me/api-keys", json=_draft(), headers=headers)
    assert stale.status_code == 403 and error(stale) == "step_up_required"
    assert stale.json()["detail"]["loginUrl"] == BROWSER_LOGIN
    assert await _keys(db_session) == 0

    # …and back from it, minutes ago again, it mints.
    headers = await _sign_in_in_the_browser(client, jti="again")
    created = await client.post("/api/v1/me/api-keys", json=_draft(), headers=headers)
    assert created.status_code == 201, created.text
    assert await _confirmed_by(db_session, "identity.api_key.created") == ["gateway_sign_in"]
