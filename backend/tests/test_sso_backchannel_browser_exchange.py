"""``exchange_mode="browser"``: the corporate cookie never reaches us.

The topology this exists for: the enterprise scopes its session cookie
to the SSO host alone, so no server of ours can ever present it. The
browser runs the translate call — its cookie jar does what ours cannot
— and posts the answering JWT here as an ``assertion``.

Everything the server topology gets from "we made the call" is
reconstructed and pinned in this file:

* the signature says the gateway minted it — verification material is
  required (a JWKS URL, a pasted public key, or a shared secret), and a
  wrong signature is refused whichever kind is configured;
* ``exp`` bounds the assertion AND the session it mints — ``idp_exp``
  rides inside our own signed refresh token, survives rotation, and
  ends the session the moment the corporate token would have expired;
* the replay burn makes each assertion sign in at most once, failing
  CLOSED when the store cannot answer;
* the row's server-side secrets stay server-side: browser mode
  publishes exactly its own public field family and nothing else.
"""
from __future__ import annotations

import time

import httpx
import jwt as pyjwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa

from backend.app.db.repositories import idp_provider_repo
from backend.app.main import backchannel_builder_with_replay_cache
from backend.auth_service.core import tokens as token_module
from backend.auth_service.interface import SsoReauthRequired
from backend.auth_service.providers import outbound
from backend.auth_service.providers.backchannel import (
    BackchannelConfigError,
    BackchannelError,
    BackchannelProvider,
    BackchannelSettings,
    BackchannelUnavailable,
    build_backchannel_provider,
    validate_settings,
)
from backend.auth_service.providers.registry import ProviderConfigSnapshot
from backend.tests.common.refresh_store import InMemoryRefreshStore
from backend.tests.test_sso_phase2 import (
    _StubUserRepo,
    _StubUserIdentityRepo,
    _session_factory,
)

_REAL_ASYNC_CLIENT = httpx.AsyncClient

TRANSLATE = "https://sso.corporate.com/auth-service/translate"
JWKS = "https://sso.corporate.com/jwks"

CLAIMS = {
    "sub": "emp-1",
    "email": "ada.lovelace@corporate.com",
    "firstName": "Ada",
    "lastName": "Lovelace",
    "auth_time": int(time.time()) - 60,
}

_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_OTHER_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
KID = "corp-2026"


def _jwk(key=None, kid=KID) -> dict:
    doc = pyjwt.algorithms.RSAAlgorithm.to_jwk(
        (key or _KEY).public_key(), as_dict=True,
    )
    doc["kid"] = kid
    return doc


def _assertion(*, key=None, exp_in=600, jti="jti-1", **extra) -> str:
    payload = {**CLAIMS, "exp": int(time.time()) + exp_in, **extra}
    if jti is not None:
        payload["jti"] = jti
    return pyjwt.encode(
        payload, key or _KEY, algorithm="RS256", headers={"kid": KID},
    )


def _settings(**over) -> BackchannelSettings:
    base = dict(
        exchange_mode="browser",
        browser_exchange_url=TRANSLATE,
        jwks_url=JWKS,
        token_source_key="",
        gateway_url="",
    )
    base.update(over)
    return BackchannelSettings(**base)


def _routes(monkeypatch, jwks: dict | None = None):
    seen: list[httpx.Request] = []

    def _dispatch(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=jwks or {"keys": [_jwk()]})

    def _make(**kwargs):
        return _REAL_ASYNC_CLIENT(
            transport=httpx.MockTransport(_dispatch), **kwargs,
        )

    monkeypatch.setattr(outbound.httpx, "AsyncClient", _make)
    return seen


# ── the provider: verify, burn, bound ────────────────────────────────

@pytest.mark.asyncio
async def test_a_signed_assertion_becomes_a_bounded_identity(monkeypatch):
    _routes(monkeypatch)
    exp = int(time.time()) + 600
    identity = await BackchannelProvider(_settings()).identity_from_assertion(
        _assertion(exp_in=600),
    )
    assert identity.email == "ada.lovelace@corporate.com"
    assert identity.external_id == "emp-1"
    # The corporate token's own expiry travels with the identity, so the
    # session we mint cannot outlive it.
    assert abs(identity.upstream_expires_at - exp) <= 2


@pytest.mark.asyncio
async def test_a_wrong_signature_is_refused(monkeypatch):
    _routes(monkeypatch)
    with pytest.raises(BackchannelError) as err:
        await BackchannelProvider(_settings()).identity_from_assertion(
            _assertion(key=_OTHER_KEY),
        )
    assert err.value.code == "backchannel_jwt_invalid"


@pytest.mark.asyncio
async def test_an_expired_assertion_is_refused(monkeypatch):
    _routes(monkeypatch)
    with pytest.raises(BackchannelError) as err:
        await BackchannelProvider(_settings()).identity_from_assertion(
            _assertion(exp_in=-60),
        )
    assert err.value.code == "backchannel_jwt_expired"


