"""Moving a data source — with its views, history and access — to another workspace.

What a move must get right, roughly in the order it would hurt to get wrong:

* **Nothing is left behind naming the old workspace.** Every view on the source moves,
  trashed ones too (restoring one later must not strand it), and so does the view with no
  source of its own that reads the source as its workspace's default — left behind, it would
  silently re-point at a different graph. Their activity moves with them, so the old
  workspace's feed stops listing views it no longer holds; the versioned graph and the
  aggregation state are re-filed too.
* **Access follows a rule people can read.** Owners and people a view is shared with keep it;
  a workspace-shared view's audience becomes the new workspace's, and the mover chooses who
  among the people losing it keeps view-only access to exactly those views.
* **Authority is checked in both workspaces.** Moving a source with views re-homes other
  people's work, so it takes administering both; an admin of only the source asks instead,
  and the destination's admins answer, reading a preview that can't go stale under them.
* **It can be put back** for a week, while nothing new is built on it — and a move that fails
  half-way puts back what it changed in the other store.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select, update

from backend.app.db.models import (
    DataSourceTransferORM,
    NotificationORM,
    OutboxEventORM,
    ProviderORM,
    ResourceGrantORM,
    ViewActivityLogORM,
    ViewORM,
    WorkspaceDataSourceORM,
    WorkspaceORM,
)
from backend.app.db.repositories import user_repo
from backend.app.services import data_source_transfer, view_access
from backend.app.services.aggregation.models import (
    AggregationDataSourceStateORM,
    AggregationJobORM,
)
from backend.app.services.permission_service import resolve
from tests.common.transfer_world import (
    A,
    B,
    C,
    DS,
    DS2,
    LOOSE,
    PEOPLE,
    PROVIDER,
    TEAM,
    VIEWS,
    acting_as,
    add_view,
    build_world,
    fake_version_store,
)
from tests.common.workspace_access_world import directory

VIEW_IDS = [v[0] for v in VIEWS]
REASON = {"X-Activity-Reason": "Team reorganisation"}
TRANSFERS = "/api/v1/admin/data-source-transfers"
VERSIONED = {"graphId": "graph_orders", "activeJobs": [], "commits": 4, "openDrafts": [],
             "openReviews": 0, "forks": 0}


def _src(ws: str = A, ds: str = DS) -> str:
    return f"/api/v1/admin/workspaces/{ws}/data-sources/{ds}"


@pytest.fixture
async def world(db_session, monkeypatch):
    store = fake_version_store(monkeypatch)
    await build_world(db_session)
    return store


async def _preview(client, to: str = B, ds: str = DS) -> dict:
    r = await client.get(f"{_src(ds=ds)}/move-preview", params={"to": to})
    assert r.status_code == 200, r.text
    return r.json()


async def _move(client, to: str = B, keep=None, ds: str = DS, token: bool = True):
    body: dict = {"targetWorkspaceId": to}
    if keep is not None:
        body["keep"] = keep
    if token:
        body["previewToken"] = (await _preview(client, to, ds))["token"]
    return await client.post(f"{_src(ds=ds)}/move", json=body, headers=REASON)


async def _propose(client, keep=None):
    body: dict = {"targetWorkspaceId": B}
    if keep is not None:
        body["keep"] = keep
    return await client.post(f"{_src()}/transfer-requests", json=body, headers=REASON)


async def _fresh(session, model, key):
    return (await session.execute(
        select(model).where(model.id == key).execution_options(populate_existing=True)
    )).scalar_one_or_none()


async def _views(session) -> dict:
    rows = (await session.execute(
        select(ViewORM.id, ViewORM.workspace_id, ViewORM.data_source_id, ViewORM.updated_at))).all()
    return {r[0]: r[1:] for r in rows}


async def _bell(session) -> set:
    return set((await session.execute(select(NotificationORM.user_id, NotificationORM.kind))).all())


async def _events(session, event_type: str) -> list[dict]:
    rows = (await session.execute(
        select(OutboxEventORM.payload).where(OutboxEventORM.event_type == event_type))).scalars().all()
    return [json.loads(p) for p in rows]


async def _can_read(session, name: str, view_id: str) -> bool:
    uid = PEOPLE[name]
    ctx = view_access.ViewerContext(
        user_id=uid, claims=await resolve(session, uid),
        group_ids=tuple(await user_repo.get_groups_for_user(session, uid)))
    return await view_access.can_read_view(session, ctx, await _fresh(session, ViewORM, view_id))


# ── the preview ──────────────────────────────────────────────────────


async def test_the_preview_shows_everything_that_moves(test_client, db_session, world):
    """The trashed view and the view that reads Orders as Finance's default move too."""
    async with acting_as(db_session, "cy"):
        p = await _preview(test_client)

    assert p["mode"] == "direct" and p["blockers"] == []
    assert {v["id"] for v in p["views"]} == {*VIEW_IDS, LOOSE}
    assert p["viewCounts"] == {"total": 7, "trashed": 1, "followsDefault": 1, "private": 2,
                               "workspace": 3, "enterprise": 1, "publishRequested": 1}
    assert {n["code"] for n in p["notes"]} >= {
        "trash", "follows_default", "primary_leaves", "publish_requests", "published_views",
        "destination_primary"}
    assert p["primary"] == {"wasPrimary": True, "wasDefault": True, "becomesPrimary": True,
                            "pinsDestinationDefault": None}


