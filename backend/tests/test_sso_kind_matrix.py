"""Cross-cutting guarantees, asserted once per provider kind.

Every other SSO test picks a kind — almost always ``oidc`` — and asserts a
feature works there. Nothing iterated ``VALID_KINDS``, so the suite had no
way to express "this holds for *every* kind", and a capability that reached
two of four looked exactly like one that reached all four.

That is not hypothetical: the dry-run shipped into the OIDC and SAML
callbacks only. It was missing from ``custom_profile`` — the kind the whole
feature set exists for, and the only one that can be ``unverified`` or
``asserted``, so the one where rehearsing a sign-in matters most because
nothing cryptographic is standing behind it.

The scaffolding here is the deliverable as much as the assertions are: a
driver per kind, so the next cross-cutting guarantee can be asserted across
the axis in a few lines rather than being quietly forgotten for two of them.
"""
from __future__ import annotations

import secrets
import time
import uuid
from dataclasses import dataclass
from typing import Callable

import jwt as pyjwt
import pytest
from sqlalchemy import func, select

from backend.app.auth.dependencies import (
    get_current_user, get_optional_user, get_permission_claims,
)
from backend.app.auth.password import hash_password
from backend.app.db import models as _models
from backend.app.db.repositories import idp_provider_repo, user_repo
from backend.auth_service.cookies import ACCESS_COOKIE_NAME, REFRESH_COOKIE_NAME
from backend.auth_service.core.password import is_password_set
from backend.auth_service.core.tokens import (
    create_dryrun_token,
    create_oidc_state_token,
    create_saml_state_token,
    decode_token,
)
from backend.auth_service.providers.base import ProviderIdentity

_SECRET = "s" * 48


def _identity(kind: str) -> ProviderIdentity:
    return ProviderIdentity(
        provider=kind,
        external_id=f"ext-{kind}",
        email=f"{kind}@corp.example",
        first_name="Kind",
        last_name="Matrix",
        raw_claims={"kind": kind, "claims": {"sub": f"ext-{kind}"},
                    "email_verified": True},
        groups=[],
        auth_time=None,
        attributes={},
    )


# ── One driver per kind ──────────────────────────────────────────────


@dataclass
class KindDriver:
    """How to stand up a provider of one kind and drive a login through
    its own entry point. Each kind enters the system differently — a
    redirect callback, a form POST, a cookie read — so a shared assertion
    needs a shared way in."""
    kind: str
    settings: dict
    #: (client, slug, monkeypatch, extra_cookies) -> httpx Response
    drive: Callable


async def _make(db_session, driver: KindDriver, slug: str):
    row = await idp_provider_repo.create_provider(
        db_session, slug=slug, display_name=slug, kind=driver.kind,
        settings=driver.settings,
    )
    await db_session.commit()
    return row


def _drive_oidc(client, slug, monkeypatch, cookies):
    from backend.auth_service.providers.oidc import OidcProvider

    async def _fetch(self, *, code, code_verifier, nonce):
        return _identity("oidc")

    monkeypatch.setattr(OidcProvider, "fetch_identity", _fetch)
    jar = {"nx_oidc": create_oidc_state_token(
        state="st", nonce="no", code_verifier="cv", next_path="/",
    ), **cookies}
    return client.get(
        f"/api/v1/auth/{slug}/callback?code=abc&state=st",
        headers={"Cookie": "; ".join(f"{k}={v}" for k, v in jar.items())},
        follow_redirects=False,
    )


def _drive_saml(client, slug, monkeypatch, cookies):
    from backend.auth_service.providers.saml2 import SamlProvider

    async def _fetch(self, *, host, https, path, post_data,
                     expected_request_id=None):
        return _identity("saml2")

    monkeypatch.setattr(SamlProvider, "fetch_identity", _fetch)
    jar = {"nx_saml": create_saml_state_token(relay_state="rs", next_path="/"),
           **cookies}
    return client.post(
        f"/api/v1/auth/{slug}/acs",
        data={"SAMLResponse": "stubbed", "RelayState": "rs"},
        headers={"Cookie": "; ".join(f"{k}={v}" for k, v in jar.items())},
        follow_redirects=False,
    )


def _profile_jwt(kind: str) -> str:
    now = int(time.time())
    return pyjwt.encode(
        {"sub": f"ext-{kind}", "emailAddress": f"{kind}@corp.example",
         "firstName": "Kind", "lastName": "Matrix",
         # ``jti`` is required and single-use: a copied payload must not
         # be replayable. Unique per call so a re-run of this driver does
         # not trip the replay cache.
         "jti": f"kind-matrix-{uuid.uuid4()}",
         "iat": now, "exp": now + 300},
        _SECRET, algorithm="HS256",
    )


