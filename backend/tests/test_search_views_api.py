"""``POST /views/from-search``, ``/views/{id}/search`` and ``/views/{id}/subsets``.

A subset view stores its search and its base, never its matches: it is made at
once, follows its base's layers live (served with them, never storing them),
refuses what it can't show, and changes its search against the hash it was read at.
"""
import json
import time

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from backend.app.api.v1.endpoints import search_views as routes
from backend.app.db.models import ViewActivityLogORM, ViewORM, ViewVersionORM
from backend.app.services import view_access
from backend.app.services.feature_flags import feature_flags
from backend.common.models.search_view import REST_LAYER_ID

URL = "/api/v1/views/from-search"
P = {"kind": "tag", "values": ["pii"]}
LAYERS = [
    {"id": "t", "name": "Tables", "order": 0, "color": "#123456", "entityTypes": ["table"]},
    {"id": "d", "name": "Dashboards", "order": 1, "entityTypes": ["dashboard"]},
]


def flags(**values):
    feature_flags._cache = {**(feature_flags._cache or {}), **values}
    feature_flags._cache_ts = time.monotonic()


@pytest.fixture()
def on():
    flags(searchViewsEnabled=True)
    yield
    flags(searchViewsEnabled=False)


async def workspace(client: AsyncClient, name: str = "Subset WS") -> str:
    resp = await client.post("/api/v1/admin/workspaces", json={"name": name, "dataSources": []})
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


async def base_view(client: AsyncClient, ws: str, layers=LAYERS, **content) -> str:
    resp = await client.post("/api/v1/views/", json={
        "name": "Sales overview", "workspaceId": ws, "viewType": "reference", "visibility": "workspace",
        "config": {"layout": {"type": "reference", "referenceLayout": {"layers": layers, "assignments": {}}},
                   "content": {"entityScope": "all", **content}},
    })
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


def body(ws: str, base: str, **over) -> dict:
    return {"name": "PII in sales", "workspaceId": ws, "predicate": P, "readIn": base,
            "provenance": {"origin": "search", "viewId": base}, **over}


async def make(client, ws, base, **over):
    resp = await client.post(URL, json=body(ws, base, **over))
    assert resp.status_code == 201, resp.text
    return resp.json()


