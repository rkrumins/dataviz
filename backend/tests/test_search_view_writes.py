"""Every way a view is written keeps a subset view a subset view: its search is the
server's alone to write, its layouts hold matches by type, a version restores its
search, a file can't smuggle one in, and a data export of one is refused (it places
nothing, so it would be the whole data source)."""
import json
import time

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from backend.app.db.models import ViewORM
from backend.app.db.repositories import view_repo
from backend.app.services.feature_flags import feature_flags
from backend.app.services.view_transfer import importing, references
from backend.common.models.management import ViewLayoutUpdateRequest
from backend.common.models.search_view import REST_LAYER_ID

P = {"kind": "tag", "values": ["pii"]}
LAYERS = [{"id": "t", "name": "Tables", "order": 0, "entityTypes": ["table"]}]


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


async def _base(client, ws):
    resp = await client.post("/api/v1/views/", json={
        "name": "Base", "workspaceId": ws, "viewType": "reference",
        "config": {"layout": {"type": "reference", "referenceLayout": {"layers": LAYERS, "assignments": {}}},
                   "content": {"entityScope": "all"}}})
    return resp.json()["id"]


async def _subset(client, ws, base, **over):
    resp = await client.post("/api/v1/views/from-search", json={
        "name": "PII", "workspaceId": ws, "predicate": P, "readIn": base, **over})
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _stored(db_session, view_id):
    row = (await db_session.execute(select(ViewORM).where(ViewORM.id == view_id))).scalar_one()
    await db_session.refresh(row)
    return row, json.loads(row.config)


class TestTheSearchIsTheServers:
    async def test_a_plain_create_drops_a_search_and_a_membership_sent_with_it(self, test_client, db_session):
        ws = await _ws(test_client)
        resp = await test_client.post("/api/v1/views/", json={
            "name": "Sneaky", "workspaceId": ws, "viewType": "reference",
            "config": {"search": {"v": 1, "predicate": P, "within": "dataSource", "layout": "own"},
                       "membership": {"v": 1, "sources": []}, "content": {"entityScope": "all"}}})
        assert resp.status_code == 201
        _row, config = await _stored(db_session, resp.json()["id"])
        assert "search" not in config and "membership" not in config

    async def test_a_settings_save_keeps_the_search(self, test_client, on, db_session):
        ws = await _ws(test_client)
        sub = (await _subset(test_client, ws, await _base(test_client, ws)))["view"]
        resp = await test_client.put(f"/api/v1/views/{sub['id']}", json={
            "name": "Renamed", "config": {"content": {"entityScope": "all"}, "search": {"v": 1, "predicate": {
                "kind": "tag", "values": ["changed"]}, "within": "dataSource", "layout": "own"}}})
        assert resp.status_code == 200, resp.text
        _row, config = await _stored(db_session, sub["id"])
        assert config["search"]["predicate"]["values"] == ["pii"]
        assert config["search"]["within"] == "view"


class TestLayouts:
    async def test_a_followed_layout_takes_no_layers(self, test_client, on, db_session):
        ws = await _ws(test_client)
        sub = (await _subset(test_client, ws, await _base(test_client, ws)))["view"]
        resp = await test_client.put(f"/api/v1/views/{sub['id']}/layout", json={
            "referenceLayout": {"layers": LAYERS, "assignments": {}}})
        assert resp.status_code == 422 and "base view" in resp.text
        ok = await test_client.put(f"/api/v1/views/{sub['id']}/layout", json={
            "referenceLayout": {"layers": [], "assignments": {}}, "entityScope": "curated"})
        assert ok.status_code == 200, ok.text
        _row, config = await _stored(db_session, sub["id"])
        assert config["content"]["entityScope"] == "all"

    @pytest.mark.parametrize("layout, words", [
        ({"layers": [{"id": "a", "name": "A", "rules": [{"tags": ["x"]}]}], "assignments": {}}, "rule"),
        ({"layers": [{"id": "a", "name": "A", "entityTypes": ["t"]}],
          "assignments": {"urn:1": {"layerId": "a"}}}, "by hand"),
        ({"layers": [{"id": "a", "name": "A", "anchorUrn": "urn:x"}], "assignments": {}}, "anchored"),
    ])
    async def test_an_own_layout_holds_type_layers_alone(self, test_client, on, layout, words):
        ws = await _ws(test_client)
        sub = (await _subset(test_client, ws, await _base(test_client, ws), layout="own",
                             layers=[{"name": "Tables", "entityTypes": ["table"]}]))["view"]
        resp = await test_client.put(f"/api/v1/views/{sub['id']}/layout", json={"referenceLayout": layout})
        assert resp.status_code == 422 and words in resp.text

    async def test_an_own_layout_takes_new_type_layers(self, test_client, on, db_session):
        ws = await _ws(test_client)
        sub = (await _subset(test_client, ws, await _base(test_client, ws), layout="own",
                             layers=[{"name": "Tables", "entityTypes": ["table"]}]))["view"]
        layers = [{"id": "a", "name": "Charts", "entityTypes": ["chart"]},
                  {"id": REST_LAYER_ID, "name": "Other", "showUnassigned": True}]
        resp = await test_client.put(f"/api/v1/views/{sub['id']}/layout", json={
            "referenceLayout": {"layers": layers, "assignments": {}}, "entityScope": "curated"})
        assert resp.status_code == 200, resp.text
        _row, config = await _stored(db_session, sub["id"])
        assert [l["id"] for l in config["layout"]["referenceLayout"]["layers"]] == ["a", REST_LAYER_ID]
        assert config["content"]["entityScope"] == "all"

    async def test_a_drafts_layout_is_held_to_the_same(self, test_client, on, db_session):
        ws = await _ws(test_client)
        sub = (await _subset(test_client, ws, await _base(test_client, ws)))["view"]
        with pytest.raises(ValueError, match="base view"):
            await view_repo.update_overlay_layout(db_session, sub["id"], "br1", ViewLayoutUpdateRequest(
                referenceLayout={"layers": LAYERS, "assignments": {}}))
        await view_repo.update_overlay_layout(db_session, sub["id"], "br1", ViewLayoutUpdateRequest(
            referenceLayout={"layers": [], "assignments": {}}, entityScope="curated"))
        overlay = await view_repo.get_overlay(db_session, sub["id"], "br1")
        assert overlay.entity_scope == "all"


