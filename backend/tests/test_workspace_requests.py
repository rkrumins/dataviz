"""Workspace requests: anyone asks for a workspace of their own; whoever creates workspaces answers.

These pin what makes a request safe to answer: it is off until an administrator turns it
on; what is asked for is checked (a free name, with a free one suggested when it is taken;
only the requester's own Playground graphs; only active teammates); one open request per
person; only approvers list and answer, never their own; a requester sees only their own.
Approving creates the workspace as the requester's, binds them its Workspace Admin and
their teammates its Members, and moves their Playground graphs in with their views — a
graph that can't move is recorded and never costs the workspace. Sending back, resubmitting,
declining and withdrawing move the request as they say, and everyone involved is told.
"""
from __future__ import annotations

import contextlib
import json

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from backend.app.auth.dependencies import get_current_user, get_optional_user, get_permission_claims
from backend.app.db.models import (
    NotificationORM, OutboxEventORM, ProviderORM, RoleBindingORM, RoleORM, RolePermissionORM, UserORM, ViewORM,
    WorkspaceDataSourceORM, WorkspaceORM, WorkspaceRequestORM,
)
from backend.app.services import playground_policy
from backend.app.services.feature_flags import feature_flags
from backend.app.services.permission_service import PermissionClaims
from backend.auth_service.interface import User
from tests.common.transfer_world import fake_version_store

PG = "ws_play"
T0 = "2026-11-20T00:00:00+00:00"
MEMBER_PERMS = (
    "workspace:datasource:manage", "workspace:datasource:read", "workspace:view:create",
    "workspace:view:delete", "workspace:view:edit", "workspace:view:read",
)


def _user(uid: str) -> User:
    return User(id=uid, email=f"{uid}@example.com", first_name=uid[4:].title(), last_name="T",
                role="user", status="active", created_at=T0, updated_at=T0)


ADA, BEN, CAL, DEE, OLGA = (_user(u) for u in ("usr_ada", "usr_ben", "usr_cal", "usr_dee", "usr_olga"))
PLAYER = PermissionClaims(sid="s_p", ws_perms={PG: MEMBER_PERMS})
APPROVER = PermissionClaims(
    sid="s_o", global_perms=("system:org-admin", "system:workspaces:create"), ws_perms={},
)


@contextlib.contextmanager
def _as(user: User, claims: PermissionClaims):
    from backend.app.main import app

    async def _u():
        return user

    saved = {k: app.dependency_overrides.get(k) for k in (get_current_user, get_optional_user, get_permission_claims)}
    app.dependency_overrides[get_current_user] = _u
    app.dependency_overrides[get_optional_user] = _u
    app.dependency_overrides[get_permission_claims] = lambda: claims
    try:
        yield
    finally:
        for k, v in saved.items():
            if v is None:
                app.dependency_overrides.pop(k, None)
            else:
                app.dependency_overrides[k] = v


@pytest.fixture
def flag_on():
    feature_flags._cache["workspaceRequestsEnabled"] = True
    yield
    feature_flags._cache["workspaceRequestsEnabled"] = False


@pytest.fixture(autouse=True)
def version_store(monkeypatch):
    """The version store runs on Postgres only: faked, as the transfer tests do."""
    return fake_version_store(monkeypatch)


