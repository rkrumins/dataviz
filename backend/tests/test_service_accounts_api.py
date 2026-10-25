"""Looking after service accounts: who may, what an account may hold, handing over.

Super and org admins (``system:service-accounts:manage``) create service
accounts, give them workspace roles, and hand a leaver's accounts over to a
successor. Each account's managers run it too: they rename it, disable and
enable it — unless an administrator holds it disabled — appoint and remove its
managers, and take its roles away. Nobody may make someone able to act as an
account who would gain what the appointer couldn't grant. A workspace lets an
account in as it does a person: its admins and stewards add it, or answer a
request one of its managers makes for it. A service account is never a
person: it is left out of every list of people, refused by the routes about
one, and can't join a team.
"""
from __future__ import annotations

import contextlib
import json

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from backend.app.api.v1.endpoints import versioning
from backend.app.auth.dependencies import get_permission_claims
from backend.app.db.models import (
    AccessRequestORM,
    GroupMemberORM,
    GroupORM,
    NotificationORM,
    OutboxEventORM,
    RoleBindingORM,
    ServiceAccountORM,
    UserORM,
    ViewActivityLogORM,
    ViewORM,
    WorkspaceORM,
)
from backend.app.db.repositories import analytics_repo, api_key_repo, notification_repo, user_repo
from backend.app.services import workspace_access
from backend.app.services.permission_service import PermissionClaims
from backend.app.services.versioning.service import AccessDenied, GraphVersioningService
from backend.auth_service.core import api_keys

BASE = "/api/v1/admin/service-accounts"
ADMIN = "usr_test000000"  # the test client's own user


@contextlib.contextmanager
def claims(*global_perms: str, ws_perms: dict | None = None):
    from backend.app.main import app

    previous = app.dependency_overrides.get(get_permission_claims)
    app.dependency_overrides[get_permission_claims] = lambda: PermissionClaims(
        sid="sess_test", global_perms=tuple(global_perms), ws_perms=ws_perms or {},
    )
    try:
        yield
    finally:
        app.dependency_overrides[get_permission_claims] = previous


def _person(user_id: str, *, status: str = "active", system: bool = False) -> UserORM:
    return UserORM(
        id=user_id, email=f"{user_id}@example.com", password_hash="not-a-real-hash",
        first_name=user_id.split("_")[1].title(), last_name="P", status=status,
        is_system_account=system,
    )


@pytest.fixture()
async def people(db_session):
    db_session.add_all([
        _person("usr_ada"), _person("usr_bea"), _person("usr_cid", status="suspended"),
        _person("usr_glass", system=True),
    ])
    db_session.add(WorkspaceORM(id="ws_x", name="Sales"))
    db_session.add(GroupORM(id="grp_ops", name="Operations"))
    await db_session.flush()
    db_session.add(GroupMemberORM(group_id="grp_ops", user_id="usr_bea"))
    # The test client's user is a super admin, so it hears about accounts
    # with nobody left.
    db_session.add(RoleBindingORM(
        subject_type="user", subject_id=ADMIN, role_name="super_admin",
        scope_type="global", scope_id=None,
    ))
    await db_session.commit()


async def _create(client, name="Metadata sync", managers=({"type": "user", "id": "usr_ada"},)):
    response = await client.post(BASE, json={
        "name": name, "description": "Reads graph metadata on a schedule",
        "managers": list(managers),
    })
    assert response.status_code == 201, response.text
    return response.json()


async def _events(db_session, prefix: str) -> list[tuple[str, dict]]:
    rows = (await db_session.execute(
        select(OutboxEventORM).where(OutboxEventORM.event_type.like(f"{prefix}%"))
        .order_by(OutboxEventORM.created_at)
    )).scalars().all()
    return [(r.event_type, json.loads(r.payload)) for r in rows]


# ── Who may ─────────────────────────────────────────────────────────


async def test_super_and_org_admins_look_after_service_accounts_and_nobody_else(
    test_client, people,
):
    with claims("system:org-admin", "system:service-accounts:manage"):
        assert (await test_client.get(BASE)).status_code == 200
    with claims("system:audit:read", "system:org-viewer"):
        assert (await test_client.get(BASE)).status_code == 403
        assert (await test_client.post(BASE, json={
            "name": "x", "managers": [{"type": "user", "id": "usr_ada"}],
        })).status_code == 403
    with claims():
        assert (await test_client.get(BASE)).status_code == 403


# ── Creating, and who manages ───────────────────────────────────────


async def test_an_account_is_created_with_its_managers_and_never_signs_in(test_client, db_session, people):
    body = await _create(test_client)
    account_id = body["id"]
    assert account_id.startswith("svc_")
    assert (body["status"], body["managed"], body["singleManager"]) == ("active", True, True)
    assert [(m["type"], m["id"], m["inGoodStanding"]) for m in body["managers"]] == [
        ("user", "usr_ada", True),
    ]
    assert (body["roles"], body["liveKeys"], body["unmanagedSince"]) == ([], 0, None)

    row = await db_session.get(UserORM, account_id)
    assert row.email == f"{account_id}@service-account.invalid"
    assert row.password_hash == "x-disabled-password-x"
    assert (row.first_name, row.status, row.signup_source) == ("Metadata sync", "active", "admin_created")
    assert (await db_session.get(ServiceAccountORM, account_id)).created_by == ADMIN

    events = await _events(db_session, "identity.service_account.")
    assert [e for e, _ in events] == [
        "identity.service_account.created", "identity.service_account.manager_added",
    ]
    assert events[1][1]["manager_id"] == "usr_ada"
    told = (await db_session.execute(
        select(NotificationORM).where(NotificationORM.kind == "service_account_manager_added")
    )).scalars().all()
    assert [(n.user_id, n.link) for n in told] == [("usr_ada", f"/service-accounts/{account_id}")]


@pytest.mark.parametrize("manager,expected", [
    ({"type": "user", "id": "usr_nobody"}, 404),
    ({"type": "user", "id": "usr_cid"}, 409),        # suspended
    ({"type": "user", "id": "usr_glass"}, 409),      # break-glass
    ({"type": "user", "id": "svc_0123456789ab"}, 422),
    ({"type": "group", "id": "grp_nope"}, 404),
])
async def test_only_an_active_person_or_a_team_manages(test_client, people, manager, expected):
    response = await test_client.post(BASE, json={"name": "x", "managers": [manager]})
    assert response.status_code == expected, response.text


