"""Discovery-first provider onboarding.

Standing up an IdP meant hand-transcribing ~15 fields between two admin
consoles — issuer URLs, entity ids, a base64 signing certificate. Each one
is a chance to introduce a typo that surfaces days later as an opaque login
failure. Both protocols publish this; these tests pin that we read it, and
that an unreachable IdP is an answer rather than a server fault.
"""
from __future__ import annotations

import httpx
import pytest

from backend.auth_service.providers.oidc import OidcError, discover_issuer

SAML_METADATA = """<?xml version="1.0"?>
<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata"
                  entityID="http://idp.example.com/metadata">
  <IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <KeyDescriptor use="signing">
      <KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#">
        <X509Data><X509Certificate>MIIBdummycertdata</X509Certificate></X509Data>
      </KeyInfo>
    </KeyDescriptor>
    <SingleLogoutService
      Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect"
      Location="https://idp.example.com/slo"/>
    <SingleSignOnService
      Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect"
      Location="https://idp.example.com/sso"/>
  </IDPSSODescriptor>
</EntityDescriptor>
"""


def _mock_discovery(monkeypatch, doc: dict | None, *, boom: Exception | None = None):
    """Patch httpx.AsyncClient.get so discovery never touches the network."""
    async def _get(self, url, *a, **k):  # noqa: ANN001
        if boom is not None:
            raise boom
        return httpx.Response(
            200, json=doc, request=httpx.Request("GET", url),
        )
    monkeypatch.setattr(httpx.AsyncClient, "get", _get)


# ── OIDC ─────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_discovery_derives_settings_from_the_issuer(monkeypatch):
    _mock_discovery(monkeypatch, {
        "issuer": "https://idp.example.com",
        "authorization_endpoint": "https://idp.example.com/authorize",
        "token_endpoint": "https://idp.example.com/token",
        "jwks_uri": "https://idp.example.com/jwks",
        "code_challenge_methods_supported": ["S256"],
        "scopes_supported": ["openid", "email", "profile", "offline_access"],
    })
    found = await discover_issuer("https://idp.example.com")

    assert found["settings"]["issuer"] == "https://idp.example.com"
    assert found["settings"]["scopes"] == "openid email profile"
    assert found["metadata"]["jwks_uri"] == "https://idp.example.com/jwks"
    assert found["warnings"] == []
    # Discovery never invents credentials — those are the operator's.
    assert "client_id" not in found["settings"]
    assert "client_secret" not in found["settings"]


@pytest.mark.asyncio
async def test_a_trailing_slash_does_not_look_like_a_mismatch(monkeypatch):
    """IdP consoles print issuers with and without a trailing slash.
    ``_discovery`` compares the document's issuer to the configured one, so
    without normalising, a pasted slash yields a baffling "issuer mismatch"
    against a perfectly good IdP."""
    _mock_discovery(monkeypatch, {
        "issuer": "https://idp.example.com",
        "jwks_uri": "https://idp.example.com/jwks",
    })
    found = await discover_issuer("https://idp.example.com/")
    assert found["settings"]["issuer"] == "https://idp.example.com"


@pytest.mark.asyncio
async def test_a_genuinely_mismatched_issuer_is_still_refused(monkeypatch):
    """Normalising the slash must not weaken the check that stops a swapped
    metadata endpoint."""
    _mock_discovery(monkeypatch, {"issuer": "https://evil.example.com"})
    with pytest.raises(OidcError, match="mismatch"):
        await discover_issuer("https://idp.example.com")


@pytest.mark.asyncio
async def test_missing_pkce_and_jwks_are_warned_about(monkeypatch):
    _mock_discovery(monkeypatch, {
        "issuer": "https://old.example.com",
        "code_challenge_methods_supported": ["plain"],
    })
    found = await discover_issuer("https://old.example.com")
    joined = " ".join(found["warnings"])
    assert "PKCE" in joined
    assert "jwks_uri" in joined


@pytest.mark.asyncio
async def test_an_empty_issuer_is_refused():
    with pytest.raises(OidcError, match="required"):
        await discover_issuer("   ")


# ── SAML ─────────────────────────────────────────────────────────────