@pytest.fixture
async def estate(db_session):
    """The Playground, with two of Ada's graphs (one with a view shared there, which Dee,
    a fellow member and not Ada's teammate, loses when it moves — so moving it takes the
    preview's token) and one of Ben's; a team workspace with Ada's production graph;
    workspaces called Team, Analytics and Analytics 2; Olga an Org Admin; Cal suspended."""
    if await db_session.get(RoleORM, playground_policy.PLAYGROUND_ROLE) is None:
        db_session.add(RoleORM(name=playground_policy.PLAYGROUND_ROLE, description="Playground member",
                               scope_type="global", scope_id=None, is_system=True, created_at=T0, updated_at=T0))
        await db_session.flush()
        db_session.add(RolePermissionORM(role_name=playground_policy.PLAYGROUND_ROLE,
                                         permission_id="workspace:view:read"))
    for user, state in ((ADA, "active"), (BEN, "active"), (CAL, "suspended"), (DEE, "active"), (OLGA, "active")):
        db_session.add(UserORM(id=user.id, email=user.email, password_hash="x", first_name=user.first_name,
                               last_name="T", status=state, created_at=T0, updated_at=T0))
    db_session.add_all([
        ProviderORM(id="prov_sandbox", name="Sandbox", provider_type="falkordb"),
        WorkspaceORM(id=PG, name="Playground", kind="playground", request_policy="open", publish_policy="request",
                     playground_settings=json.dumps({"sandboxProviderId": "prov_sandbox", "graphQuota": 5})),
        WorkspaceORM(id="ws_team", name="Team"),
        WorkspaceORM(id="ws_an", name="Analytics"),
        WorkspaceORM(id="ws_an2", name="Analytics 2"),
    ])
    await db_session.flush()
    db_session.add_all([
        RoleBindingORM(subject_type="user", subject_id=OLGA.id, role_name="org_admin", scope_type="global"),
        RoleBindingORM(subject_type="user", subject_id=ADA.id, role_name=playground_policy.PLAYGROUND_ROLE,
                       scope_type="workspace", scope_id=PG),
        RoleBindingORM(subject_type="user", subject_id=BEN.id, role_name=playground_policy.PLAYGROUND_ROLE,
                       scope_type="workspace", scope_id=PG),
        RoleBindingORM(subject_type="user", subject_id=DEE.id, role_name=playground_policy.PLAYGROUND_ROLE,
                       scope_type="workspace", scope_id=PG),
        WorkspaceDataSourceORM(id="ds_ada_a", workspace_id=PG, provider_id="prov_sandbox", graph_name="blank_a",
                               label="Ada's first", created_by=ADA.id, created_at=T0, updated_at=T0),
        WorkspaceDataSourceORM(id="ds_ada_b", workspace_id=PG, provider_id="prov_sandbox", graph_name="blank_b",
                               label="Ada's second", created_by=ADA.id, created_at=T0, updated_at=T0),
        WorkspaceDataSourceORM(id="ds_ben", workspace_id=PG, provider_id="prov_sandbox", graph_name="blank_c",
                               label="Ben's", created_by=BEN.id, created_at=T0, updated_at=T0),
        WorkspaceDataSourceORM(id="ds_ada_prod", workspace_id="ws_team", provider_id="prov_sandbox",
                               graph_name="sales", label="Sales", created_by=ADA.id, created_at=T0, updated_at=T0),
    ])
    await db_session.flush()
    db_session.add_all([
        ViewORM(id="v_a", name="First view", workspace_id=PG, data_source_id="ds_ada_a", view_type="graph",
                visibility="private", created_by=ADA.id, config="{}", created_at=T0, updated_at=T0),
        ViewORM(id="v_b", name="Shared view", workspace_id=PG, data_source_id="ds_ada_b", view_type="graph",
                visibility="workspace", created_by=ADA.id, config="{}", created_at=T0, updated_at=T0),
        ViewORM(id="v_b_trash", name="Old view", workspace_id=PG, data_source_id="ds_ada_b", view_type="graph",
                visibility="private", created_by=ADA.id, config="{}", created_at=T0, updated_at=T0,
                deleted_at=T0),
    ])
    await db_session.commit()


def _ask(**overrides) -> dict:
    return {"name": "Ada's Lab", "purpose": "project", "description": "Lineage for the lab",
            "teammateIds": [BEN.id], "playgroundSourceIds": ["ds_ada_a", "ds_ada_b"], **overrides}


async def _submit(client: AsyncClient, **overrides) -> dict:
    with _as(ADA, PLAYER):
        r = await client.post("/api/v1/workspace-requests", json=_ask(**overrides))
    assert r.status_code == 201, r.text
    return r.json()


async def _kinds(session, user_id: str) -> dict[str, str]:
    rows = (await session.execute(
        select(NotificationORM).where(NotificationORM.user_id == user_id)
        .execution_options(populate_existing=True)
    )).scalars().all()
    return {n.kind: n.link for n in rows}


async def _events(session, prefix: str) -> list[tuple[str, dict]]:
    rows = (await session.execute(
        select(OutboxEventORM).where(OutboxEventORM.event_type.like(f"{prefix}%"))
    )).scalars().all()
    return [(e.event_type, json.loads(e.payload)) for e in rows]


