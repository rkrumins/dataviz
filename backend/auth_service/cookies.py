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

The signature-bearing cookies (``nx_access``, ``nx_refresh``, and the SSO
handshake cookies) are suffixed with ``AUTH_ENVIRONMENT_ID`` when one is
configured — ``nx_access_uat`` — because cookie jars are keyed by domain
rather than by cluster: two deployments sharing these names overwrite each
other's session in a single browser even when they run on different
clusters entirely. With the id unset the names are unchanged.

``nx_csrf`` is deliberately excluded from that scoping; see the comment on
its definition below.
"""
from __future__ import annotations

import jwt as pyjwt
from fastapi import HTTPException, Request, Response, status

from .core.config import (
    AUTH_ENVIRONMENT_ID,
    COOKIE_DOMAIN,
    COOKIE_SAMESITE,
    COOKIE_SECURE,
)
from .interface import SessionTokens

# Base names, before environment scoping. Kept as the eviction list
# below: a browser that already holds a poisoned unsuffixed cookie has
# to have it cleared too, or the very loop this scoping fixes survives
# the upgrade that fixes it.
_BASE_ACCESS_COOKIE_NAME = "nx_access"
_BASE_REFRESH_COOKIE_NAME = "nx_refresh"
_BASE_CSRF_COOKIE_NAME = "nx_csrf"


def _scoped(name: str) -> str:
    """Suffix *name* with the environment id when one is configured.

    Cookie jars are keyed by domain, not by cluster or by port, so two
    deployments using identical cookie names overwrite each other's
    session in a single browser — that is why signing into UAT logs you
    out of dev even across separate clusters. Scoping the NAME (rather
    than relying on the domain attribute) makes the two jars disjoint
    regardless of how the domain is configured.
    """
    return f"{name}_{AUTH_ENVIRONMENT_ID}" if AUTH_ENVIRONMENT_ID else name


ACCESS_COOKIE_NAME = _scoped(_BASE_ACCESS_COOKIE_NAME)
REFRESH_COOKIE_NAME = _scoped(_BASE_REFRESH_COOKIE_NAME)
# Deliberately NOT scoped. This one is read from JavaScript by name
# (frontend/src/services/fetchWithTimeout.ts), so a per-environment name
# would have to be discovered at runtime before the first write request —
# and getting that wrong fails every POST with a 403.
#
# Leaving it shared is safe: CSRF here is a double-submit check, which only
# ever compares this cookie against the header on the SAME request. The
# value carries no identity and no signature, so a token minted by another
# environment still proves exactly what the check is for — that same-origin
# script could read the cookie. The signature-bearing cookies above are the
# ones that must not be shared.
CSRF_COOKIE_NAME = _BASE_CSRF_COOKIE_NAME
# Short-lived signed cookie holding the in-flight OIDC handshake
# (state / nonce / PKCE verifier). Scoped to the auth subtree so it is
# only ever sent to the callback. SameSite=Lax is required: the IdP
# redirects back via a top-level GET navigation.
OIDC_COOKIE_NAME = _scoped("nx_oidc")
OIDC_COOKIE_PATH = "/api/v1/auth/"
_OIDC_COOKIE_MAX_AGE = 600

# Short-lived signed cookie holding the in-flight SAML handshake
# (RelayState + next_path). Same scoping rationale as ``nx_oidc``.
SAML_COOKIE_NAME = _scoped("nx_saml")
SAML_COOKIE_PATH = "/api/v1/auth/"
_SAML_COOKIE_MAX_AGE = 600

# Dev/demo Custom-IdP signed identity envelope cookie. The browser
# obtains it from /api/v1/auth/custom/mock (also dev-only); the
# /custom/login route reads it to find-or-provision the user. Refused
# in production via the AUTH_CUSTOM_PROVIDER_ENABLED env gate.
MOCK_IDENTITY_COOKIE_NAME = _scoped("nx_mock_identity")
MOCK_IDENTITY_COOKIE_PATH = "/api/v1/auth/"
_MOCK_IDENTITY_COOKIE_MAX_AGE = 600

# Self-service link cookie. Set by ``POST /me/identities/link/{slug}/start``,
# read by the SSO callback to bind the verified identity to the
# already-authenticated user instead of provisioning a new account.
LINK_INTENT_COOKIE_NAME = _scoped("nx_link_intent")
LINK_INTENT_COOKIE_PATH = "/api/v1/auth/"
_LINK_INTENT_COOKIE_MAX_AGE = 600

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


def _is_ip_literal(host: str) -> bool:
    return bool(host) and (host.replace(".", "").isdigit() or ":" in host)


def _eviction_domains(request: Request | None) -> list[str | None]:
    """Every domain scope a session cookie might have been stored under.

    A browser deletes a cookie only when the deletion repeats the exact
    domain it was stored with. One deletion using *this* process's
    configured domain therefore cannot evict a cookie written under a
    different ``AUTH_COOKIE_DOMAIN`` — or written by a sibling
    environment that shares a parent domain. That gap is what turns a
    single foreign cookie into a permanent 401 loop: the server rejects
    it, tries to clear it, misses, and the browser sends it again.

    So we emit one deletion per plausible scope: the configured domain,
    host-only, and the immediate parent of the request host (the scope
    two sibling environments such as ``dataviz-dev.local`` and
    ``dataviz-uat.local`` would share). Deletions for a scope the
    browser has no cookie in are simply ignored.
    """
    domains: list[str | None] = [COOKIE_DOMAIN, None]

    host = (request.url.hostname if request is not None else None) or ""
    if host and not _is_ip_literal(host):
        parent = host.partition(".")[2]
        if parent:
            domains.append(f".{parent}")

    seen: set[str | None] = set()
    unique: list[str | None] = []
    for domain in domains:
        if domain not in seen:
            seen.add(domain)
            unique.append(domain)
    return unique


def _eviction_targets() -> list[tuple[str, str]]:
    """(name, path) pairs to clear — current names plus the unscoped ones.

    The unscoped names matter on the upgrade itself: a browser already
    holding a poisoned ``nx_access`` from before scoping existed would
    otherwise keep it forever, since the new code only ever writes and
    clears ``nx_access_<env>``.
    """
    targets = [
        (ACCESS_COOKIE_NAME, "/"),
        (REFRESH_COOKIE_NAME, REFRESH_COOKIE_PATH),
        (CSRF_COOKIE_NAME, "/"),
        (_BASE_ACCESS_COOKIE_NAME, "/"),
        (_BASE_REFRESH_COOKIE_NAME, REFRESH_COOKIE_PATH),
        (_BASE_CSRF_COOKIE_NAME, "/"),
    ]
    seen: set[tuple[str, str]] = set()
    unique: list[tuple[str, str]] = []
    for target in targets:
        if target not in seen:
            seen.add(target)
            unique.append(target)
    return unique


def clear_session_cookies(
    response: Response, request: Request | None = None
) -> None:
    """Remove the session cookies across every scope they might hold.

    Called by /logout, and by any path that has decided the presented
    token can never become valid here — see the foreign-session handling
    in ``backend.app.auth.dependencies``.

    Pass *request* whenever one is available: without it the parent-domain
    scope cannot be computed, and a cookie written under a shared parent
    survives the clear.
    """
    common = _common_kwargs()
    common.pop("domain", None)
    for domain in _eviction_domains(request):
        for name, path in _eviction_targets():
            response.delete_cookie(name, path=path, domain=domain, **common)


SESSION_FOREIGN_ERROR = "session_foreign"


class ForeignSession(HTTPException):
    """The presented ACCESS token does not belong to this deployment.

    Raised when a token fails verification for a structural reason —
    wrong signing key, wrong issuer, wrong audience, undecodable — as
    opposed to merely having expired. An expired token is normal and the
    frontend silently refreshes it; a foreign one never becomes valid,
    so leaving it in the browser produces an endless
    401 -> /login -> 401 cycle.

    Deliberately an ``HTTPException`` carrying its own 401: that way any
    app mounting these dependencies answers correctly through FastAPI's
    built-in handler, with no extra wiring. The app-level handler in
    ``backend.app.main`` recognises this exact type and *additionally*
    evicts the cookies — so missing that registration degrades to a
    plain 401 rather than a 500.
    """

    def __init__(self) -> None:
        super().__init__(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "error": SESSION_FOREIGN_ERROR,
                "message": (
                    "Session belongs to a different environment or signing "
                    "key; please sign in again."
                ),
            },
        )


def raise_if_foreign_session(request: Request) -> None:
    """Raise ``ForeignSession`` if the access cookie isn't ours at all.

    Session validation collapses every decode failure to "no user", so
    on its own it cannot tell "expired, refresh it" from "signed by
    another environment, it will never work". Re-decoding here recovers
    that distinction: expiry falls through to the ordinary 401 the
    frontend resolves silently, while a foreign token raises so the
    handler can evict the cookie instead of letting the browser
    re-present it on every subsequent request.

    Imported by both the FastAPI dependencies and ``/auth/me`` so the
    two agree on what counts as unrecoverable.
    """
    # Imported here rather than at module scope: ``core.tokens`` reads
    # the resolved signing config at import, and keeping that out of the
    # cookie module's import graph avoids ordering surprises during the
    # fail-fast secret checks in ``core.config``.
    from .core.tokens import decode_token, is_foreign_token_error

    token = read_access_cookie(request)
    if not token:
        return
    try:
        decode_token(token)
    except pyjwt.ExpiredSignatureError:
        return
    except pyjwt.InvalidTokenError as exc:
        if is_foreign_token_error(exc):
            raise ForeignSession() from exc


def read_access_cookie(request: Request) -> str | None:
    return request.cookies.get(ACCESS_COOKIE_NAME)


def read_refresh_cookie(request: Request) -> str | None:
    return request.cookies.get(REFRESH_COOKIE_NAME)


def read_csrf_cookie(request: Request) -> str | None:
    return request.cookies.get(CSRF_COOKIE_NAME)


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
        **_common_kwargs(),
    )


def clear_saml_cookie(response: Response) -> None:
    response.delete_cookie(
        SAML_COOKIE_NAME, path=SAML_COOKIE_PATH, **_common_kwargs()
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
        **_common_kwargs(),
    )


def clear_link_intent_cookie(response: Response) -> None:
    response.delete_cookie(
        LINK_INTENT_COOKIE_NAME,
        path=LINK_INTENT_COOKIE_PATH,
        **_common_kwargs(),
    )


def read_link_intent_cookie(request: Request) -> str | None:
    return request.cookies.get(LINK_INTENT_COOKIE_NAME)
