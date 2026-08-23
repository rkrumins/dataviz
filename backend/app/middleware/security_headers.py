"""
Middleware that adds standard security headers to every response.

These mitigate clickjacking, MIME-sniffing, and XSS risks.
HSTS is only added when the request arrives over HTTPS (or behind a
reverse proxy that sets X-Forwarded-Proto: https).
"""
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response


_DOCS_PATHS = ("/docs", "/redoc", "/openapi.json")

#: Cookie-name prefix for the session cookies. Matched by prefix rather
#: than exactly because ``AUTH_ENVIRONMENT_ID`` suffixes them
#: (``nx_access_uat``), and this must not need updating when it is set.
_SESSION_COOKIE_PREFIX = "nx_access"


def _carries_a_session(request: Request) -> bool:
    return any(
        name.startswith(_SESSION_COOKIE_PREFIX)
        for name in request.cookies
    ) or "authorization" in request.headers


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next) -> Response:
        response: Response = await call_next(request)

        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-XSS-Protection"] = "0"  # modern browsers; CSP is the real protection
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"

        # Swagger UI / ReDoc load scripts and styles from cdn.jsdelivr.net.
        # The /docs and /redoc HTML pages contain an inline bootstrap <script>
        # that calls SwaggerUIBundle/Redoc, so 'unsafe-inline' is required for
        # script-src. connect-src must include the CDN for source-map fetches.
        if request.url.path in _DOCS_PATHS:
            response.headers["Content-Security-Policy"] = (
                "default-src 'self'; "
                "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; "
                "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; "
                "img-src 'self' data: https://fastapi.tiangolo.com; "
                "font-src 'self' https://cdn.jsdelivr.net; "
                "connect-src 'self' https://cdn.jsdelivr.net; "
                "frame-ancestors 'none'"
            )
        else:
            response.headers["Content-Security-Policy"] = (
                "default-src 'self'; "
                "script-src 'self'; "
                "style-src 'self' 'unsafe-inline'; "
                "img-src 'self' data: blob:; "
                "font-src 'self'; "
                "connect-src 'self'; "
                "frame-ancestors 'none'"
            )

        # Cross-origin isolation for the API surface. Cheap, and it stops
        # a response being embedded as a subresource by another origin.
        response.headers.setdefault(
            "Cross-Origin-Opener-Policy", "same-origin",
        )
        response.headers.setdefault(
            "Cross-Origin-Resource-Policy", "same-origin",
        )

        # Authenticated responses must not be cached.
        #
        # Nothing set this, so /users/me, /me/permissions and /directory
        # were storable by any intermediary and by the browser's
        # back/forward cache — which is how a shared workstation shows
        # the previous user's identity after a sign-out.
        #
        # Keyed on the request carrying a session rather than on the
        # response, because the response to an authenticated request is
        # user-specific whether or not it happens to contain the user.
        # ``setdefault`` so a handler that has deliberately chosen its
        # own caching (the branding manifest, the docs) keeps it.
        if _carries_a_session(request):
            response.headers.setdefault(
                "Cache-Control", "no-store, no-cache, must-revalidate, private",
            )

        # HSTS only when behind TLS
        proto = request.headers.get("x-forwarded-proto", request.url.scheme)
        if proto == "https":
            response.headers["Strict-Transport-Security"] = (
                "max-age=31536000; includeSubDomains"
            )

        return response
