"""Looking after service accounts: who may, what an account may hold, handing over.

Super and org admins (``system:service-accounts:manage``) create service
accounts, appoint the people or teams who answer for them, give them workspace
roles, and hand a leaver's accounts over to a successor. A service account is
never a person: it is left out of every list of people, refused by the routes
about one, and can't join a team or a workspace's members by the side door.
"""
from __future__ import annotations

import contextlib
import json

import pytest
from sqlalchemy import select

from backend.app.auth.dependencies import get_permission_claims
from backend.app.db.models import (
    GroupMemberORM,
    GroupORM,
    NotificationORM,
    OutboxEventORM,
    RoleBindingORM,
    ServiceAccountORM,
    UserORM,
    WorkspaceORM,
)
from backend.app.db.repositories import api_key_repo, notification_repo, user_repo
from backend.app.services.permission_service import PermissionClaims
from backend.auth_service.core import api_keys

BASE = "/api/v1/admin/service-accounts"
ADMIN = "usr_test000000"  # the test client's own user


@contextlib.contextmanager
def claims(*global_perms: str):
    from backend.app.main import app

    previous = app.dependency_overrides.get(get_permission_claims)
    app.dependency_overrides[get_permission_claims] = lambda: PermissionClaims(
        sid="sess_test", global_perms=tuple(global_perms), ws_perms={},
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
    assert [(n.user_id, n.link) for n in told] == [("usr_ada", f"/me/service-accounts/{account_id}")]


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


async def test_a_leavers_accounts_are_handed_over_with_the_keys_they_made(
    test_client, db_session, people,
):
    alone = await _create(test_client, name="Alone")
    shared = await _create(test_client, name="Shared")
    await test_client.put(f"{BASE}/{shared['id']}/managers/groups/grp_ops")
    generated = api_keys.generate(api_keys.KIND_SERVICE)
    await api_key_repo.create(
        db_session, user_id=alone["id"], kind="service", created_by="usr_ada", name="sync",
        description=None, token_prefix=generated.display_prefix, token_hash=generated.token_hash,
        permissions={"views": "none", "data": "read", "publish": False}, resources="all",
        allowed_cidrs=None, expires_at=None, created_ip=None, created_user_agent=None,
    )
    await db_session.commit()

    listed = (await test_client.get(BASE, params={"managedBy": "usr_ada"})).json()
    facts = {i["name"]: i["handOver"] for i in listed["items"]}
    assert facts["Alone"]["lastManager"] is True
    assert [k["name"] for k in facts["Alone"]["keysCreatedBy"]] == ["sync"]
    assert facts["Shared"] == {"lastManager": False, "keysCreatedBy": []}

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
    assert (await test_client.post(f"{BASE}/hand-over", json={
        "fromUserId": "usr_bea", "to": {"type": "user", "id": "usr_bea"},
    })).status_code == 422


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
    bound = await test_client.post("/api/v1/admin/workspaces/ws_x/members", json={
        "subjectType": "user", "subjectId": svc, "role": "workspace_viewer",
    })
    assert bound.status_code == 409

    # Nobody reads a service account's inbox.
    assert await notification_repo.notify(
        db_session, user_ids=[svc], kind="anything", title="hello",
    ) == 0


# ── For managers ────────────────────────────────────────────────────


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
