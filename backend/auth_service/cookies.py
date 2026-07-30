"""
Cookie names and helpers for session transport.

Four cookies make up a session:

* ``nx_access``  — the access JWT. ``HttpOnly``, ``Secure``, ``SameSite=Lax``,
  path ``/``. Sent on every request to the API; read by ``get_current_user``.
* ``nx_refresh`` — the refresh JWT. ``HttpOnly``, ``Secure``, ``SameSite=Lax``,
  path ``/api/v1/auth/refresh`` (so it's only sent to the refresh endpoint).
* ``nx_csrf``    — the CSRF token. *Readable* by JavaScript so the frontend
  can echo it back as ``X-CSRF-Token``. ``Secure``, ``SameSite=Lax``.
* ``nx_access_exp`` — when ``nx_access`` expires, as a unix epoch. Also
  readable by JavaScript: the client cannot inspect an ``HttpOnly`` cookie,
  so without this it has no way to renew before expiry rather than after a
  401. Carries no identity and no signature.

All cookie attributes are derived from environment-driven config in
``core.config`` so deployments can tune ``Secure`` (off in local HTTP dev),
``Domain`` (parent-domain sharing), and ``SameSite`` (e.g. ``strict``).

The signature-bearing cookies (``nx_access``, ``nx_refresh``, and the SSO
handshake cookies) are suffixed with ``AUTH_ENVIRONMENT_ID`` when one is
configured — ``nx_access_uat`` — because cookie jars are keyed by domain
rather than by cluster: two deployments sharing these names overwrite each
other's session in a single browser even when they run on different
clusters entirely. With the id unset the names are unchanged.

``nx_access_exp`` is scoped too, despite carrying no signature: it decides
when the client renews, so a sibling deployment writing the same name into
the same jar leaves each tab scheduling against the other's token. The
client resolves the suffix from ``environment_id`` on ``GET /auth/me``.

``nx_csrf`` is scoped for a different reason again. Sharing its VALUE is
harmless — the double-submit check only compares it against the header on
the same request — but sharing its NAME is not, because eviction is
name-based: signing out of one deployment deletes the other's CSRF cookie
across the parent domain they share, leaving a live session unable to
perform any write. See the comments on each definition below.
"""
from __future__ import annotations

import logging
import time

import jwt as pyjwt
from fastapi import HTTPException, Request, Response, status

from .core.config import (
    AUTH_ENVIRONMENT_ID,
    COOKIE_DOMAIN,
    COOKIE_SAMESITE,
    COOKIE_SECURE,
)
from .interface import SessionTokens

logger = logging.getLogger(__name__)