async def test_the_preview_names_who_would_lose_access(test_client, db_session, world):
    """Owners and the people a view is shared with keep it. Finance's audience for its three
    workspace-shared views does not — the Analysts team, Finance's viewer and its other admin —
    unless they can already read Risk's views, as Cy and Mia can."""
    async with acting_as(db_session, "cy"):
        access = (await _preview(test_client))["access"]

    loses = {(s["type"], s["id"]): s for s in access["loses"]}
    assert set(loses) == {("group", TEAM), ("user", PEOPLE["ada"]), ("user", PEOPLE["val"])}
    assert (loses[("group", TEAM)]["views"], loses[("group", TEAM)]["memberCount"]) == (3, 1)
    # Val's grant on the Shared view carries over, so she loses only the other two.
    assert loses[("user", PEOPLE["val"])]["views"] == 2
    assert loses[("user", PEOPLE["ada"])]["role"] == "Admin"
    assert all(s["keep"] for s in loses.values())
    assert {k: access[k] for k in ("creators", "sharedWith", "everyone", "gainsViews",
                                   "gainsPeople", "adminViews")} == {
        "creators": 1, "sharedWith": 1, "everyone": 1, "gainsViews": 3,
        "gainsPeople": 4,          # Bea, Cy, Mia and Rui read Risk's views
        "adminViews": 2,
    }


async def test_the_token_changes_when_what_moves_changes(test_client, db_session, world):
    async with acting_as(db_session, "cy"):
        token = (await _preview(test_client))["token"]
        assert (await _preview(test_client))["token"] == token
        await add_view(db_session, "view_new", ws=A, ds=DS)
        assert (await _preview(test_client))["token"] != token


async def test_destinations_say_how_it_could_go_there(test_client, db_session, world):
    """Only workspaces the caller could see anyway — and for each, a move, a request or why not."""
    async with acting_as(db_session, "cy"):
        listed = (await test_client.get(f"{_src()}/move-destinations")).json()
    assert [(d["id"], d["mode"]) for d in listed] == [(B, "direct")]

    async with acting_as(db_session, "olga"):
        listed = (await test_client.get(f"{_src()}/move-destinations")).json()
    assert [(d["id"], d["mode"]) for d in listed] == [(C, "direct"), (B, "direct")]

    async with acting_as(db_session, "ada"):
        assert (await test_client.get(f"{_src()}/move-destinations")).json() == []
        directory(on=True)
        listed = (await test_client.get(f"{_src()}/move-destinations")).json()
    assert {(d["id"], d["mode"]) for d in listed} == {(B, "request"), (C, "request")}


# ── what stands in the way ───────────────────────────────────────────


