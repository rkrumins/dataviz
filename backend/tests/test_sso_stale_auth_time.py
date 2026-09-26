"""A session is never minted already past the SSO re-auth ceiling.

The ceiling is checked at /refresh, against the IdP's authentication
instant. An IdP whose own session is older than the ceiling can answer a
sign-in with that old instant — a SAML IdP's AuthnInstant, an OIDC IdP that
ignored ``max_age``, a gateway reporting the portal's original login — and
the session minted from it was refused at its first renewal, minutes after
sign-in. Where the protocol can ask for a fresh authentication it now does,
once, at sign-in (``prompt=login`` / ``ForceAuthn``). Where it cannot, or the
IdP ignores the request, the ceiling measures from this sign-in instead.
"""
from __future__ import annotations

import time
from urllib.parse import parse_qs, urlsplit

import pytest

from backend.app.db.repositories import idp_provider_repo
from backend.auth_service.core import config as auth_config
from backend.auth_service.core.config import sso_auth_time_is_stale
from backend.auth_service.core.tokens import (
    create_oidc_state_token,
    create_saml_state_token,
    decode_oidc_state_token,
)
from backend.auth_service.providers.base import ProviderIdentity

_OIDC_SETTINGS = {
    "issuer": "https://idp", "client_id": "c", "client_secret": "s",
    "redirect_uri": "https://app/cb",
}
_SAML_SETTINGS = {
    "idp_entity_id": "https://idp", "idp_sso_url": "https://idp/sso",
    "idp_x509_cert": "MIIB", "sp_entity_id": "https://app",
    "sp_acs_url": "https://app/acs",
}

_TWO_DAYS = 2 * 24 * 3600


def _identity(kind: str, auth_time: int) -> ProviderIdentity:
    return ProviderIdentity(
        provider=kind,
        external_id=f"ext-{kind}",
        email=f"{kind}@corp.example",
        first_name="Stale",
        last_name="Clock",
        raw_claims={"email_verified": True},
        groups=[],
        auth_time=auth_time,
        attributes={},
    )


async def _make(db_session, kind: str, slug: str, settings: dict):
    await idp_provider_repo.create_provider(
        db_session, slug=slug, display_name=slug, kind=kind, settings=settings,
    )
    await db_session.commit()


def _oidc_callback(client, monkeypatch, slug, *, auth_time, forced=False,
                   next_path="/dashboard"):
    from backend.auth_service.providers.oidc import OidcProvider

    async def _fetch(self, *, code, code_verifier, nonce):
        return _identity("oidc", auth_time)

    monkeypatch.setattr(OidcProvider, "fetch_identity", _fetch)
    flow = create_oidc_state_token(
        state="st", nonce="no", code_verifier="cv", next_path=next_path,
        force_reauth=forced,
    )
    return client.get(
        f"/api/v1/auth/{slug}/callback?code=abc&state=st",
        headers={"Cookie": f"nx_oidc={flow}"},
        follow_redirects=False,
    )


def _saml_acs(client, monkeypatch, slug, *, auth_time, forced=False):
    from backend.auth_service.providers.saml2 import SamlProvider

    async def _fetch(self, *, host, https, path, post_data,
                     expected_request_id=None):
        return _identity("saml2", auth_time)

    monkeypatch.setattr(SamlProvider, "fetch_identity", _fetch)
    flow = create_saml_state_token(
        relay_state="rs", next_path="/dashboard", force_reauth=forced,
    )
    return client.post(
        f"/api/v1/auth/{slug}/acs",
        data={"SAMLResponse": "stubbed", "RelayState": "rs"},
        headers={"Cookie": f"nx_saml={flow}"},
        follow_redirects=False,
    )


def _set_cookie_names(resp) -> set[str]:
    return {
        h.split("=", 1)[0]
        for h in resp.headers.get_list("set-cookie")
        if "max-age=0" not in h.lower() and "expires=thu, 01 jan 1970" not in h.lower()
    }


# ── the threshold ────────────────────────────────────────────────────


def test_stale_means_it_would_not_survive_its_first_rotation():
    now = int(time.time())
    ceiling = auth_config.SSO_SESSION_MAX_AGE_SECONDS
    access = auth_config.JWT_EXPIRY_MINUTES * 60

    assert sso_auth_time_is_stale(now - ceiling - 1, now=now)
    # Refused at the first renewal, one access lifetime from now.
    assert sso_auth_time_is_stale(now - (ceiling - access), now=now)
    assert not sso_auth_time_is_stale(now - (ceiling - access) + 1, now=now)
    assert not sso_auth_time_is_stale(now, now=now)


# ── OIDC and SAML: ask once, then measure from this sign-in ──────────