# ── Asking ──────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_off_by_default_asking_is_refused_but_answering_is_not(test_client: AsyncClient, estate, db_session):
    with _as(ADA, PLAYER):
        r = await test_client.post("/api/v1/workspace-requests", json=_ask())
    assert r.status_code == 403
    assert r.json()["detail"]["type"] == "feature_disabled"
    # A request already sent is still answered with the switch off.
    db_session.add(WorkspaceRequestORM(id="wsr_old", requester_id=ADA.id, name="Old", purpose="other",
                                       created_at=T0, updated_at=T0))
    await db_session.commit()
    with _as(ADA, PLAYER):
        resubmit = await test_client.put("/api/v1/me/workspace-requests/wsr_old", json=_ask())
    with _as(OLGA, APPROVER):
        declined = await test_client.post("/api/v1/admin/workspace-requests/wsr_old/decline", json={})
    assert resubmit.status_code == 403
    assert declined.status_code == 200, declined.text
    assert declined.json()["status"] == "declined"


@pytest.mark.asyncio
async def test_submitting_records_it_and_tells_the_approvers(test_client: AsyncClient, estate, db_session, flag_on):
    body = await _submit(test_client, teammateIds=[BEN.id, ADA.id, BEN.id])
    assert body["id"].startswith("wsr_") and body["status"] == "pending"
    assert body["requesterId"] == ADA.id and body["requesterName"] == "Ada T"
    assert body["teammateIds"] == [BEN.id]   # the requester is its admin, not a teammate
    assert body["teammates"] == [{"id": BEN.id, "displayName": "Ben T"}]
    assert body["playgroundSources"] == [
        {"id": "ds_ada_a", "label": "Ada's first", "viewCount": 1},
        {"id": "ds_ada_b", "label": "Ada's second", "viewCount": 1},   # the trashed view isn't counted
    ]
    assert (await _kinds(db_session, OLGA.id)) == {"workspace_request.submitted": "/workspaces?tab=requests"}
    assert [t for t, _ in await _events(db_session, "workspace.request.")] == ["workspace.request.submitted"]


@pytest.mark.asyncio
@pytest.mark.parametrize("name, suggestion", [(" team ", "team 2"), ("analytics", "analytics 3")])
async def test_a_taken_name_is_refused_with_a_free_one_suggested(test_client: AsyncClient, estate, flag_on,
                                                                 name, suggestion):
    with _as(ADA, PLAYER):
        r = await test_client.post("/api/v1/workspace-requests", json=_ask(name=name))
    assert r.status_code == 409
    assert r.json()["detail"]["type"] == "name_taken"
    assert r.json()["detail"]["suggestion"] == suggestion


@pytest.mark.asyncio
@pytest.mark.parametrize("overrides", [
    {"name": "   "},
    {"name": "x" * 121},
    {"purpose": "fun"},
    {"playgroundSourceIds": ["ds_ben"]},        # someone else's graph
    {"playgroundSourceIds": ["ds_ada_prod"]},   # not in the Playground
    {"playgroundSourceIds": ["ds_missing"]},
    {"teammateIds": [CAL.id]},                  # suspended
    {"teammateIds": ["usr_nobody"]},
])
async def test_what_is_asked_for_is_checked(test_client: AsyncClient, estate, flag_on, overrides):
    with _as(ADA, PLAYER):
        r = await test_client.post("/api/v1/workspace-requests", json=_ask(**overrides))
    assert r.status_code == 422, r.text
    assert isinstance(r.json()["detail"], str)


@pytest.mark.asyncio
async def test_one_open_request_per_person(test_client: AsyncClient, estate, flag_on):
    first = await _submit(test_client)
    with _as(ADA, PLAYER):
        again = await test_client.post("/api/v1/workspace-requests", json=_ask(name="Another"))
    assert again.status_code == 409
    assert again.json()["detail"]["type"] == "request_open"
    assert again.json()["detail"]["requestId"] == first["id"]