async def test_a_workspace_already_holding_the_graph_cannot_take_it(test_client, db_session, world):
    db_session.add(WorkspaceDataSourceORM(id="ds_copy", workspace_id=B, provider_id=PROVIDER,
                                          graph_name="orders", label="Orders copy"))
    await db_session.commit()
    async with acting_as(db_session, "cy"):
        listed = (await test_client.get(f"{_src()}/move-destinations")).json()
        p = await _preview(test_client)
        r = await _move(test_client, token=False)

    assert (listed[0]["mode"], listed[0]["reason"]) == (None, "Already has this graph")
    assert [b["code"] for b in p["blockers"]] == ["already_connected"]
    assert r.status_code == 409 and r.json()["detail"]["error"] == "blocked"
    assert (await _fresh(db_session, WorkspaceDataSourceORM, DS)).workspace_id == A


@pytest.mark.parametrize("setup, code", [
    ("permitted", "not_permitted"),
    ("switched_off", "destination_unavailable"),
])
async def test_a_destination_the_source_may_not_go_to(test_client, db_session, world, setup, code):
    if setup == "permitted":
        await db_session.execute(
            update(ProviderORM).where(ProviderORM.id == PROVIDER).values(permitted_workspaces=json.dumps([A])))
    else:
        await db_session.execute(update(WorkspaceORM).where(WorkspaceORM.id == B).values(is_active=False))
    await db_session.commit()
    async with acting_as(db_session, "cy"):
        p = await _preview(test_client)
        r = await _move(test_client, token=False)
    assert [b["code"] for b in p["blockers"]] == [code]
    assert r.status_code == 409


async def test_work_in_flight_blocks_a_move_but_not_a_request(test_client, db_session, world):
    """An aggregation run in progress would finish in the wrong workspace. A request may still
    be filed — the run will be over by the time anyone reads it — but not accepted while it runs."""
    db_session.add(AggregationJobORM(data_source_id=DS, workspace_id=A, status="running"))
    await db_session.commit()
    async with acting_as(db_session, "cy"):
        p = await _preview(test_client)
        moved = await _move(test_client, token=False)
    assert [(b["code"], b["transient"]) for b in p["blockers"]] == [("aggregation_running", True)]
    assert moved.status_code == 409

    async with acting_as(db_session, "ada"):
        asked = await _propose(test_client)
    assert asked.status_code == 201, asked.text
    async with acting_as(db_session, "bea"):
        detail = (await test_client.get(f"{TRANSFERS}/{asked.json()['id']}")).json()
        r = await test_client.post(f"{TRANSFERS}/{asked.json()['id']}/accept",
                                   json={"previewToken": detail["preview"]["token"]})
    assert r.status_code == 409 and r.json()["detail"]["issues"][0]["code"] == "aggregation_running"


@pytest.mark.parametrize("busy, down, code", [
    ("export", False, "graph_busy"),
    (None, True, "version_store_unavailable"),
])
async def test_the_version_store_must_be_free_and_reachable(test_client, db_session, world,
                                                              busy, down, code):
    world.facts = {**VERSIONED, "activeJobs": [busy] if busy else []}
    world.down = down
    async with acting_as(db_session, "cy"):
        p = await _preview(test_client)
        r = await _move(test_client, token=False)
    assert [b["code"] for b in p["blockers"]] == [code]
    assert r.status_code == 409 and world.relocations == []


# ── who may ──────────────────────────────────────────────────────────


@pytest.mark.parametrize("name", ["max", "mia", "ada"])
async def test_moving_views_takes_administering_both_workspaces(test_client, db_session, world, name):
    """Max manages Finance's sources, Mia manages both workspaces' and Ada runs Finance — none
    of them may re-home Max's views into Risk."""
    async with acting_as(db_session, name):
        r = await _move(test_client, token=False)
    assert r.status_code == 403
    detail = r.json()["detail"]
    assert (detail["error"], detail["permission"]) == ("missing_permission", "workspace:admin")
    assert (await _fresh(db_session, WorkspaceDataSourceORM, DS)).workspace_id == A
    assert await _events(db_session, "user.access_denied")


