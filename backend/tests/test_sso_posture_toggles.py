"""The platform posture switches, end to end through the API.

Two regressions pinned here:

* ``emailFirstLogin`` was toggleable, persisted, and displayed — and
  inert. The runtime snapshot builder in ``app/main.py`` never copied
  the field across, so the dataclass default (False) always won and the
  login page never led with email while the admin page said it would.
  The only honest test is the round trip: PATCH the switch, read the
  login page's own context.

* The lockout guard computes its target posture by merging the PATCH
  with the stored row, so disabling both login modes is refused whether
  it is attempted in one call or sequentially. The docstrings used to
  claim only the simultaneous case was blocked; these tests pin that
  both orders are.
"""
import dataclasses
import re
from contextlib import asynccontextmanager
from pathlib import Path

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db import models as m
from backend.app.db.repositories import (
    app_auth_config_repo,
    user_repo as _user_repo,
)
from backend.app.db.repositories.refresh_token_repo import make_refresh_store
from backend.auth_service.app_auth_config import (
    AuthConfigSnapshot,
    CachedAuthConfigProvider,
)
from backend.auth_service.service import LocalIdentityService

CONFIG = "/api/v1/admin/sso/config"
LOGIN_CONTEXT = "/api/v1/auth/login-context"


@pytest.fixture()
def posture_wired(db_session):
    """Install an identity service whose posture provider actually reads
    the config row, the way ``app/main.py`` wires production.

    The conftest default service uses the static permissive provider, so
    no route-level test could ever observe a posture toggle — which is
    precisely how the dropped ``email_first_login`` field stayed
    invisible. This fixture is the missing observer.
    """
    from backend.app.main import app

    @asynccontextmanager
    async def _factory():
        yield db_session

    async def _load() -> AuthConfigSnapshot:
        return await app_auth_config_repo.get_snapshot(db_session)

    previous = getattr(app.state, "identity_service", None)
    app.state.identity_service = LocalIdentityService(
        session_factory=_factory,
        user_repo=_user_repo,
        refresh_store_factory=make_refresh_store,
        auth_config_provider=CachedAuthConfigProvider(_load),
    )
    yield
    app.state.identity_service = previous


async def _seed_sso_admin(session: AsyncSession) -> None:
    """An active super-admin with a linked SSO identity, so disabling
    local login clears the would-lock-out-admin guard."""
    session.add(m.UserORM(
        id="usr_sso_admin", email="sso-admin@example.com", password_hash="x",
        first_name="A", last_name="Dmin", status="active",
        created_at="2024-01-01T00:00:00Z", updated_at="2024-01-01T00:00:00Z",
    ))
    session.add(m.RoleBindingORM(
        id="bnd_usr_sso_admin", subject_type="user", subject_id="usr_sso_admin",
        role_name="super_admin", scope_type="global", scope_id=None,
        granted_at="2024-01-01T00:00:00Z", source="local",
    ))
    session.add(m.IdpProviderORM(
        id="idp_toggle01", slug="entra", display_name="Entra",
        kind="oidc", enabled=True,
    ))
    session.add(m.UserIdentityORM(
        id="uid_usr_sso_admin", user_id="usr_sso_admin",
        provider_id="idp_toggle01", external_id="ext_usr_sso_admin",
        email_at_link="sso-admin@example.com",
    ))
    await session.commit()


# ── emailFirstLogin actually reaches the login page ──────────────────

def test_the_runtime_snapshot_builder_names_every_posture_field():
    """The seam that broke: ``app/main.py`` copies the repo snapshot
    into the runtime dataclass field by field, so a field added to the
    dataclass but not to that constructor silently runs on its default
    forever — toggleable, persisted, displayed, inert. Assert every
    dataclass field is named in the builder, so the next addition fails
    here instead of in production."""
    source = (
        Path(__file__).resolve().parents[1] / "app" / "main.py"
    ).read_text()
    start = source.index("async def _load_auth_config")
    builder = source[start:start + 1200]
    for f in dataclasses.fields(AuthConfigSnapshot):
        assert re.search(rf"\b{f.name}\s*=", builder), (
            f"AuthConfigSnapshot.{f.name} is not set by _load_auth_config "
            f"— the admin toggle for it would be silently inert at runtime"
        )


@pytest.mark.asyncio
async def test_email_first_login_round_trips_to_the_login_context(
    test_client: AsyncClient, db_session: AsyncSession, posture_wired,
):
    before = await test_client.get(LOGIN_CONTEXT)
    assert before.status_code == 200
    assert before.json()["emailFirstLogin"] is False

    flipped = await test_client.patch(CONFIG, json={"emailFirstLogin": True})
    assert flipped.status_code == 200, flipped.text
    assert flipped.json()["emailFirstLogin"] is True

    # The PATCH invalidates the posture cache, so the anonymous login
    # surface must answer with the new value immediately — not after a
    # TTL, and not never, which is what the dropped field produced.
    after = await test_client.get(LOGIN_CONTEXT)
    assert after.json()["emailFirstLogin"] is True


# ── the lockout guard holds in both orders ───────────────────────────

@pytest.mark.asyncio
async def test_disabling_both_modes_in_one_patch_is_refused(
    test_client: AsyncClient, db_session: AsyncSession,
):
    await _seed_sso_admin(db_session)
    resp = await test_client.patch(
        CONFIG, json={"ssoEnabled": False, "allowLocalLogin": False},
    )
    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"]["error"] == "both_login_modes_disabled"


@pytest.mark.asyncio
async def test_the_sequential_order_is_refused_too(
    test_client: AsyncClient, db_session: AsyncSession,
):
    """Local login off first (allowed — the admin has SSO), then the
    master switch. The guard computes the target against the stored
    row, so the second call must hit the same 409 the one-call shape
    does — a platform with no way in is never one PATCH away."""
    await _seed_sso_admin(db_session)

    first = await test_client.patch(CONFIG, json={"allowLocalLogin": False})
    assert first.status_code == 200, first.text

    second = await test_client.patch(CONFIG, json={"ssoEnabled": False})
    assert second.status_code == 409, second.text
    assert second.json()["detail"]["error"] == "both_login_modes_disabled"


@pytest.mark.asyncio
async def test_the_other_sequential_order_is_refused_as_well(
    test_client: AsyncClient, db_session: AsyncSession,
):
    resp = await test_client.patch(CONFIG, json={"ssoEnabled": False})
    assert resp.status_code == 200, resp.text

    blocked = await test_client.patch(CONFIG, json={"allowLocalLogin": False})
    assert blocked.status_code == 409, blocked.text
    assert blocked.json()["detail"]["error"] == "both_login_modes_disabled"
