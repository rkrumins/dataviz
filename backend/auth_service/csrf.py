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
  * /health, /api/v1/health, /api/v1/health/providers — operator probes
"""
from __future__ import annotations

import logging
import secrets
from typing import Iterable

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
    "/health",
    "/api/v1/health",
    "/api/v1/health/providers",
)


def mint_csrf_token() -> str:
    """Generate a new CSRF token. 32 bytes (~256 bits) of randomness."""
    return secrets.token_urlsafe(32)


class CSRFMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, exempt_paths: Iterable[str] = _DEFAULT_EXEMPT_PATHS):
        super().__init__(app)
        self._exempt = set(exempt_paths)

    async def dispatch(self, request: Request, call_next):
        if request.method in _SAFE_METHODS:
            return await call_next(request)

        path = request.url.path
        if path in self._exempt:
            return await call_next(request)

        cookie = request.cookies.get(CSRF_COOKIE_NAME)
        header = request.headers.get(CSRF_HEADER_NAME)

        if not cookie or not header or not secrets.compare_digest(cookie, header):
            logger.warning(
                "CSRF check failed for %s %s (cookie_present=%s header_present=%s)",
                request.method, path, bool(cookie), bool(header),
            )
            return JSONResponse(
                status_code=403,
                content={"detail": "CSRF token missing or invalid"},
            )

        return await call_next(request)
