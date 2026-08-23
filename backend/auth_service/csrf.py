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
  * /api/v1/auth/refresh — no readable sid once the access token has
    lapsed, which is exactly when it is called
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

import hashlib
import hmac
import logging
import os
import re
import secrets
from typing import Iterable, Pattern
from urllib.parse import urlsplit

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

from .cookies import ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME
from .core import config

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


def _origin_of(url: str) -> str:
    """``scheme://host[:port]`` of *url*, or "" if it has no origin."""
    parts = urlsplit(url)
    if not parts.scheme or not parts.netloc:
        return ""
    return f"{parts.scheme}://{parts.netloc}"


#: Separates the nonce from its tag. Not in the token_urlsafe alphabet,
#: so it cannot appear inside either half.
_CSRF_SEP = "."


def _tag(nonce: str, sid: str, key: str) -> str:
    """Truncated HMAC binding a CSRF nonce to one session."""
    return hmac.new(
        key.encode(), f"{nonce}{_CSRF_SEP}{sid}".encode(), hashlib.sha256,
    ).hexdigest()[:32]


def mint_csrf_token(sid: str | None = None) -> str:
    """A CSRF token bound to the session that will submit it.

    Plain double-submit compares the cookie against the header and
    nothing else, so the value it proves knowledge of is one the
    ATTACKER may have chosen. Anyone able to write a cookie into the
    victim's jar for this domain — a compromised sibling subdomain, a
    subdomain takeover, XSS anywhere under a shared parent — sets
    ``nx_csrf`` to a value of their own and sends the matching header.
    The comparison succeeds, the victim's ``nx_access`` rides along
    automatically, and every state-changing endpoint is reachable. The
    cookie is ``Path=/`` with no ``__Host-`` prefix, and
    ``AUTH_COOKIE_DOMAIN`` exists specifically to share the jar across
    subdomains, so the preconditions are not exotic.

    Binding the nonce to the session's ``sid`` under the signing key
    closes it: the attacker can still choose a nonce, but cannot produce
    the tag for the victim's ``sid``, and their own session's token
    carries the wrong one.

    ``sid`` is ``None`` only where no session exists yet. Those paths are
    exempt from the check anyway; the unbound token is kept so the
    fallback below stays meaningful rather than becoming a special case
    nothing produces.
    """
    nonce = secrets.token_urlsafe(32)
    if not sid:
        return nonce
    return f"{nonce}{_CSRF_SEP}{_tag(nonce, sid, config.JWT_SECRET_KEY)}"


