"""
Phase 4 — API endpoint tests for /api/v1/admin/ontologies/*.

Tests the ontology definition CRUD and publish endpoints using the
test_client fixture with auth and DB overrides.
"""
import pytest
from httpx import AsyncClient


# ── Helper ────────────────────────────────────────────────────────────

def _ontology_payload(name: str = "Test Ontology", **overrides) -> dict:
    base = {
        "name": name,
        "description": "An ontology for testing",
        "version": 1,
        "scope": "universal",
        "containmentEdgeTypes": ["CONTAINS"],
        "lineageEdgeTypes": ["LINEAGE"],
        "edgeTypeMetadata": {},
        "entityTypeHierarchy": {},
        "rootEntityTypes": ["Database"],
        "entityTypeDefinitions": {
            "Database": {"label": "Database", "icon": "database"},
            "Table": {"label": "Table", "icon": "table"},
        },
        "relationshipTypeDefinitions": {
            "CONTAINS": {"label": "Contains"},
            "LINEAGE": {"label": "Lineage"},
        },
    }
    base.update(overrides)
    return base


async def _create_ontology(client: AsyncClient, name: str = "Test Ontology") -> dict:
    """Create an ontology and return its JSON body."""
    resp = await client.post(
        "/api/v1/admin/ontologies",
        json=_ontology_payload(name),
    )
    assert resp.status_code == 201
    return resp.json()


# ── GET /admin/ontologies ─────────────────────────────────────────────

async def test_list_ontologies_empty(test_client: AsyncClient):
    """Initially the ontology list is empty."""
    resp = await test_client.get("/api/v1/admin/ontologies")
    assert resp.status_code == 200
    assert resp.json() == []


# ── POST /admin/ontologies ────────────────────────────────────────────

async def test_create_ontology(test_client: AsyncClient):
    """Create an ontology returns 201 with the created resource."""
    body = await _create_ontology(test_client, "Create Test")
    assert body["name"] == "Create Test"
    assert "id" in body
    assert body.get("isPublished") is False


async def test_create_ontology_minimal(test_client: AsyncClient):
    """Create with only the required name field."""
    resp = await test_client.post(
        "/api/v1/admin/ontologies",
        json={"name": "Minimal Ontology"},
    )
    assert resp.status_code == 201


# ── GET /admin/ontologies/{id} ────────────────────────────────────────

async def test_get_ontology(test_client: AsyncClient):
    """Fetch a created ontology by ID."""
    created = await _create_ontology(test_client, "Fetch Test")
    ont_id = created["id"]

    resp = await test_client.get(f"/api/v1/admin/ontologies/{ont_id}")
    assert resp.status_code == 200
    assert resp.json()["id"] == ont_id


async def test_get_ontology_not_found(test_client: AsyncClient):
    """Fetching a non-existent ontology returns 404."""
    resp = await test_client.get("/api/v1/admin/ontologies/ont_ghost")
    assert resp.status_code == 404


# ── PUT /admin/ontologies/{id} ────────────────────────────────────────

async def test_update_ontology_name(test_client: AsyncClient):
    """Update the name of an ontology."""
    created = await _create_ontology(test_client, "Old Name")
    ont_id = created["id"]

    resp = await test_client.put(
        f"/api/v1/admin/ontologies/{ont_id}",
        json={"name": "New Name"},
    )
    assert resp.status_code == 200
    assert resp.json()["name"] == "New Name"


async def test_update_ontology_not_found(test_client: AsyncClient):
    """Updating a non-existent ontology returns 404."""
    resp = await test_client.put(
        "/api/v1/admin/ontologies/ont_nope",
        json={"name": "Nope"},
    )
    assert resp.status_code == 404


async def test_update_ontology_definitions(test_client: AsyncClient):
    """Update entity and relationship type definitions."""
    created = await _create_ontology(test_client, "Defs Update")
    ont_id = created["id"]

    resp = await test_client.put(
        f"/api/v1/admin/ontologies/{ont_id}",
        json={
            "entityTypeDefinitions": {
                "Database": {"label": "Database", "icon": "db"},
                "Schema": {"label": "Schema", "icon": "schema"},
            },
        },
    )
    assert resp.status_code == 200