async def test_a_source_with_nothing_on_it_keeps_the_old_rule(test_client, db_session, world):
    """Ledger has no views: managing data sources in both workspaces is enough, as before."""
    async with acting_as(db_session, "mia"):
        r = await _move(test_client, ds=DS2, token=False)
    assert r.status_code == 200, r.text
    assert (await _fresh(db_session, WorkspaceDataSourceORM, DS2)).workspace_id == B


# ── the move ─────────────────────────────────────────────────────────


async def test_a_move_takes_everything_with_it(test_client, db_session, world):
    world.facts = VERSIONED
    db_session.add_all([
        ViewActivityLogORM(view_id="view_team", workspace_id=A, action="created", actor=PEOPLE["max"]),
        AggregationDataSourceStateORM(data_source_id=DS, workspace_id=A),
        AggregationJobORM(id="agg_done", data_source_id=DS, workspace_id=A, status="completed"),
    ])
    await db_session.commit()
    before = await _views(db_session)

    async with acting_as(db_session, "cy"):
        r = await _move(test_client, keep=[{"type": "group", "id": TEAM}])
    assert r.status_code == 200, r.text
    moved = r.json()
    assert (moved["status"], moved["viewCount"], moved["keptAccess"]) == ("completed", 7, 1)
    assert moved["canUndo"] and moved["reason"] == "Team reorganisation"

    ds = await _fresh(db_session, WorkspaceDataSourceORM, DS)
    assert (ds.workspace_id, ds.is_primary) == (B, True)          # Risk had no source of its own
    after = await _views(db_session)
    assert {v: after[v][0] for v in (*VIEW_IDS, LOOSE)} == {v: B for v in (*VIEW_IDS, LOOSE)}
    assert after[LOOSE][1] == DS                                   # pinned to the source it read
    assert all(after[v][2] == before[v][2] for v in before)        # a move is not an edit
    assert world.relocations == [(DS, B, True)]

    log = set((await db_session.execute(select(
        ViewActivityLogORM.view_id, ViewActivityLogORM.workspace_id, ViewActivityLogORM.action))).all())
    assert ("view_team", B, "created") in log                      # its history went with it
    assert {v for v, ws, action in log if action == "moved" and ws == B} == {*VIEW_IDS, LOOSE}

    granted = set((await db_session.execute(select(
        ResourceGrantORM.resource_id, ResourceGrantORM.subject_id, ResourceGrantORM.role_name
    ).where(ResourceGrantORM.subject_type == "group"))).all())
    assert granted == {(v, TEAM, "viewer") for v in ("view_team", "view_shared", "view_asked")}

    assert await db_session.scalar(select(AggregationDataSourceStateORM.workspace_id).where(
        AggregationDataSourceStateORM.data_source_id == DS)) == B
    assert await db_session.scalar(select(AggregationJobORM.workspace_id).where(
        AggregationJobORM.id == "agg_done")) == A                  # finished runs are history
    assert world.invalidations[0]["workspaces"] == (A, B)
    assert set(world.invalidations[0]["defaults_changed"]) == {A, B}


async def test_kept_access_is_view_only_and_only_to_the_moved_views(test_client, db_session, world):
    async with acting_as(db_session, "cy"):
        assert (await _move(test_client, keep=[{"type": "group", "id": TEAM}])).status_code == 200

    assert await _can_read(db_session, "tom", "view_team")         # kept, through his team
    assert not await _can_read(db_session, "val", "view_team")     # let go
    assert await _can_read(db_session, "val", "view_shared")       # her own grant carried over
    assert await _can_read(db_session, "max", "view_private")      # owners keep their views
    assert await _can_read(db_session, "rui", "view_team")         # Risk's audience gains it
    assert not await _can_read(db_session, "rui", "view_private")


