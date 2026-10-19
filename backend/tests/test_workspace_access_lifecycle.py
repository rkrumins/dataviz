"""Access after it is granted.

* Time-limited access is announced before it ends — a week ahead for a long
  grant, two days ahead for a short one, never for a day or two of cover —
  once per end date; moving the end announces the new one.
* Someone whose access is ending asks to keep it: a request tied to the
  grant, answered within the approver's ceiling, that extends it.
* People hear when they are added, removed, or their end date moves.
* A request nobody answers is brought up again after three days, and to the
  Org Admins after a week — once each.
* An exception ends once the identity provider grants what it did — the
  same role becomes the provider's grant, with no gap.
* A workspace takes requests one of three ways: its approvers decide, it is
  open (anyone joins as a Viewer at once), or it takes none.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import AccessRequestORM, RoleBindingORM, WorkspaceORM
from backend.app.db.repositories import access_request_repo, idp_group_mapping_repo, idp_provider_repo
from backend.app.services import access_housekeeping
from backend.app.services.permission_service import reconcile_sso_targets
from tests.common.workspace_access_world import (
    WS,
    WS_OTHER,
    acting_as,
    build_world,
    days_ago,
    events,
    in_days,
    notes,
    seed_steward_catalogue,
)

URL = "/api/v1/access-requests"
ADMIN_URL = "/api/v1/admin/access-requests"
MEMBERS = f"/api/v1/admin/workspaces/{WS}/members"


@pytest.fixture(autouse=True)
async def _steward_catalogue(db_session: AsyncSession):
    await seed_steward_catalogue(db_session)


@pytest.fixture()
async def world(db_session: AsyncSession, test_client):
    await build_world(db_session)
    return test_client


async def _grant(session, *, who="usr_ana", role="workspace_member", granted=days_ago(30),
                 ends=in_days(5), source="local", by="usr_wanda", **extra) -> RoleBindingORM:
    binding = RoleBindingORM(
        subject_type="user", subject_id=who, role_name=role, scope_type="workspace",
        scope_id=extra.pop("ws", WS), granted_at=granted, granted_by=by, expires_at=ends,
        source=source, **extra,
    )
    session.add(binding)
    await session.flush()
    return binding


async def _idp_finance(session, role="workspace_viewer"):
    """Finance's access decided by Entra ID: finance-analysts → ``role``."""
    (await session.get(WorkspaceORM, WS)).access_mode = "idp"
    provider = await idp_provider_repo.create_provider(
        session, slug="entra", display_name="Entra ID", kind="oidc", settings={},
    )
    await idp_group_mapping_repo.create_role_binding_mapping(
        session, idp_group="finance-analysts", role_name=role, scope_type="workspace",
        scope_id=WS, provider_id=provider.id,
    )
    await session.flush()
    return provider


# ── Access about to end ──────────────────────────────────────────────


async def test_access_ending_is_announced_once_a_week_ahead(world, db_session):
    binding = await _grant(db_session, ends=in_days(5.04))
    assert await access_housekeeping.remind_expiring(db_session) == 1
    [note] = await notes(db_session, "access.expiring")
    assert (note.user_id, note.title, note.link) == ("usr_ana", "Your access to Finance ends in 5 days", "/my/access")
    assert note.body.startswith("Your Member access ends on ")
    assert binding.expiry_reminded_at
    [event] = await events(db_session, "rbac.workspace.access_expiring")
    assert (event["binding_id"], event["user_id"]) == (binding.id, "usr_ana")
    # Once per end date.
    assert await access_housekeeping.remind_expiring(db_session) == 0


async def test_a_short_grant_hears_two_days_ahead_and_a_day_of_cover_never(world, db_session):
    week = await _grant(db_session, granted=days_ago(3), ends=in_days(4))
    day = await _grant(db_session, who="usr_max", role="workspace_viewer", granted=days_ago(1), ends=in_days(0.5))
    assert await access_housekeeping.remind_expiring(db_session) == 0
    assert week.expiry_reminded_at is None  # not yet: asked again on a later pass
    assert day.expiry_reminded_at  # looked at, and needs no reminder
    later = datetime.now(timezone.utc) + timedelta(days=2.5)
    assert await access_housekeeping.remind_expiring(db_session, now=later) == 1
    assert [n.user_id for n in await notes(db_session, "access.expiring")] == ["usr_ana"]