class TestVersionsAndFiles:
    async def test_restoring_a_version_brings_its_search_back(self, test_client, on, db_session):
        flags(viewPortabilityEnabled=True)
        ws = await _ws(test_client)
        made = await _subset(test_client, ws, await _base(test_client, ws))
        sub = made["view"]["id"]
        changed = await test_client.put(f"/api/v1/views/{sub}/search", json={
            "ifDefinitionHash": made["search"]["definitionHash"], "predicate": {"kind": "tag", "values": ["x"]}})
        assert changed.status_code == 200
        resp = await test_client.post(f"/api/v1/views/{sub}/versions/1/restore")
        assert resp.status_code == 200, resp.text
        _row, config = await _stored(db_session, sub)
        assert config["search"]["predicate"]["values"] == ["pii"]

    def test_a_file_cant_bring_a_search_this_server_wont_keep(self):
        good = {"search": {"v": 1, "predicate": P, "within": "view", "readIn": "b", "layout": "inherit"},
                "layout": {"referenceLayout": {"layers": [], "assignments": {}}}}
        importing._check_search(good)
        importing._check_search({"layout": {}})                         # not a subset: nothing to check
        with pytest.raises(HTTPException) as exc:
            importing._check_search({**good, "search": {**good["search"], "predicate": {
                "kind": "layer", "layerAssignment": "Gold"}}})
        assert exc.value.status_code == 422 and "layer" in exc.value.detail
        with pytest.raises(HTTPException):
            importing._check_search({**good, "search": {"v": 7}})
        with pytest.raises(HTTPException) as exc:
            importing._check_search({**good, "layout": {"referenceLayout": {"layers": LAYERS}}})
        assert "base view" in exc.value.detail
        assert importing._subset_of(good) == "b" and importing._subset_of({}) is None

    def test_a_file_replaces_a_view_of_its_own_kind_only(self):
        row = ViewORM(name="Plain", config=json.dumps({"layout": {}}))
        importing._same_kind(row, {"layout": {}})
        with pytest.raises(HTTPException) as exc:
            importing._same_kind(row, {"search": {"v": 1}})
        assert exc.value.status_code == 422 and "new view" in exc.value.detail

    def test_its_search_is_remapped_with_the_rest(self):
        definition = {"search": {"predicate": {"kind": "group", "op": "and", "children": [
            {"kind": "descendantOf", "urns": ["urn:old"]},
            {"kind": "entityType", "values": ["Table"]}]}}}
        refs = references.collect(definition)
        assert "urn:old" in refs.urns and "Table" in refs.entity_types
        out = references.rewrite(definition, references.Rewrite(
            urn_map={"urn:old": "urn:new"}, type_map={"Table": "Dataset"}))
        children = out["search"]["predicate"]["children"]
        assert children[0]["urns"] == ["urn:new"] and children[1]["values"] == ["Dataset"]


class TestExport:
    async def test_a_data_export_of_a_subset_view_is_refused(self, test_client, on, db_session, monkeypatch):
        from backend.app.api.v1.endpoints import versioning, view_guards
        ws = await _ws(test_client)
        sub = (await _subset(test_client, ws, await _base(test_client, ws)))["view"]["id"]
        row, _ = await _stored(db_session, sub)

        async def readable(session, view_id, user, claims):
            return row

        monkeypatch.setattr(view_guards, "readable_view", readable)
        with pytest.raises(HTTPException) as exc:
            await versioning._check_export_access(
                ws, "g", {"data_source_id": row.data_source_id}, branch_id=None, view_id=sub,
                viewer=None, user=None, claims=None, session=db_session, svc=None)
        assert exc.value.status_code == 422 and exc.value.detail["reason"] == "subset_view"
