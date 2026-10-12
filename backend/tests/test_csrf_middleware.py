"""
CSRF middleware: double-submit enforcement and exemption coverage.

The ``test_client`` fixture pre-loads the matching cookie+header on every
request, so most tests don't notice CSRF. These tests deliberately strip
or mismatch one side of the double-submit to verify the middleware
actually protects state-changing routes.
"""
from httpx import AsyncClient

from backend.auth_service.cookies import CSRF_COOKIE_NAME
from backend.auth_service.csrf import CSRF_HEADER_NAME


_ANY_PROTECTED_POST = "/api/v1/admin/providers"
_ANY_PROTECTED_GET = "/api/v1/admin/providers"


# ── Protected: state-changing requests need both halves ──────────────

async def test_post_without_csrf_header_is_403(test_client: AsyncClient):
    test_client.headers.pop(CSRF_HEADER_NAME, None)
    resp = await test_client.post(_ANY_PROTECTED_POST, json={})
    assert resp.status_code == 403
    assert "csrf" in resp.json()["detail"]["message"].lower()


async def test_the_failure_is_distinguishable_from_a_permission_denial(
    test_client: AsyncClient,
):
    """A client has to be able to tell these two 403s apart.

    They call for opposite responses. A missing permission is final —
    show the user the access-denied modal and stop. A missing CSRF cookie
    is repairable, because every rotation re-mints ``nx_csrf``, so the
    right move is to refresh once and retry the write.

    Collapsing them is not hypothetical: the cookie can go missing while
    the session stays live (``clear_session_cookies`` evicts across the
    parent domain two sibling deployments share), and the SPA then
    reported a permission failure for a delete the user was entitled to
    perform — with no path back short of signing in again.
    """
    test_client.headers.pop(CSRF_HEADER_NAME, None)
    resp = await test_client.post(_ANY_PROTECTED_POST, json={})

    detail = resp.json()["detail"]
    assert detail["error"] == "csrf_failed"
    # Which half was missing, because "cookie absent" and "header absent"
    # have different causes and only the first is the server's doing.
    assert detail["cookie_present"] is True
    # The original prose survives for anything matching on it.
    assert detail["message"] == "CSRF token missing or invalid"


async def test_post_without_csrf_cookie_is_403(test_client: AsyncClient):
    test_client.cookies.delete(CSRF_COOKIE_NAME)
    resp = await test_client.post(_ANY_PROTECTED_POST, json={})
    assert resp.status_code == 403


async def test_post_with_mismatched_csrf_is_403(test_client: AsyncClient):
    test_client.headers[CSRF_HEADER_NAME] = "different-from-cookie"
    resp = await test_client.post(_ANY_PROTECTED_POST, json={})
    assert resp.status_code == 403


# ── Safe methods are exempt ───────────────────────────────────────────

async def test_get_without_csrf_succeeds(test_client: AsyncClient):
    test_client.headers.pop(CSRF_HEADER_NAME, None)
    test_client.cookies.delete(CSRF_COOKIE_NAME)
    resp = await test_client.get(_ANY_PROTECTED_GET)
    # 200 here proves the middleware didn't 403 the request — the
    # endpoint itself succeeds via the auth dependency override.
    assert resp.status_code == 200


# ── Exempt endpoints (login, signup, etc.) — no CSRF needed ──────────

async def test_login_endpoint_is_csrf_exempt(test_client: AsyncClient):
    """Login must work without a session — by definition the user can't
    have a CSRF cookie before they've logged in."""
    test_client.headers.pop(CSRF_HEADER_NAME, None)
    test_client.cookies.delete(CSRF_COOKIE_NAME)
    # 401 is fine; the point is that we get past CSRF (not 403).
    resp = await test_client.post(
        "/api/v1/auth/login",
        json={"email": "ghost@example.com", "password": "anything1!"},
    )
    assert resp.status_code != 403


