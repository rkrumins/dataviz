"""Exporting views to a View Bundle file, and parsing one back."""
from __future__ import annotations

import json
import time

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from backend.app.db.models import ViewActivityLogORM, ViewORM
from backend.app.services.feature_flags import feature_flags
from backend.app.services.view_transfer import bundle as bundle_mod
from backend.app.services.view_transfer.canonical import content_hash, portable_definition

pytestmark = pytest.mark.usefixtures("view_portability_enabled")  # the preview ships off


class _FakeProvider:
    def __init__(self, known):
        self.known = known
        self.calls = []

    async def resolve_identities(self, urns):
        self.calls.append(list(urns))
        return {u: self.known.get(u) for u in urns}


class _FakeEngine:
    def __init__(self, provider):
        self.provider = provider

    async def get_ontology_digest(self):
        return "digest-abc"


@pytest.fixture
def fake_graph(monkeypatch):
    provider = _FakeProvider({
        "urn:a": {"type": "dataset", "name": "revenue", "qualifiedName": "fin.revenue"},
        "urn:anchor": {"type": "domain", "name": "Finance", "qualifiedName": None},
    })

    async def _engine_for(session, workspace_id, data_source_id):
        return _FakeEngine(provider)

    monkeypatch.setattr("backend.app.services.view_transfer.export.engine_for", _engine_for)
    return provider


async def _workspace(client: AsyncClient, name="Export WS") -> str:
    resp = await client.post("/api/v1/admin/workspaces", json={"name": name, "dataSources": []})
    assert resp.status_code == 201
    return resp.json()["id"]


async def _view(client: AsyncClient, ws_id: str, name="Finance lineage") -> str:
    resp = await client.post("/api/v1/views/", json={
        "name": name, "workspaceId": ws_id, "viewType": "reference", "tags": ["finance"],
        "description": "What feeds revenue",
        "config": {"icon": "Layout", "content": {"visibleEntityTypes": ["domain"]},
                   "layout": {"type": "reference"}, "entityOverrides": {"domain": {"color": "#111"}}},
    })
    assert resp.status_code == 201
    vid = resp.json()["id"]
    await client.put(f"/api/v1/views/{vid}/layout", json={
        "referenceLayout": {
            "layers": [{"id": "l1", "name": "Sources", "entityTypes": [], "order": 0, "anchorUrn": "urn:anchor"}],
            "assignments": {"urn:a": {"layerId": "l1", "inheritsChildren": True},
                            "urn:gone": {"layerId": "l1", "inheritsChildren": True}},
        },
        "checkpoint": {"source": "create"},
    })
    return vid


async def _export(client: AsyncClient, *refs, message=None):
    return await client.post("/api/v1/views/transfer/export",
                             json={"views": [dict(r) for r in refs], "message": message})


async def test_export_writes_a_verified_file_for_the_current_version(test_client, db_session, fake_graph):
    ws = await _workspace(test_client)
    vid = await _view(test_client, ws)
    resp = await _export(test_client, {"viewId": vid})
    assert resp.status_code == 200
    assert resp.headers["content-disposition"] == 'attachment; filename="finance-lineage.v1.view.json"'
    bundle = resp.json()
    assert bundle["format"] == "view-bundle" and bundle["formatVersion"] == 1
    [view] = bundle["views"]
    assert view["version"] == 1 and view["sourceViewId"] == vid
    assert view["portableId"].startswith("pv_")
    assert view["metadata"] == {"name": "Finance lineage", "description": "What feeds revenue",
                                "icon": "Layout", "tags": ["finance"], "viewType": "reference"}
    assert "icon" not in view["definition"] and "name" not in view["definition"]
    assert view["definition"]["entityOverrides"] == {"domain": {"color": "#111"}}
    assert view["definitionHash"] == content_hash(portable_definition(view["definition"], "reference"))
    assert resp.headers["x-definition-hash"] == view["definitionHash"]
    assert view["manifest"]["entities"] == {
        "urn:a": {"name": "revenue", "type": "dataset", "qualifiedName": "fin.revenue"},
        "urn:anchor": {"name": "Finance", "type": "domain", "qualifiedName": None},
    }
    assert view["manifest"]["entitiesResolved"] is True
    assert view["manifest"]["counts"]["assignments"] == 2
    assert [h["version"] for h in view["history"]] == [1]
    assert bundle["sources"][view["source"]]["workspace"]["name"] == "Export WS"
    assert bundle["sources"][view["source"]]["ontology"]["digest"] == "digest-abc"

    parsed = bundle_mod.parse_bundle(resp.content)
    assert parsed.integrity == "verified" and parsed.views[0].integrity == "verified"

    actions = (await db_session.execute(
        select(ViewActivityLogORM.action).where(ViewActivityLogORM.view_id == vid))).scalars().all()
    assert "exported" in actions


async def test_unsaved_changes_are_sealed_as_a_version_before_they_leave(test_client, fake_graph):
    ws = await _workspace(test_client)
    vid = await _view(test_client, ws)
    await test_client.put(f"/api/v1/views/{vid}/layout", json={"referenceLayout": {
        "layers": [{"id": "l1", "name": "Sources", "entityTypes": [], "order": 0}],
        "assignments": {"urn:b": {"layerId": "l1", "inheritsChildren": True}}}})
    bundle = (await _export(test_client, {"viewId": vid}, message="For prod")).json()
    assert bundle["views"][0]["version"] == 2
    history = (await test_client.get(f"/api/v1/views/{vid}/versions")).json()["items"]
    assert (history[0]["version"], history[0]["source"], history[0]["message"]) == (2, "export", "For prod")


