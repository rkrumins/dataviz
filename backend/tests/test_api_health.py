"""
Health endpoint contract — three-tier split (P0.3).

  /api/v1/health/live  — process liveness, NO I/O. Always 200.
  /api/v1/health       — back-compat alias for /health/live (one-release
                         deprecation).
  /api/v1/health/ready — readiness, single 1s-budgeted DB ping.
  /api/v1/health/deps  — deep dependency report (DB + provider breaker
                         state). NEVER on a probe hot path.

The decoupling rule the prime directive enforces: liveness is independent
of DB and provider state. A DB outage must NOT cause /health/live to
fail; it surfaces via /health/deps and via 5xx on actual DB-backed
endpoints.
"""
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


# ── /health/live (and the /health alias) ───────────────────────────


@pytest.mark.asyncio
async def test_liveness_is_constant_time_and_zero_io(test_client: AsyncClient, monkeypatch):
    """Liveness must NOT call get_engine() — it has zero I/O.

    We assert this by setting get_engine to raise; if the endpoint
    invoked it we would see the exception bubble through.
    """
    def _boom():
        raise AssertionError("liveness must not call get_engine()")

    monkeypatch.setattr("backend.app.db.engine.get_engine", _boom)

    resp = await test_client.get("/api/v1/health/live")
    assert resp.status_code == 200
    assert resp.json() == {"status": "live", "version": "0.2.0"}


@pytest.mark.asyncio
async def test_health_alias_returns_liveness(test_client: AsyncClient, monkeypatch):
    """The /health back-compat alias returns the same liveness shape."""
    def _boom():
        raise AssertionError("/health alias must not call get_engine()")

    monkeypatch.setattr("backend.app.db.engine.get_engine", _boom)

    resp = await test_client.get("/api/v1/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "live", "version": "0.2.0"}


@pytest.mark.asyncio
async def test_liveness_unaffected_by_db_failure(test_client: AsyncClient, monkeypatch):
    """The whole point of the split: DB down must NOT break liveness."""
    monkeypatch.setattr(
        "backend.app.db.engine.get_engine",
        lambda: _FailingEngine(),
    )

    resp = await test_client.get("/api/v1/health/live")
    assert resp.status_code == 200
    assert resp.json()["status"] == "live"


# ── /health/deps ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_deps_reports_management_db_healthy(test_client: AsyncClient, monkeypatch):
    monkeypatch.setattr(
        "backend.app.db.engine.get_engine",
        lambda: _HealthyEngine(),
    )

    resp = await test_client.get("/api/v1/health/deps")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "healthy"
    assert body["dependencies"]["management_db"] == "healthy"


@pytest.mark.asyncio
async def test_deps_reports_unhealthy_when_management_db_fails(
    test_client: AsyncClient,
    monkeypatch,
):
    monkeypatch.setattr(
        "backend.app.db.engine.get_engine",
        lambda: _FailingEngine(),
    )

    resp = await test_client.get("/api/v1/health/deps")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "unhealthy"
    assert "management_db" in body["dependencies"]
    assert "unhealthy:" in body["dependencies"]["management_db"]


@pytest.mark.asyncio
async def test_deps_includes_provider_breaker_states(test_client: AsyncClient, monkeypatch):
    """deps reports in-memory breaker state — no provider I/O."""
    monkeypatch.setattr(
        "backend.app.db.engine.get_engine",
        lambda: _HealthyEngine(),
    )

    resp = await test_client.get("/api/v1/health/deps")
    assert resp.status_code == 200
    body = resp.json()
    # ``providers`` is always present; empty dict when nothing instantiated.
    assert "providers" in body