async def test_both_workspaces_and_the_people_affected_hear_about_it(test_client, db_session, world):
    async with acting_as(db_session, "cy"):
        assert (await _move(test_client)).status_code == 200

    events = await _events(db_session, "workspace.data_source.moved")
    assert sorted(e["workspace_id"] for e in events) == [A, B]
    assert {e["stated_reason"] for e in events} == {"Team reorganisation"}
    assert {e["details"]["toWorkspaceName"] for e in events} == {"Risk"}
    assert await _events(db_session, "workspace.datasource.moved") == []

    bell = await _bell(db_session)
    assert {(PEOPLE["ada"], "data_source.moved"), (PEOPLE["bea"], "data_source.moved"),
            (PEOPLE["max"], "data_source.moved")} <= bell
    assert (PEOPLE["cy"], "data_source.moved") not in bell        # never told what you just did
    assert (PEOPLE["bea"], "view.publish_requested") in bell      # Risk answers the waiting ask now


async def test_the_destination_keeps_reading_its_own_default(test_client, db_session, world):
    """Risk's only source isn't flagged primary. Orders is older, so unflagged it would become
    Risk's default and re-point Risk's views that have no source of their own."""
    db_session.add(WorkspaceDataSourceORM(
        id="ds_risk", workspace_id=B, provider_id=PROVIDER, graph_name="risk", label="Exposure",
        created_at="2024-06-01T00:00:00+00:00", updated_at="2024-06-01T00:00:00+00:00"))
    await db_session.commit()
    async with acting_as(db_session, "cy"):
        primary = (await _preview(test_client))["primary"]
        moved = (await _move(test_client)).json()
    assert (primary["becomesPrimary"], primary["pinsDestinationDefault"]) == (False, "Exposure")
    assert (await _fresh(db_session, WorkspaceDataSourceORM, "ds_risk")).is_primary
    assert not (await _fresh(db_session, WorkspaceDataSourceORM, DS)).is_primary
    assert not (await _fresh(db_session, WorkspaceDataSourceORM, DS2)).is_primary

    async with acting_as(db_session, "cy"):
        assert (await test_client.post(f"{TRANSFERS}/{moved['id']}/undo")).status_code == 200
    assert not (await _fresh(db_session, WorkspaceDataSourceORM, "ds_risk")).is_primary
    ds = await _fresh(db_session, WorkspaceDataSourceORM, DS)
    assert (ds.workspace_id, ds.is_primary) == (A, True)


async def test_the_source_keeps_its_entity_naming_where_the_destination_differs(
    test_client, db_session, world,
):
    """Risk identifies entities by ``id``; Orders inherited ``urn`` from Finance. Keeping it on
    the source keeps every rollup valid instead of forcing a rebuild."""
    await db_session.execute(update(WorkspaceORM).where(WorkspaceORM.id == B).values(identity_property="id"))
    await db_session.commit()
    async with acting_as(db_session, "cy"):
        assert (await _preview(test_client))["identity"] == {"identityProperty": "urn",
                                                             "nameProperty": None}
        moved = (await _move(test_client)).json()
    assert (await _fresh(db_session, WorkspaceDataSourceORM, DS)).identity_property == "urn"

    async with acting_as(db_session, "cy"):
        assert (await test_client.post(f"{TRANSFERS}/{moved['id']}/undo")).status_code == 200
    assert (await _fresh(db_session, WorkspaceDataSourceORM, DS)).identity_property is None


async def test_a_failed_move_puts_the_graph_back(test_client, db_session, world, monkeypatch):
    """The version store is written first and can't share the transaction: when the rest fails,
    the graph goes back to where the source still is."""
    world.facts = VERSIONED

    async def boom(*args, **kwargs):
        raise RuntimeError("disk full")

    monkeypatch.setattr(data_source_transfer, "_grant_kept", boom)
    async with acting_as(db_session, "cy"):
        assert (await _move(test_client, token=False)).status_code == 500

    assert world.relocations == [(DS, B, True), (DS, A, False)]
    assert (await _fresh(db_session, WorkspaceDataSourceORM, DS)).workspace_id == A
    assert {ws for ws, _ds, _at in (await _views(db_session)).values()} == {A}


