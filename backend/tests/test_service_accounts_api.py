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
from fastapi import HTTPException
from sqlalchemy import select

from backend.app.api.v1.endpoints import versioning
from backend.app.auth.dependencies import get_permission_claims
from backend.app.db.models import (
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


async def test_only_service_account_admins_put_people_in_a_team_that_manages_one(
    test_client, db_session, people,
):
    """Whoever joins a team that manages a service account can act as it."""
    await _create(test_client, managers=({"type": "group", "id": "grp_ops"},))
    with claims("system:groups:manage"):
        refused = await test_client.post("/api/v1/admin/groups/grp_ops/members", json={"userId": "usr_ada"})
    assert refused.status_code == 403, refused.text
    with claims("system:groups:manage", "system:service-accounts:manage"):
        joined = await test_client.post("/api/v1/admin/groups/grp_ops/members", json={"userId": "usr_ada"})
    assert joined.status_code == 201, joined.text
    # Those who answer for it hear who can now act as it — not the newcomer.
    assert [(uid, title) for uid, title, _ in await _told(db_session, "service_account_team_joined")] == [
        ("usr_bea", "Ada P can now act as “Metadata sync”"),
    ]

    # Nor can answering an access request put anyone in it.
    db_session.add(GroupORM(id="grp_plain", name="Readers"))
    await db_session.flush()
    for team in ("grp_ops", "grp_plain"):
        db_session.add(RoleBindingORM(
            subject_type="group", subject_id=team, role_name="workspace_viewer",
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
        ("usr_ada", "For “Metadata sync”: You no longer have access to Sales", f"/me/service-accounts/{svc}"),
    ]

    (await db_session.get(UserORM, "usr_ada")).status = "suspended"
    await db_session.commit()
    assert await notification_repo.notify(
        db_session, user_ids=[svc], kind="anything", title="hello",
    ) == 1
    assert await _told(db_session, "anything") == [
        (ADMIN, "For “Metadata sync”: hello", f"/admin/service-accounts?account={svc}"),
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
