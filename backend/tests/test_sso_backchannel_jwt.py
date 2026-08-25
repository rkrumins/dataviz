"""``claims_format="jwt"``: the user object arrives as a signed token.

The corporate shape this exists for: a translate endpoint that takes the
session cookie and answers with a JWT — bare in the body, or wrapped in
JSON — whose *payload* is the user object. The credentials stay opaque;
what is decoded here is the answer itself, read from the same TLS
response the JSON shape would have been read from.

Three postures, in rising strictness, each pinned below:

* **json (default)** — a JWT body is refused exactly as before; nothing
  about the original shape moves.
* **jwt, no JWKS** — decoded without signature verification. The same
  trust as JSON: the bytes came from the endpoint we called.
* **jwt + JWKS** — signature verified against the published keys
  (asymmetric algorithms only), ``exp`` required, optional issuer and
  audience pins, key rotation handled by one forced refetch on an
  unknown ``kid``.

Everything runs through the real ``request_json`` with only the httpx
transport mocked, so the destination guard and transport rules stay in
the loop.
"""
from __future__ import annotations

import time

import httpx
import jwt as pyjwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa

from backend.auth_service.providers import outbound
from backend.auth_service.providers.backchannel import (
    BackchannelConfigError,
    BackchannelError,
    BackchannelProvider,
    BackchannelSettings,
    BackchannelUnavailable,
    validate_settings,
)

_REAL_ASYNC_CLIENT = httpx.AsyncClient

GATEWAY = "https://gw.corp.example/translate"
EXCHANGE = "https://gw.corp.example/userinfo"
JWKS = "https://gw.corp.example/jwks"

