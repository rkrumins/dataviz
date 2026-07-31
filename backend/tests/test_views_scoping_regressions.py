"""Leak regressions for the /views/* read surface (view-sharing rework).

Each test here pins a specific hole found in the 2026-07-31 audit:

  * ``GET /views/facets`` had NO auth dependency — private view tags and
    creator identities were readable unauthenticated.
  * ``GET /views/stats`` counted views the caller can't read.
  * ``GET /views/popular`` leaked workspace-tier views cross-workspace.
  * ``GET /views/`` post-filtered in Python — ``total``/``hasMore`` lied.
  * ``POST /views/{id}/favourite`` had no access check at all.
  * ``GET /views/me/recent`` returned views the visitor can no longer read.
  * ``PUT /views/{id}`` accepted ``visibility`` in the body, bypassing
    the publish gate on the dedicated endpoint.
  * ``POST /views/`` with a bogus visibility hit the DB CHECK → 500.
  * ``POST /views/{id}/visit`` on a soft-deleted view still worked.

Identity plumbing follows test_rbac_endpoint_coverage: override the
auth dependencies per-request; views routes read ``get_optional_user``,
so that override is included too.
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
from backend.app.db.models import ViewORM, WorkspaceORM
from backend.app.db.repositories import grant_repo, view_repo
from backend.app.services.permission_service import PermissionClaims
from backend.auth_service.interface import User


WS_A = "ws_alpha"
WS_B = "ws_beta"

_MEMBER_LEAVES = (
    "workspace:view:create", "workspace:view:edit",
    "workspace:view:delete", "workspace:view:read",
    "workspace:datasource:*",
)


def _user(user_id: str) -> User:
    return User(
        id=user_id,
        email=f"{user_id}@example.com",
        first_name="T",
        last_name="U",
        role="user",
        status="active",
        created_at="2024-01-01T00:00:00Z",
        updated_at="2024-01-01T00:00:00Z",
    )


ALICE = _user("usr_alice")     # creator in ws_a
BOB = _user("usr_bob")         # member of ws_a only
MALLORY = _user("usr_mallory")  # no bindings at all

ALICE_CLAIMS = PermissionClaims(sid="s_alice", ws_perms={WS_A: _MEMBER_LEAVES})
BOB_CLAIMS = PermissionClaims(sid="s_bob", ws_perms={WS_A: _MEMBER_LEAVES})
EMPTY_CLAIMS = PermissionClaims(sid="s_empty")


@contextlib.contextmanager
def _auth(*, user, claims):
    """Override ALL auth deps (views routes use get_optional_user)."""
    from backend.app.main import app

    async def _ovr_current():
        if user is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Not authenticated",
            )
        return user

    async def _ovr_optional():
        return user

    def _ovr_claims():
        if user is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Not authenticated",
            )
        return claims

    prev = {
        get_current_user: app.dependency_overrides.get(get_current_user),
        get_optional_user: app.dependency_overrides.get(get_optional_user),
        get_permission_claims: app.dependency_overrides.get(get_permission_claims),
    }
    app.dependency_overrides[get_current_user] = _ovr_current
    app.dependency_overrides[get_optional_user] = _ovr_optional
    app.dependency_overrides[get_permission_claims] = _ovr_claims
    try:
        yield
    finally:
        for dep, fn in prev.items():
            app.dependency_overrides[dep] = fn


async def _seed(db_session):
    """ws_a: alice's private (tag 'secret') + workspace + enterprise;
    ws_b: carol's workspace-tier view. Returns the four ids."""
    db_session.add(WorkspaceORM(id=WS_A, name="Alpha"))
    db_session.add(WorkspaceORM(id=WS_B, name="Beta"))
    rows = {
        "private_a": ViewORM(
            id="view_private_a", name="alice-private", workspace_id=WS_A,
            visibility="private", created_by=ALICE.id, tags='["secret"]',
        ),
        "workspace_a": ViewORM(
            id="view_workspace_a", name="alpha-team", workspace_id=WS_A,
            visibility="workspace", created_by=ALICE.id,
        ),
        "enterprise_a": ViewORM(
            id="view_enterprise_a", name="alpha-public", workspace_id=WS_A,
            visibility="enterprise", created_by=ALICE.id,
        ),
        "workspace_b": ViewORM(
            id="view_workspace_b", name="beta-team", workspace_id=WS_B,
            visibility="workspace", created_by="usr_carol",
        ),
    }
    for row in rows.values():
        db_session.add(row)
    await db_session.commit()
    return {k: v.id for k, v in rows.items()}


