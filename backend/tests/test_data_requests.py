"""Data requests: a workspace's readers ask for data to be connected to it; the platform team connects it.

These pin what makes a request safe: it is off until an administrator turns it on; only
someone who can read the workspace may ask, and everyone who can read it sees its
requests; what is asked for is checked (a title, a known system, active contacts, never
the Playground); only the platform team or the workspace's admins move a request on —
and a named Owner or Steward of the source it became may mark it connected — while the
requester never answers their own, and only the platform team declines; connecting it
names a data source in that workspace or none; the requester withdraws only their own,
while nobody has taken it; and everyone involved is told.
"""
from __future__ import annotations

import contextlib
import json

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from backend.app.auth.dependencies import get_current_user, get_optional_user, get_permission_claims
from backend.app.db.models import (
    DataRequestORM, DataSourceContactORM, GroupMemberORM, GroupORM, NotificationORM, OutboxEventORM, RoleBindingORM,
    UserORM, WorkspaceDataSourceORM, WorkspaceORM,
)
from backend.app.services import data_requests as service
from backend.app.services.feature_flags import feature_flags
from backend.app.services.permission_service import PermissionClaims
from backend.auth_service.interface import User

T0 = "2026-11-20T00:00:00+00:00"
WS = "ws_fin"
URL = f"/api/v1/admin/workspaces/{WS}/data-requests"
READ = ("workspace:datasource:read", "workspace:view:read")


def _user(uid: str) -> User:
    return User(id=uid, email=f"{uid}@example.com", first_name=uid[4:].title(), last_name="T",
                role="user", status="active", created_at=T0, updated_at=T0)


ADA, BEN, CAL, EVE, GIA, OLGA, WALT = (
    _user(u) for u in ("usr_ada", "usr_ben", "usr_cal", "usr_eve", "usr_gia", "usr_olga", "usr_walt")
)
VIEWER = PermissionClaims(sid="s_v", ws_perms={WS: READ})                                       # Ada, Gia
MANAGER = PermissionClaims(sid="s_m", ws_perms={WS: (*READ, "workspace:datasource:manage")})   # Ben
ADMIN = PermissionClaims(sid="s_a", ws_perms={WS: (*READ, "workspace:datasource:manage", "workspace:admin")})  # Walt
OUTSIDER = PermissionClaims(sid="s_x", ws_perms={"ws_other": READ})                            # Eve
PLATFORM = PermissionClaims(sid="s_o", global_perms=("system:org-admin", "system:workspaces:create"), ws_perms={})


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
    feature_flags._cache["dataRequestsEnabled"] = True
    yield
    feature_flags._cache["dataRequestsEnabled"] = False


@pytest.fixture
async def estate(db_session):
    """Finance (Walt its Workspace Admin) with a live source and a deleted one; another
    workspace with its own source; the Playground; Olga an Org Admin; Cal suspended."""
    for user, state in ((ADA, "active"), (BEN, "active"), (CAL, "suspended"), (EVE, "active"),
                        (GIA, "active"), (OLGA, "active"), (WALT, "active")):
        db_session.add(UserORM(id=user.id, email=user.email, password_hash="x", first_name=user.first_name,
                               last_name="T", status=state, created_at=T0, updated_at=T0))
    db_session.add_all([
        WorkspaceORM(id=WS, name="Finance"),
        WorkspaceORM(id="ws_other", name="Other"),
        WorkspaceORM(id="ws_play", name="Playground", kind="playground"),
    ])
    await db_session.flush()
    db_session.add_all([
        RoleBindingORM(subject_type="user", subject_id=OLGA.id, role_name="org_admin", scope_type="global"),
        RoleBindingORM(subject_type="user", subject_id=WALT.id, role_name="workspace_admin",
                       scope_type="workspace", scope_id=WS),
        WorkspaceDataSourceORM(id="ds_fin", workspace_id=WS, provider_id="prov", graph_name="ledger",
                               label="General ledger", created_at=T0, updated_at=T0),
        WorkspaceDataSourceORM(id="ds_gone", workspace_id=WS, provider_id="prov", graph_name="old",
                               label="Old", created_at=T0, updated_at=T0, deleted_at=T0),
        WorkspaceDataSourceORM(id="ds_other", workspace_id="ws_other", provider_id="prov", graph_name="ops",
                               label="Ops", created_at=T0, updated_at=T0),
    ])
    await db_session.commit()


