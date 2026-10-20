"""Asking to join a workspace, and answering.

* A person has one open request per workspace — asking again returns the
  first, and a unique index holds the rule when two asks race each other. A
  request moves from pending to approved, denied or withdrawn, or to waiting
  on the identity provider and from there to approved.
* Asking: only roles that are access, never authority, and never one already
  held. The workspace's admins and stewards hear about it — Org Admins when
  it has none — and a requester sees the name only of a workspace they could
  see anyway.
* Answering: one list across the workspaces someone lets people into.
  Approving grants a role within the answerer's ceiling (optionally until a
  date, making a lapsed grant current) or a team whose every role they could
  grant. Nobody answers their own request.
* A workspace whose access its identity provider decides: a grant in the app
  is an exception, said out loud; pointing the person to a mapped group waits
  until the access arrives at a sign-in, which closes the request.
* The Members tab holds stewards to the same ceilings.
* Every grant says how it came about — on People with access, where people
  who reach every workspace are listed too, and on My Access.
"""
from __future__ import annotations

import json

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import (
    AccessRequestORM,
    GroupMemberORM,
    GroupORM,
    NotificationORM,
    OutboxEventORM,
    RoleBindingORM,
    UserIdentityORM,
    UserORM,
    WorkspaceORM,
)
from backend.app.db.repositories import access_request_repo, idp_group_mapping_repo, idp_provider_repo
from backend.app.services.permission_service import reconcile_sso_targets
from tests.common.workspace_access_world import (
    WS,
    WS_OTHER,
    acting_as,
    build_world,
    days_ago,
    directory,
    seed_steward_catalogue,
)

URL = "/api/v1/access-requests"
ADMIN_URL = "/api/v1/admin/access-requests"


@pytest.fixture(autouse=True)
async def _steward_catalogue(db_session: AsyncSession):
    await seed_steward_catalogue(db_session)


@pytest.fixture()
async def world(db_session: AsyncSession, test_client):
    await build_world(db_session)
    return test_client


async def _submit(client, session, who="ana", ws=WS, role="workspace_member", why="Closing the quarter"):
    async with acting_as(session, who):
        return await client.post(URL, json={
            "targetType": "workspace", "targetId": ws, "requestedRole": role, "justification": why,
        })


async def _notes(session, kind: str) -> list[NotificationORM]:
    return list((await session.execute(
        select(NotificationORM).where(NotificationORM.kind == kind).order_by(NotificationORM.user_id)
    )).scalars().all())


async def _events(session, event_type: str) -> list[dict]:
    rows = (await session.execute(
        select(OutboxEventORM).where(OutboxEventORM.event_type == event_type)
    )).scalars().all()
    return [json.loads(r.payload) if isinstance(r.payload, str) else r.payload for r in rows]


async def _team(session, gid, *, role="workspace_member", source="local", protected=False, extra=()):
    """A group bound in Finance at ``role`` (plus ``extra`` bindings)."""
    session.add(GroupORM(id=gid, name=gid.title(), source=source, is_protected=protected))
    for role_name, scope_type, scope_id in ((role, "workspace", WS), *extra):
        session.add(RoleBindingORM(
            subject_type="group", subject_id=gid, role_name=role_name,
            scope_type=scope_type, scope_id=scope_id,
        ))
    await session.flush()


async def _idp_run(session):
    """Finance's access decided by Entra ID: finance-analysts → Viewer,
    finance-admins → Admin."""
    (await session.get(WorkspaceORM, WS)).access_mode = "idp"
    provider = await idp_provider_repo.create_provider(
        session, slug="entra", display_name="Entra ID", kind="oidc", settings={},
    )
    for group, role in (("finance-analysts", "workspace_viewer"), ("finance-admins", "workspace_admin")):
        await idp_group_mapping_repo.create_role_binding_mapping(
            session, idp_group=group, role_name=role, scope_type="workspace", scope_id=WS,
            provider_id=provider.id,
        )
    await session.flush()
    return provider


async def _ana_bindings(session) -> list[RoleBindingORM]:
    return list((await session.execute(
        select(RoleBindingORM).where(RoleBindingORM.subject_id == "usr_ana")
    )).scalars().all())


async def _ask(session: AsyncSession, who: str = "usr_ana", ws: str = "ws_fin", role: str = "workspace_viewer"):
    return await access_request_repo.create(
        session, requester_id=who, target_type="workspace", target_id=ws,
        requested_role=role, justification=" Joining the close team ",
    )


