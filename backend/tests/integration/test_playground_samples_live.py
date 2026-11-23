"""Blank graphs on Postgres, through the real version store: every Playground sample, and a new empty
data source made with the Explorer's wizard.

``tests/test_playground_samples.py`` pins what a sample makes against a stand-in for the version
store; this runs the routes on the real one, so a graph that can't be made there (a 502, "The
model's version store could not be created") fails here. Two ways in, one ``create_blank_graph``:

* ``POST /playground/samples/{id}``: a member of the Playground starts each sample, and must get
  201 with a graph whose main holds its day-0 import, its three views and its example change
  waiting for review;
* ``POST /{ws}/versioning/blank-graphs``: what the Explorer's New view wizard calls for a new,
  empty data source in a standard workspace, and must get 201 with a blank graph at genesis.

Each runs with ``FALKORDB_PORT`` a port, and as a Kubernetes service link writes it
(``tcp://<ip>:6379``, for a Service named ``falkordb``), which the version store's same-server
check failed on, so no blank graph could be created at all. Only what needs a graph engine is
pinned: the providers answer as reachable, and the Playground's first projection isn't run.

Needs ``GRAPHVER_E2E=1`` and ``MANAGEMENT_DB_URL`` built at head (as ``versioning-e2e`` builds it).
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import os

import pytest

from backend.app.services import playground_samples

PORTS = pytest.mark.parametrize("falkordb_port", ["6379", "tcp://10.0.0.5:6379"], ids=["port", "service-link"])
LIVE = pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")

MEMBER_PERMS = (
    "workspace:datasource:manage", "workspace:datasource:read", "workspace:ontology:read",
    "workspace:provider:read", "workspace:view:create", "workspace:view:delete",
    "workspace:view:edit", "workspace:view:read",
)


def _person():
    from backend.auth_service.interface import User
    return User(id="usr_" + os.urandom(3).hex(), email="maker@example.com", first_name="Pat",
                last_name="Maker", role="user", status="active",
                created_at="2026-01-01T00:00:00Z", updated_at="2026-01-01T00:00:00Z")


@contextlib.asynccontextmanager
async def _app_as(person, ws_perms: dict, providers: list, falkordb_port: str):
    """The app, as ``person`` with ``ws_perms``, ``providers`` answering as reachable, and
    ``FALKORDB_PORT`` set to ``falkordb_port``; everything put back after."""
    from httpx import ASGITransport, AsyncClient
    from backend.app.api.v1.endpoints import playground as playground_endpoints
    from backend.app.auth.dependencies import get_current_user, get_optional_user, get_permission_claims
    from backend.app.main import app
    from backend.app.providers.manager import provider_manager
    from backend.app.services.feature_flags import feature_flags
    from backend.app.services.permission_service import PermissionClaims
    from backend.auth_service.cookies import CSRF_COOKIE_NAME
    from backend.auth_service.csrf import CSRF_HEADER_NAME

    claims = PermissionClaims(sid="s_live", ws_perms=ws_perms)

    async def _me():
        return person

    async def _no_projection(graph_id):          # no graph engine here: the first projection waits
        return None

    port_before = os.environ.get("FALKORDB_PORT")
    flags = {k: feature_flags._cache.get(k) for k in ("playgroundEnabled", "blankModelsEnabled", "versioningEnabled")}
    saved = {k: app.dependency_overrides.get(k) for k in (get_current_user, get_optional_user, get_permission_claims)}
    original_projection = playground_endpoints.project_now
    os.environ["FALKORDB_PORT"] = falkordb_port
    for key in flags:
        feature_flags._cache[key] = True
    app.dependency_overrides[get_current_user] = _me
    app.dependency_overrides[get_optional_user] = _me
    app.dependency_overrides[get_permission_claims] = lambda: claims
    playground_endpoints.project_now = _no_projection
    for provider in providers:
        provider_manager.warmup_cache[provider] = {"ok": True}
    try:
        token = "live-csrf-" + os.urandom(4).hex()          # the double submit, as a browser sends it
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test",
                               cookies={CSRF_COOKIE_NAME: token}, headers={CSRF_HEADER_NAME: token}) as c:
            yield c
    finally:
        if port_before is None:
            os.environ.pop("FALKORDB_PORT", None)
        else:
            os.environ["FALKORDB_PORT"] = port_before
        for provider in providers:
            provider_manager.warmup_cache.pop(provider, None)
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


async def _samples(falkordb_port: str) -> None:
    from backend.app.services.versioning import db, models
    from backend.app.services.versioning.models import BranchORM, GraphORM
    from backend.app.services.versioning.service import GraphVersioningService
    from sqlalchemy import select

    await models.create_schema_and_partitions()
    sandbox = "prov_sbx_" + os.urandom(3).hex()
    ws_id, restore = await _playground(sandbox)
    try:
        async with _app_as(_person(), {ws_id: MEMBER_PERMS}, [sandbox], falkordb_port) as c:
            for sample in playground_samples.SAMPLES:          # the retail pipeline first
                r = await c.post(f"/api/v1/playground/samples/{sample.id}",
                                 json={"views": ["graph", "hierarchy"]})
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
        await restore()
        await db.dispose_engine()


async def _empty_source(falkordb_port: str) -> None:
    """The Explorer's wizard: a new, empty data source in a standard workspace."""
    from backend.app.db.engine import PoolRole, get_session_factory
    from backend.app.db.models import OntologyORM, ProviderORM, WorkspaceORM
    from backend.app.services.versioning import db, models
    from backend.app.services.versioning.service import GraphVersioningService

    await models.create_schema_and_partitions()
    tag = os.urandom(3).hex()
    ws_id, provider, layer = f"ws_live_{tag}", f"prov_live_{tag}", f"bp_live_{tag}"
    async with get_session_factory(PoolRole.WEB)() as s:
        s.add(WorkspaceORM(id=ws_id, name=f"Finance {tag}"))
        s.add(ProviderORM(id=provider, name=f"FalkorDB {tag}", provider_type="falkordb",
                          host="falkordb", port=6379))
        s.add(OntologyORM(id=layer, name=f"Finance layer {tag}", version=1, is_published=True))
        await s.commit()
    try:
        async with _app_as(_person(), {ws_id: MEMBER_PERMS}, [provider], falkordb_port) as c:
            r = await c.post(f"/api/v1/{ws_id}/versioning/blank-graphs",
                             json={"name": "General ledger", "providerId": provider, "ontologyId": layer})
            assert r.status_code == 201, (r.status_code, r.text)
            out = r.json()
            assert out["label"] == "General ledger" and out["graphName"].startswith("blank_"), out
            meta = await GraphVersioningService().get_graph(out["graphId"])
            assert meta["kind"] == "blank" and meta["data_source_id"] == out["dataSourceId"], meta
            assert meta["main_head_commit_seq"] == 1, meta          # genesis, nothing in it yet
    finally:
        await db.dispose_engine()


@LIVE
@PORTS
def test_every_sample_starts_on_the_real_version_store(falkordb_port):
    asyncio.run(_samples(falkordb_port))


@LIVE
@PORTS
def test_the_explorers_wizard_makes_an_empty_data_source(falkordb_port):
    asyncio.run(_empty_source(falkordb_port))
