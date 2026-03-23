"""
API endpoint tests for /api/v1/views/*.

Tests the view CRUD, visibility, favourite, soft-delete and restore endpoints
using the test_client fixture which overrides auth and DB session.
"""
from httpx import AsyncClient


# ── Helpers ────────────────────────────────────────────────────────────

async def _create_workspace(client: AsyncClient) -> str:
    """Create a workspace and return its ID (views require a workspace_id)."""
    resp = await client.post(
        "/api/v1/admin/workspaces",
        json={"name": "View Test WS", "dataSources": []},
    )
    assert resp.status_code == 201
    return resp.json()["id"]


def _view_payload(workspace_id: str, name: str = "Test View", **overrides) -> dict:
    base = {
        "name": name,
        "workspaceId": workspace_id,
        "viewType": "graph",
        "config": {},
        "visibility": "private",
    }
    base.update(overrides)
    return base


async def _create_view(client: AsyncClient, workspace_id: str, name: str = "Test View", **kw) -> dict:
    resp = await client.post("/api/v1/views/", json=_view_payload(workspace_id, name, **kw))
    assert resp.status_code == 201
    return resp.json()


# ── GET /views (empty) ─────────────────────────────────────────────────

async def test_list_views_empty(test_client: AsyncClient):
    """Initially the view list is empty."""
    resp = await test_client.get("/api/v1/views/")
    assert resp.status_code == 200
    assert resp.json() == []


# ── POST /views ────────────────────────────────────────────────────────

async def test_create_view(test_client: AsyncClient):
    """Create a view returns 201 with the created resource."""
    ws_id = await _create_workspace(test_client)
    body = await _create_view(test_client, ws_id, "My View")
    assert body["name"] == "My View"
    assert "id" in body
    assert body["workspaceId"] == ws_id
    assert body["viewType"] == "graph"
    assert body["visibility"] == "private"


async def test_create_view_with_optional_fields(test_client: AsyncClient):
    """Create a view with description and tags."""
    ws_id = await _create_workspace(test_client)
    body = await _create_view(
        test_client, ws_id, "Tagged View",
        description="A test view",
        tags=["tag1", "tag2"],
    )
    assert body["description"] == "A test view"
    assert body["tags"] == ["tag1", "tag2"]


async def test_create_view_missing_workspace_id(test_client: AsyncClient):
    """Creating a view without workspaceId fails with 422."""
    resp = await test_client.post(
        "/api/v1/views/",
        json={"name": "No WS", "viewType": "graph"},
    )
    assert resp.status_code == 422


# ── GET /views/{view_id} ──────────────────────────────────────────────

async def test_get_view(test_client: AsyncClient):
    """Fetch a created view by ID."""
    ws_id = await _create_workspace(test_client)
    created = await _create_view(test_client, ws_id, "Fetch Me")
    view_id = created["id"]

    resp = await test_client.get(f"/api/v1/views/{view_id}")
    assert resp.status_code == 200
    assert resp.json()["id"] == view_id
    assert resp.json()["name"] == "Fetch Me"


async def test_get_view_not_found(test_client: AsyncClient):
    """Fetching a non-existent view returns 404."""
    resp = await test_client.get("/api/v1/views/view_nonexistent")
    assert resp.status_code == 404


# ── PUT /views/{view_id} ──────────────────────────────────────────────

async def test_update_view(test_client: AsyncClient):
    """Update view name and description."""
    ws_id = await _create_workspace(test_client)
    created = await _create_view(test_client, ws_id, "Old Name")
    view_id = created["id"]

    resp = await test_client.put(
        f"/api/v1/views/{view_id}",
        json={"name": "New Name", "description": "Updated desc"},
    )
    assert resp.status_code == 200
    assert resp.json()["name"] == "New Name"
    assert resp.json()["description"] == "Updated desc"


async def test_update_view_not_found(test_client: AsyncClient):
    """Updating a non-existent view returns 404."""
    resp = await test_client.put(
        "/api/v1/views/view_ghost",
        json={"name": "Ghost"},
    )
    assert resp.status_code == 404


# ── DELETE /views/{view_id} (soft) ────────────────────────────────────

