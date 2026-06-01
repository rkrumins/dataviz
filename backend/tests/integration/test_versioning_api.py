"""HTTP-level test for the versioning API — proves the frontend↔Postgres path is
API-only (needs Postgres).

Drives the router over an in-process ASGI transport (no network, no direct DB
access from the "client"): create graph → draft → stage → checkpoint → state →
publish → history → diff, plus auth rejection and the 409 conflict→resolution
flow.  Skipped unless ``GRAPHVER_E2E=1`` + a reachable Postgres.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import models
from backend.app.services.versioning.service import GraphVersioningService


def _build_app():
    from fastapi import FastAPI
    from backend.app.api.v1.endpoints import versioning
    app = FastAPI()
    app.include_router(versioning.router, prefix="/api/v1/versioning")
    return app


async def _run() -> None:
    from httpx import ASGITransport, AsyncClient

    await models.create_schema_and_partitions()
    app = _build_app()
    transport = ASGITransport(app=app)
    base = "http://test/api/v1/versioning"

    async with AsyncClient(transport=transport, base_url="http://test", headers={"X-Actor": "alice"}) as c:
        # missing actor → 401 (auth enforced at the boundary)
        anon = await c.post(f"{base}/graphs", json={"data_source_id": "x", "workspace_id": "w"}, headers={"X-Actor": ""})
        assert anon.status_code == 401, anon.text

        # create graph + draft
        r = await c.post(f"{base}/graphs", json={"data_source_id": "ds_" + os.urandom(4).hex(), "workspace_id": "ws1"})
        assert r.status_code == 201, r.text
        gid = r.json()["graph_id"]
        r = await c.post(f"{base}/graphs/{gid}/branches", json={"originating_view_id": "view1"})
        bid = r.json()["branch_id"]

        # stage + checkpoint
        r = await c.post(f"{base}/graphs/{gid}/branches/{bid}/changes", json={"ops": [
            {"op": "create", "entity_kind": "node", "entity_id": "A", "payload": {"displayName": "Alpha"}},
            {"op": "create", "entity_kind": "node", "entity_id": "B", "payload": {"displayName": "Beta"}},
            {"op": "create", "entity_kind": "edge", "entity_id": "E1", "payload": {"edgeType": "FLOWS_TO", "sourceEntityId": "A", "targetEntityId": "B"}},
        ]})
        assert r.json()["count"] == 3, r.text
        r = await c.post(f"{base}/graphs/{gid}/branches/{bid}/commit", json={"message": "seed"})
        assert r.json()["staged_changes"] is True

        # state via API
        st = (await c.get(f"{base}/graphs/{gid}/branches/{bid}/state")).json()
        assert set(st["nodes"]) == {"A", "B"} and set(st["edges"]) == {"E1"}

        # publish
        r = await c.post(f"{base}/graphs/{gid}/branches/{bid}/publish", json={"message": "publish"})
        assert r.status_code == 200 and r.json()["commit_id"]

        # history + diff via API
        h = (await c.get(f"{base}/graphs/{gid}/entities/A/history")).json()
        assert any(v["op"] == "create" for v in h["versions"])
        main = await GraphVersioningService().main_branch_id(gid)
        d = (await c.get(f"{base}/graphs/{gid}/branches/{main}/diff", params={"from_seq": 1, "to_seq": 2})).json()
        assert set(d["added"]) == {"A", "B", "E1"}

        # conflict → 409 → resolve → 200
        r = await c.post(f"{base}/graphs", json={"data_source_id": "ds_" + os.urandom(4).hex(), "workspace_id": "ws1"})
        gid2 = r.json()["graph_id"]
        seed = (await c.post(f"{base}/graphs/{gid2}/branches", json={})).json()["branch_id"]
        await c.post(f"{base}/graphs/{gid2}/branches/{seed}/changes", json={"ops": [{"op": "create", "entity_kind": "node", "entity_id": "A", "payload": {"displayName": "A", "f": 1}}]})
        await c.post(f"{base}/graphs/{gid2}/branches/{seed}/commit", json={})
        await c.post(f"{base}/graphs/{gid2}/branches/{seed}/publish", json={"message": "seed"})
        e1 = (await c.post(f"{base}/graphs/{gid2}/branches", json={})).json()["branch_id"]
        e2 = (await c.post(f"{base}/graphs/{gid2}/branches", json={})).json()["branch_id"]
        await c.post(f"{base}/graphs/{gid2}/branches/{e1}/changes", json={"ops": [{"op": "update", "entity_kind": "node", "entity_id": "A", "payload": {"displayName": "A", "f": 10}}]})
        await c.post(f"{base}/graphs/{gid2}/branches/{e1}/commit", json={})
        await c.post(f"{base}/graphs/{gid2}/branches/{e1}/publish", json={"message": "e1"})
        await c.post(f"{base}/graphs/{gid2}/branches/{e2}/changes", json={"ops": [{"op": "update", "entity_kind": "node", "entity_id": "A", "payload": {"displayName": "A", "f": 20}}]})
        await c.post(f"{base}/graphs/{gid2}/branches/{e2}/commit", json={})
        prev = (await c.get(f"{base}/graphs/{gid2}/branches/{e2}/merge-preview")).json()
        assert prev["clean"] is False
        conflict = await c.post(f"{base}/graphs/{gid2}/branches/{e2}/publish", json={"message": "e2"})
        assert conflict.status_code == 409 and conflict.json()["detail"]["type"] == "merge_conflict"
        resolved = await c.post(f"{base}/graphs/{gid2}/branches/{e2}/publish", json={"message": "resolved", "resolutions": {"A": {"displayName": "A", "f": 99}}})
        assert resolved.status_code == 200, resolved.text

    from backend.app.services.versioning import db
    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_api_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning API e2e: OK")
