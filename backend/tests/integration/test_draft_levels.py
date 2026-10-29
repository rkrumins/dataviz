"""A draft is public or private — over HTTP, needs Postgres.

Reading:
* A private draft is read only by its owner, its members and the people on its review. Carol, who
  manages the workspace but is none of those, gets 404 like Bob, who only reads; she doesn't find
  it in the list either.
* A public draft is read by everyone who reads the data source, and listed for them.
* A review follows its draft: whoever may read the draft opens it and finds it listed, and so do
  its author and reviewers; anyone else gets 404 and doesn't see it listed.
"""
import asyncio
import os

import pytest
from sqlalchemy import text

from backend.app.services.versioning import db, models

from .test_api_graph_draft_journey import _IMPORT_NDJSON, _StubCache, _StubManager
from .test_private_draft_read import _app


async def _set_visibility(branch_id: str, visibility: str) -> None:
    async with db.graphver_session() as s:
        await s.execute(text(f'UPDATE "{models._SCHEMA}"."branches" SET visibility = :v WHERE id = :id'),
                        {"v": visibility, "id": branch_id})


async def _reads_run() -> None:
    from httpx import ASGITransport, AsyncClient

    await models.create_schema_and_partitions()
    app, G = _app()
    orig_pm, orig_cache = G.provider_manager, G.get_graph_cache
    G.provider_manager = _StubManager()
    G.get_graph_cache = lambda: _StubCache()
    ds = "ds_" + os.urandom(4).hex()
    V1, GP = "/api/v1/ws1/versioning", "/api/v1/ws1/graph"
    setup = {"X-User": "alice", "X-Manage": "1", "X-Publish": "1"}
    try:
        c = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
        async with c:
            r = await c.post(f"{V1}/graphs", json={"dataSourceId": ds, "workspaceId": "ws1"}, headers=setup)
            assert r.status_code == 201, r.text
            gid = r.json()["graphId"]
            r = await c.post(f"{V1}/graphs/{gid}/bulk-ingest", content=_IMPORT_NDJSON, headers=setup)
            assert r.status_code == 200, r.text
            d = (await c.post(f"{V1}/graphs/{gid}/branches", json={}, headers=setup)).json()["branchId"]
            save = {"ops": [{"op": "update", "kind": "node", "id": "urn:t:child",
                             "payload": {"displayName": "Child v2"}}]}
            r = await c.post(f"{GP}/changes", params={"dataSourceId": ds, "branchId": d}, json=save,
                             headers=setup)
            assert r.status_code == 200, r.text
            r = await c.post(f"{V1}/graphs/{gid}/branches/{d}/merge-requests",
                             json={"reviewers": ["dave"]}, headers=setup)
            assert r.status_code == 201, r.text
            pr = r.json()["prId"]

            def h(user: str, manage: bool) -> dict:
                return {"X-User": user, "X-Manage": "1" if manage else "0"}

            async def reads(user: str, manage: bool = False) -> list:
                return [r.status_code for r in (
                    await c.post(f"{GP}/nodes/query", params={"dataSourceId": ds, "branchId": d},
                                 json={"query": {}}, headers=h(user, manage)),
                    await c.get(f"{V1}/graphs/{gid}/branches/{d}/state", headers=h(user, manage)),
                    await c.get(f"{V1}/graphs/{gid}/branches/{d}/freshness", headers=h(user, manage)),
                    await c.get(f"{V1}/graphs/{gid}/commits", params={"branchId": d}, headers=h(user, manage)),
                    await c.get(f"{V1}/merge-requests/{pr}", headers=h(user, manage)),
                    await c.get(f"{V1}/pulls/{pr}", headers=h(user, manage)),
                )]

            async def listed(user: str, manage: bool = False) -> tuple:
                drafts = await c.get(f"{V1}/graphs/{gid}/branches", headers=h(user, manage))
                prs = await c.get(f"{V1}/graphs/{gid}/merge-requests", headers=h(user, manage))
                by_ds = await c.get(f"{V1}/data-sources/{ds}/pull-requests", headers=h(user, manage))
                assert drafts.status_code == prs.status_code == by_ds.status_code == 200
                return (d in {b["branchId"] for b in drafts.json()},
                        pr in {p["prId"] for p in prs.json()},
                        pr in {p["prId"] for p in by_ds.json()})

            ok, hidden = [200] * 6, [404] * 6
            # Private: the owner, the reviewer; not a reader, not a manager who is neither.
            assert await reads("alice") == ok
            assert await reads("dave") == ok
            assert await reads("bob") == hidden
            assert await reads("carol", manage=True) == hidden
            assert await listed("alice") == (True, True, True)
            assert await listed("dave") == (True, True, True)
            assert await listed("bob") == (False, False, False)
            assert await listed("carol", manage=True) == (False, False, False)

            # Public: everyone who reads the data source.
            await _set_visibility(d, "public")
            assert await reads("bob") == ok
            assert await reads("carol", manage=True) == ok
            assert await listed("bob") == (True, True, True)
            assert await listed("carol", manage=True) == (True, True, True)

            await _set_visibility(d, "private")
            assert await reads("bob") == hidden
            assert await listed("carol", manage=True) == (False, False, False)
    finally:
        G.provider_manager, G.get_graph_cache = orig_pm, orig_cache
        await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_a_draft_is_read_by_those_its_level_lets_in_and_its_review_follows_it(data_sources):
    asyncio.run(_reads_run())
