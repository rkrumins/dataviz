"""An entity id containing '/' reaches its version history, intact.

Entity ids carry URNs, and URNs carry paths — `…s3,bucket/key,PROD)` — so an
edge id built from two of them (`<urn>|FLOWS_TO|<urn>`) carries them too. The
client sends the id encoded (`%2F`), but the ASGI server hands the router a
DECODED path: the '/' split the segment and `/entities/{entity_id}/history`
404'd, so the relationship drawer showed no history for exactly those
relationships. The versioning router matches on the RAW path, as the graph
router does.
"""
from urllib.parse import quote

import pytest
from httpx import AsyncClient

WS = "test-ws"
S3 = "urn:li:dataset:(urn:li:dataPlatform:s3,bucket/path/to/key,PROD)"
EDGE_ID = f"{S3}|FLOWS_TO|urn:li:dataset:(urn:li:dataPlatform:s3,bucket/out,PROD)"


class _RecordingVersioning:
    def __init__(self):
        self.calls = []

    async def get_graph(self, graph_id):
        return {"workspace_id": WS}

    async def entity_history(self, *, graph_id, entity_id, viewer):
        self.calls.append(entity_id)
        return []


@pytest.fixture
async def client(test_client: AsyncClient):
    from backend.app.main import app
    from backend.app.api.v1.endpoints.versioning import get_versioning_service

    svc = _RecordingVersioning()
    app.dependency_overrides[get_versioning_service] = lambda: svc
    yield test_client, svc
    app.dependency_overrides.pop(get_versioning_service, None)


def _history(entity_id: str) -> str:
    return f"/api/v1/{WS}/versioning/graphs/g1/entities/{quote(entity_id, safe='')}/history"


async def test_an_edge_id_built_from_slash_bearing_urns(client):
    c, svc = client
    resp = await c.get(_history(EDGE_ID))
    assert resp.status_code == 200, resp.text
    assert svc.calls == [EDGE_ID]
    assert resp.json()["entityId"] == EDGE_ID


async def test_a_plain_id_is_unaffected(client):
    c, svc = client
    resp = await c.get(_history("ent_01HX"))
    assert resp.status_code == 200, resp.text
    assert svc.calls == ["ent_01HX"]
