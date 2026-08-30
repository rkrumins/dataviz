"""
POST /api/v1/admin/providers/discover-schema (unsaved payload) and the
SCHEMA_DISCOVERY capability gate on POST /{provider_id}/discover-schema.

D8: the onboarding wizard used to create a throwaway provider row,
discover its schema, then delete the row -- a write to satisfy a read.
The unsaved endpoint probes the submitted payload directly instead.
"""
from httpx import AsyncClient

from backend.app.db.repositories import provider_repo
from backend.app.providers.manager import provider_manager as provider_registry


class _FakeSchemaProvider:
    def __init__(self):
        self.closed = False

    async def discover_schema(self):
        return {"tables": ["orders", "customers"]}

    async def close(self):
        self.closed = True


class _FakeProviderRow:
    """Stand-in for the ProviderORM row the capability gate reads.

    The saved-row tests below mock provider_repo.get_provider_orm /
    get_credentials rather than create a real row and let
    with_short_session() run for real: that helper (like the pre-existing
    _load_provider_for_outbound it sits beside) reaches straight into
    backend.app.db.engine's role-based, process-cached engine, bypassing
    the get_db_session override test_client installs -- the same class of
    helper test_health_providers_resilience.py mocks for
    get_provider_probe_session rather than exercising for real.
    """

    def __init__(self, provider_type: str):
        self.provider_type = provider_type
        self.host = "localhost"
        self.port = 6379
        self.tls_enabled = False
        self.extra_config = None


# ── POST /discover-schema (unsaved) ─────────────────────────────────────

async def test_discover_schema_unsaved_never_creates_or_deletes_a_row(
    test_client: AsyncClient, monkeypatch,
):
    seen: dict[str, object] = {}
    fake = _FakeSchemaProvider()

    def _create_provider_instance(provider_type, host, port, asset_name, tls_enabled, creds, extra_config=None):
        seen.update({
            "provider_type": provider_type,
            "host": host,
            "port": port,
            "asset_name": asset_name,
            "tls_enabled": tls_enabled,
        })
        return fake

    monkeypatch.setattr(provider_registry, "_create_provider_instance", _create_provider_instance)

    resp = await test_client.post(
        "/api/v1/admin/providers/discover-schema",
        json={
            "provider": {
                "name": "Unsaved Neo4j",
                "providerType": "neo4j",
                "host": "graph.internal",
                "port": 7687,
                "tlsEnabled": False,
            },
            "assetName": "neo4j",
        },
    )
    assert resp.status_code == 200
    assert resp.json() == {"tables": ["orders", "customers"]}
    assert seen["provider_type"] == "neo4j"
    assert seen["host"] == "graph.internal"
    assert seen["asset_name"] == "neo4j"
    assert fake.closed is True

    # Nothing persisted -- the whole point of this endpoint over the old
    # create-discover-delete dance.
    providers_resp = await test_client.get("/api/v1/admin/providers")
    assert providers_resp.status_code == 200
    assert providers_resp.json() == []


async def test_discover_schema_unsaved_rejects_unsupported_type(test_client: AsyncClient):
    """FalkorDB has no SCHEMA_DISCOVERY feature -- 422 before any instance
    is even built."""
    resp = await test_client.post(
        "/api/v1/admin/providers/discover-schema",
        json={"provider": {
            "name": "x", "providerType": "falkordb", "host": "h", "port": 6379,
        }},
    )
    assert resp.status_code == 422
    assert resp.json()["detail"]["type"] == "provider_unsupported"


async def test_discover_schema_unsaved_validates_before_the_capability_check(
    test_client: AsyncClient,
):
    """A structurally invalid payload (DataHub requires a non-empty host)
    is rejected as provider_config_invalid -- validation runs before the
    SCHEMA_DISCOVERY capability check, not after."""
    resp = await test_client.post(
        "/api/v1/admin/providers/discover-schema",
        json={"provider": {"name": "x", "providerType": "datahub", "host": ""}},
    )
    assert resp.status_code == 422
    assert resp.json()["detail"]["type"] == "provider_config_invalid"


# ── POST /{provider_id}/discover-schema — capability gate ───────────────

async def test_saved_row_discover_schema_gates_on_schema_discovery_capability(
    test_client: AsyncClient, monkeypatch,
):
    """FalkorDB's discover_schema() is the base no-op ({}) today -- the
    capability gate now rejects it up front with 422 instead of silently
    returning an empty schema."""
    async def _fake_get_provider_orm(session, provider_id):
        return _FakeProviderRow("falkordb")

    monkeypatch.setattr(provider_repo, "get_provider_orm", _fake_get_provider_orm)

    resp = await test_client.post("/api/v1/admin/providers/prov_fake/discover-schema", json={})
    assert resp.status_code == 422
    assert resp.json()["detail"]["type"] == "provider_unsupported"


async def test_saved_row_discover_schema_passes_through_for_neo4j(
    test_client: AsyncClient, monkeypatch,
):
    async def _fake_get_provider_orm(session, provider_id):
        return _FakeProviderRow("neo4j")

    async def _fake_get_credentials(session, provider_id):
        return {}

    fake = _FakeSchemaProvider()
    monkeypatch.setattr(provider_repo, "get_provider_orm", _fake_get_provider_orm)
    monkeypatch.setattr(provider_repo, "get_credentials", _fake_get_credentials)
    monkeypatch.setattr(provider_registry, "_create_provider_instance", lambda *a, **kw: fake)

    resp = await test_client.post("/api/v1/admin/providers/prov_fake/discover-schema", json={})
    assert resp.status_code == 200
    assert resp.json() == {"tables": ["orders", "customers"]}


async def test_saved_row_discover_schema_404s_for_missing_provider(
    test_client: AsyncClient, monkeypatch,
):
    async def _fake_get_provider_orm(session, provider_id):
        return None

    monkeypatch.setattr(provider_repo, "get_provider_orm", _fake_get_provider_orm)

    resp = await test_client.post("/api/v1/admin/providers/prov_ghost/discover-schema", json={})
    assert resp.status_code == 404