@pytest.mark.asyncio
async def test_withdrawing_closes_it_and_frees_the_person_to_ask_again(test_client: AsyncClient, estate, flag_on):
    first = await _submit(test_client)
    with _as(ADA, PLAYER):
        withdrawn = await test_client.post(f"/api/v1/me/workspace-requests/{first['id']}/withdraw")
        twice = await test_client.post(f"/api/v1/me/workspace-requests/{first['id']}/withdraw")
        mine = await test_client.get("/api/v1/me/workspace-requests")
    assert withdrawn.status_code == 200 and withdrawn.json()["status"] == "withdrawn"
    assert withdrawn.json()["resolvedBy"] == ADA.id
    assert twice.status_code == 409 and twice.json()["detail"]["type"] == "wrong_status"
    assert [r["id"] for r in mine.json()] == [first["id"]]
    await _submit(test_client)


# ── Who sees and answers ────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_only_approvers_list_and_answer_and_never_their_own(test_client: AsyncClient, estate, db_session,
                                                                 flag_on):
    req = await _submit(test_client)
    with _as(ADA, PLAYER):
        listed = await test_client.get("/api/v1/admin/workspace-requests")
        approved = await test_client.post(f"/api/v1/admin/workspace-requests/{req['id']}/approve")
    assert listed.status_code == 403 and approved.status_code == 403
    with _as(OLGA, APPROVER):
        listed = await test_client.get("/api/v1/admin/workspace-requests")
        bad = await test_client.get("/api/v1/admin/workspace-requests?status=maybe")
        own = await test_client.post("/api/v1/workspace-requests",
                                     json=_ask(name="Olga's", playgroundSourceIds=[]))
        answer_own = await test_client.post(f"/api/v1/admin/workspace-requests/{own.json()['id']}/approve")
    assert [r["id"] for r in listed.json()] == [req["id"]]
    assert bad.status_code == 400
    assert answer_own.status_code == 403 and answer_own.json()["detail"]["type"] == "own_request"


@pytest.mark.asyncio
async def test_a_requester_sees_only_their_own(test_client: AsyncClient, estate, flag_on):
    req = await _submit(test_client)
    with _as(BEN, PLAYER):
        read = await test_client.get(f"/api/v1/me/workspace-requests/{req['id']}")
        withdraw = await test_client.post(f"/api/v1/me/workspace-requests/{req['id']}/withdraw")
        mine = await test_client.get("/api/v1/me/workspace-requests")
    with _as(ADA, PLAYER):
        hers = await test_client.get(f"/api/v1/me/workspace-requests/{req['id']}")
    assert read.status_code == 404 and withdraw.status_code == 404
    assert mine.json() == []
    assert hers.status_code == 200 and hers.json()["name"] == "Ada's Lab"


