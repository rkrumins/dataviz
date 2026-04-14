"""
Phase 4 — API endpoint tests for /api/v1/admin/providers/*.

Tests the provider CRUD admin endpoints using the test_client fixture
which overrides auth and DB session.
"""
import time

import pytest
from httpx import AsyncClient

from backend.app.registry.provider_registry import provider_registry


# ── Helper ────────────────────────────────────────────────────────────

def _provider_payload(name: str = "Test Provider", provider_type: str = "falkordb") -> dict:
    return {
        "name": name,
        "providerType": provider_type,
        "host": "localhost",
        "port": 6379,
        "tlsEnabled": False,
    }


# ── GET /admin/providers ──────────────────────────────────────────────

async def test_list_providers_empty(test_client: AsyncClient):
    """Initially the provider list is empty."""
    resp = await test_client.get("/api/v1/admin/providers")
    assert resp.status_code == 200
    assert resp.json() == []


async def test_provider_status_endpoint_returns_empty_list(test_client: AsyncClient):
    resp = await test_client.get("/api/v1/admin/providers/status")

    assert resp.status_code == 200
    assert resp.json() == []


# ── POST /admin/providers ─────────────────────────────────────────────

async def test_create_provider(test_client: AsyncClient):
    """Create a provider returns 201 with the created resource."""
    resp = await test_client.post(
        "/api/v1/admin/providers",
        json=_provider_payload("My FalkorDB"),
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["name"] == "My FalkorDB"
    assert "id" in body


async def test_create_provider_minimal(test_client: AsyncClient):
    """Create with only required fields (name + providerType)."""
    resp = await test_client.post(
        "/api/v1/admin/providers",
        json={"name": "Minimal", "providerType": "falkordb"},
    )
    assert resp.status_code == 201


# ── GET /admin/providers/{id} ─────────────────────────────────────────

async def test_get_provider(test_client: AsyncClient):
    """Fetch a created provider by ID."""
    create_resp = await test_client.post(
        "/api/v1/admin/providers",
        json=_provider_payload("Fetch Test"),
    )
    prov_id = create_resp.json()["id"]

    resp = await test_client.get(f"/api/v1/admin/providers/{prov_id}")
    assert resp.status_code == 200
    assert resp.json()["id"] == prov_id
    assert resp.json()["name"] == "Fetch Test"


async def test_get_provider_not_found(test_client: AsyncClient):
    """Fetching a non-existent provider returns 404."""
    resp = await test_client.get("/api/v1/admin/providers/prov_ghost")
    assert resp.status_code == 404


# ── PUT /admin/providers/{id} ─────────────────────────────────────────

async def test_update_provider(test_client: AsyncClient):
    """Update provider name."""
    create_resp = await test_client.post(
        "/api/v1/admin/providers",
        json=_provider_payload("Before Update"),
    )
    prov_id = create_resp.json()["id"]

    resp = await test_client.put(
        f"/api/v1/admin/providers/{prov_id}",
        json={"name": "After Update"},
    )
    assert resp.status_code == 200
    assert resp.json()["name"] == "After Update"


async def test_update_provider_not_found(test_client: AsyncClient):
    """Updating a non-existent provider returns 404."""
    resp = await test_client.put(
        "/api/v1/admin/providers/prov_nope",
        json={"name": "Nope"},
    )
    assert resp.status_code == 404


# ── DELETE /admin/providers/{id} ──────────────────────────────────────

async def test_delete_provider(test_client: AsyncClient):
    """Delete a provider returns 204, then GET returns 404."""
    create_resp = await test_client.post(
        "/api/v1/admin/providers",
        json=_provider_payload("Delete Me"),
    )
    prov_id = create_resp.json()["id"]

    del_resp = await test_client.delete(f"/api/v1/admin/providers/{prov_id}")
    assert del_resp.status_code == 204

    get_resp = await test_client.get(f"/api/v1/admin/providers/{prov_id}")
    assert get_resp.status_code == 404


async def test_delete_provider_not_found(test_client: AsyncClient):
    """Deleting a non-existent provider returns 404."""
    resp = await test_client.delete("/api/v1/admin/providers/prov_nope")
    assert resp.status_code == 404


# ── Lifecycle round-trip ──────────────────────────────────────────────

async def test_provider_crud_roundtrip(test_client: AsyncClient):
    """Full create -> read -> update -> list -> delete cycle."""
    # Create
    r = await test_client.post(
        "/api/v1/admin/providers",
        json=_provider_payload("Roundtrip"),
    )
    assert r.status_code == 201
    prov_id = r.json()["id"]

    # Read
    r = await test_client.get(f"/api/v1/admin/providers/{prov_id}")
    assert r.status_code == 200

    # Update
    r = await test_client.put(
        f"/api/v1/admin/providers/{prov_id}",
        json={"name": "Roundtrip Updated", "host": "10.0.0.1"},
    )
    assert r.status_code == 200
    assert r.json()["name"] == "Roundtrip Updated"

    # List
    r = await test_client.get("/api/v1/admin/providers")
    assert r.status_code == 200
    ids = [p["id"] for p in r.json()]
    assert prov_id in ids

    # Delete
    r = await test_client.delete(f"/api/v1/admin/providers/{prov_id}")
    assert r.status_code == 204

    # Gone
    r = await test_client.get(f"/api/v1/admin/providers/{prov_id}")
    assert r.status_code == 404


async def test_provider_status_endpoint_uses_negative_cache(test_client: AsyncClient):
    create_resp = await test_client.post(
        "/api/v1/admin/providers",
        json=_provider_payload("Cached Failure"),
    )
    provider_id = create_resp.json()["id"]
    provider_registry._failed_cache[(provider_id, "")] = time.monotonic()

    try:
        resp = await test_client.get("/api/v1/admin/providers/status")
    finally:
        provider_registry._failed_cache.pop((provider_id, ""), None)

    assert resp.status_code == 200
    body = resp.json()
    assert len(body) == 1
    assert body[0]["id"] == provider_id
    assert body[0]["name"] == "Cached Failure"
    assert body[0]["status"] == "unavailable"
    assert body[0]["lastCheckedAt"] is not None
    assert body[0]["error"]
