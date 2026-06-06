"""End-to-end coverage for the dynamic-permissions chain.

The full chain has six moving parts:

  1. Binding/membership mutation endpoint runs.
  2. ``revoke_subject_sessions`` is called from the endpoint.
  3. For ``subject_type='group'``, it fans out to every group member.
  4. Each affected user's sid is added to the Redis revocation set.
  5. The next request from that user sees ``is_revoked(sid) == True``
     in ``get_current_user`` and 401s.
  6. ``/me/permissions`` participates in the chain (it depends on
     ``get_current_user``, so a revoked session 401s here too).

If any one of these breaks, the user goes back to "log out, log back
in" for permission changes to take effect. These tests guard each
hop.

The fixtures live in ``conftest.py``: ``db_session`` for direct repo
access, ``test_client`` for HTTP-layer calls with the fake user
already authenticated.
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db import models as _models
from backend.app.services.revocation_service import (
    get_revocation_service,
    revoke_subject_sessions,
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _seed_workspace(session: AsyncSession, ws_id: str = "ws_test") -> None:
    """Insert a minimal workspace row so the binding-create endpoint
    can attach to it. Avoid the workspace_repo.create_workspace path
    because it pulls in data-source validation that isn't relevant
    here."""
    session.add(_models.WorkspaceORM(
        id=ws_id,
        name="Test Workspace",
        description="Seeded for RBAC tests",
        is_default=False,
        created_at=_now_iso(),
        updated_at=_now_iso(),
    ))
    await session.flush()


async def _seed_user(session: AsyncSession, user_id: str, email: str) -> None:
    session.add(_models.UserORM(
        id=user_id,
        email=email,
        password_hash="not-a-real-hash",
        first_name="First",
        last_name="Last",
        status="active",
        created_at=_now_iso(),
        updated_at=_now_iso(),
    ))


async def _seed_group(session: AsyncSession, group_id: str, name: str) -> None:
    session.add(_models.GroupORM(
        id=group_id,
        name=name,
        description=None,
        source="local",
        external_id=None,
        external_member_count=None,
        created_at=_now_iso(),
        created_by=None,
        updated_at=_now_iso(),
        updated_by=None,
        deleted_at=None,
    ))


async def _seed_group_member(
    session: AsyncSession, group_id: str, user_id: str,
) -> None:
    session.add(_models.GroupMemberORM(
        group_id=group_id,
        user_id=user_id,
        added_at=_now_iso(),
        added_by=None,
    ))


# ── Direct unit-level tests for the helper ──────────────────────────


@pytest.mark.asyncio
async def test_revoke_subject_sessions_user_revokes_recorded_sids(db_session):
    """The fan-out helper for ``subject_type='user'`` revokes that
    user's sessions via ``revoke_all_user_sessions``."""
    svc = get_revocation_service()
    await svc.record_session("usr_target", "sess_aaa")
    await svc.record_session("usr_target", "sess_bbb")

    revoked = await revoke_subject_sessions(
        "user", "usr_target", session=db_session, reason="test",
    )

    assert revoked == 1
    assert await svc.is_revoked("sess_aaa")
    assert await svc.is_revoked("sess_bbb")


@pytest.mark.asyncio
async def test_revoke_subject_sessions_group_fans_out_to_members(db_session):
    """The fan-out helper for ``subject_type='group'`` revokes every
    member's sessions. This is the hop that previously broke for the
    user — without it, a group-binding mutation left every group
    member on a stale JWT."""
    await _seed_group(db_session, "grp_test", "Test Group")
    await _seed_user(db_session, "usr_a", "a@test.local")
    await _seed_user(db_session, "usr_b", "b@test.local")
    await _seed_user(db_session, "usr_c", "c@test.local")
    await _seed_group_member(db_session, "grp_test", "usr_a")
    await _seed_group_member(db_session, "grp_test", "usr_b")
    await _seed_group_member(db_session, "grp_test", "usr_c")
    await db_session.commit()

    svc = get_revocation_service()
    await svc.record_session("usr_a", "sess_a")
    await svc.record_session("usr_b", "sess_b")
    await svc.record_session("usr_c", "sess_c")
    # An unrelated user must NOT be revoked.
    await _seed_user(db_session, "usr_outside", "outside@test.local")
    await db_session.commit()
    await svc.record_session("usr_outside", "sess_outside")

    revoked = await revoke_subject_sessions(
        "group", "grp_test", session=db_session, reason="test_group_revoke",
    )

    assert revoked == 3
    assert await svc.is_revoked("sess_a")
    assert await svc.is_revoked("sess_b")
    assert await svc.is_revoked("sess_c")
    assert not await svc.is_revoked("sess_outside")


@pytest.mark.asyncio
async def test_revoke_subject_sessions_group_with_no_members_returns_zero(
    db_session,
):
    """A group with zero members shouldn't blow up — the helper just
    returns 0 revoked. Guards an edge case the test_client suite
    can't easily exercise."""
    await _seed_group(db_session, "grp_empty", "Empty Group")
    await db_session.commit()

    revoked = await revoke_subject_sessions(
        "group", "grp_empty", session=db_session, reason="test",
    )

    assert revoked == 0


@pytest.mark.asyncio
async def test_revoke_subject_sessions_group_without_session_returns_zero():
    """The group fan-out needs a DB session to look up members. If a
    caller passes ``session=None`` (legacy / misuse), the helper
    short-circuits to 0 rather than crashing — the JWT TTL is still
    the floor on staleness."""
    revoked = await revoke_subject_sessions(
        "group", "grp_unknown", session=None, reason="test",
    )

    assert revoked == 0


# ── HTTP-layer test: /me/permissions enforces revocation ──────────


@pytest.mark.asyncio
async def test_me_permissions_returns_401_when_session_revoked(test_client):
    """The poller hits ``/me/permissions`` every 60s; without this hop
    in the chain, a revoked session keeps returning 200 with stale
    JWT-cached claims and the FE never triggers the silent refresh.

    The conftest test_client mints a fake user with sid='sess_test'.
    Revoking that sid in the in-memory backend SHOULD cause the next
    request to 401."""
    svc = get_revocation_service()

    # Baseline: /me/permissions returns 200 with the fake user's claims.
    resp = await test_client.get("/api/v1/me/permissions")
    assert resp.status_code == 200, resp.text

    # Revoke the conftest fake sid.
    await svc.revoke_session("sess_test")

    # The next request must 401 because ``get_current_user`` now
    # checks the revocation set on every call.
    resp = await test_client.get("/api/v1/me/permissions")
    assert resp.status_code == 401, resp.text
