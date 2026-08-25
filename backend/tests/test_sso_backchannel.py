"""The back-channel provider: two configurable legs, and how each fails.

This kind is the only one that makes outbound calls during a login, so
its failure modes are the interesting part. Three properties are load-
bearing and each has tests here:

* **Fail closed.** A timeout, a 5xx, a redirect, an oversized body, a
  missing field — none of them yield a partial identity.
* **The tokens stay opaque.** Nothing decodes them, and nothing leaks
  them into an error an operator will read.
* **"Revoked" and "unreachable" are different answers.** The liveness
  check ends a session on the first and must not on the second, so the
  provider has to keep them apart rather than collapsing both into
  "failed".

Both legs are driven through the real ``request_json``, with only the
transport mocked, so the guard, the redirect ban and the size cap are
exercised rather than stubbed past.
"""
from __future__ import annotations

import httpx
import pytest

from backend.auth_service.providers import backchannel as bc
from backend.auth_service.providers.backchannel import (
    BackchannelConfigError,
    BackchannelError,
    BackchannelProvider,
    BackchannelSettings,
    BackchannelUnavailable,
    SessionRevokedUpstream,
    build_backchannel_provider,
    validate_settings,
)
from backend.auth_service.providers import outbound
from backend.auth_service.providers.registry import ProviderConfigSnapshot

_REAL_ASYNC_CLIENT = httpx.AsyncClient

GATEWAY = "https://gw.corp.example/redeem"
EXCHANGE = "https://gw.corp.example/userinfo"

CLAIMS = {
    "sub": "emp-1",
    "email": "alice@corp.example",
    "firstName": "Alice",
    "lastName": "Anders",
    "auth_time": 1_700_000_000,
}


def _settings(**over) -> BackchannelSettings:
    base = dict(
        token_source="cookie", token_source_key="corp_session",
        gateway_url=GATEWAY, gateway_send_as="cookie",
        gateway_token_path="access_token",
        exchange_url=EXCHANGE, exchange_send_as="body",
        exchange_body_field="token",
    )
    base.update(over)
    return BackchannelSettings(**base)


def _routes(monkeypatch, handler):
    """Point every outbound call at *handler*, and record what was sent."""
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


def _happy(request: httpx.Request) -> httpx.Response:
    if request.url.path.endswith("/redeem"):
        return httpx.Response(200, json={"access_token": "gw-token-abc"})
    return httpx.Response(200, json=CLAIMS)


def _provider(**over) -> BackchannelProvider:
    return BackchannelProvider(_settings(**over))


# ── the happy path, and where each token goes ────────────────────────

@pytest.mark.asyncio
async def test_both_legs_run_and_an_identity_comes_back(monkeypatch):
    seen = _routes(monkeypatch, _happy)
    identity = await _provider().fetch_identity("ambient-xyz")

    assert [r.url.path for r in seen] == ["/redeem", "/userinfo"]
    assert identity.email == "alice@corp.example"
    assert identity.external_id == "emp-1"
    assert identity.first_name == "Alice"
    assert identity.auth_time == 1_700_000_000


@pytest.mark.asyncio
async def test_the_ambient_token_goes_where_the_row_says_cookie(monkeypatch):
    seen = _routes(monkeypatch, _happy)
    await _provider().fetch_identity("ambient-xyz")
    assert "corp_session=ambient-xyz" in seen[0].headers.get("cookie", "")


@pytest.mark.asyncio
async def test_the_ambient_token_goes_where_the_row_says_header(monkeypatch):
    seen = _routes(monkeypatch, _happy)
    await _provider(
        gateway_send_as="header", gateway_token_header="X-Session",
        gateway_token_prefix="Session ",
    ).fetch_identity("ambient-xyz")
    assert seen[0].headers["x-session"] == "Session ambient-xyz"


@pytest.mark.asyncio
async def test_the_ambient_token_goes_where_the_row_says_body(monkeypatch):
    import json
    seen = _routes(monkeypatch, _happy)
    await _provider(
        gateway_send_as="body", gateway_body_field="sessionId",
    ).fetch_identity("ambient-xyz")
    assert json.loads(seen[0].content) == {"sessionId": "ambient-xyz"}


