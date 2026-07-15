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


# ── Authoring guard: case-insensitive-unique type ids (create / update / import) ──

async def test_create_ontology_rejects_case_insensitive_dup_type_ids(test_client: AsyncClient):
    payload = _ontology_payload("Dup Rel", relationshipTypeDefinitions={
        "HAS": {"label": "Has"}, "has": {"label": "has"}})
    resp = await test_client.post("/api/v1/admin/ontologies", json=payload)
    assert resp.status_code == 422
    assert "case" in resp.json()["detail"].lower()


async def test_update_ontology_rejects_case_insensitive_dup_type_ids(test_client: AsyncClient):
    ont = await _create_ontology(test_client, "Guarded Update")
    resp = await test_client.put(
        f"/api/v1/admin/ontologies/{ont['id']}",
        json={"entityTypeDefinitions": {"Table": {"label": "Table"}, "table": {"label": "t"}}})
    assert resp.status_code == 422
    assert "case" in resp.json()["detail"].lower()


async def test_import_ontology_rejects_case_insensitive_dup_type_ids(test_client: AsyncClient):
    # The authoring guard must also cover the import routes (exported JSON is untrusted).
    payload = _ontology_payload("Imp Dup", entityTypeDefinitions={
        "Table": {"label": "Table"}, "table": {"label": "table"}})
    resp = await test_client.post("/api/v1/admin/ontologies/import", json=payload)
    assert resp.status_code == 422
    assert "case" in resp.json()["detail"].lower()


def test_reconcile_relationship_endpoints_strips_undeclared_types():
    """Authoring invariant: a relationship's endpoint types are reconciled to the ontology's
    declared entity types — undeclared refs dropped, partial overlap kept as a subset, an
    all-undeclared constraint cleared to unrestricted."""
    from types import SimpleNamespace
    from backend.app.api.v1.endpoints.ontologies import _reconcile_relationship_endpoints
    req = SimpleNamespace(
        entity_type_definitions={"attribute": {}, "object": {}, "layer": {}},
        relationship_type_definitions={
            "FLOWS_TO": {"source_types": ["dataset", "dataJob"], "target_types": ["column"]},
            "LINKS": {"source_types": ["attribute", "dataset"], "target_types": ["object"]},
            "OPEN": {"source_types": [], "target_types": []},
        },
    )
    _reconcile_relationship_endpoints(req)
    r = req.relationship_type_definitions
    assert r["FLOWS_TO"]["source_types"] == [] and r["FLOWS_TO"]["target_types"] == []
    assert r["LINKS"]["source_types"] == ["attribute"] and r["LINKS"]["target_types"] == ["object"]
    assert r["OPEN"]["source_types"] == []


def test_reconcile_relationship_endpoints_skips_partial_update_without_entity_types():
    """A relationships-only partial update (no entity types in the request) is left untouched —
    the read-time resolver filter still covers it."""
    from types import SimpleNamespace
    from backend.app.api.v1.endpoints.ontologies import _reconcile_relationship_endpoints
    req = SimpleNamespace(entity_type_definitions=None,
                          relationship_type_definitions={"FLOWS_TO": {"source_types": ["dataset"]}})
    _reconcile_relationship_endpoints(req)
    assert req.relationship_type_definitions["FLOWS_TO"]["source_types"] == ["dataset"]


# ── Publish impact gate (unforced path) ───────────────────────────────

async def test_unforced_publish_blocked_on_breaking_change(test_client: AsyncClient):
    """Without ?force=true, publishing a draft that removes types still present
    in the previous published version is blocked with 409 (policy=reject).
    Regression guard: every other publish test forces, leaving this path untested."""
    created = await _create_ontology(test_client, "Impact Gate Test")
    ont_id = created["id"]

    r = await test_client.post(f"/api/v1/admin/ontologies/{ont_id}/publish?force=true")
    assert r.status_code == 200

    # New version that drops an entity type present in v1
    r = await test_client.post(f"/api/v1/admin/ontologies/{ont_id}/new-version")
    assert r.status_code in (200, 201)
    draft = r.json()
    entity_defs = dict(draft["entityTypeDefinitions"])
    removed = next(iter(entity_defs))
    del entity_defs[removed]
    r = await test_client.put(
        f"/api/v1/admin/ontologies/{draft['id']}",
        json={"entityTypeDefinitions": entity_defs},
    )
    assert r.status_code == 200

    # Impact preview says blocked, with the removed type listed
    r = await test_client.get(f"/api/v1/admin/ontologies/{draft['id']}/impact")
    assert r.status_code == 200
    impact = r.json()
    assert impact["allowed"] is False
    assert removed in impact["removedEntityTypes"]
    assert impact["evolutionPolicy"] == "reject"

    # Unforced publish → 409; forced publish → 200
    r = await test_client.post(f"/api/v1/admin/ontologies/{draft['id']}/publish")
    assert r.status_code == 409

    r = await test_client.post(f"/api/v1/admin/ontologies/{draft['id']}/publish?force=true")
    assert r.status_code == 200
    assert r.json()["isPublished"] is True


async def test_first_publish_impact_includes_policy(test_client: AsyncClient):
    """First publish has no previous version — impact must still carry the
    evolution policy (the publish dialog renders it)."""
    created = await _create_ontology(test_client, "First Publish Impact")
    r = await test_client.get(f"/api/v1/admin/ontologies/{created['id']}/impact")
    assert r.status_code == 200
    impact = r.json()
    assert impact["allowed"] is True
    assert impact["evolutionPolicy"] == "reject"
