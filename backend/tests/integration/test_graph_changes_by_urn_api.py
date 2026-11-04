"""``POST /graph/changes`` on entities whose ids are not their urns — needs Postgres.

The canvas sends what it knows: a node's urn as the op's id and as an edge's ends. On nodes an
import (or a bulk ingest) keyed by other ids, the save now lands on them, answers in the names it
was sent — node views under the urn, a version token for every entity it wrote — and refuses a
create over something that exists, naming the change the canvas staged it as.
"""
import asyncio
import json
import os

import pytest

from backend.app.services.versioning import db, models
from backend.tests.integration.test_api_graph_draft_journey import _build_app, _StubCache, _StubManager

pytestmark = [pytest.mark.integration, pytest.mark.skipif(
    not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")]

# main: tables T and L, keyed by ids that are not their urns, as an import keys them.
_SEED = "\n".join(json.dumps(r) for r in [
    {"kind": "node", "id": "ent_T", "urn": "urn:T", "entityType": "Table", "displayName": "T"},
    {"kind": "node", "id": "ent_L", "urn": "urn:L", "entityType": "Table", "displayName": "L"},
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
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            gid = (await c.post(f"{V1}/graphs", json={"dataSourceId": ds,
                                                      "workspaceId": "ws1"})).json()["graphId"]
            assert (await c.post(f"{V1}/graphs/{gid}/bulk-ingest", content=_SEED)).status_code == 200
            draft = (await c.post(f"{V1}/graphs/{gid}/branches", json={})).json()["branchId"]
            q = {"dataSourceId": ds, "branchId": draft}

            # A rename and a drawn link, as the canvas sends them: by urn.
            r = await c.post(f"{GP}/changes", params=q, json={"ops": [
                {"op": "update", "kind": "node", "id": "urn:T", "payload": {"displayName": "T2"}},
                {"op": "create", "kind": "edge", "ref": "staged-edge_1",
                 "payload": {"edgeType": "LINEAGE", "sourceEntityId": "urn:T",
                             "targetEntityId": "urn:L"}},
            ]})
            assert r.status_code == 200, r.text
            body = r.json()
            edge_id = body["assigned"]["staged-edge_1"]
            assert set(body["entities"]) == {"urn:T", edge_id}, body["entities"]
            assert body["entities"]["urn:T"]["node"]["displayName"] == "T2"
            assert body["versions"]["urn:T"] == body["entities"]["urn:T"]["version"]
            assert body["versions"][edge_id] == body["entities"][edge_id]["version"]
            edge = body["entities"][edge_id]["edge"]
            assert (edge["sourceUrn"], edge["targetUrn"]) == ("urn:T", "urn:L")

            # A create over a node that exists is refused, named as the canvas staged it.
            r = await c.post(f"{GP}/changes", params=q, json={"ops": [
                {"op": "create", "kind": "node", "ref": "tmp-node",
                 "payload": {"urn": "urn:L", "entityType": "Table", "displayName": "L again"}},
            ]})
            assert r.status_code == 409, r.text
            assert r.json()["detail"]["type"] == "entity_exists"
            assert r.json()["detail"]["refs"] == ["tmp-node"], r.json()

            # A connection with one end is refused, never stored as a node.
            r = await c.post(f"{GP}/changes", params=q, json={"ops": [
                {"op": "create", "kind": "edge", "ref": "staged-edge_2",
                 "payload": {"edgeType": "LINEAGE", "sourceEntityId": "urn:T"}},
            ]})
            assert r.status_code == 422, r.text
    finally:
        G.provider_manager, G.get_graph_cache = orig_pm, orig_cache
        await db.dispose_engine()


def test_a_canvas_save_on_imported_nodes_lands_and_answers_by_urn(data_sources):
    asyncio.run(_run())
