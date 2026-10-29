"""Stage 2 as a whole: several people draft, share, pull, review and merge one versioned graph —
over HTTP, needs Postgres and FalkorDB (GRAPHVER_E2E=1).

Pat publishes; Alice, Bob, Carol and Rita manage. Pat seeds main. Alice and Bob each open a private
draft: to Bob and to Pat, managers both, Alice's doesn't exist (404), written or read. Bob, who
can't publish, may not write main directly (403 ``publish_required``). Alice shares her draft with
``grp_eng``, and with Pat as a viewer so he can merge it: Carol, through the group, edits it; to
Bob, no member, it still doesn't exist. Pat publishes a change to the field Alice edited; her pull
conflicts and she resolves it. Alice asks Rita to review; Carol's edit after Rita's approval makes
it stale, so Pat's merge is 409 ``approval_required`` naming Rita as stale. Rita's approval of the
head she saw is 409 ``head_moved``; she approves the new head. Bob, without publish, may not merge;
Pat merges. The merged node's history, the watermark and the
graph-store placement then say who changed it and where it lives.

Faked: the data source row (pinned to a ``gvt_`` key on a provider row for this run's FalkorDB),
the users and groups, and the graph-store topology sweep, as in the harnesses imported below.
"""
import asyncio
import os
from types import SimpleNamespace

import pytest

from backend.app.services.versioning import db, models, service

from .test_api_graph_draft_journey import _IMPORT_NDJSON, _StubCache, _StubManager
from .test_graph_store_placement_by_graph import _snapshot
from .test_private_draft_read import _app
from . import test_shared_draft_members as SDM
from .test_shared_draft_members import directory  # noqa: F401  (autouse: users, groups, names)

_PUBLISHERS = {"pat"}
_GROUPS = {"carol": ("grp_eng",)}


def _as(user, manage=True):
    """``user``'s headers: everyone manages, only Pat publishes."""
    return {"X-User": user, "X-Manage": "1" if manage else "0",
            "X-Publish": "1" if user in _PUBLISHERS else "0"}


def _denied(r, code, **fields):
    assert r.status_code == 403, (r.request.url, r.text)
    detail = r.json()["detail"]
    assert (detail["type"], detail["code"]) == ("access_denied", code), detail
    assert {k: detail[k] for k in fields} == fields, detail


def _save(urn, name):
    return {"ops": [{"op": "update", "kind": "node", "id": urn, "payload": {"displayName": name}}]}


