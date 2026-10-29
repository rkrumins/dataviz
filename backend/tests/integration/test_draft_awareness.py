"""Who else is working on a draft, as its readers see it — over HTTP, needs Postgres.

* The freshness poll (``GET …/freshness``) says the draft's own head (``headCommitSeq``), its level
  and what the caller may do with it (``access``): a write lost to a change of level shows on the
  next poll, and a draft they may no longer read is a 404.
* With ``sinceSeq`` (the head the client last saw) it says what others committed to the draft since:
  ``savedSince`` {commits, changes, by, capped} — never the caller's own, and the newest of others'
  commits only, so an old ``sinceSeq`` costs no more. ``by``: most commits first, then the latest.
* ``GET …/branches/{id}`` names who committed to the draft (``contributors``), in the same order.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models

from .test_api_graph_draft_journey import _IMPORT_NDJSON, _StubCache, _StubManager
from .test_private_draft_read import _app


def _stage(eid: str, **fields) -> dict:
    return {"ops": [{"op": "update", "entityKind": "node", "entityId": eid,
                     "payload": {"entityType": "Table", **fields}}]}


async def _awareness_run(monkeypatch) -> None:
    from httpx import ASGITransport, AsyncClient
    from backend.app.services.versioning import service as versioning_service

    await models.create_schema_and_partitions()
    app, G = _app()
    orig_pm, orig_cache = G.provider_manager, G.get_graph_cache
    G.provider_manager = _StubManager()
    G.get_graph_cache = lambda: _StubCache()
    ds = "ds_" + os.urandom(4).hex()
    V1 = "/api/v1/ws1/versioning"

    def h(user: str, manage: bool = True) -> dict:
        return {"X-User": user, "X-Manage": "1" if manage else "0", "X-Publish": "1"}

    try:
        c = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
        async with c:
            r = await c.post(f"{V1}/graphs", json={"dataSourceId": ds, "workspaceId": "ws1"}, headers=h("alice"))
            assert r.status_code == 201, r.text
            gid = r.json()["graphId"]
            r = await c.post(f"{V1}/graphs/{gid}/bulk-ingest", content=_IMPORT_NDJSON, headers=h("alice"))
            assert r.status_code == 200, r.text
            B = f"{V1}/graphs/{gid}/branches"

            async def saved(bid: str, who: str, eid: str, **fields):
                r = await c.post(f"{B}/{bid}/changes", json=_stage(eid, **fields), headers=h(who))
                assert r.status_code == 200, r.text
                r = await c.post(f"{B}/{bid}/commit", json={}, headers=h(who))
                assert r.status_code == 200 and r.json()["stagedChanges"] is True, r.text

            async def poll(bid: str, who: str, since=None, manage: bool = True):
                params = {} if since is None else {"sinceSeq": since}
                return await c.get(f"{B}/{bid}/freshness", params=params, headers=h(who, manage))

            d = (await c.post(B, json={"visibility": "public"}, headers=h("alice"))).json()["branchId"]
            r = await poll(d, "alice")
            assert r.status_code == 200, r.text
            first = r.json()
            assert (first["headCommitSeq"], first["visibility"], first["savedSince"]) == (0, "public", None), first
            assert first["access"] == {"canRead": True, "canWrite": True, "canManage": True}, first
            r = await poll(d, "vic", manage=False)                  # reads the data source only
            assert r.json()["access"] == {"canRead": True, "canWrite": False, "canManage": False}, r.text

            # Bob saves twice and Carol once; Alice's own save is not news to her.
            await saved(d, "bob", "urn:t:child", description="bob 1")
            await saved(d, "bob", "urn:t:root", description="bob 2")
            await saved(d, "carol", "urn:t:child", displayName="carol's")
            await saved(d, "alice", "urn:t:root", displayName="alice's")
            r = await poll(d, "alice", since=0)
            news = r.json()
            assert news["headCommitSeq"] == 4, news
            assert news["savedSince"] == {"commits": 3, "changes": 3, "by": ["bob", "carol"],
                                          "capped": False}, news
            r = await poll(d, "alice", since=news["headCommitSeq"])
            assert r.json()["savedSince"] == {"commits": 0, "changes": 0, "by": [], "capped": False}, r.text
            r = await poll(d, "bob", since=2)                        # Carol's and Alice's since his
            assert r.json()["savedSince"] == {"commits": 2, "changes": 2, "by": ["alice", "carol"],
                                              "capped": False}, r.text

            # An old sinceSeq reads the newest of others' commits only, and says so.
            monkeypatch.setattr(versioning_service, "_SAVED_SINCE_SCAN", 2)
            r = await poll(d, "alice", since=0)
            assert r.json()["savedSince"] == {"commits": 2, "changes": 2, "by": ["carol", "bob"],
                                              "capped": True}, r.text
            monkeypatch.undo()

            # Who committed to it, most commits first, then the latest.
            r = await c.get(f"{B}/{d}", headers=h("alice"))
            assert r.status_code == 200 and r.json()["contributors"] == ["bob", "alice", "carol"], r.text

            # Made private: Bob's next poll says it is gone; Alice's says she still manages it.
            r = await c.post(f"{B}/{d}/visibility", json={"visibility": "private"}, headers=h("alice"))
            assert r.status_code == 200, r.text
            assert (await poll(d, "bob")).status_code == 404
            r = await poll(d, "alice")
            assert (r.json()["visibility"], r.json()["access"]["canManage"]) == ("private", True), r.text
    finally:
        G.provider_manager, G.get_graph_cache = orig_pm, orig_cache
        await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_a_drafts_readers_see_who_else_is_working_on_it(data_sources, monkeypatch):
    asyncio.run(_awareness_run(monkeypatch))
