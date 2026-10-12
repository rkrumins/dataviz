"""Open-redirect guard on the post-login bounce.

``_safe_next`` is the single choke point for ``?next=`` across OIDC, the
SAML ACS and both custom provider kinds. Its value is sealed into the
signed flow cookie and acted on by ``_session_redirect`` *after* the
session cookies are set, so anything that escapes the origin here
bounces an already-authenticated user to the attacker.

The original guard was ``startswith("/") and not startswith("//")``,
which accepts ``/\\evil.com``. Browsers implement the WHATWG URL spec,
whose relative-slash state treats a backslash as a slash, so that value
resolves to ``https://evil.com/``.
"""
from __future__ import annotations

import pytest

from backend.auth_service.api.router import _safe_next


ESCAPES = [
    # The bypass this test exists for.
    "/\\evil.com",
    "/\\\\evil.com",
    "/\\/evil.com",
    # Percent-encoded forms of the same, decoded by the browser.
    "/%5cevil.com",
    "/%5Cevil.com",
    "/%2f%2fevil.com",
    "/%2F%2Fevil.com",
    # Control characters stripped from the URL before parsing, which
    # turns the remainder into a protocol-relative URL.
    "/\tevil.com",
    "/\t/evil.com",
    "/\n/evil.com",
    "/\r/evil.com",
    "/%09/evil.com",
    # The shapes the original guard already handled — kept so a rewrite
    # cannot regress them while fixing the backslash.
    "//evil.com",
    "///evil.com",
    "https://evil.com",
    "http://evil.com",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "evil.com",
    "",
    None,
]


@pytest.mark.parametrize("raw", ESCAPES)
def test_values_that_can_leave_the_origin_fall_back_to_root(raw):
    assert _safe_next(raw) == "/", f"{raw!r} was accepted as a same-site path"


LEGITIMATE = [
    "/",
    "/dashboard",
    "/workspaces/ws_123/views",
    "/views?tab=shared&sort=name",
    "/docs/overview#section-2",
    # A colon inside a path segment is legal and cannot introduce a
    # scheme, because the value already starts with "/".
    "/catalog/urn:li:dataset:abc",
    # Percent-encoding that stays a path once decoded must survive.
    "/search?q=a%20b",
    "/views/My%20View",
]


@pytest.mark.parametrize("raw", LEGITIMATE)
def test_real_relative_paths_are_preserved_verbatim(raw):
    assert _safe_next(raw) == raw
