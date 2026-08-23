"""The middleware stack is in the order its comments claim.

Starlette's ``add_middleware`` does ``user_middleware.insert(0, ...)``
and builds the stack by wrapping in ``reversed()``, so the LAST one
registered ends up OUTERMOST. The registration block was labelled
"outermost → innermost" and was the exact reverse, which cost two
things — neither of them visible at runtime:

  * ``_TimeoutMiddleware``, commented "must be added FIRST so it wraps
    all other middleware", was INNERMOST, so the deadline did not cover
    the gzip pass — the multi-MB graph payloads whose on-loop
    compression is the case the timeout exists for.
  * ``CSRFMiddleware``, commented "innermost", was OUTERMOST, and it
    returns its 403 without calling the rest of the chain — so that
    response carried neither the security headers nor the CORS headers
    the middleware below it would have added.

Nothing asserted the order, so both comments could say the opposite of
the behaviour indefinitely. This is that assertion.
"""
from __future__ import annotations

from backend.app.main import app


def _stack() -> list[str]:
    """Outermost first — the order requests actually traverse."""
    return [mw.cls.__name__ for mw in app.user_middleware]


EXPECTED = [
    # Outermost. The deadline has to enclose everything it is meant to
    # bound, gzip included.
    "_TimeoutMiddleware",
    # Refuses an oversized body before anything reads or parses it,
    # while still inside the deadline that bounds the check.
    "_BodySizeLimitMiddleware",
    # Response decoration, outside anything that can short-circuit, so
    # an early return still gets it.
    "SecurityHeadersMiddleware",
    "RequestIdMiddleware",
    "StructuredLoggingMiddleware",
    "GZipMiddleware",
    # CORS must be outside CSRF: a CSRF 403 is a response a cross-origin
    # caller has to be able to read, and the SPA's self-heal depends on
    # reading `detail.error == 'csrf_failed'` out of its body.
    "CORSMiddleware",
    # Innermost — closest to the route.
    "CSRFMiddleware",
]


def test_the_stack_is_in_the_documented_order():
    assert _stack() == EXPECTED


def test_the_timeout_encloses_gzip():
    """Its own comment says it "wraps all other middleware"."""
    stack = _stack()
    assert stack.index("_TimeoutMiddleware") < stack.index("GZipMiddleware")


def test_security_headers_enclose_csrf():
    """CSRF returns its 403 without calling the rest of the chain, so
    anything that must appear on that response has to be outside it."""
    stack = _stack()
    assert stack.index("SecurityHeadersMiddleware") < stack.index("CSRFMiddleware")


def test_cors_encloses_csrf():
    stack = _stack()
    assert stack.index("CORSMiddleware") < stack.index("CSRFMiddleware")


def test_csrf_is_innermost():
    assert _stack()[-1] == "CSRFMiddleware"