@pytest.mark.asyncio
async def test_an_assertion_signs_in_at_most_once(monkeypatch):
    _routes(monkeypatch)
    provider = BackchannelProvider(_settings())
    token = _assertion()
    await provider.identity_from_assertion(token)
    with pytest.raises(BackchannelError) as err:
        await provider.identity_from_assertion(token)
    assert err.value.code == "backchannel_replayed"


@pytest.mark.asyncio
async def test_a_jti_less_assertion_is_still_single_use(monkeypatch):
    """Corporate translate endpoints often omit ``jti``; the token's own
    bytes then key the burn, which is exact single-use either way."""
    _routes(monkeypatch)
    provider = BackchannelProvider(_settings())
    token = _assertion(jti=None)
    await provider.identity_from_assertion(token)
    with pytest.raises(BackchannelError) as err:
        await provider.identity_from_assertion(token)
    assert err.value.code == "backchannel_replayed"


@pytest.mark.asyncio
async def test_a_replay_store_failure_refuses_the_login(monkeypatch):
    """"We could not check for a replay" has no floor under it, so it
    fails closed — an outage, never a free pass."""
    class _BrokenStore:
        async def record(self, key, exp):
            raise RuntimeError("store down")

    _routes(monkeypatch)
    provider = BackchannelProvider(_settings(), replay_cache=_BrokenStore())
    with pytest.raises(BackchannelUnavailable):
        await provider.identity_from_assertion(_assertion())


@pytest.mark.asyncio
async def test_no_refusal_quotes_the_assertion(monkeypatch):
    _routes(monkeypatch)
    bad = _assertion(key=_OTHER_KEY)
    with pytest.raises(BackchannelError) as err:
        await BackchannelProvider(_settings()).identity_from_assertion(bad)
    assert bad.split(".")[1] not in str(err.value)


# ── the other verification materials ─────────────────────────────────
#
# Corporate gateways that sign but publish no JWKS hand their team a
# public key instead; symmetric ones hand a secret. Same trust, same
# strictness — the MATERIAL decides the algorithm list, so neither
# RS→HS nor HS→RS confusion is expressible.

from cryptography.hazmat.primitives import serialization

_SECRET = "corp-shared-verify-0123456789abcdef"


def _pem(key=None) -> str:
    return (key or _KEY).public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode()


def _hs_assertion(*, secret=_SECRET, exp_in=600, jti="jti-hs-1", **extra) -> str:
    payload = {**CLAIMS, "exp": int(time.time()) + exp_in, **extra}
    if jti is not None:
        payload["jti"] = jti
    return pyjwt.encode(payload, secret, algorithm="HS256")


@pytest.mark.asyncio
async def test_a_pasted_public_key_verifies_like_a_jwks():
    # No _routes() on purpose: nothing may be fetched — the key is in
    # the row. An outbound call here would crash on the missing stub.
    exp = int(time.time()) + 600
    identity = await BackchannelProvider(
        _settings(jwks_url="", jwt_public_key=_pem()),
    ).identity_from_assertion(_assertion(exp_in=600))
    assert identity.email == "ada.lovelace@corporate.com"
    assert abs(identity.upstream_expires_at - exp) <= 2


@pytest.mark.asyncio
async def test_a_wrong_pasted_key_refuses_the_assertion():
    with pytest.raises(BackchannelError) as err:
        await BackchannelProvider(
            _settings(jwks_url="", jwt_public_key=_pem(_OTHER_KEY)),
        ).identity_from_assertion(_assertion())
    assert err.value.code == "backchannel_jwt_invalid"


@pytest.mark.asyncio
async def test_a_garbage_paste_is_a_refusal_not_a_crash():
    """An operator's bad paste raises InvalidKeyError, which is NOT an
    InvalidTokenError — without the broader catch it was a 500."""
    with pytest.raises(BackchannelError) as err:
        await BackchannelProvider(
            _settings(jwks_url="", jwt_public_key="not a pem at all"),
        ).identity_from_assertion(_assertion())
    assert err.value.code == "backchannel_jwt_invalid"


