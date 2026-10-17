"""A private draft is written only by its owner (doc 13 visibility table, Stage 2) — over HTTP, needs
Postgres.

Alice owns a private draft. Bob holds workspace manage, so he may read it, but every write to it is
403 ``access_denied`` with code ``not_draft_owner``: a canvas save (``/graph/changes``), a node
create through the graph routes with ``branchId``, a stage, a checkpoint, a pull, an import into it,
a publish (in the request or queued as a job) and opening a merge request from it. Bob's abandon is
refused too (``_require_manage``). None of these writes anything, and Alice can do every one.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models

from .test_api_graph_draft_journey import _IMPORT_NDJSON, _StubCache, _StubManager, _build_app


def _app():
    from fastapi import Request
    from types import SimpleNamespace
    from backend.app.auth.dependencies import get_current_user, get_optional_user
    from backend.app.api.v1.endpoints import versioning as V
    from backend.app.services.versioning.import_export.service import ImportExportService

    app, G = _build_app()

    async def header_user(request: Request):         # X-User picks the caller; both hold manage
        uid = request.headers.get("X-User", "alice")
        return SimpleNamespace(id=uid, email=f"{uid}@example.com")
    app.dependency_overrides[get_current_user] = header_user
    app.dependency_overrides[get_optional_user] = header_user
    # The import and queued-publish routes are refused before the store is touched.
    app.dependency_overrides[V.get_import_export_service] = lambda: ImportExportService(
        versioning=V.get_versioning_service(), store=object())
    return app, G, V


async def _run() -> None:
    from httpx import ASGITransport, AsyncClient

    await models.create_schema_and_partitions()
    app, G, V = _app()
    orig_pm, orig_cache, orig_sync_max = G.provider_manager, G.get_graph_cache, V.vconfig.SYNC_PUBLISH_MAX_CHANGES
    G.provider_manager = _StubManager()
    G.get_graph_cache = lambda: _StubCache()
    ds = "ds_" + os.urandom(4).hex()
    V1, GP = "/api/v1/ws1/versioning", "/api/v1/ws1/graph"
    alice, bob = {"X-User": "alice"}, {"X-User": "bob"}
    try:
        c = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
        async with c:
            r = await c.post(f"{V1}/graphs", json={"dataSourceId": ds, "workspaceId": "ws1"}, headers=alice)
            assert r.status_code == 201, r.text
            gid = r.json()["graphId"]
            r = await c.post(f"{V1}/graphs/{gid}/bulk-ingest", content=_IMPORT_NDJSON, headers=alice)
            assert r.status_code == 200, r.text
            d = (await c.post(f"{V1}/graphs/{gid}/branches", json={}, headers=alice)).json()["branchId"]
            qd = {"dataSourceId": ds, "branchId": d}
            save = {"ops": [{"op": "update", "kind": "node", "id": "urn:t:child",
                             "payload": {"displayName": "Child v2"}}]}
            r = await c.post(f"{GP}/changes", params=qd, json=save, headers=alice)
            assert r.status_code == 200, r.text
            # Bob may read it: he holds workspace manage.
            r = await c.get(f"{V1}/graphs/{gid}/branches/{d}/state", headers=bob)
            assert r.status_code == 200, r.text
            log = {"branchId": d}
            commits = len((await c.get(f"{V1}/graphs/{gid}/commits", params=log, headers=alice)).json()["commits"])

            def refused(r):
                assert r.status_code == 403, r.text
                detail = r.json()["detail"]
                assert detail["type"] == "access_denied", detail
                assert detail["code"] == "not_draft_owner", detail
                assert detail["branchId"] == d and detail["owner"] == "alice", detail

            stage = {"ops": [{"op": "create", "entityKind": "node", "entityId": "urn:t:bob",
                              "payload": {"urn": "urn:t:bob", "entityType": "Table", "displayName": "Bob"}}]}
            refused(await c.post(f"{GP}/changes", params=qd, json=save, headers=bob))
            refused(await c.post(f"{GP}/nodes/create", params=qd, headers=bob, json={
                "entityType": "Table", "displayName": "Bob Node", "parentUrn": "urn:t:root"}))
            refused(await c.post(f"{V1}/graphs/{gid}/branches/{d}/changes", json=stage, headers=bob))
            refused(await c.post(f"{V1}/graphs/{gid}/branches/{d}/commit", json={}, headers=bob))
            refused(await c.post(f"{V1}/graphs/{gid}/branches/{d}/rebase", json={}, headers=bob))
            refused(await c.post(f"{V1}/graphs/{gid}/imports", params={"branchId": d},
                                 content=_IMPORT_NDJSON, headers=bob))
            refused(await c.post(f"{V1}/graphs/{gid}/branches/{d}/publish", json={"message": "m"}, headers=bob))
            V.vconfig.SYNC_PUBLISH_MAX_CHANGES = 0       # a large draft: publish is queued as a job
            refused(await c.post(f"{V1}/graphs/{gid}/branches/{d}/publish", json={"message": "m"}, headers=bob))
            V.vconfig.SYNC_PUBLISH_MAX_CHANGES = orig_sync_max
            refused(await c.post(f"{V1}/graphs/{gid}/branches/{d}/merge-requests", json={}, headers=bob))
            r = await c.post(f"{V1}/graphs/{gid}/branches/{d}/abandon", headers=bob)
            assert r.status_code == 403 and r.json()["detail"]["type"] == "access_denied", r.text

            # Nothing Bob sent landed: no commit, nothing staged, no job, no PR, still open.
            assert len((await c.get(f"{V1}/graphs/{gid}/commits", params=log, headers=alice)).json()["commits"]) == commits
            st = (await c.get(f"{V1}/graphs/{gid}/branches/{d}/state", headers=alice)).json()["nodes"]
            assert "urn:t:bob" not in st and not any(n.get("displayName") == "Bob Node" for n in st.values())
            assert (await c.get(f"{V1}/graphs/{gid}/merge-requests", headers=alice)).json() == []
            branches = {b["branchId"]: b for b in (await c.get(f"{V1}/graphs/{gid}/branches", headers=alice)).json()}
            assert branches[d]["status"] == "open", branches[d]

            # Alice does every one of them.
            r = await c.post(f"{GP}/nodes/create", params=qd, headers=alice, json={
                "entityType": "Table", "displayName": "Alice Node", "parentUrn": "urn:t:root"})
            assert r.status_code == 200 and r.json()["success"] is True, r.text
            r = await c.post(f"{V1}/graphs/{gid}/branches/{d}/changes", json=stage, headers=alice)
            assert r.status_code == 200, r.text
            r = await c.post(f"{V1}/graphs/{gid}/branches/{d}/commit", json={}, headers=alice)
            assert r.status_code == 200 and r.json()["commitId"], r.text
            r = await c.post(f"{V1}/graphs/{gid}/branches/{d}/rebase", json={}, headers=alice)
            assert r.status_code == 200, r.text
            r = await c.post(f"{V1}/graphs/{gid}/branches/{d}/merge-requests", json={}, headers=alice)
            assert r.status_code == 201, r.text
            r = await c.post(f"{V1}/graphs/{gid}/branches/{d}/publish", json={"message": "ship"}, headers=alice)
            assert r.status_code == 200, r.text
            d2 = (await c.post(f"{V1}/graphs/{gid}/branches", json={}, headers=alice)).json()["branchId"]
            r = await c.post(f"{V1}/graphs/{gid}/branches/{d2}/abandon", headers=alice)
            assert r.status_code == 200 and r.json()["status"] == "abandoned", r.text
    finally:
        G.provider_manager, G.get_graph_cache = orig_pm, orig_cache
        V.vconfig.SYNC_PUBLISH_MAX_CHANGES = orig_sync_max
        await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_private_draft_written_only_by_owner(data_sources):
    asyncio.run(_run())
