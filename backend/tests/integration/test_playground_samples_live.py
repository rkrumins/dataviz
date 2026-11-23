"""POST /playground/samples/{id} on Postgres: every sample starts, through the real version store.

``tests/test_playground_samples.py`` pins what a sample makes against a stand-in for the version
store; this runs the same route on the real one, so a sample that can't be made there (a 502,
"The model's version store could not be created") fails here. Each sample is started by a member
of the Playground and must answer 201 with a graph whose main holds its day-0 import, its three
views and its example change waiting for review. Only what needs a graph engine is pinned: the
sandbox provider answers as reachable, and the first projection isn't run.

Needs ``GRAPHVER_E2E=1`` and ``MANAGEMENT_DB_URL`` built at head (as ``versioning-e2e`` builds it).
"""
from __future__ import annotations

import asyncio
import json
import os

import pytest

from backend.app.services import playground_samples

MEMBER_PERMS = (
    "workspace:datasource:manage", "workspace:datasource:read", "workspace:ontology:read",
    "workspace:provider:read", "workspace:view:create", "workspace:view:delete",
    "workspace:view:edit", "workspace:view:read",
)


async def _playground(sandbox: str):
    """The Playground on ``sandbox`` (the one there is, else a new one), and how to put it back."""
    from sqlalchemy import select
    from backend.app.db.engine import PoolRole, get_session_factory
    from backend.app.db.models import ProviderORM, WorkspaceORM

    settings = {"sandboxProviderId": sandbox, "starterOntologyIds": [], "graphQuota": 10}
    async with get_session_factory(PoolRole.WEB)() as s:
        s.add(ProviderORM(id=sandbox, name=f"Sandbox {sandbox}", provider_type="falkordb",
                          host="sandbox", port=6379))
        ws = (await s.execute(select(WorkspaceORM).where(WorkspaceORM.kind == "playground"))).scalar_one_or_none()
        before = None if ws is None else ws.playground_settings
        if ws is None:
            ws = WorkspaceORM(id="ws_pg_" + os.urandom(3).hex(), name="Playground", kind="playground",
                              request_policy="open", publish_policy="request")
            s.add(ws)
        ws.playground_settings = json.dumps(settings)
        await s.commit()
        ws_id, made = ws.id, before is None

    async def restore() -> None:
        async with get_session_factory(PoolRole.WEB)() as s:
            row = await s.get(WorkspaceORM, ws_id)
            if row is not None and not made:
                row.playground_settings = before
                await s.commit()

    return ws_id, restore


async def _run() -> None:
    from httpx import ASGITransport, AsyncClient
    from backend.app.api.v1.endpoints import playground as playground_endpoints
    from backend.app.auth.dependencies import get_current_user, get_optional_user, get_permission_claims
    from backend.app.main import app
    from backend.app.providers.manager import provider_manager
    from backend.app.services.feature_flags import feature_flags
    from backend.app.services.permission_service import PermissionClaims
    from backend.app.services.versioning import db, models
    from backend.app.services.versioning.models import BranchORM, GraphORM
    from backend.app.services.versioning.service import GraphVersioningService
    from backend.auth_service.cookies import CSRF_COOKIE_NAME
    from backend.auth_service.csrf import CSRF_HEADER_NAME
    from backend.auth_service.interface import User
    from sqlalchemy import select

    await models.create_schema_and_partitions()
    sandbox = "prov_sbx_" + os.urandom(3).hex()
    ws_id, restore = await _playground(sandbox)
    member = User(id="usr_" + os.urandom(3).hex(), email="member@example.com", first_name="Pat",
                  last_name="Member", role="user", status="active",
                  created_at="2026-01-01T00:00:00Z", updated_at="2026-01-01T00:00:00Z")
    claims = PermissionClaims(sid="s_live", ws_perms={ws_id: MEMBER_PERMS})

    async def _member():
        return member

    async def _no_projection(graph_id):          # no graph engine here: the first projection waits
        return None

    flags = {k: feature_flags._cache.get(k) for k in ("playgroundEnabled", "blankModelsEnabled", "versioningEnabled")}
    saved = {k: app.dependency_overrides.get(k) for k in (get_current_user, get_optional_user, get_permission_claims)}
    original_projection = playground_endpoints.project_now
    for key in flags:
        feature_flags._cache[key] = True
    app.dependency_overrides[get_current_user] = _member
    app.dependency_overrides[get_optional_user] = _member
    app.dependency_overrides[get_permission_claims] = lambda: claims
    playground_endpoints.project_now = _no_projection
    provider_manager.warmup_cache[sandbox] = {"ok": True}
    try:
        token = "live-csrf-" + os.urandom(4).hex()          # the double submit, as a browser sends it
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test",
                               cookies={CSRF_COOKIE_NAME: token}, headers={CSRF_HEADER_NAME: token}) as c:
            for sample in playground_samples.SAMPLES:          # the retail pipeline first
                r = await c.post(f"/api/v1/playground/samples/{sample.id}")
                assert r.status_code == 201, (sample.id, r.status_code, r.text)
                out = r.json()
                svc = GraphVersioningService()
                graph_id = (await svc.get_graph_by_data_source(out["dataSourceId"]))["graph_id"]
                meta = await svc.get_graph(graph_id)
                assert meta["kind"] == "blank" and meta["data_source_id"] == out["dataSourceId"]
                assert meta["main_head_commit_seq"] == 2, meta          # genesis, then the sample
                assert set(out["viewIds"]) >= {"context", "graph", "hierarchy"}, out
                assert out["draftId"] and out["reviewId"], out
                async with db.graphver_session() as s:
                    graph = await s.get(GraphORM, graph_id)
                    drafts = (await s.execute(select(BranchORM).where(
                        BranchORM.graph_id == graph.id, BranchORM.kind == "draft"))).scalars().all()
                assert [d.id for d in drafts] == [out["draftId"]], drafts
    finally:
        provider_manager.warmup_cache.pop(sandbox, None)
        playground_endpoints.project_now = original_projection
        for k, v in saved.items():
            if v is None:
                app.dependency_overrides.pop(k, None)
            else:
                app.dependency_overrides[k] = v
        for key, value in flags.items():
            if value is None:
                feature_flags._cache.pop(key, None)
            else:
                feature_flags._cache[key] = value
        await restore()
        await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_every_sample_starts_on_the_real_version_store():
    asyncio.run(_run())
