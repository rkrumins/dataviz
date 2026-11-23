"""A workspace's own groups: its admins make, rename, re-role and delete them, and say who is in them.

These pin who manages what: a group the workspace owns is managed by its admins from the
workspace, and named after it (``"Lab · Engineers"``); a group only bound there is read, never
changed (403 ``not_owned``); a steward reads, never writes. Changing who is in a group grants or
takes away everything it carries, so a group that also reaches beyond what the admin could grant
is refused; people the identity provider put in a group leave it there (409 ``managed_by_idp``).
Every change ends the sessions it must, is recorded, and tells the people it adds. A taken name
— a deleted group's too — is refused with a free one. Linking to the identity provider is a
platform administrator's: theirs links at once, anyone else's asks.
"""
from __future__ import annotations

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from backend.app.db.models import (
    GroupMemberORM, GroupORM, IdpGroupRoleMappingORM, IdpLinkRequestORM, RoleBindingORM,
)
from tests.common.groups_world import (
    ADA, BEN, CAL, DEE, MAX, OTHER, PLATFORM_GROUP, ROOT, STU, T0, WS, acting, build_world, events, kinds,
)

BASE = f"/api/v1/admin/workspaces/{WS}/groups"


@pytest.fixture
async def world(db_session):
    await build_world(db_session)


async def _make(client: AsyncClient, user=ADA, **overrides) -> dict:
    body = {"name": "Engineers", "role": "workspace_publisher", "memberIds": [BEN.id, DEE.id],
            "description": "The builders", **overrides}
    with acting(user):
        r = await client.post(BASE, json=body)
    assert r.status_code == 201, r.text
    return r.json()


async def _fresh(session, model, *where):
    return (await session.execute(
        select(model).where(*where).execution_options(populate_existing=True)
    )).scalars().all()


# ── Making one ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_a_workspace_admin_makes_a_group_the_workspace_owns(test_client: AsyncClient, world, db_session):
    body = await _make(test_client)
    assert body | {"id": None, "createdAt": None} == {
        "id": None, "name": "Lab · Engineers", "shortName": "Engineers", "description": "The builders",
        "owned": True, "role": "workspace_publisher", "roleLabel": "Publisher", "memberCount": 2,
        "memberPreview": [{"id": BEN.id, "displayName": "Ben T"}, {"id": DEE.id, "displayName": "Dee T"}],
        "source": "local", "idpLinks": [], "pendingIdpLink": None, "createdAt": None,
    }
    group = await db_session.get(GroupORM, body["id"])
    assert (group.workspace_id, group.created_by) == (WS, ADA.id)
    bound = (await db_session.execute(
        select(RoleBindingORM.role_name).where(RoleBindingORM.subject_id == group.id, RoleBindingORM.scope_id == WS)
    )).scalars().all()
    assert bound == ["workspace_publisher"]
    assert (await kinds(db_session, BEN.id)) == {"workspace.member_added": f"/workspaces/{WS}"}
    assert [p["group_id"] for _, p in await events(db_session, "rbac.group.created")] == [group.id]
    assert sorted((p["user_id"], p["via"]) for _, p in await events(db_session, "rbac.group.member_added")) == [
        (BEN.id, "workspace"), (DEE.id, "workspace")]
    assert [(p["subject_type"], p["role"]) for _, p in await events(db_session, "rbac.workspace.member_bound")] == [
        ("group", "workspace_publisher")]

    with acting(ADA):
        listed = await test_client.get(BASE)
    assert listed.status_code == 200, listed.text
    assert [(g["name"], g["owned"], g["role"]) for g in listed.json()] == [
        ("Finance readers", False, "workspace_viewer"), ("Lab · Engineers", True, "workspace_publisher")]


@pytest.mark.asyncio
@pytest.mark.parametrize("overrides", [
    {"name": "   "}, {"name": "x" * 81}, {"role": "workspace_admin"},
    {"memberIds": [CAL.id]}, {"memberIds": ["usr_nobody"]}, {"memberIds": ["svc_robot"]},
])
async def test_what_a_group_is_made_with_is_checked(test_client: AsyncClient, world, db_session, overrides):
    body = {"name": "Engineers", "role": "workspace_member", **overrides}
    with acting(ADA):
        r = await test_client.post(BASE, json=body)
    assert r.status_code == 422, r.text
    assert await _fresh(db_session, GroupORM, GroupORM.workspace_id == WS) == []