async def test_a_team_answers_for_an_account_while_anyone_in_it_can(test_client, db_session, people):
    account = await _create(test_client)
    added = await test_client.put(f"{BASE}/{account['id']}/managers/groups/grp_ops")
    assert added.status_code == 200, added.text
    team = next(m for m in added.json()["managers"] if m["type"] == "group")
    assert (team["name"], team["inGoodStanding"], team["membersInGoodStanding"]) == ("Operations", True, 1)
    assert added.json()["singleManager"] is False   # Ada, and Bea through the team

    # Ada goes; the team still answers for it.
    gone = await test_client.delete(f"{BASE}/{account['id']}/managers/users/usr_ada")
    assert gone.status_code == 200
    assert (gone.json()["managed"], gone.json()["unmanagedSince"]) == (True, None)

    # The team's last member goes too: nobody is left, and the clock starts.
    await test_client.delete("/api/v1/admin/groups/grp_ops/members/usr_bea")
    after = (await test_client.get(f"{BASE}/{account['id']}")).json()
    assert after["managed"] is False
    assert after["unmanagedSince"] and after["pausesAt"]
    told = (await db_session.execute(
        select(NotificationORM).where(NotificationORM.kind == "service_account_unmanaged")
    )).scalars().all()
    assert [n.user_id for n in told] == [ADMIN]

    # Someone joins the team, and the account is managed again at once.
    await test_client.post("/api/v1/admin/groups/grp_ops/members", json={"userId": "usr_ada"})
    again = (await test_client.get(f"{BASE}/{account['id']}")).json()
    assert (again["managed"], again["unmanagedSince"]) == (True, None)


async def test_removing_the_last_manager_starts_the_clock_in_the_same_answer(
    test_client, people,
):
    account = await _create(test_client)
    gone = await test_client.delete(f"{BASE}/{account['id']}/managers/users/usr_ada")
    assert gone.status_code == 200
    assert (gone.json()["managed"], gone.json()["managers"]) == (False, [])
    assert gone.json()["unmanagedSince"] and gone.json()["pausesAt"]
    back = await test_client.put(f"{BASE}/{account['id']}/managers/users/usr_bea")
    assert (back.json()["managed"], back.json()["unmanagedSince"]) == (True, None)


async def test_suspending_the_last_manager_is_noticed_at_once(test_client, db_session, people):
    account = await _create(test_client)
    assert (await test_client.post("/api/v1/admin/users/usr_ada/suspend")).status_code == 200
    after = (await test_client.get(f"{BASE}/{account['id']}")).json()
    assert after["unmanagedSince"] is not None
    assert (await test_client.post("/api/v1/admin/users/usr_ada/reactivate")).status_code == 200
    assert (await test_client.get(f"{BASE}/{account['id']}")).json()["unmanagedSince"] is None


# ── Its own details, and its status ─────────────────────────────────


async def test_an_account_is_renamed_disabled_and_enabled(test_client, db_session, people):
    account = await _create(test_client)
    renamed = await test_client.patch(f"{BASE}/{account['id']}", json={"name": "Nightly sync"})
    assert renamed.json()["name"] == "Nightly sync"
    disabled = await test_client.post(f"{BASE}/{account['id']}/disable")
    assert disabled.json()["status"] == "disabled"
    assert (await test_client.post(f"{BASE}/{account['id']}/disable")).status_code == 409
    assert (await test_client.post(f"{BASE}/{account['id']}/enable")).json()["status"] == "active"
    kinds = [e for e, _ in await _events(db_session, "identity.service_account.")]
    assert kinds[-3:] == [
        "identity.service_account.updated", "identity.service_account.disabled",
        "identity.service_account.enabled",
    ]
    # Its managers hear of both: their integration stops, then works again.
    told = (await db_session.execute(
        select(NotificationORM.user_id, NotificationORM.kind, NotificationORM.title)
        .where(NotificationORM.kind.in_(("service_account_disabled", "service_account_enabled")))
        .order_by(NotificationORM.kind)
    )).all()
    assert [tuple(r) for r in told] == [
        ("usr_ada", "service_account_disabled",
         "For “Nightly sync”: An administrator disabled it, and its keys have stopped"),
        ("usr_ada", "service_account_enabled", "For “Nightly sync”: An administrator enabled it again"),
    ]


async def test_joining_a_team_that_manages_an_account_gains_nothing_the_adder_couldnt_grant(
    test_client, db_session, people,
):
    """Whoever joins a team that manages a service account can act as it, so
    adding someone is held to the rule for appointing a manager."""
    svc = (await _create(test_client, managers=({"type": "group", "id": "grp_ops"},)))["id"]
    db_session.add_all([_person("usr_dan"), _person("usr_eve"), _person("usr_fay")])
    await db_session.commit()
    members = "/api/v1/admin/groups/grp_ops/members"
    # It reaches nothing yet, so joining gains nothing.
    with claims("system:groups:manage"):
        joined = await test_client.post(members, json={"userId": "usr_ada"})
    assert joined.status_code == 201, joined.text
    # Those who answer for it hear who can now act as it — not the newcomer.
    assert [(uid, title) for uid, title, _ in await _told(db_session, "service_account_team_joined")] == [
        ("usr_bea", "Ada P can now act as “Metadata sync”"),
    ]

    # Once it is a Member in Sales, a newcomer would gain that.
    assert (await test_client.post(f"{BASE}/{svc}/roles", json={
        "workspaceId": "ws_x", "role": "workspace_member",
    })).status_code == 201
    with claims("system:groups:manage", "system:service-accounts:manage"):
        refused = await test_client.post(members, json={"userId": "usr_dan"})
    assert refused.status_code == 403, refused.text
    assert refused.json()["detail"] == (
        "This team manages service accounts, so whoever joins it can act as them. Whoever "
        "manages a service account can do whatever it can, and Dan P would gain Member in "
        "Sales, which you can't grant"
    )
    # Not someone who holds as much there already, nor anyone added by someone
    # who could grant it there.
    db_session.add(RoleBindingORM(
        subject_type="user", subject_id="usr_dan", role_name="workspace_admin",
        scope_type="workspace", scope_id="ws_x",
    ))
    await db_session.commit()
    with claims("system:groups:manage"):
        assert (await test_client.post(members, json={"userId": "usr_dan"})).status_code == 201
    with claims("system:groups:manage", ws_perms={"ws_x": ("workspace:members:add",)}):
        assert (await test_client.post(members, json={"userId": "usr_eve"})).status_code == 201
    # And when the team's own roles give as much, joining it gains nothing more.
    db_session.add(RoleBindingORM(
        subject_type="group", subject_id="grp_ops", role_name="workspace_member",
        scope_type="workspace", scope_id="ws_x",
    ))
    await db_session.commit()
    with claims("system:groups:manage"):
        assert (await test_client.post(members, json={"userId": "usr_fay"})).status_code == 201

    # Nor can answering an access request put anyone in it.
    db_session.add(GroupORM(id="grp_plain", name="Readers"))
    await db_session.flush()
    db_session.add(RoleBindingORM(
        subject_type="group", subject_id="grp_plain", role_name="workspace_viewer",
        scope_type="workspace", scope_id="ws_x",
    ))
    await db_session.commit()
    org_admin = PermissionClaims(sid="sess_org", global_perms=("system:org-admin",), ws_perms={})
    offered = {g["id"] for g in await workspace_access.addable_groups(db_session, org_admin, "ws_x")}
    assert offered == {"grp_plain"}


