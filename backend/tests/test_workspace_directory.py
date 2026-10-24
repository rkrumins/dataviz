"""Find a workspace, and the access settings that shape it.

* The directory is refused while its switch is off — it ships off.
* It lists every workspace its admins haven't hidden, plus the ones the
  caller can open; an Org Admin sees them all.
* Each entry says what the workspace is, how many people and data sources
  it has, who answers its requests, how access works, and where the caller
  stands: their roles, and their open request.
* Admins set whether it is listed, who decides access and a note for people
  asking, on the workspace itself.
"""
from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import (
    GroupMemberORM,
    GroupORM,
    ProviderORM,
    RoleBindingORM,
    WorkspaceDataSourceORM,
    WorkspaceORM,
)
from tests.common.workspace_access_world import (
    WS,
    WS_OTHER,
    acting_as,
    build_world,
    days_ago,
    directory,
    seed_steward_catalogue,
)

URL = "/api/v1/workspace-directory"


@pytest.fixture(autouse=True)
async def _steward_catalogue(db_session: AsyncSession):
    await seed_steward_catalogue(db_session)


@pytest.fixture()
async def world(db_session: AsyncSession, test_client):
    await build_world(db_session)
    return test_client


def _by_id(res) -> dict[str, dict]:
    assert res.status_code == 200, res.text
    return {e["id"]: e for e in res.json()["entries"]}


async def test_the_directory_is_refused_while_its_switch_is_off(world, db_session):
    async with acting_as(db_session, "ana"):
        res = await world.get(URL)
    assert res.status_code == 403
    assert res.json()["detail"]["feature"] == "workspaceDirectoryEnabled"


async def test_each_entry_says_what_it_is_who_is_in_it_and_who_answers(world, db_session):
    directory(on=True)
    ws = await db_session.get(WorkspaceORM, WS)
    ws.description, ws.access_note = "Month-end close and reporting", "Say which team you're on"
    db_session.add(ProviderORM(id="prov_1", name="P", provider_type="falkordb"))
    db_session.add_all([
        WorkspaceDataSourceORM(id="ds_1", workspace_id=WS, provider_id="prov_1"),
        WorkspaceDataSourceORM(id="ds_2", workspace_id=WS, provider_id="prov_1"),
        WorkspaceDataSourceORM(id="ds_gone", workspace_id=WS, provider_id="prov_1", deleted_at=days_ago(1)),
    ])
    # People reach it through a group too, and a lapsed grant reaches nobody.
    db_session.add(GroupORM(id="grp_close", name="Close team"))
    db_session.add(GroupMemberORM(group_id="grp_close", user_id="usr_ana"))
    db_session.add(RoleBindingORM(
        subject_type="group", subject_id="grp_close", role_name="workspace_viewer",
        scope_type="workspace", scope_id=WS,
    ))
    db_session.add(RoleBindingORM(
        subject_type="user", subject_id="usr_olga", role_name="workspace_admin",
        scope_type="workspace", scope_id=WS_OTHER, expires_at=days_ago(2),
    ))
    await db_session.flush()

    async with acting_as(db_session, "max"):
        entries = _by_id(await world.get(URL))
    fin = entries[WS]
    assert (fin["name"], fin["description"], fin["accessNote"], fin["accessMode"]) == (
        "Finance", "Month-end close and reporting", "Say which team you're on", "app",
    )
    assert (fin["dataSourceCount"], fin["peopleCount"]) == (2, 4)
    assert (fin["approverIds"], fin["approverCount"]) == (["usr_bob", "usr_wanda"], 2)
    assert (fin["canOpen"], fin["yourRoles"], fin["openRequest"]) == (True, ["workspace_member"], None)
    ops = entries[WS_OTHER]
    assert (ops["peopleCount"], ops["approverIds"], ops["canOpen"]) == (0, [], False)


async def test_a_hidden_workspace_is_listed_only_for_those_who_can_open_it(world, db_session):
    directory(on=True)
    (await db_session.get(WorkspaceORM, WS)).directory_listed = False
    await db_session.flush()
    async with acting_as(db_session, "ana"):
        assert list(_by_id(await world.get(URL))) == [WS_OTHER]
    async with acting_as(db_session, "max"):
        assert _by_id(await world.get(URL))[WS]["directoryListed"] is False
    async with acting_as(db_session, "olga"):
        assert set(_by_id(await world.get(URL))) == {WS, WS_OTHER}
    # Deleted is gone for everyone.
    (await db_session.get(WorkspaceORM, WS_OTHER)).deleted_at = days_ago(1)
    await db_session.flush()
    async with acting_as(db_session, "olga"):
        assert list(_by_id(await world.get(URL))) == [WS]


async def test_your_open_request_is_on_the_entry(world, db_session):
    directory(on=True)
    async with acting_as(db_session, "ana"):
        asked = await world.post("/api/v1/access-requests", json={
            "targetType": "workspace", "targetId": WS, "requestedRole": "workspace_viewer",
        })
        assert asked.status_code == 201, asked.text
        entry = _by_id(await world.get(URL))[WS]
    assert entry["openRequest"]["id"] == asked.json()["id"]
    assert (entry["openRequest"]["status"], entry["openRequest"]["requestedRole"]) == (
        "pending", "workspace_viewer",
    )
    assert (entry["canOpen"], entry["yourRoles"]) == (False, [])


async def test_admins_set_listing_access_mode_and_note_on_the_workspace(world, db_session):
    url = f"/api/v1/admin/workspaces/{WS}"
    async with acting_as(db_session, "wanda"):
        res = await world.put(url, json={
            "directoryListed": False, "accessMode": "idp", "accessNote": "  Request finance-analysts  ",
        })
        assert res.status_code == 200, res.text
        assert (res.json()["directoryListed"], res.json()["accessMode"], res.json()["accessNote"]) == (
            False, "idp", "Request finance-analysts",
        )
        # Untouched fields stay; an empty note clears it.
        cleared = (await world.put(url, json={"accessNote": ""})).json()
        assert (cleared["directoryListed"], cleared["accessMode"], cleared["accessNote"]) == (False, "idp", None)
        assert (await world.put(url, json={"accessMode": "everyone"})).status_code == 422
        assert (await world.put(url, json={"accessNote": "x" * 501})).status_code == 422
    # A steward lets people in; the workspace's settings stay with its admins.
    async with acting_as(db_session, "bob"):
        assert (await world.put(url, json={"directoryListed": True})).status_code == 403
