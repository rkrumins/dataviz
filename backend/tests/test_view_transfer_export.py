"""Exporting views to a View Bundle file, and parsing one back."""
from __future__ import annotations

import json
import time

import pytest
from httpx import AsyncClient
from sqlalchemy import select, update

from backend.app.db.models import ViewActivityLogORM, ViewMemberORM, ViewORM
from backend.app.db.repositories import view_members_repo
from backend.app.services.feature_flags import feature_flags
from backend.app.services.view_transfer import bundle as bundle_mod
from backend.app.services.view_transfer import limits
from backend.app.services.view_transfer.canonical import content_hash, portable_definition

from backend.app.services.permission_service import PermissionClaims
from backend.tests.test_view_transfer_import import _as, _user
from backend.tests.test_views_from_members_api import (  # noqa: F401 — fixtures
    body as members_body,
    graph,
    membership_on,
    source_view,
)

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


async def _view(client: AsyncClient, ws_id: str, name="Finance lineage", visibility="private") -> str:
    resp = await client.post("/api/v1/views/", json={
        "name": name, "workspaceId": ws_id, "viewType": "reference", "tags": ["finance"],
        "visibility": visibility,
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


async def _unsaved_change(client: AsyncClient, vid: str):
    """A canvas save: a layout write that takes no version."""
    await client.put(f"/api/v1/views/{vid}/layout", json={"referenceLayout": {
        "layers": [{"id": "l1", "name": "Sources", "entityTypes": [], "order": 0}],
        "assignments": {"urn:b": {"layerId": "l1", "inheritsChildren": True}}}})


async def _preview(client: AsyncClient, *view_ids):
    resp = await client.post("/api/v1/views/transfer/export/preview", json={"viewIds": list(view_ids)})
    assert resp.status_code == 200, resp.text
    return resp.json()["views"]


async def test_the_preview_says_what_an_export_would_write_and_writes_nothing(test_client, fake_graph):
    ws = await _workspace(test_client)
    vid = await _view(test_client, ws)
    await _unsaved_change(test_client, vid)
    [view] = await _preview(test_client, vid, vid)                 # listed twice, described once
    assert (view["headVersion"], view["dirty"], view["maySeal"]) == (1, True, True)
    assert (view["exportsAs"], view["includesUnsaved"]) == (2, True)
    assert view["stats"]["assignments"] == 1 and view["estimatedBytes"] > 0
    assert (view["workspaceId"], view["name"]) == (ws, "Finance lineage")
    history = (await test_client.get(f"/api/v1/views/{vid}/versions")).json()["items"]
    assert [v["version"] for v in history] == [1], "a preview writes nothing"


async def test_a_reader_exports_the_latest_version_and_saves_nothing(test_client, fake_graph):
    """Sealing unsaved changes writes a version: only someone who may edit the view does that."""
    ws = await _workspace(test_client)
    vid = await _view(test_client, ws, visibility="workspace")
    await _unsaved_change(test_client, vid)
    reader = _user("usr_reader")
    with _as(reader, PermissionClaims(sid="s_reader", ws_perms={ws: ("workspace:view:read",)})):
        [view] = await _preview(test_client, vid)
        assert (view["dirty"], view["maySeal"], view["includesUnsaved"], view["exportsAs"]) == (True, False, False, 1)
        resp = await _export(test_client, {"viewId": vid})
        assert resp.status_code == 200, resp.text
        assert resp.headers["x-view-version"] == "1" and resp.json()["views"][0]["version"] == 1
    history = (await test_client.get(f"/api/v1/views/{vid}/versions")).json()["items"]
    assert [v["version"] for v in history] == [1], "the reader's export saved nothing"
    # Someone who may edit it seals the change on the way out.
    assert (await _export(test_client, {"viewId": vid})).headers["x-view-version"] == "2"


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


# ── A view made from a query: its members ───────────────────────────────────

COLUMNS = ["urn", "layerId", "whole", "name", "type", "orderKey", "logicalNodeId"]


async def _list_view(client: AsyncClient, ws: str, src: str, **overrides) -> str:
    resp = await client.post("/api/v1/views/from-members", json=members_body(ws, src, **overrides))
    assert resp.status_code == 201, resp.text
    return resp.json()["view"]["id"]


async def test_a_snapshot_carries_its_members_beside_its_definition(
    test_client, db_session, fake_graph, graph, membership_on, monkeypatch,
):
    """A snapshot's members are data, not design: carried beside its definition, in name
    order — never in it, nor in its hash. A view kept up to date carries none: it works its
    members out where it arrives."""
    async def _engine_for(session, workspace_id, data_source_id, **kwargs):
        raise ConnectionError("no graph here")

    monkeypatch.setattr("backend.app.services.view_transfer.inspect.engine_for", _engine_for)
    ws = await _workspace(test_client)
    src = await source_view(test_client, ws)
    frozen = await _list_view(test_client, ws, src, mode="snapshot", name="Frozen")
    kept = await _list_view(test_client, ws, src, name="Kept up to date")
    # Named so that name order isn't URN order.
    await db_session.execute(update(ViewMemberORM).where(
        ViewMemberORM.view_id == frozen, ViewMemberORM.urn == "col_a1",
    ).values(name="zeta", sort_key=view_members_repo.sort_key("zeta", "col_a1")))
    await db_session.commit()

    resp = await _export(test_client, {"viewId": frozen}, {"viewId": kept})
    assert resp.status_code == 200, resp.text
    snapshot, live = resp.json()["views"]
    assert "members" not in live
    members = snapshot["members"]
    assert (members["format"], members["count"], members["columns"]) == ("rows-v1", 6, COLUMNS)
    assert [row[0] for row in members["rows"]] == ["col_a2", "col_b1", "dom", "tbl_a", "tbl_b", "col_a1"]
    layers = {l["id"]: l["name"] for l in snapshot["definition"]["layout"]["referenceLayout"]["layers"]}
    rows = {row[0]: dict(zip(COLUMNS, row)) for row in members["rows"]}
    assert (layers[rows["col_a1"]["layerId"]], rows["col_a1"]["name"], rows["col_a1"]["type"]) == (
        "Columns", "zeta", "column")
    held = (await db_session.execute(select(ViewMemberORM.urn, ViewMemberORM.layer_id, ViewMemberORM.whole).where(
        ViewMemberORM.view_id == frozen))).all()
    assert {(r["urn"], r["layerId"], r["whole"]) for r in rows.values()} == {tuple(h) for h in held}
    assert snapshot["definition"]["layout"]["referenceLayout"]["assignments"] == {}
    assert snapshot["definitionHash"] == content_hash(portable_definition(snapshot["definition"], "reference"))

    parsed = bundle_mod.parse_bundle(resp.content)
    assert parsed.integrity == "verified" and parsed.views[0].raw["members"]["count"] == 6
    stripped = json.loads(resp.content)
    stripped["views"][0].pop("members")
    without = bundle_mod.parse_bundle(json.dumps(stripped).encode())
    assert without.integrity == "verified", "the section is outside every hash"
    assert without.views[0].actual_hash == parsed.views[0].actual_hash

    inspected = await test_client.post("/api/v1/views/transfer/inspect", content=resp.content,
                                       headers={"content-type": "application/json"})
    assert inspected.status_code == 200, inspected.text
    assert [v["members"] for v in inspected.json()["views"]] == [members, None], "what the wizard sends back"


def test_a_snapshots_members_count_against_a_files_limit(monkeypatch):
    doc = _minimal_bundle()
    doc["views"][0]["members"] = {"format": "rows-v1", "count": 2, "columns": COLUMNS, "rows": [
        ["urn:a", "l1", False, "a", "table", None, None], ["urn:b", "l1", True, "b", "table", None, None]]}
    assert bundle_mod.parse_bundle(json.dumps(doc).encode()).integrity == "verified"
    monkeypatch.setattr(limits, "MAX_ASSIGNMENTS_PER_BUNDLE", 1)
    with pytest.raises(bundle_mod.BundleError) as info:
        bundle_mod.parse_bundle(json.dumps(doc).encode())
    assert info.value.code == "too_many_assignments"


@pytest.mark.parametrize("damage", [
    {"count": 3},
    {"rows": [["urn:a", "l1"]], "count": 1},
    {"columns": ["urn", "name"], "rows": [["urn:a", "a"]], "count": 1},
    {"format": "rows-v9"},
])
def test_a_damaged_members_section_is_refused(damage):
    doc = _minimal_bundle()
    doc["views"][0]["members"] = {"format": "rows-v1", "count": 1, "columns": COLUMNS,
                                  "rows": [["urn:a", "l1", False, "a", "table", None, None]], **damage}
    with pytest.raises(bundle_mod.BundleError) as info:
        bundle_mod.parse_bundle(json.dumps(doc).encode())
    assert info.value.code == "invalid_bundle"


async def test_the_preview_counts_a_list_views_members(test_client, fake_graph, graph, membership_on):
    """Its design holds none of its members, so the preview counts them beside it — and a
    snapshot's, which its file carries, in its size."""
    ws = await _workspace(test_client)
    src = await source_view(test_client, ws)
    frozen = await _list_view(test_client, ws, src, mode="snapshot")
    kept = await _list_view(test_client, ws, src)
    plain = await _view(test_client, ws)
    snapshot, live, ordinary = await _preview(test_client, frozen, kept, plain)
    assert (snapshot["stats"]["members"], live["stats"]["members"]) == (6, 6)
    assert snapshot["stats"]["assignments"] == live["stats"]["assignments"] == 0
    assert "members" not in ordinary["stats"]
    assert snapshot["estimatedBytes"] > live["estimatedBytes"]


async def test_a_drafts_review_counts_a_list_views_members(test_client, db_session, graph, membership_on):
    from backend.app.services import draft_views

    ws = await _workspace(test_client)
    view_id = await _list_view(test_client, ws, await source_view(test_client, ws))
    row = (await db_session.execute(select(ViewORM).where(ViewORM.id == view_id))).scalar_one()
    row.draft_branch_id = "br-review"           # waiting in a draft to go live, as a staged import does
    await db_session.commit()
    [entry] = await draft_views.changes_on(db_session, "br-review")
    assert (entry["change"], entry["stats"]["members"], entry["stats"]["assignments"]) == ("create", 6, 0)


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
