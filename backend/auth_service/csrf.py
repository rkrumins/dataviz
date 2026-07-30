"""
Double-submit CSRF middleware.

For state-changing requests (POST/PUT/PATCH/DELETE), require the
``X-CSRF-Token`` header to equal the ``nx_csrf`` cookie. Because the
attacker's cross-site request can carry the cookie (browsers attach it
automatically on a SameSite=Lax POST navigation) but cannot read it to
populate the header, the comparison proves the request was initiated by
a same-origin script.

Exempt paths:
  * GET / HEAD / OPTIONS — read-only
  * /api/v1/auth/login   — no session yet
  * /api/v1/auth/refresh — refresh cookie is path-scoped and HttpOnly
  * /api/v1/auth/signup, /forgot-password, /reset-password,
    /verify-invite — no authenticated session
  * /api/v1/auth/logout  — idempotent and intentionally no-auth
  * /api/v1/auth/resolve — email-first routing, pre-session
  * /health, /api/v1/health, /api/v1/health/providers — operator probes
  * /api/v1/auth/{slug}/{acs,sls,browser-profile,mock} — the IdP-callback
    surface; see ``_EXEMPT_PATTERNS`` for why each one has to be, and what
    authenticates it instead.
"""
from __future__ import annotations

import logging
import re
import secrets
from typing import Iterable, Pattern

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

from .cookies import CSRF_COOKIE_NAME

logger = logging.getLogger(__name__)

CSRF_HEADER_NAME = "X-CSRF-Token"

_SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}

_DEFAULT_EXEMPT_PATHS = (
    "/api/v1/auth/login",
    "/api/v1/auth/refresh",
    "/api/v1/auth/logout",
    "/api/v1/auth/signup",
    "/api/v1/auth/forgot-password",
    "/api/v1/auth/reset-password",
    "/api/v1/auth/verify-invite",
    # Email-first login routing. Called from the login page before any
    # session exists, so there is no nx_csrf cookie to submit. Reveals
    # nothing — every miss returns the same empty body — and is rate
    # limited like /login.
    "/api/v1/auth/resolve",
    "/health",
    "/api/v1/health",
    "/api/v1/health/providers",
)


# The IdP-callback surface. These are slug-routed, so the exact-match set
# above can never cover them — a per-provider path is only knowable at
# runtime.
#
# Each of these is unreachable by a same-origin script holding a CSRF token,
# and each carries its own origin authentication instead:
#
#   * /acs, /sls  — the caller is the IdP, POSTing a cross-site form. There is
#     no page of ours in the loop to set a header. Authenticated by the XML
#     signature over the SAML assertion (python3-saml strict mode + replay
#     cache) and by RelayState echoed from the signed ``nx_saml`` cookie.
#   * /browser-profile — posted from /portal-login by a user who is not logged
#     in yet, so no ``nx_csrf`` cookie exists to submit. Authenticated by the
#     HS256/RS256 envelope verified in ``providers/custom_profile.py``, which
#     requires ``exp`` and bounds ``iat`` by ``max_age_seconds``.
#   * /mock — same pre-session situation on the dev-login page. Already
#     hard-gated by ``AUTH_CUSTOM_PROVIDER_ENABLED`` plus the ENV prod guard,
#     so it 404s in production regardless.
#
# Anchored at both ends and limited to a single slug segment on purpose: this
# must not grow into a prefix match that quietly exempts a real state-changing
# route. Anything genuinely driven by our own JS keeps the check.
_EXEMPT_PATTERNS: tuple[Pattern[str], ...] = (
    re.compile(r"^/api/v1/auth/[^/]+/(acs|sls|browser-profile|mock)$"),
)


def mint_csrf_token() -> str:
    """Generate a new CSRF token. 32 bytes (~256 bits) of randomness."""
    return secrets.token_urlsafe(32)


class CSRFMiddleware(BaseHTTPMiddleware):
    def __init__(
        self,
        app,
        exempt_paths: Iterable[str] = _DEFAULT_EXEMPT_PATHS,
        exempt_patterns: Iterable[Pattern[str]] = _EXEMPT_PATTERNS,
    ):
        super().__init__(app)
        self._exempt = set(exempt_paths)
        self._exempt_patterns = tuple(exempt_patterns)

    def _is_exempt(self, path: str) -> bool:
        if path in self._exempt:
            return True
        return any(p.fullmatch(path) for p in self._exempt_patterns)

    async def dispatch(self, request: Request, call_next):
        if request.method in _SAFE_METHODS:
            return await call_next(request)

        path = request.url.path
        if self._is_exempt(path):
            return await call_next(request)

        cookie = request.cookies.get(CSRF_COOKIE_NAME)
        header = request.headers.get(CSRF_HEADER_NAME)

        if not cookie or not header or not secrets.compare_digest(cookie, header):
            logger.warning(
                "CSRF check failed for %s %s (cookie_present=%s header_present=%s)",
                request.method, path, bool(cookie), bool(header),
            )
            # Structured, like the ``requires()`` 403, and for a sharper
            # reason: this is NOT an authorization failure, and a client
            # that cannot tell the two apart shows the user an
            # access-denied modal for a permission they hold.
            #
            # It also has a recovery the permission case does not.
            # ``nx_csrf`` is re-minted by every rotation, so a session
            # that is still valid can repair itself by refreshing — which
            # is what the SPA does when it sees ``csrf_failed``. That
            # matters because the cookie can go missing while the session
            # stays live: ``clear_session_cookies`` evicts across the
            # parent domain two sibling deployments share, so signing out
            # of one instance disarms writes in the other.
            #
            # ``message`` keeps the original prose so anything scraping
            # it still matches.
            return JSONResponse(
                status_code=403,
                content={
                    "detail": {
                        "error": "csrf_failed",
                        "cookie_present": bool(cookie),
                        "message": "CSRF token missing or invalid",
                    }
                },
            )

        return await call_next(request)