@pytest.mark.asyncio
async def test_an_approver_reads_what_the_requester_built(test_client: AsyncClient, estate, flag_on):
    req = await _submit(test_client)
    with _as(OLGA, APPROVER):
        r = await test_client.get(f"/api/v1/admin/workspace-requests/{req['id']}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["requesterEmail"] == ADA.email and body["requesterName"] == "Ada T"
    assert body["playgroundActivity"] == {"graphs": 2, "views": 2}
    assert [s["viewCount"] for s in body["playgroundSources"]] == [1, 1]


# ── Approving ───────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_approving_creates_the_workspace_binds_its_people_and_moves_the_graphs(
    test_client: AsyncClient, estate, db_session, flag_on,
):
    req = await _submit(test_client)
    with _as(OLGA, APPROVER):
        r = await test_client.post(f"/api/v1/admin/workspace-requests/{req['id']}/approve",
                                   json={"name": "Lineage Lab", "description": "Approved"})
    assert r.status_code == 200, r.text
    body = r.json()
    ws_id = body["workspaceId"]
    assert body["status"] == "approved" and body["resolvedBy"] == OLGA.id
    assert body["outcome"] == {"movedSources": ["ds_ada_a", "ds_ada_b"], "failedSources": [],
                               "membersAdded": [BEN.id], "workspaceId": ws_id}

    ws = (await db_session.execute(
        select(WorkspaceORM).where(WorkspaceORM.id == ws_id).execution_options(populate_existing=True)
    )).scalar_one()
    assert (ws.name, ws.description, ws.created_by, ws.kind) == ("Lineage Lab", "Approved", ADA.id, "standard")
    bindings = (await db_session.execute(
        select(RoleBindingORM.subject_id, RoleBindingORM.role_name).where(RoleBindingORM.scope_id == ws_id)
    )).all()
    assert sorted(bindings) == [(ADA.id, "workspace_admin"), (BEN.id, "workspace_member")]

    sources = (await db_session.execute(
        select(WorkspaceDataSourceORM.id, WorkspaceDataSourceORM.workspace_id)
        .where(WorkspaceDataSourceORM.id.in_(["ds_ada_a", "ds_ada_b", "ds_ben"]))
        .execution_options(populate_existing=True)
    )).all()
    assert dict(sources) == {"ds_ada_a": ws_id, "ds_ada_b": ws_id, "ds_ben": PG}
    views = dict((await db_session.execute(
        select(ViewORM.id, ViewORM.workspace_id).execution_options(populate_existing=True)
    )).all())
    assert views == {"v_a": ws_id, "v_b": ws_id, "v_b_trash": ws_id}

    assert (await _kinds(db_session, ADA.id))["workspace_request.approved"] == f"/workspaces/{ws_id}?welcome=1"
    assert (await _kinds(db_session, BEN.id))["workspace.member_added"] == f"/workspaces/{ws_id}"
    created = await _events(db_session, "rbac.workspace.created")
    assert [(p["workspace_id"], p["actor_id"]) for _, p in created] == [(ws_id, OLGA.id)]
    bound = await _events(db_session, "rbac.workspace.member_bound")
    assert sorted((p["subject_id"], p["role"]) for _, p in bound) == [
        (ADA.id, "workspace_admin"), (BEN.id, "workspace_member")]
    assert [t for t, _ in await _events(db_session, "workspace.request.")] == [
        "workspace.request.submitted", "workspace.request.approved"]
    with _as(OLGA, APPROVER):
        again = await test_client.post(f"/api/v1/admin/workspace-requests/{req['id']}/approve")
    assert again.status_code == 409 and again.json()["detail"]["type"] == "wrong_status"


@pytest.mark.asyncio
async def test_a_graph_that_cannot_move_is_recorded_and_the_workspace_kept(
    test_client: AsyncClient, estate, db_session, flag_on,
):
    req = await _submit(test_client)
    gone = await db_session.get(WorkspaceDataSourceORM, "ds_ada_a")
    gone.deleted_at = T0   # deleted after the request was sent
    await db_session.commit()
    with _as(OLGA, APPROVER):
        r = await test_client.post(f"/api/v1/admin/workspace-requests/{req['id']}/approve")
    assert r.status_code == 200, r.text
    outcome = r.json()["outcome"]
    assert outcome["movedSources"] == ["ds_ada_b"]
    assert outcome["failedSources"] == [{"id": "ds_ada_a", "reason": "It is no longer in the Playground."}]
    ws = (await db_session.execute(
        select(WorkspaceORM).where(WorkspaceORM.id == outcome["workspaceId"])
    )).scalar_one_or_none()
    assert ws is not None and ws.name == "Ada's Lab"
    stored = (await db_session.execute(
        select(WorkspaceRequestORM).where(WorkspaceRequestORM.id == req["id"])
        .execution_options(populate_existing=True)
    )).scalar_one()
    assert stored.status == "approved" and json.loads(stored.outcome) == outcome


@pytest.mark.asyncio
async def test_a_move_refused_midway_rolls_back_only_itself(
    test_client: AsyncClient, estate, db_session, flag_on, version_store,
):
    req = await _submit(test_client, playgroundSourceIds=["ds_ada_b"])
    version_store.busy = "an import"
    with _as(OLGA, APPROVER):
        r = await test_client.post(f"/api/v1/admin/workspace-requests/{req['id']}/approve")
    assert r.status_code == 200, r.text
    outcome = r.json()["outcome"]
    assert outcome["movedSources"] == []
    assert [f["id"] for f in outcome["failedSources"]] == ["ds_ada_b"]
    assert "busy" in outcome["failedSources"][0]["reason"]
    ws_id = outcome["workspaceId"]
    assert (await db_session.execute(select(WorkspaceORM.id).where(WorkspaceORM.id == ws_id))).scalar_one()
    bound = (await db_session.execute(
        select(RoleBindingORM.subject_id).where(RoleBindingORM.scope_id == ws_id)
    )).scalars().all()
    assert sorted(bound) == [ADA.id, BEN.id]
    source = (await db_session.execute(
        select(WorkspaceDataSourceORM.workspace_id).where(WorkspaceDataSourceORM.id == "ds_ada_b")
        .execution_options(populate_existing=True)
    )).scalar_one()
    assert source == PG