async def test_exporting_an_older_version_exports_exactly_that_version(test_client, fake_graph):
    ws = await _workspace(test_client)
    vid = await _view(test_client, ws)
    await test_client.put(f"/api/v1/views/{vid}/layout", json={
        "referenceLayout": {"layers": [{"id": "l1", "name": "S", "entityTypes": [], "order": 0}],
                            "assignments": {}}, "checkpoint": {"source": "wizard"}})
    old = (await _export(test_client, {"viewId": vid, "version": 1})).json()["views"][0]
    assert old["version"] == 1
    assert set(old["definition"]["layout"]["referenceLayout"]["assignments"]) == {"urn:a", "urn:gone"}
    assert (await _export(test_client, {"viewId": vid, "version": 9})).status_code == 404


async def test_a_multi_view_file_shares_one_source_and_one_lookup(test_client, fake_graph):
    ws = await _workspace(test_client)
    first = await _view(test_client, ws, "One")
    second = await _view(test_client, ws, "Two")
    resp = await _export(test_client, {"viewId": first}, {"viewId": second})
    bundle = resp.json()
    assert resp.headers["content-disposition"] == 'attachment; filename="2-views.view.json"'
    assert len(bundle["sources"]) == 1 and len(bundle["views"]) == 2
    assert len(fake_graph.calls) == 1, "one identity lookup per source graph, not per view"
    assert bundle["bundleHash"] == bundle_mod.bundle_hash(bundle["views"])
    assert (await _export(test_client, {"viewId": first}, {"viewId": first})).status_code == 422


async def test_export_survives_an_unreachable_source(test_client, monkeypatch):
    async def _down(session, workspace_id, data_source_id):
        raise ConnectionError("provider down")

    monkeypatch.setattr("backend.app.services.view_transfer.export.engine_for", _down)
    ws = await _workspace(test_client)
    vid = await _view(test_client, ws)
    view = (await _export(test_client, {"viewId": vid})).json()["views"][0]
    assert view["manifest"]["entities"] == {} and view["manifest"]["entitiesResolved"] is False


async def test_the_switch_stops_exports(test_client, fake_graph):
    ws = await _workspace(test_client)
    vid = await _view(test_client, ws)
    feature_flags._cache = {**(feature_flags._cache or {}), "viewExportEnabled": False}
    feature_flags._cache_ts = time.monotonic()
    resp = await _export(test_client, {"viewId": vid})
    assert resp.status_code == 403 and resp.json()["detail"]["feature"] == "viewExportEnabled"


async def test_a_legacy_view_without_an_identity_gets_one_on_export(test_client, db_session, fake_graph):
    ws = await _workspace(test_client)
    vid = await _view(test_client, ws)
    row = (await db_session.execute(select(ViewORM).where(ViewORM.id == vid))).scalar_one()
    row.portable_id = None
    await db_session.flush()
    view = (await _export(test_client, {"viewId": vid})).json()["views"][0]
    assert view["portableId"].startswith("pv_")


# ── Parsing ─────────────────────────────────────────────────────────────────


def _minimal_bundle(**overrides):
    definition = portable_definition({"layout": {"type": "graph"}}, "graph")
    view = {"source": "s1", "portableId": "pv_1", "version": 1,
            "definitionHash": content_hash(definition),
            "metadata": {"name": "V", "viewType": "graph"}, "definition": definition}
    doc = {"format": "view-bundle", "formatVersion": 1, "sources": {"s1": {}}, "views": [view]}
    doc["bundleHash"] = bundle_mod.bundle_hash(doc["views"])
    doc.update(overrides)
    return doc


def test_a_file_edited_after_export_still_parses_but_says_so():
    doc = _minimal_bundle()
    doc["views"][0]["definition"]["filters"] = {"fieldFilters": [{"field": "x"}]}
    parsed = bundle_mod.parse_bundle(json.dumps(doc).encode())
    assert parsed.views[0].integrity == "modified" and parsed.integrity == "modified"
    assert any(n["code"] == "modified" for n in parsed.notices)


def test_formatting_and_key_order_do_not_count_as_edits():
    doc = _minimal_bundle()
    pretty = json.dumps(doc, indent=4, sort_keys=True).encode()
    assert bundle_mod.parse_bundle(pretty).integrity == "verified"


@pytest.mark.parametrize("raw, code", [
    (b"not json", "not_json"),
    (json.dumps({"format": "other"}).encode(), "wrong_format"),
    (json.dumps(_minimal_bundle(formatVersion=2)).encode(), "newer_format"),
    (json.dumps(_minimal_bundle(views=[])).encode(), "empty"),
    (("[" * 200 + "]" * 200).encode(), "too_deep"),
    (b"\xff\xfe\x00", "not_json"),
])
def test_files_that_are_not_bundles_are_refused_with_a_reason(raw, code):
    with pytest.raises(bundle_mod.BundleError) as info:
        bundle_mod.parse_bundle(raw)
    assert info.value.code == code


def test_a_view_naming_an_undescribed_source_is_refused():
    doc = _minimal_bundle()
    doc["views"][0]["source"] = "s9"
    with pytest.raises(bundle_mod.BundleError):
        bundle_mod.parse_bundle(json.dumps(doc).encode())


def test_a_view_removed_by_hand_is_noticed():
    doc = _minimal_bundle()
    second = dict(doc["views"][0], portableId="pv_2")
    doc["views"].append(second)
    doc["bundleHash"] = bundle_mod.bundle_hash(doc["views"])
    doc["views"].pop()
    parsed = bundle_mod.parse_bundle(json.dumps(doc).encode())
    assert parsed.integrity == "modified"
    assert any(n["code"] == "set_changed" for n in parsed.notices)