@pytest.mark.asyncio
async def test_the_gateway_token_is_presented_to_the_exchange(monkeypatch):
    import json
    seen = _routes(monkeypatch, _happy)
    await _provider().fetch_identity("ambient-xyz")
    assert json.loads(seen[1].content) == {"token": "gw-token-abc"}


@pytest.mark.asyncio
async def test_static_headers_are_forwarded_on_both_legs(monkeypatch):
    """Where an app id and secret live. They are configuration, not
    something this module knows the meaning of."""
    seen = _routes(monkeypatch, _happy)
    await _provider(
        gateway_headers={"X-App-Id": "app-1", "X-App-Secret": "s3cr3t"},
        exchange_headers={"X-App-Id": "app-1"},
    ).fetch_identity("ambient-xyz")
    assert seen[0].headers["x-app-id"] == "app-1"
    assert seen[0].headers["x-app-secret"] == "s3cr3t"
    assert seen[1].headers["x-app-id"] == "app-1"


# ── shapes the operator configures ───────────────────────────────────

@pytest.mark.asyncio
async def test_a_gateway_that_answers_with_claims_needs_no_second_leg(monkeypatch):
    """One round trip instead of two, no code change — just a blank
    exchange_url."""
    seen = _routes(
        monkeypatch, lambda r: httpx.Response(200, json=CLAIMS),
    )
    identity = await _provider(exchange_url="").fetch_identity("ambient-xyz")
    assert [r.url.path for r in seen] == ["/redeem"]
    assert identity.email == "alice@corp.example"


@pytest.mark.asyncio
async def test_dotted_paths_reach_into_a_nested_response(monkeypatch):
    def handler(request):
        if request.url.path.endswith("/redeem"):
            return httpx.Response(200, json={"data": {"tokens": [
                {"value": "gw-token-abc"},
            ]}})
        return httpx.Response(200, json={"response": {"user": CLAIMS}})

    _routes(monkeypatch, handler)
    identity = await _provider(
        gateway_token_path="data.tokens[0].value",
        exchange_claims_path="response.user",
    ).fetch_identity("ambient-xyz")
    assert identity.external_id == "emp-1"


@pytest.mark.asyncio
async def test_one_level_of_nesting_is_hoisted_without_dotted_paths(monkeypatch):
    """So an operator maps ``firstName``, not ``user.firstName``."""
    def handler(request):
        if request.url.path.endswith("/redeem"):
            return httpx.Response(200, json={"access_token": "gw-token-abc"})
        return httpx.Response(200, json={"user": CLAIMS})

    _routes(monkeypatch, handler)
    identity = await _provider().fetch_identity("ambient-xyz")
    assert identity.email == "alice@corp.example"


# ── fail closed ──────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_no_ambient_token_is_a_refusal_before_any_call(monkeypatch):
    seen = _routes(monkeypatch, _happy)
    with pytest.raises(BackchannelError):
        await _provider().fetch_identity("   ")
    assert seen == []


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [401, 403])
async def test_an_authoritative_rejection_is_its_own_error(monkeypatch, status):
    """The distinction the liveness check turns on: this one ends a
    session, and the outage cases below must not."""
    _routes(monkeypatch, lambda r: httpx.Response(status, json={}))
    with pytest.raises(SessionRevokedUpstream):
        await _provider().fetch_identity("ambient-xyz")


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [400, 404, 500, 502, 503])
async def test_any_other_bad_status_is_an_outage_not_a_verdict(
    monkeypatch, status,
):
    _routes(monkeypatch, lambda r: httpx.Response(status, json={}))
    with pytest.raises(BackchannelUnavailable):
        await _provider().fetch_identity("ambient-xyz")