async def test_appointing_a_manager_takes_being_able_to_grant_the_accounts_roles(
    test_client, db_session, people,
):
    """A manager can do whatever the account can: whoever appoints one, or
    hands an account over, must be able to grant its roles themselves."""
    svc = (await _create(test_client))["id"]
    assert (await test_client.post(f"{BASE}/{svc}/roles", json={
        "workspaceId": "ws_x", "role": "workspace_viewer",
    })).status_code == 201
    with claims("system:service-accounts:manage"):
        appointed = await test_client.put(f"{BASE}/{svc}/managers/users/usr_bea")
        handed = await test_client.post(f"{BASE}/hand-over", json={
            "fromUserId": "usr_ada", "to": {"type": "user", "id": "usr_bea"},
        })
    assert (appointed.status_code, handed.status_code) == (403, 403)
    with claims("system:org-admin", "system:service-accounts:manage"):
        assert (await test_client.put(f"{BASE}/{svc}/managers/users/usr_bea")).status_code == 200


# ── Its managers run it ─────────────────────────────────────────────


async def _managed_by_me(client, *others: str, name: str = "Metadata sync") -> str:
    """An account the test client's own user manages, with ``others``."""
    managers = [{"type": "user", "id": ADMIN}, *({"type": "user", "id": o} for o in others)]
    return (await _create(client, name=name, managers=managers))["id"]


async def test_its_managers_run_it_without_administering_service_accounts(
    test_client, db_session, people,
):
    svc = await _managed_by_me(test_client, "usr_ada")
    granted = await test_client.post(f"{BASE}/{svc}/roles", json={
        "workspaceId": "ws_x", "role": "workspace_viewer",
    })
    assert granted.status_code == 201
    with claims():
        detail = await test_client.get(f"{BASE}/{svc}")
        assert detail.status_code == 200, detail.text
        assert detail.json()["can"] == {
            "view": True, "edit": True, "disable": True, "enable": True, "managers": True,
            "keys": True, "grant": False, "revoke": True, "request": True,
        }
        assert (await test_client.get(f"/api/v1/me/service-accounts/{svc}")).json()["can"] == detail.json()["can"]
        renamed = await test_client.patch(f"{BASE}/{svc}", json={"name": "Nightly sync"})
        assert renamed.json()["name"] == "Nightly sync"
        disabled = await test_client.post(f"{BASE}/{svc}/disable")
        assert (disabled.json()["status"], disabled.json()["adminHold"]) == ("disabled", False)
        assert (await test_client.post(f"{BASE}/{svc}/enable")).json()["status"] == "active"
        dropped = await test_client.delete(f"{BASE}/{svc}/roles/{granted.json()['bindingId']}")
        assert dropped.status_code == 204
        # Giving it roles, and the whole inventory, stay the administrators'.
        refused = await test_client.post(f"{BASE}/{svc}/roles", json={
            "workspaceId": "ws_x", "role": "workspace_viewer",
        })
        assert (refused.status_code, refused.json()["detail"]) == (
            403, "Only an administrator of service accounts can give it a role here",
        )
        assert (await test_client.get(BASE)).status_code == 403
    # Its other manager hears who did it: no administrator was involved.
    assert sorted((uid, title) for uid, title, _ in [
        *await _told(db_session, "service_account_disabled"),
        *await _told(db_session, "service_account_enabled"),
    ]) == [
        ("usr_ada", "For “Nightly sync”: Test User disabled it, and its keys have stopped"),
        ("usr_ada", "For “Nightly sync”: Test User enabled it again"),
    ]


async def test_to_anyone_else_it_does_not_exist(test_client, people):
    svc = (await _create(test_client))["id"]
    with claims():
        assert (await test_client.get(f"{BASE}/{svc}")).status_code == 404
        assert (await test_client.get(f"/api/v1/me/service-accounts/{svc}")).status_code == 404
        assert (await test_client.patch(f"{BASE}/{svc}", json={"name": "Mine now"})).status_code == 404
        assert (await test_client.post(f"{BASE}/{svc}/disable")).status_code == 404
        assert (await test_client.put(f"{BASE}/{svc}/managers/users/{ADMIN}")).status_code == 404
    # Someone who may make any account's keys sees it, for that alone.
    with claims("system:users:manage"):
        seen = await test_client.get(f"{BASE}/{svc}")
        assert {k for k, v in seen.json()["can"].items() if v} == {"view", "keys"}
        assert (await test_client.post(f"{BASE}/{svc}/disable")).status_code == 403


async def test_an_administrator_holds_it_disabled(test_client, db_session, people):
    """Disabled by an administrator of service accounts — even one who
    manages it — it stays disabled until one of them enables it."""
    svc = await _managed_by_me(test_client, "usr_ada")
    with claims("system:service-accounts:manage"):
        held = await test_client.post(f"{BASE}/{svc}/disable")
    assert (held.json()["status"], held.json()["adminHold"]) == ("disabled", True)
    with claims():
        assert (await test_client.get(f"{BASE}/{svc}")).json()["can"]["enable"] is False
        refused = await test_client.post(f"{BASE}/{svc}/enable")
    assert (refused.status_code, refused.json()["detail"]) == (403, (
        "An administrator disabled this service account, so only an administrator of service "
        "accounts can enable it"
    ))
    with claims("system:service-accounts:manage"):
        released = await test_client.post(f"{BASE}/{svc}/enable")
    assert (released.json()["status"], released.json()["adminHold"]) == ("active", False)
    assert [title for _uid, title, _ in await _told(db_session, "service_account_disabled")] == [
        "For “Metadata sync”: An administrator disabled it, and its keys have stopped",
    ]
    assert [p["held"] for _e, p in await _events(db_session, "identity.service_account.disabled")] == [True]


async def test_what_only_an_administrator_may_do_needs_a_session_known_alive(
    test_client, people, monkeypatch,
):
    """As ``requires`` does for ``system:service-accounts:manage``: when it
    can't be told whether the session was revoked, an administrator's change
    is refused — a manager's change to their own account is not."""
    from backend.app.auth import dependencies as deps
    from backend.app.services.revocation_service import RevocationBackendError

    class _Unreachable:
        async def is_revoked(self, sid: str) -> bool:
            raise RevocationBackendError("unreachable")

    mine = await _managed_by_me(test_client)
    theirs = (await _create(test_client, name="Nightly export"))["id"]
    monkeypatch.setattr(deps, "get_revocation_service", lambda: _Unreachable())
    with claims("system:service-accounts:manage"):
        assert (await test_client.patch(f"{BASE}/{theirs}", json={"name": "x"})).status_code == 503
        assert (await test_client.patch(f"{BASE}/{mine}", json={"name": "y"})).status_code == 200


async def test_a_manager_appoints_only_someone_who_gains_nothing_they_couldnt_grant(
    test_client, db_session, people,
):
    svc = await _managed_by_me(test_client)
    assert (await test_client.post(f"{BASE}/{svc}/roles", json={
        "workspaceId": "ws_x", "role": "workspace_member",
    })).status_code == 201
    with claims():
        refused = await test_client.put(f"{BASE}/{svc}/managers/users/usr_bea")
    assert (refused.status_code, refused.json()["detail"]) == (403, (
        "Whoever manages a service account can do whatever it can, and Bea P would gain Member "
        "in Sales, which you can't grant"
    ))
    # Someone who holds as much there already gains nothing...
    db_session.add(RoleBindingORM(
        subject_type="user", subject_id="usr_bea", role_name="workspace_admin",
        scope_type="workspace", scope_id="ws_x",
    ))
    await db_session.commit()
    with claims():
        assert (await test_client.put(f"{BASE}/{svc}/managers/users/usr_bea")).status_code == 200
    # ...and someone who could grant it there may appoint anyone: a steward
    # grants Member.
    with claims(ws_perms={"ws_x": ("workspace:members:add",)}):
        assert (await test_client.put(f"{BASE}/{svc}/managers/users/usr_ada")).status_code == 200