async def test_soft_delete_view(test_client: AsyncClient):
    """Soft-deleting a view returns 204."""
    ws_id = await _create_workspace(test_client)
    created = await _create_view(test_client, ws_id, "Soft Delete Me")
    view_id = created["id"]

    resp = await test_client.delete(f"/api/v1/views/{view_id}")
    assert resp.status_code == 204


async def test_delete_view_not_found(test_client: AsyncClient):
    """Deleting a non-existent view returns 404."""
    resp = await test_client.delete("/api/v1/views/view_nope")
    assert resp.status_code == 404


# ── DELETE /views/{view_id}?permanent=true ─────────────────────────────

async def test_permanent_delete_view(test_client: AsyncClient):
    """Permanently deleting a view returns 204 and it is gone."""
    ws_id = await _create_workspace(test_client)
    created = await _create_view(test_client, ws_id, "Perm Delete Me")
    view_id = created["id"]

    resp = await test_client.delete(f"/api/v1/views/{view_id}?permanent=true")
    assert resp.status_code == 204

    # View should be truly gone
    resp = await test_client.get(f"/api/v1/views/{view_id}")
    assert resp.status_code == 404


# ── POST /views/{view_id}/restore ──────────────────────────────────────

async def test_restore_soft_deleted_view(test_client: AsyncClient):
    """Restoring a soft-deleted view brings it back."""
    ws_id = await _create_workspace(test_client)
    created = await _create_view(test_client, ws_id, "Restore Me")
    view_id = created["id"]

    # Soft-delete
    resp = await test_client.delete(f"/api/v1/views/{view_id}")
    assert resp.status_code == 204

    # Restore
    resp = await test_client.post(f"/api/v1/views/{view_id}/restore")
    assert resp.status_code == 200
    assert resp.json()["id"] == view_id
    assert resp.json()["name"] == "Restore Me"


async def test_restore_not_found(test_client: AsyncClient):
    """Restoring a non-existent view returns 404."""
    resp = await test_client.post("/api/v1/views/view_nope/restore")
    assert resp.status_code == 404


# ── PUT /views/{view_id}/visibility ───────────────────────────────────

async def test_update_visibility(test_client: AsyncClient):
    """Update view visibility to workspace."""
    ws_id = await _create_workspace(test_client)
    created = await _create_view(test_client, ws_id, "Visibility Test")
    view_id = created["id"]

    resp = await test_client.put(
        f"/api/v1/views/{view_id}/visibility",
        json={"visibility": "workspace"},
    )
    assert resp.status_code == 200
    assert resp.json()["visibility"] == "workspace"


async def test_update_visibility_enterprise(test_client: AsyncClient):
    """Update view visibility to enterprise."""
    ws_id = await _create_workspace(test_client)
    created = await _create_view(test_client, ws_id, "Enterprise Vis")
    view_id = created["id"]

    resp = await test_client.put(
        f"/api/v1/views/{view_id}/visibility",
        json={"visibility": "enterprise"},
    )
    assert resp.status_code == 200
    assert resp.json()["visibility"] == "enterprise"


async def test_update_visibility_invalid(test_client: AsyncClient):
    """Invalid visibility value returns 422."""
    ws_id = await _create_workspace(test_client)
    created = await _create_view(test_client, ws_id, "Bad Vis")
    view_id = created["id"]

    resp = await test_client.put(
        f"/api/v1/views/{view_id}/visibility",
        json={"visibility": "public"},
    )
    assert resp.status_code == 422


async def test_update_visibility_not_found(test_client: AsyncClient):
    """Updating visibility of non-existent view returns 404."""
    resp = await test_client.put(
        "/api/v1/views/view_nope/visibility",
        json={"visibility": "private"},
    )
    assert resp.status_code == 404


# ── POST /views/{view_id}/favourite ───────────────────────────────────

async def test_favourite_view(test_client: AsyncClient):
    """Favouriting a view returns 201."""
    ws_id = await _create_workspace(test_client)
    created = await _create_view(test_client, ws_id, "Fave Me")
    view_id = created["id"]

    resp = await test_client.post(f"/api/v1/views/{view_id}/favourite")
    assert resp.status_code == 201
    body = resp.json()
    assert body["favourited"] is True


