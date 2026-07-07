"""HTTP test for the super-admin infrastructure status endpoint.

Drives ``GET /api/v1/admin/system/status`` over in-process ASGI with the
REAL ``requires("system:admin")`` router gate (only the two leaf identity
dependencies are overridden, same harness as ``test_versioning_api``).
Needs the live dev stack (Postgres/Redis/FalkorDB reachable) — skipped
unless ``GRAPHVER_E2E=1``.

Covers the contract that matters operationally:
  * the snapshot is 200 + complete even when a probed service is dead
    (degrade, never 500) and completes within the probe budgets;
  * the ~10s cache is shared (second call reports cacheAgeMs > 0 and
    does not re-assemble);
  * non-admins get 403 from the real gate.
"""
import asyncio
import os
import time
from types import SimpleNamespace

import pytest

pytestmark = pytest.mark.skipif(
    not os.getenv("GRAPHVER_E2E"),
    reason="set GRAPHVER_E2E=1 + a live dev stack to run",
)

_SERVICE_KEYS = {
    "vizService", "managementDb", "graphverDb", "busRedis", "cacheRedis",
    "falkordb", "aggregationControlplane", "aggregationWorker",
    "statsService", "graphService",
}


def _build_app():
    from fastapi import Depends, FastAPI, Request
    import backend.app.auth.dependencies as deps
    from backend.app.auth.dependencies import (
        get_current_user, get_permission_claims, requires,
    )
    from backend.app.services.permission_service import PermissionClaims
    from backend.app.api.v1.endpoints import system_status as SS

    deps.get_revocation_service = lambda: SimpleNamespace(
        is_revoked=lambda sid: False)

    async def fake_user():
        return SimpleNamespace(id="u_test", email="t@example.com")

    async def fake_claims(request: Request):
        perms = tuple(p for p in request.headers.get("x-test-perms", "").split(",") if p)
        return PermissionClaims(sid="", global_perms=perms, ws_perms={})

    app = FastAPI()
    # Same router-level gate as the real registration in api.py.
    app.include_router(
        SS.router, prefix="/api/v1/admin/system",
        dependencies=[Depends(requires("system:admin"))],
    )
    app.dependency_overrides[get_current_user] = fake_user
    app.dependency_overrides[get_permission_claims] = fake_claims
    return app


def _reset_cache():
    from backend.app.services.system_status import service as ss_service
    ss_service._cache = None


def _client(app):
    import httpx
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test")


_ADMIN = {"x-test-perms": "system:admin"}


@pytest.mark.asyncio
async def test_snapshot_envelope_and_all_services():
    app = _build_app()
    _reset_cache()
    async with _client(app) as client:
        resp = await client.get("/api/v1/admin/system/status", headers=_ADMIN)
    assert resp.status_code == 200
    body = resp.json()
    for key in ("status", "generatedAt", "cacheAgeMs", "services", "streams",
                "projection", "aggregationJobs", "statsPolling", "outbox"):
        assert key in body, f"snapshot missing {key!r}"
    assert body["status"] in ("healthy", "degraded", "down")
    tiles = {t["key"]: t for t in body["services"]}
    assert set(tiles) == _SERVICE_KEYS
    for tile in tiles.values():
        assert tile["status"] in ("healthy", "degraded", "down", "unknown")
    # Live dev stack: the datastores this process itself depends on are up.
    for key in ("managementDb", "graphverDb", "busRedis", "falkordb"):
        assert tiles[key]["status"] in ("healthy", "degraded"), tiles[key]


@pytest.mark.asyncio
async def test_dead_service_degrades_without_500(monkeypatch):
    monkeypatch.setenv("STATS_SERVICE_URL", "http://127.0.0.1:59999")
    monkeypatch.setenv("GRAPH_SERVICE_URL", "http://127.0.0.1:59999")
    app = _build_app()
    _reset_cache()
    started = time.monotonic()
    async with _client(app) as client:
        resp = await client.get("/api/v1/admin/system/status", headers=_ADMIN)
    elapsed = time.monotonic() - started
    assert resp.status_code == 200
    # Concurrent probes: wall time ≈ max budget (2s), never the sum.
    assert elapsed < 6, f"snapshot took {elapsed:.1f}s — probes serialized?"
    tiles = {t["key"]: t for t in resp.json()["services"]}
    # statsService may be lifted down→degraded by live stream consumers,
    # but it must not read healthy when its health URL is dead.
    assert tiles["statsService"]["status"] in ("down", "degraded")
    assert tiles["graphService"]["status"] == "down"
    _reset_cache()


@pytest.mark.asyncio
async def test_snapshot_cache_is_shared(monkeypatch):
    from backend.app.services.system_status import service as ss_service

    calls = {"n": 0}
    real_assemble = ss_service._assemble

    async def counting_assemble(app_state):
        calls["n"] += 1
        return await real_assemble(app_state)

    monkeypatch.setattr(ss_service, "_assemble", counting_assemble)
    app = _build_app()
    _reset_cache()
    async with _client(app) as client:
        first = await client.get("/api/v1/admin/system/status", headers=_ADMIN)
        await asyncio.sleep(0.05)
        second = await client.get("/api/v1/admin/system/status", headers=_ADMIN)
    assert first.json()["cacheAgeMs"] == 0
    assert second.json()["cacheAgeMs"] > 0
    assert calls["n"] == 1
    _reset_cache()


@pytest.mark.asyncio
async def test_non_admin_gets_403():
    app = _build_app()
    async with _client(app) as client:
        resp = await client.get(
            "/api/v1/admin/system/status",
            headers={"x-test-perms": "workspace:datasource:read"})
    assert resp.status_code == 403
