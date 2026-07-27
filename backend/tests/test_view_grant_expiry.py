"""Time-bound view shares.

Role bindings have been expirable since Phase 7 — ISO ``expiresAt``, an
``expiresIn`` duration shortcut, a duration picker in the members UI, and
a countdown badge. ``resource_grants`` had none of it, so every view ever
shared with a person or group was shared permanently: the one access path
on the platform that could not lapse.

Expiry is filtered in ``grant_repo.list_grants_for_user_with_groups``,
which is the only path the access evaluator consults, so a lapsed share
cannot be honoured by any caller that forgets to check.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from backend.app.db.models import (
    ResourceGrantORM,
    UserORM,
    ViewORM,
    WorkspaceORM,
)
from backend.app.db.repositories import grant_repo
from backend.app.services import view_access
from tests.common.view_scopes import viewer_context

WS = "ws_finance"


def _iso(delta: timedelta) -> str:
    return (datetime.now(timezone.utc) + delta).isoformat()


async def _seed(session):
    session.add(WorkspaceORM(id=WS, name="Finance"))
    session.add(UserORM(
        id="usr_friend", email="friend@example.com", password_hash="x",
        first_name="F", last_name="R", status="active",
    ))
    session.add(ViewORM(
        id="view_x", name="Secret", workspace_id=WS,
        visibility="private", created_by="usr_owner",
    ))
    await session.commit()


# ── the repo drops lapsed grants ─────────────────────────────────────

@pytest.mark.asyncio
async def test_an_unexpired_grant_still_confers_read(db_session):
    await _seed(db_session)
    await grant_repo.create_grant(
        db_session, resource_type="view", resource_id="view_x",
        subject_type="user", subject_id="usr_friend", role_name="viewer",
        expires_at=_iso(timedelta(days=1)),
    )
    await db_session.commit()

    view = (await db_session.execute(
        select(ViewORM).where(ViewORM.id == "view_x")
    )).scalar_one()
    ctx = viewer_context(user_id="usr_friend")
    decision = await view_access.read_decision(db_session, ctx, view)
    assert decision.allowed
    assert decision.reason == "grant"


@pytest.mark.asyncio
async def test_an_expired_grant_confers_nothing(db_session):
    await _seed(db_session)
    await grant_repo.create_grant(
        db_session, resource_type="view", resource_id="view_x",
        subject_type="user", subject_id="usr_friend", role_name="viewer",
        expires_at=_iso(timedelta(days=-1)),
    )
    await db_session.commit()

    view = (await db_session.execute(
        select(ViewORM).where(ViewORM.id == "view_x")
    )).scalar_one()
    ctx = viewer_context(user_id="usr_friend")
    assert not (await view_access.read_decision(db_session, ctx, view)).allowed


@pytest.mark.asyncio
async def test_an_expired_grant_is_excluded_from_the_read_scope(db_session):
    """The SQL side must agree — otherwise the list would still show it."""
    await _seed(db_session)
    await grant_repo.create_grant(
        db_session, resource_type="view", resource_id="view_x",
        subject_type="user", subject_id="usr_friend", role_name="viewer",
        expires_at=_iso(timedelta(hours=-1)),
    )
    await db_session.commit()

    ctx = viewer_context(user_id="usr_friend")
    scope = await view_access.build_read_scope(db_session, ctx)
    assert scope.grant_view_ids == ()


@pytest.mark.asyncio
async def test_a_grant_with_no_expiry_is_permanent(db_session):
    """The existing behaviour, unchanged — NULL means never lapses."""
    await _seed(db_session)
    await grant_repo.create_grant(
        db_session, resource_type="view", resource_id="view_x",
        subject_type="user", subject_id="usr_friend", role_name="viewer",
    )
    await db_session.commit()

    ctx = viewer_context(user_id="usr_friend")
    scope = await view_access.build_read_scope(db_session, ctx)
    assert scope.grant_view_ids == ("view_x",)


@pytest.mark.asyncio
async def test_a_malformed_expiry_does_not_revoke(db_session):
    """Fail-open on an unparseable timestamp, matching ``is_expired``'s
    documented behaviour for bindings: a bad write must not silently strip
    access someone legitimately has."""
    await _seed(db_session)
    await grant_repo.create_grant(
        db_session, resource_type="view", resource_id="view_x",
        subject_type="user", subject_id="usr_friend", role_name="viewer",
        expires_at="not-a-timestamp",
    )
    await db_session.commit()

    ctx = viewer_context(user_id="usr_friend")
    scope = await view_access.build_read_scope(db_session, ctx)
    assert scope.grant_view_ids == ("view_x",)


# ── the API accepts both expiry forms ────────────────────────────────

@pytest.mark.asyncio
async def test_share_with_an_iso_expiry(test_client: AsyncClient, db_session):
    await _seed(db_session)
    expiry = _iso(timedelta(days=7))
    resp = await test_client.post(
        "/api/v1/views/view_x/grants",
        json={
            "subjectType": "user", "subjectId": "usr_friend",
            "role": "viewer", "expiresAt": expiry,
        },
    )
    assert resp.status_code == 201
    assert resp.json()["expiresAt"] == expiry


@pytest.mark.asyncio
async def test_share_with_a_duration_shortcut(
    test_client: AsyncClient, db_session,
):
    """``expiresIn`` mirrors the workspace-members API, so the same
    duration picker works for both."""
    await _seed(db_session)
    resp = await test_client.post(
        "/api/v1/views/view_x/grants",
        json={
            "subjectType": "user", "subjectId": "usr_friend",
            "role": "viewer", "expiresIn": "7d",
        },
    )
    assert resp.status_code == 201
    assert resp.json()["expiresAt"] is not None

    stored = (await db_session.execute(
        select(ResourceGrantORM).where(ResourceGrantORM.resource_id == "view_x")
    )).scalar_one()
    assert stored.expires_at is not None


@pytest.mark.asyncio
async def test_both_expiry_forms_at_once_is_rejected(
    test_client: AsyncClient, db_session,
):
    await _seed(db_session)
    resp = await test_client.post(
        "/api/v1/views/view_x/grants",
        json={
            "subjectType": "user", "subjectId": "usr_friend",
            "role": "viewer",
            "expiresAt": _iso(timedelta(days=1)), "expiresIn": "7d",
        },
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_a_duration_over_the_cap_is_rejected(
    test_client: AsyncClient, db_session,
):
    """Same 365-day cap as bindings — a permanent share omits the field
    rather than abusing the shortcut."""
    await _seed(db_session)
    resp = await test_client.post(
        "/api/v1/views/view_x/grants",
        json={
            "subjectType": "user", "subjectId": "usr_friend",
            "role": "viewer", "expiresIn": "500d",
        },
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_sharing_without_expiry_still_works(
    test_client: AsyncClient, db_session,
):
    """Permanent remains the default; the field is opt-in."""
    await _seed(db_session)
    resp = await test_client.post(
        "/api/v1/views/view_x/grants",
        json={"subjectType": "user", "subjectId": "usr_friend", "role": "viewer"},
    )
    assert resp.status_code == 201
    assert resp.json()["expiresAt"] is None