async def test_only_peoples_own_grants_made_here_are_announced(world, db_session):
    await _grant(db_session, source="sso")
    await _grant(db_session, who="usr_max", role="workspace_viewer", ends=None)
    db_session.add(RoleBindingORM(
        subject_type="group", subject_id="grp_x", role_name="workspace_viewer", scope_type="workspace",
        scope_id=WS, granted_at=days_ago(30), expires_at=in_days(3),
    ))
    await db_session.flush()
    assert await access_housekeeping.remind_expiring(db_session) == 0


async def test_moving_the_end_announces_the_new_one(world, db_session):
    binding = await _grant(db_session)
    await access_housekeeping.remind_expiring(db_session)
    async with acting_as(db_session, "wanda"):
        res = await world.put(f"{MEMBERS}/{binding.id}/expiry", json={"expiresIn": "7d"})
    assert res.status_code == 200, res.text
    assert binding.expiry_reminded_at is None
    [note] = await notes(db_session, "workspace.access_end_changed")
    assert note.title.startswith("Your access to Finance now ends on ")
    async with acting_as(db_session, "wanda"):
        await world.put(f"{MEMBERS}/{binding.id}/expiry", json={})
    titles = [n.title for n in await notes(db_session, "workspace.access_end_changed")]
    assert "Your access to Finance no longer ends" in titles


# ── Asking to keep it ────────────────────────────────────────────────


async def test_asking_to_keep_access_extends_it_when_approved(world, db_session):
    binding = await _grant(db_session, ends=in_days(3))
    async with acting_as(db_session, "ana"):
        res = await world.post(f"{URL}/extend", json={"bindingId": binding.id, "justification": "Audit runs late"})
        again = await world.post(f"{URL}/extend", json={"bindingId": binding.id})
    assert res.status_code == 201, res.text
    body = res.json()
    assert (body["bindingId"], body["requestedRole"], body["status"]) == (binding.id, "workspace_member", "pending")
    assert body["currentExpiresAt"] == binding.expires_at
    assert (again.status_code, again.json()["id"]) == (200, body["id"])
    asked = await notes(db_session, "access_request.submitted")
    assert {n.user_id for n in asked} == {"usr_bob", "usr_wanda"}
    assert asked[0].title == "Ana T asks to keep their access to Finance"

    async with acting_as(db_session, "bob"):
        res = await world.post(f"{ADMIN_URL}/{body['id']}/approve", json={"expiresIn": "30d"})
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "approved"
    await db_session.refresh(binding)
    ends = datetime.fromisoformat(binding.expires_at)
    assert timedelta(days=29) < ends - datetime.now(timezone.utc) < timedelta(days=31)
    assert res.json()["accessExpiresAt"] == binding.expires_at
    [note] = await notes(db_session, "access_request.approved")
    assert note.title == "You can keep your access to Finance"
    assert note.body.startswith("Your Member access now ends on ")


async def test_only_your_own_time_limited_grant_made_here_can_be_kept(world, db_session):
    someone_elses = await _grant(db_session, who="usr_max", role="workspace_viewer")
    for_good = await _grant(db_session, role="workspace_viewer", ends=None)
    from_idp = await _grant(db_session, ws=WS_OTHER, source="sso")
    lapsed = await _grant(db_session, role="workspace_data_engineer", ends=days_ago(1))
    async with acting_as(db_session, "ana"):
        assert (await world.post(f"{URL}/extend", json={"bindingId": someone_elses.id})).status_code == 404
        for b in (for_good, from_idp, lapsed):
            assert (await world.post(f"{URL}/extend", json={"bindingId": b.id})).status_code == 409


async def test_one_open_request_per_workspace_never_answers_for_another(world, db_session):
    binding = await _grant(db_session, role="workspace_viewer")
    async with acting_as(db_session, "ana"):
        more = await world.post(URL, json={
            "targetType": "workspace", "targetId": WS, "requestedRole": "workspace_member",
        })
        keep = await world.post(f"{URL}/extend", json={"bindingId": binding.id})
        assert (more.status_code, keep.status_code) == (201, 409)
        assert "Withdraw it" in keep.json()["detail"]
        await world.post(f"/api/v1/me/access-requests/{more.json()['id']}/withdraw")
        assert (await world.post(f"{URL}/extend", json={"bindingId": binding.id})).status_code == 201
        again = await world.post(URL, json={
            "targetType": "workspace", "targetId": WS, "requestedRole": "workspace_member",
        })
    assert again.status_code == 409
    assert "keep your access" in again.json()["detail"]