@pytest.fixture
async def contacts(estate, db_session):
    """General ledger names Ben its Steward and the Ledger team (Gia) its Owner; Finance's
    second source, Payables, names nobody."""
    db_session.add_all([
        GroupORM(id="grp_ledger", name="Ledger team"),
        WorkspaceDataSourceORM(id="ds_ap", workspace_id=WS, provider_id="prov", graph_name="ap",
                               label="Payables", created_at=T0, updated_at=T0),
    ])
    await db_session.flush()
    db_session.add_all([
        GroupMemberORM(group_id="grp_ledger", user_id=GIA.id),
        DataSourceContactORM(data_source_id="ds_fin", role="owner", subject_type="group",
                             subject_id="grp_ledger", created_at=T0),
        DataSourceContactORM(data_source_id="ds_fin", role="steward", subject_type="user",
                             subject_id=BEN.id, created_at=T0),
    ])
    await db_session.commit()


def _ask(**overrides) -> dict:
    return {"title": "Finance marts", "system": "snowflake", "details": "FIN_DB.MARTS — gl_* and ap_*",
            "purpose": "Month-end close lineage", "urgency": "this_month", "contactIds": [BEN.id], **overrides}


async def _submit(client: AsyncClient, user: User = ADA, claims: PermissionClaims = VIEWER, **overrides) -> dict:
    with _as(user, claims):
        r = await client.post(URL, json=_ask(**overrides))
    assert r.status_code == 201, r.text
    return r.json()


async def _kinds(session, user_id: str) -> dict[str, str]:
    rows = (await session.execute(
        select(NotificationORM).where(NotificationORM.user_id == user_id)
        .execution_options(populate_existing=True)
    )).scalars().all()
    return {n.kind: n.link for n in rows}


async def _events(session) -> list[tuple[str, dict]]:
    rows = (await session.execute(
        select(OutboxEventORM).where(OutboxEventORM.event_type.like("workspace.data_request.%"))
        .order_by(OutboxEventORM.id)
    )).scalars().all()
    return [(e.event_type, json.loads(e.payload)) for e in rows]


async def _act(client: AsyncClient, user: User, claims: PermissionClaims, request_id: str, verb: str, body=None):
    with _as(user, claims):
        return await client.post(f"/api/v1/admin/data-requests/{request_id}/{verb}", json=body or {})


# ── Asking ──────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_off_by_default_asking_is_refused_but_answering_is_not(test_client: AsyncClient, estate, db_session):
    with _as(ADA, VIEWER):
        r = await test_client.post(URL, json=_ask())
    assert r.status_code == 403
    assert r.json()["detail"]["type"] == "feature_disabled"
    # A request already sent is still read, and answered, with the switch off.
    db_session.add(DataRequestORM(id="dr_old", workspace_id=WS, requested_by=ADA.id, title="Old ask",
                                  system="dbt", created_at=T0, updated_at=T0))
    await db_session.commit()
    with _as(ADA, VIEWER):
        listed = await test_client.get(URL)
    started = await _act(test_client, OLGA, PLATFORM, "dr_old", "start")
    assert [r["id"] for r in listed.json()] == ["dr_old"]
    assert started.status_code == 200, started.text
    assert started.json()["status"] == "in_progress"


