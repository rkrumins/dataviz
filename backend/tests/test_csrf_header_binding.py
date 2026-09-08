"""CSRF for a real (sid-bearing) session verifies the HEADER's binding.

The double-submit *equality* check (header == cookie) depended on the
client reading its own ``nx_csrf`` cookie back to build the header — a
read that duplicate/again-scoped cookies, browser send-order, and a
``Secure`` cookie dropped over plain HTTP all make unreliable, stranding
a perfectly valid session on ``csrf_failed`` until a full reload.

For a session that carries a ``sid`` the check is now that the header
carries a token cryptographically bound to that ``sid``. A cross-site
attacker cannot set the ``X-CSRF-Token`` header at all, and cannot forge
a bound token, so this is a complete CSRF defence that does not depend on
the cookie value the server happens to read. Sessions with no ``sid``
keep plain double-submit (covered in ``test_csrf_middleware.py``).
"""
from httpx import AsyncClient

from backend.auth_service.cookies import ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME
from backend.auth_service.csrf import CSRF_HEADER_NAME, mint_csrf_token
from backend.auth_service.core.tokens import create_access_token


_PROTECTED_POST = "/api/v1/admin/providers"


def _access_with_sid(sid: str) -> str:
    return create_access_token("u1", "a@b.c", "user", extra={"sid": sid})


async def test_bound_header_passes_even_when_the_cookie_mismatches(
    test_client: AsyncClient,
):
    """The fix: a header bound to this session passes even if the cookie
    the server reads is a different value (the duplicate-cookie shape)."""
    resp = await test_client.post(
        _PROTECTED_POST, json={},
        cookies={
            ACCESS_COOKIE_NAME: _access_with_sid("sess_x"),
            CSRF_COOKIE_NAME: "a-totally-different-cookie-value",
        },
        headers={CSRF_HEADER_NAME: mint_csrf_token("sess_x")},
    )
    assert resp.status_code != 403, resp.text


async def test_bound_header_passes_even_when_the_cookie_is_absent(
    test_client: AsyncClient,
):
    """And even with no ``nx_csrf`` cookie at all — the Secure-over-HTTP
    shape, where the cookie is silently dropped but the header (held in
    memory by the client) still carries a bound token."""
    test_client.cookies.delete(CSRF_COOKIE_NAME)
    resp = await test_client.post(
        _PROTECTED_POST, json={},
        cookies={ACCESS_COOKIE_NAME: _access_with_sid("sess_x")},
        headers={CSRF_HEADER_NAME: mint_csrf_token("sess_x")},
    )
    assert resp.status_code != 403, resp.text


async def test_an_unbound_header_is_refused_for_a_sid_session(
    test_client: AsyncClient,
):
    """A well-formed cookie==header double-submit is NOT enough once the
    session has a sid: the header must carry a token bound to it."""
    resp = await test_client.post(
        _PROTECTED_POST, json={},
        cookies={
            ACCESS_COOKIE_NAME: _access_with_sid("sess_x"),
            CSRF_COOKIE_NAME: "unbound-nonce-only",
        },
        headers={CSRF_HEADER_NAME: "unbound-nonce-only"},
    )
    assert resp.status_code == 403
    assert resp.json()["detail"]["error"] == "csrf_failed"


async def test_a_header_bound_to_another_session_is_refused(
    test_client: AsyncClient,
):
    """The binding is per-session: a token minted for a different sid —
    a planted cookie from a sibling subdomain — does not pass."""
    resp = await test_client.post(
        _PROTECTED_POST, json={},
        cookies={ACCESS_COOKIE_NAME: _access_with_sid("sess_victim")},
        headers={CSRF_HEADER_NAME: mint_csrf_token("sess_attacker")},
    )
    assert resp.status_code == 403
    assert resp.json()["detail"]["error"] == "csrf_failed"


async def test_a_cross_origin_write_is_still_refused_for_a_sid_session(
    test_client: AsyncClient,
):
    """The Origin layer is independent of and prior to the token check —
    a bound header does not buy a foreign origin in."""
    resp = await test_client.post(
        _PROTECTED_POST, json={},
        cookies={ACCESS_COOKIE_NAME: _access_with_sid("sess_x")},
        headers={
            CSRF_HEADER_NAME: mint_csrf_token("sess_x"),
            "Origin": "https://evil.example",
        },
    )
    assert resp.status_code == 403
    assert resp.json()["detail"]["error"] == "csrf_failed"