async def test_keeping_access_stays_within_the_approvers_ceiling(world, db_session):
    binding = await _grant(db_session, role="workspace_data_engineer")
    async with acting_as(db_session, "ana"):
        req = (await world.post(f"{URL}/extend", json={"bindingId": binding.id})).json()
    async with acting_as(db_session, "bob"):
        assert (await world.post(f"{ADMIN_URL}/{req['id']}/approve", json={"expiresIn": "30d"})).status_code == 403
    async with acting_as(db_session, "wanda"):
        res = await world.post(f"{ADMIN_URL}/{req['id']}/approve", json={})
    assert res.status_code == 200, res.text
    await db_session.refresh(binding)
    assert binding.expires_at is None  # no end chosen: it no longer ends


async def test_an_admin_moving_the_end_answers_the_request_to_keep_it(world, db_session):
    binding = await _grant(db_session)
    async with acting_as(db_session, "ana"):
        req = (await world.post(f"{URL}/extend", json={"bindingId": binding.id})).json()
    async with acting_as(db_session, "wanda"):
        await world.put(f"{MEMBERS}/{binding.id}/expiry", json={"expiresIn": "90d"})
    row = await db_session.get(AccessRequestORM, req["id"])
    assert (row.status, row.resolved_by, row.access_expires_at) == ("approved", "usr_wanda", binding.expires_at)


# ── Hearing about changes ────────────────────────────────────────────


async def test_people_hear_when_added_and_removed(world, db_session):
    async with acting_as(db_session, "wanda"):
        added = await world.post(MEMBERS, json={
            "subjectType": "user", "subjectId": "usr_ana", "role": "workspace_viewer", "expiresIn": "7d",
        })
        assert added.status_code == 201, added.text
        removed = await world.delete(f"{MEMBERS}/{added.json()['bindingId']}")
        assert removed.status_code == 204
    [note] = await notes(db_session, "workspace.member_added")
    assert (note.user_id, note.title, note.actor_id) == ("usr_ana", "You were added to Finance", "usr_wanda")
    assert note.body.startswith("As Viewer until ")
    [note] = await notes(db_session, "workspace.member_removed")
    assert (note.user_id, note.title) == ("usr_ana", "You no longer have access to Finance")


async def test_losing_one_of_several_grants_says_so(world, db_session):
    other = await _grant(db_session, role="workspace_viewer", ends=None)
    await _grant(db_session, ends=None)
    async with acting_as(db_session, "wanda"):
        await world.delete(f"{MEMBERS}/{other.id}")
    [note] = await notes(db_session, "workspace.member_removed")
    assert note.title == "Your Viewer access to Finance was removed"


# ── Requests nobody answers ──────────────────────────────────────────


async def _waiting(session, *, ws=WS, days=4, status="pending") -> AccessRequestORM:
    row, _ = await access_request_repo.create(
        session, requester_id="usr_ana", target_type="workspace", target_id=ws,
        requested_role="workspace_viewer",
    )
    row.created_at = days_ago(days)
    if status == "awaiting_idp":
        row.status, row.resolved_at, row.resolved_by, row.idp_group = status, days_ago(1), "usr_bob", "g"
    await session.flush()
    return row


async def test_a_waiting_request_is_brought_up_after_three_days_then_to_the_org_admins(world, db_session):
    row = await _waiting(db_session, days=4)
    assert await access_housekeeping.nudge_waiting_requests(db_session) == (1, 0)
    reminders = await notes(db_session, "access_request.reminder")
    assert {n.user_id for n in reminders} == {"usr_bob", "usr_wanda"}
    assert reminders[0].title == "Ana T is still waiting to join Finance"
    assert row.reminded_at and row.escalated_at is None

    row.created_at = days_ago(8)
    assert await access_housekeeping.nudge_waiting_requests(db_session) == (0, 1)
    [note] = await notes(db_session, "access_request.escalated")
    assert (note.user_id, note.title) == ("usr_olga", "Nobody has answered Ana T's request to join Finance")
    assert [e["request_id"] for e in await events(db_session, "rbac.access_request.escalated")] == [row.id]
    assert await access_housekeeping.nudge_waiting_requests(db_session) == (0, 0)

    async with acting_as(db_session, "wanda"):
        [listed] = (await world.get(ADMIN_URL)).json()
    assert listed["remindedAt"] and listed["escalatedAt"]