# ── facets ───────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_facets_unauthenticated_401(test_client: AsyncClient, db_session):
    await _seed(db_session)
    with _auth(user=None, claims=None):
        r = await test_client.get("/api/v1/views/facets")
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_facets_scoped_to_principal(test_client: AsyncClient, db_session):
    await _seed(db_session)
    # A stranger sees no trace of alice's private view.
    with _auth(user=MALLORY, claims=EMPTY_CLAIMS):
        r = await test_client.get("/api/v1/views/facets")
    assert r.status_code == 200
    body = r.json()
    assert all(t["value"] != "secret" for t in body["tags"])
    # Carol only authored the unreadable ws_b view → absent entirely.
    assert all(c["userId"] != "usr_carol" for c in body["creators"])
    # The creator herself still sees her own tag.
    with _auth(user=ALICE, claims=ALICE_CLAIMS):
        r2 = await test_client.get("/api/v1/views/facets")
    assert any(t["value"] == "secret" for t in r2.json()["tags"])


# ── stats ────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_stats_unauthenticated_401(test_client: AsyncClient, db_session):
    await _seed(db_session)
    with _auth(user=None, claims=None):
        r = await test_client.get("/api/v1/views/stats")
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_stats_totals_match_list_totals(test_client: AsyncClient, db_session):
    await _seed(db_session)
    with _auth(user=BOB, claims=BOB_CLAIMS):
        stats = await test_client.get("/api/v1/views/stats")
        listed = await test_client.get("/api/v1/views/")
    assert stats.status_code == 200 and listed.status_code == 200
    # bob reads ws_a workspace + enterprise only.
    assert listed.json()["total"] == 2
    assert stats.json()["total"] == 2


# ── popular ──────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_popular_unauthenticated_401(test_client: AsyncClient, db_session):
    await _seed(db_session)
    with _auth(user=None, claims=None):
        r = await test_client.get("/api/v1/views/popular")
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_popular_excludes_foreign_workspace_tier(
    test_client: AsyncClient, db_session,
):
    ids = await _seed(db_session)
    for vid in ids.values():
        await view_repo.favourite_view(db_session, vid, "usr_fan")
    await db_session.commit()
    with _auth(user=BOB, claims=BOB_CLAIMS):
        r = await test_client.get("/api/v1/views/popular")
    assert r.status_code == 200
    got = {v["id"] for v in r.json()}
    assert ids["workspace_b"] not in got, "cross-workspace leak"
    assert ids["private_a"] not in got
    assert got == {ids["workspace_a"], ids["enterprise_a"]}


# ── list pagination honesty ──────────────────────────────────────────

@pytest.mark.asyncio
async def test_list_pagination_totals_after_scoping(
    test_client: AsyncClient, db_session,
):
    await _seed(db_session)
    with _auth(user=BOB, claims=BOB_CLAIMS):
        page = await test_client.get("/api/v1/views/", params={"limit": 1})
    body = page.json()
    assert body["total"] == 2
    assert body["hasMore"] is True
    assert len(body["items"]) == 1
    with _auth(user=BOB, claims=BOB_CLAIMS):
        page2 = await test_client.get(
            "/api/v1/views/", params={"limit": 1, "offset": 1},
        )
    body2 = page2.json()
    assert body2["hasMore"] is False
    assert len(body2["items"]) == 1


