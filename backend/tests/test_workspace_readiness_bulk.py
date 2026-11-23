"""GET /api/v1/admin/workspaces/{ws_id}/data-sources/readiness — every source at once.

The workspace page asked each data source's readiness separately, four at a time,
and rendered nothing until the slowest answered. This route answers for them all
in one request: each entry the single route's answer, a source that can't be read
``null`` rather than a failed request, never more than four asked at once, and
behind the same permission as the single route.
"""
import asyncio
import contextlib

import pytest
from fastapi import HTTPException, status
from httpx import AsyncClient

from backend.app.api.v1.endpoints import aggregation as agg_endpoints
from backend.app.auth.dependencies import (
    get_current_user,
    get_optional_user,
    get_permission_claims,
)
from backend.app.db.models import ProviderORM, WorkspaceDataSourceORM, WorkspaceORM
from backend.app.services.aggregation.schemas import DataSourceReadinessResponse
from backend.app.services.permission_service import PermissionClaims
from backend.auth_service.interface import User

WS_FIN, WS_OPS = "ws_fin", "ws_ops"
URL = f"/api/v1/admin/workspaces/{WS_FIN}/data-sources/readiness"

BOB = User(
    id="usr_bob", email="usr_bob@example.com", first_name="T", last_name="U",
    role="user", status="active",
    created_at="2024-01-01T00:00:00Z", updated_at="2024-01-01T00:00:00Z",
)


@contextlib.contextmanager
def _auth(*, user, claims):
    from backend.app.main import app

    async def _current():
        if user is None:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="x")
        return user

    async def _optional():
        return user

    prev = {dep: app.dependency_overrides.get(dep)
            for dep in (get_current_user, get_optional_user, get_permission_claims)}
    app.dependency_overrides[get_current_user] = _current
    app.dependency_overrides[get_optional_user] = _optional
    app.dependency_overrides[get_permission_claims] = lambda: claims
    try:
        yield
    finally:
        for dep, fn in prev.items():
            app.dependency_overrides[dep] = fn


class _Svc:
    """Answers readiness after a beat, tracking how many are asked at once."""

    def __init__(self, broken=()):
        self.broken = set(broken)
        self.in_flight = 0
        self.peak = 0
        self.asked = []

    async def get_readiness(self, ds_id, session):
        self.asked.append(ds_id)
        self.in_flight += 1
        self.peak = max(self.peak, self.in_flight)
        try:
            await asyncio.sleep(0.01)
            if ds_id in self.broken:
                raise RuntimeError("provider down")
            return DataSourceReadinessResponse(
                dataSourceId=ds_id, isReady=True, aggregationStatus="ready", canCreateViews=True,
                message="Aggregation complete. Views can be created.",
            )
        finally:
            self.in_flight -= 1


@pytest.fixture
def svc(monkeypatch):
    from backend.app.main import app

    @contextlib.asynccontextmanager
    async def _session():
        yield object()

    service = _Svc()
    monkeypatch.setattr(agg_endpoints, "_PROXY_ENABLED", False)
    monkeypatch.setattr(agg_endpoints, "get_graph_read_session", _session)
    monkeypatch.setattr(app.state, "aggregation_service", service, raising=False)
    return service


async def _sources(db_session, n_fin: int):
    db_session.add(ProviderORM(id="prov_a", name="Warehouse", provider_type="falkordb"))
    db_session.add_all([WorkspaceORM(id=WS_FIN, name="Finance"), WorkspaceORM(id=WS_OPS, name="Operations")])
    db_session.add_all([
        WorkspaceDataSourceORM(id=f"ds_fin_{i}", workspace_id=WS_FIN, provider_id="prov_a", graph_name=f"g{i}")
        for i in range(n_fin)
    ])
    db_session.add(WorkspaceDataSourceORM(id="ds_ops", workspace_id=WS_OPS, provider_id="prov_a", graph_name="o"))
    await db_session.commit()


async def test_every_source_of_the_workspace_in_one_answer(test_client: AsyncClient, db_session, svc):
    await _sources(db_session, 3)
    svc.broken = {"ds_fin_1"}

    resp = await test_client.get(URL)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    # Another workspace's source is not asked about.
    assert set(body) == {"ds_fin_0", "ds_fin_1", "ds_fin_2"}
    assert "ds_ops" not in svc.asked
    # The single route's shape, keyed by source; the broken one answers null.
    assert body["ds_fin_0"]["aggregationStatus"] == "ready"
    assert body["ds_fin_0"]["dataSourceId"] == "ds_fin_0"
    assert body["ds_fin_1"] is None
    assert body["ds_fin_2"]["isReady"] is True


async def test_asks_at_most_four_sources_at_once(test_client: AsyncClient, db_session, svc):
    await _sources(db_session, 10)
    resp = await test_client.get(URL)
    assert resp.status_code == 200
    assert len(resp.json()) == 10
    assert svc.peak == agg_endpoints._READINESS_FANOUT == 4


async def test_a_workspace_with_no_sources_answers_empty(test_client: AsyncClient, db_session, svc):
    await _sources(db_session, 0)
    resp = await test_client.get(URL)
    assert resp.status_code == 200
    assert resp.json() == {}


async def test_needs_data_source_read_in_that_workspace(test_client: AsyncClient, db_session, svc):
    await _sources(db_session, 2)
    member = PermissionClaims(sid="s_bob", ws_perms={WS_FIN: ("workspace:datasource:read",)})
    outsider = PermissionClaims(sid="s_bob", ws_perms={WS_OPS: ("workspace:datasource:read",)})

    with _auth(user=BOB, claims=member):
        allowed = await test_client.get(URL)
    with _auth(user=BOB, claims=outsider):
        refused = await test_client.get(URL)

    assert allowed.status_code == 200
    assert set(allowed.json()) == {"ds_fin_0", "ds_fin_1"}
    assert refused.status_code == 403
    assert refused.json()["detail"]["permission"] == "workspace:datasource:read"