# ── POST /admin/ontologies/{id}/publish ───────────────────────────────

async def test_publish_ontology(test_client: AsyncClient):
    """Publishing an unpublished ontology returns 200 with isPublished=True."""
    created = await _create_ontology(test_client, "Publish Test")
    ont_id = created["id"]

    resp = await test_client.post(f"/api/v1/admin/ontologies/{ont_id}/publish?force=true")
    assert resp.status_code == 200
    assert resp.json()["isPublished"] is True


async def test_publish_ontology_not_found(test_client: AsyncClient):
    """Publishing a non-existent ontology returns 404."""
    resp = await test_client.post("/api/v1/admin/ontologies/ont_ghost/publish?force=true")
    assert resp.status_code == 404


# ── DELETE /admin/ontologies/{id} ─────────────────────────────────────

async def test_delete_ontology(test_client: AsyncClient):
    """Delete an ontology returns 204 (soft-delete)."""
    created = await _create_ontology(test_client, "Delete Me")
    ont_id = created["id"]

    del_resp = await test_client.delete(f"/api/v1/admin/ontologies/{ont_id}")
    assert del_resp.status_code == 204

    # Soft-deleted ontologies are still accessible via GET (they have deleted_at set)
    get_resp = await test_client.get(f"/api/v1/admin/ontologies/{ont_id}")
    assert get_resp.status_code == 200


async def test_delete_ontology_not_found(test_client: AsyncClient):
    """Deleting a non-existent ontology returns 404."""
    resp = await test_client.delete("/api/v1/admin/ontologies/ont_nope")
    assert resp.status_code == 404


# ── Lifecycle round-trip ──────────────────────────────────────────────

async def test_ontology_crud_roundtrip(test_client: AsyncClient):
    """Full create -> read -> update -> publish -> list -> delete cycle."""
    # Create
    created = await _create_ontology(test_client, "Roundtrip")
    ont_id = created["id"]

    # Read
    r = await test_client.get(f"/api/v1/admin/ontologies/{ont_id}")
    assert r.status_code == 200
    assert r.json()["name"] == "Roundtrip"

    # Update
    r = await test_client.put(
        f"/api/v1/admin/ontologies/{ont_id}",
        json={"name": "Roundtrip Updated", "description": "Updated desc"},
    )
    assert r.status_code == 200
    assert r.json()["name"] == "Roundtrip Updated"

    # List should include it
    r = await test_client.get("/api/v1/admin/ontologies")
    assert r.status_code == 200
    ids = [o["id"] for o in r.json()]
    assert ont_id in ids

    # Publish (force=true to bypass impact check)
    r = await test_client.post(f"/api/v1/admin/ontologies/{ont_id}/publish?force=true")
    assert r.status_code == 200
    assert r.json()["isPublished"] is True

    # Delete (published ontologies may still be deletable if no data sources reference them)
    r = await test_client.delete(f"/api/v1/admin/ontologies/{ont_id}")
    assert r.status_code == 204


# ── Clone ─────────────────────────────────────────────────────────────

async def test_clone_ontology(test_client: AsyncClient):
    """Cloning an ontology creates a new draft copy."""
    created = await _create_ontology(test_client, "Original")
    ont_id = created["id"]

    resp = await test_client.post(f"/api/v1/admin/ontologies/{ont_id}/clone")
    assert resp.status_code == 201
    clone = resp.json()
    assert clone["id"] != ont_id
    assert "copy" in clone["name"].lower()
    assert clone.get("isPublished") is False


# ── Validate ──────────────────────────────────────────────────────────

async def test_validate_ontology(test_client: AsyncClient):
    """Validate returns a validation response with isValid and issues."""
    created = await _create_ontology(test_client, "Validate Test")
    ont_id = created["id"]

    resp = await test_client.post(f"/api/v1/admin/ontologies/{ont_id}/validate")
    assert resp.status_code == 200
    body = resp.json()
    assert "isValid" in body
    assert "issues" in body