async def _story(prov: str, key: str) -> None:
    from httpx import ASGITransport, AsyncClient

    from backend.app.api.v1.endpoints import graph_store as GS
    from backend.app.api.v1.endpoints import versioning as V
    from backend.app.db.engine import close_db

    await models.create_schema_and_partitions()
    await _provider(prov)
    app, G = _app()
    app.include_router(GS.router, prefix="/api/v1/admin/graph-store")
    orig = G.provider_manager, G.get_graph_cache, V.get_graph_cache
    G.provider_manager = _StubManager()
    G.get_graph_cache = V.get_graph_cache = lambda: _StubCache()
    ds = "ds_" + os.urandom(4).hex()
    V1, GP = "/api/v1/ws1/versioning", "/api/v1/ws1/graph"
    try:
        c = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
        async with c:
            # 1. Pat puts the data source under version control and seeds main.
            r = await c.post(f"{V1}/graphs", json={"dataSourceId": ds, "workspaceId": "ws1"}, headers=_as("pat"))
            assert r.status_code == 201, r.text
            gid, main_id = r.json()["graphId"], r.json()["mainBranchId"]
            r = await c.post(f"{V1}/graphs/{gid}/bulk-ingest", content=_IMPORT_NDJSON, headers=_as("pat"))
            assert r.status_code == 200 and r.json()["ingested"] == 3, r.text

            # 2. Alice and Bob each open a private draft; Alice edits hers.
            drafts = {}
            for who in ("alice", "bob"):
                r = await c.post(f"{V1}/graphs/{gid}/branches", json={"visibility": "private"},
                                 headers=_as(who))
                assert r.status_code in (200, 201), r.text
                drafts[who] = r.json()["branchId"]
            d = drafts["alice"]
            B, qd = f"{V1}/graphs/{gid}/branches/{d}", {"dataSourceId": ds, "branchId": d}
            r = await c.post(f"{GP}/changes", params=qd, json=_save("urn:t:child", "Alice's child"),
                             headers=_as("alice"))
            assert r.status_code == 200, r.text
            r = await c.post(f"{GP}/changes", params=qd, json=_save("urn:t:child", "Bob's"), headers=_as("bob"))
            assert r.status_code == 404, r.text
            # Managing the workspace opens no private draft: whoever reads it, with manage or
            # without, is told it isn't there.
            for h in (_as("bob", manage=False), _as("bob"), _as("pat")):
                r = await c.get(f"{B}/state", headers=h)
                assert r.status_code == 404, r.text
                r = await c.post(f"{GP}/nodes/query", params=qd, json={"query": {}}, headers=h)
                assert r.status_code == 404, r.text
            st = (await c.get(f"{B}/state", headers=_as("alice"))).json()["nodes"]
            assert st["urn:t:child"]["displayName"] == "Alice's child", st

            # 3. Bob can't publish, so he may not write main directly.
            r = await c.post(f"{GP}/nodes/create", params={"dataSourceId": ds}, headers=_as("bob"),
                             json={"entityType": "Table", "displayName": "Bob on main", "parentUrn": "urn:t:root"})
            _denied(r, "publish_required", required="workspace:datasource:publish")

            # 4. Alice shares her draft with grp_eng as editors and with Pat, who will merge it, as a
            #    viewer: Carol edits it, Bob is no member.
            for subject, kind, role in (("grp_eng", "group", "editor"), ("pat", "user", "viewer")):
                r = await c.post(f"{B}/members", headers=_as("alice"),
                                 json={"subjectType": kind, "subjectId": subject, "role": role})
                assert r.status_code == 200, r.text
            r = await c.get(B, headers=_as("alice"))
            assert (r.json()["visibility"], r.json()["isShared"]) == ("private", True), r.text
            r = await c.post(f"{GP}/changes", params=qd, json=_save("urn:t:root", "Carol's root"),
                             headers=_as("carol"))
            assert r.status_code == 200, r.text
            r = await c.post(f"{GP}/changes", params=qd, json=_save("urn:t:root", "Bob's root"), headers=_as("bob"))
            assert r.status_code == 404, r.text

            # 5. Pat publishes a change to the field Alice edited; her pull conflicts, she keeps hers.
            r = await c.post(f"{V1}/graphs/{gid}/branches", json={}, headers=_as("pat"))
            assert r.status_code in (200, 201), r.text
            p = r.json()["branchId"]
            r = await c.post(f"{GP}/changes", params={"dataSourceId": ds, "branchId": p},
                             json=_save("urn:t:child", "Pat's child"), headers=_as("pat"))
            assert r.status_code == 200, r.text
            r = await c.post(f"{V1}/graphs/{gid}/branches/{p}/publish", json={"message": "pat renames child"},
                             headers=_as("pat"))
            assert r.status_code == 200, r.text
            r = await c.post(f"{B}/rebase", json={}, headers=_as("alice"))
            assert r.status_code == 200 and r.json()["clean"] is False, r.text
            pulled = r.json()
            assert [(x["entity_id"], x["path"], x["ours"], x["theirs"]) for x in pulled["conflicts"]] == [
                ("urn:t:child", ["displayName"], "Alice's child", "Pat's child"),
                # a rename carries the source's name property with it (#595), so it clashes too
                ("urn:t:child", ["properties", "name"], "Alice's child", "Pat's child")], pulled
            mine = pulled["seeds"]["urn:t:child"]
            assert mine["displayName"] == "Alice's child", mine
            r = await c.post(f"{B}/rebase", json={"resolutions": {"urn:t:child": mine}}, headers=_as("alice"))
            assert r.status_code == 200 and r.json()["clean"] is True, r.text
            st = (await c.get(f"{B}/state", headers=_as("alice"))).json()["nodes"]
            assert (st["urn:t:child"]["displayName"], st["urn:t:root"]["displayName"]) == (
                "Alice's child", "Carol's root"), st

            # 6. Alice asks Rita to review. Carol's edit after Rita approved makes the approval stale:
            #    Pat may not merge until Rita approves what would now merge.
            r = await c.post(f"{B}/merge-requests", json={"title": "Rename child", "reviewers": ["rita"]},
                             headers=_as("alice"))
            assert r.status_code == 201, r.text
            pr = f"{V1}/merge-requests/{r.json()['prId']}"
            seen = (await c.get(pr, headers=_as("rita"))).json()["headCommitId"]
            r = await c.post(f"{pr}/approve", json={"expectedHeadCommitId": seen}, headers=_as("rita"))
            assert r.status_code == 200 and r.json()["approvedBy"] == ["rita"], r.text
            r = await c.post(f"{GP}/changes", params=qd, json=_save("urn:t:root", "Carol's root v2"),
                             headers=_as("carol"))
            assert r.status_code == 200, r.text
            r = await c.post(f"{pr}/merge", json={"message": "ship it"}, headers=_as("pat"))
            assert r.status_code == 409, r.text
            assert r.json()["detail"] == {"type": "approval_required", "pending": ["rita"], "stale": ["rita"]}, r.text
            head = (await c.get(pr, headers=_as("rita"))).json()["headCommitId"]
            assert head != seen
            r = await c.post(f"{pr}/approve", json={"expectedHeadCommitId": seen}, headers=_as("rita"))
            assert r.status_code == 409, r.text
            assert (r.json()["detail"]["type"], r.json()["detail"]["headCommitId"]) == ("head_moved", head), r.text
            r = await c.post(f"{pr}/approve", json={"expectedHeadCommitId": head}, headers=_as("rita"))
            assert r.status_code == 200 and r.json()["staleApprovedBy"] == [], r.text
            r = await c.post(f"{pr}/merge", json={"message": "ship it"}, headers=_as("bob"))
            assert r.status_code == 403, r.text
            assert r.json()["detail"]["permission"] == "workspace:datasource:publish", r.text
            r = await c.post(f"{pr}/merge", json={"message": "ship it"}, headers=_as("pat"))
            assert r.status_code == 200, r.text
            merged = r.json()["commitId"]
            st = (await c.get(f"{V1}/graphs/{gid}/branches/{main_id}/state", headers=_as("bob"))).json()["nodes"]
            assert (st["urn:t:child"]["displayName"], st["urn:t:root"]["displayName"]) == (
                "Alice's child", "Carol's root v2"), st

            # 7. Who changed it: Pat merged Alice's PR, Alice and Carol wrote it.
            pr_now = (await c.get(pr, headers=_as("pat"))).json()
            assert (pr_now["actor"], pr_now["mergedBy"], pr_now["mergedVia"], pr_now["resultingCommitId"]) == (
                "alice", "pat", "review", merged), pr_now
            r = await c.get(f"{V1}/graphs/{gid}/entities/urn:t:child/history", headers=_as("bob"))
            assert r.status_code == 200, r.text
            last = r.json()["versions"][0]
            assert (last["commit_id"], last["actor"], last["commit_message"]) == (merged, "pat", "ship it"), last
            assert last["changes"] == [{"path": ["displayName"], "kind": "changed",
                                        "before": "Pat's child", "after": "Alice's child"},
                                       {"path": ["properties", "name"], "kind": "changed",
                                        "before": "Pat's child", "after": "Alice's child"}], last
            log = (await c.get(f"{V1}/graphs/{gid}/commits", headers=_as("bob"))).json()["commits"]
            assert (log[0]["commit_id"], log[0]["actor"], log[0]["contributors"]) == (
                merged, "pat", ["alice", "carol"]), log[0]

            # Where it lives: the merge was projected into the data source's pinned key, on its provider.
            wm = (await c.get(f"{V1}/graphs/{gid}/watermark", headers=_as("bob"))).json()
            assert (wm["projectionKey"], wm["providerId"]) == (key, prov), wm
            assert wm["fresh"] is True and wm["projectedRevision"]["commitId"] == merged, wm
            r = await c.get("/api/v1/admin/graph-store/placement", params={"graphId": gid}, headers=_as("bob"))
            assert r.status_code == 200, r.text
            assert r.json()["providerId"] == prov, r.text
            assert [p["graphKey"] for p in r.json()["placements"]] == [key], r.text
    finally:
        G.provider_manager, G.get_graph_cache, V.get_graph_cache = orig
        await db.dispose_engine()
        await close_db()