def _drive_custom_profile(client, slug, monkeypatch, cookies):
    jar = {"corp_profile": _profile_jwt("custom_profile"), **cookies}
    return client.get(
        f"/api/v1/auth/{slug}/login?next=/dashboard",
        headers={"Cookie": "; ".join(f"{k}={v}" for k, v in jar.items())},
        follow_redirects=False,
    )


def _drive_custom(client, slug, monkeypatch, cookies):
    from backend.auth_service.api import router as router_mod
    from backend.auth_service.core.tokens import create_mock_identity_token

    # Dev-only kind, gated off by default. The gate is not what this file
    # is testing, so open it for the duration.
    monkeypatch.setattr(router_mod, "AUTH_CUSTOM_PROVIDER_ENABLED", True)
    # DEFAULT_CUSTOM maps ``external_id``/``first_name``/``last_name``,
    # not the OIDC spellings.
    jar = {"nx_mock_identity": create_mock_identity_token({
        "external_id": "ext-custom", "email": "custom@corp.example",
        "email_verified": True,
        "first_name": "Kind", "last_name": "Matrix",
    }), **cookies}
    return client.get(
        f"/api/v1/auth/{slug}/login?next=/dashboard",
        headers={"Cookie": "; ".join(f"{k}={v}" for k, v in jar.items())},
        follow_redirects=False,
    )


def _drive_backchannel(client, slug, monkeypatch, cookies):
    """The ambient cookie is the only thing the browser contributes, and
    the two outbound legs are stubbed at ``fetch_identity`` — the same
    seam the OIDC and SAML drivers use. What the gateway says is this
    file's business only insofar as an identity comes back."""
    from backend.auth_service.providers.backchannel import BackchannelProvider

    async def _fetch(self, raw):
        assert raw == "ambient-xyz"   # the driver really did present it
        return _identity("backchannel")

    monkeypatch.setattr(BackchannelProvider, "fetch_identity", _fetch)
    jar = {"corp_session": "ambient-xyz", **cookies}
    return client.get(
        f"/api/v1/auth/{slug}/login?next=/dashboard",
        headers={"Cookie": "; ".join(f"{k}={v}" for k, v in jar.items())},
        follow_redirects=False,
    )


DRIVERS = [
    KindDriver("oidc", {
        "issuer": "https://idp", "client_id": "c", "client_secret": "s",
        "redirect_uri": "https://app/cb",
    }, _drive_oidc),
    KindDriver("saml2", {
        "idp_entity_id": "https://idp", "idp_sso_url": "https://idp/sso",
        "idp_x509_cert": "MIIB", "sp_entity_id": "https://app",
        "sp_acs_url": "https://app/acs",
    }, _drive_saml),
    KindDriver("custom_profile", {
        "source": "cookie", "source_key": "corp_profile",
        "payload_format": "jwt", "signing_alg": "HS256",
        "shared_secret": _SECRET, "max_age_seconds": 300,
    }, _drive_custom_profile),
    KindDriver("custom", {"shared_secret": _SECRET}, _drive_custom),
    KindDriver("backchannel", {
        "token_source": "cookie", "token_source_key": "corp_session",
        "gateway_url": "https://gw.corp.example/redeem",
        "gateway_send_as": "cookie",
        "gateway_token_path": "access_token",
        "exchange_url": "https://gw.corp.example/userinfo",
    }, _drive_backchannel),
]

_IDS = [d.kind for d in DRIVERS]


def test_every_kind_has_a_driver():
    """If a kind is added, this file must grow with it — otherwise the
    matrix silently stops covering the axis it exists to cover."""
    assert {d.kind for d in DRIVERS} == idp_provider_repo.VALID_KINDS


async def _counts(db_session) -> tuple[int, int]:
    return (
        await db_session.scalar(
            select(func.count()).select_from(_models.UserORM)),
        await db_session.scalar(
            select(func.count()).select_from(_models.UserIdentityORM)),
    )


# ── The guarantees ───────────────────────────────────────────────────