async def test_a_team_gains_nothing_when_its_own_roles_cover_the_account(
    test_client, db_session, people,
):
    svc = await _managed_by_me(test_client)
    assert (await test_client.post(f"{BASE}/{svc}/roles", json={
        "workspaceId": "ws_x", "role": "workspace_viewer",
    })).status_code == 201
    with claims():
        refused = await test_client.put(f"{BASE}/{svc}/managers/groups/grp_ops")
    assert refused.status_code == 403
    assert "and Operations would gain Viewer in Sales" in refused.json()["detail"]
    db_session.add(RoleBindingORM(
        subject_type="group", subject_id="grp_ops", role_name="workspace_viewer",
        scope_type="workspace", scope_id="ws_x",
    ))
    await db_session.commit()
    with claims():
        assert (await test_client.put(f"{BASE}/{svc}/managers/groups/grp_ops")).status_code == 200


async def test_its_managers_cant_leave_it_with_none(test_client, people):
    svc = await _managed_by_me(test_client)
    with claims():
        last = await test_client.delete(f"{BASE}/{svc}/managers/users/{ADMIN}")
        assert last.status_code == 409, last.text
        not_a_manager = await test_client.delete(f"{BASE}/{svc}/managers/users/usr_bea")
        assert not_a_manager.status_code == 404
        assert (await test_client.put(f"{BASE}/{svc}/managers/users/usr_ada")).status_code == 200
        stepped_down = await test_client.delete(f"{BASE}/{svc}/managers/users/{ADMIN}")
        assert stepped_down.status_code == 200, stepped_down.text
        # Having stepped down, they no longer see it.
        assert stepped_down.json()["can"]["view"] is False
        assert (await test_client.get(f"{BASE}/{svc}")).status_code == 404


# ── A workspace lets it in ──────────────────────────────────────────

MEMBERS = "/api/v1/admin/workspaces/ws_x/members"
REQUESTS = "/api/v1/access-requests"
STEWARD = {"ws_x": ("workspace:members:add",)}


async def _approver(db_session, user_id: str = "usr_bea") -> None:
    """Someone who answers Sales's requests, so there is someone to tell."""
    db_session.add(RoleBindingORM(
        subject_type="user", subject_id=user_id, role_name="workspace_admin",
        scope_type="workspace", scope_id="ws_x",
    ))
    await db_session.commit()


async def test_a_workspace_adds_it_as_it_adds_a_person(test_client, db_session, people):
    svc = (await _create(test_client))["id"]
    with claims(ws_perms=STEWARD):
        found = (await test_client.get(f"{MEMBERS}/service-accounts", params={"q": "metadata"})).json()
        assert [(c["id"], [m["name"] for m in c["managers"]], c["roles"]) for c in found] == [
            (svc, ["Ada P"], []),
        ]
        options = (await test_client.get(f"{MEMBERS}/grant-options")).json()
        assert {r["name"]: r["requestable"] for r in options["roles"]} == {
            "workspace_member": True, "workspace_viewer": True,
        }
        added = await test_client.post(MEMBERS, json={
            "subjectType": "user", "subjectId": svc, "role": "workspace_viewer",
        })
        assert added.status_code == 201, added.text
        assert (await test_client.get(f"{MEMBERS}/service-accounts")).json()[0]["roles"] == ["workspace_viewer"]
    # Never a role that administers the workspace or lets people in.
    with claims("system:org-admin"):
        refused = await test_client.post(MEMBERS, json={
            "subjectType": "user", "subjectId": svc, "role": "workspace_admin",
        })
        assert refused.status_code == 422, refused.text
    # Its managers hear, naming it.
    assert [(uid, title) for uid, title, _ in await _told(db_session, "workspace.member_added")] == [
        ("usr_ada", "For “Metadata sync”: You were added to Sales"),
    ]


async def test_where_the_identity_provider_decides_only_admins_add_it(test_client, db_session, people):
    """The provider doesn't know a service account: its role there is the
    admins' decision — not a steward's, and never an exception that ends."""
    svc = (await _create(test_client))["id"]
    (await db_session.get(WorkspaceORM, "ws_x")).access_mode = "idp"
    await db_session.commit()
    with claims(ws_perms=STEWARD):
        refused = await test_client.post(MEMBERS, json={
            "subjectType": "user", "subjectId": svc, "role": "workspace_viewer",
        })
    assert refused.status_code == 403, refused.text
    with claims("system:org-admin"):
        added = await test_client.post(MEMBERS, json={
            "subjectType": "user", "subjectId": svc, "role": "workspace_viewer",
        })
    assert added.status_code == 201, added.text
    binding = (await db_session.execute(
        select(RoleBindingORM).where(RoleBindingORM.subject_id == svc)
    )).scalar_one()
    assert (binding.idp_exception, binding.expires_at) == (False, None)


async def test_its_managers_ask_a_workspace_for_it(test_client, db_session, people):
    await _approver(db_session)
    svc = await _managed_by_me(test_client, "usr_ada")
    ask = {"targetType": "workspace", "targetId": "ws_x", "requestedRole": "workspace_member"}
    with claims():
        asked = await test_client.post(REQUESTS, json={**ask, "serviceAccountId": svc})
        assert asked.status_code == 201, asked.text
        detail = (await test_client.get(f"{BASE}/{svc}")).json()
    body = asked.json()
    assert (body["requester"]["id"], body["requestedBy"]["id"]) == (svc, ADMIN)
    assert body["serviceAccount"]["description"] == "Reads graph metadata on a schedule"
    assert [m["name"] for m in body["serviceAccount"]["managers"]] == ["Ada P", "Test User"]
    assert [(r["workspaceName"], r["role"], r["requestedBy"]) for r in detail["requests"]] == [
        ("Sales", "workspace_member", "Test User"),
    ]
    row = await db_session.get(AccessRequestORM, body["id"])
    assert (row.requester_id, row.requested_by) == (svc, ADMIN)
    assert [(uid, title) for uid, title, _ in await _told(db_session, "access_request.submitted")] == [
        ("usr_bea", "Test User asked for “Metadata sync” to join Sales"),
    ]
    # The one who asked doesn't answer it, nor does anyone who manages it.
    refused = await test_client.post(f"/api/v1/admin/access-requests/{body['id']}/approve", json={})
    assert (refused.status_code, refused.json()["detail"]) == (
        403, "You can't answer a request for a service account you manage, or one you asked for",
    )
    # Its managers may take it back.
    with claims():
        withdrawn = await test_client.post(f"/api/v1/me/access-requests/{body['id']}/withdraw")
    assert withdrawn.json()["status"] == "withdrawn"


