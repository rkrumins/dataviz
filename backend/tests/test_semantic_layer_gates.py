"""The six semantic-layer toggles, and the view-mode list, now actually stop things.

Before this, all six were decoration. An admin could turn "Import" off and watch people go on
importing; turn "Export" off and watch the JSON download; turn editing off and watch the layer
get rewritten. The switches were on the page, they saved, they showed as enabled — and no line
of server code ever read them.

These tests are the difference. Each one turns a flag off and proves the server REFUSES, then
proves it refuses the right things and only the right things — because a gate that also blocks
reads, or blocks the analysis endpoints, would be its own kind of broken.
"""
import time

from httpx import AsyncClient

from backend.app.services.feature_flags import feature_flags


def _set_flag(key: str, value) -> None:
    """Set a flag as far as the gates are concerned."""
    feature_flags._cache = dict(feature_flags._cache or {}, **{key: value})
    feature_flags._cache_ts = time.monotonic()


async def _ontology(client: AsyncClient, name: str = "Layer") -> str:
    resp = await client.post("/api/v1/admin/ontologies", json={
        "name": name,
        "entityTypeDefinitions": {"Node": {"id": "Node", "name": "Node"}},
        "relationshipTypeDefinitions": {},
    })
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


# ── semanticLayerEditMode ─────────────────────────────────────────────────────

async def test_edit_mode_off_refuses_every_content_write(
    test_client: AsyncClient,
):
    ontology_id = await _ontology(test_client, "Frozen")
    _set_flag("semanticLayerEditMode", False)

    created = await test_client.post("/api/v1/admin/ontologies", json={
        "name": "Nope", "entityTypeDefinitions": {}, "relationshipTypeDefinitions": {},
    })
    assert created.status_code == 403
    assert created.json()["detail"]["feature"] == "semanticLayerEditMode"

    updated = await test_client.put(
        f"/api/v1/admin/ontologies/{ontology_id}", json={"name": "Renamed"},
    )
    assert updated.status_code == 403

    deleted = await test_client.delete(f"/api/v1/admin/ontologies/{ontology_id}")
    assert deleted.status_code == 403


async def test_edit_mode_off_still_allows_reading(
    test_client: AsyncClient,
):
    """Read-only means READ-only. Turning editing off must not black out the pages."""
    ontology_id = await _ontology(test_client, "Readable")
    _set_flag("semanticLayerEditMode", False)

    assert (await test_client.get("/api/v1/admin/ontologies")).status_code == 200
    assert (await test_client.get(f"/api/v1/admin/ontologies/{ontology_id}")).status_code == 200


async def test_edit_mode_off_still_allows_publish_and_clone(
    test_client: AsyncClient,
):
    """The promise the product makes in its own admin hint: "Admins can still publish, clone,
    and export." If that copy is on the page, the gate has to honour it."""
    ontology_id = await _ontology(test_client, "Publishable")
    _set_flag("semanticLayerEditMode", False)

    published = await test_client.post(f"/api/v1/admin/ontologies/{ontology_id}/publish")
    assert published.status_code == 200, published.text

    cloned = await test_client.post(
        f"/api/v1/admin/ontologies/{ontology_id}/clone", json={"name": "Copy"},
    )
    assert cloned.status_code == 201, cloned.text


async def test_edit_mode_off_also_refuses_IMPORT(
    test_client: AsyncClient,
):
    """The subtle one, and the whole reason import carries the edit gate as well as its own.

    Import rewrites a layer's content — it is editing that happens to arrive as a file. If it
    escaped the edit gate, "semantic layers are read-only" would be false for anyone willing to
    upload, which is precisely the hole these flags exist to close.
    """
    _set_flag("semanticLayerEditMode", False)

    resp = await test_client.post("/api/v1/admin/ontologies/import", json={
        "ontology": {
            "name": "Smuggled",
            "entityTypeDefinitions": {},
            "relationshipTypeDefinitions": {},
        },
    })
    assert resp.status_code == 403, "editing is off — an upload must not be a way around it"


# ── the flags with their own switch ───────────────────────────────────────────

async def test_import_off_refuses_import_but_editing_still_works(
    test_client: AsyncClient,
):
    ontology_id = await _ontology(test_client, "Editable")
    _set_flag("semanticLayerImportEnabled", False)

    blocked = await test_client.post("/api/v1/admin/ontologies/import", json={
        "ontology": {
            "name": "Imported",
            "entityTypeDefinitions": {},
            "relationshipTypeDefinitions": {},
        },
    })
    assert blocked.status_code == 403
    assert blocked.json()["detail"]["feature"] == "semanticLayerImportEnabled"

    still_editable = await test_client.put(
        f"/api/v1/admin/ontologies/{ontology_id}", json={"name": "Still Editable"},
    )
    assert still_editable.status_code == 200, "only IMPORT was turned off"


async def test_export_off_refuses_the_download(
    test_client: AsyncClient,
):
    ontology_id = await _ontology(test_client, "Secret")
    assert (await test_client.get(f"/api/v1/admin/ontologies/{ontology_id}/export")).status_code == 200

    _set_flag("semanticLayerExportEnabled", False)

    resp = await test_client.get(f"/api/v1/admin/ontologies/{ontology_id}/export")
    assert resp.status_code == 403
    assert resp.json()["detail"]["feature"] == "semanticLayerExportEnabled"


