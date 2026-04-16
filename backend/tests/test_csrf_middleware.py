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
    assert "csrf" in resp.json()["detail"].lower()


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


async def test_signup_endpoint_is_csrf_exempt(test_client: AsyncClient):
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