async def test_a_workspace_answers_a_request_for_it_with_a_role(test_client, db_session, people):
    """Approved by someone who neither manages it nor asked: a role, never a
    team or the identity provider's group."""
    await _approver(db_session)
    svc = (await _create(test_client))["id"]
    rows = [
        AccessRequestORM(
            requester_id=svc, requested_by="usr_ada", target_type="workspace", target_id="ws_x",
            requested_role="workspace_member", status="pending",
        ),
    ]
    db_session.add_all(rows)
    await db_session.commit()
    request_id = rows[0].id
    assert (await test_client.post(f"/api/v1/admin/access-requests/{request_id}/approve", json={
        "groupId": "grp_ops",
    })).status_code == 422
    assert (await test_client.post(f"/api/v1/admin/access-requests/{request_id}/route", json={
        "idpGroup": "sales-readers",
    })).status_code == 409
    approved = await test_client.post(f"/api/v1/admin/access-requests/{request_id}/approve", json={
        "expiresIn": "30d",
    })
    assert approved.status_code == 200, approved.text
    binding = (await db_session.execute(
        select(RoleBindingORM).where(RoleBindingORM.subject_id == svc)
    )).scalar_one()
    assert (binding.role_name, binding.expires_at is not None, binding.idp_exception) == (
        "workspace_member", True, False,
    )
    assert [(uid, title) for uid, title, _ in await _told(db_session, "access_request.approved")] == [
        ("usr_ada", "For “Metadata sync”: You can now open Sales"),
    ]

    # Its managers ask to keep it before it ends.
    svc_mine = await _managed_by_me(test_client, name="Nightly export")
    db_session.add(RoleBindingORM(
        subject_type="user", subject_id=svc_mine, role_name="workspace_viewer",
        scope_type="workspace", scope_id="ws_x", expires_at="2099-01-01T00:00:00+00:00",
    ))
    await db_session.commit()
    mine = (await db_session.execute(
        select(RoleBindingORM).where(RoleBindingORM.subject_id == svc_mine)
    )).scalar_one()
    with claims():
        kept = await test_client.post(f"{REQUESTS}/extend", json={"bindingId": mine.id})
    assert kept.status_code == 201, kept.text
    assert (kept.json()["requester"]["id"], kept.json()["requestedBy"]["id"]) == (svc_mine, ADMIN)


async def test_only_its_managers_ask_for_it(test_client, db_session, people):
    """Someone who neither manages an account nor administers service
    accounts can't ask for it, or ask to keep its access: to them it
    doesn't exist."""
    svc = (await _create(test_client))["id"]
    db_session.add(RoleBindingORM(
        subject_type="user", subject_id=svc, role_name="workspace_viewer",
        scope_type="workspace", scope_id="ws_x", expires_at="2099-01-01T00:00:00+00:00",
    ))
    # Requests read who you are from the database: here, nobody special.
    for binding in (await db_session.execute(
        select(RoleBindingORM).where(RoleBindingORM.subject_id == ADMIN)
    )).scalars():
        await db_session.delete(binding)
    await db_session.commit()
    binding = (await db_session.execute(
        select(RoleBindingORM).where(RoleBindingORM.subject_id == svc)
    )).scalar_one()
    asked = await test_client.post(REQUESTS, json={
        "targetType": "workspace", "targetId": "ws_x", "requestedRole": "workspace_member",
        "serviceAccountId": svc,
    })
    assert asked.status_code == 404, asked.text
    kept = await test_client.post(f"{REQUESTS}/extend", json={"bindingId": binding.id})
    assert kept.status_code == 404, kept.text


async def test_a_workspace_closed_to_requests_adds_it_itself(test_client, db_session, people):
    svc = await _managed_by_me(test_client)
    (await db_session.get(WorkspaceORM, "ws_x")).request_policy = "closed"
    await db_session.commit()
    with claims():
        refused = await test_client.post(REQUESTS, json={
            "targetType": "workspace", "targetId": "ws_x", "requestedRole": "workspace_viewer",
            "serviceAccountId": svc,
        })
    assert refused.status_code == 403
    assert refused.json()["detail"]["message"] == "This workspace isn't taking requests. Ask its admins to add it."


async def test_an_administrator_gives_it_a_role_until_a_date(test_client, people):
    svc = (await _create(test_client))["id"]
    granted = await test_client.post(f"{BASE}/{svc}/roles", json={
        "workspaceId": "ws_x", "role": "workspace_viewer", "expiresAt": "2099-01-01T00:00:00+00:00",
    })
    assert granted.status_code == 201, granted.text
    assert granted.json()["expiresAt"] == "2099-01-01T00:00:00+00:00"
    assert (await test_client.get(f"{BASE}/{svc}")).json()["roles"][0]["expiresAt"] == "2099-01-01T00:00:00+00:00"


async def test_a_workspace_it_is_in_sees_whose_it_is(test_client, db_session, people):
    """Its admins and stewards see it — who manages it, what it is for — but
    nothing of the other workspaces it is in, and they run nothing."""
    svc = (await _create(test_client))["id"]
    db_session.add(WorkspaceORM(id="ws_y", name="Finance"))
    for ws in ("ws_x", "ws_y"):
        db_session.add(RoleBindingORM(
            subject_type="user", subject_id=svc, role_name="workspace_viewer",
            scope_type="workspace", scope_id=ws,
        ))
    await db_session.commit()
    with claims(ws_perms=STEWARD):
        seen = await test_client.get(f"{BASE}/{svc}")
        assert seen.status_code == 200, seen.text
        assert {k for k, v in seen.json()["can"].items() if v} == {"view"}
        assert [r["workspaceName"] for r in seen.json()["roles"]] == ["Sales"]
        assert seen.json()["requests"] == []
        assert (await test_client.post(f"{BASE}/{svc}/disable")).status_code == 403
    with claims(ws_perms={"ws_y": ("workspace:view:read",)}):
        assert (await test_client.get(f"{BASE}/{svc}")).status_code == 404


# ── Workspace roles ─────────────────────────────────────────────────


async def test_an_account_holds_workspace_roles_that_neither_administer_nor_let_people_in(
    test_client, db_session, people,
):
    account = await _create(test_client)
    roles = f"{BASE}/{account['id']}/roles"
    granted = await test_client.post(roles, json={"workspaceId": "ws_x", "role": "workspace_viewer"})
    assert granted.status_code == 201, granted.text
    assert (granted.json()["workspaceName"], granted.json()["role"]) == ("Sales", "workspace_viewer")
    assert (await test_client.post(
        roles, json={"workspaceId": "ws_x", "role": "workspace_viewer"},
    )).status_code == 409
    assert (await test_client.post(
        roles, json={"workspaceId": "ws_x", "role": "workspace_admin"},
    )).status_code == 422
    assert (await test_client.post(
        roles, json={"workspaceId": "ws_gone", "role": "workspace_viewer"},
    )).status_code == 404

    detail = (await test_client.get(f"{BASE}/{account['id']}")).json()
    assert [(r["workspaceId"], r["role"]) for r in detail["roles"]] == [("ws_x", "workspace_viewer")]
    revoked = await test_client.delete(f"{roles}/{granted.json()['bindingId']}")
    assert revoked.status_code == 204
    assert (await test_client.get(f"{BASE}/{account['id']}")).json()["roles"] == []
    kinds = [e for e, _ in await _events(db_session, "rbac.workspace.member_")]
    assert kinds == ["rbac.workspace.member_bound", "rbac.workspace.member_revoked"]


