"""Hardening for workspaces that hold sensitive graphs.

* **The restricted mark is the admins'.** It is what stops a source's
  members publishing views over it to everyone, so a member who could lift
  it could step around it. Members still edit everything else.
* **Exceptions are the admins', and they end.** Letting someone in around
  the identity provider takes a workspace admin, an end date 90 days away
  at most, and the same again — confirmed as an exception — to keep it.
* **Whoever lets someone in sees what they open.** Every role in a
  workspace reads every data source in it, so the grant options list them,
  restricted ones marked.
"""
from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import (
    AccessRequestORM,
    ProviderORM,
    RoleBindingORM,
    WorkspaceDataSourceORM,
    WorkspaceORM,
)
from backend.app.services import access_housekeeping
from tests.common.workspace_access_world import (
    WS,
    acting_as,
    build_world,
    days_ago,
    in_days,
    notes,
    seed_steward_catalogue,
)

URL = "/api/v1/access-requests"
ADMIN_URL = "/api/v1/admin/access-requests"
MEMBERS = f"/api/v1/admin/workspaces/{WS}/members"
ANA = {"subjectType": "user", "subjectId": "usr_ana", "role": "workspace_viewer"}


@pytest.fixture(autouse=True)
async def _steward_catalogue(db_session: AsyncSession):
    await seed_steward_catalogue(db_session)


@pytest.fixture()
async def world(db_session: AsyncSession, test_client):
    await build_world(db_session)
    db_session.add(ProviderORM(id="prov_x", name="P", provider_type="falkordb"))
    db_session.add_all([
        WorkspaceDataSourceORM(
            id="ds_hr", workspace_id=WS, provider_id="prov_x", graph_name="hr", label="HR warehouse",
            is_primary=True, is_restricted=True,
        ),
        WorkspaceDataSourceORM(id="ds_led", workspace_id=WS, provider_id="prov_x", graph_name="led", label="Ledger"),
    ])
    await db_session.commit()
    return test_client


async def _idp(session):
    (await session.get(WorkspaceORM, WS)).access_mode = "idp"
    await session.flush()


async def _ask(world, session, role="workspace_viewer") -> dict:
    async with acting_as(session, "ana"):
        res = await world.post(URL, json={"targetType": "workspace", "targetId": WS, "requestedRole": role})
    assert res.status_code == 201, res.text
    return res.json()


# ── The restricted mark ──────────────────────────────────────────────


async def test_only_admins_change_whether_a_source_is_restricted(world, db_session):
    url = f"/api/v1/admin/workspaces/{WS}/data-sources/ds_hr"
    async with acting_as(db_session, "max"):
        lifted = await world.put(url, json={"isRestricted": False})
        # Everything else is still a member's to edit — the mark sent as it is included.
        renamed = await world.put(url, json={"label": "HR", "isRestricted": True})
    assert lifted.status_code == 403
    assert lifted.json()["detail"] == "Only the workspace's admins can change whether a source is restricted"
    assert renamed.status_code == 200, renamed.text
    source = await db_session.get(WorkspaceDataSourceORM, "ds_hr")
    await db_session.refresh(source)
    assert (source.is_restricted, source.label) == (True, "HR")

    async with acting_as(db_session, "wanda"):
        assert (await world.put(url, json={"isRestricted": False})).status_code == 200
    await db_session.refresh(source)
    assert source.is_restricted is False


# ── Exceptions ───────────────────────────────────────────────────────


async def test_only_admins_grant_an_exception_and_it_always_ends(world, db_session):
    await _idp(db_session)
    req = await _ask(world, db_session)
    approve = f"{ADMIN_URL}/{req['id']}/approve"
    async with acting_as(db_session, "bob"):
        steward = await world.post(approve, json={"exception": True, "expiresIn": "30d"})
    async with acting_as(db_session, "wanda"):
        for_good = await world.post(approve, json={"exception": True})
        too_long = await world.post(approve, json={"exception": True, "expiresAt": in_days(120)})
        ok = await world.post(approve, json={"exception": True, "expiresIn": "90d"})
    assert steward.status_code == 403
    assert "Only the workspace's admins" in steward.json()["detail"]
    assert (for_good.status_code, too_long.status_code) == (422, 422)
    assert ok.status_code == 200, ok.text
    assert ok.json()["idpException"] is True