async def test_one_open_request_per_person_per_workspace(db_session: AsyncSession):
    first, created = await _ask(db_session)
    assert created and first.status == "pending" and first.justification == "Joining the close team"

    # Asking again — even for another role — returns the open request.
    again, created = await _ask(db_session, role="workspace_member")
    assert (again.id, created) == (first.id, False)

    # Another workspace, or another person, is another request.
    assert (await _ask(db_session, ws="ws_ops"))[1]
    assert (await _ask(db_session, who="usr_bob"))[1]

    # Once answered, the person may ask again.
    await access_request_repo.resolve(
        db_session, request_id=first.id, new_status="denied", resolver_id="usr_admin",
    )
    later, created = await _ask(db_session)
    assert created and later.id != first.id


async def test_two_asks_racing_end_with_one_request(db_session: AsyncSession, monkeypatch):
    first, _ = await _ask(db_session)

    # The second ask checks before the first is written, then inserts: the
    # unique index refuses it and it answers with the first instead.
    real = access_request_repo.find_open_for
    calls = {"n": 0}

    async def missed_once(session, **kw):
        calls["n"] += 1
        return None if calls["n"] == 1 else await real(session, **kw)

    monkeypatch.setattr(access_request_repo, "find_open_for", missed_once)
    raced, created = await _ask(db_session)
    assert (raced.id, created) == (first.id, False)

    rows = (await db_session.execute(select(AccessRequestORM))).scalars().all()
    assert [r.id for r in rows] == [first.id]


async def test_the_index_refuses_a_second_open_request(db_session: AsyncSession):
    await _ask(db_session)
    db_session.add(AccessRequestORM(
        requester_id="usr_ana", target_type="workspace", target_id="ws_fin",
        requested_role="workspace_member", status="pending",
    ))
    with pytest.raises(IntegrityError):
        await db_session.flush()


async def test_answers_follow_the_allowed_transitions(db_session: AsyncSession):
    row, _ = await _ask(db_session)

    routed = await access_request_repo.resolve(
        db_session, request_id=row.id, new_status="awaiting_idp", resolver_id="usr_admin",
        idp_group="finance-analysts",
    )
    assert (routed.status, routed.idp_group) == ("awaiting_idp", "finance-analysts")
    # Still open: no second request while it waits on the identity provider.
    assert (await _ask(db_session))[0].id == row.id
    # Pointing it to the identity provider again is not an answer it can take.
    with pytest.raises(ValueError):
        await access_request_repo.resolve(
            db_session, request_id=row.id, new_status="awaiting_idp", resolver_id="usr_admin",
            idp_group="other",
        )

    done = await access_request_repo.resolve(
        db_session, request_id=row.id, new_status="approved", resolver_id="usr_admin",
        granted_role="workspace_viewer", idp_group="finance-analysts",
    )
    assert (done.status, done.granted_role) == ("approved", "workspace_viewer")
    with pytest.raises(ValueError):
        await access_request_repo.resolve(
            db_session, request_id=row.id, new_status="withdrawn", resolver_id="usr_ana",
        )

    assert [r.id for r in await access_request_repo.list_for_requester(
        db_session, requester_id="usr_ana", status="open",
    )] == []
    with pytest.raises(ValueError):
        await access_request_repo.list_for_requester(db_session, requester_id="usr_ana", status="maybe")


# ── Asking ───────────────────────────────────────────────────────────


async def test_the_roles_anyone_may_ask_for_are_access_never_authority(world, db_session):
    async with acting_as(db_session, "ana"):
        res = await world.get(f"{URL}/requestable-roles", params={"workspaceId": WS})
        missing = await world.get(f"{URL}/requestable-roles", params={"workspaceId": "ws_nope"})
    assert res.status_code == 200, res.text
    # Admin and steward administer or let people in; platform roles aren't workspace roles.
    assert [r["name"] for r in res.json()["roles"]] == [
        "workspace_viewer", "workspace_member", "workspace_data_engineer",
    ]
    assert (res.json()["requestPolicy"], res.json()["joinRole"]) == ("approval", None)
    assert missing.status_code == 404


async def test_asking_opens_one_request_and_tells_who_answers(world, db_session):
    first = await _submit(world, db_session)
    assert first.status_code == 201, first.text
    body = first.json()
    assert (body["status"], body["requestedRole"], body["justification"]) == (
        "pending", "workspace_member", "Closing the quarter",
    )

    again = await _submit(world, db_session, role="workspace_viewer")
    assert (again.status_code, again.json()["id"]) == (200, body["id"])

    # The steward and the admin hear about it once; the member and the asker don't.
    notes = await _notes(db_session, "access_request.submitted")
    assert [n.user_id for n in notes] == ["usr_bob", "usr_wanda"]
    assert notes[0].title == "Ana T asked to join Finance"
    assert notes[0].body == "As Member: “Closing the quarter”"
    assert notes[0].link == "/workspaces?tab=requests"
    assert [e["target_id"] for e in await _events(db_session, "rbac.access_request.created")] == [WS]