@pytest.mark.asyncio
async def test_a_redirect_from_the_gateway_is_refused(monkeypatch):
    """Following one would defeat the address check: it ran against the
    URL an operator configured, and the request would land elsewhere."""
    _routes(monkeypatch, lambda r: httpx.Response(
        302, headers={"location": "http://169.254.169.254/"},
    ))
    with pytest.raises(BackchannelUnavailable):
        await _provider().fetch_identity("ambient-xyz")


@pytest.mark.asyncio
async def test_an_oversized_response_is_refused(monkeypatch):
    _routes(monkeypatch, lambda r: httpx.Response(200, content=b"x" * 9000))
    with pytest.raises(BackchannelUnavailable):
        await _provider(max_response_bytes=1024).fetch_identity("ambient-xyz")


@pytest.mark.asyncio
async def test_a_non_json_response_is_refused(monkeypatch):
    _routes(monkeypatch, lambda r: httpx.Response(200, content=b"<html/>"))
    with pytest.raises(BackchannelUnavailable):
        await _provider().fetch_identity("ambient-xyz")


@pytest.mark.asyncio
async def test_a_timeout_is_an_outage(monkeypatch):
    def _boom(request):
        raise httpx.ConnectTimeout("too slow", request=request)

    _routes(monkeypatch, _boom)
    with pytest.raises(BackchannelUnavailable):
        await _provider().fetch_identity("ambient-xyz")


@pytest.mark.asyncio
async def test_a_gateway_response_with_no_token_is_refused(monkeypatch):
    _routes(monkeypatch, lambda r: httpx.Response(200, json={"ok": True}))
    with pytest.raises(BackchannelError) as err:
        await _provider().fetch_identity("ambient-xyz")
    assert "access_token" in str(err.value)


@pytest.mark.asyncio
async def test_claims_that_are_not_an_object_are_refused(monkeypatch):
    def handler(request):
        if request.url.path.endswith("/redeem"):
            return httpx.Response(200, json={"access_token": "gw-token-abc"})
        return httpx.Response(200, json=["not", "an", "object"])

    _routes(monkeypatch, handler)
    with pytest.raises(BackchannelError):
        await _provider().fetch_identity("ambient-xyz")


@pytest.mark.asyncio
async def test_claims_without_an_auth_time_are_refused_by_default(monkeypatch):
    """``complete_sso_login`` falls back to "now" with a warning when
    ``auth_time`` is absent, which quietly disables the 24h SSO re-auth
    ceiling for every session this provider mints. Refusing here is what
    keeps that ceiling meaningful."""
    def handler(request):
        if request.url.path.endswith("/redeem"):
            return httpx.Response(200, json={"access_token": "gw-token-abc"})
        return httpx.Response(200, json={k: v for k, v in CLAIMS.items()
                                         if k != "auth_time"})

    _routes(monkeypatch, handler)
    with pytest.raises(BackchannelError, match="auth_time"):
        await _provider().fetch_identity("ambient-xyz")


@pytest.mark.asyncio
async def test_an_operator_can_accept_claims_without_an_auth_time(monkeypatch):
    def handler(request):
        if request.url.path.endswith("/redeem"):
            return httpx.Response(200, json={"access_token": "gw-token-abc"})
        return httpx.Response(200, json={k: v for k, v in CLAIMS.items()
                                         if k != "auth_time"})

    _routes(monkeypatch, handler)
    identity = await _provider(require_auth_time=False).fetch_identity("a-xyz")
    assert identity.email == "alice@corp.example"


# ── the tokens stay opaque ───────────────────────────────────────────

@pytest.mark.asyncio
async def test_no_failure_message_carries_either_token(monkeypatch):
    """Both are live credentials. An error string is the one place they
    would plausibly end up written down — a log line, an audit row, a
    message shown to an admin."""
    ambient = "AMBIENT-SECRET-VALUE"
    gateway_token = "GATEWAY-SECRET-VALUE"

    def handler(request):
        if request.url.path.endswith("/redeem"):
            return httpx.Response(200, json={"access_token": gateway_token})
        return httpx.Response(500, content=b"upstream detail")

    _routes(monkeypatch, handler)
    with pytest.raises(BackchannelError) as err:
        await _provider().fetch_identity(ambient)
    message = str(err.value)
    assert ambient not in message
    assert gateway_token not in message


