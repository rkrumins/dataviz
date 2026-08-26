"""The guarded outbound helper, and the one exception it permits.

``assert_fetchable`` refuses every private address, which is correct for
IdP *metadata* — that is published on the public internet. It is fatal
for a back-channel identity gateway, which is on RFC1918 by definition:
"internal SSO endpoint" is the whole point of the pattern.

So the guard grows an allowlist. The risk that creates is the reason
most of this file exists: an allowlist that could be talked into
reaching ``169.254.169.254`` would convert an admin form into
instance-credential theft. These tests pin the floor that no entry can
lower, and pin that the relaxation is otherwise exact — one host, one
port, one address class.
"""
from __future__ import annotations

import httpx
import pytest

from backend.auth_service.providers import outbound
from backend.auth_service.providers.outbound import (
    BlockedOutboundRequest,
    OutboundStatusError,
    assert_fetchable,
    host_port_key,
    request_json,
)


# ── the allowlist key ────────────────────────────────────────────────

@pytest.mark.parametrize("url,expected", [
    ("https://gw.corp.internal/x",      "gw.corp.internal:443"),
    ("https://GW.Corp.Internal/x",      "gw.corp.internal:443"),
    ("https://gw.corp.internal./x",     "gw.corp.internal:443"),
    ("https://gw.corp.internal:443/x",  "gw.corp.internal:443"),
    ("https://gw.corp.internal:8443/x", "gw.corp.internal:8443"),
    ("http://gw.corp.internal/x",       "gw.corp.internal:80"),
])
def test_the_key_is_normalised_and_the_port_is_always_explicit(url, expected):
    """Case, a trailing root dot, and an implicit port are all the same
    entry — an operator should not have to guess which spelling the
    form wants."""
    assert host_port_key(url) == expected


# ── what the allowlist unlocks ───────────────────────────────────────

PRIVATE = "https://10.0.0.5/authenticate"


def test_a_private_address_is_still_refused_by_default():
    with pytest.raises(BlockedOutboundRequest):
        assert_fetchable(PRIVATE)


def test_the_allowlist_permits_exactly_that_host_and_port():
    assert_fetchable(PRIVATE, allow_hosts={"10.0.0.5:443"})  # no raise


def test_a_different_port_on_an_allowed_host_is_refused():
    """The entry names a service, not a machine. Allowing the gateway
    on 443 must not also allow Redis on 6379 on the same box."""
    with pytest.raises(BlockedOutboundRequest):
        assert_fetchable("https://10.0.0.5:6379/x", allow_hosts={"10.0.0.5:443"})


def test_an_entry_for_a_different_host_does_not_carry_over():
    with pytest.raises(BlockedOutboundRequest):
        assert_fetchable(PRIVATE, allow_hosts={"10.0.0.6:443"})


def test_entries_are_matched_case_insensitively():
    assert_fetchable(
        "https://10.0.0.5/x", allow_hosts={"  10.0.0.5:443  "},
    )  # no raise


# ── the floor no entry can lower ─────────────────────────────────────

NEVER = [
    # The one that matters: cloud metadata. Reaching this is not
    # information disclosure, it is instance credentials.
    "https://169.254.169.254/latest/meta-data/",
    # The IPv4-mapped IPv6 spelling of the same destination.
    "https://[::ffff:169.254.169.254]/latest/meta-data/",
    # Our own process: Redis, debug ports, internal endpoints.
    "https://127.0.0.1/x",
    "https://[::1]/x",
    # Not a destination at all.
    "https://0.0.0.0/x",
    "https://[ff02::1]/x",
]


@pytest.mark.parametrize("url", NEVER)
def test_these_are_refused_even_when_explicitly_allowlisted(url):
    """The whole security argument for a UI-editable allowlist rests on
    this test. An operator can permit their internal gateway; they
    cannot permit the metadata service, whatever they type in the form.
    """
    with pytest.raises(BlockedOutboundRequest):
        assert_fetchable(url, allow_hosts={host_port_key(url)})


def test_plain_http_in_production_is_refused_even_when_allowlisted(monkeypatch):
    monkeypatch.setenv("ENV", "production")
    with pytest.raises(BlockedOutboundRequest):
        assert_fetchable("http://10.0.0.5/x", allow_hosts={"10.0.0.5:80"})


