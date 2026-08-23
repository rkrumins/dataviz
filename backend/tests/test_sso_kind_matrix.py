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

import time
from dataclasses import dataclass
from typing import Callable

import jwt as pyjwt
import pytest
from sqlalchemy import func, select

from backend.app.db import models as _models
from backend.app.db.repositories import idp_provider_repo
from backend.auth_service.core.tokens import (
    create_dryrun_token,
    create_oidc_state_token,
    create_saml_state_token,
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

    async def _fetch(self, *, host, https, path, post_data):
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
