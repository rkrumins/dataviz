"""Authorization regression tests for the view read endpoints.

Three endpoints were reachable without the access checks their siblings
apply, each with a distinct consequence:

  * ``GET /views/facets``   — no auth dependency at all. The creator facet
    carries display names and **email addresses**, and the tag facet spans
    private views, so anonymous callers could enumerate the user directory.
  * ``GET /views/stats``    — ``get_optional_user`` (never raises) plus
    unrestricted filter params. ``?visibility=private&createdBy=<victim>``
    combined with ``search`` turns the counts into a substring oracle over
    private view names, descriptions and tags.
  * ``POST``/``DELETE /views/{id}/favourite`` — no access check. The
    404-vs-201 split is an existence oracle, and a caller who cannot read
    the view could still write ``favourited`` rows into its owner's
    activity timeline and inflate its ranking in the trending strip.
    ``POST /views/{id}/visit`` next door already gated correctly.

These tests pin the fix. See also ``test_api_rbac_phase2.py`` for the
evaluator-level matrix.
"""
from __future__ import annotations

import contextlib

import pytest
from fastapi import HTTPException, status
from httpx import AsyncClient

from backend.app.auth.dependencies import (
    get_current_user,
    get_optional_user,
    get_permission_claims,
)
from backend.app.db.models import UserORM, ViewORM, WorkspaceORM
from backend.app.services.permission_service import PermissionClaims


# ── helpers ──────────────────────────────────────────────────────────

async def _seed_workspace(session, *, ws_id="ws_finance", name="Finance"):
    session.add(WorkspaceORM(id=ws_id, name=name))
    await session.commit()
    return ws_id


async def _seed_view(
    session,
    *,
    view_id="view_test",
    workspace_id="ws_finance",
    visibility="private",
    created_by="usr_alice",
):
    session.add(ViewORM(
        id=view_id,
        name=view_id,
        workspace_id=workspace_id,
        visibility=visibility,
        created_by=created_by,
    ))
    await session.commit()
    return view_id


async def _seed_user(session, *, user_id="usr_alice", email="alice@example.com"):
    session.add(UserORM(
        id=user_id,
        email=email,
        password_hash="x",
        first_name="Alice",
        last_name="Alison",
        status="active",
    ))
    await session.commit()
    return user_id


@contextlib.contextmanager
def _anonymous():
    """Swap the auth deps for their real anonymous behaviour.

    The conftest ``test_client`` fixture pins every request to a system
    admin, so an "is this reachable without a session?" test has to undo
    those overrides: ``get_current_user`` and ``get_permission_claims``
    raise 401 when the cookie is absent, ``get_optional_user`` returns
    ``None``.
    """
    from backend.app.main import app

    async def _no_user():
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated",
        )

    async def _optional_none():
        return None

    def _no_claims():
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated",
        )

    prev = {
        get_current_user: app.dependency_overrides.get(get_current_user),
        get_optional_user: app.dependency_overrides.get(get_optional_user),
        get_permission_claims: app.dependency_overrides.get(get_permission_claims),
    }
    app.dependency_overrides[get_current_user] = _no_user
    app.dependency_overrides[get_optional_user] = _optional_none
    app.dependency_overrides[get_permission_claims] = _no_claims
    try:
        yield
    finally:
        for dep, original in prev.items():
            if original is None:
                app.dependency_overrides.pop(dep, None)
            else:
                app.dependency_overrides[dep] = original


@contextlib.contextmanager
def _as(user_id: str, claims: PermissionClaims):
    """Run requests as a specific principal with specific claims."""
    from backend.app.main import app

    user = type("U", (), {"id": user_id, "email": f"{user_id}@example.com"})()

    async def _user():
        return user

    def _claims():
        return claims

    prev = {
        get_current_user: app.dependency_overrides.get(get_current_user),
        get_optional_user: app.dependency_overrides.get(get_optional_user),
        get_permission_claims: app.dependency_overrides.get(get_permission_claims),
    }
    app.dependency_overrides[get_current_user] = _user
    app.dependency_overrides[get_optional_user] = _user
    app.dependency_overrides[get_permission_claims] = _claims
    try:
        yield
    finally:
        for dep, original in prev.items():
            if original is None:
                app.dependency_overrides.pop(dep, None)
            else:
                app.dependency_overrides[dep] = original


