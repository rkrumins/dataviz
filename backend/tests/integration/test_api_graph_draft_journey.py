"""HTTP e2e of the draft journey over the real ``/graph`` + ``/versioning`` routers (Postgres).

This is the frontend-facing seam the provider/engine tests don't cover: it drives the *actual
HTTP endpoints* end to end — create a versioned graph, import an existing one (ndjson), open a
draft, edit it through the normal graph endpoints with ``?branchId=``, read-your-writes, and
publish — proving branchId flows through ``get_context_engine`` → ``for_workspace`` → provider
selection → (de)serialization, and that a draft is isolated from main until published.

Postgres-only, no FalkorDB/Redis: the live ``main`` provider is an empty stub (the draft path is
pure Postgres and never queries it) and the read cache is stubbed (writes only call
``bump_generation``). Main reads here therefore go through the empty stub — so published state is
verified via the versioning ``/state`` endpoint (the full-stack guide verifies it through
``/graph`` after FalkorDB projection). Gated by ``GRAPHVER_E2E=1`` + a reachable Postgres.
"""
import asyncio
import json
import os
from types import SimpleNamespace

import pytest

from backend.app.services.versioning import db, models


class _StubLiveProvider:
    """Stands in for the FalkorDB 'main' provider — empty; the draft path never queries it."""
    name = "stub-live"

    async def get_nodes(self, query=None):
        return []

    async def get_edges(self, query=None):
        return []

    async def get_node(self, urn):
        return None

    async def search_nodes(self, query, limit: int = 10, offset: int = 0):
        return []

    async def get_ontology_metadata(self):
        raise NotImplementedError


class _StubManager:
    async def get_provider_for_workspace(self, workspace_id, session, data_source_id=None):
        return _StubLiveProvider()


class _StubCache:
    async def bump_generation(self, scope):
        return None


def _build_app():
    from fastapi import FastAPI, Request
    import backend.app.auth.dependencies as deps
    from backend.app.auth.dependencies import (
        get_current_user, get_optional_user, get_permission_claims,
    )
    from backend.app.services.permission_service import PermissionClaims
    from backend.app.db.engine import get_db_session
    from backend.app.api.v1.endpoints import versioning as V
    from backend.app.api.v1.endpoints import graph as G

    # No Redis in the test env: neutralise the revocation lookup (claims carry an empty sid).
    deps.get_revocation_service = lambda: SimpleNamespace(is_revoked=lambda sid: False)

    async def fake_user():
        return SimpleNamespace(id="u_test", email="t@example.com")

    async def fake_claims(request: Request):
        ws = request.path_params.get("ws_id") or "ws1"
        return PermissionClaims(
            sid="", global_perms=(),
            ws_perms={ws: ("workspace:datasource:read", "workspace:datasource:manage")})

    async def fake_db():
        # for_workspace only uses this session for ontology resolution (degrades gracefully
        # when the management ontology tables are absent); the draft path uses the versioning
        # service's own sessions.
        async with db.graphver_session() as s:
            yield s

    app = FastAPI()
    app.include_router(V.router, prefix="/api/v1/{ws_id}/versioning")
    app.include_router(G.router, prefix="/api/v1/{ws_id}/graph")
    app.dependency_overrides[get_current_user] = fake_user
    app.dependency_overrides[get_optional_user] = fake_user
    app.dependency_overrides[get_permission_claims] = fake_claims
    app.dependency_overrides[get_db_session] = fake_db
    return app, G


# An "existing graph" to import: a Domain containing a Table, on main.
_IMPORT_NDJSON = "\n".join(json.dumps(r) for r in [
    {"kind": "node", "id": "urn:t:root", "urn": "urn:t:root", "entityType": "Domain", "displayName": "Imported Root"},
    {"kind": "node", "id": "urn:t:child", "urn": "urn:t:child", "entityType": "Table", "displayName": "Imported Child"},
    {"kind": "edge", "id": "e_root_child", "edgeType": "CONTAINS", "source": "urn:t:root", "target": "urn:t:child"},
])