@pytest.mark.asyncio
@pytest.mark.parametrize("driver", DRIVERS, ids=_IDS)
async def test_a_login_succeeds_for_every_kind(
    test_client, db_session, registry, sso_events, monkeypatch, driver,
):
    """The control. Without it, a dry-run assertion could pass simply
    because the flow was broken and wrote nothing anyway."""
    slug = f"matrix-{driver.kind}".replace("_", "-")
    await _make(db_session, driver, slug)
    before = await _counts(db_session)

    resp = await driver.drive(test_client, slug, monkeypatch, {})

    assert resp.status_code in (200, 302), resp.text
    assert "nx_access" in resp.headers.get("set-cookie", ""), (
        f"{driver.kind}: no session minted — {resp.headers.get('location')}"
    )
    assert await _counts(db_session) != before


@pytest.mark.asyncio
@pytest.mark.parametrize("driver", DRIVERS, ids=_IDS)
async def test_a_dry_run_writes_nothing_for_every_kind(
    test_client, db_session, registry, sso_events, monkeypatch, driver,
):
    """The guarantee the dry-run makes to an operator, asserted on the
    axis it was only half-delivered across."""
    slug = f"matrix-dry-{driver.kind}".replace("_", "-")
    row = await _make(db_session, driver, slug)
    before = await _counts(db_session)

    resp = await driver.drive(test_client, slug, monkeypatch, {
        "nx_dryrun": create_dryrun_token(
            admin_id="u-admin", provider_id=row.id,
        ),
    })

    assert "nx_access" not in resp.headers.get("set-cookie", ""), (
        f"{driver.kind}: a rehearsal minted a real session"
    )
    assert await _counts(db_session) == before, (
        f"{driver.kind}: a rehearsal wrote rows"
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("driver", DRIVERS, ids=_IDS)
async def test_a_failure_mints_a_reference_for_every_kind(
    test_client, db_session, registry, sso_events, monkeypatch, driver,
):
    """A user can only quote a reference they were shown, and an admin can
    only look up one that was minted. Neither works if a kind forgets."""
    import re

    slug = f"matrix-fail-{driver.kind}".replace("_", "-")
    await _make(db_session, driver, slug)

    # No credential of any kind presented -> each flow's own failure path.
    resp = await driver.drive(test_client, slug, monkeypatch, {})
    if resp.status_code == 302 and "/login?" in resp.headers.get("location", ""):
        location = resp.headers["location"]
        assert "sso_error=1" in location, driver.kind
        assert re.search(r"ref=[0-9a-f]{8}", location), driver.kind


def _set_cookies(resp) -> dict[str, str]:
    """The cookies a response sets, by name; deletions left out."""
    jar = {}
    for header in resp.headers.get_list("set-cookie"):
        name, _, rest = header.partition("=")
        value = rest.split(";", 1)[0].strip('"')
        if value:
            jar[name.strip()] = value
    return jar


def _cookie_header(**cookies: str) -> dict[str, str]:
    return {"Cookie": "; ".join(f"{k}={v}" for k, v in cookies.items())}


def _upstream_cookies(driver: KindDriver, monkeypatch) -> dict[str, str]:
    """What the browser sends with every request besides our own cookies.

    A back-channel session is re-confirmed with the gateway at every
    rotation, using the gateway's cookie, so a refresh without it reads as
    a sign-out upstream. The confirmation is stubbed at the same seam as
    the driver's sign-in.
    """
    if driver.kind != "backchannel":
        return {}
    from backend.auth_service.providers.backchannel import BackchannelProvider

    async def _still_signed_in(self, raw):
        assert raw == "ambient-xyz"

    monkeypatch.setattr(
        BackchannelProvider, "confirm_still_authenticated", _still_signed_in,
    )
    return {"corp_session": "ambient-xyz"}


def _use_the_real_sign_in_checks() -> None:
    """The real dependencies, not the conftest's stand-in user."""
    from backend.app.main import app

    for dep in (get_current_user, get_optional_user, get_permission_claims):
        app.dependency_overrides.pop(dep, None)


async def _sign_in(client, driver: KindDriver, slug: str, monkeypatch) -> dict:
    signed_in = await driver.drive(client, slug, monkeypatch, {})
    session = _set_cookies(signed_in)
    assert ACCESS_COOKIE_NAME in session, (
        f"{driver.kind}: no session minted — {signed_in.headers.get('location')}"
    )
    return session


async def _assert_the_session_works(
    client, driver: KindDriver, session: dict, monkeypatch,
    *, account_flag: bool,
) -> None:
    """An SSO session is answered like any other, before and after a
    rotation — which re-reads the account — and is never sent to the
    password change."""
    claims = decode_token(session[ACCESS_COOKIE_NAME])
    assert claims["signin"] == "sso" and "mcp" not in claims, driver.kind

    me = await client.get(
        "/api/v1/auth/me",
        headers=_cookie_header(**{ACCESS_COOKIE_NAME: session[ACCESS_COOKIE_NAME]}),
    )
    assert me.status_code == 200, me.text
    assert me.json()["passwordChangeRequired"] is False, driver.kind
    assert me.json()["user"]["mustChangePassword"] is account_flag
    works = await client.get(
        "/api/v1/users/me/activity",
        headers=_cookie_header(**{ACCESS_COOKIE_NAME: session[ACCESS_COOKIE_NAME]}),
    )
    assert works.status_code == 200, f"{driver.kind}: {works.text}"

    rotated = await client.post(
        "/api/v1/auth/refresh",
        headers=_cookie_header(**{
            REFRESH_COOKIE_NAME: session[REFRESH_COOKIE_NAME],
            **_upstream_cookies(driver, monkeypatch),
        }),
    )
    assert rotated.status_code == 200, f"{driver.kind}: {rotated.text}"
    assert rotated.json()["passwordChangeRequired"] is False, driver.kind
    renewed = _set_cookies(rotated)[ACCESS_COOKIE_NAME]
    assert decode_token(renewed)["signin"] == "sso"
    assert "mcp" not in decode_token(renewed)
    still_works = await client.get(
        "/api/v1/users/me/activity",
        headers=_cookie_header(**{ACCESS_COOKIE_NAME: renewed}),
    )
    assert still_works.status_code == 200, f"{driver.kind}: {still_works.text}"


@pytest.mark.asyncio
@pytest.mark.parametrize("driver", DRIVERS, ids=_IDS)
async def test_an_sso_only_account_works_for_every_kind(
    test_client, db_session, registry, sso_events, monkeypatch, driver,
):
    """Someone who has only ever signed in through the IdP and never had a
    local password: nothing about passwords applies to them."""
    _use_the_real_sign_in_checks()
    slug = f"matrix-sso-only-{driver.kind}".replace("_", "-")
    await _make(db_session, driver, slug)

    session = await _sign_in(test_client, driver, slug, monkeypatch)
    user = await user_repo.get_user_by_id(
        db_session, decode_token(session[ACCESS_COOKIE_NAME])["sub"],
    )
    assert not is_password_set(user.password_hash)
    assert user.must_change_password is False

    await _assert_the_session_works(
        test_client, driver, session, monkeypatch, account_flag=False,
    )
    # And there is no password to sign in with, so no session to hold.
    by_password = await test_client.post(
        "/api/v1/auth/login",
        json={"email": user.email, "password": "Aa1!" + secrets.token_urlsafe(18)},
    )
    assert by_password.status_code == 401, by_password.text


@pytest.mark.asyncio
@pytest.mark.parametrize("driver", DRIVERS, ids=_IDS)
async def test_a_pending_password_change_holds_no_kind(
    test_client, db_session, registry, sso_events, monkeypatch, driver,
):
    """Someone who signs in through the IdP nearly every day and also
    holds a local password that has to be replaced, because an
    administrator set it. The requirement is about that password, so it
    holds a session signed in with it and no session signed in through
    any kind of provider."""
    _use_the_real_sign_in_checks()
    slug = f"matrix-held-{driver.kind}".replace("_", "-")
    await _make(db_session, driver, slug)
    first = await _sign_in(test_client, driver, slug, monkeypatch)
    user_id = decode_token(first[ACCESS_COOKIE_NAME])["sub"]
    email = (await user_repo.get_user_by_id(db_session, user_id)).email

    admin_set = "Aa1!" + secrets.token_urlsafe(18)
    await user_repo.update_password(
        db_session, user_id, hash_password(admin_set), must_change=True,
    )
    await db_session.commit()

    # The control: signing in with the password is held, so the
    # requirement really is live on this account.
    by_password = await test_client.post(
        "/api/v1/auth/login", json={"email": email, "password": admin_set},
    )
    assert by_password.status_code == 200, by_password.text
    assert by_password.json()["passwordChangeRequired"] is True
    held = await test_client.get(
        "/api/v1/users/me/activity",
        headers=_cookie_header(**{
            ACCESS_COOKIE_NAME: _set_cookies(by_password)[ACCESS_COOKIE_NAME],
        }),
    )
    assert held.status_code == 403, held.text
    assert held.json()["detail"]["error"] == "password_change_required"

    session = await _sign_in(test_client, driver, slug, monkeypatch)
    assert decode_token(session[ACCESS_COOKIE_NAME])["sub"] == user_id
    await _assert_the_session_works(
        test_client, driver, session, monkeypatch, account_flag=True,
    )
