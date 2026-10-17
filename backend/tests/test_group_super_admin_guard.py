"""Only a Super Admin changes who is in a group that grants Super Admin.

Org admins hold ``system:groups:manage``, and a member inherits every binding
the group holds — so adding someone to a group bound to ``super_admin`` would
make them a Super Admin. Pinned here:

* an org admin is refused (403 ``group_grants_super_admin``) adding to,
  removing from, or deleting such a group, and nothing changes or is recorded;
* an org admin still manages every other group;
* a Super Admin manages the group as before.
"""
from __future__ import annotations

import pytest
from sqlalchemy import func, select

from backend.app.auth.dependencies import get_permission_claims
from backend.app.db.models import (
    GroupMemberORM, GroupORM, OutboxEventORM, RoleBindingORM, UserORM,
)
from backend.app.services.permission_service import PermissionClaims

API = "/api/v1/admin/groups"


@pytest.fixture
def org_admin_client(test_client):
    """The test client, signed in as an org admin instead of a Super Admin."""
    from backend.app.main import app
    app.dependency_overrides[get_permission_claims] = lambda: PermissionClaims(
        sid="sess_test",
        global_perms=("system:groups:manage", "system:org-admin"),
        ws_perms={},
    )
    return test_client


async def _group(db_session, gid: str, *, role: str | None) -> None:
    """A group with one member, ``usr_ann``, and ``usr_new`` waiting to join."""
    for uid in ("usr_ann", "usr_new"):
        db_session.add(UserORM(
            id=uid, email=f"{uid}@example.com", password_hash="x",
            first_name=uid, last_name="Test", status="active",
        ))
    db_session.add(GroupORM(id=gid, name=gid))
    if role:
        db_session.add(RoleBindingORM(
            subject_type="group", subject_id=gid, role_name=role,
            scope_type="global", scope_id=None,
        ))
    db_session.add(GroupMemberORM(group_id=gid, user_id="usr_ann"))
    await db_session.commit()


async def _members(db_session, gid: str) -> set[str]:
    return set((await db_session.execute(
        select(GroupMemberORM.user_id).where(GroupMemberORM.group_id == gid)
    )).scalars().all())


async def _deleted_at(db_session, gid: str) -> str | None:
    return (await db_session.execute(
        select(GroupORM.deleted_at).where(GroupORM.id == gid)
    )).scalar_one()


async def _group_events(db_session) -> int:
    return (await db_session.execute(
        select(func.count()).select_from(OutboxEventORM)
        .where(OutboxEventORM.event_type.like("rbac.group.%"))
    )).scalar_one()


@pytest.mark.asyncio
async def test_org_admin_cannot_change_a_group_that_grants_super_admin(
    org_admin_client, db_session,
):
    await _group(db_session, "grp_owners", role="super_admin")
    before = await _group_events(db_session)

    for r in (
        await org_admin_client.post(f"{API}/grp_owners/members", json={"userId": "usr_new"}),
        await org_admin_client.delete(f"{API}/grp_owners/members/usr_ann"),
        await org_admin_client.delete(f"{API}/grp_owners"),
    ):
        assert r.status_code == 403, r.text
        assert r.json()["detail"]["error"] == "group_grants_super_admin"
        assert "only a Super Admin" in r.json()["detail"]["message"]

    assert await _members(db_session, "grp_owners") == {"usr_ann"}
    assert await _deleted_at(db_session, "grp_owners") is None
    assert await _group_events(db_session) == before


@pytest.mark.asyncio
async def test_org_admin_still_manages_other_groups(org_admin_client, db_session):
    await _group(db_session, "grp_team", role=None)

    r = await org_admin_client.post(f"{API}/grp_team/members", json={"userId": "usr_new"})
    assert r.status_code == 201, r.text
    r = await org_admin_client.delete(f"{API}/grp_team/members/usr_ann")
    assert r.status_code == 204, r.text
    assert await _members(db_session, "grp_team") == {"usr_new"}
    r = await org_admin_client.delete(f"{API}/grp_team")
    assert r.status_code == 204, r.text


@pytest.mark.asyncio
async def test_super_admin_manages_a_group_that_grants_super_admin(
    test_client, db_session,
):
    await _group(db_session, "grp_owners", role="super_admin")

    r = await test_client.post(f"{API}/grp_owners/members", json={"userId": "usr_new"})
    assert r.status_code == 201, r.text
    r = await test_client.delete(f"{API}/grp_owners/members/usr_ann")
    assert r.status_code == 204, r.text
    assert await _members(db_session, "grp_owners") == {"usr_new"}
    r = await test_client.delete(f"{API}/grp_owners")
    assert r.status_code == 204, r.text
    assert await _deleted_at(db_session, "grp_owners") is not None
