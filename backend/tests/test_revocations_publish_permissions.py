"""Every sweep that ends a user's sessions says so on their permissions topic.

``revoke_subject_sessions`` always did: a user or group revocation bumps
``perms:{user}`` after the commit, so that user's open tabs re-read their
claims. The other three sweeps ended the same sessions without a word: a
role's permissions changing, one identity provider's sessions ending, and
the platform-wide sign-out. With only the periodic check that cost little,
because the next check answered 401 and the refresh re-read the claims.
With live push on, it was the difference between a second and a whole
check interval.
"""
from __future__ import annotations

import asyncio
import time
from datetime import datetime, timezone

import pytest

from backend.app.changes import publish as publish_mod
from backend.app.changes import topics as change_topics
from backend.app.changes.registry import InMemoryChangeRegistry
from backend.app.db import models as m
from backend.app.db.repositories import binding_repo, group_repo
from backend.app.db.repositories.refresh_token_repo import make_refresh_store
from backend.app.services.revocation_service import (
    InMemoryBackend,
    RevocationService,
    configure_revocation_service,
    revoke_platform_sessions,
    revoke_provider_sessions,
    revoke_role_sessions,
)
from backend.auth_service.core import tokens as token_module

PROVIDER = "idp_corp_x"


@pytest.fixture(autouse=True)
def _fresh_revocation_service():
    configure_revocation_service(RevocationService(InMemoryBackend()))


@pytest.fixture
def registry(monkeypatch):
    reg = InMemoryChangeRegistry()
    monkeypatch.setattr(publish_mod, "get_registry", lambda: reg)
    return reg


async def _seed_user(session, user_id: str) -> str:
    session.add(m.UserORM(
        id=user_id, email=f"{user_id}@example.com", password_hash="x",
        first_name="U", last_name="Ser", status="active",
        created_at="2024-01-01T00:00:00Z", updated_at="2024-01-01T00:00:00Z",
    ))
    await session.flush()
    return user_id


async def _mint(session, *, user_id: str, provider_id: str | None) -> None:
    auth_time = int(time.time()) - 60 if provider_id else None
    _, claims = token_module.create_refresh_token(user_id=user_id, auth_time=auth_time)
    await make_refresh_store(session).record_mint(
        jti=claims.jti, family_id=claims.family_id, user_id=user_id,
        auth_time=auth_time, mint_ms=claims.mint_ms,
        expires_at_iso="2099-01-01T00:00:00+00:00",
        idp_provider_id=provider_id,
        idp_checked_at=int(time.time()) if provider_id else None,
    )


async def _commit(session) -> None:
    """Publishing waits for the commit, and then for the scheduled bumps."""
    await session.commit()
    for _ in range(5):
        await asyncio.sleep(0)


async def _moved(registry, *user_ids: str) -> dict[str, int]:
    versions = await registry.snapshot(
        [change_topics.permissions_for(uid) for uid in user_ids]
    )
    return {uid: versions[change_topics.permissions_for(uid)] for uid in user_ids}


@pytest.mark.asyncio
async def test_a_role_change_tells_every_user_who_holds_the_role(db_session, registry):
    direct = await _seed_user(db_session, "usr_direct")
    via_group = await _seed_user(db_session, "usr_via_group")
    bystander = await _seed_user(db_session, "usr_bystander")
    now = datetime.now(timezone.utc).isoformat()
    db_session.add(m.RoleORM(
        name="acme_auditor", description="test role", scope_type="global",
        scope_id=None, is_system=False, created_at=now, updated_at=now,
        created_by=None,
    ))
    group = await group_repo.create_group(db_session, name="auditors")
    db_session.add(m.GroupMemberORM(group_id=group.id, user_id=via_group))
    await db_session.flush()
    for subject_type, subject_id in (("user", direct), ("group", group.id)):
        await binding_repo.create_binding(
            db_session, subject_type=subject_type, subject_id=subject_id,
            role_name="acme_auditor", scope_type="workspace", scope_id="ws_x",
        )

    assert await revoke_role_sessions("acme_auditor", session=db_session) == 2
    await _commit(db_session)

    assert await _moved(registry, direct, via_group, bystander) == {
        direct: 1, via_group: 1, bystander: 0,
    }


@pytest.mark.asyncio
async def test_ending_a_providers_sessions_tells_the_people_it_signed_in(
    db_session, registry,
):
    sso = await _seed_user(db_session, "usr_sso")
    password_only = await _seed_user(db_session, "usr_password")
    await _mint(db_session, user_id=sso, provider_id=PROVIDER)
    await _mint(db_session, user_id=password_only, provider_id=None)

    await revoke_provider_sessions(PROVIDER, session=db_session, reason="test")
    await _commit(db_session)

    assert await _moved(registry, sso, password_only) == {sso: 1, password_only: 0}


@pytest.mark.asyncio
async def test_the_platform_sign_out_tells_everyone_but_system_accounts(
    db_session, registry,
):
    from backend.app.db.repositories import user_repo

    person = await _seed_user(db_session, "usr_person")
    system = await _seed_user(db_session, "usr_system")
    await user_repo.set_system_account(db_session, system, True)
    await _mint(db_session, user_id=person, provider_id=None)
    await _mint(db_session, user_id=system, provider_id=None)

    await revoke_platform_sessions(session=db_session, reason="test")
    await _commit(db_session)

    assert await _moved(registry, person, system) == {person: 1, system: 0}


@pytest.mark.asyncio
async def test_nothing_is_said_before_the_commit(db_session, registry):
    """Announcing first would send tabs to re-read claims that have not
    changed yet, and having recorded the new version they would not ask
    again."""
    sso = await _seed_user(db_session, "usr_sso_early")
    await _mint(db_session, user_id=sso, provider_id=PROVIDER)

    await revoke_provider_sessions(PROVIDER, session=db_session, reason="test")
    for _ in range(5):
        await asyncio.sleep(0)

    assert await _moved(registry, sso) == {sso: 0}