async def test_a_workspace_nobody_answers_asks_the_org_admins(world, db_session):
    assert (await _submit(world, db_session, ws=WS_OTHER)).status_code == 201
    assert [n.user_id for n in await _notes(db_session, "access_request.submitted")] == ["usr_olga"]


@pytest.mark.parametrize("role", ["workspace_admin", "workspace_steward", "org_admin", "no_such_role"])
async def test_authority_may_not_be_asked_for(world, db_session, role):
    assert (await _submit(world, db_session, role=role)).status_code == 400


async def test_asking_for_what_you_already_have_is_refused(world, db_session):
    # A member already holds everything a viewer or data engineer could.
    for role in ("workspace_member", "workspace_viewer", "workspace_data_engineer"):
        assert (await _submit(world, db_session, who="max", role=role)).status_code == 409, role
    # An Org Admin reaches every workspace.
    assert (await _submit(world, db_session, who="olga", ws=WS_OTHER)).status_code == 409
    assert (await _submit(world, db_session, ws="ws_gone")).status_code == 404


async def test_a_requester_sees_the_name_only_of_a_workspace_they_could_see(world, db_session):
    first = (await _submit(world, db_session)).json()
    assert first["target"] == {"type": "workspace", "id": WS, "label": None, "accessMode": None}

    # Listed in Find a workspace while it's on: the name is no secret.
    directory(on=True)
    async with acting_as(db_session, "ana"):
        mine = (await world.get("/api/v1/me/access-requests")).json()
    assert (mine[0]["target"]["label"], mine[0]["target"]["accessMode"]) == ("Finance", "app")

    # Hidden by its admins: the id alone again.
    (await db_session.get(WorkspaceORM, WS)).directory_listed = False
    await db_session.flush()
    async with acting_as(db_session, "ana"):
        mine = (await world.get("/api/v1/me/access-requests")).json()
    assert mine[0]["target"]["label"] is None

    # Whoever answers it always sees it.
    async with acting_as(db_session, "bob"):
        listed = (await world.get(ADMIN_URL)).json()
    assert listed[0]["target"]["label"] == "Finance"


async def test_withdrawing_closes_your_own_open_request(world, db_session):
    req = (await _submit(world, db_session)).json()
    url = f"/api/v1/me/access-requests/{req['id']}/withdraw"
    async with acting_as(db_session, "max"):
        assert (await world.post(url)).status_code == 404
    async with acting_as(db_session, "ana"):
        res = await world.post(url)
        assert (res.status_code, res.json()["status"]) == (200, "withdrawn")
        assert (await world.post(url)).status_code == 409
    assert [e["actor_id"] for e in await _events(db_session, "rbac.access_request.withdrawn")] == ["usr_ana"]
    # Closed, so asking again opens a new one.
    assert (await _submit(world, db_session)).status_code == 201


# ── Answering ────────────────────────────────────────────────────────


async def test_one_list_across_the_workspaces_you_let_people_into(world, db_session):
    fin = (await _submit(world, db_session)).json()
    ops = (await _submit(world, db_session, ws=WS_OTHER)).json()

    async with acting_as(db_session, "bob"):
        assert [r["id"] for r in (await world.get(ADMIN_URL)).json()] == [fin["id"]]
        assert (await world.get(ADMIN_URL, params={"workspaceId": WS_OTHER})).status_code == 403
    async with acting_as(db_session, "olga"):
        assert {r["id"] for r in (await world.get(ADMIN_URL)).json()} == {fin["id"], ops["id"]}
    async with acting_as(db_session, "max"):
        assert (await world.get(ADMIN_URL)).json() == []
        assert (await world.get(f"/api/v1/admin/workspaces/{WS}/access-requests")).status_code == 403

    # Answered requests leave the open list and stay in the history.
    async with acting_as(db_session, "bob"):
        assert (await world.post(f"{ADMIN_URL}/{fin['id']}/deny")).status_code == 200
        assert (await world.get(ADMIN_URL)).json() == []
        everything = (await world.get(ADMIN_URL, params={"status": "all"})).json()
        assert [r["status"] for r in everything] == ["denied"]
        one = await world.get(f"/api/v1/admin/workspaces/{WS}/access-requests", params={"status": "all"})
        assert [r["id"] for r in one.json()] == [fin["id"]]
        assert (await world.get(ADMIN_URL, params={"status": "maybe"})).status_code == 400


