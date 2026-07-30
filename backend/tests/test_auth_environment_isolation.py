"""Two environments must not share a session in one browser.

Cookie jars are keyed by DOMAIN, not by cluster. Two deployments that
use identical cookie names (``nx_access``) and identical token stamps
(``iss``/``aud`` both ``nexus-lineage``) therefore overwrite each
other's session even when they run on separate clusters entirely —
signing into UAT logs you out of dev, and the only symptom the server
can report is an opaque "Signature verification failed", because the
foreign token is structurally identical to a genuine one.

``AUTH_ENVIRONMENT_ID`` fixes both halves: it scopes the cookie NAMES so
the jars are disjoint, and binds the environment into ``iss`` so a
cross-environment token fails as a recognisable ``InvalidIssuerError``.
"""
from __future__ import annotations

import importlib
import sys

import jwt
import pytest

from fastapi import Response


_SECRET = "shared-signing-key-" + "a" * 32

_MODULES = (
    "backend.auth_service.cookies",
    "backend.auth_service.core.tokens",
    "backend.auth_service.core.config",
)


def _reload_for_env(monkeypatch, env_id: str | None, *, secret: str = _SECRET):
    """Re-import the auth modules as a given environment."""
    monkeypatch.setenv("JWT_SECRET_KEY", secret)
    monkeypatch.delenv("JWT_SECRET_KEY_PREVIOUS", raising=False)
    if env_id is None:
        monkeypatch.delenv("AUTH_ENVIRONMENT_ID", raising=False)
    else:
        monkeypatch.setenv("AUTH_ENVIRONMENT_ID", env_id)
    for name in _MODULES:
        sys.modules.pop(name, None)
    return (
        importlib.import_module("backend.auth_service.core.tokens"),
        importlib.import_module("backend.auth_service.cookies"),
    )


@pytest.fixture(autouse=True)
def _restore_modules():
    """Put the exact module objects back after each test.

    Re-importing is not enough: modules that did ``from ... import
    decode_token`` at import time keep a reference to the ORIGINAL
    function, so a fresh import would leave ``sys.modules`` and those
    call sites disagreeing about which signing key is in force — which
    surfaces as unrelated auth tests failing later in the session.
    """
    saved = {name: sys.modules.get(name) for name in _MODULES}
    yield
    for name, module in saved.items():
        if module is not None:
            sys.modules[name] = module
        else:
            sys.modules.pop(name, None)


def test_cookie_names_are_disjoint_between_environments(monkeypatch):
    _tokens, dev = _reload_for_env(monkeypatch, "dev")
    dev_names = {dev.ACCESS_COOKIE_NAME, dev.REFRESH_COOKIE_NAME}

    _tokens, uat = _reload_for_env(monkeypatch, "uat")
    uat_names = {uat.ACCESS_COOKIE_NAME, uat.REFRESH_COOKIE_NAME}

    assert dev_names == {"nx_access_dev", "nx_refresh_dev"}
    assert uat_names == {"nx_access_uat", "nx_refresh_uat"}
    # The whole point: signing into one cannot overwrite the other.
    assert dev_names.isdisjoint(uat_names)


def test_csrf_cookie_name_stays_unscoped(monkeypatch):
    """The frontend reads this one from JS by a hardcoded name.

    Scoping it would need the name discovered at runtime before the first
    write, and getting that wrong 403s every POST. Safe to share: the
    double-submit check only compares this cookie against the header on
    the same request, so the value carries no cross-environment meaning.
    """
    _tokens, dev = _reload_for_env(monkeypatch, "dev")
    assert dev.CSRF_COOKIE_NAME == "nx_csrf"
    _tokens, uat = _reload_for_env(monkeypatch, "uat")
    assert uat.CSRF_COOKIE_NAME == "nx_csrf"


def test_handshake_cookies_are_scoped_too(monkeypatch):
    """SSO callbacks are equally reachable cross-environment."""
    _tokens, uat = _reload_for_env(monkeypatch, "uat")
    assert uat.OIDC_COOKIE_NAME == "nx_oidc_uat"
    assert uat.SAML_COOKIE_NAME == "nx_saml_uat"
    assert uat.LINK_INTENT_COOKIE_NAME == "nx_link_intent_uat"
    # nx_dryrun was the one that got missed. It carries a JWT like its
    # siblings, so two environments open in one browser could clobber
    # each other's in-flight rehearsal.
    assert uat.DRYRUN_COOKIE_NAME == "nx_dryrun_uat"


def test_every_signed_cookie_is_scoped(monkeypatch):
    """The inventory check, so the next flow cookie cannot be forgotten.

    Naming them one by one is how ``nx_dryrun`` stayed unscoped: it was
    added after the list and nothing compared the two. This asserts the
    property instead — anything carrying a signature is scoped, and the
    exceptions are named with a reason.
    """
    _tokens, uat = _reload_for_env(monkeypatch, "uat")

    # Both are read from JavaScript by name and neither is
    # signature-bearing, so a shared name costs nothing. See the comments
    # on their definitions.
    unscoped_by_design = {"CSRF_COOKIE_NAME", "ACCESS_EXPIRY_COOKIE_NAME"}

    for attr in dir(uat):
        if not attr.endswith("_COOKIE_NAME") or attr.startswith("_"):
            continue
        value = getattr(uat, attr)
        if attr in unscoped_by_design:
            assert not value.endswith("_uat"), f"{attr} is scoped unexpectedly"
        else:
            assert value.endswith("_uat"), (
                f"{attr}={value!r} is not environment-scoped. If it carries "
                "a signature it must be; if it does not, add it to "
                "unscoped_by_design with the reason."
            )


