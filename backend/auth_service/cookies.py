"""
Cookie names and helpers for session transport.

Three cookies make up a session:

* ``nx_access``  — the access JWT. ``HttpOnly``, ``Secure``, ``SameSite=Lax``,
  path ``/``. Sent on every request to the API; read by ``get_current_user``.
* ``nx_refresh`` — the refresh JWT. ``HttpOnly``, ``Secure``, ``SameSite=Lax``,
  path ``/api/v1/auth/refresh`` (so it's only sent to the refresh endpoint).
* ``nx_csrf``    — the CSRF token. *Readable* by JavaScript so the frontend
  can echo it back as ``X-CSRF-Token``. ``Secure``, ``SameSite=Lax``.

All cookie attributes are derived from environment-driven config in
``core.config`` so deployments can tune ``Secure`` (off in local HTTP dev),
``Domain`` (parent-domain sharing), and ``SameSite`` (e.g. ``strict``).
"""
from __future__ import annotations

from fastapi import Request, Response

from .core.config import COOKIE_DOMAIN, COOKIE_SAMESITE, COOKIE_SECURE
from .interface import SessionTokens

ACCESS_COOKIE_NAME = "nx_access"
REFRESH_COOKIE_NAME = "nx_refresh"
CSRF_COOKIE_NAME = "nx_csrf"
# Short-lived signed cookie holding the in-flight OIDC handshake
# (state / nonce / PKCE verifier). Scoped to the auth subtree so it is
# only ever sent to the callback. SameSite=Lax is required: the IdP
# redirects back via a top-level GET navigation.
OIDC_COOKIE_NAME = "nx_oidc"
OIDC_COOKIE_PATH = "/api/v1/auth/"
_OIDC_COOKIE_MAX_AGE = 600

# Short-lived signed cookie holding the in-flight SAML handshake
# (RelayState + next_path). Same PATH scoping as ``nx_oidc``, but NOT the
# same SameSite: the OIDC callback is a cross-site top-level GET, which Lax
# permits, whereas the SAML ACS is a cross-site top-level POST, which Lax
# explicitly withholds cookies from. Under Lax the ACS handler therefore
# never sees this cookie and fails the handshake with ``missing_flow_cookie``
# — the whole SP-initiated flow dead, on every IdP. See ``_cross_site_kwargs``.
SAML_COOKIE_NAME = "nx_saml"
SAML_COOKIE_PATH = "/api/v1/auth/"
_SAML_COOKIE_MAX_AGE = 600

# Dev/demo Custom-IdP signed identity envelope cookie. The browser
# obtains it from /api/v1/auth/custom/mock (also dev-only); the
# /custom/login route reads it to find-or-provision the user. Refused
# in production via the AUTH_CUSTOM_PROVIDER_ENABLED env gate.
MOCK_IDENTITY_COOKIE_NAME = "nx_mock_identity"
MOCK_IDENTITY_COOKIE_PATH = "/api/v1/auth/"
_MOCK_IDENTITY_COOKIE_MAX_AGE = 600

# Self-service link cookie. Set by ``POST /me/identities/link/{slug}/start``,
# read by the SSO callback to bind the verified identity to the
# already-authenticated user instead of provisioning a new account.
# Cross-site-scoped for the same reason as ``nx_saml``: linking a SAML IdP
# completes on the ACS POST, and a Lax cookie would be dropped there, silently
# turning a link into a JIT-provision of a duplicate account.
LINK_INTENT_COOKIE_NAME = "nx_link_intent"
LINK_INTENT_COOKIE_PATH = "/api/v1/auth/"
_LINK_INTENT_COOKIE_MAX_AGE = 600

# Dry-run cookie. Set by ``POST /admin/idp-providers/{id}/dry-run/start``,
# read by the SSO callback, which then reports what WOULD have happened
# and mints nothing. Cross-site-scoped for the same reason as ``nx_saml``:
# a SAML dry-run completes on the ACS POST, and a Lax cookie dropped there
# would silently turn the rehearsal into a real login.
DRYRUN_COOKIE_NAME = "nx_dryrun"
DRYRUN_COOKIE_PATH = "/api/v1/auth/"
_DRYRUN_COOKIE_MAX_AGE = 600

# Refresh cookie is scoped to the /auth subtree so it's sent to /refresh
# AND /logout (logout needs to read it to revoke the rotation family)
# but is excluded from every data endpoint where it's never useful.
REFRESH_COOKIE_PATH = "/api/v1/auth/"


def _common_kwargs() -> dict:
    return {
        "secure": COOKIE_SECURE,
        "samesite": COOKIE_SAMESITE,
        "domain": COOKIE_DOMAIN,
    }


def _cross_site_kwargs() -> dict:
    """Cookie kwargs for a handshake that completes on a cross-site POST.

    ``SameSite=None`` is the only value browsers send on a cross-site form
    POST, and they require ``Secure`` alongside it — a ``SameSite=None``
    cookie without ``Secure`` is rejected outright. So this deliberately
    ignores ``COOKIE_SECURE`` rather than honouring it.

    That is not a downgrade in practice: an IdP will not POST a signed
    assertion to a plaintext ACS URL, so SAML is HTTPS-only anyway. Deriving
    this from ``COOKIE_SECURE`` would reintroduce the exact bug in the
    off position — a cookie silently withheld at the ACS, in the one
    configuration where it is hardest to notice.
    """
    return {
        "secure": True,
        "samesite": "none",
        "domain": COOKIE_DOMAIN,
    }