class TestCreate:
    async def test_the_preview_off_refuses(self, test_client):
        flags(searchViewsEnabled=False)
        ws = await workspace(test_client)
        resp = await test_client.post(URL, json=body(ws, "x"))
        assert resp.status_code == 403 and resp.json()["detail"]["feature"] == "searchViewsEnabled"

    async def test_a_subset_stores_its_search_and_is_served_its_bases_layers(self, test_client, on, db_session):
        ws = await workspace(test_client)
        base = await base_view(test_client, ws)
        made = await make(test_client, ws, base)
        view, search = made["view"], made["search"]
        served = view["config"]["layout"]["referenceLayout"]["layers"]
        assert [l["id"] for l in served] == ["t", "d", REST_LAYER_ID]
        assert served[0]["color"] == "#123456" and served[-1]["showUnassigned"] is True
        assert view["config"]["search"]["readIn"] == base
        assert search["base"] == {"viewId": base, "name": "Sales overview", "available": True}
        assert [l["id"] for l in search["layers"]] == ["t", "d", REST_LAYER_ID]
        assert search["status"] == "ok" and not search["placedByType"]

        row = (await db_session.execute(select(ViewORM).where(ViewORM.id == view["id"]))).scalar_one()
        stored = json.loads(row.config)
        assert stored["layout"]["referenceLayout"]["layers"] == []          # never stored
        assert stored["content"]["entityScope"] == "all" and row.subset_of == base
        version = (await db_session.execute(
            select(ViewVersionORM).where(ViewVersionORM.view_id == row.id))).scalar_one()
        assert version.source == "create"
        actions = (await db_session.execute(select(ViewActivityLogORM.action).where(
            ViewActivityLogORM.view_id == row.id))).scalars().all()
        assert "created" in actions

    async def test_its_layers_follow_the_base_as_it_changes(self, test_client, on, db_session):
        ws = await workspace(test_client)
        base = await base_view(test_client, ws)
        made = await make(test_client, ws, base)
        row = (await db_session.execute(select(ViewORM).where(ViewORM.id == base))).scalar_one()
        config = json.loads(row.config)
        config["layout"]["referenceLayout"]["layers"].append(
            {"id": "c", "name": "Charts", "order": 2, "entityTypes": ["chart"]})
        row.config = json.dumps(config)
        await db_session.commit()
        served = (await test_client.get(f"/api/v1/views/{made['view']['id']}")).json()
        assert [l["id"] for l in served["config"]["layout"]["referenceLayout"]["layers"]] == [
            "t", "d", "c", REST_LAYER_ID]
        listed = (await test_client.get(f"/api/v1/views/?workspaceId={ws}")).json()
        items = listed["items"] if isinstance(listed, dict) else listed
        mine = next(v for v in items if v["id"] == made["view"]["id"])
        assert len(mine["config"]["layout"]["referenceLayout"]["layers"]) == 4

    async def test_a_retry_with_its_key_answers_with_the_first_view(self, test_client, on):
        ws = await workspace(test_client)
        base = await base_view(test_client, ws)
        headers = {"Idempotency-Key": "k1"}
        one = await test_client.post(URL, json=body(ws, base), headers=headers)
        two = await test_client.post(URL, json=body(ws, base), headers=headers)
        assert (one.status_code, two.status_code) == (201, 200)
        assert one.json()["view"]["id"] == two.json()["view"]["id"]

    async def test_an_own_layout_is_type_layers_and_the_rest(self, test_client, on):
        ws = await workspace(test_client)
        base = await base_view(test_client, ws)
        made = await make(test_client, ws, base, layout="own", rest="Everything else", layers=[
            {"name": "Tables", "entityTypes": ["table", "table"]}, {"name": "Charts", "entityTypes": ["chart"]}])
        layers = made["view"]["config"]["layout"]["referenceLayout"]["layers"]
        assert [(l["id"], l["name"], l["entityTypes"]) for l in layers] == [
            ("layer-1", "Tables", ["table"]), ("layer-2", "Charts", ["chart"]),
            (REST_LAYER_ID, "Everything else", [])]
        assert layers[-1]["showUnassigned"] is True

    async def test_a_whole_data_source_subset_has_no_base(self, test_client, on):
        ws = await workspace(test_client)
        made = await make(test_client, ws, None, within="dataSource", layout="own", readIn=None,
                          layers=[{"name": "Tables", "entityTypes": ["table"]}])
        assert made["search"]["base"] is None and made["view"]["config"]["search"]["within"] == "dataSource"

    @pytest.mark.parametrize("over, code, words", [
        ({"predicate": {"kind": "layer", "layerAssignment": "Tables"}}, 422, "filter by layer"),
        ({"predicate": {"kind": "edges", "sourceWhere": P}}, 422, "edges"),
        ({"readIn": "nope"}, 404, "not found"),
        ({"layout": "own", "layers": [{"name": f"L{i}", "entityTypes": [f"t{i}"]} for i in range(13)]},
         422, ""),
    ])
    async def test_refusals(self, test_client, on, over, code, words):
        ws = await workspace(test_client)
        base = await base_view(test_client, ws)
        resp = await test_client.post(URL, json=body(ws, base, **over))
        assert resp.status_code == code, resp.text
        assert words in json.dumps(resp.json())

    async def test_a_subset_of_a_subset_is_its_bases(self, test_client, on):
        ws = await workspace(test_client)
        base = await base_view(test_client, ws)
        sub = (await make(test_client, ws, base))["view"]["id"]
        resp = await test_client.post(URL, json=body(ws, sub))
        assert resp.status_code == 422 and "subset view already" in resp.text

    async def test_a_base_in_another_workspace(self, test_client, on):
        ws, other = await workspace(test_client), await workspace(test_client, "Other WS")
        base = await base_view(test_client, other)
        resp = await test_client.post(URL, json=body(ws, base))
        assert resp.status_code == 422 and "another workspace" in resp.text

    async def test_a_word_alone_with_nothing_to_bound_it(self, test_client, on):
        ws = await workspace(test_client)
        bare = await base_view(test_client, ws, layers=[{"id": "x", "name": "All", "showUnassigned": True}])
        word = {"kind": "text", "value": "orders", "target": "any"}
        resp = await test_client.post(URL, json=body(ws, bare, predicate=word))
        assert resp.status_code == 422 and "every entity" in resp.text
        typed = await base_view(test_client, ws)
        made = await test_client.post(URL, json=body(ws, typed, predicate=word))
        assert made.status_code == 201

    async def test_writing_a_search_needs_data_source_read(self, test_client, on, monkeypatch):
        ws = await workspace(test_client)
        base = await base_view(test_client, ws)
        monkeypatch.setattr(routes, "has_permission", lambda *a, **k: False)
        resp = await test_client.post(URL, json=body(ws, base))
        assert resp.status_code == 403
        assert resp.json()["detail"]["permission"] == "workspace:datasource:read"