# ── Handing over ────────────────────────────────────────────────────


async def _made(db_session, account_id: str, maker: str, name: str, **fields):
    """A key ``maker`` made for ``account_id`` — or, given ``kind="personal"``,
    their own."""
    kind = fields.pop("kind", "service")
    generated = api_keys.generate(kind)
    key = await api_key_repo.create(
        db_session, user_id=account_id, kind=kind, created_by=maker, name=name,
        description=None, token_prefix=generated.display_prefix, token_hash=generated.token_hash,
        permissions={"views": "none", "data": "read", "publish": False}, resources="all",
        allowed_cidrs=None, expires_at=fields.pop("expires_at", None), created_ip=None,
        created_user_agent=None,
    )
    await db_session.commit()
    return key


async def test_a_leavers_accounts_are_handed_over_with_the_keys_they_made(
    test_client, db_session, people,
):
    alone = await _create(test_client, name="Alone")
    shared = await _create(test_client, name="Shared")
    await test_client.put(f"{BASE}/{shared['id']}/managers/groups/grp_ops")
    await _made(db_session, alone["id"], "usr_ada", "sync")

    listed = (await test_client.get(BASE, params={"managedBy": "usr_ada"})).json()
    facts = {i["name"]: i["handOver"] for i in listed["items"]}
    assert facts["Alone"]["lastManager"] is True
    assert [k["name"] for k in facts["Alone"]["keysCreatedBy"]] == ["sync"]
    assert facts["Shared"] == {"seat": True, "teams": [], "lastManager": False, "keysCreatedBy": []}

    handed = await test_client.post(f"{BASE}/hand-over", json={
        "fromUserId": "usr_ada", "to": {"type": "user", "id": "usr_bea"},
    })
    assert handed.status_code == 200, handed.text
    assert sorted(handed.json()["handedOver"]) == sorted([alone["id"], shared["id"]])
    for account_id in (alone["id"], shared["id"]):
        managers = (await test_client.get(f"{BASE}/{account_id}")).json()["managers"]
        assert "usr_ada" not in {m["id"] for m in managers}
        assert "usr_bea" in {m["id"] for m in managers}
    vias = {p["via"] for _e, p in await _events(db_session, "identity.service_account.manager_")
            if p.get("via")}
    assert vias == {"hand_over"}
    # The successor hears that the key Ada made still works.
    told = (await db_session.execute(
        select(NotificationORM.user_id, NotificationORM.title, NotificationORM.body)
        .where(NotificationORM.kind == "service_account_maker_left")
    )).all()
    assert [(r.user_id, r.title) for r in told] == [("usr_bea", "Keys Ada P made for “Alone” still work")]
    assert "“sync”" in told[0].body
    assert (await test_client.post(f"{BASE}/hand-over", json={
        "fromUserId": "usr_bea", "to": {"type": "user", "id": "usr_bea"},
    })).status_code == 422


async def test_a_leavers_list_holds_their_teams_accounts_and_the_keys_they_made(
    test_client, db_session, people,
):
    """Bea answers for one account herself and one through her team, and made
    a key for a third she no longer manages. A hand-over moves her own seat:
    the team keeps its."""
    direct = await _create(test_client, name="Direct", managers=({"type": "user", "id": "usr_bea"},))
    team = await _create(test_client, name="Team", managers=({"type": "group", "id": "grp_ops"},))
    made = await _create(test_client, name="Made")
    await _create(test_client, name="Elsewhere")
    await _made(db_session, made["id"], "usr_bea", "nightly")
    await _made(db_session, made["id"], "usr_bea", "old", expires_at="2001-01-01T00:00:00+00:00")
    revoked = await _made(db_session, team["id"], "usr_bea", "gone")
    await api_key_repo.revoke(db_session, revoked.id, by=ADMIN, reason="admin")
    await db_session.commit()

    listed = (await test_client.get(BASE, params={"managedBy": "usr_bea"})).json()
    facts = {i["name"]: i["handOver"] for i in listed["items"]}
    assert (listed["total"], sorted(facts)) == (3, ["Direct", "Made", "Team"])
    assert facts["Direct"] == {"seat": True, "teams": [], "lastManager": True, "keysCreatedBy": []}
    assert facts["Team"] == {"seat": False, "teams": ["Operations"], "lastManager": True, "keysCreatedBy": []}
    assert (facts["Made"]["seat"], facts["Made"]["teams"], facts["Made"]["lastManager"]) == (False, [], False)
    assert [k["name"] for k in facts["Made"]["keysCreatedBy"]] == ["nightly"]

    handed = await test_client.post(f"{BASE}/hand-over", json={
        "fromUserId": "usr_bea", "to": {"type": "user", "id": "usr_ada"},
    })
    assert handed.json()["handedOver"] == [direct["id"]]
    managers = (await test_client.get(f"{BASE}/{team['id']}")).json()["managers"]
    assert [(m["type"], m["id"]) for m in managers] == [("group", "grp_ops")]


async def test_the_keys_a_leaver_made_are_revoked_in_one_step(test_client, db_session, people):
    sync = await _create(test_client, name="Sync")
    other = await _create(test_client, name="Other", managers=({"type": "group", "id": "grp_ops"},))
    theirs = [
        await _made(db_session, sync["id"], "usr_bea", "ingest"),
        await _made(db_session, sync["id"], "usr_bea", "backfill"),
        await _made(db_session, other["id"], "usr_bea", "export"),
    ]
    kept = [
        await _made(db_session, sync["id"], "usr_ada", "adas"),
        await _made(db_session, "usr_bea", "usr_bea", "her own", kind="personal"),
    ]
    route = "/api/v1/admin/users/usr_bea/api-keys/revoke-made"
    with claims("system:org-admin", "system:service-accounts:manage"):
        assert (await test_client.post(route)).status_code == 403

    response = await test_client.post(route, json={"note": "Bea has left"})
    assert response.json() == {"revoked": 3}
    for key in theirs + kept:
        await db_session.refresh(key)
    assert [k.revoked_reason for k in theirs] == ["admin"] * 3
    assert {k.revoked_note for k in theirs} == {"Bea has left"}
    assert [k.revoked_at for k in kept] == [None, None]
    # Whoever answers for each account hears once: its integration needs a new key.
    told = (await db_session.execute(
        select(NotificationORM.user_id, NotificationORM.title, NotificationORM.body)
        .where(NotificationORM.kind == "api_key_revoked_by_admin")
        .order_by(NotificationORM.user_id)
    )).all()
    assert [(r.user_id, r.title) for r in told] == [
        ("usr_ada", "An administrator revoked the keys Bea P made for “Sync”"),
        ("usr_bea", "An administrator revoked the keys Bea P made for “Other”"),
    ]
    assert told[0].body.startswith("“ingest” (") and "“backfill” (" in told[0].body
    assert told[0].body.endswith("The administrator said: “Bea has left”")
    assert (await test_client.post(route)).json() == {"revoked": 0}