@pytest.mark.asyncio
async def test_oidc_asks_the_idp_once_for_a_fresh_authentication(
    test_client, db_session, registry, sso_events, monkeypatch,
):
    await _make(db_session, "oidc", "stale-oidc", _OIDC_SETTINGS)

    resp = await _oidc_callback(
        test_client, monkeypatch, "stale-oidc",
        auth_time=int(time.time()) - _TWO_DAYS,
    )

    assert resp.status_code == 302, resp.text
    target = urlsplit(resp.headers["location"])
    assert target.path == "/api/v1/auth/stale-oidc/login"
    assert parse_qs(target.query) == {"next": ["/dashboard"], "force": ["1"]}
    # Nothing minted: a session measured from that instant would end at
    # its first renewal. The spent handshake cookie is cleared.
    assert "nx_access" not in _set_cookie_names(resp)
    assert not [t for t, _ in sso_events if t == "user.logged_in"]
    assert any(
        h.startswith("nx_oidc=") for h in resp.headers.get_list("set-cookie")
    )


@pytest.mark.asyncio
async def test_oidc_forced_and_still_stale_is_anchored_not_refused(
    test_client, db_session, registry, sso_events, monkeypatch,
):
    """The IdP ignored ``prompt=login``. Asking again would loop, and
    refusing would lock the user out over the IdP's behaviour — so the
    ceiling measures from this sign-in, and the record says so."""
    await _make(db_session, "oidc", "deaf-oidc", _OIDC_SETTINGS)

    signin = await _oidc_callback(
        test_client, monkeypatch, "deaf-oidc",
        auth_time=int(time.time()) - _TWO_DAYS, forced=True,
    )

    assert signin.status_code == 302, signin.text
    assert signin.headers["location"] == "/dashboard"
    logins = [p for t, p in sso_events if t == "user.logged_in"]
    assert logins[-1]["auth_time_anchored"] is True
    assert abs(logins[-1]["auth_time"] - int(time.time())) <= 5

    refreshed = await test_client.post(
        "/api/v1/auth/refresh",
        cookies={k: v for k, v in signin.cookies.items()},
    )
    assert refreshed.status_code == 200, refreshed.text


@pytest.mark.asyncio
async def test_oidc_a_fresh_authentication_is_used_as_asserted(
    test_client, db_session, registry, sso_events, monkeypatch,
):
    await _make(db_session, "oidc", "fresh-oidc", _OIDC_SETTINGS)
    authenticated = int(time.time()) - 3600

    signin = await _oidc_callback(
        test_client, monkeypatch, "fresh-oidc", auth_time=authenticated,
    )

    assert signin.status_code == 302
    assert signin.headers["location"] == "/dashboard"
    logins = [p for t, p in sso_events if t == "user.logged_in"]
    assert logins[-1]["auth_time"] == authenticated
    assert logins[-1]["auth_time_anchored"] is False


@pytest.mark.asyncio
async def test_saml_asks_the_idp_once_for_a_fresh_authentication(
    test_client, db_session, registry, sso_events, monkeypatch,
):
    await _make(db_session, "saml2", "stale-saml", _SAML_SETTINGS)

    resp = await _saml_acs(
        test_client, monkeypatch, "stale-saml",
        auth_time=int(time.time()) - _TWO_DAYS,
    )

    assert resp.status_code == 302, resp.text
    target = urlsplit(resp.headers["location"])
    assert target.path == "/api/v1/auth/stale-saml/login"
    assert parse_qs(target.query)["force"] == ["1"]
    assert "nx_access" not in _set_cookie_names(resp)


@pytest.mark.asyncio
async def test_saml_forced_and_still_stale_is_anchored(
    test_client, db_session, registry, sso_events, monkeypatch,
):
    await _make(db_session, "saml2", "deaf-saml", _SAML_SETTINGS)

    signin = await _saml_acs(
        test_client, monkeypatch, "deaf-saml",
        auth_time=int(time.time()) - _TWO_DAYS, forced=True,
    )

    assert signin.status_code == 302, signin.text
    assert "nx_access" in _set_cookie_names(signin)
    logins = [p for t, p in sso_events if t == "user.logged_in"]
    assert logins[-1]["auth_time_anchored"] is True


# ── the flag rides the flow cookie ───────────────────────────────────


@pytest.mark.asyncio
async def test_a_forced_sign_in_records_that_it_was_forced(
    test_client, db_session, registry, monkeypatch,
):
    from backend.auth_service.providers.oidc import OidcProvider

    await _make(db_session, "oidc", "flag-oidc", _OIDC_SETTINGS)

    async def _authorize(self, next_path, *, force_reauth=False):
        return "https://idp/authorize", {
            "state": "st", "nonce": "no", "code_verifier": "cv",
            "next": next_path,
        }

    monkeypatch.setattr(OidcProvider, "build_authorization", _authorize)

    def _flow(resp) -> dict:
        raw = next(
            h for h in resp.headers.get_list("set-cookie")
            if h.startswith("nx_oidc=")
        )
        return decode_oidc_state_token(raw.split(";", 1)[0].split("=", 1)[1])

    forced = await test_client.get(
        "/api/v1/auth/flag-oidc/login?next=/x&force=1", follow_redirects=False,
    )
    plain = await test_client.get(
        "/api/v1/auth/flag-oidc/login?next=/x", follow_redirects=False,
    )

    assert _flow(forced)["force"] is True
    # Absent, not False — a flow cookie minted before this change decodes
    # to exactly this, and reads as "not forced yet".
    assert "force" not in _flow(plain)