# ── liveness asks only the first leg ─────────────────────────────────

@pytest.mark.asyncio
async def test_confirming_liveness_costs_one_call_not_two(monkeypatch):
    """It runs on every rotation. The claims are not needed to answer
    "is this session still live", so fetching them would double the
    cost of the check for nothing."""
    seen = _routes(monkeypatch, _happy)
    await _provider().confirm_still_authenticated("ambient-xyz")
    assert [r.url.path for r in seen] == ["/redeem"]


@pytest.mark.asyncio
async def test_liveness_reports_a_rejection_and_an_outage_differently(
    monkeypatch,
):
    _routes(monkeypatch, lambda r: httpx.Response(401, json={}))
    with pytest.raises(SessionRevokedUpstream):
        await _provider().confirm_still_authenticated("ambient-xyz")

    _routes(monkeypatch, lambda r: httpx.Response(503, json={}))
    with pytest.raises(BackchannelUnavailable):
        await _provider().confirm_still_authenticated("ambient-xyz")


# ── the allowlist reaches the guard ──────────────────────────────────

INTERNAL = "https://10.0.0.5/redeem"


@pytest.mark.asyncio
async def test_an_internal_gateway_is_refused_without_an_allowlist_entry(
    monkeypatch,
):
    """The provider is useless without the allowlist and must say so by
    refusing, not by reaching an address nobody permitted."""
    seen = _routes(monkeypatch, _happy)
    provider = BackchannelProvider(
        _settings(gateway_url=INTERNAL, exchange_url=""),
    )
    with pytest.raises(BackchannelUnavailable):
        await provider.fetch_identity("ambient-xyz")
    assert seen == []


@pytest.mark.asyncio
async def test_an_allowlisted_internal_gateway_is_reached(monkeypatch):
    seen = _routes(monkeypatch, lambda r: httpx.Response(200, json=CLAIMS))

    async def _allowed():
        return frozenset({"10.0.0.5:443"})

    provider = BackchannelProvider(
        _settings(gateway_url=INTERNAL, exchange_url=""),
        allowed_hosts=_allowed,
    )
    identity = await provider.fetch_identity("ambient-xyz")
    assert identity.email == "alice@corp.example"
    assert len(seen) == 1


@pytest.mark.asyncio
async def test_the_allowlist_is_read_per_request_not_per_build(monkeypatch):
    """Removing a host has to stop working now. The registry caches
    provider instances for 60s, so an allowlist resolved at build time
    would keep a revoked destination reachable for a minute."""
    _routes(monkeypatch, lambda r: httpx.Response(200, json=CLAIMS))
    reads = []
    allowed = {"10.0.0.5:443"}

    async def _allowed():
        reads.append(1)
        return frozenset(allowed)

    provider = BackchannelProvider(
        _settings(gateway_url=INTERNAL, exchange_url=""),
        allowed_hosts=_allowed,
    )
    await provider.fetch_identity("ambient-xyz")
    allowed.clear()
    with pytest.raises(BackchannelUnavailable):
        await provider.fetch_identity("ambient-xyz")
    assert len(reads) == 2


# ── configuration that must not be accepted ──────────────────────────

@pytest.mark.parametrize("over,fragment", [
    ({"gateway_url": ""}, "gateway_url"),
    ({"token_source_key": ""}, "token_source_key"),
    ({"token_source": "local_storage"}, "token_source"),
    ({"gateway_send_as": "header", "gateway_token_header": ""}, "token_header"),
    ({"gateway_send_as": "body", "gateway_body_field": "x",
      "gateway_method": "GET"}, "GET"),
    ({"gateway_send_as": "body", "gateway_body_field": ""}, "body_field"),
    ({"gateway_send_as": "smoke-signal"}, "send_as"),
    ({"gateway_method": "DELETE"}, "method"),
    ({"gateway_token_path": ""}, "gateway_token_path"),
    ({"exchange_send_as": "cookie"}, "cookie"),
    ({"timeout_seconds": 0}, "timeout"),
    ({"max_response_bytes": 0}, "max_response_bytes"),
    ({"liveness_grace_seconds": -1}, "liveness_grace_seconds"),
])
def test_a_row_that_would_not_work_is_refused_at_build_time(over, fragment):
    """At build time, not at login time: a misconfigured row should
    surface when the registry materialises it, not to the first user who
    tries to sign in with it."""
    with pytest.raises(BackchannelConfigError, match=fragment):
        validate_settings(_settings(**over))