def test_a_non_http_scheme_is_refused_even_when_allowlisted():
    with pytest.raises(BlockedOutboundRequest):
        assert_fetchable("file:///etc/passwd", allow_hosts={":443"})


# ── request_json ─────────────────────────────────────────────────────

URL = "https://sso.example.com/gateway"


#: Captured before any monkeypatching. ``outbound.httpx`` IS the global
#: ``httpx`` module, so patching ``AsyncClient`` through it also rebinds
#: the name this helper would otherwise call — and the factory would
#: recurse into itself instead of building a client.
_REAL_ASYNC_CLIENT = httpx.AsyncClient


def _mock_client(handler):
    """Swap the helper's client for one wired to a MockTransport,
    preserving the kwargs the helper passes (timeout, redirects off)."""
    def _make(**kwargs):
        return _REAL_ASYNC_CLIENT(
            transport=httpx.MockTransport(handler), **kwargs,
        )
    return _make


@pytest.mark.asyncio
async def test_a_json_body_comes_back_parsed(monkeypatch):
    def handler(request):
        assert request.method == "POST"
        assert request.headers["x-app-id"] == "app-1"
        return httpx.Response(200, json={"token": "abc"})

    monkeypatch.setattr(outbound.httpx, "AsyncClient", _mock_client(handler))
    got = await request_json(
        URL, json_body={"session": "xyz"},
        headers={"x-app-id": "app-1"}, timeout=2.0,
    )
    assert got == {"token": "abc"}


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [301, 302, 303, 307, 308])
async def test_a_redirect_is_an_error_not_a_hop(monkeypatch, status):
    """Following one would defeat the pre-flight address check
    entirely: the check ran against the first URL, the request lands on
    the second."""
    monkeypatch.setattr(
        outbound.httpx, "AsyncClient",
        _mock_client(lambda r: httpx.Response(
            status, headers={"location": "http://169.254.169.254/"},
        )),
    )
    with pytest.raises(BlockedOutboundRequest, match="redirect"):
        await request_json(URL, timeout=2.0)


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [400, 401, 403, 404, 500, 502, 503])
async def test_a_failure_status_fails_closed(monkeypatch, status):
    """And carries the code, which the liveness check reads to tell
    "the IdP revoked this session" from "the IdP is having an
    outage"."""
    monkeypatch.setattr(
        outbound.httpx, "AsyncClient",
        _mock_client(lambda r: httpx.Response(status, json={"error": "nope"})),
    )
    with pytest.raises(OutboundStatusError) as err:
        await request_json(URL, timeout=2.0)
    assert err.value.status_code == status


@pytest.mark.asyncio
async def test_an_oversized_response_is_refused(monkeypatch):
    monkeypatch.setattr(
        outbound.httpx, "AsyncClient",
        _mock_client(lambda r: httpx.Response(200, content=b"x" * 5000)),
    )
    with pytest.raises(BlockedOutboundRequest, match="cap"):
        await request_json(URL, timeout=2.0, max_bytes=1024)


@pytest.mark.asyncio
async def test_a_non_json_response_is_refused(monkeypatch):
    monkeypatch.setattr(
        outbound.httpx, "AsyncClient",
        _mock_client(lambda r: httpx.Response(200, content=b"<html>hi</html>")),
    )
    with pytest.raises(BlockedOutboundRequest, match="valid JSON"):
        await request_json(URL, timeout=2.0)


@pytest.mark.asyncio
async def test_the_response_body_never_reaches_the_error_message(monkeypatch):
    """These errors surface to an administrator. A helper that echoed
    what an internal address replied would hand back exactly the
    capability the address check exists to withhold.
    """
    secret = "SUPER-SECRET-INTERNAL-DETAIL"
    monkeypatch.setattr(
        outbound.httpx, "AsyncClient",
        _mock_client(lambda r: httpx.Response(500, content=secret.encode())),
    )
    with pytest.raises(OutboundStatusError) as err:
        await request_json(URL, timeout=2.0)
    assert secret not in str(err.value)


@pytest.mark.asyncio
async def test_the_destination_is_checked_before_the_request_is_made(monkeypatch):
    """The pre-flight check is the point: an SSRF's value is often the
    side effect, not the response, so a request that gets sent and then
    judged has already done the damage."""
    sent = []
    monkeypatch.setattr(
        outbound.httpx, "AsyncClient",
        _mock_client(lambda r: sent.append(r) or httpx.Response(200, json={})),
    )
    with pytest.raises(BlockedOutboundRequest):
        await request_json("https://169.254.169.254/x", timeout=2.0)
    assert sent == []


