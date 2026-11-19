"""A list view or a subset view stays a Context View of what it holds, whatever a write asks.

A list view (made from a query: ``config.membership``) shows its members alone, a subset view
(``config.search``) its search's matches. As a Graph or Hierarchy view, or with a scope that
shows entities they don't hold, either would load what its members or matches were chosen
from — the whole data source. So a settings save that changes its view type or its layout's
type, and a layout save that asks for another ``entityScope``, are refused (422
``list_view_context_only``); a save that leaves them out, or asks for what the view already
is, goes through. Every other view changes kind as before.
"""
import json
import time

import pytest
from sqlalchemy import select

from backend.app.db.models import ViewORM
from backend.app.db.repositories.view_repo import CONTEXT_VIEW_ONLY, context_only_problem
from backend.app.services.feature_flags import feature_flags

LAYERS = [{"id": "t", "name": "Tables", "order": 0, "entityTypes": ["table"]}]
MEMBERSHIP = {"v": 1, "mode": "live", "sources": [{"spec": {"seeds": {"urns": ["urn:seed"]}}}]}


def flags(**values):
    feature_flags._cache = {**(feature_flags._cache or {}), **values}
    feature_flags._cache_ts = time.monotonic()


@pytest.fixture()
def on():
    flags(searchViewsEnabled=True)
    yield
    flags(searchViewsEnabled=False)


async def _ws(client):
    return (await client.post("/api/v1/admin/workspaces", json={"name": "W", "dataSources": []})).json()["id"]


async def _view(client, ws, scope="all"):
    resp = await client.post("/api/v1/views/", json={
        "name": "Base", "workspaceId": ws, "viewType": "reference",
        "config": {"layout": {"type": "reference", "referenceLayout": {"layers": LAYERS, "assignments": {}}},
                   "content": {"entityScope": scope}}})
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


async def _list_view(client, session, ws):
    """A view as ``POST /views/from-members`` leaves one: its definition is the server's alone to
    write, so it is set on the stored row (as test_live_views_writes.py does)."""
    view_id = await _view(client, ws, scope="curated")
    row = (await session.execute(select(ViewORM).where(ViewORM.id == view_id))).scalar_one()
    config = json.loads(row.config)
    config["membership"] = MEMBERSHIP
    row.config = json.dumps(config)
    await session.commit()
    return view_id


async def _subset(client, ws):
    resp = await client.post("/api/v1/views/from-search", json={
        "name": "PII", "workspaceId": ws, "predicate": {"kind": "tag", "values": ["pii"]},
        "readIn": await _view(client, ws)})
    assert resp.status_code == 201, resp.text
    return resp.json()["view"]["id"]


def _refused(resp):
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"] == {"reason": "list_view_context_only", "message": CONTEXT_VIEW_ONLY}


async def _stored(session, view_id):
    row = (await session.execute(select(ViewORM).where(ViewORM.id == view_id)
                                 .execution_options(populate_existing=True))).scalar_one()
    return row.view_type, json.loads(row.config)


@pytest.fixture(params=["list", "subset"])
async def held(request, test_client, db_session, on):
    """A list view and a subset view (following its base: it stores no layers), each with the
    scope it holds, the other one, and the layers its layout stores."""
    ws = await _ws(test_client)
    if request.param == "list":
        return await _list_view(test_client, db_session, ws), "curated", "all", LAYERS
    return await _subset(test_client, ws), "all", "curated", []


@pytest.mark.parametrize("change", [
    {"viewType": "graph"},
    {"viewType": "hierarchy"},
    {"config": {"layout": {"type": "graph"}, "content": {}}},
    {"viewType": "hierarchy", "config": {"layout": {"type": "hierarchy"}, "content": {}}},
])
async def test_a_settings_save_cannot_change_its_kind(test_client, db_session, held, change):
    view_id, *_rest = held
    _refused(await test_client.put(f"/api/v1/views/{view_id}", json={"name": "Renamed", **change}))
    view_type, config = await _stored(db_session, view_id)
    assert view_type == "reference" and config["layout"]["type"] == "reference"
    assert (await test_client.get(f"/api/v1/views/{view_id}")).json()["name"] != "Renamed"


async def test_a_settings_save_that_keeps_its_kind_goes_through(test_client, db_session, held):
    view_id, *_rest = held
    resp = await test_client.put(f"/api/v1/views/{view_id}", json={
        "name": "Renamed", "viewType": "reference",
        "config": {"layout": {"type": "reference"}, "content": {}}})
    assert resp.status_code == 200, resp.text
    resp = await test_client.put(f"/api/v1/views/{view_id}", json={"description": "Just words"})
    assert resp.status_code == 200, resp.text


async def test_a_layout_save_cannot_change_what_it_shows(test_client, db_session, held):
    view_id, scope, other, layers = held
    stored = {"layers": layers, "assignments": {}}
    _refused(await test_client.put(f"/api/v1/views/{view_id}/layout",
                                   json={"referenceLayout": stored, "entityScope": other}))
    _view_type, config = await _stored(db_session, view_id)
    assert config["content"]["entityScope"] == scope
    for same in ({"entityScope": scope}, {}):
        resp = await test_client.put(f"/api/v1/views/{view_id}/layout", json={"referenceLayout": stored, **same})
        assert resp.status_code == 200, resp.text


async def test_any_other_view_changes_kind_as_before(test_client, db_session):
    view_id = await _view(test_client, await _ws(test_client))
    resp = await test_client.put(f"/api/v1/views/{view_id}/layout", json={
        "referenceLayout": {"layers": LAYERS, "assignments": {}}, "entityScope": "curated"})
    assert resp.status_code == 200, resp.text
    resp = await test_client.put(f"/api/v1/views/{view_id}", json={
        "viewType": "graph", "config": {"layout": {"type": "graph"}, "content": {}}})
    assert resp.status_code == 200, resp.text
    assert (await _stored(db_session, view_id))[0] == "graph"


def test_what_the_guard_asks_of_each_kind():
    listed, subset = {"membership": MEMBERSHIP}, {"search": {"v": 1}}
    assert context_only_problem({}, view_type="graph", entity_scope="all") is None
    assert context_only_problem({"membership": None}, view_type="graph") is None
    for config, scope, other in ((listed, "curated", "all"), (subset, "all", "curated")):
        assert context_only_problem(config) is None
        assert context_only_problem(config, view_type="reference", layout_type="reference",
                                    entity_scope=scope) is None
        assert context_only_problem(config, view_type="graph") == CONTEXT_VIEW_ONLY
        assert context_only_problem(config, layout_type="hierarchy") == CONTEXT_VIEW_ONLY
        assert context_only_problem(config, entity_scope=other) == CONTEXT_VIEW_ONLY