@pytest.mark.asyncio
async def test_list_embedded_popular_is_scoped(
    test_client: AsyncClient, db_session,
):
    ids = await _seed(db_session)
    for vid in ids.values():
        await view_repo.favourite_view(db_session, vid, "usr_fan")
    await db_session.commit()
    with _auth(user=BOB, claims=BOB_CLAIMS):
        r = await test_client.get(
            "/api/v1/views/", params={"include": "popular"},
        )
    popular_ids = {v["id"] for v in (r.json().get("popular") or [])}
    assert ids["workspace_b"] not in popular_ids
    assert ids["private_a"] not in popular_ids


# ── favourite ────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_favourite_unreadable_view_404(
    test_client: AsyncClient, db_session,
):
    ids = await _seed(db_session)
    with _auth(user=MALLORY, claims=EMPTY_CLAIMS):
        r = await test_client.post(f"/api/v1/views/{ids['private_a']}/favourite")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_favourite_unauthenticated_401(
    test_client: AsyncClient, db_session,
):
    ids = await _seed(db_session)
    with _auth(user=None, claims=None):
        r = await test_client.post(f"/api/v1/views/{ids['enterprise_a']}/favourite")
    assert r.status_code == 401


# ── recents ──────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_recent_drops_views_no_longer_readable(
    test_client: AsyncClient, db_session,
):
    ids = await _seed(db_session)
    # Mallory visited the enterprise view while it was public…
    await view_repo.record_view_visit(db_session, ids["enterprise_a"], MALLORY.id)
    await view_repo.record_view_visit(db_session, ids["workspace_a"], MALLORY.id)
    await db_session.commit()
    # …then it went private.
    await view_repo.update_visibility(db_session, ids["enterprise_a"], "private")
    await db_session.commit()
    with _auth(user=MALLORY, claims=EMPTY_CLAIMS):
        r = await test_client.get("/api/v1/views/me/recent")
    assert r.status_code == 200
    assert [e["viewId"] for e in r.json()] == []


# ── mutation-path hardening ──────────────────────────────────────────

@pytest.mark.asyncio
async def test_generic_put_rejects_visibility(
    test_client: AsyncClient, db_session,
):
    ids = await _seed(db_session)
    with _auth(user=ALICE, claims=ALICE_CLAIMS):
        r = await test_client.put(
            f"/api/v1/views/{ids['private_a']}",
            json={"visibility": "enterprise"},
        )
    assert r.status_code == 422
    row = await db_session.get(ViewORM, ids["private_a"])
    await db_session.refresh(row)
    assert row.visibility == "private", "PUT must not write visibility"


@pytest.mark.asyncio
async def test_create_with_bogus_visibility_422(
    test_client: AsyncClient, db_session,
):
    await _seed(db_session)
    with _auth(user=ALICE, claims=ALICE_CLAIMS):
        r = await test_client.post(
            "/api/v1/views/",
            json={
                "name": "x", "workspaceId": WS_A,
                "viewType": "graph", "visibility": "everyone",
            },
        )
    assert r.status_code == 422


# ── deleted views ────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_visit_on_soft_deleted_view_404(
    test_client: AsyncClient, db_session,
):
    ids = await _seed(db_session)
    await view_repo.delete_view(db_session, ids["workspace_a"])
    await db_session.commit()
    with _auth(user=BOB, claims=BOB_CLAIMS):
        r = await test_client.post(f"/api/v1/views/{ids['workspace_a']}/visit")
    assert r.status_code == 404


# ── shared-with-me category ──────────────────────────────────────────

@pytest.mark.asyncio
async def test_shared_with_me_category(test_client: AsyncClient, db_session):
    ids = await _seed(db_session)
    # Carol's ws_b workspace view is shared with mallory explicitly.
    await grant_repo.create_grant(
        db_session, resource_type="view", resource_id=ids["workspace_b"],
        subject_type="user", subject_id=MALLORY.id, role_name="viewer",
    )
    await db_session.commit()
    with _auth(user=MALLORY, claims=EMPTY_CLAIMS):
        r = await test_client.get(
            "/api/v1/views/", params={"category": "shared-with-me"},
        )
    assert r.status_code == 200
    body = r.json()
    assert {v["id"] for v in body["items"]} == {ids["workspace_b"]}
    assert body["total"] == 1