# Base names, before environment scoping. Kept as the eviction list
# below: a browser that already holds a poisoned unsuffixed cookie has
# to have it cleared too, or the very loop this scoping fixes survives
# the upgrade that fixes it.
_BASE_ACCESS_COOKIE_NAME = "nx_access"
_BASE_REFRESH_COOKIE_NAME = "nx_refresh"
_BASE_CSRF_COOKIE_NAME = "nx_csrf"
_BASE_ACCESS_EXPIRY_COOKIE_NAME = "nx_access_exp"


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
# Scoped, though nothing in the VALUE requires it. Sharing the value is
# genuinely harmless — CSRF here is a double-submit check that only ever
# compares this cookie against the header on the SAME request, so a token
# minted by another environment still proves exactly what the check is
# for: that same-origin script could read the cookie.
#
# Sharing the NAME is not harmless, and the difference is deletion.
# ``clear_session_cookies`` evicts across every domain scope a cookie
# might hold, deliberately including the parent that two sibling
# deployments share (see ``_eviction_domains``). Under one unscoped name
# that makes signing out of one instance delete the other's CSRF cookie —
# leaving a session that is still perfectly valid unable to perform any
# write at all, because every state-changing request now fails the
# double-submit before it reaches a handler. The user sees "CSRF token
# missing or invalid" on a delete they are entitled to perform, and no
# amount of retrying fixes it.
#
# The original objection — JavaScript reads this by name, so a scoped
# name has to be discovered at runtime, and getting it wrong 403s every
# POST — is answered the same way ``nx_access_exp`` answers it: the SPA
# learns the suffix from ``environment_id`` on ``GET /auth/me``, and
# falls back to the unscoped name until it does. Writes only happen after
# bootstrap, so the window in which the fallback is load-bearing does not
# overlap with any write.
CSRF_COOKIE_NAME = _scoped(_BASE_CSRF_COOKIE_NAME)
# When ``nx_access`` expires, as a unix epoch. Readable by JavaScript,
# because the browser cannot read the HttpOnly access cookie and so has
# no way to know its own session is about to lapse — which is why token
# renewal was reactive: wait for a 401, then refresh, then replay. That
# costs a user-visible request the whole round trip, and in an idle tab
# nothing issues a request at all, so renewal depended on an unrelated
# poller happening to fire.
#
# Publishing the expiry lets the client rotate BEFORE the token dies.
# It leaks nothing — an expiry instant is not a secret, carries no
# identity, and is already implicit in the access cookie's own Max-Age.
#
# SCOPED, unlike ``nx_csrf``. This was unscoped on the reasoning that
# nothing here is signature-bearing, so two environments sharing the name
# would "at most make one of them reschedule sooner than needed — and
# they cannot collide anyway without also colliding on the access cookie,
# which IS scoped."
#
# Both halves of that were wrong, and the second one inverted the actual
# risk. The collision is not between the two cookies; it is two BACKENDS
# writing one name into one jar, which happens whenever sibling
# deployments share a parent domain (``AUTH_COOKIE_DOMAIN`` set to
# ``.example.com``, two instances beneath it). Scoping the access cookie
# is precisely what leaves this one describing a token that is not the
# one the reading tab holds.
#
# And the effect is not "sooner". The client schedules its rotation at
# ``expiry - 60s``; handed a sibling's later expiry it schedules PAST its
# own token's death, never rotates proactively, and falls back to
# reactive 401 refresh — which an idle tab never triggers, because an
# idle tab makes no requests. The session then lapses in exactly the way
# the whole keepalive exists to prevent.
#
# The original objection is real but small: JavaScript reads this by
# name, so the suffix has to be discovered. ``GET /auth/me`` — the
# bootstrap call, made before the keepalive can start — returns
# ``environment_id`` for that. Discovery failing is survivable by
# construction: the reader falls back to the unscoped name, and the
# scheduler already treats "no published expiry" as "probe again in 60s"
# rather than an error.
ACCESS_EXPIRY_COOKIE_NAME = _scoped(_BASE_ACCESS_EXPIRY_COOKIE_NAME)
# Short-lived signed cookie holding the in-flight OIDC handshake
# (state / nonce / PKCE verifier). Scoped to the auth subtree so it is
# only ever sent to the callback. SameSite=Lax is required: the IdP
# redirects back via a top-level GET navigation.
OIDC_COOKIE_NAME = _scoped("nx_oidc")
OIDC_COOKIE_PATH = "/api/v1/auth/"
_OIDC_COOKIE_MAX_AGE = 600

# Short-lived signed cookie holding the in-flight SAML handshake
# (RelayState + next_path). Same PATH scoping as ``nx_oidc``, but NOT the
# same SameSite: the OIDC callback is a cross-site top-level GET, which Lax
# permits, whereas the SAML ACS is a cross-site top-level POST, which Lax
# explicitly withholds cookies from. Under Lax the ACS handler therefore
# never sees this cookie and fails the handshake with ``missing_flow_cookie``
# — the whole SP-initiated flow dead, on every IdP. See ``_cross_site_kwargs``.
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
# Cross-site-scoped for the same reason as ``nx_saml``: linking a SAML IdP
# completes on the ACS POST, and a Lax cookie would be dropped there, silently
# turning a link into a JIT-provision of a duplicate account.
LINK_INTENT_COOKIE_NAME = _scoped("nx_link_intent")
LINK_INTENT_COOKIE_PATH = "/api/v1/auth/"
_LINK_INTENT_COOKIE_MAX_AGE = 600

# Dry-run cookie. Set by ``POST /admin/idp-providers/{id}/dry-run/start``,
# read by the SSO callback, which then reports what WOULD have happened
# and mints nothing. Cross-site-scoped for the same reason as ``nx_saml``:
# a SAML dry-run completes on the ACS POST, and a Lax cookie dropped there
# would silently turn the rehearsal into a real login.
#
# Environment-scoped like every other signed flow cookie. It was the one
# that got missed: it carries a JWT, so two environments open in one
# browser could clobber each other's in-flight rehearsal, and the admin
# would see a dry run fail for no visible reason.
DRYRUN_COOKIE_NAME = _scoped("nx_dryrun")
DRYRUN_COOKIE_PATH = "/api/v1/auth/"
_DRYRUN_COOKIE_MAX_AGE = 600

