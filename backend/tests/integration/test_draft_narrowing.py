"""A draft changes level, and nobody's unsaved edits are lost on the way — over HTTP, needs Postgres.

* Its owner or a maintainer changes it (``POST …/visibility``); anyone else is refused. The data
  source's policy holds: a level it rules out is 409.
* Made public, everyone who reads the data source reads it, and everyone who changes it writes it.
* Made private, the writers who lose it — not its owner, not its editor or maintainer members — have
  what they staged committed first, each under their own name, in the order they staged it. They
  then read it no more (404). A member keeps what they staged.
* If two of them staged clashing changes, the second can't be saved: 409 ``staged_changes_unsaved``
  naming them, and the draft keeps its level (what the first staged is saved).
* ``…/visibility-impact`` says beforehand whose edits will be saved, and how many.
* Removing a member, or making them a viewer, commits what they staged first too.
"""
import asyncio
import os
from types import SimpleNamespace

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.service import GraphVersioningService

from .test_api_graph_draft_journey import _IMPORT_NDJSON, _StubCache, _StubManager
from .test_private_draft_read import _app


def _stage(eid: str, **fields) -> dict:
    return {"ops": [{"op": "update", "entityKind": "node", "entityId": eid,
                     "payload": {"entityType": "Table", **fields}}]}


async def _narrowing_run(monkeypatch) -> None:
    from httpx import ASGITransport, AsyncClient
    from backend.app.services import drafts_policy

    await models.create_schema_and_partitions()
    app, G = _app()
    orig_pm, orig_cache = G.provider_manager, G.get_graph_cache
    G.provider_manager = _StubManager()
    G.get_graph_cache = lambda: _StubCache()
    ds = "ds_" + os.urandom(4).hex()
    V1 = "/api/v1/ws1/versioning"
    svc = GraphVersioningService()

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

            async def level(bid: str, to: str, who: str = "alice"):
                return await c.post(f"{B}/{bid}/visibility", json={"visibility": to}, headers=h(who))

            async def staged(bid: str, who: str, eid: str, **fields):
                r = await c.post(f"{B}/{bid}/changes", json=_stage(eid, **fields), headers=h(who))
                assert r.status_code == 200, r.text

            # Widened: Bob, who only reads the data source, reads it; Carol, who changes it, writes it.
            d = (await c.post(B, json={"visibility": "private"}, headers=h("alice"))).json()["branchId"]
            assert (await c.get(f"{B}/{d}", headers=h("bob", manage=False))).status_code == 404
            r = await level(d, "public")
            assert r.status_code == 200 and r.json()["visibility"] == "public", r.text
            assert (await c.get(f"{B}/{d}", headers=h("bob", manage=False))).status_code == 200
            r = await level(d, "private", who="carol")                 # a writer, not its maintainer
            assert (r.status_code, r.json()["detail"]["code"]) == (403, "not_draft_owner"), r.text

            # Narrowed: Bob's and Carol's staged edits are saved under their names first; Dave, a
            # member editor, keeps his staged.
            await svc.add_branch_member(graph_id=gid, branch_id=d, subject_type="user", subject_id="dave",
                                        role="editor", actor="alice")
            await staged(d, "bob", "urn:t:child", description="from bob")
            await staged(d, "carol", "urn:t:root", description="from carol")
            await staged(d, "dave", "urn:t:child", displayName="Dave's child")
            r = await c.get(f"{B}/{d}/visibility-impact", params={"visibility": "private"}, headers=h("alice"))
            assert r.status_code == 200, r.text
            assert r.json()["saved"] == [{"actor": "bob", "changes": 1}, {"actor": "carol", "changes": 1}]
            r = await level(d, "private")
            assert r.status_code == 200 and r.json()["visibility"] == "private", r.text
            log = (await c.get(f"{V1}/graphs/{gid}/commits", params={"branchId": d}, headers=h("alice"))).json()
            assert [cm["actor"] for cm in log["commits"][:2]] == ["carol", "bob"], log
            st = (await c.get(f"{B}/{d}/state", headers=h("alice"))).json()["nodes"]
            assert (st["urn:t:child"].get("description"), st["urn:t:root"].get("description")) == (
                "from bob", "from carol"), st
            for who in ("bob", "carol"):
                assert (await c.get(f"{B}/{d}", headers=h(who))).status_code == 404
            r = await c.post(f"{B}/{d}/commit", json={}, headers=h("dave"))
            assert r.status_code == 200 and r.json()["stagedChanges"] is True, r.text   # still his

            # A clash between two who lose it: the second can't be saved; the level stays.
            e = (await c.post(B, json={"visibility": "public"}, headers=h("alice"))).json()["branchId"]
            await staged(e, "bob", "urn:t:child", description="bob's")
            await staged(e, "carol", "urn:t:child", description="carol's")
            r = await level(e, "private")
            assert r.status_code == 409, r.text
            assert (r.json()["detail"]["type"], r.json()["detail"]["actors"]) == (
                "staged_changes_unsaved", ["carol"]), r.text
            assert (await c.get(f"{B}/{e}", headers=h("alice"))).json()["visibility"] == "public"

            # The policy holds on a change of level too.
            async def public_only(_s, _ds):
                return drafts_policy.resolve(None, SimpleNamespace(draft_levels="public_only"))
            monkeypatch.setattr(drafts_policy, "load", public_only)
            r = await level(e, "private")
            assert (r.status_code, r.json()["detail"]["type"]) == (409, "private_drafts_disabled"), r.text
            monkeypatch.undo()

            # A member removed, or made a viewer, has what they staged committed first.
            f = (await c.post(B, json={"visibility": "private"}, headers=h("alice"))).json()["branchId"]
            for who in ("erin", "frank"):
                await svc.add_branch_member(graph_id=gid, branch_id=f, subject_type="user", subject_id=who,
                                            role="editor", actor="alice")
            await staged(f, "erin", "urn:t:child", description="erin's")
            await staged(f, "frank", "urn:t:root", description="frank's")
            await svc.remove_branch_member(graph_id=gid, branch_id=f, subject_type="user",
                                           subject_id="erin", actor="alice")
            await svc.add_branch_member(graph_id=gid, branch_id=f, subject_type="user", subject_id="frank",
                                        role="viewer", actor="alice")
            log = (await c.get(f"{V1}/graphs/{gid}/commits", params={"branchId": f}, headers=h("alice"))).json()
            assert [cm["actor"] for cm in log["commits"][:2]] == ["frank", "erin"], log
    finally:
        G.provider_manager, G.get_graph_cache = orig_pm, orig_cache
        await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_a_draft_changes_level_and_no_ones_unsaved_edits_are_lost(data_sources, monkeypatch):
    asyncio.run(_narrowing_run(monkeypatch))
