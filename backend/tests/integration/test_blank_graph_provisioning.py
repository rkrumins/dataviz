"""POST /{ws}/versioning/blank-graphs — self-service blank-model provisioning (needs Postgres).

One call must mint: a manual data source (providerId-only, ontology bound, collision-proof
``blank_<ds_id>`` graph name), a genesis-only ``kind="blank"`` strict versioned graph pinned
to that name + provider, and a compensating delete of the data source if graph creation
fails. Guards: unpublished ontology → 422 ``ontology_not_published``; non-FalkorDB provider
→ 422 ``provider_unsupported``. ``/resolve`` must expose ``kind`` (the frontend's blank-vs-
unseeded discriminator). Same in-process ASGI harness as test_versioning_api.py.
"""
import asyncio
import json
import os
from types import SimpleNamespace

import pytest

from backend.app.services.versioning import db, models

M = "workspace:datasource:read,workspace:datasource:manage"


def _hdr(perms: str = M) -> dict:
    return {"x-test-perms": perms}


def _build_app():
    from fastapi import FastAPI, Request
    import backend.app.auth.dependencies as deps
    from backend.app.auth.dependencies import get_current_user, get_permission_claims
    from backend.app.services.permission_service import PermissionClaims
    from backend.app.api.v1.endpoints import versioning as V

    deps.get_revocation_service = lambda: SimpleNamespace(is_revoked=lambda sid: False)

    async def fake_user():
        return SimpleNamespace(id="u_test", email="t@example.com")

    async def fake_claims(request: Request):
        perms = tuple(p for p in request.headers.get("x-test-perms", "").split(",") if p)
        ws = request.path_params.get("ws_id") or "ws_blank"
        return PermissionClaims(sid="", global_perms=(), ws_perms={ws: perms} if perms else {})

    app = FastAPI()
    app.include_router(V.router, prefix="/api/v1/{ws_id}/versioning")
    app.dependency_overrides[get_current_user] = fake_user
    app.dependency_overrides[get_permission_claims] = fake_claims
    return app


async def _seed_management(ws_id: str):
    """Workspace + a FalkorDB provider, a Neo4j provider, a published and an
    unpublished ontology — the vocabulary the endpoint validates against."""
    from backend.app.db.engine import PoolRole, get_engine, get_session_factory
    from backend.app.db.models import (
        Base as MgmtBase, OntologyORM, ProviderORM, WorkspaceORM, WorkspaceDataSourceORM,
    )

    eng = get_engine(PoolRole.WEB)
    async with eng.begin() as conn:
        await conn.run_sync(
            MgmtBase.metadata.create_all,
            tables=[WorkspaceORM.__table__, ProviderORM.__table__,
                    OntologyORM.__table__, WorkspaceDataSourceORM.__table__],
        )
    suffix = os.urandom(3).hex()
    ids = {"falkor": f"prov_fk_{suffix}", "neo4j": f"prov_n4_{suffix}",
           "published": f"bp_pub_{suffix}", "draft": f"bp_draft_{suffix}"}
    async with get_session_factory(PoolRole.WEB)() as s:
        if await s.get(WorkspaceORM, ws_id) is None:
            s.add(WorkspaceORM(id=ws_id, name="Blank Test WS"))
        s.add(ProviderORM(id=ids["falkor"], name="falkor-a", provider_type="falkordb",
                          host="falkordb", port=6379))
        s.add(ProviderORM(id=ids["neo4j"], name="neo-a", provider_type="neo4j",
                          host="neo4j", port=7687))
        s.add(OntologyORM(id=ids["published"], name="Pub Ontology", is_published=True,
                          entity_type_definitions=json.dumps({"Dataset": {"name": "Dataset"}}),
                          relationship_type_definitions=json.dumps(
                              {"FLOWS_TO": {"name": "FLOWS_TO", "is_lineage": True}})))
        s.add(OntologyORM(id=ids["draft"], name="Draft Ontology", is_published=False))
        await s.commit()
    return ids