async def test_reminders_reach_the_org_admins_where_nobody_answers(world, db_session):
    await _waiting(db_session, ws=WS_OTHER)
    await access_housekeeping.nudge_waiting_requests(db_session)
    assert [n.user_id for n in await notes(db_session, "access_request.reminder")] == ["usr_olga"]


async def test_requests_waiting_on_the_identity_provider_are_not_brought_up(world, db_session):
    await _waiting(db_session, days=10, status="awaiting_idp")
    assert await access_housekeeping.nudge_waiting_requests(db_session) == (0, 0)


# ── Exceptions the identity provider catches up with ─────────────────


async def _signs_in(session, provider, *groups) -> dict:
    return await reconcile_sso_targets(session, user_id="usr_ana", idp_groups=list(groups), provider_id=provider.id)


async def test_an_exception_becomes_the_identity_providers_grant_once_it_grants_the_same(world, db_session):
    provider = await _idp_finance(db_session)
    exception = await _grant(db_session, role="workspace_viewer", ends=in_days(20), idp_exception=True)
    async with acting_as(db_session, "ana"):
        req = (await world.post(f"{URL}/extend", json={"bindingId": exception.id})).json()

    assert (await _signs_in(db_session, provider, "marketing"))["exceptions_retired"] == 0
    assert (await _signs_in(db_session, provider, "finance-analysts"))["exceptions_retired"] == 1
    await db_session.refresh(exception)
    # The one binding the role can have, now the provider's: no end, no gap.
    assert (exception.source, exception.idp_exception, exception.expires_at, exception.granted_by) == (
        "sso", False, None, None,
    )
    assert [(n.user_id, n.title) for n in await notes(db_session, "access.exception_retired")] == [
        ("usr_ana", "Your access to Finance now comes from your identity provider"),
        ("usr_wanda", "Ana T's exception in Finance has ended"),
    ]
    assert [e["binding_id"] for e in await events(db_session, "rbac.workspace.exception_retired")] == [exception.id]
    assert (await db_session.get(AccessRequestORM, req["id"])).status == "approved"
    async with acting_as(db_session, "wanda"):
        people = (await world.get(f"{MEMBERS}/effective")).json()["users"]
    [ana] = [u for u in people if u["userId"] == "usr_ana"]
    assert ana["grants"][0]["provenance"]["origin"] == "idp"
    # Later sign-ins treat it as the provider's: leaving the group ends it.
    assert (await _signs_in(db_session, provider, "finance-analysts"))["exceptions_retired"] == 0
    await _signs_in(db_session, provider)
    await db_session.refresh(exception)
    assert exception.expires_at is not None


async def test_a_lapsed_exception_does_not_keep_the_identity_providers_grant_out(world, db_session):
    provider = await _idp_finance(db_session)
    lapsed = await _grant(db_session, role="workspace_viewer", ends=days_ago(2), idp_exception=True)
    assert (await _signs_in(db_session, provider, "finance-analysts"))["exceptions_retired"] == 1
    await db_session.refresh(lapsed)
    assert (lapsed.source, lapsed.expires_at) == ("sso", None)


async def test_an_exception_ends_once_the_identity_provider_grants_more(world, db_session):
    provider = await _idp_finance(db_session, role="workspace_member")
    exception = await _grant(db_session, role="workspace_viewer", ends=in_days(20), idp_exception=True)
    assert (await _signs_in(db_session, provider, "finance-analysts"))["exceptions_retired"] == 1
    await db_session.refresh(exception)
    assert datetime.fromisoformat(exception.expires_at) <= datetime.now(timezone.utc)
    roles = (await db_session.execute(
        select(RoleBindingORM.role_name).where(
            RoleBindingORM.subject_id == "usr_ana", RoleBindingORM.source == "sso",
        )
    )).scalars().all()
    assert roles == ["workspace_member"]