CLAIMS = {
    "sub": "emp-1",
    "email": "ada.lovelace@corporate.com",
    "firstName": "Ada",
    "lastName": "Lovelace",
    "auth_time": 1_700_000_000,
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


def _token(
    *, key=None, kid=KID, alg="RS256", exp_in=600, headers=None, **extra,
) -> str:
    payload = {**CLAIMS, **extra}
    if exp_in is not None:
        payload.setdefault("exp", int(time.time()) + exp_in)
    header = {"kid": kid, **(headers or {})} if kid else (headers or {})
    return pyjwt.encode(payload, key or _KEY, algorithm=alg, headers=header)


def _settings(**over) -> BackchannelSettings:
    base = dict(
        token_source="cookie", token_source_key="corp_session",
        gateway_url=GATEWAY, gateway_send_as="cookie",
        gateway_token_path="access_token",
        claims_format="jwt",
    )
    base.update(over)
    return BackchannelSettings(**base)


def _routes(monkeypatch, handler):
    seen: list[httpx.Request] = []

    def _dispatch(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    def _make(**kwargs):
        return _REAL_ASYNC_CLIENT(
            transport=httpx.MockTransport(_dispatch), **kwargs,
        )

    monkeypatch.setattr(outbound.httpx, "AsyncClient", _make)
    return seen


def _serving(token: str, *, jwks: dict | None = None, shape="bare"):
    """A gateway that answers with *token*, plus an optional JWKS host."""
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/jwks"):
            return httpx.Response(200, json=jwks or {"keys": [_jwk()]})
        if shape == "bare":
            return httpx.Response(
                200, content=token.encode(),
                headers={"content-type": "application/jwt"},
            )
        return httpx.Response(200, json={"jwt": token})
    return handler


# ── decoding, unverified: the translate shapes ───────────────────────

@pytest.mark.asyncio
async def test_a_bare_jwt_body_becomes_the_identity(monkeypatch):
    """The whole described corporate flow in one call: cookie in, a
    bare application/jwt body out, its payload mapped to the profile."""
    _routes(monkeypatch, _serving(_token()))
    identity = await BackchannelProvider(_settings()).fetch_identity(
        "ambient-xyz",
    )
    assert identity.email == "ada.lovelace@corporate.com"
    assert identity.external_id == "emp-1"
    assert identity.first_name == "Ada"
    assert identity.auth_time == 1_700_000_000


@pytest.mark.asyncio
async def test_a_json_wrapped_jwt_is_read_from_its_path(monkeypatch):
    _routes(monkeypatch, _serving(_token(), shape="wrapped"))
    identity = await BackchannelProvider(
        _settings(exchange_claims_path="jwt"),
    ).fetch_identity("ambient-xyz")
    assert identity.external_id == "emp-1"


@pytest.mark.asyncio
async def test_a_second_leg_can_answer_with_a_jwt_too(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/translate"):
            return httpx.Response(200, json={"access_token": "gw-token"})
        return httpx.Response(
            200, content=_token().encode(),
            headers={"content-type": "application/jwt"},
        )

    seen = _routes(monkeypatch, handler)
    identity = await BackchannelProvider(
        _settings(exchange_url=EXCHANGE),
    ).fetch_identity("ambient-xyz")
    assert identity.external_id == "emp-1"
    assert [r.url.path for r in seen] == ["/translate", "/userinfo"]


@pytest.mark.asyncio
async def test_an_unverified_garbage_token_is_a_legible_refusal(monkeypatch):
    def handler(request):
        return httpx.Response(200, json={"jwt": "not.a.jwt"})

    _routes(monkeypatch, handler)
    with pytest.raises(BackchannelError) as err:
        await BackchannelProvider(
            _settings(exchange_claims_path="jwt"),
        ).fetch_identity("ambient-xyz")
    assert err.value.code == "backchannel_jwt_invalid"


@pytest.mark.asyncio
async def test_json_mode_still_refuses_a_jwt_body(monkeypatch):
    """The default is untouched: a connection that expects a user
    object does not quietly start accepting tokens."""
    _routes(monkeypatch, _serving(_token()))
    with pytest.raises(BackchannelUnavailable):
        await BackchannelProvider(
            _settings(claims_format="json"),
        ).fetch_identity("ambient-xyz")


# ── verifying against a JWKS ─────────────────────────────────────────

def _verified_settings(**over) -> BackchannelSettings:
    return _settings(jwks_url=JWKS, **over)


@pytest.mark.asyncio
async def test_a_correctly_signed_token_verifies_and_signs_in(monkeypatch):
    seen = _routes(monkeypatch, _serving(_token()))
    identity = await BackchannelProvider(
        _verified_settings(),
    ).fetch_identity("ambient-xyz")
    assert identity.external_id == "emp-1"
    assert [r.url.path for r in seen] == ["/translate", "/jwks"]


@pytest.mark.asyncio
async def test_a_wrong_signature_is_refused(monkeypatch):
    _routes(monkeypatch, _serving(_token(key=_OTHER_KEY)))
    with pytest.raises(BackchannelError) as err:
        await BackchannelProvider(
            _verified_settings(),
        ).fetch_identity("ambient-xyz")
    assert err.value.code == "backchannel_jwt_invalid"


@pytest.mark.asyncio
async def test_an_expired_token_is_its_own_code(monkeypatch):
    """Expiry gets a distinct code because the remedy is different:
    clock skew or caching on their side, not a key or pin problem."""
    _routes(monkeypatch, _serving(_token(exp_in=-60)))
    with pytest.raises(BackchannelError) as err:
        await BackchannelProvider(
            _verified_settings(),
        ).fetch_identity("ambient-xyz")
    assert err.value.code == "backchannel_jwt_expired"


@pytest.mark.asyncio
async def test_a_token_without_exp_is_refused_when_verifying(monkeypatch):
    _routes(monkeypatch, _serving(_token(exp_in=None)))
    with pytest.raises(BackchannelError) as err:
        await BackchannelProvider(
            _verified_settings(),
        ).fetch_identity("ambient-xyz")
    assert err.value.code == "backchannel_jwt_invalid"


@pytest.mark.asyncio
async def test_symmetric_algorithms_are_refused(monkeypatch):
    """The JWKS is public. An HS256 token 'verified' against material an
    attacker can also read is not verified at all, so the algorithm
    list never contains a symmetric entry."""
    hs_token = pyjwt.encode(
        {**CLAIMS, "exp": int(time.time()) + 600},
        "the-jwks-is-public-so-this-verifies-nothing", algorithm="HS256",
        headers={"kid": KID},
    )
    _routes(monkeypatch, _serving(hs_token))
    with pytest.raises(BackchannelError) as err:
        await BackchannelProvider(
            _verified_settings(),
        ).fetch_identity("ambient-xyz")
    assert err.value.code == "backchannel_jwt_invalid"


@pytest.mark.asyncio
@pytest.mark.parametrize("pin,claim", [
    ({"jwt_issuer": "https://sso.corporate.com"}, {"iss": "https://evil"}),
    ({"jwt_audience": "dataviz"}, {"aud": "someone-else"}),
])
async def test_the_pins_pin(monkeypatch, pin, claim):
    _routes(monkeypatch, _serving(_token(**claim)))
    with pytest.raises(BackchannelError) as err:
        await BackchannelProvider(
            _verified_settings(**pin),
        ).fetch_identity("ambient-xyz")
    assert err.value.code == "backchannel_jwt_invalid"


@pytest.mark.asyncio
async def test_matching_pins_pass(monkeypatch):
    _routes(monkeypatch, _serving(
        _token(iss="https://sso.corporate.com", aud="dataviz"),
    ))
    identity = await BackchannelProvider(_verified_settings(
        jwt_issuer="https://sso.corporate.com", jwt_audience="dataviz",
    )).fetch_identity("ambient-xyz")
    assert identity.external_id == "emp-1"


@pytest.mark.asyncio
async def test_an_unknown_kid_forces_one_refetch(monkeypatch):
    """Key rotation: the cached document does not know the new kid, so
    it is fetched again before the token is refused."""
    stale = {"keys": [_jwk(kid="corp-2020")]}
    fresh = {"keys": [_jwk(kid="corp-2020"), _jwk(kid=KID)]}
    served: list[dict] = [stale, fresh]

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/jwks"):
            return httpx.Response(200, json=served.pop(0))
        return httpx.Response(
            200, content=_token().encode(),
            headers={"content-type": "application/jwt"},
        )

    provider = BackchannelProvider(_verified_settings())
    seen = _routes(monkeypatch, handler)
    identity = await provider.fetch_identity("ambient-xyz")
    assert identity.external_id == "emp-1"
    assert [r.url.path for r in seen] == ["/translate", "/jwks", "/jwks"]


@pytest.mark.asyncio
async def test_a_kid_unknown_even_after_refetching_is_refused(monkeypatch):
    stale = {"keys": [_jwk(kid="corp-2020")]}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/jwks"):
            return httpx.Response(200, json=stale)
        return httpx.Response(200, content=_token().encode())

    _routes(monkeypatch, handler)
    with pytest.raises(BackchannelError) as err:
        await BackchannelProvider(
            _verified_settings(),
        ).fetch_identity("ambient-xyz")
    assert err.value.code == "backchannel_jwt_invalid"


@pytest.mark.asyncio
async def test_a_jwks_outage_is_an_outage_not_a_verdict(monkeypatch):
    """The key set not answering must land in the same bucket as the
    IdP not answering — the liveness machinery must never read it as
    'this session is over'."""
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/jwks"):
            return httpx.Response(503)
        return httpx.Response(200, content=_token().encode())

    _routes(monkeypatch, handler)
    with pytest.raises(BackchannelUnavailable):
        await BackchannelProvider(
            _verified_settings(),
        ).fetch_identity("ambient-xyz")


@pytest.mark.asyncio
async def test_no_refusal_quotes_the_token(monkeypatch):
    """The token is the identity. Every message names a failure class;
    none may carry the material itself."""
    bad = _token(key=_OTHER_KEY)
    _routes(monkeypatch, _serving(bad))
    with pytest.raises(BackchannelError) as err:
        await BackchannelProvider(
            _verified_settings(),
        ).fetch_identity("ambient-xyz")
    assert bad not in str(err.value)
    assert bad.split(".")[1] not in str(err.value)


# ── configuration refusals ───────────────────────────────────────────

@pytest.mark.parametrize("over,needle", [
    (dict(claims_format="xml"), "claims_format"),
    (dict(claims_format="json", jwks_url=JWKS), "jwks_url"),
    (dict(jwks_url="", jwt_issuer="https://sso"), "jwt_issuer"),
    (dict(jwks_url="", jwt_audience="dataviz"), "jwt_audience"),
])
def test_impossible_jwt_combinations_are_refused(over, needle):
    with pytest.raises(BackchannelConfigError, match=needle):
        validate_settings(_settings(**over))
