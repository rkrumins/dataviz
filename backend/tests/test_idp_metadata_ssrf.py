"""IdP metadata fetches cannot be pointed at our own network.

Three provider paths GET a URL an administrator typed — OIDC discovery,
the JWKS endpoint that discovery names, and SAML IdP metadata — and each
used a bare httpx call. That made ``POST /admin/idp-providers/discover``
an arbitrary-URL request issued from inside the cluster, with the
response handed back to the caller.

Admin-gated, so not an unauthenticated hole. Still worth closing: the
value of the network position this service holds is that it can reach
things an admin's browser cannot, and "an admin would never" is not an
access control.

The JWKS case is the one with teeth beyond disclosure. It comes out of
the discovery document rather than the provider row, so it is one
indirection further from anything validated — and it names the keys that
decide whether an ID token is genuine.
"""
from __future__ import annotations

import pytest

from backend.auth_service.providers.outbound import (
    BlockedOutboundRequest,
    assert_fetchable,
)


BLOCKED = [
    # Cloud metadata — the canonical SSRF target.
    "http://169.254.169.254/latest/meta-data/",
    "http://[fd00::1]/",
    # Our own services.
    "http://127.0.0.1:6379/",
    "https://localhost/.well-known/openid-configuration",
    "http://10.0.0.5/",
    "http://192.168.1.1/",
    "http://172.16.0.1/",
    "http://[::1]:8000/",
    # IPv4-mapped IPv6 of the metadata address — the form a denylist of
    # literal v4 CIDRs misses.
    "http://[::ffff:169.254.169.254]/",
    # Not fetchable at all.
    "file:///etc/passwd",
    "gopher://example.com/",
    "ftp://example.com/meta.xml",
]


@pytest.mark.parametrize("url", BLOCKED)
def test_targets_inside_our_own_network_are_refused(url):
    with pytest.raises(BlockedOutboundRequest):
        assert_fetchable(url)


def test_a_public_https_issuer_is_allowed():
    # Uses a name guaranteed by RFC 2606 to be resolvable-or-not without
    # reaching anything real; if DNS cannot answer, the refusal is the
    # resolver's and the assertion below still holds.
    try:
        assert_fetchable("https://example.com/.well-known/openid-configuration")
    except BlockedOutboundRequest as exc:
        assert "cannot resolve" in str(exc), exc


def test_plain_http_is_refused_in_production(monkeypatch):
    """The discovery document decides which keys verify your users."""
    monkeypatch.setenv("ENV", "production")
    with pytest.raises(BlockedOutboundRequest) as err:
        assert_fetchable("http://example.com/.well-known/openid-configuration")
    assert "plain http" in str(err.value)


def test_plain_http_is_tolerated_outside_production(monkeypatch):
    """Local IdP stubs are served over http; dev must keep working."""
    monkeypatch.setenv("ENV", "dev")
    try:
        assert_fetchable("http://example.com/.well-known/openid-configuration")
    except BlockedOutboundRequest as exc:
        assert "cannot resolve" in str(exc), exc


def test_the_saml_metadata_fetch_no_longer_follows_redirects():
    """A 302 to an internal address is the standard way past a
    pre-flight check, and no IdP needs one to serve its own metadata."""
    import inspect

    from backend.auth_service.providers import outbound

    src = inspect.getsource(outbound.fetch_metadata)
    assert "follow_redirects=False" in src
