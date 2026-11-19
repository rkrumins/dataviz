"""``POST /views/{view_id}/duplicate`` — a proper copy of a view, made the way its kind is made.

An ordinary view is copied with its design and its saved queries; a view made from a query is
made again from the same definition, through ``/views/from-members``' own steps, its members
worked out afresh; a subset view is made again through ``/views/from-search`` with the same
search. The resolver's fake graph and fixtures are ``test_views_from_members_api.py``'s.
"""
import json

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import ViewMembershipStateORM, ViewORM, ViewVersionORM
from backend.app.services.permission_service import PermissionClaims
from backend.tests.test_view_transfer_import import _as, _user
from backend.tests.test_views_from_members_api import (  # noqa: F401 — fixtures
    URL as FROM_MEMBERS,
    body,
    flags,
    graph,
    members_of,
    membership_on,
    source_view,
    workspace,
)

LAYERS = [
    {"id": "l_tbl", "name": "Tables", "order": 0, "entityTypes": ["table"]},
    {"id": "l_col", "name": "Columns", "order": 1, "entityTypes": ["column"]},
]
PREDICATE = {"kind": "tag", "values": ["pii"]}


def duplicate(client: AsyncClient, view_id: str, **body):
    return client.post(f"/api/v1/views/{view_id}/duplicate", json=body or None)


async def config_of(client: AsyncClient, view_id: str) -> dict:
    resp = await client.get(f"/api/v1/views/{view_id}")
    assert resp.status_code == 200, resp.text
    return resp.json()["config"]


async def ordinary(client: AsyncClient, ws: str, **extra) -> str:
    resp = await client.post("/api/v1/views/", json={
        "name": "Sales overview", "workspaceId": ws, "viewType": "reference", "description": "What sells",
        "tags": ["sales"],
        "config": {"icon": "Layout", "content": {"entityScope": "curated", "visibleEntityTypes": ["table"]},
                   "layout": {"type": "reference", "referenceLayout": {
                       "layers": LAYERS,
                       "assignments": {"tbl_a": {"layerId": "l_tbl", "inheritsChildren": True}},
                       "displayRules": [{"id": "hot", "op": "color", "value": "#f00"}]}},
                   "entityOverrides": {"table": {"color": "#111"}}},
        **extra,
    })
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


async def list_view(client: AsyncClient, ws: str, src: str, **overrides) -> str:
    resp = await client.post(FROM_MEMBERS, json=body(ws, src, **overrides))
    assert resp.status_code == 201, resp.text
    return resp.json()["view"]["id"]


async def subset(client: AsyncClient, ws: str, base: str, **overrides) -> str:
    resp = await client.post("/api/v1/views/from-search", json={
        "name": "PII", "workspaceId": ws, "predicate": PREDICATE, "readIn": base, **overrides})
    assert resp.status_code == 201, resp.text
    return resp.json()["view"]["id"]


@pytest.fixture()
def subsets_on():
    flags(searchViewsEnabled=True)
    yield
    flags(searchViewsEnabled=False)


# ── An ordinary view ────────────────────────────────────────────────────────


async def test_an_ordinary_view_is_copied_with_its_design_and_its_saved_queries(test_client: AsyncClient):
    ws = await workspace(test_client)
    view_id = await ordinary(test_client, ws)
    saved = await test_client.put(f"/api/v1/views/{view_id}/library/queries/q-hot", json={
        "name": "Hot tables", "predicate": {"kind": "tag", "values": ["hot"]}})
    assert saved.status_code == 200, saved.text

    resp = await duplicate(test_client, view_id)
    assert resp.status_code == 201, resp.text
    out = resp.json()
    assert set(out) == {"view"}
    copy = out["view"]
    assert copy["id"] != view_id and copy["portableId"] != (await test_client.get(f"/api/v1/views/{view_id}")).json()[
        "portableId"], "a copy is a view of its own"
    assert (copy["name"], copy["visibility"], copy["workspaceId"]) == ("Copy of Sales overview", "private", ws)
    assert (copy["description"], copy["tags"]) == ("What sells", ["sales"])
    theirs, mine = await config_of(test_client, view_id), await config_of(test_client, copy["id"])
    assert mine["layout"]["referenceLayout"] == theirs["layout"]["referenceLayout"], (
        "its layers, what people placed in them, its display rules")
    assert (mine["entityOverrides"], mine["content"], mine["icon"]) == (
        theirs["entityOverrides"], theirs["content"], "Layout")
    library = (await test_client.get(f"/api/v1/views/{copy['id']}/library")).json()
    [query] = library["savedQueries"]
    assert (query["name"], query["predicate"]) == ("Hot tables", {"kind": "tag", "values": ["hot"]})
    assert query["id"] != "q-hot"
    assert len((await test_client.get(f"/api/v1/views/{view_id}/library")).json()["savedQueries"]) == 1