async def test_approving_grants_the_role_until_the_date_and_says_so(world, db_session):
    req = (await _submit(world, db_session)).json()
    async with acting_as(db_session, "bob"):
        res = await world.post(f"{ADMIN_URL}/{req['id']}/approve", json={"expiresIn": "30d", "note": "Welcome"})
    assert res.status_code == 200, res.text
    body = res.json()
    assert (body["status"], body["grantedRole"], body["idpException"], body["resolvedBy"]) == (
        "approved", "workspace_member", False, "usr_bob",
    )
    [binding] = await _ana_bindings(db_session)
    assert (binding.role_name, binding.scope_id, binding.granted_by, binding.access_request_id) == (
        "workspace_member", WS, "usr_bob", req["id"],
    )
    assert binding.expires_at == body["accessExpiresAt"] and binding.expires_at
    assert [e["binding_id"] for e in await _events(db_session, "rbac.workspace.member_bound")] == [binding.id]
    assert [e["granted_role"] for e in await _events(db_session, "rbac.access_request.approved")] == [
        "workspace_member",
    ]
    [note] = await _notes(db_session, "access_request.approved")
    assert (note.user_id, note.title, note.link) == ("usr_ana", "You can now open Finance", f"/workspaces/{WS}")
    assert note.body == f"You were granted Member until {binding.expires_at[:10]}. Welcome"

    # Answered once: the next answer is refused, and Ana can read the name now.
    async with acting_as(db_session, "wanda"):
        assert (await world.post(f"{ADMIN_URL}/{req['id']}/deny")).status_code == 409
    async with acting_as(db_session, "ana"):
        assert (await world.get("/api/v1/me/access-requests")).json()[0]["target"]["label"] == "Finance"


async def test_a_steward_lets_people_in_as_viewer_or_member_only(world, db_session):
    req = (await _submit(world, db_session, role="workspace_data_engineer")).json()
    async with acting_as(db_session, "bob"):
        refused = await world.post(f"{ADMIN_URL}/{req['id']}/approve")
        assert refused.status_code == 403
        assert "Viewer or Member" in refused.json()["detail"]
        assert (await world.post(f"{ADMIN_URL}/{req['id']}/approve", json={"role": "workspace_admin"})).status_code == 403
        res = await world.post(f"{ADMIN_URL}/{req['id']}/approve", json={"role": "workspace_viewer"})
    assert (res.status_code, res.json()["grantedRole"]) == (200, "workspace_viewer")


async def test_approving_as_asked_never_grants_authority(world, db_session):
    # A request from before only access could be asked for.
    row = AccessRequestORM(
        requester_id="usr_ana", target_type="workspace", target_id=WS,
        requested_role="workspace_admin", status="pending",
    )
    db_session.add(row)
    await db_session.flush()
    async with acting_as(db_session, "wanda"):
        assert (await world.post(f"{ADMIN_URL}/{row.id}/approve")).status_code == 400
        # Chosen deliberately, an admin may grant it.
        res = await world.post(f"{ADMIN_URL}/{row.id}/approve", json={"role": "workspace_admin"})
    assert (res.status_code, res.json()["grantedRole"]) == (200, "workspace_admin")


async def test_nobody_answers_their_own_request_or_one_they_cannot(world, db_session):
    req = (await _submit(world, db_session)).json()
    async with acting_as(db_session, "max"):
        assert (await world.post(f"{ADMIN_URL}/{req['id']}/approve")).status_code == 403
    # Ana becomes a steward while her request is open: still not hers to answer.
    db_session.add(RoleBindingORM(
        subject_type="user", subject_id="usr_ana", role_name="workspace_steward",
        scope_type="workspace", scope_id=WS,
    ))
    await db_session.flush()
    async with acting_as(db_session, "ana"):
        res = await world.post(f"{ADMIN_URL}/{req['id']}/approve")
    assert (res.status_code, res.json()["detail"]) == (403, "You can't answer your own request")
    async with acting_as(db_session, "bob"):
        assert (await world.post(f"{ADMIN_URL}/ar_nope/approve")).status_code == 404


async def test_approving_makes_a_lapsed_grant_current_again(world, db_session):
    lapsed = RoleBindingORM(
        subject_type="user", subject_id="usr_ana", role_name="workspace_member",
        scope_type="workspace", scope_id=WS, expires_at=days_ago(3), source="sso",
    )
    db_session.add(lapsed)
    await db_session.flush()
    req = (await _submit(world, db_session)).json()
    async with acting_as(db_session, "bob"):
        assert (await world.post(f"{ADMIN_URL}/{req['id']}/approve")).status_code == 200
    assert [(b.id, b.expires_at, b.source, b.access_request_id, b.granted_by) for b in await _ana_bindings(db_session)] == [
        (lapsed.id, None, "local", req["id"], "usr_bob"),
    ]
    [event] = await _events(db_session, "rbac.workspace.member_bound")
    assert event["reactivated"] is True