async def test_a_clash_that_races_the_check_is_a_conflict(test_client, db_session, world, monkeypatch):
    world.facts = VERSIONED
    db_session.add(WorkspaceDataSourceORM(id="ds_copy", workspace_id=B, provider_id=PROVIDER,
                                          graph_name="orders", label="Orders copy"))
    await db_session.commit()

    async def never(*args, **kwargs):
        return False

    monkeypatch.setattr(data_source_transfer, "_connected_in", never)
    async with acting_as(db_session, "cy"):
        r = await _move(test_client, token=False)
    assert r.status_code == 409 and r.json()["detail"]["error"] == "already_connected"
    assert world.relocations == [(DS, B, True), (DS, A, False)]


# ── requests ─────────────────────────────────────────────────────────


async def test_an_admin_of_one_side_asks_and_the_other_side_answers(test_client, db_session, world):
    async with acting_as(db_session, "ada"):
        r = await _propose(test_client, keep=[])
    assert r.status_code == 201, r.text
    asked = r.json()
    assert (asked["status"], asked["kind"], asked["canCancel"], asked["canAccept"]) == (
        "pending", "request", True, False)
    assert asked["expiresAt"] and asked["reason"] == "Team reorganisation"
    assert {(PEOPLE["bea"], "data_source.transfer_requested"),
            (PEOPLE["cy"], "data_source.transfer_requested")} <= await _bell(db_session)
    assert (await _fresh(db_session, WorkspaceDataSourceORM, DS)).workspace_id == A

    async with acting_as(db_session, "ada"):
        again = await _propose(test_client)
    assert again.status_code == 409 and again.json()["detail"]["error"] == "request_waiting"

    async with acting_as(db_session, "bea"):
        incoming = (await test_client.get(TRANSFERS)).json()
        detail = (await test_client.get(f"{TRANSFERS}/{asked['id']}")).json()
        accepted = await test_client.post(f"{TRANSFERS}/{asked['id']}/accept",
                                          json={"previewToken": detail["preview"]["token"]})
    assert [t["id"] for t in incoming] == [asked["id"]] and incoming[0]["canAccept"]
    assert incoming[0]["fromWorkspace"]["name"] == "Finance"       # a party sees both names
    assert detail["changesSinceRequest"] == {"viewsAdded": 0, "viewsRemoved": 0, "newPeople": 0}
    assert not any(s["keep"] for s in detail["preview"]["access"]["loses"])
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["status"] == "completed"
    assert (await _fresh(db_session, WorkspaceDataSourceORM, DS)).workspace_id == B
    assert (PEOPLE["ada"], "data_source.transfer_accepted") in await _bell(db_session)
    assert not (await db_session.execute(select(ResourceGrantORM.id).where(
        ResourceGrantORM.subject_type == "group"))).first()          # she kept nobody's access


async def test_a_review_that_went_stale_is_refused(test_client, db_session, world):
    async with acting_as(db_session, "ada"):
        asked = (await _propose(test_client)).json()
    async with acting_as(db_session, "bea"):
        token = (await test_client.get(f"{TRANSFERS}/{asked['id']}")).json()["preview"]["token"]
    await add_view(db_session, "view_late", ws=A, ds=DS)

    async with acting_as(db_session, "bea"):
        stale = await test_client.post(f"{TRANSFERS}/{asked['id']}/accept", json={"previewToken": token})
        detail = (await test_client.get(f"{TRANSFERS}/{asked['id']}")).json()
        fresh = await test_client.post(f"{TRANSFERS}/{asked['id']}/accept",
                                       json={"previewToken": detail["preview"]["token"]})
    assert stale.status_code == 409 and stale.json()["detail"]["error"] == "preview_stale"
    assert detail["changesSinceRequest"]["viewsAdded"] == 1
    assert fresh.status_code == 200


