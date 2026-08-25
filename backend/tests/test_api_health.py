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


# ── /health/ready: revocation must be shared ────────────────────────
#
# ``get_revocation_service`` catches broadly and installs an in-process
# backend when Redis cannot be reached, whose own docstring says not to
# use it in production. With 4 gunicorn workers per container across N
# replicas that turns every revocation into a no-op for 4N-1 of them:
# the admin UI shows a session killed and the browser keeps working. It
# logged at ERROR and nothing failed readiness, so the misconfiguration
# was invisible. Readiness is the right place to surface it — a pod that
# cannot revoke should not take traffic.
#
# Only decisive in prod: a dev stack has one worker, so the in-process
# backend is genuinely equivalent there and failing readiness would just
# stop ./dev.sh working.

@pytest.mark.asyncio
async def test_ready_reports_the_revocation_backend(test_client, monkeypatch):
    import backend.app.main as main_module

    monkeypatch.setattr(
        "backend.app.db.engine.get_engine", lambda: _HealthyEngine()
    )
    # Readiness refuses on a stale schema before it looks at anything
    # else, and the test DB is not migrated. Satisfy that gate so these
    # assertions are about the revocation one.
    monkeypatch.setattr(
        "backend.app.db.engine.get_schema_state",
        lambda: {"at_head": True, "applied": "head", "expected": "head"},
    )
    monkeypatch.setattr(main_module, "_is_production", lambda: False)
    resp = await test_client.get("/api/v1/health/ready")
    assert resp.status_code == 200
    assert resp.json()["revocation"] in ("shared", "in_process")


@pytest.mark.asyncio
async def test_production_is_not_ready_without_a_shared_revocation_store(
    test_client, monkeypatch,
):
    import backend.app.main as main_module
    import backend.app.services.revocation_service as revocation_service

    monkeypatch.setattr(
        "backend.app.db.engine.get_engine", lambda: _HealthyEngine()
    )
    # Readiness refuses on a stale schema before it looks at anything
    # else, and the test DB is not migrated. Satisfy that gate so these
    # assertions are about the revocation one.
    monkeypatch.setattr(
        "backend.app.db.engine.get_schema_state",
        lambda: {"at_head": True, "applied": "head", "expected": "head"},
    )
    monkeypatch.setattr(main_module, "_is_production", lambda: True)
    monkeypatch.setattr(revocation_service, "revocation_is_shared", lambda: False)

    resp = await test_client.get("/api/v1/health/ready")
    assert resp.status_code == 503
    body = resp.json()
    assert body["status"] == "not_ready"
    assert body["revocation"] == "in_process"
    assert "revoked session" in body["reason"]


@pytest.mark.asyncio
async def test_production_is_ready_with_a_shared_revocation_store(
    test_client, monkeypatch,
):
    import backend.app.main as main_module
    import backend.app.services.revocation_service as revocation_service

    monkeypatch.setattr(
        "backend.app.db.engine.get_engine", lambda: _HealthyEngine()
    )
    # Readiness refuses on a stale schema before it looks at anything
    # else, and the test DB is not migrated. Satisfy that gate so these
    # assertions are about the revocation one.
    monkeypatch.setattr(
        "backend.app.db.engine.get_schema_state",
        lambda: {"at_head": True, "applied": "head", "expected": "head"},
    )
    monkeypatch.setattr(main_module, "_is_production", lambda: True)
    monkeypatch.setattr(revocation_service, "revocation_is_shared", lambda: True)

    resp = await test_client.get("/api/v1/health/ready")
    assert resp.status_code == 200
    assert resp.json()["revocation"] == "shared"


@pytest.mark.asyncio
async def test_a_dev_stack_stays_ready_without_one(test_client, monkeypatch):
    """One worker means the in-process backend really is equivalent, and
    failing readiness here would just stop ./dev.sh working."""
    import backend.app.main as main_module
    import backend.app.services.revocation_service as revocation_service

    monkeypatch.setattr(
        "backend.app.db.engine.get_engine", lambda: _HealthyEngine()
    )
    # Readiness refuses on a stale schema before it looks at anything
    # else, and the test DB is not migrated. Satisfy that gate so these
    # assertions are about the revocation one.
    monkeypatch.setattr(
        "backend.app.db.engine.get_schema_state",
        lambda: {"at_head": True, "applied": "head", "expected": "head"},
    )
    monkeypatch.setattr(main_module, "_is_production", lambda: False)
    monkeypatch.setattr(revocation_service, "revocation_is_shared", lambda: False)

    resp = await test_client.get("/api/v1/health/ready")
    assert resp.status_code == 200
    assert resp.json()["revocation"] == "in_process"