async def test_favourite_view_not_found(test_client: AsyncClient):
    """Favouriting a non-existent view returns 404."""
    resp = await test_client.post("/api/v1/views/view_nope/favourite")
    assert resp.status_code == 404


# ── DELETE /views/{view_id}/favourite ─────────────────────────────────

async def test_unfavourite_view(test_client: AsyncClient):
    """Unfavouriting a previously favourited view returns 204."""
    ws_id = await _create_workspace(test_client)
    created = await _create_view(test_client, ws_id, "Unfave Me")
    view_id = created["id"]

    # Favourite first
    resp = await test_client.post(f"/api/v1/views/{view_id}/favourite")
    assert resp.status_code == 201

    # Unfavourite
    resp = await test_client.delete(f"/api/v1/views/{view_id}/favourite")
    assert resp.status_code == 204


async def test_unfavourite_not_found(test_client: AsyncClient):
    """Unfavouriting when no favourite exists returns 404."""
    ws_id = await _create_workspace(test_client)
    created = await _create_view(test_client, ws_id, "No Fave")
    view_id = created["id"]

    resp = await test_client.delete(f"/api/v1/views/{view_id}/favourite")
    assert resp.status_code == 404


# ── GET /views/popular ────────────────────────────────────────────────

async def test_list_popular_views_empty(test_client: AsyncClient):
    """Popular views returns empty list initially."""
    resp = await test_client.get("/api/v1/views/popular")
    assert resp.status_code == 200
    assert resp.json() == []


# ── Filtering ─────────────────────────────────────────────────────────

async def test_list_views_filter_by_workspace(test_client: AsyncClient):
    """List views filtered by workspaceId."""
    ws_id = await _create_workspace(test_client)
    await _create_view(test_client, ws_id, "WS View")

    resp = await test_client.get(f"/api/v1/views/?workspaceId={ws_id}")
    assert resp.status_code == 200
    views = resp.json()
    assert len(views) >= 1
    assert all(v["workspaceId"] == ws_id for v in views)


async def test_list_views_with_search(test_client: AsyncClient):
    """List views with search query."""
    ws_id = await _create_workspace(test_client)
    await _create_view(test_client, ws_id, "Unique Search Name XYZ")

    resp = await test_client.get("/api/v1/views/?search=Unique Search Name XYZ")
    assert resp.status_code == 200


async def test_list_views_pagination(test_client: AsyncClient):
    """List views with limit and offset."""
    ws_id = await _create_workspace(test_client)
    for i in range(3):
        await _create_view(test_client, ws_id, f"Page View {i}")

    resp = await test_client.get("/api/v1/views/?limit=2&offset=0")
    assert resp.status_code == 200
    assert len(resp.json()) <= 2


# ── Full CRUD round-trip ──────────────────────────────────────────────

async def test_view_crud_roundtrip(test_client: AsyncClient):
    """Full create -> read -> update -> delete -> restore cycle."""
    ws_id = await _create_workspace(test_client)

    # Create
    created = await _create_view(test_client, ws_id, "Roundtrip")
    view_id = created["id"]

    # Read
    r = await test_client.get(f"/api/v1/views/{view_id}")
    assert r.status_code == 200
    assert r.json()["name"] == "Roundtrip"

    # Update
    r = await test_client.put(
        f"/api/v1/views/{view_id}",
        json={"name": "Roundtrip Updated"},
    )
    assert r.status_code == 200
    assert r.json()["name"] == "Roundtrip Updated"

    # Soft delete
    r = await test_client.delete(f"/api/v1/views/{view_id}")
    assert r.status_code == 204

    # Restore
    r = await test_client.post(f"/api/v1/views/{view_id}/restore")
    assert r.status_code == 200
    assert r.json()["name"] == "Roundtrip Updated"

    # Permanent delete
    r = await test_client.delete(f"/api/v1/views/{view_id}?permanent=true")
    assert r.status_code == 204

    # Gone
    r = await test_client.get(f"/api/v1/views/{view_id}")
    assert r.status_code == 404