async def test_an_exception_the_identity_provider_grants_less_than_stays(world, db_session):
    provider = await _idp_finance(db_session)
    exception = await _grant(db_session, role="workspace_member", ends=in_days(20), idp_exception=True)
    assert (await _signs_in(db_session, provider, "finance-analysts"))["exceptions_retired"] == 0
    await db_session.refresh(exception)
    assert (exception.source, exception.idp_exception) == ("local", True)
    assert datetime.fromisoformat(exception.expires_at) > datetime.now(timezone.utc)


# ── How a workspace takes requests ───────────────────────────────────


async def _policy(world, session, policy, **extra):
    async with acting_as(session, "wanda"):
        return await world.put(f"/api/v1/admin/workspaces/{WS}", json={"requestPolicy": policy, **extra})


async def test_an_open_workspace_lets_anyone_join_as_a_viewer(world, db_session):
    assert (await _policy(world, db_session, "open")).json()["requestPolicy"] == "open"
    async with acting_as(db_session, "ana"):
        options = (await world.get(f"{URL}/requestable-roles", params={"workspaceId": WS})).json()
        joined = await world.post(f"{URL}/join", json={"workspaceId": WS})
    assert (options["requestPolicy"], options["joinRole"]) == ("open", "workspace_viewer")
    assert joined.status_code == 201, joined.text
    assert (joined.json()["status"], joined.json()["grantedRole"]) == ("approved", "workspace_viewer")
    [binding] = (await db_session.execute(
        select(RoleBindingORM).where(RoleBindingORM.subject_id == "usr_ana")
    )).scalars().all()
    assert (binding.role_name, binding.granted_by, binding.access_request_id) == (
        "workspace_viewer", "usr_ana", joined.json()["id"],
    )
    assert [e["user_id"] for e in await events(db_session, "rbac.workspace.member_joined")] == ["usr_ana"]

    async with acting_as(db_session, "ana"):
        assert (await world.post(f"{URL}/join", json={"workspaceId": WS})).status_code == 409
        # More than Viewer is still asked for.
        more = await world.post(URL, json={
            "targetType": "workspace", "targetId": WS, "requestedRole": "workspace_member",
        })
    assert (more.status_code, more.json()["status"]) == (201, "pending")
    async with acting_as(db_session, "wanda"):
        people = (await world.get(f"{MEMBERS}/effective")).json()["users"]
    [ana] = [u for u in people if u["userId"] == "usr_ana"]
    assert ana["grants"][0]["provenance"]["origin"] == "joined"


async def test_a_closed_workspace_takes_no_requests_but_keeps_its_people(world, db_session):
    await _policy(world, db_session, "closed")
    binding = await _grant(db_session)
    async with acting_as(db_session, "max"):
        options = (await world.get(f"{URL}/requestable-roles", params={"workspaceId": WS})).json()
    async with acting_as(db_session, "ana"):
        asked = await world.post(URL, json={
            "targetType": "workspace", "targetId": WS_OTHER, "requestedRole": "workspace_viewer",
        })
        refused = await world.post(URL, json={
            "targetType": "workspace", "targetId": WS, "requestedRole": "workspace_data_engineer",
        })
        joined = await world.post(f"{URL}/join", json={"workspaceId": WS})
        kept = await world.post(f"{URL}/extend", json={"bindingId": binding.id})
    assert (options["requestPolicy"], options["joinRole"]) == ("closed", None)
    assert asked.status_code == 201  # Operations still takes them
    assert (refused.status_code, refused.json()["detail"]["type"]) == (403, "closed")
    assert (joined.status_code, joined.json()["detail"]["type"]) == (403, "not_open")
    assert kept.status_code == 201


async def test_a_workspace_its_identity_provider_decides_cannot_be_open(world, db_session):
    res = await _policy(world, db_session, "open", accessMode="idp")
    assert res.status_code == 422
    assert (await db_session.get(WorkspaceORM, WS)).request_policy == "approval"
    async with acting_as(db_session, "ana"):
        assert (await world.post(f"{URL}/join", json={"workspaceId": WS})).status_code == 403
