"""FalkorDB-first reads + watermark + Postgres fallback (P2) — needs Postgres.

Drives the read endpoints over ASGI (auth overridden). Verifies: every read
carries a freshness watermark; neighbors serve from Postgres when the projection
lags or no FalkorDB is configured; and when the projection is caught up they
serve from FalkorDB (via a fake read client that returns reader-shaped results),
falling back to Postgres on a FalkorDB error. The live socket is covered in P6.
"""
import asyncio
import os
from types import SimpleNamespace

import pytest

from backend.app.services.versioning import models
from backend.app.services.versioning.projection import FalkorProjector
from backend.app.services.versioning.service import GraphVersioningService
from backend.tests.integration.test_versioning_projection import FakeFalkor

R, M = "workspace:datasource:read", "workspace:datasource:manage"


# --- a minimal fake FalkorDB read client returning reader-shaped results --- #
class _FakeNode:
    def __init__(self, props):
        self.properties = props


class _FakeRel:
    def __init__(self, props):
        self.properties = props


class _FakeRes:
    def __init__(self, rows):
        self.result_set = rows


class _FakeReadGraph:
    def __init__(self, nodes, edges):
        self._nodes, self._edges = nodes, edges

    async def query(self, cypher, params=None):
        if "a.urn IN $urns" in cypher:
            return _FakeRes([[e["src"], e["tgt"], e["type"], _FakeRel(e.get("props", {}))] for e in self._edges])
        return _FakeRes([[_FakeNode(p)] for p in self._nodes])


class _RaisingGraph:
    async def query(self, cypher, params=None):
        raise RuntimeError("falkor down")


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
        ws = request.path_params.get("ws_id") or "ws1"
        return PermissionClaims(sid="", global_perms=(), ws_perms={ws: (R, M)})

    app = FastAPI()
    app.include_router(V.router, prefix="/api/v1/{ws_id}/versioning")
    app.dependency_overrides[get_current_user] = fake_user
    app.dependency_overrides[get_permission_claims] = fake_claims
    app.dependency_overrides[V.get_falkor_read_factory] = lambda: None     # default: PG path
    return app, V


async def _run() -> None:
    from httpx import ASGITransport, AsyncClient

    await models.create_schema_and_partitions()
    app, V = _build_app()
    svc = GraphVersioningService()
    ws1 = "/api/v1/ws1/versioning"

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        # seed A -> B, publish (projection NOT run → projected < committed)
        gid = (await c.post(f"{ws1}/graphs", json={"dataSourceId": "ds_" + os.urandom(3).hex(), "workspaceId": "ws1",
                                                 "falkorGraphName": "gvt_" + os.urandom(3).hex()})).json()["graphId"]
        bid = (await c.post(f"{ws1}/graphs/{gid}/branches", json={})).json()["branchId"]
        await c.post(f"{ws1}/graphs/{gid}/branches/{bid}/changes", json={"ops": [
            {"op": "create", "entityKind": "node", "entityId": "A", "payload": {"displayName": "Alpha", "entityType": "Dataset"}},
            {"op": "create", "entityKind": "node", "entityId": "B", "payload": {"displayName": "Beta", "entityType": "Dataset"}},
            {"op": "create", "entityKind": "edge", "entityId": "E1", "payload": {"edgeType": "FLOWS_TO", "sourceEntityId": "A", "targetEntityId": "B"}},
        ]})
        await c.post(f"{ws1}/graphs/{gid}/branches/{bid}/commit", json={})
        await c.post(f"{ws1}/graphs/{gid}/branches/{bid}/publish", json={"message": "v1"})
        mid = await svc.main_branch_id(gid)

        # /state carries the watermark; projection lags (not fresh)
        st = (await c.get(f"{ws1}/graphs/{gid}/branches/{mid}/state")).json()
        assert st["watermark"]["committed"] == 2 and st["watermark"]["projected"] == 0
        assert st["watermark"]["fresh"] is False

        # neighbors: projection lags → Postgres fallback, correct neighborhood
        nb = (await c.get(f"{ws1}/graphs/{gid}/graph/neighbors", params={"urn": "gv:A", "depth": 1})).json()
        assert nb["source"] == "postgres"
        assert {n["entityId"] for n in nb["nodes"]} == {"A", "B"}
        assert [e["id"] for e in nb["edges"]] == ["E1"]
        assert nb["watermark"]["fresh"] is False

        # advance the projection (faithful fake: DROP+reseed+verify all run) → fresh
        await FalkorProjector(graph_client_factory=FakeFalkor()).project_graph(gid)
        wm = await svc.projection_watermark(gid)
        assert wm["projected"] == 2 and wm["fresh"] is True

        # fresh + FalkorDB read factory → served from FalkorDB (fake)
        fake = _FakeReadGraph(
            nodes=[{"urn": "gv:A", "entityType": "Dataset", "displayName": "Alpha"},
                   {"urn": "gv:B", "entityType": "Dataset", "displayName": "Beta"}],
            edges=[{"src": "gv:A", "tgt": "gv:B", "type": "FLOWS_TO", "props": {"id": "E1"}}],
        )
        app.dependency_overrides[V.get_falkor_read_factory] = lambda: (lambda name, provider_id=None: fake)
        nb = (await c.get(f"{ws1}/graphs/{gid}/graph/neighbors", params={"urn": "gv:A", "depth": 1})).json()
        assert nb["source"] == "falkordb", nb
        assert {n["urn"] for n in nb["nodes"]} == {"gv:A", "gv:B"}
        assert [e["id"] for e in nb["edges"]] == ["E1"]

        # fresh but FalkorDB errors → graceful Postgres fallback
        app.dependency_overrides[V.get_falkor_read_factory] = lambda: (lambda name, provider_id=None: _RaisingGraph())
        nb = (await c.get(f"{ws1}/graphs/{gid}/graph/neighbors", params={"urn": "gv:A"})).json()
        assert nb["source"] == "postgres" and {n["entityId"] for n in nb["nodes"]} == {"A", "B"}

    from backend.app.services.versioning import db
    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_reads_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning FalkorDB-first reads + watermark + fallback e2e: OK")