async def test_declining_tells_the_proposer_why(test_client, db_session, world):
    async with acting_as(db_session, "ada"):
        asked = (await _propose(test_client)).json()
    async with acting_as(db_session, "bea"):
        r = await test_client.post(f"{TRANSFERS}/{asked['id']}/decline",
                                   json={"note": "Risk is being wound down"})
    assert r.status_code == 200
    assert (r.json()["status"], r.json()["resolutionNote"]) == ("declined", "Risk is being wound down")
    note = (await db_session.execute(select(NotificationORM).where(
        NotificationORM.kind == "data_source.transfer_declined"))).scalar_one()
    assert (note.user_id, note.body) == (PEOPLE["ada"], "Risk is being wound down")
    assert len(await _events(db_session, "workspace.data_source.transfer_declined")) == 2


async def test_the_proposer_can_cancel_and_the_destination_hears(test_client, db_session, world):
    async with acting_as(db_session, "ada"):
        asked = (await _propose(test_client)).json()
        r = await test_client.post(f"{TRANSFERS}/{asked['id']}/cancel", json={})
    assert r.status_code == 200 and r.json()["status"] == "cancelled"
    assert (PEOPLE["bea"], "data_source.transfer_cancelled") in await _bell(db_session)


async def test_only_the_destination_answers_and_only_parties_see_it(test_client, db_session, world):
    async with acting_as(db_session, "ada"):
        asked = (await _propose(test_client)).json()
        own = await test_client.post(f"{TRANSFERS}/{asked['id']}/accept", json={"previewToken": "x"})
    assert own.status_code == 403
    async with acting_as(db_session, "val"):
        assert (await test_client.get(f"{TRANSFERS}/{asked['id']}")).status_code == 404


