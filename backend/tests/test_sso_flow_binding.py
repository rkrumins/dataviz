"""A handshake is bound to the provider — and the request — that began it.

Three separate gaps, all from the same root: the flow state carried less
than it needed to.

  * ONE ``nx_oidc`` and ONE ``nx_saml`` cookie name serve every provider
    slug, and neither state token named a provider. So a handshake begun
    at provider B satisfied provider A's state / RelayState check. Token
    validation still pins ``iss``/``aud`` to A's config, which is why
    this was a hardening gap rather than a live mixup — but it is
    exactly the half RFC 9207 exists to complete.
  * The AuthnRequest ``ID`` was never captured, so ``process_response``
    was called without a ``request_id`` — and python3-saml only compares
    ``InResponseTo`` when it is handed one. Nothing tied a response to
    the request that asked for it, and an unsolicited IdP-initiated
    response was accepted as an ordinary login. The library does not
    warn when the check is skipped.
  * SLO honoured an UNSIGNED LogoutRequest, over GET, on a CSRF-exempt
    route.

Cookies minted before this shipped carry no ``pid``/``rid`` and are
accepted rather than refused: they self-drain within the cookie's
10-minute life, and refusing them would break every handshake in flight
across a deploy for no security gain.
"""
from __future__ import annotations

import pytest

from backend.auth_service.core.tokens import (
    create_oidc_state_token,
    create_saml_state_token,
    decode_oidc_state_token,
    decode_saml_state_token,
)


class _Provider:
    def __init__(self, provider_id: str):
        self.provider_id = provider_id


def _belongs(flow, provider):
    from backend.auth_service.api.router import _flow_belongs_to

    return _flow_belongs_to(flow, provider)


# ── Provider binding ─────────────────────────────────────────────────

def test_an_oidc_flow_carries_the_provider_that_started_it():
    flow = decode_oidc_state_token(create_oidc_state_token(
        state="s", nonce="n", code_verifier="v", next_path="/",
        provider_id="idp_a",
    ))
    assert flow["pid"] == "idp_a"
    assert _belongs(flow, _Provider("idp_a")) is True


def test_an_oidc_flow_from_another_provider_is_refused():
    """The mixup case: provider B's handshake at provider A's callback."""
    flow = decode_oidc_state_token(create_oidc_state_token(
        state="s", nonce="n", code_verifier="v", next_path="/",
        provider_id="idp_b",
    ))
    assert _belongs(flow, _Provider("idp_a")) is False


def test_a_saml_flow_carries_the_provider_that_started_it():
    flow = decode_saml_state_token(create_saml_state_token(
        relay_state="rs", next_path="/", provider_id="idp_a",
    ))
    assert flow["pid"] == "idp_a"
    assert _belongs(flow, _Provider("idp_a")) is True


def test_a_saml_flow_from_another_provider_is_refused():
    flow = decode_saml_state_token(create_saml_state_token(
        relay_state="rs", next_path="/", provider_id="idp_b",
    ))
    assert _belongs(flow, _Provider("idp_a")) is False


@pytest.mark.parametrize("mint,decode,kwargs", [
    (create_oidc_state_token, decode_oidc_state_token,
     dict(state="s", nonce="n", code_verifier="v", next_path="/")),
    (create_saml_state_token, decode_saml_state_token,
     dict(relay_state="rs", next_path="/")),
])
def test_a_cookie_from_before_this_deploy_is_still_accepted(
    mint, decode, kwargs,
):
    """Self-draining compat. Refusing these would sign out every
    handshake in flight at deploy time and close nothing — the cookie
    lives ten minutes."""
    flow = decode(mint(**kwargs))
    assert "pid" not in flow
    assert _belongs(flow, _Provider("idp_a")) is True


# ── InResponseTo ─────────────────────────────────────────────────────

def test_a_saml_flow_carries_the_authnrequest_id():
    flow = decode_saml_state_token(create_saml_state_token(
        relay_state="rs", next_path="/", request_id="_req_123",
    ))
    assert flow["rid"] == "_req_123"


saml2 = pytest.importorskip(
    "backend.auth_service.providers.saml2",
    reason="python3-saml / libxmlsec1 not available",
)


def test_build_authorization_returns_the_request_id():
    """It has to be captured at leg 1 or there is nothing to compare at
    leg 2 — which is why the check was silently absent."""
    import inspect

    src = inspect.getsource(saml2.SamlProvider.build_authorization)
    assert "get_last_request_id" in src
    assert inspect.signature(
        saml2.SamlProvider.build_authorization
    ).return_annotation == "tuple[str, str, str]"


def test_fetch_identity_passes_the_expected_id_to_the_library():
    """python3-saml compares ``InResponseTo`` only when handed a
    ``request_id``, and says nothing when it is not."""
    import inspect

    src = inspect.getsource(saml2.SamlProvider.fetch_identity)
    assert "process_response(request_id=" in src
    assert "expected_request_id" in inspect.signature(
        saml2.SamlProvider.fetch_identity
    ).parameters


# ── SLO signature ────────────────────────────────────────────────────

def test_slo_requires_a_signed_message_and_login_does_not(monkeypatch):
    """``wantMessagesSigned`` cannot be on globally — ID-style IdPs sign
    the assertion, not the Response, and login must keep working with
    them. A LogoutRequest has no assertion, so for SLO the message
    signature is the only thing that can authenticate it."""
    settings = saml2.SamlSettings(
        provider_id="idp_1", provider_slug="corp",
        idp_entity_id="https://idp.example/meta",
        idp_sso_url="https://idp.example/sso",
        idp_x509_cert="MIIBstub",
        sp_entity_id="https://app.example/sp",
        sp_acs_url="https://app.example/acs",
    )
    provider = saml2.SamlProvider(settings)

    login_cfg = provider._settings_dict()
    slo_cfg = provider._settings_dict(want_messages_signed=True)

    assert login_cfg["security"]["wantMessagesSigned"] is False
    assert slo_cfg["security"]["wantMessagesSigned"] is True
    # The assertion signature is required either way — that is the one
    # that must never be optional.
    for cfg in (login_cfg, slo_cfg):
        assert cfg["security"]["wantAssertionsSigned"] is True
        assert cfg["strict"] is True
