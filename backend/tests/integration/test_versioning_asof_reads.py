"""Branch- and as-of-aware reads (unification Phase 1) — needs Postgres.

Drives the read endpoints over ASGI (auth overridden). Verifies: a draft's reads
show the draft overlay while ``main`` does not; ``asOfSeq`` time-travels ``main`` and
a draft; reading a commit's state round-trips (and 404s on an unknown commit); the
commit log is branch-aware; and the FalkorDB hot path is used ONLY for ``main``@head
— any ``branchId`` or ``asOfSeq`` forces the Postgres composition path.
"""
import asyncio
import os
from types import SimpleNamespace

import pytest

from backend.app.services.versioning import models
from backend.app.services.versioning.projection import FalkorProjector
from backend.app.services.versioning.service import GraphVersioningService

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


async def _noop(cypher, params=None):
    return None


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
        gid = (await c.post(f"{ws1}/graphs", json={"dataSourceId": "ds_" + os.urandom(3).hex(), "workspaceId": "ws1",
                                                 "falkorGraphName": "gvt_" + os.urandom(3).hex()})).json()["graphId"]

        # ── v1 on main: A -> B ──
        d1 = (await c.post(f"{ws1}/graphs/{gid}/branches", json={})).json()["branchId"]
        await c.post(f"{ws1}/graphs/{gid}/branches/{d1}/changes", json={"ops": [
            {"op": "create", "entityKind": "node", "entityId": "A", "payload": {"urn": "gv:A", "displayName": "Alpha", "entityType": "Dataset"}},
            {"op": "create", "entityKind": "node", "entityId": "B", "payload": {"urn": "gv:B", "displayName": "Beta", "entityType": "Dataset"}},
            {"op": "create", "entityKind": "edge", "entityId": "E1", "payload": {"edgeType": "FLOWS_TO", "sourceEntityId": "A", "targetEntityId": "B"}},
        ]})
        await c.post(f"{ws1}/graphs/{gid}/branches/{d1}/commit", json={})
        await c.post(f"{ws1}/graphs/{gid}/branches/{d1}/publish", json={"message": "v1"})
        mid = await svc.main_branch_id(gid)

        # ── my draft d2 (unpublished): A->Alpha2, +C, +edge A->C ──
        d2 = (await c.post(f"{ws1}/graphs/{gid}/branches", json={})).json()["branchId"]
        await c.post(f"{ws1}/graphs/{gid}/branches/{d2}/changes", json={"ops": [
            {"op": "update", "entityKind": "node", "entityId": "A", "payload": {"urn": "gv:A", "displayName": "Alpha2", "entityType": "Dataset"}},
            {"op": "create", "entityKind": "node", "entityId": "C", "payload": {"urn": "gv:C", "displayName": "Gamma", "entityType": "Dataset"}},
            {"op": "create", "entityKind": "edge", "entityId": "E2", "payload": {"edgeType": "FLOWS_TO", "sourceEntityId": "A", "targetEntityId": "C"}},
        ]})
        await c.post(f"{ws1}/graphs/{gid}/branches/{d2}/commit", json={})

        # ── branch-aware state: draft overlay vs main ──
        main_st = (await c.get(f"{ws1}/graphs/{gid}/branches/{mid}/state")).json()
        assert set(main_st["nodes"]) == {"A", "B"} and main_st["nodes"]["A"]["displayName"] == "Alpha"
        d2_st = (await c.get(f"{ws1}/graphs/{gid}/branches/{d2}/state")).json()
        assert set(d2_st["nodes"]) == {"A", "B", "C"} and d2_st["nodes"]["A"]["displayName"] == "Alpha2"

        # ── as-of state on main: genesis(seq1) empty, v1(seq2) has A,B ──
        s1 = (await c.get(f"{ws1}/graphs/{gid}/branches/{mid}/state", params={"asOfSeq": 1})).json()
        assert s1["nodes"] == {} and s1["edges"] == {}
        s2 = (await c.get(f"{ws1}/graphs/{gid}/branches/{mid}/state", params={"asOfSeq": 2})).json()
        assert set(s2["nodes"]) == {"A", "B"} and s2["nodes"]["A"]["displayName"] == "Alpha"

        # ── as-of on the draft (large seq == head) composes base@branch-point + own ──
        d2_asof = (await c.get(f"{ws1}/graphs/{gid}/branches/{d2}/state", params={"asOfSeq": 9999})).json()
        assert set(d2_asof["nodes"]) == {"A", "B", "C"} and d2_asof["nodes"]["A"]["displayName"] == "Alpha2"

        # ── commit-state round-trip (time-travel by commit id) + 404 on unknown ──
        commits = (await c.get(f"{ws1}/graphs/{gid}/commits")).json()["commits"]
        by_kind = {x["kind"]: x for x in commits}
        genesis_id, v1_id = by_kind["genesis"]["commit_id"], by_kind["squash_publish"]["commit_id"]
        assert (await c.get(f"{ws1}/graphs/{gid}/commits/{genesis_id}/state")).json()["nodes"] == {}
        v1_state = (await c.get(f"{ws1}/graphs/{gid}/commits/{v1_id}/state")).json()
        assert set(v1_state["nodes"]) == {"A", "B"}
        assert (await c.get(f"{ws1}/graphs/{gid}/commits/cmt_missing/state")).status_code == 404

        # ── commit log is branch-aware: main has genesis+v1; d2 has its checkpoint ──
        assert len(commits) == 2
        d2_log = (await c.get(f"{ws1}/graphs/{gid}/commits", params={"branchId": d2})).json()["commits"]
        assert len(d2_log) == 1 and d2_log[0]["kind"] == "edit"   # draft checkpoint commit

        # ── project main → fresh; FalkorDB serves ONLY main@head, never branch/as-of ──
        await FalkorProjector(graph_client_factory=lambda name: SimpleNamespace(query=_noop)).project_graph(gid)
        assert (await svc.projection_watermark(gid))["fresh"] is True
        fake = _FakeReadGraph(
            nodes=[{"urn": "gv:A", "entityType": "Dataset", "displayName": "Alpha"},
                   {"urn": "gv:B", "entityType": "Dataset", "displayName": "Beta"}],
            edges=[{"src": "gv:A", "tgt": "gv:B", "type": "FLOWS_TO", "props": {"id": "E1"}}],
        )
        app.dependency_overrides[V.get_falkor_read_factory] = lambda: (lambda name: fake)

        main_nb = (await c.get(f"{ws1}/graphs/{gid}/graph/neighbors", params={"urn": "gv:A", "depth": 1})).json()
        assert main_nb["source"] == "falkordb" and {n["urn"] for n in main_nb["nodes"]} == {"gv:A", "gv:B"}

        asof_nb = (await c.get(f"{ws1}/graphs/{gid}/graph/neighbors", params={"urn": "gv:A", "depth": 1, "asOfSeq": 2})).json()
        assert asof_nb["source"] == "postgres" and {n["entityId"] for n in asof_nb["nodes"]} == {"A", "B"}

        draft_nb = (await c.get(f"{ws1}/graphs/{gid}/graph/neighbors", params={"urn": "gv:A", "depth": 1, "branchId": d2})).json()
        assert draft_nb["source"] == "postgres"
        assert {n["entityId"] for n in draft_nb["nodes"]} == {"A", "B", "C"}
        assert {e["id"] for e in draft_nb["edges"]} == {"E1", "E2"}

    from backend.app.services.versioning import db
    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_asof_reads_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning branch + as-of reads e2e: OK")