async def test_an_unanswered_request_expires(test_client, db_session, world):
    async with acting_as(db_session, "ada"):
        asked = (await _propose(test_client)).json()
    await db_session.execute(update(DataSourceTransferORM).values(
        expires_at=(datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()))
    await db_session.commit()
    async with acting_as(db_session, "bea"):
        assert (await test_client.get(TRANSFERS)).json() == []
        everything = (await test_client.get(TRANSFERS, params={"status": "all"})).json()
        r = await test_client.post(f"{TRANSFERS}/{asked['id']}/accept", json={"previewToken": "x"})
    assert [t["status"] for t in everything] == ["expired"]
    assert r.status_code == 409 and r.json()["detail"]["error"] == "expired"
    async with acting_as(db_session, "ada"):
        assert (await _propose(test_client)).status_code == 201       # free to ask again


async def test_deleting_the_source_closes_its_request(test_client, db_session, world, monkeypatch):
    from backend.app.services.versioning import purge_worker

    async def tombstoned(**kwargs):
        return 0

    monkeypatch.setattr(purge_worker, "tombstone_graphs_for_data_source", tombstoned)
    async with acting_as(db_session, "ada"):
        asked = (await _propose(test_client)).json()
        assert (await test_client.delete(_src())).status_code == 204
    row = await _fresh(db_session, DataSourceTransferORM, asked["id"])
    assert (row.status, row.resolution_note) == ("cancelled", "The data source was deleted.")


async def test_a_direct_move_closes_a_waiting_request(test_client, db_session, world):
    async with acting_as(db_session, "ada"):
        asked = (await _propose(test_client)).json()
    async with acting_as(db_session, "olga"):
        assert (await _move(test_client, to=C)).status_code == 200
    row = await _fresh(db_session, DataSourceTransferORM, asked["id"])
    assert (row.status, row.resolution_note) == ("cancelled", "It was moved to Ops directly.")


# ── undo ─────────────────────────────────────────────────────────────


async def test_undo_puts_everything_back(test_client, db_session, world):
    world.facts = VERSIONED
    db_session.add_all([
        ViewActivityLogORM(view_id="view_team", workspace_id=A, action="created", actor=PEOPLE["max"]),
        AggregationDataSourceStateORM(data_source_id=DS, workspace_id=A),
    ])
    await db_session.commit()
    async with acting_as(db_session, "cy"):
        moved = (await _move(test_client, keep=[{"type": "group", "id": TEAM}])).json()
        r = await test_client.post(f"{TRANSFERS}/{moved['id']}/undo", headers=REASON)
    assert r.status_code == 200, r.text
    assert (r.json()["status"], r.json()["canUndo"]) == ("undone", False)

    ds = await _fresh(db_session, WorkspaceDataSourceORM, DS)
    assert (ds.workspace_id, ds.is_primary) == (A, True)
    after = await _views(db_session)
    assert {v: after[v][0] for v in after} == {v: A for v in after}
    assert after[LOOSE][1] is None                                  # back to following the default
    assert not (await db_session.execute(select(ResourceGrantORM.id).where(
        ResourceGrantORM.subject_type == "group"))).first()
    assert {ws for (ws,) in (await db_session.execute(
        select(ViewActivityLogORM.workspace_id))).all()} == {A}
    assert await db_session.scalar(select(AggregationDataSourceStateORM.workspace_id).where(
        AggregationDataSourceStateORM.data_source_id == DS)) == A
    assert world.relocations == [(DS, B, True), (DS, A, True)]
    assert len(await _events(db_session, "workspace.data_source.move_undone")) == 2


async def test_undo_is_refused_once_something_is_built_on_it(test_client, db_session, world):
    async with acting_as(db_session, "cy"):
        moved = (await _move(test_client)).json()
    await add_view(db_session, "view_built_in_risk", ws=B, ds=DS)
    async with acting_as(db_session, "cy"):
        history = (await test_client.get(f"{_src(ws=B)}/transfers")).json()
        r = await test_client.post(f"{TRANSFERS}/{moved['id']}/undo")
    assert (history[0]["canUndo"], history[0]["undoBlockedBy"]) == (
        False, "1 view was built on it since it moved, so it can't be undone. Move it back instead.")
    assert r.status_code == 409 and r.json()["detail"]["error"] == "undo_unavailable"


async def test_undo_lasts_a_week(test_client, db_session, world):
    async with acting_as(db_session, "cy"):
        moved = (await _move(test_client)).json()
    await db_session.execute(update(DataSourceTransferORM).values(
        completed_at=(datetime.now(timezone.utc) - timedelta(days=8)).isoformat()))
    await db_session.commit()
    async with acting_as(db_session, "cy"):
        r = await test_client.post(f"{TRANSFERS}/{moved['id']}/undo")
    assert r.status_code == 409


async def test_a_request_is_the_destinations_to_send_back(test_client, db_session, world):
    async with acting_as(db_session, "ada"):
        asked = (await _propose(test_client)).json()
    async with acting_as(db_session, "bea"):
        token = (await test_client.get(f"{TRANSFERS}/{asked['id']}")).json()["preview"]["token"]
        assert (await test_client.post(f"{TRANSFERS}/{asked['id']}/accept",
                                       json={"previewToken": token})).status_code == 200
    async with acting_as(db_session, "ada"):
        refused = await test_client.post(f"{TRANSFERS}/{asked['id']}/undo")
    assert refused.status_code == 403
    async with acting_as(db_session, "bea"):
        assert (await test_client.post(f"{TRANSFERS}/{asked['id']}/undo")).status_code == 200
    assert (await _fresh(db_session, WorkspaceDataSourceORM, DS)).workspace_id == A


# ── history ──────────────────────────────────────────────────────────


async def test_history_names_only_what_the_reader_may_see(test_client, db_session, world):
    async with acting_as(db_session, "cy"):
        moved = (await _move(test_client)).json()
        assert (await test_client.post(f"{TRANSFERS}/{moved['id']}/undo")).status_code == 200
        mine = (await test_client.get(f"{_src()}/transfers")).json()
    assert [(t["id"], t["status"], t["toWorkspace"]["name"]) for t in mine] == [
        (moved["id"], "undone", "Risk")]
    assert mine[0]["createdBy"]["name"] == "Cy T"

    async with acting_as(db_session, "val"):                       # can open Finance, not Risk
        theirs = (await test_client.get(f"{_src()}/transfers")).json()
    assert (theirs[0]["fromWorkspace"]["name"], theirs[0]["toWorkspace"]["name"]) == ("Finance", None)