def set_session_cookies(response: Response, tokens: SessionTokens) -> None:
    """Attach the three session cookies to *response*. Called by /login and /refresh."""
    common = _common_kwargs()
    response.set_cookie(
        key=ACCESS_COOKIE_NAME,
        value=tokens.access_token,
        max_age=tokens.access_max_age_seconds,
        httponly=True,
        path="/",
        **common,
    )
    response.set_cookie(
        key=REFRESH_COOKIE_NAME,
        value=tokens.refresh_token,
        max_age=tokens.refresh_max_age_seconds,
        httponly=True,
        path=REFRESH_COOKIE_PATH,
        **common,
    )
    # CSRF lifetime follows the refresh cookie, NOT the access cookie.
    # If the two matched, a user whose access cookie just expired would
    # lose the CSRF cookie at the same moment — the next write would
    # 403 on CSRF before the 401-triggered silent refresh could run,
    # forcing a re-login every ``JWT_EXPIRY_MINUTES``. While refresh is
    # still valid we want every state-changing request to be able to
    # mint the double-submit header.
    response.set_cookie(
        key=CSRF_COOKIE_NAME,
        value=tokens.csrf_token,
        max_age=tokens.refresh_max_age_seconds,
        httponly=False,
        path="/",
        **common,
    )


def clear_session_cookies(response: Response) -> None:
    """Remove the three session cookies. Called by /logout (and on auth failure)."""
    common = _common_kwargs()
    # Browsers only delete a cookie when the deletion call repeats the
    # original path/domain/secure attributes.
    response.delete_cookie(ACCESS_COOKIE_NAME, path="/", **common)
    response.delete_cookie(REFRESH_COOKIE_NAME, path=REFRESH_COOKIE_PATH, **common)
    response.delete_cookie(CSRF_COOKIE_NAME, path="/", **common)


def read_access_cookie(request: Request) -> str | None:
    return request.cookies.get(ACCESS_COOKIE_NAME)


def read_refresh_cookie(request: Request) -> str | None:
    return request.cookies.get(REFRESH_COOKIE_NAME)


def set_oidc_cookie(response: Response, state_token: str) -> None:
    response.set_cookie(
        key=OIDC_COOKIE_NAME,
        value=state_token,
        max_age=_OIDC_COOKIE_MAX_AGE,
        httponly=True,
        path=OIDC_COOKIE_PATH,
        **_common_kwargs(),
    )


def clear_oidc_cookie(response: Response) -> None:
    response.delete_cookie(
        OIDC_COOKIE_NAME, path=OIDC_COOKIE_PATH, **_common_kwargs()
    )


def read_oidc_cookie(request: Request) -> str | None:
    return request.cookies.get(OIDC_COOKIE_NAME)


# ── SAML state cookie ────────────────────────────────────────────────


def set_saml_cookie(response: Response, state_token: str) -> None:
    response.set_cookie(
        key=SAML_COOKIE_NAME,
        value=state_token,
        max_age=_SAML_COOKIE_MAX_AGE,
        httponly=True,
        path=SAML_COOKIE_PATH,
        **_cross_site_kwargs(),
    )


def clear_saml_cookie(response: Response) -> None:
    response.delete_cookie(
        SAML_COOKIE_NAME, path=SAML_COOKIE_PATH, **_cross_site_kwargs()
    )


def read_saml_cookie(request: Request) -> str | None:
    return request.cookies.get(SAML_COOKIE_NAME)


# ── Custom-IdP mock-identity cookie (dev/demo only) ──────────────────


def set_mock_identity_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key=MOCK_IDENTITY_COOKIE_NAME,
        value=token,
        max_age=_MOCK_IDENTITY_COOKIE_MAX_AGE,
        httponly=True,
        path=MOCK_IDENTITY_COOKIE_PATH,
        **_common_kwargs(),
    )


def clear_mock_identity_cookie(response: Response) -> None:
    response.delete_cookie(
        MOCK_IDENTITY_COOKIE_NAME,
        path=MOCK_IDENTITY_COOKIE_PATH,
        **_common_kwargs(),
    )


def read_mock_identity_cookie(request: Request) -> str | None:
    return request.cookies.get(MOCK_IDENTITY_COOKIE_NAME)


# ── Link intent cookie ──────────────────────────────────────────────


def set_link_intent_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key=LINK_INTENT_COOKIE_NAME,
        value=token,
        max_age=_LINK_INTENT_COOKIE_MAX_AGE,
        httponly=True,
        path=LINK_INTENT_COOKIE_PATH,
        **_cross_site_kwargs(),
    )


def clear_link_intent_cookie(response: Response) -> None:
    response.delete_cookie(
        LINK_INTENT_COOKIE_NAME,
        path=LINK_INTENT_COOKIE_PATH,
        **_cross_site_kwargs(),
    )


def read_link_intent_cookie(request: Request) -> str | None:
    return request.cookies.get(LINK_INTENT_COOKIE_NAME)


# ── Dry-run cookie ───────────────────────────────────────────────────


def set_dryrun_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key=DRYRUN_COOKIE_NAME,
        value=token,
        max_age=_DRYRUN_COOKIE_MAX_AGE,
        httponly=True,
        path=DRYRUN_COOKIE_PATH,
        **_cross_site_kwargs(),
    )


def clear_dryrun_cookie(response: Response) -> None:
    response.delete_cookie(
        DRYRUN_COOKIE_NAME,
        path=DRYRUN_COOKIE_PATH,
        **_cross_site_kwargs(),
    )


def read_dryrun_cookie(request: Request) -> str | None:
    return request.cookies.get(DRYRUN_COOKIE_NAME)
