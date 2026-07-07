"""API endpoint tests for PUT /api/v1/views/{view_id}/layout.

Tests the layout-only update endpoint using the test_client fixture which
overrides auth and DB session (see test_api_views.py for the same
convention).
"""
from httpx import AsyncClient


# ── Helpers ────────────────────────────────────────────────────────────

async def _create_workspace(client: AsyncClient) -> str:
    resp = await client.post(
        "/api/v1/admin/workspaces",
        json={"name": "Layout Test WS", "dataSources": []},
    )
    assert resp.status_code == 201
    return resp.json()["id"]


async def _create_view(client: AsyncClient, workspace_id: str, name: str = "Test View", **overrides) -> dict:
    base = {
        "name": name,
        "workspaceId": workspace_id,
        "viewType": "reference",
        "config": {
            "content": {
                "visibleEntityTypes": ["domain"],
                "visibleRelationshipTypes": [],
                "defaultDepth": 5,
                "maxDepth": 10,
                "rootEntityTypes": ["domain"],
            },
            "filters": {"entityTypeFilters": [], "fieldFilters": [], "searchableFields": [], "quickFilters": []},
            "layout": {"type": "reference", "lod": {"enabled": False, "levels": []}},
        },
        "visibility": "private",
    }
    base.update(overrides)
    resp = await client.post("/api/v1/views/", json=base)
    assert resp.status_code == 201
    return resp.json()


def _layout_payload(**overrides) -> dict:
    base = {
        "referenceLayout": {
            "layers": [{"id": "l1", "name": "Layer 1", "entityTypes": [], "order": 0}],
            "assignments": {"urn:a": {"layerId": "l1", "inheritsChildren": True, "assignedBy": "user"}},
        },
    }
    base.update(overrides)
    return base


# ── PUT /views/{view_id}/layout ─────────────────────────────────────────

async def test_update_view_layout(test_client: AsyncClient):
    """Layout update succeeds and the referenceLayout round-trips."""
    ws_id = await _create_workspace(test_client)
    created = await _create_view(test_client, ws_id, "Layout View")
    view_id = created["id"]

    resp = await test_client.put(
        f"/api/v1/views/{view_id}/layout",
        json=_layout_payload(),
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["config"]["layout"]["referenceLayout"]["layers"][0]["id"] == "l1"
    assert body["config"]["layout"]["referenceLayout"]["assignments"]["urn:a"]["layerId"] == "l1"


async def test_update_view_layout_preserves_other_config_keys(test_client: AsyncClient):
    """Layout-only merge preserves name/content/filters and other config keys."""
    ws_id = await _create_workspace(test_client)
    created = await _create_view(test_client, ws_id, "Preserve Me")
    view_id = created["id"]

    resp = await test_client.put(
        f"/api/v1/views/{view_id}/layout",
        json=_layout_payload(),
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["name"] == "Preserve Me"
    assert body["config"]["content"]["visibleEntityTypes"] == ["domain"]
    assert body["config"]["content"]["defaultDepth"] == 5
    assert body["config"]["filters"]["entityTypeFilters"] == []
    assert body["config"]["layout"]["type"] == "reference"
    assert body["config"]["layout"]["lod"] == {"enabled": False, "levels": []}


async def test_update_view_layout_sets_entity_scope(test_client: AsyncClient):
    """entityScope, when present, is written to config.content.entityScope only."""
    ws_id = await _create_workspace(test_client)
    created = await _create_view(test_client, ws_id, "Scoped View")
    view_id = created["id"]

    resp = await test_client.put(
        f"/api/v1/views/{view_id}/layout",
        json=_layout_payload(entityScope="curated"),
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["config"]["content"]["entityScope"] == "curated"
    # Untouched sibling content fields survive.
    assert body["config"]["content"]["visibleEntityTypes"] == ["domain"]


async def test_update_view_layout_unknown_layer_id_422(test_client: AsyncClient):
    """An assignment naming a layerId absent from layers is rejected with 422."""
    ws_id = await _create_workspace(test_client)
    created = await _create_view(test_client, ws_id, "Bad Assignment View")
    view_id = created["id"]

    resp = await test_client.put(
        f"/api/v1/views/{view_id}/layout",
        json=_layout_payload(referenceLayout={
            "layers": [{"id": "l1", "name": "Layer 1", "entityTypes": [], "order": 0}],
            "assignments": {"urn:a": {"layerId": "does-not-exist", "inheritsChildren": True}},
        }),
    )
    assert resp.status_code == 422


async def test_update_view_layout_missing_layers_key_422(test_client: AsyncClient):
    """referenceLayout without a layers list fails request validation (422)."""
    ws_id = await _create_workspace(test_client)
    created = await _create_view(test_client, ws_id, "Malformed View")
    view_id = created["id"]

    resp = await test_client.put(
        f"/api/v1/views/{view_id}/layout",
        json={"referenceLayout": {"assignments": {}}},
    )
    assert resp.status_code == 422


async def test_update_view_layout_bumps_updated_at(test_client: AsyncClient):
    """A layout save bumps updated_at."""
    ws_id = await _create_workspace(test_client)
    created = await _create_view(test_client, ws_id, "Freshness View")
    view_id = created["id"]
    original_updated_at = created["updatedAt"]

    resp = await test_client.put(
        f"/api/v1/views/{view_id}/layout",
        json=_layout_payload(),
    )
    assert resp.status_code == 200
    assert resp.json()["updatedAt"] != original_updated_at


async def test_update_view_layout_not_found(test_client: AsyncClient):
    """Layout update on a non-existent view returns 404."""
    resp = await test_client.put(
        "/api/v1/views/view_ghost/layout",
        json=_layout_payload(),
    )
    assert resp.status_code == 404