@pytest.mark.asyncio
async def test_asking_records_it_and_tells_the_platform_team_and_the_workspaces_admins(
    test_client: AsyncClient, estate, db_session, flag_on,
):
    body = await _submit(test_client, contactIds=[BEN.id, ADA.id, BEN.id])
    assert body["id"].startswith("dr_") and body["status"] == "pending"
    assert (body["workspaceId"], body["workspaceName"]) == (WS, "Finance")
    assert (body["requestedBy"], body["requesterName"]) == (ADA.id, "Ada T")
    assert (body["title"], body["system"], body["urgency"]) == ("Finance marts", "snowflake", "this_month")
    assert body["details"] == "FIN_DB.MARTS — gl_* and ap_*" and body["purpose"] == "Month-end close lineage"
    assert body["contactIds"] == [BEN.id]   # the requester is the requester, not a contact
    assert body["contacts"] == [{"id": BEN.id, "displayName": "Ben T"}]
    assert body["assigneeId"] is None and body["dataSourceId"] is None

    assert (await _kinds(db_session, OLGA.id)) == {"data_request.submitted": "/workspaces?tab=requests"}
    assert (await _kinds(db_session, WALT.id)) == {
        "data_request.submitted": "/workspaces/ws_fin?tab=data&section=sources",
    }
    assert (await _kinds(db_session, ADA.id)) == {}   # never told of what you did yourself
    [(kind, payload)] = await _events(db_session)
    assert kind == "workspace.data_request.submitted"
    assert payload["workspace_id"] == WS and payload["requester_id"] == ADA.id and payload["actor_id"] == ADA.id


@pytest.mark.asyncio
@pytest.mark.parametrize("overrides", [
    {"title": "   "},
    {"title": "x" * 121},
    {"system": "oracle"},
    {"urgency": "yesterday"},
    {"details": "x" * 2001},
    {"contactIds": [CAL.id]},          # suspended
    {"contactIds": ["usr_nobody"]},
])
async def test_what_is_asked_for_is_checked(test_client: AsyncClient, estate, flag_on, overrides):
    with _as(ADA, VIEWER):
        r = await test_client.post(URL, json=_ask(**overrides))
    assert r.status_code == 422, r.text


@pytest.mark.asyncio
async def test_the_playground_takes_no_data_requests(test_client: AsyncClient, estate, flag_on):
    with _as(OLGA, PLATFORM):
        r = await test_client.post("/api/v1/admin/workspaces/ws_play/data-requests", json=_ask())
        missing = await test_client.post("/api/v1/admin/workspaces/ws_nowhere/data-requests", json=_ask())
    assert r.status_code == 422 and r.json()["detail"]["type"] == "playground"
    assert missing.status_code == 404


@pytest.mark.asyncio
async def test_only_the_workspaces_readers_ask_and_see_its_requests(test_client: AsyncClient, estate, flag_on):
    ada = await _submit(test_client)
    ben = await _submit(test_client, BEN, MANAGER, title="dbt core", system="dbt")
    with _as(EVE, OUTSIDER):
        asked = await test_client.post(URL, json=_ask())
        listed = await test_client.get(URL)
        started = await test_client.post(f"/api/v1/admin/data-requests/{ada['id']}/start")
    assert asked.status_code == 403 and listed.status_code == 403
    assert started.status_code == 404   # not a workspace of hers: not hers to know of

    with _as(ADA, VIEWER):
        everyone = await test_client.get(URL)
        open_only = await test_client.get(f"{URL}?status=open")
        bad = await test_client.get(f"{URL}?status=maybe")
        mine = await test_client.get("/api/v1/me/data-requests")
    assert [r["id"] for r in everyone.json()] == [ben["id"], ada["id"]]   # a member sees them all
    assert len(open_only.json()) == 2 and bad.status_code == 400
    assert [r["id"] for r in mine.json()] == [ada["id"]]


@pytest.mark.asyncio
async def test_the_requester_withdraws_their_own_while_nobody_has_taken_it(
    test_client: AsyncClient, estate, db_session, flag_on,
):
    first = await _submit(test_client)
    second = await _submit(test_client, title="Second")
    with _as(BEN, MANAGER):
        not_his = await test_client.post(f"/api/v1/me/data-requests/{first['id']}/withdraw")
    with _as(ADA, VIEWER):
        withdrawn = await test_client.post(f"/api/v1/me/data-requests/{first['id']}/withdraw")
        twice = await test_client.post(f"/api/v1/me/data-requests/{first['id']}/withdraw")
    assert not_his.status_code == 404
    assert withdrawn.status_code == 200 and withdrawn.json()["status"] == "withdrawn"
    assert withdrawn.json()["resolvedBy"] == ADA.id and withdrawn.json()["resolvedAt"]
    assert twice.status_code == 409 and twice.json()["detail"]["type"] == "wrong_status"

    assert (await _act(test_client, OLGA, PLATFORM, second["id"], "start")).status_code == 200
    with _as(ADA, VIEWER):
        taken = await test_client.post(f"/api/v1/me/data-requests/{second['id']}/withdraw")
    assert taken.status_code == 409
    assert "workspace.data_request.withdrawn" in [k for k, _ in await _events(db_session)]


