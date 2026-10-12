"""An entity id containing '/' reaches its version history and summary, intact.

Entity ids carry URNs, and URNs carry paths — `…s3,bucket/key,PROD)` — so an
edge id built from two of them (`<urn>|FLOWS_TO|<urn>`) carries them too. The
client sends the id encoded (`%2F`), but the ASGI server hands the router a
DECODED path: the '/' split the segment and `/entities/{entity_id}/history`
404'd, so the relationship drawer showed no history for exactly those
relationships. The versioning router matches on the RAW path, as the graph
router does.

Also pins the history page's contract at the route: paging parameters reach the
service, the cursor comes back as `nextBefore`, and a foreign cursor is a 422.
"""
from urllib.parse import quote

import pytest
from httpx import AsyncClient

from backend.app.services.versioning.entity_audit import InvalidCursor

WS = "test-ws"
S3 = "urn:li:dataset:(urn:li:dataPlatform:s3,bucket/path/to/key,PROD)"
EDGE_ID = f"{S3}|FLOWS_TO|urn:li:dataset:(urn:li:dataPlatform:s3,bucket/out,PROD)"


class _RecordingVersioning:
    def __init__(self):
        self.calls = []

    async def get_graph(self, graph_id):
        return {"workspace_id": WS}

    async def assert_branch_readable(self, *, graph_id, branch_id, viewer):
        self.calls.append(("readable", branch_id))


@pytest.fixture
async def client(test_client: AsyncClient, monkeypatch):
    from backend.app.main import app
    from backend.app.api.v1.endpoints import versioning
    from backend.app.api.v1.endpoints.versioning import get_versioning_service

    svc = _RecordingVersioning()

    async def page(_svc, *, graph_id, entity_id, branch_id, scope, limit, before, include_payload, kind):
        if before == "bad":
            raise InvalidCursor("not a history cursor")
        svc.calls.append(("history", entity_id, branch_id, scope, limit, before))
        return {"entityId": entity_id, "kind": "edge", "versions": [{"actor": "u1"}],
                "hasMore": True, "nextBefore": "cur2"}

    async def summary(_svc, *, graph_id, entity_id, branch_id, kind, include_value):
        svc.calls.append(("summary", entity_id, include_value))
        return {"entityId": entity_id, "kind": "edge", "exists": True, "version": "h", "inherited": False,
                "created": None, "updated": None, "revisions": {"published": 1, "draft": 0},
                "changedOnMainSinceBranch": False, "baseCommitSeq": None}

    monkeypatch.setattr(versioning, "entity_history_page", page)
    monkeypatch.setattr(versioning, "entity_summary", summary)
    app.dependency_overrides[get_versioning_service] = lambda: svc
    yield test_client, svc
    app.dependency_overrides.pop(get_versioning_service, None)


def _entity(entity_id: str, what: str) -> str:
    return f"/api/v1/{WS}/versioning/graphs/g1/entities/{quote(entity_id, safe='')}/{what}"


async def test_an_edge_id_built_from_slash_bearing_urns(client):
    c, svc = client
    resp = await c.get(_entity(EDGE_ID, "history"))
    assert resp.status_code == 200, resp.text
    assert svc.calls == [("history", EDGE_ID, None, "all", 50, None)]
    assert resp.json()["entityId"] == EDGE_ID


async def test_a_plain_id_is_unaffected(client):
    c, svc = client
    resp = await c.get(_entity("ent_01HX", "history"))
    assert resp.status_code == 200, resp.text
    assert svc.calls == [("history", "ent_01HX", None, "all", 50, None)]


async def test_the_summary_reaches_a_slash_bearing_id(client):
    c, svc = client
    resp = await c.get(_entity(EDGE_ID, "summary") + "?include=value")
    assert resp.status_code == 200, resp.text
    assert svc.calls == [("summary", EDGE_ID, True)]
    assert resp.json()["entityId"] == EDGE_ID


async def test_history_pages_and_checks_the_draft_is_readable(client):
    c, svc = client
    resp = await c.get(_entity("ent_1", "history") + "?branchId=d1&scope=draft&limit=20&before=cur1")
    assert resp.status_code == 200, resp.text
    assert svc.calls == [("readable", "d1"), ("history", "ent_1", "d1", "draft", 20, "cur1")]
    body = resp.json()
    assert (body["hasMore"], body["nextBefore"]) == (True, "cur2")


async def test_a_foreign_cursor_is_a_422(client):
    c, _ = client
    resp = await c.get(_entity("ent_1", "history") + "?before=bad")
    assert resp.status_code == 422
    assert resp.json()["detail"]["type"] == "invalid_cursor"


async def test_paging_bounds_are_enforced(client):
    c, _ = client
    assert (await c.get(_entity("ent_1", "history") + "?limit=500")).status_code == 422
    assert (await c.get(_entity("ent_1", "history") + "?scope=everything")).status_code == 422
