"""A draft changes hands — over HTTP, needs Postgres.

* Its owner hands it to someone else at any time (``POST …/transfer``); its maintainers can't. The
  previous owner stays on as a maintainer, and what they staged stays theirs.
* With ``keepPrevious: false`` the previous owner keeps nothing: what they staged is committed
  first, under their name, and a private draft is then unknown to them (404).
* A workspace admin hands on a draft only once its owner has left the workspace; until then it is
  its owner's, and a private one is unknown to the admin (404).
* ``GET …/drafts/owner-left`` (workspace admins) lists the open drafts whose owner left: their
  name, owner, level and status, never their content.
* Who it goes to must be an active person who changes the workspace's data sources (422
  ``ineligible_owner``, decided in test_draft_transfer_routes.py); a closed draft stays as it is.
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


async def _transfer_run(monkeypatch) -> None:
    from fastapi import Request
    from httpx import ASGITransport, AsyncClient
    from backend.app.api.v1.endpoints import versioning as ep
    from backend.app.auth.dependencies import get_permission_claims
    from backend.app.services.permission_service import PermissionClaims
    from backend.app.services.versioning.errors import IneligibleOwner

    await models.create_schema_and_partitions()
    app, G = _app()

    async def header_claims(request: Request):          # everyone changes the data source; X-Admin
        perms = ("workspace:datasource:read", "workspace:datasource:manage",
                 "workspace:datasource:publish")
        if request.headers.get("X-Admin") == "1":
            perms += ("workspace:admin",)
        return PermissionClaims(sid="", global_perms=(), ws_perms={"ws1": perms})
    app.dependency_overrides[get_permission_claims] = header_claims

    left = set()                                         # who has left the workspace

    async def who_left(_session, _ws_id, owners):
        return {o for o in owners if o in left}
    monkeypatch.setattr(ep, "_owners_who_left", who_left)

    async def eligible(_session, _ws_id, user_id):
        if user_id == "vic":                              # reads the data source, changes nothing
            raise IneligibleOwner(user_id, "no_manage")
    monkeypatch.setattr(ep, "_assert_owner_eligible", eligible)

    orig_pm, orig_cache = G.provider_manager, G.get_graph_cache
    G.provider_manager = _StubManager()
    G.get_graph_cache = lambda: _StubCache()
    ds = "ds_" + os.urandom(4).hex()
    V1 = "/api/v1/ws1/versioning"

    def h(user: str, admin: bool = False) -> dict:
        return {"X-User": user, **({"X-Admin": "1"} if admin else {})}

    try:
        c = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
        async with c:
            r = await c.post(f"{V1}/graphs", json={"dataSourceId": ds, "workspaceId": "ws1"}, headers=h("alice"))
            assert r.status_code == 201, r.text
            gid = r.json()["graphId"]
            r = await c.post(f"{V1}/graphs/{gid}/bulk-ingest", content=_IMPORT_NDJSON, headers=h("alice"))
            assert r.status_code == 200, r.text
            B = f"{V1}/graphs/{gid}/branches"

            async def transfer(bid: str, to: str, who: str, admin: bool = False, **body):
                return await c.post(f"{B}/{bid}/transfer", json={"to": to, **body}, headers=h(who, admin))

            async def staged(bid: str, who: str, eid: str, **fields):
                r = await c.post(f"{B}/{bid}/changes", json=_stage(eid, **fields), headers=h(who))
                assert r.status_code == 200, r.text

            async def owner_left():
                r = await c.get(f"{V1}/drafts/owner-left", headers=h("dave", admin=True))
                assert r.status_code == 200, r.text
                return {x["branchId"]: x for x in r.json() if x["graphId"] == gid}

            # Alice hands her private draft to Bob; she stays on as a maintainer, with what she staged.
            d = (await c.post(B, json={"visibility": "private"}, headers=h("alice"))).json()["branchId"]
            await staged(d, "alice", "urn:t:child", description="alice's")
            r = await transfer(d, "bob", "alice")
            assert r.status_code == 200 and r.json()["owner"] == "bob", r.text
            members = (await c.get(f"{B}/{d}/members", headers=h("bob"))).json()["members"]
            assert [(m["subjectId"], m["role"]) for m in members] == [("alice", "maintainer")], members
            r = await c.post(f"{B}/{d}/commit", json={}, headers=h("alice"))
            assert r.status_code == 200 and r.json()["stagedChanges"] is True, r.text     # still hers

            # Only its owner hands it on: not a maintainer.
            r = await transfer(d, "carol", "alice")
            assert (r.status_code, r.json()["detail"]["code"]) == (403, "not_draft_owner"), r.text

            # keepPrevious false: what Bob staged is committed under his name first; then the private
            # draft is unknown to him.
            await staged(d, "bob", "urn:t:root", description="bob's")
            r = await transfer(d, "carol", "bob", keepPrevious=False)
            assert r.status_code == 200 and r.json()["owner"] == "carol", r.text
            log = (await c.get(f"{V1}/graphs/{gid}/commits", params={"branchId": d}, headers=h("carol"))).json()
            assert log["commits"][0]["actor"] == "bob", log
            st = (await c.get(f"{B}/{d}/state", headers=h("carol"))).json()["nodes"]
            assert st["urn:t:root"].get("description") == "bob's", st
            assert (await c.get(f"{B}/{d}", headers=h("bob"))).status_code == 404

            # A workspace admin: not while its owner is here (and it is private: unknown to them) …
            r = await transfer(d, "erin", "dave", admin=True)
            assert r.status_code == 404, r.text
            assert d not in await owner_left()
            assert (await c.get(f"{V1}/drafts/owner-left", headers=h("erin"))).status_code == 403
            # … once its owner has left, listed for them and handed on.
            left.add("carol")
            listed = (await owner_left())[d]
            assert {k: listed[k] for k in ("dataSourceId", "owner", "visibility", "status")} == {
                "dataSourceId": ds, "owner": "carol", "visibility": "private", "status": "open"}, listed
            assert "headCommitId" not in listed, "what it holds is not an admin's to see"
            r = await transfer(d, "erin", "dave", admin=True)
            assert r.status_code == 200 and r.json()["owner"] == "erin", r.text
            assert d not in await owner_left()
            assert (await c.get(f"{B}/{d}", headers=h("erin"))).status_code == 200

            # Someone who can't change the data source can't own it; a closed draft stays as it is.
            r = await transfer(d, "vic", "erin")
            assert (r.status_code, r.json()["detail"]["type"]) == (422, "ineligible_owner"), r.text
            assert (await c.post(f"{B}/{d}/abandon", headers=h("erin"))).status_code == 200
            r = await transfer(d, "bob", "erin")
            assert (r.status_code, r.json()["detail"]["type"]) == (409, "branch_closed"), r.text
    finally:
        G.provider_manager, G.get_graph_cache = orig_pm, orig_cache
        await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_a_draft_changes_hands(data_sources, monkeypatch):
    asyncio.run(_transfer_run(monkeypatch))