async def test_those_who_answer_hear_when_someone_who_made_keys_stops(test_client, db_session, people):
    """Ada manages the account, and Bea through her team; each made a key."""
    account = await _create(test_client, name="Sync")
    await test_client.put(f"{BASE}/{account['id']}/managers/groups/grp_ops")
    await _made(db_session, account["id"], "usr_bea", "beas")
    await _made(db_session, account["id"], "usr_ada", "adas")

    async def told():
        return [
            (r.user_id, r.title) for r in (await db_session.execute(
                select(NotificationORM.user_id, NotificationORM.title)
                .where(NotificationORM.kind == "service_account_maker_left")
                .order_by(NotificationORM.created_at, NotificationORM.user_id)
            )).all()
        ]

    bea_left = ("usr_ada", "Keys Bea P made for “Sync” still work")
    # Bea also holds a seat herself, which she loses: she still answers
    # through her team, so nobody is told.
    await test_client.put(f"{BASE}/{account['id']}/managers/users/usr_bea")
    await test_client.delete(f"{BASE}/{account['id']}/managers/users/usr_bea")
    assert await told() == []
    # Out of the team, she no longer does: Ada hears.
    await test_client.delete("/api/v1/admin/groups/grp_ops/members/usr_bea")
    assert await told() == [bea_left]

    # Back in the team, then the team is deleted.
    await test_client.post("/api/v1/admin/groups/grp_ops/members", json={"userId": "usr_bea"})
    deleted = await test_client.delete("/api/v1/admin/groups/grp_ops")
    assert deleted.status_code == 204
    assert (await told())[1:] == [bea_left]

    # Bea is appointed herself, and Ada suspended: Bea hears of Ada's key.
    await test_client.put(f"{BASE}/{account['id']}/managers/users/usr_bea")
    assert (await test_client.post("/api/v1/admin/users/usr_ada/suspend")).status_code == 200
    assert (await told())[2:] == [("usr_bea", "Keys Ada P made for “Sync” still work")]

    # Ada is back; Bea is made a break-glass account, which manages nothing.
    assert (await test_client.post("/api/v1/admin/users/usr_ada/reactivate")).status_code == 200
    marked = await test_client.post("/api/v1/admin/users/usr_bea/system-account", json={"isSystemAccount": True})
    assert marked.status_code == 200, marked.text
    assert (await told())[3:] == [bea_left]


# ── Never a person ──────────────────────────────────────────────────


async def test_a_service_account_is_not_one_of_the_people(test_client, db_session, people):
    account = await _create(test_client)
    svc = account["id"]
    users = (await test_client.get("/api/v1/admin/users", params={"limit": 100})).json()
    listed = users["items"] if isinstance(users, dict) else users
    assert svc not in {u["id"] for u in listed}
    stats = await user_repo.user_stats(db_session)
    assert stats["total"] == len([u for u in (await db_session.execute(select(UserORM))).scalars()
                                  if not u.id.startswith("svc_")])
    for method, path in (
        ("post", f"/api/v1/admin/users/{svc}/suspend"),
        ("post", f"/api/v1/admin/users/{svc}/reset-password"),
        ("post", f"/api/v1/admin/users/{svc}/system-account"),
        ("get", f"/api/v1/admin/users/{svc}/identities"),
    ):
        response = await getattr(test_client, method)(path, **({"json": {}} if method == "post" else {}))
        assert response.status_code == 404, (path, response.status_code, response.text)

    found = (await test_client.get("/api/v1/directory", params={"q": "Metadata"})).json()
    assert svc not in {u["id"] for u in found.get("users", [])}
    hits = await test_client.get("/api/v1/admin/rbac/search", params={"q": "Metadata", "types": "user"})
    assert hits.status_code == 200, hits.text
    assert svc not in {h["id"] for h in hits.json()}

    joined = await test_client.post("/api/v1/admin/groups/grp_ops/members", json={"userId": svc})
    assert joined.status_code == 409


async def test_nothing_is_shared_with_a_service_account(test_client, db_session, people):
    """Its access is the workspace roles on its own page: a view or a draft
    can't be shared with it, and it neither reviews nor approves a PR — its
    managers would be approving through it."""
    svc = (await _create(test_client))["id"]
    db_session.add(ViewORM(
        id="view_sa", name="Lineage", workspace_id="ws_x", visibility="workspace", created_by=ADMIN,
    ))
    await db_session.commit()
    shared = await test_client.post("/api/v1/views/view_sa/grants", json={
        "subjectType": "user", "subjectId": svc, "role": "viewer",
    })
    assert shared.status_code == 409, shared.text

    with pytest.raises(HTTPException) as refused:
        await versioning.add_branch_member(
            ws_id="ws_x", graph_id="g_sa", branch_id="b_sa",
            body=versioning.BranchMemberRequest(subjectType="user", subjectId=svc, role="viewer"),
            user=None, _meta={}, svc=None,
        )
    assert refused.value.status_code == 409

    def untouched():
        raise AssertionError("refused before anything is read")

    service = GraphVersioningService(session_factory=untouched)
    with pytest.raises(AccessDenied):
        await service.approve_pr(pr_id="mr_sa", actor=svc)
    with pytest.raises(AccessDenied):
        await service.open_pr(source_graph_id="g_fork", actor=ADMIN, reviewers=[svc])
    with pytest.raises(AccessDenied):
        await service.open_draft_mr(graph_id="g_sa", branch_id="b_sa", actor=ADMIN, reviewers=[svc])


async def test_a_service_account_is_neither_counted_nor_found_as_a_person(
    test_client, db_session, people,
):
    """Who has access shows it, without its placeholder address; how many
    people there are, who can act on a queue, the admin search and the
    analytics of people leave it out."""
    svc = (await _create(test_client))["id"]
    granted = await test_client.post(f"{BASE}/{svc}/roles", json={
        "workspaceId": "ws_x", "role": "workspace_viewer",
    })
    assert granted.status_code == 201, granted.text
    db_session.add(RoleBindingORM(
        subject_type="user", subject_id="usr_bea", role_name="workspace_viewer",
        scope_type="workspace", scope_id="ws_x",
    ))
    for actor in (svc, "usr_bea"):
        db_session.add(ViewActivityLogORM(
            view_id="view_any", workspace_id="ws_x", action="updated", actor=actor,
        ))
    await db_session.commit()

    members = (await test_client.get("/api/v1/admin/workspaces/ws_x/members")).json()
    [bound] = [m for m in members if m["subject"]["id"] == svc]
    assert (bound["subject"]["displayName"], bound["subject"]["secondary"]) == ("Metadata sync", None)
    effective = (await test_client.get("/api/v1/admin/workspaces/ws_x/members/effective")).json()
    [listed] = [u for u in effective["users"] if u["userId"] == svc]
    assert listed["email"] is None

    assert await notification_repo.workspace_member_count(db_session, "ws_x") == 1
    assert await notification_repo.users_who_can(
        db_session, workspace_id="ws_x", permission="workspace:view:read",
    ) == {"usr_bea"}
    assert (await workspace_access.audience(db_session, ["ws_x"]))["ws_x"] == ({"usr_bea"}, set())
    active = [u for u in (await db_session.execute(select(UserORM))).scalars()
              if u.status == "active" and not u.id.startswith("svc_")]
    assert await notification_repo.platform_user_count(db_session) == len(active)
    assert svc not in {u.id for u in await user_repo.search_users(db_session, q="Metadata")}

    summary = await analytics_repo.platform_summary(db_session, days=7)
    assert [u["userId"] for u in summary["leaderboards"]["topUsers"]] == ["usr_bea"]
    [row] = [r for r in await analytics_repo.workspace_rows(db_session, days=7) if r["workspaceId"] == "ws_x"]
    assert (row["members"], row["activeUsers"]) == (1, 1)
    detail = await analytics_repo.workspace_detail(db_session, "ws_x", days=7)
    assert [c["userId"] for c in detail["topContributors"]] == ["usr_bea"]