# ── accept_jwt: the one widened refusal ──────────────────────────────

_JWS = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJlbXAtMSJ9.c2ln"


@pytest.mark.asyncio
async def test_a_bare_jwt_body_passes_when_the_caller_expects_one(monkeypatch):
    """A token-translation endpoint that answers with the token as the
    whole body — text/plain, not JSON. The caller says it expects that
    shape; nothing else about the transport rules changes."""
    monkeypatch.setattr(
        outbound.httpx, "AsyncClient",
        _mock_client(lambda r: httpx.Response(
            200, content=_JWS.encode(),
            headers={"content-type": "application/jwt"},
        )),
    )
    got = await request_json(URL, timeout=2.0, accept_jwt=True)
    assert got == _JWS


@pytest.mark.asyncio
async def test_a_bare_jwt_body_is_still_refused_without_the_flag(monkeypatch):
    """The default stays strict: a caller that expects JSON gets the
    same refusal it always did, whatever the body looks like."""
    monkeypatch.setattr(
        outbound.httpx, "AsyncClient",
        _mock_client(lambda r: httpx.Response(200, content=_JWS.encode())),
    )
    with pytest.raises(BlockedOutboundRequest, match="valid JSON"):
        await request_json(URL, timeout=2.0)


@pytest.mark.asyncio
async def test_accept_jwt_does_not_admit_arbitrary_text(monkeypatch):
    """The flag widens the refusal for exactly one shape. HTML — an SSO
    portal's login page, say — is still an error, not a token."""
    monkeypatch.setattr(
        outbound.httpx, "AsyncClient",
        _mock_client(lambda r: httpx.Response(200, content=b"<html>hi</html>")),
    )
    with pytest.raises(BlockedOutboundRequest, match="valid JSON"):
        await request_json(URL, timeout=2.0, accept_jwt=True)


@pytest.mark.asyncio
async def test_a_json_wrapped_jwt_needs_no_flag(monkeypatch):
    """`{"access_token": "<jws>"}` is just JSON with a string in it; the
    caller resolves a path to it. The flag exists only for the bare-body
    shape."""
    monkeypatch.setattr(
        outbound.httpx, "AsyncClient",
        _mock_client(lambda r: httpx.Response(200, json={"access_token": _JWS})),
    )
    got = await request_json(URL, timeout=2.0)
    assert got == {"access_token": _JWS}


# ── fetch_jwks: the key set, guarded like everything else ────────────

@pytest.mark.asyncio
async def test_fetch_jwks_returns_the_document(monkeypatch):
    def handler(request):
        assert request.method == "GET"
        return httpx.Response(200, json={"keys": [{"kid": "a", "kty": "RSA"}]})

    monkeypatch.setattr(outbound.httpx, "AsyncClient", _mock_client(handler))
    doc = await outbound.fetch_jwks(URL, timeout=2.0)
    assert doc["keys"][0]["kid"] == "a"


@pytest.mark.asyncio
async def test_fetch_jwks_refuses_a_non_jwks_answer(monkeypatch):
    """An object without a `keys` array is not a key set, whatever else
    it is. Refusing here beats handing PyJWT a shape it half-tolerates."""
    monkeypatch.setattr(
        outbound.httpx, "AsyncClient",
        _mock_client(lambda r: httpx.Response(200, json={"nope": True})),
    )
    with pytest.raises(BlockedOutboundRequest, match="JWKS"):
        await outbound.fetch_jwks(URL, timeout=2.0)


@pytest.mark.asyncio
async def test_fetch_jwks_goes_through_the_destination_guard(monkeypatch):
    """The key set decides which signatures verify. This is the fetch
    PyJWKClient would have made unguarded — the reason fetch_jwks
    exists is that it must not be."""
    sent = []
    monkeypatch.setattr(
        outbound.httpx, "AsyncClient",
        _mock_client(lambda r: sent.append(r) or httpx.Response(200, json={"keys": []})),
    )
    with pytest.raises(BlockedOutboundRequest):
        await outbound.fetch_jwks("https://169.254.169.254/jwks", timeout=2.0)
    assert sent == []
