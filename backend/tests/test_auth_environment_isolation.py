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

    # Nothing is unscoped any more. Both JS-readable cookies used to be,
    # on the reasoning that neither carries a signature — true of their
    # VALUES, and irrelevant to the problem, which turned out to be about
    # their NAMES. See the two tests below for what each one cost.
    unscoped_by_design: set[str] = set()

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


def test_the_expiry_cookie_is_scoped_so_siblings_cannot_cross_wire(monkeypatch):
    """Two deployments under one parent domain write one cookie jar.

    ``nx_access_exp`` was unscoped on the reasoning that nothing in it is
    signature-bearing, so sharing it would "at most make one of them
    reschedule sooner than needed — and they cannot collide anyway
    without also colliding on the access cookie, which IS scoped."

    Both halves were wrong. The collision is not between the two cookies;
    it is two BACKENDS writing one name, which is what scoping the access
    cookie leaves possible rather than prevents. And the effect is not
    "sooner": the client schedules at ``expiry - 60s``, so a sibling's
    LATER expiry schedules it past its own token's death. It then never
    renews proactively and falls back to reactive 401 refresh, which an
    idle tab never triggers because it issues no requests — the session
    lapses in exactly the way the keepalive exists to prevent.
    """
    _tokens, dev = _reload_for_env(monkeypatch, "dev")
    _tokens, uat = _reload_for_env(monkeypatch, "uat")

    assert dev.ACCESS_EXPIRY_COOKIE_NAME == "nx_access_exp_dev"
    assert uat.ACCESS_EXPIRY_COOKIE_NAME == "nx_access_exp_uat"
    assert dev.ACCESS_EXPIRY_COOKIE_NAME != uat.ACCESS_EXPIRY_COOKIE_NAME


def test_two_backends_writing_one_jar_do_not_overwrite_the_schedule(monkeypatch):
    """The failure, reproduced at the level it actually happens.

    Not two constants compared — two responses, from two deployments,
    landing in the browser one after the other the way sibling hosts
    under a shared ``AUTH_COOKIE_DOMAIN`` do. Both expiry values have to
    survive, or whichever backend answered last decides when the other's
    tabs renew.
    """
    jar: dict[str, str] = {}

    def _collect(response: Response) -> None:
        for header in response.headers.getlist("set-cookie"):
            name, _, rest = header.partition("=")
            jar[name] = rest.split(";")[0]

    for env in ("dev", "uat"):
        _tokens, cookies = _reload_for_env(monkeypatch, env)
        response = Response()
        cookies.set_session_cookies(
            response,
            cookies.SessionTokens(
                access_token=f"access.{env}",
                access_max_age_seconds=900,
                refresh_token=f"refresh.{env}",
                refresh_max_age_seconds=604800,
                csrf_token="csrf",
            ),
        )
        _collect(response)

    assert "nx_access_exp_dev" in jar
    assert "nx_access_exp_uat" in jar
    assert "nx_access_exp" not in jar, (
        "an unscoped expiry cookie is still being written; a sibling "
        "deployment will overwrite it and cross-wire the renewal schedule"
    )


def test_the_csrf_cookie_is_scoped_so_one_logout_cannot_disarm_the_other(
    monkeypatch,
):
    """Sharing the VALUE is harmless. Sharing the NAME is not.

    The double-submit check only compares this cookie against the header
    on the same request, so a value minted by a sibling deployment proves
    exactly what the check is for — that reasoning held, and it is why
    this cookie stayed unscoped.

    What it missed is deletion. ``clear_session_cookies`` evicts across
    every domain scope a cookie might hold, deliberately including the
    parent two sibling deployments share. Under one name, signing out of
    instance A deletes instance B's CSRF cookie — and B's session is
    untouched, because ITS access and refresh cookies are scoped. The
    result is a live, authenticated session that cannot perform a single
    write, reporting "CSRF token missing or invalid" on operations the
    user is fully entitled to perform.
    """
    _tokens, dev = _reload_for_env(monkeypatch, "dev")
    _tokens, uat = _reload_for_env(monkeypatch, "uat")

    assert dev.CSRF_COOKIE_NAME == "nx_csrf_dev"
    assert uat.CSRF_COOKIE_NAME == "nx_csrf_uat"

    # And the eviction list — the mechanism that caused the damage — must
    # not reach across. Clearing dev's session names dev's cookie and the
    # legacy unscoped one, never uat's.
    dev_targets = {name for name, _path in dev._eviction_targets()}
    assert "nx_csrf_dev" in dev_targets
    assert "nx_csrf" in dev_targets, "the pre-scoping cookie must still be evictable"
    assert "nx_csrf_uat" not in dev_targets


def test_the_healed_csrf_cookie_uses_the_scoped_name(monkeypatch):
    """The /auth/me heal writes through ``set_csrf_cookie``, which must
    inherit the environment scoping — an unscoped heal would recreate
    the very cross-deployment clobbering the scoping exists to stop."""
    _tokens, dev = _reload_for_env(monkeypatch, "dev")
    response = Response()
    dev.set_csrf_cookie(response, "tok", max_age_seconds=60)

    headers = response.headers.getlist("set-cookie")
    assert len(headers) == 1
    assert headers[0].startswith("nx_csrf_dev=")
    assert not headers[0].startswith("nx_csrf=")


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