async def _run() -> None:
    from httpx import ASGITransport, AsyncClient

    await models.create_schema_and_partitions()
    app, G = _build_app()
    orig_pm, orig_cache = G.provider_manager, G.get_graph_cache
    G.provider_manager = _StubManager()
    G.get_graph_cache = lambda: _StubCache()

    ds = "ds_" + os.urandom(4).hex()
    V1, GP = "/api/v1/ws1/versioning", "/api/v1/ws1/graph"
    try:
        c = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
        async with c:
            # 1. create a versioned graph for the data source
            r = await c.post(f"{V1}/graphs", json={"dataSourceId": ds, "workspaceId": "ws1"})
            assert r.status_code == 201, r.text
            gid, main_id = r.json()["graphId"], r.json()["mainBranchId"]

            # 2. IMPORT an existing graph (ndjson → one import commit on main)
            r = await c.post(f"{V1}/graphs/{gid}/bulk-ingest", content=_IMPORT_NDJSON)
            assert r.status_code == 200, r.text
            assert r.json()["ingested"] == 3, r.text          # 2 nodes + 1 edge

            # 3. open a draft
            draft = (await c.post(f"{V1}/graphs/{gid}/branches", json={})).json()["branchId"]

            # 4. EDIT on the draft through the NORMAL graph endpoints (the cohesion proof)
            qd = {"dataSourceId": ds, "branchId": draft}
            r = await c.post(f"{GP}/nodes/create", params=qd, json={
                "entityType": "Table", "displayName": "Draft Node", "parentUrn": "urn:t:root"})
            assert r.status_code == 200 and r.json()["success"] is True, r.text
            new_urn = r.json()["node"]["urn"]
            r = await c.post(f"{GP}/edges", params=qd, json={
                "sourceUrn": "urn:t:child", "targetUrn": new_urn, "edgeType": "LINEAGE"})
            assert r.status_code == 201, r.text

            # 5. read-your-writes on the draft (uncached endpoints — no Redis needed)
            nodes = (await c.post(f"{GP}/nodes/query", params=qd, json={"query": {}})).json()
            assert {"urn:t:root", "urn:t:child", new_urn} <= {n["urn"] for n in nodes}
            edges = (await c.post(f"{GP}/edges/query", params=qd, json={"query": {}})).json()
            assert any(e["edgeType"] == "LINEAGE" for e in edges), edges

            # 5b. UI-shaped diff of the draft vs its base — the added node + edges come back
            #     as whole payloads (what the canvas overlay / Changes panel render).
            dvm = (await c.get(f"{V1}/graphs/{gid}/branches/{draft}/diff-vs-main")).json()
            added_nodes = [e for e in dvm["added"] if e["kind"] == "node"]
            added_edges = [e for e in dvm["added"] if e["kind"] == "edge"]
            assert any(e["after"]["urn"] == new_urn for e in added_nodes), dvm
            assert any(e["after"].get("edgeType") == "LINEAGE" for e in added_edges), dvm
            assert dvm["removed"] == [] and dvm["modified"] == [], dvm

            # 5c. ATOMIC draft save via POST /graph/changes — create + partial-merge update
            #     in one commit. The update sends ONLY displayName; the server must merge
            #     it onto current state (entityType must survive — full-replace would clobber it).
            batch = {"ops": [
                {"op": "create", "kind": "node", "id": "urn:t:batch", "ref": "tmp1",
                 "payload": {"urn": "urn:t:batch", "entityType": "Table", "displayName": "Batch Node"}},
                {"op": "update", "kind": "node", "id": "urn:t:child",
                 "payload": {"displayName": "Child v2"}},
            ], "message": "batch edit"}
            r = await c.post(f"{GP}/changes", params={"dataSourceId": ds, "branchId": draft}, json=batch)
            assert r.status_code == 200, r.text
            assert r.json()["commitId"], r.text
            assert r.json()["assigned"].get("tmp1") == "urn:t:batch", r.json()
            st_b = (await c.get(f"{V1}/graphs/{gid}/branches/{draft}/state")).json()["nodes"]
            assert "urn:t:batch" in st_b, list(st_b)
            assert st_b["urn:t:child"]["displayName"] == "Child v2", st_b["urn:t:child"]
            assert st_b["urn:t:child"]["entityType"] == "Table", st_b["urn:t:child"]  # merge kept it

            # 6. routing isolation: the same read on MAIN (no branchId) hits the live stub (empty)
            main_nodes = (await c.post(f"{GP}/nodes/query", params={"dataSourceId": ds}, json={"query": {}})).json()
            assert {n["urn"] for n in main_nodes} == set(), main_nodes

            # 7. store isolation: versioning main state has the import but NOT the draft node yet
            st = (await c.get(f"{V1}/graphs/{gid}/branches/{main_id}/state")).json()
            assert "urn:t:root" in st["nodes"] and new_urn not in st["nodes"]

            # 8. unknown branch on a versioned graph → 404
            bad = await c.post(f"{GP}/nodes/query",
                               params={"dataSourceId": ds, "branchId": "br_bogus"}, json={"query": {}})
            assert bad.status_code == 404, bad.text

            # 9. publish the draft → main (squashes the apply_ops commits the graph writes made)
            r = await c.post(f"{V1}/graphs/{gid}/branches/{draft}/publish", json={"message": "publish draft"})
            assert r.status_code == 200, r.text

            # 10. main now carries the imported graph + the draft edit
            st2 = (await c.get(f"{V1}/graphs/{gid}/branches/{main_id}/state")).json()
            assert {"urn:t:root", "urn:t:child", new_urn} <= set(st2["nodes"])
    finally:
        G.provider_manager, G.get_graph_cache = orig_pm, orig_cache
        await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_api_graph_draft_journey_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("API graph draft journey (HTTP create→import→draft-edit→read→publish) e2e: OK")