def test_saml_metadata_yields_the_fields_an_operator_would_type():
    parse = pytest.importorskip(
        "backend.auth_service.providers.saml2"
    ).parse_idp_metadata
    found = parse(SAML_METADATA)
    s = found["settings"]
    assert s["idp_entity_id"] == "http://idp.example.com/metadata"
    assert s["idp_sso_url"] == "https://idp.example.com/sso"
    assert s["idp_slo_url"] == "https://idp.example.com/slo"
    # Stored the way _settings_dict expects: body only, no PEM headers.
    assert "BEGIN CERTIFICATE" not in s["idp_x509_cert"]
    assert s["idp_x509_cert"]


def test_saml_metadata_without_a_certificate_warns():
    mod = pytest.importorskip("backend.auth_service.providers.saml2")
    stripped = SAML_METADATA.replace(
        "<X509Data><X509Certificate>MIIBdummycertdata</X509Certificate></X509Data>",
        "",
    )
    found = mod.parse_idp_metadata(stripped)
    assert any("certificate" in w.lower() for w in found["warnings"])


def test_unparseable_saml_metadata_raises_rather_than_returning_junk():
    mod = pytest.importorskip("backend.auth_service.providers.saml2")
    with pytest.raises(mod.SamlError):
        mod.parse_idp_metadata("not xml at all")
    with pytest.raises(mod.SamlError, match="empty"):
        mod.parse_idp_metadata("   ")


# ── Endpoint contract ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_endpoint_returns_settings_for_a_reachable_issuer(
    test_client, monkeypatch,
):
    _mock_discovery(monkeypatch, {
        "issuer": "https://idp.example.com",
        "jwks_uri": "https://idp.example.com/jwks",
        "code_challenge_methods_supported": ["S256"],
    })
    resp = await test_client.post(
        "/api/v1/admin/idp-providers/discover",
        json={"kind": "oidc", "issuer": "https://idp.example.com"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["success"] is True
    assert body["settings"]["issuer"] == "https://idp.example.com"


@pytest.mark.asyncio
async def test_an_unreachable_issuer_is_an_answer_not_a_500(
    test_client, monkeypatch,
):
    """Mirrors the data-source /test-connection contract: a probe failure is
    a structured result. A 500 would tell the operator nothing and look like
    our fault rather than a typo in the URL."""
    _mock_discovery(
        monkeypatch, None,
        boom=httpx.ConnectError("nodename nor servname provided"),
    )
    resp = await test_client.post(
        "/api/v1/admin/idp-providers/discover",
        json={"kind": "oidc", "issuer": "https://typo.example.com"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["success"] is False
    assert body["error"]
    assert body["settings"] == {}


@pytest.mark.asyncio
async def test_endpoint_parses_pasted_saml_metadata(test_client):
    pytest.importorskip("backend.auth_service.providers.saml2")
    resp = await test_client.post(
        "/api/v1/admin/idp-providers/discover",
        json={"kind": "saml2", "metadataXml": SAML_METADATA},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["success"] is True
    assert body["settings"]["idp_sso_url"] == "https://idp.example.com/sso"


@pytest.mark.asyncio
async def test_a_missing_input_is_a_400_not_a_probe_failure(test_client):
    """The distinction the /test-connection precedent draws: a malformed
    REQUEST is a 400, an unreachable TARGET is a structured result."""
    resp = await test_client.post(
        "/api/v1/admin/idp-providers/discover", json={"kind": "oidc"},
    )
    assert resp.status_code == 400
    assert "issuer" in resp.text


@pytest.mark.asyncio
async def test_discovery_is_refused_for_kinds_that_publish_nothing(test_client):
    """A custom_profile provider is defined by your portal, not discoverable
    from it — saying so beats an empty result that looks like a failure."""
    resp = await test_client.post(
        "/api/v1/admin/idp-providers/discover",
        json={"kind": "custom_profile", "issuer": "https://x"},
    )
    assert resp.status_code == 400
    assert "custom_profile" in resp.text


@pytest.mark.asyncio
async def test_discovery_never_persists(test_client, db_session, monkeypatch):
    from backend.app.db.repositories import idp_provider_repo

    _mock_discovery(monkeypatch, {
        "issuer": "https://idp.example.com",
        "jwks_uri": "https://idp.example.com/jwks",
    })
    before = len(await idp_provider_repo.list_providers(db_session))
    await test_client.post(
        "/api/v1/admin/idp-providers/discover",
        json={"kind": "oidc", "issuer": "https://idp.example.com"},
    )
    after = len(await idp_provider_repo.list_providers(db_session))
    assert after == before