async def test_a_copy_is_called_and_shared_as_asked(test_client: AsyncClient):
    ws = await workspace(test_client)
    view_id = await ordinary(test_client, ws)
    resp = await duplicate(test_client, view_id, name="Mine", visibility="workspace")
    assert resp.status_code == 201, resp.text
    assert (resp.json()["view"]["name"], resp.json()["view"]["visibility"]) == ("Mine", "workspace")
    for bad in ({"visibility": "enterprise"}, {"name": ""}, {"name": "x" * 121}, {"color": "red"}):
        assert (await duplicate(test_client, view_id, **bad)).status_code == 422, bad


# ── A view made from a query ────────────────────────────────────────────────


async def test_a_list_view_is_made_again_from_its_definition_and_worked_out_afresh(
    test_client: AsyncClient, db_session: AsyncSession, graph, membership_on,
):
    ws = await workspace(test_client)
    src = await source_view(test_client, ws)
    view_id = await list_view(test_client, ws, src)
    tables = next(l["id"] for l in (await config_of(test_client, view_id))["layout"]["referenceLayout"]["layers"]
                  if l["name"] == "Tables")
    included = await test_client.post(f"/api/v1/views/{view_id}/membership/members",
                                      json={"include": [{"urn": "col_a2", "layerId": tables}]})
    assert included.status_code == 200, included.text

    resp = await duplicate(test_client, view_id)
    assert resp.status_code == 201, resp.text
    out = resp.json()
    copy_id = out["view"]["id"]
    assert set(out) == {"view", "membership"} and out["view"]["name"] == "Copy of Orders tables"
    assert out["membership"]["status"] in ("ok", "updating")
    theirs, mine = await config_of(test_client, view_id), await config_of(test_client, copy_id)
    assert mine["layout"]["referenceLayout"]["layers"] == theirs["layout"]["referenceLayout"]["layers"], (
        "its layers as they are, not chosen again")
    assert mine["layout"]["referenceLayout"]["assignments"]["col_a2"]["layerId"] == tables, "an entry people placed"
    for key in ("mode", "sources", "layout", "exclude"):
        assert mine["membership"][key] == theirs["membership"][key], key
    state = (await db_session.execute(select(ViewMembershipStateORM).where(
        ViewMembershipStateORM.view_id == copy_id))).scalar_one()
    assert state.members_epoch is not None, "worked out on its first turn"
    assert await members_of(db_session, copy_id) == await members_of(db_session, view_id)
    version = (await db_session.execute(select(ViewVersionORM).where(ViewVersionORM.view_id == copy_id))).scalar_one()
    assert (version.source, json.loads(version.provenance)["copyOf"]) == ("create", view_id)


async def test_a_snapshot_is_copied_as_a_snapshot_with_members_of_its_own(
    test_client: AsyncClient, db_session: AsyncSession, graph, membership_on,
):
    ws = await workspace(test_client)
    view_id = await list_view(test_client, ws, await source_view(test_client, ws), mode="snapshot")
    resp = await duplicate(test_client, view_id, name="Frozen too")
    assert resp.status_code == 201, resp.text
    membership = resp.json()["membership"]
    assert (membership["mode"], membership["status"]) == ("snapshot", "frozen")
    assert len(await members_of(db_session, resp.json()["view"]["id"])) == 6


async def test_a_list_view_is_copied_only_where_the_views_it_names_are(
    test_client: AsyncClient, graph, membership_on,
):
    ws, elsewhere = await workspace(test_client), await workspace(test_client, "Elsewhere")
    view_id = await list_view(test_client, ws, await source_view(test_client, ws))
    resp = await duplicate(test_client, view_id, workspaceId=elsewhere)
    assert resp.status_code == 422 and resp.json()["detail"]["reason"] == "view_other_workspace"
    flags(viewMembershipEnabled=False)
    resp = await duplicate(test_client, view_id)
    assert resp.status_code == 403 and resp.json()["detail"]["feature"] == "viewMembershipEnabled"


