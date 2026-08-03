"""Share-flow support endpoints: the people/group directory and grant
role editing.

``GET /api/v1/directory`` exists because the share dialog's picker used
an ADMIN-ONLY user listing — a creator without admin rights saw an
empty picker. The directory is available to any signed-in user, serves
active users and groups only, and is search-driven.

``PUT /views/{id}/grants/{grant_id}`` closes the "can add and remove
but not change" gap — editing a grantee's role no longer requires
revoke + re-share.
"""
from __future__ import annotations

import pytest
from httpx import AsyncClient

from backend.app.db.models import GroupMemberORM, UserORM, ViewORM, WorkspaceORM
from backend.app.db.repositories import grant_repo, group_repo
from backend.app.services.permission_service import PermissionClaims
from backend.tests.test_views_scoping_regressions import _auth, _user


CALLER = _user("usr_dir_caller")
EMPTY_CLAIMS = PermissionClaims(sid="s_dir")


async def _seed_people(db_session):
    db_session.add(UserORM(
        id="usr_ada", email="ada@example.com", password_hash="x",
        first_name="Ada", last_name="Lovelace", status="active",
    ))
    db_session.add(UserORM(
        id="usr_alan", email="alan@example.com", password_hash="x",
        first_name="Alan", last_name="Turing", status="active",
    ))
    db_session.add(UserORM(
        id="usr_gone", email="ada.retired@example.com", password_hash="x",
        first_name="Ada", last_name="Retired", status="suspended",
    ))
    group = await group_repo.create_group(db_session, name="Analytics Team")
    db_session.add(GroupMemberORM(group_id=group.id, user_id="usr_ada"))
    await db_session.commit()
    return group.id


# ── directory ────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_directory_requires_auth(test_client: AsyncClient, db_session):
    await _seed_people(db_session)
    with _auth(user=None, claims=None):
        r = await test_client.get("/api/v1/directory", params={"q": "ada"})
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_directory_open_to_any_signed_in_user(
    test_client: AsyncClient, db_session,
):
    await _seed_people(db_session)
    with _auth(user=CALLER, claims=EMPTY_CLAIMS):
        r = await test_client.get("/api/v1/directory", params={"q": "ada"})
    assert r.status_code == 200
    body = r.json()
    ids = {u["id"] for u in body["users"]}
    assert "usr_ada" in ids
    # Suspended users never surface in the picker.
    assert "usr_gone" not in ids
    ada = next(u for u in body["users"] if u["id"] == "usr_ada")
    assert ada["displayName"] == "Ada Lovelace"
    assert ada["email"] == "ada@example.com"


@pytest.mark.asyncio
async def test_directory_matches_groups(test_client: AsyncClient, db_session):
    group_id = await _seed_people(db_session)
    with _auth(user=CALLER, claims=EMPTY_CLAIMS):
        r = await test_client.get("/api/v1/directory", params={"q": "analytics"})
    body = r.json()
    assert [g["id"] for g in body["groups"]] == [group_id]
    assert body["groups"][0]["name"] == "Analytics Team"
    assert body["groups"][0]["memberCount"] == 1


@pytest.mark.asyncio
async def test_directory_types_filter_and_limit(
    test_client: AsyncClient, db_session,
):
    await _seed_people(db_session)
    with _auth(user=CALLER, claims=EMPTY_CLAIMS):
        users_only = await test_client.get(
            "/api/v1/directory", params={"q": "a", "types": "user", "limit": 1},
        )
    body = users_only.json()
    assert body["groups"] == []
    assert len(body["users"]) == 1


# ── grant role editing ───────────────────────────────────────────────

WS = "ws_grantrole"
CREATOR = _user("usr_gr_creator")


async def _seed_granted_view(db_session, *, view_id="view_gr"):
    if (await db_session.get(WorkspaceORM, WS)) is None:
        db_session.add(WorkspaceORM(id=WS, name="Grant Role WS"))
    db_session.add(ViewORM(
        id=view_id, name=view_id, workspace_id=WS,
        visibility="private", created_by=CREATOR.id,
    ))
    if (await db_session.get(UserORM, "usr_grantee_gr")) is None:
        db_session.add(UserORM(
            id="usr_grantee_gr", email="grantee@example.com", password_hash="x",
            first_name="Grae", last_name="Ntee", status="active",
        ))
    await db_session.commit()
    grant = await grant_repo.create_grant(
        db_session, resource_type="view", resource_id=view_id,
        subject_type="user", subject_id="usr_grantee_gr", role_name="viewer",
        granted_by=CREATOR.id,
    )
    await db_session.commit()
    return view_id, grant.id


@pytest.mark.asyncio
async def test_creator_edits_grant_role(test_client: AsyncClient, db_session):
    view_id, grant_id = await _seed_granted_view(db_session)
    with _auth(user=CREATOR, claims=EMPTY_CLAIMS):
        r = await test_client.put(
            f"/api/v1/views/{view_id}/grants/{grant_id}",
            json={"role": "editor"},
        )
        listed = await test_client.get(f"/api/v1/views/{view_id}/grants")
    assert r.status_code == 200, r.text
    assert r.json()["role"] == "editor"
    assert listed.json()[0]["role"] == "editor"


@pytest.mark.asyncio
async def test_grant_role_update_rejects_foreign_grant(
    test_client: AsyncClient, db_session,
):
    view_id, _ = await _seed_granted_view(db_session)
    other_view, other_grant = await _seed_granted_view(
        db_session, view_id="view_gr_other",
    )
    with _auth(user=CREATOR, claims=EMPTY_CLAIMS):
        r = await test_client.put(
            f"/api/v1/views/{view_id}/grants/{other_grant}",
            json={"role": "editor"},
        )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_grant_role_update_needs_manage_rights(
    test_client: AsyncClient, db_session,
):
    view_id, grant_id = await _seed_granted_view(db_session)
    stranger = _user("usr_gr_stranger")
    with _auth(user=stranger, claims=EMPTY_CLAIMS):
        r = await test_client.put(
            f"/api/v1/views/{view_id}/grants/{grant_id}",
            json={"role": "editor"},
        )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_grant_role_update_validates_role(
    test_client: AsyncClient, db_session,
):
    view_id, grant_id = await _seed_granted_view(db_session)
    with _auth(user=CREATOR, claims=EMPTY_CLAIMS):
        r = await test_client.put(
            f"/api/v1/views/{view_id}/grants/{grant_id}",
            json={"role": "admin"},
        )
    assert r.status_code == 422