async def _provider(prov: str) -> None:
    """The FalkorDB provider the data source is pinned to: this run's FalkorDB."""
    from backend.app.db.engine import PoolRole, get_engine, get_session_factory
    from backend.app.db.models import Base as MgmtBase, ProviderORM

    async with get_engine(PoolRole.WEB).begin() as conn:
        await conn.run_sync(MgmtBase.metadata.create_all, tables=[ProviderORM.__table__])
    async with get_session_factory(PoolRole.WEB)() as s:
        s.add(ProviderORM(id=prov, name="Falkor Story", provider_type="falkordb",
                          host=os.getenv("FALKORDB_HOST", "falkordb"), port=int(os.getenv("FALKORDB_PORT", "6379"))))
        await s.commit()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_stage2_collaboration_story(monkeypatch):
    from backend.app.db.repositories import data_source_repo
    from backend.app.services.graph_store import topology

    sfx = os.urandom(3).hex()
    prov, key = f"prov_story_{sfx}", f"gvt_story_{sfx}"   # gvt_: the session cleanup drops the key

    async def get_data_source_orm(session, data_source_id, **_kw):
        return SimpleNamespace(id=data_source_id, workspace_id="ws1", graph_name=key, provider_id=prov,
                               ontology_id=None)

    async def groups(actor):
        return _GROUPS.get(actor, ())

    async def snapshot(*, fresh=False, wait_s=0.0):
        return _snapshot(prov, [key]), False

    monkeypatch.setattr(SDM, "_USERS", SDM._USERS | {"pat"})          # Pat is shared the draft
    monkeypatch.setattr(data_source_repo, "get_data_source_orm", get_data_source_orm)
    monkeypatch.setattr(service, "_load_actor_groups", groups)
    monkeypatch.setattr(topology, "snapshot_for_request", snapshot)
    asyncio.run(_story(prov, key))