def test_the_builder_validates(monkeypatch):
    snap = ProviderConfigSnapshot(
        id="idp_1", slug="corp", display_name="Corp", kind="backchannel",
        enabled=True, priority=100, settings={"token_source_key": "x"},
        claim_mapping={}, linking_policy="strict",
        button_label=None, button_icon=None,
    )
    with pytest.raises(BackchannelConfigError):
        build_backchannel_provider(snap)


def test_settings_survive_the_round_trip_from_a_row():
    snap = ProviderConfigSnapshot(
        id="idp_1", slug="corp", display_name="Corp", kind="backchannel",
        enabled=True, priority=100,
        settings={
            "token_source": "header", "token_source_key": "X-Corp",
            "gateway_url": GATEWAY, "gateway_send_as": "header",
            "gateway_token_header": "Authorization",
            "gateway_headers": {"X-App-Id": "a"},
            "exchange_url": EXCHANGE, "liveness_grace_seconds": "120",
            "timeout_seconds": "2.5", "require_auth_time": "false",
        },
        claim_mapping={"email": ["mail"]}, linking_policy="allow_verified",
        button_label=None, button_icon=None,
    )
    provider = build_backchannel_provider(snap)
    s = provider.settings
    assert s.token_source == "header"
    assert s.gateway_headers == {"X-App-Id": "a"}
    assert s.liveness_grace_seconds == 120
    assert s.timeout_seconds == 2.5
    assert s.require_auth_time is False
    assert s.claim_mapping_override == {"email": ["mail"]}
    assert s.linking_policy == "allow_verified"


# ── trusting the gateway's email addresses ───────────────────────────
#
# The linking-by-email step this kind exists for is gated on
# email_verified, which corporate gateways rarely send. The toggle says
# absence counts as verified; anything the gateway actually says wins.

@pytest.mark.asyncio
async def test_an_absent_email_verified_counts_as_verified_by_default(
    monkeypatch,
):
    _routes(monkeypatch, _happy)   # CLAIMS carries no email_verified
    identity = await _provider().fetch_identity("ambient-xyz")
    assert identity.raw_claims["email_verified"] is True


@pytest.mark.asyncio
async def test_the_trust_toggle_turns_that_off(monkeypatch):
    _routes(monkeypatch, _happy)
    identity = await _provider(
        trust_gateway_email=False,
    ).fetch_identity("ambient-xyz")
    assert identity.raw_claims["email_verified"] is False


@pytest.mark.asyncio
async def test_an_explicit_false_from_the_gateway_still_wins(monkeypatch):
    """The toggle covers absence, never contradiction: a gateway that
    says an address is unverified is believed."""
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/redeem"):
            return httpx.Response(200, json={"access_token": "gw-token-abc"})
        return httpx.Response(200, json={**CLAIMS, "email_verified": False})

    _routes(monkeypatch, handler)
    identity = await _provider().fetch_identity("ambient-xyz")
    assert identity.raw_claims["email_verified"] is False


@pytest.mark.asyncio
async def test_an_explicit_true_needs_no_toggle(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/redeem"):
            return httpx.Response(200, json={"access_token": "gw-token-abc"})
        return httpx.Response(200, json={**CLAIMS, "email_verified": True})

    _routes(monkeypatch, handler)
    identity = await _provider(
        trust_gateway_email=False,
    ).fetch_identity("ambient-xyz")
    assert identity.raw_claims["email_verified"] is True
