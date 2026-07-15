"""
Phase 4 — API endpoint tests for /api/v1/admin/providers/*.

Tests the provider CRUD admin endpoints using the test_client fixture
which overrides auth and DB session.
"""
import pytest
from httpx import AsyncClient

# The SAME singleton the endpoints use: backend.app.api.v1.endpoints.providers
# imports `provider_manager as provider_registry` (migration alias). The old
# `backend.app.registry.provider_registry` singleton is a different object —
# seeding/monkeypatching it never reaches the endpoint under test.
from backend.app.providers.manager import provider_manager as provider_registry


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


async def test_provider_status_endpoint_is_zero_io_and_reads_warmup_cache(
    test_client: AsyncClient,
):
    """The /status endpoint's CURRENT contract (P0.5, superseding the old
    bounded-fan-out design this test used to pin): the handler does NO
    outbound work at all — it merges in-memory breaker state with the
    background warmup cache and returns. A hung provider host therefore
    cannot slow the response by construction (there is no probe to hang);
    warmup-observed-healthy providers report ready, never-observed ones
    report unknown."""
    import time

    create_resp_a = await test_client.post(
        "/api/v1/admin/providers", json=_provider_payload("Warm-A"),
    )
    create_resp_b = await test_client.post(
        "/api/v1/admin/providers", json=_provider_payload("Never-Observed-B"),
    )
    create_resp_c = await test_client.post(
        "/api/v1/admin/providers", json=_provider_payload("Warm-C"),
    )
    id_a = create_resp_a.json()["id"]
    id_b = create_resp_b.json()["id"]
    id_c = create_resp_c.json()["id"]

    now = time.time()
    provider_registry.warmup_cache[id_a] = {"ok": True, "checked_at": now}
    provider_registry.warmup_cache[id_c] = {"ok": True, "checked_at": now}

    try:
        t0 = time.monotonic()
        resp = await test_client.get("/api/v1/admin/providers/status")
        elapsed = time.monotonic() - t0
    finally:
        provider_registry.warmup_cache.pop(id_a, None)
        provider_registry.warmup_cache.pop(id_c, None)

    assert resp.status_code == 200
    body = resp.json()
    by_id = {row["id"]: row for row in body}

    # Zero outbound work → the response is effectively instant.
    assert elapsed < 3.0, f"Response took {elapsed:.2f}s — /status must do no I/O"

    assert by_id[id_a]["status"] == "ready"
    assert by_id[id_c]["status"] == "ready"
    assert by_id[id_b]["status"] == "unknown", by_id[id_b]
    assert by_id[id_a]["lastCheckedAt"] is not None
    assert by_id[id_b]["lastCheckedAt"] is None


async def test_provider_status_endpoint_reports_unavailable_when_circuit_open(
    test_client: AsyncClient,
):
    """When a provider's circuit breaker is open, /status must short-circuit
    to 'unavailable' without probing the downstream. Replaces the previous
    negative-cache test — pybreaker is now the authoritative 'recently
    failed' state."""
    from backend.common.adapters import CircuitBreakerProxy

    create_resp = await test_client.post(
        "/api/v1/admin/providers",
        json=_provider_payload("Circuit Open"),
    )
    provider_id = create_resp.json()["id"]

    class _StubTarget:
        async def close(self) -> None:
            return None

    proxy = CircuitBreakerProxy(_StubTarget(), name=f"{provider_id}:test")
    proxy.breaker.open()
    provider_registry._providers[(provider_id, "")] = proxy  # type: ignore[assignment]

    try:
        resp = await test_client.get("/api/v1/admin/providers/status")
    finally:
        provider_registry._providers.pop((provider_id, ""), None)

    assert resp.status_code == 200
    body = resp.json()
    assert len(body) == 1
    assert body[0]["id"] == provider_id
    assert body[0]["name"] == "Circuit Open"
    assert body[0]["status"] == "unavailable"
    assert body[0]["lastCheckedAt"] is not None
    # resolve_provider_status wording: "Provider circuit: <state>".
    assert "circuit" in body[0]["error"].lower()


async def test_test_connection_checks_unsaved_provider_details_without_persisting(
    test_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
):
    class _HealthyProvider:
        async def get_stats(self):
            return {"node_count": 1}

    created: dict[str, object] = {}

    def _create_provider_instance(provider_type, host, port, asset_name, tls_enabled, creds, extra_config=None):
        created.update({
            "provider_type": provider_type,
            "host": host,
            "port": port,
            "asset_name": asset_name,
            "tls_enabled": tls_enabled,
            "creds": creds,
        })
        return _HealthyProvider()

    monkeypatch.setattr(provider_registry, "_create_provider_instance", _create_provider_instance)

    resp = await test_client.post(
        "/api/v1/admin/providers/test-connection",
        json={
            "name": "Unsaved Provider",
            "providerType": "falkordb",
            "host": "graph.internal",
            "port": 6379,
            "tlsEnabled": True,
            "credentials": {"username": "demo", "password": "secret"},
        },
    )

    assert resp.status_code == 200
    assert resp.json()["success"] is True
    assert resp.json()["latencyMs"] is not None
    # The submitted identity/credentials reach the instance factory. The
    # credentials blob asserts as a SUBSET: ConnectionCredentials grows
    # optional fields (cache_*, sentinel_*, spanner) that default to None.
    creds_seen = created.pop("creds")
    assert created == {
        "provider_type": "falkordb",
        "host": "graph.internal",
        "port": 6379,
        "asset_name": None,
        "tls_enabled": True,
    }
    assert creds_seen["username"] == "demo"
    assert creds_seen["password"] == "secret"
    assert all(v is None for k, v in creds_seen.items()
               if k not in ("username", "password"))

    providers_resp = await test_client.get("/api/v1/admin/providers")
    assert providers_resp.status_code == 200
    assert providers_resp.json() == []


async def test_test_connection_returns_failure_payload_for_unreachable_provider(
    test_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
):
    class _BrokenProvider:
        async def get_stats(self):
            raise OSError("connection refused")

    monkeypatch.setattr(
        provider_registry,
        "_create_provider_instance",
        lambda *args, **kwargs: _BrokenProvider(),
    )

    resp = await test_client.post(
        "/api/v1/admin/providers/test-connection",
        json={
            "name": "Unreachable Provider",
            "providerType": "falkordb",
            "host": "graph.internal",
            "port": 6379,
            "tlsEnabled": False,
        },
    )

    assert resp.status_code == 200
    assert resp.json() == {
        "success": False,
        "latencyMs": None,
        "error": "connection refused",
        "providerVersion": None,
    }
