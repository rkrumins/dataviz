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
