import pytest
from httpx import AsyncClient


class _HealthyConnection:
    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return None

    async def execute(self, _statement):
        return 1


class _HealthyEngine:
    def connect(self):
        return _HealthyConnection()


class _FailingConnection:
    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return None

    async def execute(self, _statement):
        raise RuntimeError("db down")


class _FailingEngine:
    def connect(self):
        return _FailingConnection()


@pytest.mark.asyncio
async def test_health_reports_only_management_db(test_client: AsyncClient, monkeypatch):
    monkeypatch.setattr(
        "backend.app.db.engine.get_engine",
        lambda: _HealthyEngine(),
    )

    async def _unexpected_primary_lookup(_session):
        raise AssertionError("health endpoint must not resolve a primary provider")

    monkeypatch.setattr(
        "backend.app.main.provider_registry._resolve_primary_id",
        _unexpected_primary_lookup,
        raising=False,
    )

    resp = await test_client.get("/api/v1/health")

    assert resp.status_code == 200
    assert resp.json() == {
        "status": "healthy",
        "version": "0.2.0",
        "dependencies": {"management_db": "healthy"},
    }


@pytest.mark.asyncio
async def test_health_returns_unhealthy_when_management_db_fails(
    test_client: AsyncClient,
    monkeypatch,
):
    monkeypatch.setattr(
        "backend.app.db.engine.get_engine",
        lambda: _FailingEngine(),
    )

    resp = await test_client.get("/api/v1/health")

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "unhealthy"
    assert "management_db" in body["dependencies"]
    assert "unhealthy:" in body["dependencies"]["management_db"]
    assert "primary_provider" not in body["dependencies"]