async def _ds_row(ds_id: str):
    from backend.app.db.engine import PoolRole, get_session_factory
    from backend.app.db.models import WorkspaceDataSourceORM
    async with get_session_factory(PoolRole.WEB)() as s:
        return await s.get(WorkspaceDataSourceORM, ds_id)


async def _run() -> None:
    from httpx import ASGITransport, AsyncClient
    from backend.app.api.v1.endpoints import versioning as V
    from backend.app.services.versioning.models import ProjectionStateORM
    from backend.app.services.versioning.service import GraphVersioningService

    await models.create_schema_and_partitions()
    ws = "ws_blank_" + os.urandom(3).hex()
    ids = await _seed_management(ws)
    app = _build_app()
    base = f"/api/v1/{ws}/versioning"
    c = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")

    async with c:
        # ── no manage permission → 403 ───────────────────────────────────────
        r = await c.post(f"{base}/blank-graphs", headers=_hdr(""), json={
            "name": "My Model", "providerId": ids["falkor"], "ontologyId": ids["published"]})
        assert r.status_code == 403, r.text

        # ── guards: unpublished ontology / non-FalkorDB provider / unknowns ──
        r = await c.post(f"{base}/blank-graphs", headers=_hdr(), json={
            "name": "My Model", "providerId": ids["falkor"], "ontologyId": ids["draft"]})
        assert r.status_code == 422 and r.json()["detail"]["type"] == "ontology_not_published", r.text
        r = await c.post(f"{base}/blank-graphs", headers=_hdr(), json={
            "name": "My Model", "providerId": ids["neo4j"], "ontologyId": ids["published"]})
        assert r.status_code == 422 and r.json()["detail"]["type"] == "provider_unsupported", r.text
        r = await c.post(f"{base}/blank-graphs", headers=_hdr(), json={
            "name": "My Model", "providerId": "prov_nope", "ontologyId": ids["published"]})
        assert r.status_code == 422, r.text
        r = await c.post(f"{base}/blank-graphs", headers=_hdr(), json={
            "name": "My Model", "providerId": ids["falkor"], "ontologyId": "bp_nope"})
        assert r.status_code == 404, r.text

        # ── happy path ───────────────────────────────────────────────────────
        r = await c.post(f"{base}/blank-graphs", headers=_hdr(), json={
            "name": "Customer Lineage", "providerId": ids["falkor"],
            "ontologyId": ids["published"]})
        assert r.status_code == 201, r.text
        out = r.json()
        ds_id, gid = out["dataSourceId"], out["graphId"]
        assert out["graphName"] == f"blank_{ds_id}" and out["mainBranchId"], out

        row = await _ds_row(ds_id)
        assert row is not None and row.graph_name == f"blank_{ds_id}", vars(row)
        assert row.ontology_id == ids["published"] and row.provider_id == ids["falkor"]
        assert row.source_mode == "managed" and row.catalog_item_id is None
        assert row.label == "Customer Lineage" and row.created_by == "u_test"

        svc = GraphVersioningService()
        meta = await svc.get_graph(gid)
        assert meta["kind"] == "blank" and meta["data_source_id"] == ds_id
        assert meta["base_ontology_id"] == ids["published"]
        assert meta["main_head_commit_seq"] == 1               # genesis-only
        async with db.graphver_session() as s:
            ps = await s.get(ProjectionStateORM, gid)
            assert ps.falkor_graph_name == f"blank_{ds_id}", vars(ps)
            assert ps.falkor_provider == ids["falkor"]
            assert ps.projected_commit_seq == 0 and ps.target_commit_seq == 1

        # graph row honors strict enforcement (contractually ontology-governed)
        from backend.app.services.versioning.models import GraphORM
        async with db.graphver_session() as s:
            g = await s.get(GraphORM, gid)
            assert g.ontology_enforcement == "strict"

        # ── /resolve exposes kind (frontend blank-vs-unseeded discriminator) ──
        r = await c.get(f"{base}/resolve", params={"dataSourceId": ds_id}, headers=_hdr())
        assert r.status_code == 200 and r.json()["kind"] == "blank", r.text

        # ── user-chosen physical graph name ──────────────────────────────────
        custom = "e2e_named_" + os.urandom(3).hex()
        # name-check: available before, then the same rules reject bad input
        r = await c.get(f"{base}/blank-graphs/name-check",
                        params={"providerId": ids["falkor"], "graphName": custom}, headers=_hdr())
        assert r.status_code == 200 and r.json()["available"] is True, r.text
        # (case is normalized, not rejected — "UPPER_Case" → available as "upper_case")
        r = await c.get(f"{base}/blank-graphs/name-check",
                        params={"providerId": ids["falkor"], "graphName": "UPPER_Case"}, headers=_hdr())
        assert r.json() == {"available": True, "normalized": "upper_case", "reason": None}, r.text
        for bad, why in [("Ab", "too short"), ("has space", "slug rules"),
                         ("-leading", "slug rules"),
                         ("gv_mine", "reserved"), ("blank_mine", "reserved"),
                         ("mygraph_proj", "reserved")]:
            r = await c.get(f"{base}/blank-graphs/name-check",
                            params={"providerId": ids["falkor"], "graphName": bad}, headers=_hdr())
            assert r.status_code == 200 and r.json()["available"] is False, (bad, why, r.text)
        # provision with the custom name → it IS the physical key
        r = await c.post(f"{base}/blank-graphs", headers=_hdr(), json={
            "name": "Named Model", "providerId": ids["falkor"],
            "ontologyId": ids["published"], "graphName": custom})
        assert r.status_code == 201, r.text
        named = r.json()
        assert named["graphName"] == custom, named
        named_row = await _ds_row(named["dataSourceId"])
        assert named_row.graph_name == custom
        async with db.graphver_session() as s:
            ps2 = await s.get(ProjectionStateORM, named["graphId"])
            assert ps2.falkor_graph_name == custom
        # the name is now taken — check endpoint AND provisioning both refuse it
        r = await c.get(f"{base}/blank-graphs/name-check",
                        params={"providerId": ids["falkor"], "graphName": custom}, headers=_hdr())
        assert r.json()["available"] is False, r.text
        r = await c.post(f"{base}/blank-graphs", headers=_hdr(), json={
            "name": "Named Again", "providerId": ids["falkor"],
            "ontologyId": ids["published"], "graphName": custom})
        assert r.status_code == 422 and r.json()["detail"]["type"] == "graph_name_unavailable", r.text
        # invalid name at provision time is rejected before anything is created
        r = await c.post(f"{base}/blank-graphs", headers=_hdr(), json={
            "name": "Bad Name", "providerId": ids["falkor"],
            "ontologyId": ids["published"], "graphName": "gv_reserved"})
        assert r.status_code == 422 and r.json()["detail"]["type"] == "graph_name_unavailable", r.text

        # ── compensation: graph creation fails → the data source is removed ──
        class _FailingSvc:
            async def create_graph(self, **kw):
                raise RuntimeError("boom")
        app.dependency_overrides[V.get_versioning_service] = lambda: _FailingSvc()
        r = await c.post(f"{base}/blank-graphs", headers=_hdr(), json={
            "name": "Doomed Model", "providerId": ids["falkor"],
            "ontologyId": ids["published"]})
        assert r.status_code == 502, r.text
        app.dependency_overrides.pop(V.get_versioning_service)
        from backend.app.db.engine import PoolRole, get_session_factory
        from backend.app.db.models import WorkspaceDataSourceORM
        from sqlalchemy import select
        async with get_session_factory(PoolRole.WEB)() as s:
            doomed = (await s.execute(select(WorkspaceDataSourceORM).where(
                WorkspaceDataSourceORM.label == "Doomed Model",
                WorkspaceDataSourceORM.workspace_id == ws))).scalars().all()
            assert doomed == [], [d.id for d in doomed]

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_blank_graph_provisioning_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("blank-graph provisioning (ds + genesis graph + guards + compensation) e2e: OK")