# ── Moving a request on ─────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_only_the_platform_team_or_the_workspaces_admins_move_it_on(
    test_client: AsyncClient, estate, db_session, flag_on,
):
    req = await _submit(test_client, GIA, VIEWER)
    for user, claims in ((ADA, VIEWER), (BEN, MANAGER)):   # a reader, and someone who manages its data
        for verb in ("start", "connect"):
            refused = await _act(test_client, user, claims, req["id"], verb)
            assert refused.status_code == 403, (user.id, verb)
            assert refused.json()["detail"]["type"] == "not_fulfiller"

    started = await _act(test_client, WALT, ADMIN, req["id"], "start")
    assert started.status_code == 200, started.text
    assert started.json()["status"] == "in_progress"
    assert (started.json()["assigneeId"], started.json()["assigneeName"]) == (WALT.id, "Walt T")
    assert (await _kinds(db_session, GIA.id)) == {"data_request.started": "/workspaces/ws_fin?tab=data&section=sources"}
    again = await _act(test_client, OLGA, PLATFORM, req["id"], "start")
    assert again.status_code == 409 and again.json()["detail"]["type"] == "wrong_status"

    # Declining is the platform team's alone.
    declined_by_walt = await _act(test_client, WALT, ADMIN, req["id"], "decline", {"reason": "No"})
    assert declined_by_walt.status_code == 403
    declined = await _act(test_client, OLGA, PLATFORM, req["id"], "decline", {"reason": "  Covered by Finance Data  "})
    assert declined.status_code == 200, declined.text
    body = declined.json()
    assert (body["status"], body["resolvedBy"], body["resolutionNote"]) == ("declined", OLGA.id, "Covered by Finance Data")
    assert "data_request.declined" in await _kinds(db_session, GIA.id)
    assert (await _act(test_client, OLGA, PLATFORM, req["id"], "connect")).status_code == 409


@pytest.mark.asyncio
async def test_the_requester_never_answers_their_own_request(test_client: AsyncClient, estate, flag_on):
    walts = await _submit(test_client, WALT, ADMIN)
    olgas = await _submit(test_client, OLGA, PLATFORM, title="Olga's own")
    for user, claims, req in ((WALT, ADMIN, walts), (OLGA, PLATFORM, olgas)):
        for verb, body in (("start", None), ("connect", {"dataSourceId": "ds_fin"}), ("decline", {"reason": "x"})):
            r = await _act(test_client, user, claims, req["id"], verb, body)
            assert r.status_code == 403, (user.id, verb)
            assert r.json()["detail"]["type"] == "own_request"
    # Somebody else can.
    assert (await _act(test_client, OLGA, PLATFORM, walts["id"], "start")).status_code == 200
    assert (await _act(test_client, WALT, ADMIN, olgas["id"], "connect")).status_code == 200


@pytest.mark.asyncio
async def test_a_named_owner_or_steward_connects_it_as_their_own_source(
    test_client: AsyncClient, contacts, flag_on,
):
    req = await _submit(test_client)
    # Taking it on, or connecting it as another source or none, stays with the admins and the platform team.
    for verb, body in (("start", None), ("connect", None), ("connect", {"dataSourceId": "ds_ap"})):
        r = await _act(test_client, BEN, MANAGER, req["id"], verb, body)
        assert r.status_code == 403 and r.json()["detail"]["type"] == "not_fulfiller", (verb, body)

    connected = await _act(test_client, BEN, MANAGER, req["id"], "connect", {"dataSourceId": "ds_fin"})
    assert connected.status_code == 200, connected.text
    assert (connected.json()["status"], connected.json()["resolvedBy"]) == ("connected", BEN.id)

    # The Owner here is a group: its members count too, with no other right in the workspace.
    other = await _submit(test_client, title="More ledger")
    by_gia = await _act(test_client, GIA, VIEWER, other["id"], "connect", {"dataSourceId": "ds_fin"})
    assert by_gia.status_code == 200, by_gia.text