async def test_approving_into_a_team_whose_every_role_the_answerer_could_grant(world, db_session):
    await _team(db_session, "grp_close")
    await _team(db_session, "grp_global", extra=[("org_admin", "global", None)])
    await _team(db_session, "grp_locked", protected=True)
    await _team(db_session, "grp_scim", source="scim")
    await _team(db_session, "grp_wide", extra=[("workspace_admin", "workspace", WS_OTHER)])
    async with acting_as(db_session, "bob"):
        options = (await world.get(f"/api/v1/admin/workspaces/{WS}/members/grant-options")).json()
    assert [(g["id"], g["roles"]) for g in options["groups"]] == [("grp_close", ["workspace_member"])]

    req = (await _submit(world, db_session)).json()
    async with acting_as(db_session, "bob"):
        for gid in ("grp_global", "grp_locked", "grp_scim", "grp_wide", "grp_nope"):
            refused = await world.post(f"{ADMIN_URL}/{req['id']}/approve", json={"groupId": gid})
            assert refused.status_code == 403, gid
        assert (await world.post(
            f"{ADMIN_URL}/{req['id']}/approve", json={"groupId": "grp_close", "expiresIn": "7d"},
        )).status_code == 422
        res = await world.post(f"{ADMIN_URL}/{req['id']}/approve", json={"groupId": "grp_close"})
    assert res.status_code == 200, res.text
    assert (res.json()["grantedGroup"], res.json()["grantedRole"]) == ({"id": "grp_close", "name": "Grp_Close"}, None)
    member = await db_session.get(GroupMemberORM, ("grp_close", "usr_ana"))
    assert (member.added_by, member.access_request_id, member.source) == ("usr_bob", req["id"], "local")
    [event] = await _events(db_session, "rbac.group.member_added")
    assert (event["via"], event["access_request_id"]) == ("access_request", req["id"])
    [note] = await _notes(db_session, "access_request.approved")
    assert note.body == "You were added to the team “Grp_Close”."


async def test_denying_tells_the_requester_why(world, db_session):
    req = (await _submit(world, db_session)).json()
    async with acting_as(db_session, "bob"):
        res = await world.post(f"{ADMIN_URL}/{req['id']}/deny", json={"note": "Finance is closed to contractors"})
    assert (res.status_code, res.json()["status"], res.json()["resolutionNote"]) == (
        200, "denied", "Finance is closed to contractors",
    )
    [note] = await _notes(db_session, "access_request.denied")
    # Ana can't see Finance (the directory is off), so the Inbox doesn't name it.
    assert (note.user_id, note.title, note.body) == (
        "usr_ana", "Your request to join the workspace was declined", "Finance is closed to contractors",
    )


# ── When the identity provider decides ───────────────────────────────


async def test_granting_in_the_app_is_an_exception_said_out_loud(world, db_session):
    await _idp_run(db_session)
    await _team(db_session, "grp_close")
    req = (await _submit(world, db_session)).json()
    async with acting_as(db_session, "bob"):
        for body in ({}, {"groupId": "grp_close"}):
            refused = await world.post(f"{ADMIN_URL}/{req['id']}/approve", json=body)
            assert refused.status_code == 409, body
            assert refused.json()["detail"]["type"] == "idp_managed"
    # Exceptions are the admins' (see test_workspace_access_hardening).
    async with acting_as(db_session, "wanda"):
        res = await world.post(f"{ADMIN_URL}/{req['id']}/approve", json={"exception": True, "expiresIn": "30d"})
    assert (res.status_code, res.json()["idpException"]) == (200, True)
    [binding] = await _ana_bindings(db_session)
    assert (binding.idp_exception, binding.access_request_id) == (True, req["id"])