# ── What is said to it ──────────────────────────────────────────────


async def _told(db_session, kind: str) -> list[tuple[str, str, str]]:
    rows = (await db_session.execute(
        select(NotificationORM.user_id, NotificationORM.title, NotificationORM.link)
        .where(NotificationORM.kind == kind)
    )).all()
    return [tuple(r) for r in rows]


async def test_what_is_said_to_an_account_reaches_those_who_answer_for_it(
    test_client, db_session, people,
):
    """Nobody reads a service account's own inbox. A workspace admin removing
    its access is told to its managers instead — and while it has none, to
    its administrators."""
    svc = (await _create(test_client))["id"]
    granted = await test_client.post(f"{BASE}/{svc}/roles", json={
        "workspaceId": "ws_x", "role": "workspace_viewer",
    })
    removed = await test_client.delete(
        f"/api/v1/admin/workspaces/ws_x/members/{granted.json()['bindingId']}",
    )
    assert removed.status_code == 204, removed.text
    assert await _told(db_session, "workspace.member_removed") == [
        ("usr_ada", "For “Metadata sync”: You no longer have access to Sales", f"/service-accounts/{svc}"),
    ]

    (await db_session.get(UserORM, "usr_ada")).status = "suspended"
    await db_session.commit()
    assert await notification_repo.notify(
        db_session, user_ids=[svc], kind="anything", title="hello",
    ) == 1
    assert await _told(db_session, "anything") == [
        (ADMIN, "For “Metadata sync”: hello", f"/service-accounts/{svc}"),
    ]


async def test_who_answers_for_two_accounts_hears_of_each(test_client, db_session, people, monkeypatch):
    one = (await _create(test_client, name="One"))["id"]
    two = (await _create(test_client, name="Two"))["id"]
    assert await notification_repo.notify(db_session, user_ids=[one, two], kind="both", title="hello") == 2
    assert sorted(title for _, title, _ in await _told(db_session, "both")) == [
        "For “One”: hello", "For “Two”: hello",
    ]

    # A notice that fails is undone alone: the caller's own work stands.
    from backend.app.services import service_account_standing

    async def unavailable(*_args, **_kwargs):
        raise RuntimeError("nobody to ask")

    monkeypatch.setattr(service_account_standing, "key_audience", unavailable)
    db_session.add(GroupORM(id="grp_kept", name="Kept"))
    assert await notification_repo.notify(db_session, user_ids=[one], kind="failed", title="hello") == 0
    await db_session.commit()
    assert await db_session.get(GroupORM, "grp_kept") is not None
    assert await _told(db_session, "failed") == []


# ── For managers ────────────────────────────────────────────────────


async def test_a_manager_reads_their_accounts_a_page_at_a_time(test_client, db_session, people):
    db_session.add(GroupMemberORM(group_id="grp_ops", user_id=ADMIN))
    await db_session.commit()
    await _create(test_client, name="Alpha", managers=({"type": "user", "id": ADMIN},))
    for name in ("Bravo", "Charlie"):
        await _create(test_client, name=name, managers=({"type": "group", "id": "grp_ops"},))
    await _create(test_client, name="Delta")
    with claims():
        first = (await test_client.get("/api/v1/me/service-accounts", params={"limit": 2})).json()
        rest = (await test_client.get("/api/v1/me/service-accounts", params={"limit": 2, "offset": 2})).json()
    assert (first["total"], [i["name"] for i in first["items"]]) == (3, ["Alpha", "Bravo"])
    assert [i["name"] for i in rest["items"]] == ["Charlie"]


async def test_a_team_is_counted_once_a_page_and_each_person_once(test_client, db_session, people):
    """However many accounts a team manages, its members are counted once
    for the page; and someone who manages an account both themselves and
    through a team is one person, not two."""
    from backend.app.db.repositories import service_account_repo
    from sqlalchemy import event

    both = await _create(test_client, name="Both", managers=(
        {"type": "user", "id": "usr_bea"}, {"type": "group", "id": "grp_ops"},
    ))
    db_session.add_all([GroupORM(id="grp_crowd", name="Crowd")])
    await db_session.flush()
    db_session.add_all([
        GroupMemberORM(group_id="grp_crowd", user_id=u) for u in ("usr_ada", "usr_bea", ADMIN, "usr_cid")
    ])
    await db_session.commit()
    crowd = await _create(test_client, name="Crowd", managers=({"type": "group", "id": "grp_crowd"},))

    statements = []
    engine = db_session.bind.sync_engine

    def _count(*_args):
        statements.append(1)

    async def listed():
        statements.clear()
        event.listen(engine, "before_cursor_execute", _count)
        try:
            body = (await test_client.get(BASE)).json()
        finally:
            event.remove(engine, "before_cursor_execute", _count)
        return {i["name"]: i for i in body["items"]}, len(statements)

    items, few = await listed()
    assert items["Both"]["singleManager"] is True
    team = next(m for m in items["Crowd"]["managers"] if m["type"] == "group")
    assert (team["membersInGoodStanding"], items["Crowd"]["singleManager"]) == (3, False)
    for n in range(6):
        await _create(test_client, name=f"Crowd {n}", managers=({"type": "group", "id": "grp_crowd"},))
    items, many = await listed()
    assert len(items) == 8 and many == few
    assert await service_account_repo.add_manager(
        db_session, crowd["id"], group_id="grp_crowd", added_by=ADMIN,
    ) is False
    # The duplicate is turned away under a savepoint: the session carries on.
    assert {m["id"] for m in (await test_client.get(f"{BASE}/{both['id']}")).json()["managers"]} == {
        "usr_bea", "grp_ops",
    }


async def test_a_manager_finds_the_accounts_they_answer_for(test_client, db_session, people):
    mine = await _create(test_client, name="Mine", managers=({"type": "user", "id": ADMIN},))
    theirs = await _create(test_client, name="Theirs")
    with claims():
        listed = (await test_client.get("/api/v1/me/service-accounts")).json()
        assert [i["id"] for i in listed["items"]] == [mine["id"]]
        assert (await test_client.get(f"/api/v1/me/service-accounts/{mine['id']}")).status_code == 200
        assert (await test_client.get(f"/api/v1/me/service-accounts/{theirs['id']}")).status_code == 404
    with claims("system:users:manage"):
        # A super admin may make any account's keys, so may open any.
        assert (await test_client.get(f"/api/v1/me/service-accounts/{theirs['id']}")).status_code == 200