@pytest.mark.asyncio
async def test_a_source_naming_nobody_gives_its_creator_no_say(test_client: AsyncClient, contacts, db_session, flag_on):
    ds = await db_session.get(WorkspaceDataSourceORM, "ds_ap")
    ds.created_by = BEN.id
    await db_session.commit()
    req = await _submit(test_client)
    r = await _act(test_client, BEN, MANAGER, req["id"], "connect", {"dataSourceId": "ds_ap"})
    assert r.status_code == 403 and r.json()["detail"]["type"] == "not_fulfiller"


@pytest.mark.asyncio
async def test_connecting_names_a_source_in_the_requests_workspace_or_none(
    test_client: AsyncClient, estate, db_session, flag_on,
):
    req = await _submit(test_client)
    for ds in ("ds_other", "ds_gone", "ds_nowhere"):
        r = await _act(test_client, OLGA, PLATFORM, req["id"], "connect", {"dataSourceId": ds})
        assert r.status_code == 422, ds
        assert r.json()["detail"]["type"] == "data_source_elsewhere"

    connected = await _act(test_client, WALT, ADMIN, req["id"], "connect",
                           {"dataSourceId": "ds_fin", "note": "Ledger is in — the marts follow on Friday."})
    assert connected.status_code == 200, connected.text
    body = connected.json()
    assert (body["status"], body["dataSourceId"], body["dataSourceLabel"]) == ("connected", "ds_fin", "General ledger")
    assert body["resolvedBy"] == WALT.id and body["resolutionNote"] == "Ledger is in — the marts follow on Friday."
    assert (await _kinds(db_session, ADA.id)) == {
        "data_request.connected": "/workspaces/ws_fin?tab=data&section=sources",
    }
    events = dict(await _events(db_session))
    assert events["workspace.data_request.connected"]["data_source_id"] == "ds_fin"

    # Connected later, through Add source, or outside the product: no source named.
    other = await _submit(test_client, title="A file")
    later = await _act(test_client, OLGA, PLATFORM, other["id"], "connect")
    assert later.status_code == 200 and later.json()["dataSourceId"] is None


@pytest.mark.asyncio
async def test_the_platform_queue_is_the_platform_teams(test_client: AsyncClient, estate, flag_on):
    pending = await _submit(test_client)
    done = await _submit(test_client, title="Done")
    await _act(test_client, OLGA, PLATFORM, done["id"], "connect")
    with _as(BEN, MANAGER):
        refused = await test_client.get("/api/v1/admin/data-requests")
    with _as(OLGA, PLATFORM):
        open_ = await test_client.get("/api/v1/admin/data-requests")
        everything = await test_client.get("/api/v1/admin/data-requests?status=all")
        connected = await test_client.get("/api/v1/admin/data-requests?status=connected")
        bad = await test_client.get("/api/v1/admin/data-requests?status=maybe")
    assert refused.status_code == 403
    assert [r["id"] for r in open_.json()] == [pending["id"]]
    assert {r["id"] for r in everything.json()} == {pending["id"], done["id"]}
    assert [r["id"] for r in connected.json()] == [done["id"]]
    assert bad.status_code == 400


# ── Asked for server-side ───────────────────────────────────────────────

@pytest.mark.asyncio
async def test_a_flow_can_ask_on_someones_behalf(estate, db_session):
    rows = await service.create_for_workspace(
        db_session, workspace_id=WS, requested_by=ADA.id,
        items=[{"title": "Finance marts", "system": "snowflake", "contactIds": [BEN.id]},
               {"title": "dbt core", "system": "dbt", "urgency": "this_week"}],
    )
    await db_session.commit()
    assert [(r.title, r.system, r.urgency, r.status) for r in rows] == [
        ("Finance marts", "snowflake", "no_rush", "pending"), ("dbt core", "dbt", "this_week", "pending"),
    ]
    assert json.loads(rows[0].contact_ids) == [BEN.id]
    assert [k for k, _ in await _events(db_session)] == ["workspace.data_request.submitted"] * 2
    assert "data_request.submitted" in await _kinds(db_session, OLGA.id)
