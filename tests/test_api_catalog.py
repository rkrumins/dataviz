"""
API endpoint tests for /api/v1/admin/catalog/*.

Tests the catalog item CRUD, bindings, cleanup, impact and force-delete
endpoints using the test_client fixture which overrides auth and DB session.
"""
from httpx import AsyncClient


# ── Helpers ────────────────────────────────────────────────────────────

async def _create_provider(client: AsyncClient, name: str = "Cat Provider") -> str:
    """Create a provider and return its ID (catalog items require a provider_id)."""
    resp = await client.post(
        "/api/v1/admin/providers",
        json={"name": name, "providerType": "falkordb"},
    )
    assert resp.status_code == 201
    return resp.json()["id"]


def _catalog_payload(provider_id: str, name: str = "Test Item", **overrides) -> dict:
    base = {
        "providerId": provider_id,
        "name": name,
        "sourceIdentifier": "test_graph",
    }
    base.update(overrides)
    return base


async def _create_catalog_item(client: AsyncClient, provider_id: str, name: str = "Test Item", **kw) -> dict:
    resp = await client.post(
        "/api/v1/admin/catalog",
        json=_catalog_payload(provider_id, name, **kw),
    )
    assert resp.status_code == 201
    return resp.json()


# ── GET /admin/catalog (empty) ────────────────────────────────────────

async def test_list_catalog_items_empty(test_client: AsyncClient):
    """Initially the catalog item list is empty."""
    resp = await test_client.get("/api/v1/admin/catalog")
    assert resp.status_code == 200
    assert resp.json() == []


# ── POST /admin/catalog ──────────────────────────────────────────────

async def test_create_catalog_item(test_client: AsyncClient):
    """Create a catalog item returns 201."""
    prov_id = await _create_provider(test_client)
    body = await _create_catalog_item(test_client, prov_id, "My Item")
    assert body["name"] == "My Item"
    assert "id" in body
    assert body["providerId"] == prov_id
    assert body["sourceIdentifier"] == "test_graph"


async def test_create_catalog_item_with_description(test_client: AsyncClient):
    """Create catalog item with optional description."""
    prov_id = await _create_provider(test_client)
    body = await _create_catalog_item(
        test_client, prov_id, "Described Item",
        description="A test catalog item",
    )
    assert body["description"] == "A test catalog item"


async def test_create_catalog_item_provider_not_found(test_client: AsyncClient):
    """Creating a catalog item with non-existent provider returns 404."""
    resp = await test_client.post(
        "/api/v1/admin/catalog",
        json=_catalog_payload("prov_nonexistent", "Orphan"),
    )
    assert resp.status_code == 404


async def test_create_catalog_item_missing_name(test_client: AsyncClient):
    """Creating a catalog item without name fails with 422."""
    prov_id = await _create_provider(test_client)
    resp = await test_client.post(
        "/api/v1/admin/catalog",
        json={"providerId": prov_id},
    )
    assert resp.status_code == 422


# ── GET /admin/catalog/{item_id} ──────────────────────────────────────

async def test_get_catalog_item(test_client: AsyncClient):
    """Fetch a created catalog item by ID."""
    prov_id = await _create_provider(test_client)
    created = await _create_catalog_item(test_client, prov_id, "Fetch Me")
    item_id = created["id"]

    resp = await test_client.get(f"/api/v1/admin/catalog/{item_id}")
    assert resp.status_code == 200
    assert resp.json()["id"] == item_id
    assert resp.json()["name"] == "Fetch Me"


async def test_get_catalog_item_not_found(test_client: AsyncClient):
    """Fetching a non-existent catalog item returns 404."""
    resp = await test_client.get("/api/v1/admin/catalog/cat_nonexistent")
    assert resp.status_code == 404


# ── PUT /admin/catalog/{item_id} ──────────────────────────────────────

async def test_update_catalog_item(test_client: AsyncClient):
    """Update catalog item name."""
    prov_id = await _create_provider(test_client)
    created = await _create_catalog_item(test_client, prov_id, "Old Name")
    item_id = created["id"]

    resp = await test_client.put(
        f"/api/v1/admin/catalog/{item_id}",
        json={"name": "New Name", "description": "Updated"},
    )
    assert resp.status_code == 200
    assert resp.json()["name"] == "New Name"
    assert resp.json()["description"] == "Updated"


async def test_update_catalog_item_not_found(test_client: AsyncClient):
    """Updating a non-existent catalog item returns 404."""
    resp = await test_client.put(
        "/api/v1/admin/catalog/cat_ghost",
        json={"name": "Ghost"},
    )
    assert resp.status_code == 404


# ── DELETE /admin/catalog/{item_id} ───────────────────────────────────

async def test_delete_catalog_item(test_client: AsyncClient):
    """Delete a catalog item returns 204, then GET returns 404."""
    prov_id = await _create_provider(test_client)
    created = await _create_catalog_item(test_client, prov_id, "Delete Me")
    item_id = created["id"]

    resp = await test_client.delete(f"/api/v1/admin/catalog/{item_id}")
    assert resp.status_code == 204

    resp = await test_client.get(f"/api/v1/admin/catalog/{item_id}")
    assert resp.status_code == 404