async def test_signup_endpoint_is_csrf_exempt(test_client: AsyncClient, signup_enabled):
    # Enable self-registration so the only 403 that could occur here is a CSRF
    # rejection — otherwise the signupEnabled security gate (which fails closed)
    # returns its own 403 and masks what this test is actually checking.
    test_client.headers.pop(CSRF_HEADER_NAME, None)
    test_client.cookies.delete(CSRF_COOKIE_NAME)
    resp = await test_client.post(
        "/api/v1/auth/signup",
        json={
            "email": "noCsrf@example.com",
            "password": "Sup3rS3cur3!Pass",
            "firstName": "No",
            "lastName": "Csrf",
        },
    )
    assert resp.status_code != 403


# ── Session binding + Origin (added with the CSRF hardening) ─────────
#
# The conftest client's access cookie carries no ``sid``, so these drive
# the middleware's two new checks through real requests rather than
# relying on that fallback path.

async def test_a_cross_origin_write_is_refused(test_client: AsyncClient):
    """Second, independent defence.

    Double-submit assumes the attacker cannot write our cookie; Origin
    assumes they cannot forge the header, which browsers guarantee. The
    second matters most in the configuration that removes the first's
    backstop — ``AUTH_COOKIE_SAMESITE=none``, which a split-origin
    deployment would plausibly set.
    """
    resp = await test_client.post(
        _ANY_PROTECTED_POST, json={},
        headers={"Origin": "https://evil.example"},
    )
    assert resp.status_code == 403
    assert resp.json()["detail"]["error"] == "csrf_failed"


async def test_a_same_origin_write_is_allowed(test_client: AsyncClient):
    resp = await test_client.post(
        _ANY_PROTECTED_POST, json={},
        headers={"Origin": "http://testserver"},
    )
    assert resp.status_code != 403


async def test_a_configured_cors_origin_is_allowed(
    test_client: AsyncClient, monkeypatch,
):
    """The allowlist is read from CORS_ALLOWED_ORIGINS.

    Read per request rather than cached, because the CORS middleware and
    this check disagreeing would produce a request the browser permits
    and the server refuses.
    """
    monkeypatch.setenv("CORS_ALLOWED_ORIGINS", "https://app.corp.example")
    resp = await test_client.post(
        _ANY_PROTECTED_POST, json={},
        headers={"Origin": "https://app.corp.example"},
    )
    assert resp.status_code != 403


async def test_a_request_with_no_origin_or_referer_is_allowed(
    test_client: AsyncClient,
):
    """Non-browser clients send neither, and CSRF needs a browser.

    The smoke script and any server-to-server caller land here; refusing
    them would break those without closing anything, since the attack
    requires a browser and browsers always send Origin on a cross-site
    write.
    """
    resp = await test_client.post(_ANY_PROTECTED_POST, json={})
    assert resp.status_code != 403


async def test_a_cross_origin_referer_is_refused_when_origin_is_absent(
    test_client: AsyncClient,
):
    resp = await test_client.post(
        _ANY_PROTECTED_POST, json={},
        headers={"Referer": "https://evil.example/attack.html"},
    )
    assert resp.status_code == 403


async def test_login_csrf_is_refused_even_though_login_skips_double_submit(
    test_client: AsyncClient,
):
    """The endpoints double-submit cannot protect are the point.

    ``/auth/login`` has no ``nx_csrf`` cookie to compare — there is no
    session yet — so it has always been exempt. That left login-CSRF
    open: a third-party page POSTs the attacker's credentials, the
    victim's browser is silently signed into an account the attacker
    controls, and everything the victim then does happens in it.

    Origin needs no cookie, so it covers precisely this gap.
    """
    resp = await test_client.post(
        "/api/v1/auth/login",
        json={"email": "a@b.com", "password": "x"},
        headers={"Origin": "https://evil.example"},
    )
    assert resp.status_code == 403
    assert resp.json()["detail"]["error"] == "csrf_failed"


async def test_logout_csrf_is_refused(test_client: AsyncClient):
    resp = await test_client.post(
        "/api/v1/auth/logout", headers={"Origin": "https://evil.example"},
    )
    assert resp.status_code == 403