# Refresh cookie is scoped to the /auth subtree so it's sent to /refresh
# AND /logout (logout needs to read it to revoke the rotation family)
# but is excluded from every data endpoint where it's never useful.
REFRESH_COOKIE_PATH = "/api/v1/auth/"

# The hard limit browsers place on one cookie, measured over name + value
# (RFC 6265bis §5.4; Chrome and Firefox both enforce 4096). Past it the
# cookie is **discarded without any error** — the Set-Cookie is sent, the
# response is a 200, and the next request simply arrives anonymous. That
# silence is what makes an oversized session cookie so expensive to
# diagnose, and why this constant exists rather than being implicit.
MAX_COOKIE_BYTES = 4096

# The point at which the access cookie is close enough to the limit to be
# worth saying so. Nothing branches on it — the token carries nothing that
# grows with tenant size, so it should sit at a few hundred bytes forever —
# which is exactly why crossing this is worth reporting: it means something
# unbounded found its way back into the token, and the margin below the
# limit is the window in which that can still be noticed rather than
# diagnosed from unexplained sign-outs.
#
# Sized so the remaining headroom absorbs an environment-suffixed cookie
# name, a longer signature if the algorithm ever changes, and growth in the
# global permission vocabulary.
ACCESS_COOKIE_WARN_BYTES = 3072


def access_cookie_bytes(token: str) -> int:
    """What the browser will measure for the access cookie.

    Name plus separator plus value — the metric the 4096 limit applies
    to, not the length of the token alone.
    """
    return len(ACCESS_COOKIE_NAME) + 1 + len(token)


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


def _warn_if_oversized(token: str) -> None:
    """Say something when a cookie is about to be thrown away.

    A cookie over ``MAX_COOKIE_BYTES`` is discarded by the browser with no
    error of any kind: the ``Set-Cookie`` goes out, the response is a 200,
    and the next request simply arrives anonymous. The user is bounced to
    /login with nothing in any log to explain it, and because size depends
    on how many workspaces *that particular user* is bound to, it looks
    unreproducible.

    Reaching this is a bug, not a configuration problem — the token carries
    only bounded claims, so its size does not depend on the account — so it
    is logged at ERROR and names the numbers needed to act on it. It stays
    here afterwards as a tripwire: this is the last point in the process
    that can still see the whole cookie.
    """
    size = access_cookie_bytes(token)
    if size <= MAX_COOKIE_BYTES:
        return
    logger.error(
        "Access cookie is %dB, over the %dB limit browsers enforce — it "
        "will be DISCARDED silently and the session will present as an "
        "unexplained sign-out. Nothing in this token is supposed to grow "
        "with the account, so treat it as a bug in what the mint embedded.",
        size, MAX_COOKIE_BYTES,
    )


def set_session_cookies(response: Response, tokens: SessionTokens) -> None:
    """Attach the four session cookies to *response*. Called by /login and /refresh."""
    common = _common_kwargs()
    _warn_if_oversized(tokens.access_token)
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
    # Same reasoning as the CSRF cookie above, for a different reason:
    # this one has to OUTLIVE the access cookie it describes. A tab that
    # boots after the access token died still needs to know *when* it
    # died — that is precisely the tab that should refresh immediately
    # rather than fire a request it knows will 401. Matching the access
    # cookie's own Max-Age would delete this at the exact moment it
    # becomes useful.
    response.set_cookie(
        key=ACCESS_EXPIRY_COOKIE_NAME,
        value=str(int(time.time()) + tokens.access_max_age_seconds),
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
        (ACCESS_EXPIRY_COOKIE_NAME, "/"),
        (_BASE_ACCESS_COOKIE_NAME, "/"),
        (_BASE_REFRESH_COOKIE_NAME, REFRESH_COOKIE_PATH),
        (_BASE_CSRF_COOKIE_NAME, "/"),
        (_BASE_ACCESS_EXPIRY_COOKIE_NAME, "/"),
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