def verify_csrf_token(presented: str, sid: str | None) -> bool:
    """Whether *presented* was minted for *sid*.

    Verified against the whole key ring, not just the active key, so a
    signing-key rotation does not 403 every write in flight — the same
    reasoning ``_candidate_keys`` applies to tokens.

    When the session carries no ``sid`` the tag cannot be checked and
    this falls back to "is it well-formed". That is not a hole an
    attacker can steer into: whether a ``sid`` is present is decided by
    the victim's signed access token, which the attacker cannot alter.
    """
    if not presented:
        return False
    if not sid:
        return True
    nonce, sep, tag = presented.partition(_CSRF_SEP)
    if not sep or not nonce or not tag:
        # An unbound token against a session that has a sid: either a
        # pre-rotation cookie (the SPA refreshes and retries) or a
        # planted one. Both are correctly refused.
        return False
    return any(
        hmac.compare_digest(tag, _tag(nonce, sid, key))
        for _kid, key in config.JWT_VERIFICATION_KEYS
    )


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
        return self._is_idp_callback(path)

    def _is_idp_callback(self, path: str) -> bool:
        """The slug-routed IdP surface, which is legitimately cross-site."""
        return any(p.fullmatch(path) for p in self._exempt_patterns)

    async def dispatch(self, request: Request, call_next):
        if request.method in _SAFE_METHODS:
            return await call_next(request)

        path = request.url.path

        # Origin is checked FIRST, and on nearly everything the
        # double-submit skips.
        #
        # The exempt list is mostly pre-session endpoints — login,
        # refresh, signup, password reset — which have no ``nx_csrf``
        # cookie to submit and so cannot be protected by comparing one.
        # That left them with no CSRF defence at all beyond
        # ``SameSite=Lax``, which is a browser default the operator can
        # switch off (``AUTH_COOKIE_SAMESITE=none``). Origin needs no
        # cookie, so it covers exactly the endpoints double-submit
        # cannot: login-CSRF (signing a victim into an attacker's
        # account), logout-CSRF, and a cross-site rotation of somebody
        # else's token family.
        #
        # The IdP callbacks are the real exception. ``/acs`` is a
        # cross-site top-level POST from the IdP and ``/sls`` likewise —
        # a foreign Origin there is the correct, expected case, and each
        # carries its own authentication (XML signature + replay cache,
        # signed flow cookie). ``/browser-profile`` and ``/mock`` are
        # posted from our own pages, but they are grouped with the
        # others by one regex and separating them here would mean a
        # second list to keep in sync; both already verify a signed
        # envelope or are prod-disabled outright.
        if not self._is_idp_callback(path) and not self._origin_is_allowed(request):
            logger.warning(
                "Cross-origin write refused for %s %s (origin=%r)",
                request.method, path, request.headers.get("origin"),
            )
            return self._refuse(cookie_present=bool(
                request.cookies.get(CSRF_COOKIE_NAME)
            ))

        if self._is_exempt(path):
            return await call_next(request)

        cookie = request.cookies.get(CSRF_COOKIE_NAME)
        header = request.headers.get(CSRF_HEADER_NAME)

        if (
            not cookie
            or not header
            or not secrets.compare_digest(cookie, header)
            or not verify_csrf_token(cookie, self._session_sid(request))
        ):
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
            return self._refuse(cookie_present=bool(cookie))

        return await call_next(request)

    @staticmethod
    def _session_sid(request: Request) -> str | None:
        """The ``sid`` this request's access cookie claims, if readable.

        An expired or absent access token yields ``None``, and the CSRF
        check then falls back to plain double-submit — which is correct,
        because such a request is about to be refused by
        ``get_current_user`` anyway. Answering 401 there is more useful
        to the client than 403 here.
        """
        raw = request.cookies.get(ACCESS_COOKIE_NAME)
        if not raw:
            return None
        try:
            from .core.tokens import decode_token

            return decode_token(raw).get("sid")
        except Exception:  # noqa: BLE001 — unreadable token, not our call
            return None

    def _origin_is_allowed(self, request: Request) -> bool:
        """Second, independent check: did this write come from our page?

        Double-submit — even bound to the session — assumes the attacker
        cannot write our cookie. Origin assumes they cannot forge the
        header, which browsers guarantee. Two assumptions rather than
        one, and this one also covers the configuration where
        ``AUTH_COOKIE_SAMESITE=none`` removes the browser's own
        protection.

        A missing Origin AND Referer is allowed: non-browser clients
        (curl, the smoke script, server-to-server) send neither, and
        they are not the threat CSRF is about — the attack requires a
        browser, and browsers send Origin on every cross-site write.
        """
        origin = request.headers.get("origin")
        if origin is None:
            referer = request.headers.get("referer")
            if not referer:
                return True
            origin = _origin_of(referer)
        return origin in self._allowed_origins(request)

    @staticmethod
    def _allowed_origins(request: Request) -> set[str]:
        """Our own origin, plus whatever CORS is configured to trust.

        Read per request rather than cached: ``CORS_ALLOWED_ORIGINS`` is
        the same list the CORS middleware uses, and the two disagreeing
        would produce a request the browser permits and we refuse.

        Both schemes are accepted for our OWN host, and that is
        deliberate. TLS terminates upstream, so the app sees ``http``
        and has to infer the client's scheme from ``X-Forwarded-Proto``
        — a header some deployments do not set. Pinning the comparison
        to the inferred scheme would mean that on any such deployment
        the browser sends ``Origin: https://host`` while this computes
        ``http://host``, and EVERY write 403s. That is a large
        availability risk for a small security one: an ``http`` origin
        on our own host is either us behind a proxy we mis-read, or a
        downgrade that HSTS and ``Secure`` cookies already answer.
        Entries from ``CORS_ALLOWED_ORIGINS`` stay exact — those are
        third-party origins and the scheme is part of naming them.
        """
        allowed = {
            o.strip()
            for o in os.getenv("CORS_ALLOWED_ORIGINS", "").split(",")
            if o.strip()
        }
        host = request.headers.get("host")
        if host:
            allowed.add(f"https://{host}")
            allowed.add(f"http://{host}")
        return allowed

    @staticmethod
    def _refuse(*, cookie_present: bool) -> JSONResponse:
        return JSONResponse(
            status_code=403,
            content={
                "detail": {
                    "error": "csrf_failed",
                    "cookie_present": cookie_present,
                    "message": "CSRF token missing or invalid",
                }
            },
        )