async def test_pointing_to_the_identity_provider_waits_for_the_access_to_arrive(world, db_session):
    provider = await _idp_run(db_session)
    db_session.add(UserIdentityORM(user_id="usr_ana", provider_id=provider.id, external_id="sub-ana"))
    await db_session.flush()
    req = (await _submit(world, db_session)).json()
    route = f"{ADMIN_URL}/{req['id']}/route"
    async with acting_as(db_session, "bob"):
        assert (await world.post(route, json={"idpGroup": "nobody-maps-this"})).status_code == 400
        # finance-admins makes administrators: more than a steward could grant.
        assert (await world.post(route, json={"idpGroup": "finance-admins"})).status_code == 403
        res = await world.post(route, json={"idpGroup": "finance-analysts", "note": "Ask the service desk"})
    assert res.status_code == 200, res.text
    body = res.json()
    assert (body["status"], body["idpGroup"], body["idpProvider"], body["requester"]["ssoLinked"]) == (
        "awaiting_idp", "finance-analysts", "Entra ID", True,
    )
    [note] = await _notes(db_session, "access_request.routed")
    assert note.user_id == "usr_ana"
    assert note.body.startswith("Ask your IT team to add you to “finance-analysts” in Entra ID.")
    assert note.body.endswith("Ask the service desk")

    # Still open: asking again returns it, and it can't be pointed elsewhere.
    assert (await _submit(world, db_session)).status_code == 200
    async with acting_as(db_session, "bob"):
        assert (await world.post(route, json={"idpGroup": "finance-analysts"})).status_code == 409

    # A sign-in that brings other groups changes nothing...
    out = await reconcile_sso_targets(db_session, user_id="usr_ana", idp_groups=["marketing"], provider_id=provider.id)
    assert out["requests_fulfilled"] == 0
    assert (await db_session.get(AccessRequestORM, req["id"])).status == "awaiting_idp"
    # ...the one that brings finance-analysts closes it.
    out = await reconcile_sso_targets(
        db_session, user_id="usr_ana", idp_groups=["finance-analysts"], provider_id=provider.id,
    )
    assert out["requests_fulfilled"] == 1
    row = await db_session.get(AccessRequestORM, req["id"])
    assert (row.status, row.resolved_by, row.idp_group) == ("approved", "usr_bob", "finance-analysts")
    assert row.fulfilled_at
    assert [(n.user_id, n.title) for n in await _notes(db_session, "access_request.fulfilled")] == [
        ("usr_ana", "You can now open Finance"), ("usr_bob", "Access to Finance arrived"),
    ]
    assert [e["idp_group"] for e in await _events(db_session, "rbac.access_request.fulfilled")] == ["finance-analysts"]


async def test_access_through_a_team_the_identity_provider_fills_closes_it_too(world, db_session):
    provider = await _idp_run(db_session)
    await _team(db_session, "grp_analysts", role="workspace_viewer")
    await idp_group_mapping_repo.create_group_membership_mapping(
        db_session, idp_group="fin-team", target_group_id="grp_analysts", provider_id=provider.id,
    )
    req = (await _submit(world, db_session, role="workspace_viewer")).json()
    async with acting_as(db_session, "bob"):
        options = (await world.get(f"/api/v1/admin/workspaces/{WS}/members/grant-options")).json()
        assert {"idpGroup": "fin-team", "provider": "Entra ID", "role": "workspace_viewer",
                "viaGroupId": "grp_analysts", "viaGroupName": "Grp_Analysts"} in options["idpRoutes"]
        assert (await world.post(f"{ADMIN_URL}/{req['id']}/route", json={"idpGroup": "fin-team"})).status_code == 200
    out = await reconcile_sso_targets(db_session, user_id="usr_ana", idp_groups=["fin-team"], provider_id=provider.id)
    assert (out["memberships_added"], out["requests_fulfilled"]) == (1, 1)


async def test_a_workspace_decided_here_is_never_pointed_to_the_identity_provider(world, db_session):
    req = (await _submit(world, db_session)).json()
    async with acting_as(db_session, "bob"):
        res = await world.post(f"{ADMIN_URL}/{req['id']}/route", json={"idpGroup": "finance-analysts"})
    assert res.status_code == 409


async def test_a_request_waiting_on_the_identity_provider_can_still_be_denied(world, db_session):
    await _idp_run(db_session)
    req = (await _submit(world, db_session)).json()
    async with acting_as(db_session, "bob"):
        await world.post(f"{ADMIN_URL}/{req['id']}/route", json={"idpGroup": "finance-analysts"})
        res = await world.post(f"{ADMIN_URL}/{req['id']}/deny")
    assert (res.status_code, res.json()["status"]) == (200, "denied")
    [note] = await _notes(db_session, "access_request.denied")
    assert note.body == "No reason was given."


# ── The Members tab ──────────────────────────────────────────────────


async def test_a_steward_adds_people_on_the_members_tab_within_the_same_ceiling(world, db_session):
    url = f"/api/v1/admin/workspaces/{WS}/members"
    db_session.add(GroupORM(id="grp_x", name="X"))
    await db_session.flush()
    async with acting_as(db_session, "bob"):
        assert (await world.get(url)).status_code == 200
        assert (await world.get(f"{url}/effective")).status_code == 200
        added = await world.post(url, json={"subjectType": "user", "subjectId": "usr_ana", "role": "workspace_viewer"})
        assert added.status_code == 201, added.text
        assert (await world.post(
            url, json={"subjectType": "user", "subjectId": "usr_ana", "role": "workspace_admin"},
        )).status_code == 403
        assert (await world.post(
            url, json={"subjectType": "group", "subjectId": "grp_x", "role": "workspace_viewer"},
        )).status_code == 403
        # Removing people stays with admins.
        removed = await world.delete(f"{url}/{added.json()['bindingId']}")
        assert removed.status_code == 403
    async with acting_as(db_session, "max"):
        assert (await world.get(url)).status_code == 403