@pytest.mark.asyncio
async def test_approving_checks_the_name_again(test_client: AsyncClient, estate, db_session, flag_on):
    req = await _submit(test_client)
    db_session.add(WorkspaceORM(id="ws_late", name="ADA'S LAB"))
    await db_session.commit()
    with _as(OLGA, APPROVER):
        clash = await test_client.post(f"/api/v1/admin/workspace-requests/{req['id']}/approve")
        override_clash = await test_client.post(f"/api/v1/admin/workspace-requests/{req['id']}/approve",
                                                json={"name": "Team"})
        renamed = await test_client.post(f"/api/v1/admin/workspace-requests/{req['id']}/approve",
                                         json={"name": "Ada's Lab 2"})
    assert clash.status_code == 409 and clash.json()["detail"]["type"] == "name_taken"
    assert clash.json()["detail"]["suggestion"] == "Ada's Lab 2"
    assert override_clash.status_code == 409
    assert renamed.status_code == 200, renamed.text


# ── Sending back, resubmitting, declining ───────────────────────────────

@pytest.mark.asyncio
async def test_sent_back_resubmitted_then_pending_again(test_client: AsyncClient, estate, db_session, flag_on):
    req = await _submit(test_client)
    with _as(OLGA, APPROVER):
        empty = await test_client.post(f"/api/v1/admin/workspace-requests/{req['id']}/send-back",
                                       json={"question": ""})
        sent = await test_client.post(f"/api/v1/admin/workspace-requests/{req['id']}/send-back",
                                      json={"question": "Which team is this for?"})
        approve_now = await test_client.post(f"/api/v1/admin/workspace-requests/{req['id']}/approve")
    assert empty.status_code == 422
    assert sent.status_code == 200, sent.text
    assert (sent.json()["status"], sent.json()["question"]) == ("changes_requested", "Which team is this for?")
    assert approve_now.status_code == 409
    assert (await _kinds(db_session, ADA.id)) == {"workspace_request.sent_back": "/my/access?tab=workspaces"}

    with _as(ADA, PLAYER):
        again = await test_client.put(f"/api/v1/me/workspace-requests/{req['id']}",
                                      json=_ask(name="Risk Lab", teamName="Risk", playgroundSourceIds=["ds_ada_b"]))
        twice = await test_client.put(f"/api/v1/me/workspace-requests/{req['id']}", json=_ask())
    assert again.status_code == 200, again.text
    body = again.json()
    assert (body["status"], body["question"], body["name"], body["teamName"]) == ("pending", None, "Risk Lab", "Risk")
    assert body["playgroundSourceIds"] == ["ds_ada_b"]
    assert twice.status_code == 409 and twice.json()["detail"]["type"] == "wrong_status"
    assert "workspace_request.resubmitted" in await _kinds(db_session, OLGA.id)


@pytest.mark.asyncio
async def test_declining_closes_it_with_the_reason(test_client: AsyncClient, estate, db_session, flag_on):
    req = await _submit(test_client)
    with _as(OLGA, APPROVER):
        r = await test_client.post(f"/api/v1/admin/workspace-requests/{req['id']}/decline",
                                   json={"reason": "Use the Risk workspace."})
    assert r.status_code == 200, r.text
    assert (r.json()["status"], r.json()["resolutionNote"]) == ("declined", "Use the Risk workspace.")
    assert (await _kinds(db_session, ADA.id)) == {"workspace_request.declined": "/my/access?tab=workspaces"}
    with _as(ADA, PLAYER):
        withdraw = await test_client.post(f"/api/v1/me/workspace-requests/{req['id']}/withdraw")
    assert withdraw.status_code == 409
    assert (await db_session.execute(select(WorkspaceORM).where(WorkspaceORM.name == "Ada's Lab"))).first() is None