class TestReadAndEdit:
    async def test_status_has_an_etag(self, test_client, on):
        ws = await workspace(test_client)
        sub = (await make(test_client, ws, await base_view(test_client, ws)))["view"]["id"]
        first = await test_client.get(f"/api/v1/views/{sub}/search")
        assert first.status_code == 200 and first.headers["ETag"]
        again = await test_client.get(f"/api/v1/views/{sub}/search",
                                      headers={"If-None-Match": first.headers["ETag"]})
        assert again.status_code == 304

    async def test_the_bases_name_only_to_who_can_open_it(self, test_client, on, monkeypatch):
        ws = await workspace(test_client)
        base = await base_view(test_client, ws)
        sub = (await make(test_client, ws, base))["view"]["id"]
        monkeypatch.setenv("RBAC_ENFORCE_VIEWS", "1")
        real = view_access.can_read_view

        async def not_the_base(session, ctx, view):
            return view.id != base and await real(session, ctx, view)

        monkeypatch.setattr(view_access, "can_read_view", not_the_base)
        status = (await test_client.get(f"/api/v1/views/{sub}/search")).json()
        assert status["base"] == {"viewId": base, "name": None, "available": True}
        assert len(status["layers"]) == 3

    async def test_a_deleted_base_leaves_it_waiting(self, test_client, on, db_session):
        ws = await workspace(test_client)
        base = await base_view(test_client, ws)
        sub = (await make(test_client, ws, base))["view"]["id"]
        deleted = await test_client.delete(f"/api/v1/views/{base}")
        assert deleted.status_code in (200, 204)
        status = (await test_client.get(f"/api/v1/views/{sub}/search")).json()
        assert status["status"] == "base_missing" and status["layers"] == []
        assert status["base"]["available"] is False
        served = (await test_client.get(f"/api/v1/views/{sub}")).json()
        assert served["config"]["layout"]["referenceLayout"]["layers"] == []

    async def test_an_edit_against_a_stale_hash_is_a_conflict(self, test_client, on):
        ws = await workspace(test_client)
        sub = (await make(test_client, ws, await base_view(test_client, ws)))["view"]["id"]
        resp = await test_client.put(f"/api/v1/views/{sub}/search",
                                     json={"ifDefinitionHash": "stale", "predicate": P})
        assert resp.status_code == 409 and resp.json()["detail"]["definitionHash"]

    async def test_a_draft_can_not_change_it(self, test_client, on):
        ws = await workspace(test_client)
        made = await make(test_client, ws, await base_view(test_client, ws))
        resp = await test_client.put(f"/api/v1/views/{made['view']['id']}/search?branchId=b1",
                                     json={"ifDefinitionHash": made["search"]["definitionHash"]})
        assert resp.status_code == 409

    async def test_changing_its_search_records_a_version(self, test_client, on, db_session):
        ws = await workspace(test_client)
        made = await make(test_client, ws, await base_view(test_client, ws))
        sub = made["view"]["id"]
        new = {"kind": "tag", "values": ["gdpr"]}
        resp = await test_client.put(f"/api/v1/views/{sub}/search", json={
            "ifDefinitionHash": made["search"]["definitionHash"], "predicate": new})
        assert resp.status_code == 200, resp.text
        assert resp.json()["definition"]["predicate"]["values"] == ["gdpr"]
        assert resp.json()["definitionHash"] != made["search"]["definitionHash"]
        sources = (await db_session.execute(select(ViewVersionORM.source).where(
            ViewVersionORM.view_id == sub).order_by(ViewVersionORM.version))).scalars().all()
        assert sources == ["create", "wizard"]

    async def test_its_own_layout_then_following_again(self, test_client, on, db_session):
        ws = await workspace(test_client)
        made = await make(test_client, ws, await base_view(test_client, ws))
        sub = made["view"]["id"]
        own = (await test_client.put(f"/api/v1/views/{sub}/search", json={
            "ifDefinitionHash": made["search"]["definitionHash"], "layout": "own"})).json()
        assert own["definition"]["layout"] == "own"
        row = (await db_session.execute(select(ViewORM).where(ViewORM.id == sub))).scalar_one()
        await db_session.refresh(row)
        stored = json.loads(row.config)["layout"]["referenceLayout"]["layers"]
        assert [l["id"] for l in stored] == ["t", "d", REST_LAYER_ID]
        back = (await test_client.put(f"/api/v1/views/{sub}/search", json={
            "ifDefinitionHash": own["definitionHash"], "layout": "inherit"})).json()
        assert back["definition"]["layout"] == "inherit"
        await db_session.refresh(row)
        assert json.loads(row.config)["layout"]["referenceLayout"]["layers"] == []

    async def test_no_layers_to_copy_without_its_base(self, test_client, on):
        ws = await workspace(test_client)
        base = await base_view(test_client, ws)
        made = await make(test_client, ws, base)
        await test_client.delete(f"/api/v1/views/{base}")
        resp = await test_client.put(f"/api/v1/views/{made['view']['id']}/search", json={
            "ifDefinitionHash": made["search"]["definitionHash"], "layout": "own"})
        assert resp.status_code == 409 and resp.json()["detail"]["reason"] == "base_missing"


class TestSubsets:
    async def test_a_base_lists_its_subsets(self, test_client, on):
        ws = await workspace(test_client)
        base = await base_view(test_client, ws)
        one = (await make(test_client, ws, base))["view"]["id"]
        two = (await make(test_client, ws, base, name="Another"))["view"]["id"]
        listed = (await test_client.get(f"/api/v1/views/{base}/subsets")).json()
        assert listed["count"] == 2 and {i["viewId"] for i in listed["items"]} == {one, two}
        assert (await test_client.get(f"/api/v1/views/{one}/subsets")).json()["count"] == 0