async def test_adding_a_person_where_the_identity_provider_decides_is_an_exception(world, db_session):
    await _idp_run(db_session)
    url = f"/api/v1/admin/workspaces/{WS}/members"
    db_session.add(GroupORM(id="grp_x", name="X"))
    await db_session.flush()
    person = {"subjectType": "user", "subjectId": "usr_ana", "role": "workspace_viewer"}
    async with acting_as(db_session, "wanda"):
        refused = await world.post(url, json=person)
        assert (refused.status_code, refused.json()["detail"]["type"]) == (409, "idp_managed")
        assert (await world.post(url, json={**person, "exception": True, "expiresIn": "30d"})).status_code == 201
        # A group is bound as ever.
        assert (await world.post(
            url, json={"subjectType": "group", "subjectId": "grp_x", "role": "workspace_viewer"},
        )).status_code == 201
    [binding] = await _ana_bindings(db_session)
    assert binding.idp_exception is True


async def test_adding_someone_whose_grant_lapsed_makes_it_current_again(world, db_session):
    lapsed = RoleBindingORM(
        subject_type="user", subject_id="usr_ana", role_name="workspace_viewer",
        scope_type="workspace", scope_id=WS, expires_at=days_ago(1),
    )
    db_session.add(lapsed)
    await db_session.flush()
    url = f"/api/v1/admin/workspaces/{WS}/members"
    person = {"subjectType": "user", "subjectId": "usr_ana", "role": "workspace_viewer"}
    async with acting_as(db_session, "wanda"):
        res = await world.post(url, json=person)
        assert (res.status_code, res.json()["bindingId"], res.json()["expiresAt"]) == (201, lapsed.id, None)
        assert (await world.post(url, json=person)).status_code == 409


async def test_grant_options_are_what_the_caller_could_grant(world, db_session):
    await _idp_run(db_session)
    url = f"/api/v1/admin/workspaces/{WS}/members/grant-options"
    async with acting_as(db_session, "bob"):
        steward = (await world.get(url)).json()
    assert (steward["tier"], steward["accessMode"]) == ("steward", "idp")
    assert [r["name"] for r in steward["roles"]] == ["workspace_viewer", "workspace_member"]
    assert [r["idpGroup"] for r in steward["idpRoutes"]] == ["finance-analysts"]
    async with acting_as(db_session, "wanda"):
        admin = (await world.get(url)).json()
    assert admin["tier"] == "admin"
    assert [r["name"] for r in admin["roles"]] == [
        "workspace_viewer", "workspace_member", "workspace_data_engineer",
        "workspace_admin", "workspace_steward",
    ]
    assert [(r["idpGroup"], r["role"]) for r in admin["idpRoutes"]] == [
        ("finance-admins", "workspace_admin"), ("finance-analysts", "workspace_viewer"),
    ]
    async with acting_as(db_session, "max"):
        assert (await world.get(url)).status_code == 403


async def test_deleting_a_workspace_closes_its_open_requests(world, db_session):
    req = (await _submit(world, db_session)).json()
    async with acting_as(db_session, "wanda"):
        res = await world.delete(f"/api/v1/admin/workspaces/{WS}")
    assert res.status_code < 300, res.text
    row = await db_session.get(AccessRequestORM, req["id"])
    assert (row.status, row.resolution_note, row.resolved_by) == ("denied", "The workspace was deleted", "usr_wanda")


# ── How every grant came about ───────────────────────────────────────


async def _person(session, uid: str) -> None:
    session.add(UserORM(
        id=uid, email=f"{uid}@example.com", password_hash="x", first_name=uid[4:].title(),
        last_name="T", status="active", created_at="2024-01-01T00:00:00Z", updated_at="2024-01-01T00:00:00Z",
    ))
    await session.flush()