async def test_auto_suggest_off_refuses_to_score(
    test_client: AsyncClient,
):
    _set_flag("semanticLayerAutoSuggest", False)

    resp = await test_client.post("/api/v1/admin/ontologies/suggest", json={
        "totalNodes": 1, "totalEdges": 0,
        "entityTypeStats": [{"id": "Node", "name": "Node", "count": 1, "sampleNames": []}],
        "edgeTypeStats": [], "tagStats": [],
    })
    assert resp.status_code == 403
    assert resp.json()["detail"]["feature"] == "semanticLayerAutoSuggest"


async def test_version_history_off_hides_versions_and_audit(
    test_client: AsyncClient,
):
    ontology_id = await _ontology(test_client, "Historic")
    _set_flag("semanticLayerVersionHistory", False)

    versions = await test_client.get(f"/api/v1/admin/ontologies/{ontology_id}/versions")
    assert versions.status_code == 403

    audit = await test_client.get(f"/api/v1/admin/ontologies/{ontology_id}/audit")
    assert audit.status_code == 403


async def test_analysis_endpoints_survive_a_frozen_model(
    test_client: AsyncClient,
):
    """Why these gates are per-route instead of one router-wide write_gate.

    `/validate`, `/coverage` and `/resolution-check` are POSTs that only ANALYSE. A gate keyed on
    the HTTP method would take them away along with the editing — and inspecting the model is
    exactly what you still want to do when it is frozen.
    """
    ontology_id = await _ontology(test_client, "Inspectable")
    _set_flag("semanticLayerEditMode", False)

    resp = await test_client.post(f"/api/v1/admin/ontologies/{ontology_id}/validate")
    assert resp.status_code == 200, "analysis is not editing"


# ── allowedViewModes ──────────────────────────────────────────────────────────

async def _workspace(client: AsyncClient) -> str:
    resp = await client.post(
        "/api/v1/admin/workspaces", json={"name": "Modes WS", "dataSources": []},
    )
    assert resp.status_code == 201
    return resp.json()["id"]


async def test_a_withdrawn_view_mode_cannot_be_created(
    test_client: AsyncClient,
):
    ws_id = await _workspace(test_client)
    _set_flag("allowedViewModes", ["graph"])

    allowed = await test_client.post("/api/v1/views/", json={
        "name": "Fine", "workspaceId": ws_id, "viewType": "graph", "visibility": "private",
    })
    assert allowed.status_code == 201, allowed.text

    refused = await test_client.post("/api/v1/views/", json={
        "name": "Withdrawn", "workspaceId": ws_id, "viewType": "hierarchy",
        "visibility": "private",
    })
    assert refused.status_code == 403
    assert refused.json()["detail"]["feature"] == "allowedViewModes"


async def test_a_view_ALREADY_built_in_a_withdrawn_mode_stays_editable(
    test_client: AsyncClient,
):
    """The promise: withdrawing a layout stops NEW work in it, and does not strand the old work.

    If saving a rename on a legacy hierarchy view started 403ing, an admin narrowing the list
    would silently freeze every view built before they did it.
    """
    ws_id = await _workspace(test_client)
    created = await test_client.post("/api/v1/views/", json={
        "name": "Legacy", "workspaceId": ws_id, "viewType": "hierarchy", "visibility": "private",
    })
    assert created.status_code == 201
    view_id = created.json()["id"]

    _set_flag("allowedViewModes", ["graph"])

    renamed = await test_client.put(
        f"/api/v1/views/{view_id}", json={"name": "Legacy, Renamed"},
    )
    assert renamed.status_code == 200, "an existing view in a withdrawn layout must stay editable"

    # But it cannot be CONVERTED into another withdrawn layout.
    converted = await test_client.put(
        f"/api/v1/views/{view_id}", json={"viewType": "reference"},
    )
    assert converted.status_code == 403


# ── Data governance: the two flags that close real holes ──────────────────────

async def test_graph_export_off_refuses_the_job_AND_the_download(test_client: AsyncClient):
    """The hole this closes.

    An admin could turn off "Export layers" (`semanticLayerExportEnabled`), watch the page go green,
    and believe their lineage could not leave the product — while the graph DATA itself walked out
    through the export job and its download, which no flag covered. Locking the SHAPE of the estate
    while leaving the CONTENTS open is the kind of gap that only looks safe.

    Both routes carry the gate. Gating creation alone would stop new exports while an
    already-queued one stayed collectable: the file leaves anyway, and the admin thinks they shut
    the door.
    """
    _set_flag("graphExportEnabled", False)

    started = await test_client.post("/api/v1/ws_x/versioning/graphs/g_x/exports", json={})
    assert started.status_code == 403, started.text
    assert started.json()["detail"]["feature"] == "graphExportEnabled"

    fetched = await test_client.get(
        "/api/v1/ws_x/versioning/graphs/g_x/exports/job_x/download",
    )
    assert fetched.status_code == 403, (
        "gating the job but not the download leaves the file collectable — the door is still open"
    )


async def test_blank_models_off_refuses_lineage_with_no_source_behind_it(test_client: AsyncClient):
    """The provenance switch.

    A hand-drawn model looks exactly like a discovered one on the canvas, and once it is in the
    estate nobody downstream can tell which is which. Until this flag existed the only way to forbid
    it was to turn version control off entirely — which also took drafts, reviews and history with
    it, so nobody ever did and the rule went unenforced.
    """
    _set_flag("blankModelsEnabled", False)

    resp = await test_client.post(
        "/api/v1/ws_x/versioning/blank-graphs", json={"name": "Drawn by hand"},
    )
    assert resp.status_code == 403
    assert resp.json()["detail"]["feature"] == "blankModelsEnabled"
