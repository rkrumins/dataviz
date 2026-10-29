"""A person needs publish to write a versioned graph's main directly — needs Postgres.

The graph router's writes with no draft (``/nodes/create``, ``/edges``, ``PATCH``/``DELETE
/edges/{id}``, ``/commands/batch``, ``/save``) and ``…/bulk-ingest`` commit straight to ``main``. A
person without ``workspace:datasource:publish`` gets 403 ``publish_required`` and nothing lands; a
publisher's write lands; an API key (none holds publish) writes main only when the person who owns
it holds publish; and a manage-only owner's write to their draft, in person or with their key, is
unaffected. Main is written down both of its paths: from Postgres while the projection is behind,
and through the write-through wrapper once it has caught up.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.service import GraphVersioningService

pytestmark = pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"),
                                reason="set GRAPHVER_E2E=1 + a live Postgres to run")

V1, GP = "/api/v1/ws1/versioning", "/api/v1/ws1/graph"
MIA, PAT = {"X-User": "mia"}, {"X-User": "pat"}
MIA_KEY, PAT_KEY = {"X-User": "mia", "X-Key": "mia-key"}, {"X-User": "pat", "X-Key": "pat-key"}


def _app():
    """The real routers. ``mia`` holds read and manage (a workspace_member); ``pat`` holds publish
    as well (a workspace_publisher). With ``X-Key`` the request is made with a key that person
    owns: read and manage, as every key holds at most, and where its owner may publish."""
    from fastapi import Request
    from types import SimpleNamespace
    from backend.app.auth.dependencies import get_current_user, get_optional_user, get_permission_claims
    from backend.app.services.permission_service import KeyScope, PermissionClaims
    from .test_api_graph_draft_journey import _build_app

    app, G = _build_app()

    async def header_user(request: Request):
        uid = request.headers.get("X-User", "pat")
        return SimpleNamespace(id=uid, email=f"{uid}@example.com")

    async def claims(request: Request):
        who = request.headers.get("X-User", "pat")
        perms = ("workspace:datasource:read", "workspace:datasource:manage")
        if who == "pat":
            perms += ("workspace:datasource:publish",)
        scope = None
        if request.headers.get("X-Key"):
            scope = KeyScope(key_id="k", data="write", all_resources=True, owner_publish_workspaces=frozenset(
                {"ws1"} if "workspace:datasource:publish" in perms else ()))
            perms = ("workspace:datasource:read", "workspace:datasource:manage")
        return PermissionClaims(sid="", global_perms=(), ws_perms={"ws1": perms}, key_scope=scope)

    app.dependency_overrides[get_current_user] = header_user
    app.dependency_overrides[get_optional_user] = header_user
    app.dependency_overrides[get_permission_claims] = claims
    return app, G


def _refused(r):
    assert r.status_code == 403, r.text
    d = r.json()["detail"]
    assert (d["type"], d["code"], d["required"]) == (
        "access_denied", "publish_required", "workspace:datasource:publish"), r.text
    assert "draft" in d["message"], r.text


async def _main_head(svc, gid):
    return (await svc.commit_log(graph_id=gid, limit=1))[0]["commit_id"]


async def _main_writes(c, ds, who, edge_id, a, b):
    """Every graph-router write to main, as ``who``, around the edge ``edge_id`` from ``a`` to ``b``;
    each answer in order."""
    q, name = {"dataSourceId": ds}, who.get("X-Key", who["X-User"])
    return [
        await c.post(f"{GP}/nodes/create", params=q, headers=who,
                     json={"entityType": "Table", "displayName": f"{name} node"}),
        await c.post(f"{GP}/edges", params=q, headers=who,
                     json={"sourceUrn": b, "targetUrn": a, "edgeType": "LINEAGE"}),
        await c.patch(f"{GP}/edges/{edge_id}", params=q, headers=who,
                      json={"properties": {"by": name}}),
        await c.post(f"{GP}/commands/batch", params=q, headers=who, json={"commands": [
            {"op": "create_node", "payload": {"entityType": "Table", "displayName": "batch"}}]}),
        await c.post(f"{GP}/save", params=q, headers=who, json={"nodes": [
            {"urn": f"urn:s:{name}", "entityType": "Table", "displayName": "saved"}],
            "edges": []}),
        await c.delete(f"{GP}/edges/{edge_id}", params=q, headers=who),
    ]


def _seed(eid, a, b):
    node = lambda u: {"op": "create", "entity_kind": "node", "entity_id": u,
                      "payload": {"urn": u, "entityType": "Table", "displayName": u}}
    return [node(a), node(b),
            {"op": "create", "entity_kind": "edge", "entity_id": eid,
             "payload": {"sourceEntityId": a, "targetEntityId": b, "edgeType": "LINEAGE"}}]


async def _run_graph_writes() -> None:
    from httpx import ASGITransport, AsyncClient
    from .test_api_graph_draft_journey import _StubCache, _StubManager

    await models.create_schema_and_partitions()
    app, G = _app()
    orig_pm, orig_cache = G.provider_manager, G.get_graph_cache
    G.provider_manager = _StubManager()
    G.get_graph_cache = lambda: _StubCache()
    svc = GraphVersioningService()
    ds = "ds_" + os.urandom(4).hex()
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            r = await c.post(f"{V1}/graphs", json={"dataSourceId": ds, "workspaceId": "ws1"}, headers=PAT)
            assert r.status_code == 201, r.text
            gid = r.json()["graphId"]
            await svc.apply_ops(graph_id=gid, actor="seed", message="seed", ops=_seed("e1", "N", "M"))

            # Mia manages but cannot publish: every write to main is refused, in person or with her
            # key, and nothing lands.
            before = await _main_head(svc, gid)
            for who in (MIA, MIA_KEY):
                for r in await _main_writes(c, ds, who, "e1", "N", "M"):
                    _refused(r)
            assert await _main_head(svc, gid) == before
            assert not (await svc.entity_value(graph_id=gid, entity_id="e1")).get("properties")

            # Her own draft takes the same edit, in person and with her key.
            d = (await c.post(f"{V1}/graphs/{gid}/branches", json={}, headers=MIA)).json()["branchId"]
            for who in (MIA, MIA_KEY):
                r = await c.post(f"{GP}/nodes/create", params={"dataSourceId": ds, "branchId": d},
                                 headers=who, json={"entityType": "Table", "displayName": "draft node"})
                assert r.status_code == 200 and r.json()["success"] is True, r.text
            assert await _main_head(svc, gid) == before

            # A publisher, in person and with their key, writes main directly.
            for who, eid in ((PAT, "e_pat"), (PAT_KEY, "e_key")):
                a, b = f"A_{eid}", f"B_{eid}"
                await svc.apply_ops(graph_id=gid, actor="seed", message="edge", ops=_seed(eid, a, b))
                head = await _main_head(svc, gid)
                answers = await _main_writes(c, ds, who, eid, a, b)
                assert [a.status_code for a in answers] == [200, 201, 200, 200, 200, 204], \
                    [(a.status_code, a.text) for a in answers]
                assert answers[0].json()["success"] is True, answers[0].text
                assert answers[3].json()["succeeded"] == 1, answers[3].text
                assert await _main_head(svc, gid) != head
                assert await svc.entity_value(graph_id=gid, entity_id=eid) is None
                saved = f"urn:s:{who.get('X-Key', who['X-User'])}"
                assert await svc.entity_value(graph_id=gid, entity_id=saved) is not None
    finally:
        G.provider_manager, G.get_graph_cache = orig_pm, orig_cache
        await db.dispose_engine()


async def _run_bulk_ingest() -> None:
    from httpx import ASGITransport, AsyncClient
    from .test_api_graph_draft_journey import _IMPORT_NDJSON

    await models.create_schema_and_partitions()
    app, _ = _app()
    svc = GraphVersioningService()
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            async def graph():
                r = await c.post(f"{V1}/graphs", json={"dataSourceId": "ds_" + os.urandom(4).hex(),
                                                       "workspaceId": "ws1"}, headers=PAT)
                assert r.status_code == 201, r.text
                return r.json()["graphId"]

            for who in (PAT, PAT_KEY):
                gid = await graph()
                r = await c.post(f"{V1}/graphs/{gid}/bulk-ingest", content=_IMPORT_NDJSON, headers=who)
                assert r.status_code == 200 and r.json()["ingested"] == 3, r.text

            gid = await graph()
            before = await _main_head(svc, gid)
            for who in (MIA, MIA_KEY):
                _refused(await c.post(f"{V1}/graphs/{gid}/bulk-ingest", content=_IMPORT_NDJSON, headers=who))
            assert await _main_head(svc, gid) == before
            assert (await svc.materialize_state(graph_id=gid, branch_id=await svc.main_branch_id(gid)))["nodes"] == {}
    finally:
        await db.dispose_engine()


@pytest.fixture
def no_flag_or_projector(monkeypatch):
    from backend.app.providers import versioned_write_provider as vwp

    async def _none(*_a, **_kw):
        return None
    monkeypatch.setattr(vwp, "_require_versioning_flag", _none)
    monkeypatch.setattr(vwp, "nudge_projection", _none)


def test_main_writes_from_postgres_need_publish_for_a_person(data_sources, no_flag_or_projector):
    asyncio.run(_run_graph_writes())


def test_main_writes_through_the_projection_need_publish_for_a_person(
        data_sources, no_flag_or_projector, monkeypatch):
    async def _fresh(self, graph_id):
        return {"fresh": True, "committed": 1, "projected": 1}
    monkeypatch.setattr(GraphVersioningService, "projection_watermark", _fresh)
    asyncio.run(_run_graph_writes())


def test_bulk_ingest_into_main_needs_publish_for_a_person(data_sources):
    asyncio.run(_run_bulk_ingest())
