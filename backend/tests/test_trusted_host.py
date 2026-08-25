"""A request may not claim a Host this deployment does not answer to.

Worth being precise about what this is for, because the usual reason does
not apply here: the app sends no email and builds no reset or invite links,
so there is no Host-poisoning-to-account-takeover chain.

What does depend on the claimed host is SAML. python3-saml derives
``current_url`` from it to validate an assertion's ``Destination`` and
``Recipient``, so an attacker replaying an assertion minted for a different
SP can set the header to match. ``_request_https_host`` already honours
``ALLOWED_HOSTS`` for that specific consumer; this middleware refuses the
forged host at the perimeter instead.

Note what is deliberately NOT Starlette's ``TrustedHostMiddleware``:
kubelet connects to the pod IP, so a probe's Host is a dynamic address no
operator can allowlist, and Starlette's version has no path exemption --
adding it would have made every pod fail its own readiness probe.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.app.main import _TrustedHostMiddleware


@pytest.fixture
def client():
    app = FastAPI()
    app.add_middleware(
        _TrustedHostMiddleware,
        allowed_hosts=("app.corp.example", "Alt.Corp.Example:8443"),
    )

    @app.get("/api/v1/thing")
    async def thing():
        return {"ok": True}

    @app.get("/health")
    async def health():
        return {"ok": True}

    @app.get("/health/ready")
    async def health_ready():
        return {"ok": True}

    @app.get("/api/v1/health/ready")
    async def api_health_ready():
        return {"ok": True}

    return TestClient(app)


@pytest.mark.parametrize(
    "host",
    [
        "app.corp.example",
        "app.corp.example:443",       # port is not part of the identity
        "app.corp.example:8000",
        "APP.CORP.EXAMPLE",           # Host is case-insensitive
        "alt.corp.example",           # allowlist entry carried a port
        "alt.corp.example:8443",
    ],
)
def test_a_host_we_answer_to_is_allowed(client, host):
    assert client.get("/api/v1/thing", headers={"Host": host}).status_code == 200


@pytest.mark.parametrize(
    "host",
    [
        "evil.example",
        "app.corp.example.evil.example",   # suffix, not a match
        "evilapp.corp.example",            # prefix, not a match
        "10.1.2.3",
        "localhost",
    ],
)
def test_a_host_we_do_not_answer_to_is_refused(client, host):
    resp = client.get("/api/v1/thing", headers={"Host": host})
    assert resp.status_code == 400
    assert "Host header" in resp.json()["detail"]


@pytest.mark.parametrize(
    "path", ["/health", "/health/ready", "/api/v1/health/ready"],
)
def test_probe_paths_answer_on_any_host(client, path):
    """kubelet dials the pod IP. Without this exemption the pod would fail
    its own readiness probe the moment ALLOWED_HOSTS was set."""
    resp = client.get(path, headers={"Host": "10.244.3.17:8000"})
    assert resp.status_code == 200


def test_every_health_route_the_app_mounts_is_exempt():
    """The exemption is a prefix list, and the probe paths live in
    deployment manifests this suite cannot see. Assert against the routes
    the app actually mounts, so adding a health endpoint outside the
    prefixes fails here rather than in a rollout."""
    from backend.app.main import app as real_app

    prefixes = _TrustedHostMiddleware._EXEMPT_PREFIXES
    health_paths = {
        route.path
        for route in real_app.routes
        if "health" in (getattr(route, "tags", None) or [])
    }
    assert health_paths, "no health-tagged routes found — did the tag change?"
    missed = [
        path for path in health_paths
        if not any(path == p or path.startswith(p + "/") for p in prefixes)
    ]
    assert missed == [], (
        f"{missed} are health routes outside {prefixes}, so a probe hitting "
        "them on the pod IP would 400 once ALLOWED_HOSTS is set."
    )


def test_the_allowlist_is_normalised_at_construction():
    """Ports and case are stripped from the configured entries too, so an
    operator writing 'Example.com:8443' gets what they meant."""
    mw = _TrustedHostMiddleware(
        app=None, allowed_hosts=("Example.COM:8443", "  ", "b.example  "),
    )
    assert mw._allowed == frozenset({"example.com", "b.example"})


def test_an_unconfigured_deployment_does_not_mount_it():
    """``ALLOWED_HOSTS`` unset means off -- the same posture the SAML check
    takes, and what keeps every local and CI stack working unchanged."""
    from backend.app.main import ALLOWED_HOSTS, app

    mounted = [m.cls.__name__ for m in app.user_middleware]
    if ALLOWED_HOSTS:
        assert "_TrustedHostMiddleware" in mounted
    else:
        assert "_TrustedHostMiddleware" not in mounted