async def test_adding_someone_as_an_exception_takes_an_admin_and_an_end(world, db_session):
    await _idp(db_session)
    async with acting_as(db_session, "bob"):
        steward = await world.post(MEMBERS, json={**ANA, "exception": True, "expiresIn": "30d"})
    async with acting_as(db_session, "wanda"):
        for_good = await world.post(MEMBERS, json={**ANA, "exception": True})
        added = await world.post(MEMBERS, json={**ANA, "exception": True, "expiresIn": "30d"})
    assert (steward.status_code, for_good.status_code) == (403, 422)
    assert added.status_code == 201, added.text
    assert added.json()["expiresAt"]


async def test_keeping_an_exception_is_confirmed_again_by_an_admin(world, db_session):
    await _idp(db_session)
    binding = RoleBindingORM(
        subject_type="user", subject_id="usr_ana", role_name="workspace_viewer", scope_type="workspace",
        scope_id=WS, granted_at=days_ago(25), granted_by="usr_wanda", expires_at=in_days(5),
        source="local", idp_exception=True,
    )
    db_session.add(binding)
    await db_session.flush()
    async with acting_as(db_session, "ana"):
        req = (await world.post(f"{URL}/extend", json={"bindingId": binding.id})).json()
    assert req["idpException"] is True
    # Only admins hear: only they can keep it going.
    assert [n.user_id for n in await notes(db_session, "access_request.submitted")] == ["usr_wanda"]

    approve = f"{ADMIN_URL}/{req['id']}/approve"
    async with acting_as(db_session, "bob"):
        steward = await world.post(approve, json={"exception": True, "expiresIn": "30d"})
    async with acting_as(db_session, "wanda"):
        unconfirmed = await world.post(approve, json={"expiresIn": "30d"})
        for_good = await world.post(approve, json={"exception": True})
        kept = await world.post(approve, json={"exception": True, "expiresIn": "30d"})
    assert steward.status_code == 403
    assert (unconfirmed.status_code, unconfirmed.json()["detail"]["type"]) == (409, "idp_managed")
    assert for_good.status_code == 422
    assert kept.status_code == 200, kept.text
    await db_session.refresh(binding)
    assert (binding.idp_exception, binding.expires_at is not None) == (True, True)


async def test_moving_an_exceptions_end_is_confirmed_and_keeps_an_end(world, db_session):
    binding = RoleBindingORM(
        subject_type="user", subject_id="usr_ana", role_name="workspace_viewer", scope_type="workspace",
        scope_id=WS, expires_at=in_days(5), source="local", idp_exception=True,
    )
    db_session.add(binding)
    await db_session.flush()
    url = f"{MEMBERS}/{binding.id}/expiry"
    async with acting_as(db_session, "wanda"):
        unconfirmed = await world.put(url, json={"expiresIn": "30d"})
        for_good = await world.put(url, json={"exception": True})
        moved = await world.put(url, json={"exception": True, "expiresIn": "30d"})
    assert (unconfirmed.status_code, for_good.status_code, moved.status_code) == (409, 422, 200)


async def test_a_waiting_request_to_keep_an_exception_reminds_only_admins(world, db_session):
    binding = RoleBindingORM(
        subject_type="user", subject_id="usr_ana", role_name="workspace_viewer", scope_type="workspace",
        scope_id=WS, expires_at=in_days(5), source="local", idp_exception=True,
    )
    db_session.add(binding)
    await db_session.flush()
    async with acting_as(db_session, "ana"):
        req = (await world.post(f"{URL}/extend", json={"bindingId": binding.id})).json()
    (await db_session.get(AccessRequestORM, req["id"])).created_at = days_ago(4)
    await db_session.flush()
    assert await access_housekeeping.nudge_waiting_requests(db_session) == (1, 0)
    assert [n.user_id for n in await notes(db_session, "access_request.reminder")] == ["usr_wanda"]


# ── What a grant opens ───────────────────────────────────────────────


async def test_the_grant_options_list_every_source_a_role_reads(world, db_session):
    async with acting_as(db_session, "bob"):
        res = await world.get(f"{MEMBERS}/grant-options")
    assert res.status_code == 200, res.text
    assert res.json()["dataSources"] == [
        {"id": "ds_hr", "label": "HR warehouse", "restricted": True},
        {"id": "ds_led", "label": "Ledger", "restricted": False},
    ]