@pytest.mark.asyncio
async def test_a_taken_name_is_refused_with_a_free_one(test_client: AsyncClient, world, db_session):
    db_session.add_all([GroupORM(name="Lab · Readers", deleted_at=T0), GroupORM(name="Lab · Readers 2")])
    await db_session.commit()
    with acting(ADA):
        clash = await test_client.post(BASE, json={"name": " Readers ", "role": "workspace_viewer"})
    assert clash.status_code == 409, clash.text
    assert clash.json()["detail"]["type"] == "group_name_taken"
    assert clash.json()["detail"]["suggestion"] == "Readers 3"

    made = await _make(test_client, name="Builders", memberIds=[])
    with acting(ADA):
        rename = await test_client.patch(f"{BASE}/{made['id']}", json={"name": "Readers"})
        same = await test_client.patch(f"{BASE}/{made['id']}", json={"name": "Builders"})
    assert rename.status_code == 409 and rename.json()["detail"]["type"] == "group_name_taken"
    assert same.status_code == 200, same.text


# ── Changing and deleting one ──────────────────────────────────────────


@pytest.mark.asyncio
async def test_renaming_keeps_the_prefix_and_a_new_role_replaces_the_old(test_client: AsyncClient, world, db_session):
    made = await _make(test_client)
    with acting(ADA):
        r = await test_client.patch(f"{BASE}/{made['id']}",
                                    json={"name": "Builders", "description": "", "role": "workspace_viewer"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["name"], body["shortName"], body["description"], body["role"], body["roleLabel"]) == (
        "Lab · Builders", "Builders", None, "workspace_viewer", "Viewer")
    bound = (await db_session.execute(
        select(RoleBindingORM.role_name).where(RoleBindingORM.subject_id == made["id"])
    )).scalars().all()
    assert bound == ["workspace_viewer"]
    assert [p["role"] for _, p in await events(db_session, "rbac.workspace.member_revoked")] == ["workspace_publisher"]
    assert [p["group_id"] for _, p in await events(db_session, "rbac.group.updated")] == [made["id"]]

    with acting(ADA):
        untouched = await test_client.patch(f"{BASE}/{made['id']}", json={"role": "workspace_viewer"})
    assert untouched.json()["description"] is None
    assert len(await events(db_session, "rbac.workspace.member_revoked")) == 1


@pytest.mark.asyncio
async def test_deleting_takes_its_bindings_links_and_waiting_link_with_it(
    test_client: AsyncClient, world, db_session,
):
    made = await _make(test_client)
    db_session.add(IdpGroupRoleMappingORM(idp_group="ML-Engineers", target_type="group_membership",
                                          target_group_id=made["id"], created_at=T0))
    db_session.add(GroupMemberORM(group_id=made["id"], user_id=MAX.id, source="sso"))
    await db_session.commit()
    with acting(ADA):
        asked = await test_client.post(f"{BASE}/{made['id']}/idp-link", json={"idpGroup": "Lab-Builders"})
        gone = await test_client.delete(f"{BASE}/{made['id']}")
        listed = await test_client.get(BASE)
    assert asked.status_code == 200, asked.text
    assert gone.status_code == 204, gone.text
    group = (await _fresh(db_session, GroupORM, GroupORM.id == made["id"]))[0]
    assert group.deleted_at is not None
    assert await _fresh(db_session, RoleBindingORM, RoleBindingORM.subject_id == made["id"]) == []
    assert await _fresh(db_session, IdpGroupRoleMappingORM, IdpGroupRoleMappingORM.target_group_id == made["id"]) == []
    left = await _fresh(db_session, GroupMemberORM, GroupMemberORM.group_id == made["id"])
    assert sorted(m.user_id for m in left) == [BEN.id, DEE.id]   # the identity provider's member went with its link
    [request] = await _fresh(db_session, IdpLinkRequestORM, IdpLinkRequestORM.group_id == made["id"])
    assert request.status == "cancelled"
    [(_, deleted)] = await events(db_session, "rbac.group.deleted")
    assert (deleted["group_id"], deleted["bindings_revoked"], deleted["workspace_id"]) == (made["id"], 1, WS)
    assert [g["id"] for g in listed.json()] == [PLATFORM_GROUP]


@pytest.mark.asyncio
async def test_a_group_the_workspace_does_not_own_is_read_not_changed(test_client: AsyncClient, world, db_session):
    target = f"{BASE}/{PLATFORM_GROUP}"
    with acting(ADA):
        members = await test_client.get(f"{target}/members")
        refused = [
            await test_client.patch(target, json={"name": "Mine now"}),
            await test_client.delete(target),
            await test_client.post(f"{target}/members", json={"userId": BEN.id}),
            await test_client.delete(f"{target}/members/{BEN.id}"),
            await test_client.post(f"{target}/idp-link", json={"idpGroup": "Finance-All"}),
        ]
        missing = await test_client.get(f"{BASE}/grp_nowhere/members")
        elsewhere = await test_client.get(f"/api/v1/admin/workspaces/{OTHER}/groups/{PLATFORM_GROUP}/members")
    assert members.status_code == 200 and members.json() == []
    assert [(r.status_code, r.json()["detail"]["type"]) for r in refused] == [(403, "not_owned")] * 5
    assert missing.status_code == 404
    assert elsewhere.status_code == 403   # Ada has no say in Other
    assert (await db_session.get(GroupORM, PLATFORM_GROUP)).name == "Finance readers"


@pytest.mark.asyncio
async def test_a_steward_reads_the_groups_but_does_not_change_them(test_client: AsyncClient, world, db_session):
    made = await _make(test_client)
    with acting(STU):
        listed = await test_client.get(BASE)
        members = await test_client.get(f"{BASE}/{made['id']}/members")
        writes = [
            await test_client.post(BASE, json={"name": "Mine", "role": "workspace_viewer"}),
            await test_client.patch(f"{BASE}/{made['id']}", json={"name": "Mine"}),
            await test_client.delete(f"{BASE}/{made['id']}"),
            await test_client.post(f"{BASE}/{made['id']}/members", json={"userId": MAX.id}),
            await test_client.post(f"{BASE}/{made['id']}/idp-link", json={"idpGroup": "X"}),
        ]
    with acting(MAX):
        member_reads = await test_client.get(BASE)
    assert listed.status_code == 200 and len(listed.json()) == 2
    assert members.status_code == 200
    assert [(m["id"], m["displayName"], m["email"], m["source"]) for m in members.json()] == [
        (BEN.id, "Ben T", BEN.email, "local"), (DEE.id, "Dee T", DEE.email, "local")]
    assert [r.status_code for r in writes] == [403] * 5
    assert member_reads.status_code == 403


# ── Who is in it ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_adding_and_removing_people(test_client: AsyncClient, world, db_session):
    made = await _make(test_client, memberIds=[BEN.id])
    path = f"{BASE}/{made['id']}/members"
    db_session.add(GroupMemberORM(group_id=made["id"], user_id=MAX.id, source="sso"))
    await db_session.commit()
    with acting(ADA):
        added = await test_client.post(path, json={"userId": DEE.id})
        again = await test_client.post(path, json={"userId": DEE.id})
        bad = [await test_client.post(path, json={"userId": u}) for u in (CAL.id, "svc_robot", "usr_nobody")]
        removed = await test_client.delete(f"{path}/{BEN.id}")
        not_in = await test_client.delete(f"{path}/{BEN.id}")
        sso = await test_client.delete(f"{path}/{MAX.id}")
        listed = await test_client.get(path)
    assert added.status_code == 201, added.text
    assert added.json() | {"addedAt": None} == {
        "id": DEE.id, "displayName": "Dee T", "email": DEE.email, "source": "local", "addedAt": None}
    assert again.status_code == 409 and again.json()["detail"]["type"] == "already_member"
    assert [r.status_code for r in bad] == [422] * 3
    assert removed.status_code == 204 and not_in.status_code == 404
    assert sso.status_code == 409 and sso.json()["detail"]["type"] == "managed_by_idp"
    assert sorted((m["id"], m["source"]) for m in listed.json()) == [(DEE.id, "local"), (MAX.id, "sso")]
    assert (await kinds(db_session, DEE.id))["workspace.member_added"] == f"/workspaces/{WS}"
    assert [(p["user_id"], p["via"]) for _, p in await events(db_session, "rbac.group.member_removed")] == [
        (BEN.id, "workspace")]


@pytest.mark.asyncio
async def test_a_group_that_reaches_beyond_the_workspace_is_left_to_whoever_can_grant_that(
    test_client: AsyncClient, world, db_session,
):
    made = await _make(test_client, memberIds=[BEN.id])
    db_session.add(RoleBindingORM(subject_type="group", subject_id=made["id"], role_name="workspace_member",
                                  scope_type="workspace", scope_id=OTHER))
    await db_session.commit()
    with acting(ADA):
        refused = [
            await test_client.post(f"{BASE}/{made['id']}/members", json={"userId": DEE.id}),
            await test_client.delete(f"{BASE}/{made['id']}/members/{BEN.id}"),
            await test_client.delete(f"{BASE}/{made['id']}"),
        ]
        renamed = await test_client.patch(f"{BASE}/{made['id']}", json={"name": "Still mine"})
    assert [(r.status_code, r.json()["detail"]["type"]) for r in refused] == [(403, "reaches_beyond_workspace")] * 3
    assert renamed.status_code == 200
    with acting(ROOT):
        by_root = await test_client.post(f"{BASE}/{made['id']}/members", json={"userId": DEE.id})
    assert by_root.status_code == 201, by_root.text


# ── The identity provider ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_a_platform_admin_links_at_once_and_unlinks(test_client: AsyncClient, world, db_session):
    made = await _make(test_client, memberIds=[])
    with acting(ROOT):
        linked = await test_client.post(f"{BASE}/{made['id']}/idp-link",
                                        json={"idpGroup": " ML-Engineers ", "providerId": "idp_corp"})
        twice = await test_client.post(f"{BASE}/{made['id']}/idp-link",
                                       json={"idpGroup": "ML-Engineers", "providerId": "idp_corp"})
        nowhere = await test_client.post(f"{BASE}/{made['id']}/idp-link",
                                         json={"idpGroup": "ML-Engineers", "providerId": "idp_missing"})
    assert linked.status_code == 200, linked.text
    [link] = linked.json()["idpLinks"]
    assert link | {"mappingId": None} == {"mappingId": None, "idpGroup": "ML-Engineers", "providerId": "idp_corp",
                                          "providerName": "Corporate SSO"}
    assert linked.json()["pendingIdpLink"] is None
    assert twice.status_code == 409 and twice.json()["detail"]["type"] == "already_linked"
    assert nowhere.status_code == 422

    db_session.add(GroupMemberORM(group_id=made["id"], user_id=BEN.id, source="sso"))
    await db_session.commit()
    with acting(ADA):
        not_hers = await test_client.delete(f"{BASE}/{made['id']}/idp-links/{link['mappingId']}")
    with acting(ROOT):
        other_group = await test_client.delete(f"{BASE}/{PLATFORM_GROUP}/idp-links/{link['mappingId']}")
        unlinked = await test_client.delete(f"{BASE}/{made['id']}/idp-links/{link['mappingId']}")
    assert not_hers.status_code == 403
    assert other_group.status_code == 404
    assert unlinked.status_code == 204, unlinked.text
    assert await _fresh(db_session, IdpGroupRoleMappingORM) == []
    assert await _fresh(db_session, GroupMemberORM, GroupMemberORM.group_id == made["id"]) == []


@pytest.mark.asyncio
async def test_a_group_made_with_an_idp_group_is_linked_or_asked_for(test_client: AsyncClient, world, db_session):
    asked = await _make(test_client, idpGroup="ML-Engineers", memberIds=[])
    assert asked["idpLinks"] == []
    assert asked["pendingIdpLink"] | {"requestId": None, "requestedAt": None} == {
        "requestId": None, "idpGroup": "ML-Engineers", "requestedBy": ADA.id, "requestedByName": "Ada T",
        "requestedAt": None}
    assert (await kinds(db_session, ROOT.id)) == {"idp_link.requested": "/workspaces?tab=requests"}

    linked = await _make(test_client, user=ROOT, name="Readers", idpGroup="Finance-All", memberIds=[])
    assert [lk["idpGroup"] for lk in linked["idpLinks"]] == ["Finance-All"] and linked["pendingIdpLink"] is None