# ── /views/facets ────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_facets_rejects_anonymous(test_client: AsyncClient, db_session):
    """The creator facet leaks display names and emails — never anonymous."""
    with _anonymous():
        resp = await test_client.get("/api/v1/views/facets")
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_facets_still_works_authenticated(test_client: AsyncClient, db_session):
    await _seed_workspace(db_session)
    await _seed_view(db_session, view_id="view_facets", visibility="workspace")

    resp = await test_client.get("/api/v1/views/facets")
    assert resp.status_code == 200


# ── /views/stats ─────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_stats_rejects_anonymous(test_client: AsyncClient, db_session):
    """Unrestricted filters + counts = an oracle over private views."""
    with _anonymous():
        resp = await test_client.get(
            "/api/v1/views/stats",
            params={"visibility": "private", "createdBy": "usr_alice"},
        )
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_stats_still_works_authenticated(test_client: AsyncClient, db_session):
    await _seed_workspace(db_session)
    await _seed_view(db_session, view_id="view_stats", visibility="workspace")

    resp = await test_client.get("/api/v1/views/stats")
    assert resp.status_code == 200


# ── /views/{id}/favourite ────────────────────────────────────────────

@pytest.mark.asyncio
async def test_favourite_denied_without_read_access(
    test_client: AsyncClient, db_session,
):
    """A caller who cannot read the view cannot favourite it, and gets the
    same 404 as for a view that doesn't exist — no existence oracle."""
    await _seed_user(db_session)
    ws_id = await _seed_workspace(db_session)
    await _seed_view(
        db_session, view_id="view_secret", workspace_id=ws_id,
        visibility="private", created_by="usr_alice",
    )

    stranger = PermissionClaims(sid="sess_stranger", ws_perms={})
    with _as("usr_stranger", stranger):
        resp = await test_client.post("/api/v1/views/view_secret/favourite")
    assert resp.status_code == 404

    # Indistinguishable from a view id that was never issued.
    with _as("usr_stranger", stranger):
        missing = await test_client.post("/api/v1/views/view_does_not_exist/favourite")
    assert missing.status_code == resp.status_code


@pytest.mark.asyncio
async def test_favourite_denied_does_not_write_activity(
    test_client: AsyncClient, db_session,
):
    """The rejected favourite must leave no trace in the owner's timeline."""
    from sqlalchemy import func, select

    from backend.app.db.models import ViewActivityLogORM

    await _seed_user(db_session)
    ws_id = await _seed_workspace(db_session)
    await _seed_view(
        db_session, view_id="view_secret2", workspace_id=ws_id,
        visibility="private", created_by="usr_alice",
    )

    stranger = PermissionClaims(sid="sess_stranger", ws_perms={})
    with _as("usr_stranger", stranger):
        await test_client.post("/api/v1/views/view_secret2/favourite")

    count = (await db_session.execute(
        select(func.count()).select_from(ViewActivityLogORM)
        .where(ViewActivityLogORM.view_id == "view_secret2")
    )).scalar_one()
    assert count == 0


@pytest.mark.asyncio
async def test_favourite_allowed_with_read_access(
    test_client: AsyncClient, db_session,
):
    """The happy path still works — the gate matches ``can_read_view``."""
    ws_id = await _seed_workspace(db_session)
    await _seed_view(
        db_session, view_id="view_shared", workspace_id=ws_id,
        visibility="workspace", created_by="usr_alice",
    )

    member = PermissionClaims(
        sid="sess_member", ws_perms={ws_id: ("workspace:view:read",)},
    )
    with _as("usr_member", member):
        resp = await test_client.post("/api/v1/views/view_shared/favourite")
    assert resp.status_code == 201

    with _as("usr_member", member):
        undo = await test_client.delete("/api/v1/views/view_shared/favourite")
    assert undo.status_code == 204


@pytest.mark.asyncio
async def test_unfavourite_denied_without_read_access(
    test_client: AsyncClient, db_session,
):
    ws_id = await _seed_workspace(db_session)
    await _seed_view(
        db_session, view_id="view_secret3", workspace_id=ws_id,
        visibility="private", created_by="usr_alice",
    )

    stranger = PermissionClaims(sid="sess_stranger", ws_perms={})
    with _as("usr_stranger", stranger):
        resp = await test_client.delete("/api/v1/views/view_secret3/favourite")
    assert resp.status_code == 404