async def test_cross_site_refresh_is_refused(test_client: AsyncClient):
    """Rotating somebody else's family from a third-party page."""
    resp = await test_client.post(
        "/api/v1/auth/refresh", headers={"Origin": "https://evil.example"},
    )
    assert resp.status_code == 403


async def test_the_idp_callback_surface_still_accepts_a_foreign_origin(
    test_client: AsyncClient,
):
    """``/acs`` is a cross-site top-level POST from the IdP.

    A foreign Origin here is the correct case, not an attack — refusing
    it would break every SP-initiated SAML login. What authenticates it
    is the XML signature over the assertion plus the RelayState echoed
    from the signed flow cookie, not anything CSRF can see.
    """
    resp = await test_client.post(
        "/api/v1/auth/some-slug/acs",
        data={"SAMLResponse": "x", "RelayState": "y"},
        headers={"Origin": "https://idp.corp.example"},
    )
    # Whatever it answers, it must not be the CSRF refusal.
    assert resp.status_code != 403 or (
        resp.json().get("detail", {}).get("error") != "csrf_failed"
    )


async def test_backchannel_signin_is_csrf_exempt(test_client: AsyncClient):
    """``/{slug}/backchannel`` is posted by our own login page *before*
    any session exists, so there is no ``nx_csrf`` cookie to
    double-submit. What authenticates the call is the handle in the
    body, which is redeemed against the provider's own gateway.

    The regression: the route was left off the exemption list, so every
    first sign-in through the handle shape answered 403 ``csrf_failed``
    — surfaced to the user as "signing in with that session did not
    work" with nothing an operator could fix.
    """
    test_client.cookies.delete(CSRF_COOKIE_NAME)
    test_client.headers.pop(CSRF_HEADER_NAME, None)
    resp = await test_client.post(
        "/api/v1/auth/some-slug/backchannel", json={"handle": "opaque"},
    )
    assert resp.status_code != 403 or (
        resp.json().get("detail", {}).get("error") != "csrf_failed"
    )


async def test_the_backchannel_exemption_is_anchored(
    test_client: AsyncClient,
):
    """Only the exact segment is exempt — a longer path that merely
    starts the same way keeps the check."""
    test_client.cookies.delete(CSRF_COOKIE_NAME)
    test_client.headers.pop(CSRF_HEADER_NAME, None)
    resp = await test_client.post(
        "/api/v1/auth/some-slug/backchannel/extra", json={},
    )
    assert resp.status_code == 403
    assert resp.json()["detail"]["error"] == "csrf_failed"


async def test_our_own_host_is_allowed_under_either_scheme(
    test_client: AsyncClient,
):
    """TLS terminates upstream, so the app sees http and has to infer
    the client's scheme from a header some deployments do not set.
    Pinning the comparison to the inferred scheme would 403 every write
    on any such deployment — a large availability risk for a small
    security one, since an http origin on our own host is either us
    behind a proxy we mis-read or a downgrade that HSTS already answers.
    """
    for origin in ("http://testserver", "https://testserver"):
        resp = await test_client.post(
            _ANY_PROTECTED_POST, json={}, headers={"Origin": origin},
        )
        assert resp.status_code != 403, f"{origin} was refused"


async def test_a_different_host_is_still_refused_under_either_scheme(
    test_client: AsyncClient,
):
    """Tolerating the scheme must not tolerate the host."""
    for origin in ("http://evil.example", "https://evil.example"):
        resp = await test_client.post(
            _ANY_PROTECTED_POST, json={}, headers={"Origin": origin},
        )
        assert resp.status_code == 403, f"{origin} was allowed"


async def test_origin_null_is_refused(test_client: AsyncClient):
    """Sandboxed iframes and data: URLs send this. It is not our origin."""
    resp = await test_client.post(
        _ANY_PROTECTED_POST, json={}, headers={"Origin": "null"},
    )
    assert resp.status_code == 403
