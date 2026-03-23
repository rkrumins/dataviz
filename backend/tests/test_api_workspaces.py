"""
Phase 4 — API endpoint tests for /api/v1/admin/workspaces/*.

The test_client fixture overrides auth (require_admin) and database
session, so all requests run against an in-memory SQLite DB.
"""
import pytest
from httpx import AsyncClient


# ── GET /admin/workspaces ─────────────────────────────────────────────

async def test_list_workspaces_empty(test_client: AsyncClient):
    """Initially the workspace list is empty."""
    resp = await test_client.get("/api/v1/admin/workspaces")
    assert resp.status_code == 200
    assert resp.json() == []


# ── POST /admin/workspaces ────────────────────────────────────────────

async def test_create_workspace_minimal(test_client: AsyncClient):
    """Create a workspace with no data sources (Skip for Now flow)."""
    resp = await test_client.post(
        "/api/v1/admin/workspaces",
        json={"name": "Test Workspace", "dataSources": []},
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["name"] == "Test Workspace"
    assert "id" in body
    assert isinstance(body.get("dataSources", []), list)


async def test_create_workspace_with_description(test_client: AsyncClient):
    """Create a workspace with optional description."""
    resp = await test_client.post(
        "/api/v1/admin/workspaces",
        json={
            "name": "Described WS",
            "description": "A workspace for testing",
            "dataSources": [],
        },
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["description"] == "A workspace for testing"


# ── GET /admin/workspaces/{id} ────────────────────────────────────────

async def test_get_workspace(test_client: AsyncClient):
    """Create then fetch a workspace by ID."""
    create_resp = await test_client.post(
        "/api/v1/admin/workspaces",
        json={"name": "Fetch Me", "dataSources": []},
    )
    ws_id = create_resp.json()["id"]

    resp = await test_client.get(f"/api/v1/admin/workspaces/{ws_id}")
    assert resp.status_code == 200
    assert resp.json()["id"] == ws_id
    assert resp.json()["name"] == "Fetch Me"


async def test_get_workspace_not_found(test_client: AsyncClient):
    """Fetching a non-existent workspace returns 404."""
    resp = await test_client.get("/api/v1/admin/workspaces/ws_nonexistent")
    assert resp.status_code == 404


# ── PUT /admin/workspaces/{id} ────────────────────────────────────────

async def test_update_workspace_name(test_client: AsyncClient):
    """Update the name of an existing workspace."""
    create_resp = await test_client.post(
        "/api/v1/admin/workspaces",
        json={"name": "Old Name", "dataSources": []},
    )
    ws_id = create_resp.json()["id"]

    resp = await test_client.put(
        f"/api/v1/admin/workspaces/{ws_id}",
        json={"name": "New Name"},
    )
    assert resp.status_code == 200
    assert resp.json()["name"] == "New Name"


async def test_update_workspace_not_found(test_client: AsyncClient):
    """Updating a non-existent workspace returns 404."""
    resp = await test_client.put(
        "/api/v1/admin/workspaces/ws_ghost",
        json={"name": "Ghost"},
    )
    assert resp.status_code == 404


# ── DELETE /admin/workspaces/{id} ─────────────────────────────────────

async def test_delete_workspace(test_client: AsyncClient):
    """Delete a workspace returns 204, subsequent GET returns 404."""
    create_resp = await test_client.post(
        "/api/v1/admin/workspaces",
        json={"name": "To Delete", "dataSources": []},
    )
    ws_id = create_resp.json()["id"]

    del_resp = await test_client.delete(f"/api/v1/admin/workspaces/{ws_id}")
    assert del_resp.status_code == 204

    get_resp = await test_client.get(f"/api/v1/admin/workspaces/{ws_id}")
    assert get_resp.status_code == 404


async def test_delete_workspace_not_found(test_client: AsyncClient):
    """Deleting a non-existent workspace returns 404."""
    resp = await test_client.delete("/api/v1/admin/workspaces/ws_nope")
    assert resp.status_code == 404


# ── Lifecycle round-trip ──────────────────────────────────────────────

async def test_workspace_crud_roundtrip(test_client: AsyncClient):
    """Full create -> read -> update -> delete cycle."""
    # Create
    r = await test_client.post(
        "/api/v1/admin/workspaces",
        json={"name": "Roundtrip", "dataSources": []},
    )
    assert r.status_code == 201
    ws_id = r.json()["id"]

    # Read
    r = await test_client.get(f"/api/v1/admin/workspaces/{ws_id}")
    assert r.status_code == 200

    # Update
    r = await test_client.put(
        f"/api/v1/admin/workspaces/{ws_id}",
        json={"name": "Roundtrip Updated"},
    )
    assert r.status_code == 200
    assert r.json()["name"] == "Roundtrip Updated"

    # List should include it
    r = await test_client.get("/api/v1/admin/workspaces")
    assert r.status_code == 200
    ids = [w["id"] for w in r.json()]
    assert ws_id in ids

    # Delete
    r = await test_client.delete(f"/api/v1/admin/workspaces/{ws_id}")
    assert r.status_code == 204

    # Gone
    r = await test_client.get(f"/api/v1/admin/workspaces/{ws_id}")
    assert r.status_code == 404