async def test_delete_catalog_item_not_found(test_client: AsyncClient):
    """Deleting a non-existent catalog item returns 404."""
    resp = await test_client.delete("/api/v1/admin/catalog/cat_nope")
    assert resp.status_code == 404


async def test_delete_catalog_item_force(test_client: AsyncClient):
    """Force-deleting a catalog item returns 204."""
    prov_id = await _create_provider(test_client)
    created = await _create_catalog_item(test_client, prov_id, "Force Delete")
    item_id = created["id"]

    resp = await test_client.delete(f"/api/v1/admin/catalog/{item_id}?force=true")
    assert resp.status_code == 204


# ── GET /admin/catalog?providerId=... (filter) ────────────────────────

async def test_list_catalog_items_filter_by_provider(test_client: AsyncClient):
    """List catalog items filtered by providerId."""
    prov_id = await _create_provider(test_client)
    await _create_catalog_item(test_client, prov_id, "Filtered Item")

    resp = await test_client.get(f"/api/v1/admin/catalog?providerId={prov_id}")
    assert resp.status_code == 200
    items = resp.json()
    assert len(items) >= 1
    assert all(i["providerId"] == prov_id for i in items)


# ── GET /admin/catalog/bindings ───────────────────────────────────────

async def test_list_catalog_bindings_empty(test_client: AsyncClient):
    """Bindings list is initially empty."""
    resp = await test_client.get("/api/v1/admin/catalog/bindings")
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)


async def test_list_catalog_bindings_with_items(test_client: AsyncClient):
    """Bindings includes created catalog items (unbound)."""
    prov_id = await _create_provider(test_client)
    created = await _create_catalog_item(test_client, prov_id, "Binding Item")

    resp = await test_client.get("/api/v1/admin/catalog/bindings")
    assert resp.status_code == 200
    bindings = resp.json()
    ids = [b["id"] for b in bindings]
    assert created["id"] in ids
    # Unbound item should have null workspace
    binding = next(b for b in bindings if b["id"] == created["id"])
    assert binding["boundWorkspaceId"] is None


async def test_list_catalog_bindings_filter_by_provider(test_client: AsyncClient):
    """Bindings can be filtered by providerId."""
    prov_id = await _create_provider(test_client)
    await _create_catalog_item(test_client, prov_id, "Filtered Binding")

    resp = await test_client.get(f"/api/v1/admin/catalog/bindings?providerId={prov_id}")
    assert resp.status_code == 200
    bindings = resp.json()
    assert all(b["providerId"] == prov_id for b in bindings)


# ── POST /admin/catalog/cleanup ───────────────────────────────────────

async def test_cleanup_duplicates(test_client: AsyncClient):
    """Cleanup returns count of deleted duplicates."""
    resp = await test_client.post("/api/v1/admin/catalog/cleanup")
    assert resp.status_code == 200
    body = resp.json()
    assert "deleted" in body
    assert isinstance(body["deleted"], int)


# ── GET /admin/catalog/{item_id}/impact ───────────────────────────────

async def test_get_catalog_item_impact(test_client: AsyncClient):
    """Impact endpoint returns blast-radius report."""
    prov_id = await _create_provider(test_client)
    created = await _create_catalog_item(test_client, prov_id, "Impact Item")
    item_id = created["id"]

    resp = await test_client.get(f"/api/v1/admin/catalog/{item_id}/impact")
    assert resp.status_code == 200
    body = resp.json()
    assert "catalogItems" in body or "workspaces" in body or "views" in body


async def test_get_catalog_item_impact_not_found(test_client: AsyncClient):
    """Impact for non-existent item returns 404."""
    resp = await test_client.get("/api/v1/admin/catalog/cat_nope/impact")
    assert resp.status_code == 404


# ── Full CRUD round-trip ──────────────────────────────────────────────

async def test_catalog_item_crud_roundtrip(test_client: AsyncClient):
    """Full create -> read -> update -> list -> delete cycle."""
    prov_id = await _create_provider(test_client)

    # Create
    created = await _create_catalog_item(test_client, prov_id, "Roundtrip")
    item_id = created["id"]

    # Read
    r = await test_client.get(f"/api/v1/admin/catalog/{item_id}")
    assert r.status_code == 200

    # Update
    r = await test_client.put(
        f"/api/v1/admin/catalog/{item_id}",
        json={"name": "Roundtrip Updated"},
    )
    assert r.status_code == 200
    assert r.json()["name"] == "Roundtrip Updated"

    # List
    r = await test_client.get("/api/v1/admin/catalog")
    assert r.status_code == 200
    ids = [i["id"] for i in r.json()]
    assert item_id in ids

    # Delete
    r = await test_client.delete(f"/api/v1/admin/catalog/{item_id}")
    assert r.status_code == 204

    # Gone
    r = await test_client.get(f"/api/v1/admin/catalog/{item_id}")
    assert r.status_code == 404