# ── A subset view ───────────────────────────────────────────────────────────


async def test_a_subset_view_is_made_again_with_its_search(
    test_client: AsyncClient, db_session: AsyncSession, subsets_on,
):
    ws = await workspace(test_client)
    base = await ordinary(test_client, ws)
    follows = await subset(test_client, ws, base, include={"contents": True})
    own = await subset(test_client, ws, base, layout="own", rest="Everything else",
                       layers=[{"name": "Columns", "entityTypes": ["column"], "color": "#0f0"}])

    for view_id in (follows, own):
        resp = await duplicate(test_client, view_id)
        assert resp.status_code == 201, resp.text
        out = resp.json()
        assert set(out) == {"view", "search"}
        theirs, mine = await config_of(test_client, view_id), await config_of(test_client, out["view"]["id"])
        for key in ("predicate", "within", "readIn", "layout", "include", "hiddenLayers"):
            assert mine["search"].get(key) == theirs["search"].get(key), key
        row = (await db_session.execute(select(ViewORM).where(ViewORM.id == out["view"]["id"]))).scalar_one()
        assert row.subset_of == base, "listed among its base's subsets"
    layers = [(l["name"], l.get("entityTypes"), l.get("color"))
              for l in mine["layout"]["referenceLayout"]["layers"]]
    assert layers == [("Columns", ["column"], "#0f0"), ("Everything else", [], None)]


# ── Asked again ─────────────────────────────────────────────────────────────


async def test_the_same_key_carries_one_copy_on_and_no_key_makes_a_new_one(
    test_client: AsyncClient, db_session: AsyncSession, graph, membership_on, subsets_on,
):
    """A copy of a large list view is worked out a step at a time (202: send it again): the
    same ``Idempotency-Key`` carries that one copy on — and a copy sent again after no answer
    is the one already made, never a second."""
    ws = await workspace(test_client)
    src = await source_view(test_client, ws)
    listed = await list_view(test_client, ws, src)
    subset_id = await subset(test_client, ws, await ordinary(test_client, ws))

    async def copies() -> int:
        return len((await db_session.execute(select(ViewORM.id).where(ViewORM.name.like("Copy of %")))).all())

    for view_id in (listed, subset_id):
        before = await copies()
        key = {"Idempotency-Key": f"dup-{view_id}"}
        first = await test_client.post(f"/api/v1/views/{view_id}/duplicate", headers=key)
        assert first.status_code == 201, first.text
        again = await test_client.post(f"/api/v1/views/{view_id}/duplicate", headers=key)
        assert again.status_code in (200, 201), again.text
        assert again.json()["view"]["id"] == first.json()["view"]["id"], "the copy already made"
        assert await copies() == before + 1
        fresh = await duplicate(test_client, view_id)
        assert fresh.status_code == 201 and fresh.json()["view"]["id"] != first.json()["view"]["id"]
        assert await copies() == before + 2


# ── Who may ─────────────────────────────────────────────────────────────────


async def test_duplicating_needs_to_read_the_view_and_to_make_one_where_the_copy_goes(test_client: AsyncClient):
    ws, elsewhere = await workspace(test_client), await workspace(test_client, "Elsewhere")
    private = await ordinary(test_client, ws)
    shared = await ordinary(test_client, ws, visibility="workspace")
    resp = await duplicate(test_client, "view_nothere")
    assert resp.status_code == 404 and resp.json()["detail"]["reason"] == "view_not_found"

    reader = PermissionClaims(sid="s_reader", ws_perms={ws: ("workspace:view:read",)})
    with _as(_user("usr_reader"), reader):
        resp = await duplicate(test_client, private)
        assert resp.status_code == 404 and resp.json()["detail"]["reason"] == "view_not_found", (
            "a view they can't read is one they can't know of")
        assert (await duplicate(test_client, shared)).status_code == 403, "they can't make a view here"
    maker = PermissionClaims(sid="s_maker", ws_perms={ws: ("workspace:view:read", "workspace:view:create")})
    with _as(_user("usr_maker"), maker):
        assert (await duplicate(test_client, shared)).status_code == 201
        assert (await duplicate(test_client, shared, workspaceId=elsewhere)).status_code == 403
