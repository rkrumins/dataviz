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
    # Conditional: mounted only when ALLOWED_HOSTS is configured, which
    # it is not in this suite. Inserted into the expectation below when
    # it is, so neither posture can drift unnoticed.
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


def _expected() -> list[str]:
    """EXPECTED, with the conditional host allowlist spliced in when this
    deployment configures one."""
    from backend.app.main import ALLOWED_HOSTS

    if not ALLOWED_HOSTS:
        return EXPECTED
    out = list(EXPECTED)
    out.insert(out.index("RequestIdMiddleware"), "_TrustedHostMiddleware")
    return out


def test_the_stack_is_in_the_documented_order():
    assert _stack() == _expected()


def test_the_host_allowlist_sits_between_headers_and_csrf():
    """Inside SecurityHeadersMiddleware so a 400 still carries the headers,
    and outside CSRFMiddleware, which derives its same-origin allowance
    from the very Host header this validates.

    Asserted on the intended order rather than the live stack, because
    ALLOWED_HOSTS is unset in this suite and the layer is therefore not
    mounted — the placement still has to be pinned."""
    from backend.app.main import ALLOWED_HOSTS

    order = list(EXPECTED)
    if not ALLOWED_HOSTS:
        order.insert(order.index("RequestIdMiddleware"), "_TrustedHostMiddleware")
    else:
        order = _stack()
    assert order.index("SecurityHeadersMiddleware") < order.index(
        "_TrustedHostMiddleware"
    )
    assert order.index("_TrustedHostMiddleware") < order.index("CSRFMiddleware")


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