def test_foreign_token_fails_as_issuer_not_signature(monkeypatch):
    """The diagnosis users actually need.

    Same signing key, different environment: without issuer binding this
    token would simply be accepted, silently giving a dev session
    authority in UAT. With it, the failure names the real cause.
    """
    dev_tokens, _cookies = _reload_for_env(monkeypatch, "dev")
    dev_token = dev_tokens.create_access_token("u1", "a@b.c", "user")

    uat_tokens, _cookies = _reload_for_env(monkeypatch, "uat")
    with pytest.raises(jwt.InvalidIssuerError):
        uat_tokens.decode_token(dev_token)


def test_foreign_token_is_classified_unrecoverable(monkeypatch):
    dev_tokens, _cookies = _reload_for_env(monkeypatch, "dev")
    dev_token = dev_tokens.create_access_token("u1", "a@b.c", "user")

    uat_tokens, _cookies = _reload_for_env(monkeypatch, "uat")
    try:
        uat_tokens.decode_token(dev_token)
    except jwt.InvalidTokenError as exc:
        assert uat_tokens.is_foreign_token_error(exc)
    else:  # pragma: no cover - guarded by the test above
        pytest.fail("cross-environment token was accepted")


def test_refresh_family_is_environment_bound(monkeypatch):
    """Refresh is where the reported error surfaced, so pin it too."""
    dev_tokens, _cookies = _reload_for_env(monkeypatch, "dev")
    dev_refresh, _claims = dev_tokens.create_refresh_token("u1")

    uat_tokens, _cookies = _reload_for_env(monkeypatch, "uat")
    with pytest.raises(jwt.InvalidTokenError):
        uat_tokens.decode_refresh_token(dev_refresh)


def test_unset_environment_id_preserves_existing_behaviour(monkeypatch):
    """Single-environment deployments must see no change at all."""
    tokens, cookies = _reload_for_env(monkeypatch, None)
    assert cookies.ACCESS_COOKIE_NAME == "nx_access"
    assert cookies.REFRESH_COOKIE_NAME == "nx_refresh"
    assert cookies.CSRF_COOKIE_NAME == "nx_csrf"
    assert tokens.JWT_ISSUER == "nexus-lineage"


def test_invalid_environment_id_fails_fast(monkeypatch):
    """The id becomes part of a cookie name; a bad one would yield a
    cookie the browser silently refuses to store."""
    monkeypatch.setenv("JWT_SECRET_KEY", _SECRET)
    monkeypatch.setenv("AUTH_ENVIRONMENT_ID", "bad env!")
    sys.modules.pop("backend.auth_service.core.config", None)
    with pytest.raises(RuntimeError, match="AUTH_ENVIRONMENT_ID"):
        importlib.import_module("backend.auth_service.core.config")


# ── Cookie eviction ──────────────────────────────────────────────────


def _set_cookie_headers(response: Response) -> list[str]:
    return [
        value.decode()
        for key, value in response.raw_headers
        if key.decode().lower() == "set-cookie"
    ]


def test_eviction_covers_host_only_and_parent_domain(monkeypatch):
    """The loop-breaker.

    A browser deletes a cookie only when the deletion repeats the exact
    domain it was stored under. Clearing with just this process's
    configured domain misses a cookie written host-only or under a
    shared parent — so the server rejects it, fails to clear it, and the
    browser sends it again on the next request, forever.
    """
    _tokens, cookies = _reload_for_env(monkeypatch, "uat")

    class _FakeURL:
        hostname = "dataviz-uat.local"

    class _FakeRequest:
        url = _FakeURL()

    response = Response()
    cookies.clear_session_cookies(response, _FakeRequest())
    headers = _set_cookie_headers(response)

    assert any("Domain=.local" in h for h in headers), headers
    # Host-only deletions carry no Domain attribute at all.
    assert any("Domain=" not in h for h in headers), headers


def test_eviction_also_clears_the_unscoped_legacy_names(monkeypatch):
    """Upgrade path.

    A browser already holding a poisoned ``nx_access`` from before
    scoping existed would otherwise keep it forever, since the new code
    only ever writes and clears ``nx_access_<env>``.
    """
    _tokens, cookies = _reload_for_env(monkeypatch, "uat")

    response = Response()
    cookies.clear_session_cookies(response)
    headers = _set_cookie_headers(response)

    assert any(h.startswith("nx_access_uat=") for h in headers), headers
    assert any(h.startswith("nx_access=") for h in headers), headers
    assert any(h.startswith("nx_refresh=") for h in headers), headers
    assert any(h.startswith("nx_csrf=") for h in headers), headers


def test_eviction_without_a_request_still_clears_configured_and_host_only(monkeypatch):
    """``/logout`` on a code path with no request in scope must still work."""
    _tokens, cookies = _reload_for_env(monkeypatch, None)

    response = Response()
    cookies.clear_session_cookies(response)
    headers = _set_cookie_headers(response)

    assert any(h.startswith("nx_access=") for h in headers), headers
    assert all("Max-Age=0" in h or "expires=" in h.lower() for h in headers), headers