@pytest.mark.asyncio
async def test_an_hs_header_never_meets_public_material():
    """The classic confusion: HMAC the token with the PEM text everyone
    can read. PyJWT refuses to MINT such a token, so the forgery is
    hand-rolled the way an attacker would — and refused at the header
    check, before any key is touched."""
    import base64
    import hashlib
    import hmac
    import json as _json

    def _b64(data: bytes) -> str:
        return base64.urlsafe_b64encode(data).rstrip(b"=").decode()

    head = _b64(_json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    body = _b64(_json.dumps(
        {**CLAIMS, "exp": int(time.time()) + 600, "jti": "jti-x"},
    ).encode())
    sig = _b64(hmac.new(
        _pem().encode(), f"{head}.{body}".encode(), hashlib.sha256,
    ).digest())
    forged = f"{head}.{body}.{sig}"

    with pytest.raises(BackchannelError) as err:
        await BackchannelProvider(
            _settings(jwks_url="", jwt_public_key=_pem()),
        ).identity_from_assertion(forged)
    assert err.value.code == "backchannel_jwt_invalid"
    assert "jwt_alg_refused" in str(err.value)


@pytest.mark.asyncio
async def test_a_shared_secret_verifies_hs256():
    identity = await BackchannelProvider(
        _settings(jwks_url="", jwt_shared_secret=_SECRET),
    ).identity_from_assertion(_hs_assertion())
    assert identity.external_id == "emp-1"


@pytest.mark.asyncio
async def test_a_wrong_secret_is_refused():
    with pytest.raises(BackchannelError) as err:
        await BackchannelProvider(
            _settings(jwks_url="", jwt_shared_secret=_SECRET),
        ).identity_from_assertion(_hs_assertion(secret="some-other-secret"))
    assert err.value.code == "backchannel_jwt_invalid"


@pytest.mark.asyncio
async def test_an_rs_header_never_meets_the_shared_secret():
    """The other confusion direction: the secret pins the list to HS256
    exactly, so an asymmetric header is refused outright."""
    with pytest.raises(BackchannelError) as err:
        await BackchannelProvider(
            _settings(jwks_url="", jwt_shared_secret=_SECRET),
        ).identity_from_assertion(_assertion())
    assert err.value.code == "backchannel_jwt_invalid"
    assert "jwt_alg_refused" in str(err.value)


@pytest.mark.asyncio
@pytest.mark.parametrize("material", ["public_key", "shared_secret"])
async def test_exp_stays_required_with_pasted_material(material):
    if material == "public_key":
        s = _settings(jwks_url="", jwt_public_key=_pem())
        token = pyjwt.encode({**CLAIMS, "jti": "j"}, _KEY, algorithm="RS256")
    else:
        s = _settings(jwks_url="", jwt_shared_secret=_SECRET)
        token = pyjwt.encode({**CLAIMS, "jti": "j"}, _SECRET, algorithm="HS256")
    with pytest.raises(BackchannelError) as err:
        await BackchannelProvider(s).identity_from_assertion(token)
    assert err.value.code == "backchannel_jwt_invalid"


@pytest.mark.asyncio
async def test_pins_apply_to_pasted_material_too():
    s = _settings(
        jwks_url="", jwt_shared_secret=_SECRET,
        jwt_issuer="https://sso.corporate.com",
    )
    with pytest.raises(BackchannelError) as err:
        await BackchannelProvider(s).identity_from_assertion(
            _hs_assertion(iss="https://evil.example"),
        )
    assert err.value.code == "backchannel_jwt_invalid"

    identity = await BackchannelProvider(s).identity_from_assertion(
        _hs_assertion(iss="https://sso.corporate.com", jti="jti-hs-2"),
    )
    assert identity.external_id == "emp-1"


@pytest.mark.asyncio
async def test_the_burn_applies_whatever_the_material():
    provider = BackchannelProvider(
        _settings(jwks_url="", jwt_shared_secret=_SECRET),
    )
    token = _hs_assertion(jti="jti-burn")
    await provider.identity_from_assertion(token)
    with pytest.raises(BackchannelError) as err:
        await provider.identity_from_assertion(token)
    assert err.value.code == "backchannel_replayed"


# ── configuration refusals ───────────────────────────────────────────

@pytest.mark.parametrize("over,needle", [
    (dict(browser_exchange_url=""), "browser_exchange_url"),
    # No verification material at all. The message still names jwks_url
    # first — it is the choice most gateways can offer.
    (dict(jwks_url=""), "jwks_url"),
    (dict(jwks_url="", jwt_public_key="PEM", jwt_shared_secret="s"),
     "exactly one"),
    (dict(jwt_public_key="PEM"), "exactly one"),  # jwks stays from base
    (dict(browser_exchange_method="DELETE"), "browser_exchange_method"),
    # A token path with nothing forwarding it is dead configuration —
    # the refusal names the body field that would give it a purpose.
    (dict(authenticate_url="https://sso/x",
          authenticate_token_path="token"), "authenticate_token_path"),
    # The forwarding shape, each leg missing: no trigger to answer with
    # a token, no path to read it from, a GET that would drop the body.
    (dict(browser_exchange_method="POST",
          browser_exchange_body_field="token"), "authenticate_url"),
    (dict(browser_exchange_method="POST",
          browser_exchange_body_field="token",
          authenticate_url="https://sso/x"), "authenticate_token_path"),
    (dict(browser_exchange_body_field="token",
          authenticate_url="https://sso/x",
          authenticate_token_path="token"), "never be sent"),
    (dict(liveness_url="https://gw/validate"), "liveness_url"),
])
def test_impossible_browser_mode_rows_are_refused(over, needle):
    with pytest.raises(BackchannelConfigError, match=needle):
        validate_settings(_settings(**over))


@pytest.mark.parametrize("over", [
    dict(jwks_url="", jwt_public_key="-----BEGIN PUBLIC KEY-----"),
    dict(jwks_url="", jwt_shared_secret="s3cr3t"),
])
def test_each_material_alone_makes_a_valid_browser_row(over):
    validate_settings(_settings(**over))


def test_browser_mode_needs_no_server_leg():
    """The whole point: no gateway_url, no token_source_key, and the row
    still builds."""
    validate_settings(_settings())


def test_the_forwarding_shape_makes_a_valid_browser_row():
    """The pairing that unblocks gateways whose translate endpoint
    requires the trigger's token POSTed back in a JSON body."""
    validate_settings(_settings(
        browser_exchange_method="POST",
        browser_exchange_body_field="token",
        authenticate_url="https://sso.corporate.com/authenticate",
        authenticate_token_path="token",
    ))


def test_the_body_field_survives_the_snapshot_stripped():
    provider = build_backchannel_provider(_snap(
        browser_exchange_method="POST",
        browser_exchange_body_field=" token ",
        authenticate_url="https://sso.corporate.com/authenticate",
        authenticate_token_path="token",
    ))
    assert provider.settings.browser_exchange_body_field == "token"


# ── the session is bounded by the corporate token ────────────────────

def _service(store, killed=None):
    from backend.auth_service.service import LocalIdentityService

    async def _killer(uid):
        (killed if killed is not None else []).append(uid)

    return LocalIdentityService(
        session_factory=_session_factory,
        user_repo=_StubUserRepo(),
        user_identity_repo=_StubUserIdentityRepo(has_identity=True),
        refresh_store_factory=lambda s: store,
        session_killer=_killer,
    )


async def _minted(store, *, idp_exp):
    auth_time = int(time.time()) - 60
    token, claims = token_module.create_refresh_token(
        user_id="usr_1", family_id="fam1", auth_time=auth_time,
        idp_exp=idp_exp,
    )
    await store.record_mint(
        jti=claims.jti, family_id="fam1", user_id="usr_1",
        auth_time=auth_time, mint_ms=claims.mint_ms,
        expires_at_iso="2099-01-01T00:00:00+00:00",
        idp_provider_id=None, idp_checked_at=None,
    )
    return token, claims


@pytest.mark.asyncio
async def test_a_live_upstream_token_lets_the_refresh_through():
    store = InMemoryRefreshStore()
    token, _ = await _minted(store, idp_exp=int(time.time()) + 3600)
    user, tokens = await _service(store).refresh(token, ambient_cookies={})
    assert user.id == "usr_1"
    # And the successor still carries the bound — rotation must not be a
    # way to shed it.
    successor = token_module.decode_refresh_token(tokens.refresh_token)
    assert successor.idp_exp is not None


@pytest.mark.asyncio
async def test_an_expired_upstream_token_ends_the_session():
    """The corporate token expired between renewals. The next refresh
    ends the family — everywhere — and answers with the reauth envelope
    the silent re-sign-in keys on."""
    killed: list = []
    store = InMemoryRefreshStore()
    token, claims = await _minted(store, idp_exp=int(time.time()) - 10)

    with pytest.raises(SsoReauthRequired):
        await _service(store, killed).refresh(token, ambient_cookies={})
    assert killed == ["usr_1"]
    assert store.revoked_family == claims.family_id


@pytest.mark.asyncio
async def test_a_session_without_the_claim_is_untouched():
    """Server-mode and OIDC sessions carry no idp_exp; nothing about
    their refresh moves."""
    store = InMemoryRefreshStore()
    token, _ = await _minted(store, idp_exp=None)
    user, _tokens = await _service(store).refresh(token, ambient_cookies={})
    assert user.id == "usr_1"


# ── the production builder refuses what it cannot protect ────────────

def _snap(**settings) -> ProviderConfigSnapshot:
    base = dict(
        exchange_mode="browser", browser_exchange_url=TRANSLATE,
        jwks_url=JWKS,
    )
    base.update(settings)
    return ProviderConfigSnapshot(
        id="idp_bc", slug="corp", display_name="Corp", kind="backchannel",
        enabled=True, priority=100, settings=base, claim_mapping={},
        linking_policy="strict", button_label=None, button_icon=None,
    )


def test_prod_without_a_shared_store_refuses_browser_rows():
    builder = backchannel_builder_with_replay_cache(
        build_backchannel_provider, None, True,
    )
    with pytest.raises(RuntimeError, match="single-use"):
        builder(_snap())


def test_prod_with_a_shared_store_serves_them():
    class _Store:
        async def record(self, key, exp):
            return True

    builder = backchannel_builder_with_replay_cache(
        build_backchannel_provider, _Store(), True,
    )
    assert isinstance(builder(_snap()), BackchannelProvider)


def test_server_rows_are_served_regardless():
    """Their tokens are redeemed at the gateway — its own replay
    defence — so the store requirement does not apply."""
    builder = backchannel_builder_with_replay_cache(
        build_backchannel_provider, None, True,
    )
    provider = builder(_snap(
        exchange_mode="server", browser_exchange_url="", jwks_url="",
        token_source_key="corp_session",
        gateway_url="https://gw.corp.example/redeem",
    ))
    assert isinstance(provider, BackchannelProvider)


# ── the routes ───────────────────────────────────────────────────────

async def _make_row(db_session, *, lifecycle="live", **over):
    settings = dict(
        exchange_mode="browser",
        browser_exchange_url=TRANSLATE,
        browser_exchange_method="GET",
        browser_exchange_headers={"X-App-Id": "app-1"},
        jwks_url=JWKS,
        gateway_headers={"X-App-Secret": "s3cr3t"},
        exchange_headers={"X-Other-Secret": "als0-s3cret"},
    )
    settings.update(over)
    row = await idp_provider_repo.create_provider(
        db_session, slug="corp-browser", display_name="Corporate (browser)",
        kind="backchannel", settings=settings, claim_mapping={},
        linking_policy="strict",
    )
    if lifecycle == "live":
        await idp_provider_repo.publish_provider(db_session, row.id)
    await db_session.commit()
    return row


@pytest.mark.asyncio
async def test_a_posted_assertion_signs_in_and_links_by_email(
    test_client, db_session, registry, sso_events, monkeypatch,
):
    from backend.app.db.models import UserORM
    from sqlalchemy import select

    _routes(monkeypatch)
    await _make_row(db_session)

    resp = await test_client.post(
        "/api/v1/auth/corp-browser/backchannel",
        json={"assertion": _assertion()},
    )
    assert resp.status_code == 200, resp.text
    assert "nx_access" in resp.headers.get("set-cookie", "")
    row = (await db_session.execute(
        select(UserORM).where(UserORM.email == "ada.lovelace@corporate.com"),
    )).scalar_one()
    assert row.first_name == "Ada"


@pytest.mark.asyncio
async def test_the_route_burns_the_assertion_across_requests(
    test_client, db_session, registry, sso_events, monkeypatch,
):
    """The conftest registry rebuilds the provider per request
    (ttl_seconds=0), so this only holds when the burn lives in a store
    that outlives the provider instance — which is exactly what
    production binds. A per-instance cache would pass the provider test
    above and still fail here."""
    class _Shared:
        def __init__(self):
            self.seen: set[str] = set()

        async def record(self, key, exp):
            if key in self.seen:
                return False
            self.seen.add(key)
            return True

    shared = _Shared()
    from backend.auth_service.providers import PROVIDER_BUILDERS

    def _wired(snap, **kw):
        kw.pop("replay_cache", None)
        return build_backchannel_provider(snap, replay_cache=shared, **kw)

    monkeypatch.setitem(PROVIDER_BUILDERS, "backchannel", _wired)

    _routes(monkeypatch)
    await _make_row(db_session)
    token = _assertion()

    first = await test_client.post(
        "/api/v1/auth/corp-browser/backchannel", json={"assertion": token},
    )
    assert first.status_code == 200, first.text
    second = await test_client.post(
        "/api/v1/auth/corp-browser/backchannel", json={"assertion": token},
    )
    assert second.status_code == 401
    assert second.json()["detail"]["error"] == "backchannel_replayed"


@pytest.mark.asyncio
async def test_the_assertion_shape_is_refused_on_a_server_row(
    test_client, db_session, registry, sso_events, monkeypatch,
):
    _routes(monkeypatch)
    await _make_row(
        db_session,
        exchange_mode="server", browser_exchange_url="", jwks_url="",
        browser_exchange_headers={},
        token_source_key="corp_session",
        gateway_url="https://gw.corp.example/redeem",
    )
    resp = await test_client.post(
        "/api/v1/auth/corp-browser/backchannel",
        json={"assertion": _assertion()},
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_both_shapes_at_once_is_a_422(
    test_client, db_session, registry, sso_events, monkeypatch,
):
    _routes(monkeypatch)
    await _make_row(db_session)
    resp = await test_client.post(
        "/api/v1/auth/corp-browser/backchannel",
        json={"assertion": _assertion(), "handle": "h"},
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_the_redirect_flow_refuses_browser_rows(
    test_client, db_session, registry, sso_events, monkeypatch,
):
    """A bare navigation cannot complete this shape — no server-readable
    cookie exists — so it fails the standard sso_error way instead of
    pretending to look for one."""
    _routes(monkeypatch)
    await _make_row(db_session)
    resp = await test_client.get(
        "/api/v1/auth/corp-browser/login?next=/dashboard",
        follow_redirects=False,
    )
    assert resp.status_code == 302
    assert "sso_error=1" in resp.headers["location"]


@pytest.mark.asyncio
async def test_a_dry_run_verifies_without_writing(
    test_client, db_session, registry, sso_events, monkeypatch,
):
    from backend.auth_service.core.tokens import create_dryrun_token

    _routes(monkeypatch)
    row = await _make_row(db_session, lifecycle="draft")
    resp = await test_client.post(
        "/api/v1/auth/corp-browser/backchannel",
        json={"assertion": _assertion()},
        cookies={"nx_dryrun": create_dryrun_token(
            admin_id="u-admin", provider_id=row.id,
        )},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json().get("dryRun") is True
    assert "nx_access" not in resp.headers.get("set-cookie", "")


# ── what the browser is told ─────────────────────────────────────────

@pytest.mark.asyncio
async def test_browser_rows_publish_exactly_their_public_family(
    test_client, db_session, registry, sso_events, monkeypatch,
):
    """The browserExchange alias family — plus the trigger family when
    one is configured — and not one server-side fact. Checked by
    iterating the stored settings, so the next secret someone adds
    cannot leak by default."""
    _routes(monkeypatch)
    await _make_row(db_session)

    resp = await test_client.get("/api/v1/auth/providers")
    entry = next(p for p in resp.json() if p["slug"] == "corp-browser")
    assert set(entry.get("config", {})) == {
        "browserExchangeUrl", "browserExchangeMethod",
        "browserExchangeHeaders",
    }
    body = resp.text
    assert "s3cr3t" not in body
    assert "als0-s3cret" not in body
    assert "jwks" not in body.lower()


@pytest.mark.asyncio
async def test_the_pasted_materials_never_reach_the_browser(
    test_client, db_session, registry, sso_events, monkeypatch,
):
    """The shared secret is a signing key; the PEM is not secret but is
    still a server-side fact. Neither belongs on the sign-in page."""
    _routes(monkeypatch)
    await _make_row(
        db_session, jwks_url="",
        jwt_shared_secret="hs-verify-material-x9y8z7",
    )

    resp = await test_client.get("/api/v1/auth/providers")
    body = resp.text
    assert "hs-verify-material-x9y8z7" not in body
    assert "jwt_shared_secret" not in body
    assert "jwtSharedSecret" not in body
    assert "jwt_public_key" not in body


@pytest.mark.asyncio
async def test_server_rows_publish_none_of_the_browser_family(
    test_client, db_session, registry, sso_events, monkeypatch,
):
    _routes(monkeypatch)
    await _make_row(
        db_session,
        exchange_mode="server", browser_exchange_url="", jwks_url="",
        browser_exchange_headers={},
        token_source_key="corp_session",
        gateway_url="https://gw.corp.example/redeem",
    )
    resp = await test_client.get("/api/v1/auth/providers")
    entry = next(p for p in resp.json() if p["slug"] == "corp-browser")
    assert "browserExchange" not in str(entry.get("config", {}))


@pytest.mark.asyncio
async def test_a_forwarding_row_publishes_the_body_field_and_the_trigger(
    test_client, db_session, registry, sso_events, monkeypatch,
):
    """The sign-in page cannot build the POST without the field name, so
    it is public — beside the trigger family that produces the token it
    forwards. The server-side secrets stay put."""
    _routes(monkeypatch)
    await _make_row(
        db_session,
        browser_exchange_method="POST",
        browser_exchange_body_field="token",
        authenticate_url="https://sso.corporate.com/authenticate",
        authenticate_method="POST",
        authenticate_token_path="token",
    )
    resp = await test_client.get("/api/v1/auth/providers")
    entry = next(p for p in resp.json() if p["slug"] == "corp-browser")
    assert set(entry.get("config", {})) == {
        "browserExchangeUrl", "browserExchangeMethod",
        "browserExchangeHeaders", "browserExchangeBodyField",
        "authenticateUrl", "authenticateMethod", "authenticateTokenPath",
    }
    assert entry["config"]["browserExchangeBodyField"] == "token"
    body = resp.text
    assert "s3cr3t" not in body
    assert "als0-s3cret" not in body


@pytest.mark.asyncio
async def test_the_trigger_switch_still_hides_the_trigger_not_the_body_field(
    test_client, db_session, registry, sso_events, monkeypatch,
):
    """Switching the trigger off unpublishes the trigger family, as
    ever. The body field stays published: with no trigger to produce a
    token, the sign-in page then refuses with a message naming the real
    problem instead of earning the gateway's opaque refusal."""
    _routes(monkeypatch)
    await _make_row(
        db_session,
        browser_exchange_method="POST",
        browser_exchange_body_field="token",
        authenticate_enabled=False,
        authenticate_url="https://sso.corporate.com/authenticate",
        authenticate_token_path="token",
    )
    resp = await test_client.get("/api/v1/auth/providers")
    entry = next(p for p in resp.json() if p["slug"] == "corp-browser")
    config = entry.get("config", {})
    assert config.get("browserExchangeBodyField") == "token"
    assert not any(k.startswith("authenticate") for k in config)


# ── trust_unsigned: both shapes, no verification, unverified rating ──
#
# The explicit opt-out for gateways whose reply shape varies by
# environment (a signed JWT here, bare JSON there) or that sign
# nothing at all. One row accepts BOTH shapes — unverified — and the
# assurance machinery rates it accordingly, which is what keeps
# platform-admin mappings out of its reach.

def _unsigned_settings(**over) -> BackchannelSettings:
    return _settings(jwks_url="", trust_unsigned=True, **over)


@pytest.mark.asyncio
async def test_trust_unsigned_accepts_a_bare_json_reply():
    import json as _json

    identity = await BackchannelProvider(
        _unsigned_settings(),
    ).identity_from_assertion(_json.dumps({**CLAIMS, "jti": "u-1"}))
    assert identity.email == "ada.lovelace@corporate.com"
    # No exp anywhere in the reply: no ceiling, not a zero ceiling —
    # a 0 would end the session at its first rotation.
    assert identity.upstream_expires_at is None


@pytest.mark.asyncio
async def test_trust_unsigned_accepts_a_jwt_from_any_key():
    exp = int(time.time()) + 600
    identity = await BackchannelProvider(
        _unsigned_settings(),
    ).identity_from_assertion(_assertion(key=_OTHER_KEY, exp_in=600))
    # An unverified exp still SHORTENS the session when present.
    assert abs(identity.upstream_expires_at - exp) <= 2


@pytest.mark.asyncio
async def test_trust_unsigned_still_refuses_a_stale_exp():
    with pytest.raises(BackchannelError) as err:
        await BackchannelProvider(
            _unsigned_settings(),
        ).identity_from_assertion(_assertion(exp_in=-60))
    assert err.value.code == "backchannel_jwt_expired"


@pytest.mark.asyncio
@pytest.mark.parametrize("garbage", [
    "{not json",
    '["a", "list"]',
    "neither.a.jwt-nor-json",
])
async def test_trust_unsigned_still_refuses_garbage(garbage):
    with pytest.raises(BackchannelError) as err:
        await BackchannelProvider(
            _unsigned_settings(),
        ).identity_from_assertion(garbage)
    assert err.value.code == "backchannel_jwt_invalid"


@pytest.mark.asyncio
@pytest.mark.parametrize("material", [
    dict(),                                       # jwks (base)
    dict(jwks_url="", jwt_public_key="pem"),
    dict(jwks_url="", jwt_shared_secret="s"),
])
async def test_a_verifying_row_never_falls_back_to_json(material):
    """No opportunistic verification: accepting bare JSON on a row with
    material would let anyone bypass the signature by not signing."""
    import json as _json

    with pytest.raises(BackchannelError) as err:
        await BackchannelProvider(
            _settings(**material),
        ).identity_from_assertion(_json.dumps({**CLAIMS, "jti": "u-2"}))
    assert err.value.code == "backchannel_jwt_invalid"
    assert "assertion_not_a_jwt" in str(err.value)


@pytest.mark.asyncio
async def test_the_burn_holds_even_with_no_exp_at_all():
    """The stores size their TTL from exp; an absent one used to mean a
    ~1s burn — a replay window wearing a burn's name. The clamp makes
    the second presentation refuse whatever the payload said."""
    import json as _json

    seen: list[tuple[str, int]] = []

    class _Recorder:
        def __init__(self):
            self._keys: set[str] = set()

        async def record(self, key, exp):
            seen.append((key, exp))
            if key in self._keys:
                return False
            self._keys.add(key)
            return True

    provider = BackchannelProvider(
        _unsigned_settings(), replay_cache=_Recorder(),
    )
    reply = _json.dumps({**CLAIMS, "jti": "burn-me"})
    await provider.identity_from_assertion(reply)
    with pytest.raises(BackchannelError) as err:
        await provider.identity_from_assertion(reply)
    assert err.value.code == "backchannel_replayed"
    # The horizon handed to the store is clamped, never 0/None.
    now = int(time.time())
    assert all(now + 800 < exp <= now + 86_401 for _, exp in seen)


@pytest.mark.asyncio
async def test_the_replay_store_still_fails_closed_unsigned():
    class _BrokenStore:
        async def record(self, key, exp):
            raise RuntimeError("store down")

    import json as _json

    with pytest.raises(BackchannelUnavailable):
        await BackchannelProvider(
            _unsigned_settings(), replay_cache=_BrokenStore(),
        ).identity_from_assertion(_json.dumps({**CLAIMS, "jti": "u-3"}))


@pytest.mark.parametrize("over,needle", [
    (dict(jwks_url="", trust_unsigned=True,
          jwt_public_key="PEM"), "contradict"),
    (dict(trust_unsigned=True), "contradict"),  # jwks stays from base
    (dict(jwks_url="", trust_unsigned=True,
          jwt_issuer="https://sso"), "pin"),
])
def test_trust_unsigned_contradictions_are_refused(over, needle):
    with pytest.raises(BackchannelConfigError, match=needle):
        validate_settings(_settings(**over))


def test_trust_unsigned_alone_makes_a_valid_browser_row():
    validate_settings(_unsigned_settings())


def test_prod_still_demands_the_shared_store_for_unsigned_rows():
    """The burn is the only single-use control left on this posture —
    a per-process cache would be a replay window per worker."""
    builder = backchannel_builder_with_replay_cache(
        build_backchannel_provider, None, True,
    )
    with pytest.raises(RuntimeError, match="single-use"):
        builder(_snap(jwks_url="", trust_unsigned=True))


@pytest.mark.asyncio
async def test_a_real_unsigned_login_is_audited(
    test_client, db_session, registry, sso_events, monkeypatch,
):
    """Accepting browser-written claims nobody verified is exactly the
    kind of event an auditor greps for later — the same record the
    unsigned custom_profile posture writes."""
    import json as _json

    await _make_row(db_session, jwks_url="", trust_unsigned=True)

    resp = await test_client.post(
        "/api/v1/auth/corp-browser/backchannel",
        json={"assertion": _json.dumps({**CLAIMS, "jti": "audit-1"})},
    )
    assert resp.status_code == 200, resp.text
    kinds = [k for k, _ in sso_events]
    assert "user.sso_unsigned_accepted" in kinds
    payload = dict(sso_events)["user.sso_unsigned_accepted"]
    assert payload["via"] == "browser_assertion"


@pytest.mark.asyncio
async def test_a_rehearsal_is_not_audited_as_an_acceptance(
    test_client, db_session, registry, sso_events, monkeypatch,
):
    """Nothing was accepted — the dry run writes nothing and signs
    nobody in, so recording it would salt the audit trail."""
    import json as _json

    from backend.auth_service.core.tokens import create_dryrun_token

    row = await _make_row(db_session, jwks_url="", trust_unsigned=True)

    resp = await test_client.post(
        "/api/v1/auth/corp-browser/backchannel",
        json={"assertion": _json.dumps({**CLAIMS, "jti": "audit-2"})},
        cookies={"nx_dryrun": create_dryrun_token(
            admin_id="u-admin", provider_id=row.id,
        )},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json().get("dryRun") is True
    kinds = [k for k, _ in sso_events]
    assert "user.sso_unsigned_accepted" not in kinds


# ── the rehearsal names the case it saw ──────────────────────────────
#
# A gateway whose reply shape varies by environment makes the operator's
# first question "which case is THIS deployment?" — so the dry-run
# outcome says what arrived and what judged it.

async def _rehearse(test_client, db_session, row, body):
    from backend.auth_service.core.tokens import create_dryrun_token

    return await test_client.post(
        "/api/v1/auth/corp-browser/backchannel",
        json=body,
        cookies={"nx_dryrun": create_dryrun_token(
            admin_id="u-admin", provider_id=row.id,
        )},
    )


@pytest.mark.asyncio
async def test_the_rehearsal_reports_a_jwks_verified_token(
    test_client, db_session, registry, sso_events, monkeypatch,
):
    _routes(monkeypatch)
    row = await _make_row(db_session)
    resp = await _rehearse(
        test_client, db_session, row, {"assertion": _assertion()},
    )
    assert resp.status_code == 200, resp.text
    verification = resp.json()["outcome"]["verification"]
    assert verification == {
        "shape": "jwt", "verified": True, "material": "jwks",
    }


@pytest.mark.asyncio
async def test_the_rehearsal_reports_the_shared_secret_case(
    test_client, db_session, registry, sso_events, monkeypatch,
):
    row = await _make_row(
        db_session, jwks_url="", jwt_shared_secret=_SECRET,
    )
    resp = await _rehearse(
        test_client, db_session, row, {"assertion": _hs_assertion()},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["outcome"]["verification"] == {
        "shape": "jwt", "verified": True, "material": "shared_secret",
    }


@pytest.mark.asyncio
async def test_the_rehearsal_reports_an_unsigned_json_reply(
    test_client, db_session, registry, sso_events, monkeypatch,
):
    import json as _json

    row = await _make_row(db_session, jwks_url="", trust_unsigned=True)
    resp = await _rehearse(
        test_client, db_session, row,
        {"assertion": _json.dumps({**CLAIMS, "jti": "v-1"})},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["outcome"]["verification"] == {
        "shape": "json", "verified": False, "material": "none",
    }


@pytest.mark.asyncio
async def test_a_handle_rehearsal_carries_no_verification_verdict(
    test_client, db_session, registry, sso_events, monkeypatch,
):
    """The handle is redeemed server-side — there is no browser-borne
    assertion to have judged, so no verdict is invented for it."""
    def _gw(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=dict(CLAIMS))

    def _make(**kwargs):
        return _REAL_ASYNC_CLIENT(
            transport=httpx.MockTransport(_gw), **kwargs,
        )

    monkeypatch.setattr(outbound.httpx, "AsyncClient", _make)
    row = await _make_row(
        db_session,
        exchange_mode="server", browser_exchange_url="", jwks_url="",
        token_source_key="", gateway_url="https://gw.corp.example/redeem",
        gateway_send_as="body", gateway_body_field="token",
        authenticate_url="https://sso.corporate.com/authenticate",
        authenticate_token_path="token",
    )
    resp = await _rehearse(
        test_client, db_session, row, {"handle": "handle-abc"},
    )
    assert resp.status_code == 200, resp.text
    assert "verification" not in resp.json()["outcome"]