async def test_people_with_access_say_how_each_grant_came_about(world, db_session):
    provider = await _idp_run(db_session)
    for uid in ("usr_tess", "usr_ivy", "usr_eve"):
        await _person(db_session, uid)
    # Tess: a team someone added her to.
    await _team(db_session, "grp_close")
    db_session.add(GroupMemberORM(group_id="grp_close", user_id="usr_tess", added_by="usr_wanda"))
    # Ivy: her identity provider's group; her last sign-in asserted two groups.
    (await db_session.get(UserORM, "usr_ivy")).metadata_ = json.dumps({"idp_groups": ["finance-analysts", "everyone"]})
    await db_session.flush()
    await reconcile_sso_targets(db_session, user_id="usr_ivy", idp_groups=["finance-analysts"], provider_id=provider.id)
    # Ana: an approved request; Eve: an exception.
    req = (await _submit(world, db_session)).json()
    async with acting_as(db_session, "wanda"):
        approved = await world.post(
            f"{ADMIN_URL}/{req['id']}/approve", json={"exception": True, "expiresIn": "30d"},
        )
        assert approved.status_code == 200, approved.text
        added = await world.post(
            f"/api/v1/admin/workspaces/{WS}/members",
            json={
                "subjectType": "user", "subjectId": "usr_eve", "role": "workspace_viewer",
                "exception": True, "expiresIn": "30d",
            },
        )
        assert added.status_code == 201, added.text
    (await db_session.get(WorkspaceORM, WS)).access_mode = "app"
    await db_session.flush()

    async with acting_as(db_session, "bob"):
        res = await world.get(f"/api/v1/admin/workspaces/{WS}/members/effective")
    assert res.status_code == 200, res.text
    body = res.json()
    how = {u["userId"]: [(g["via"], g["provenance"]) for g in u["grants"]] for u in body["users"]}

    [(via, max_)] = how["usr_max"]
    assert (via, max_["origin"], max_["by"]) == ("direct", "direct", None)
    [(via, tess)] = how["usr_tess"]
    assert (via, tess["origin"], tess["source"], tess["by"]) == ("group", "team", "Grp_Close", "usr_wanda")
    [(via, ivy)] = how["usr_ivy"]
    assert (via, ivy["origin"], ivy["idpGroups"], ivy["idpProvider"]) == (
        "direct", "idp", ["finance-analysts"], "Entra ID",
    )
    [(via, ana)] = how["usr_ana"]
    assert (ana["origin"], ana["by"], ana["requestId"]) == ("exception", "usr_wanda", req["id"])
    [(via, eve)] = how["usr_eve"]
    assert (eve["origin"], eve["by"], eve["requestId"]) == ("exception", "usr_wanda", None)

    # Organization-wide people are listed, marked as such.
    [(via, olga)] = how["usr_olga"]
    assert (via, olga["origin"], olga["source"]) == ("org", "org_role", "org_admin")
    assert body["orgWideUsers"] == 1
    assert next(u for u in body["users"] if u["userId"] == "usr_olga")["effectiveRole"] == "org_admin"


async def test_an_approved_request_reads_as_one_on_people_with_access(world, db_session):
    req = (await _submit(world, db_session)).json()
    async with acting_as(db_session, "bob"):
        await world.post(f"{ADMIN_URL}/{req['id']}/approve")
        users = (await world.get(f"/api/v1/admin/workspaces/{WS}/members/effective")).json()["users"]
    [grant] = next(u for u in users if u["userId"] == "usr_ana")["grants"]
    assert (grant["provenance"]["origin"], grant["provenance"]["by"], grant["provenance"]["requestId"]) == (
        "request", "usr_bob", req["id"],
    )


async def test_my_access_says_how_each_binding_came_about_and_drops_lapsed_ones(world, db_session):
    await _team(db_session, "grp_close", role="workspace_viewer")
    db_session.add(GroupMemberORM(group_id="grp_close", user_id="usr_ana", added_by="usr_wanda"))
    db_session.add(RoleBindingORM(
        subject_type="user", subject_id="usr_ana", role_name="workspace_member",
        scope_type="workspace", scope_id=WS_OTHER, expires_at=days_ago(1),
    ))
    await db_session.flush()
    req = (await _submit(world, db_session, role="workspace_data_engineer")).json()
    async with acting_as(db_session, "wanda"):
        await world.post(f"{ADMIN_URL}/{req['id']}/approve", json={"expiresIn": "7d"})
    async with acting_as(db_session, "ana"):
        res = await world.get("/api/v1/me/access")
    assert res.status_code == 200, res.text
    body = res.json()
    # The lapsed Operations grant is gone; the approved one says how, and until when.
    [direct] = body["directBindings"]
    assert (direct["role"], direct["scope"]["id"], direct["provenance"]["origin"]) == (
        "workspace_data_engineer", WS, "request",
    )
    assert direct["expiresAt"] and direct["provenance"]["requestId"] == req["id"]
    [inherited] = body["inheritedBindings"]
    assert (inherited["viaGroup"]["id"], inherited["provenance"]["origin"], inherited["provenance"]["by"]) == (
        "grp_close", "team", "usr_wanda",
    )
