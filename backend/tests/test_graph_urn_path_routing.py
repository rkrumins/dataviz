"""A URN containing '/' reaches the right graph route, intact.

URNs carry paths — `urn:li:dataset:(urn:li:dataPlatform:s3,bucket/key,PROD)`,
file systems, `db/schema` names. The client sends them correctly encoded
(`%2F`), but the ASGI server hands the router a DECODED path: the '/' split
the segment, `/nodes/{urn}` stopped matching and every such entity 404'd —
its node, its children, its ancestors. Nothing under it could ever load.

The graph router matches on the RAW path, so an encoded '/' stays inside its
parameter. That also keeps routing unambiguous: a node whose URN ends in
"/children" is a node lookup, not a children request.
"""
import pytest
from httpx import AsyncClient

from backend.common.models.graph import ChildrenWithEdgesResult, GraphNode

_EMPTY = ChildrenWithEdgesResult(
    children=[], containmentEdges=[], lineageEdges=[], totalChildren=0, hasMore=False, nextCursor=None,
)


class _RecordingEngine:
    def __init__(self):
        self.calls = []
        self.provider = None

    async def get_node(self, urn, *a, **kw):
        self.calls.append(("get_node", urn))
        return GraphNode(urn=urn, entityType="dataset", displayName=urn)

    async def get_children_with_edges(self, urn, **kw):
        self.calls.append(("children_with_edges", urn))
        return _EMPTY

    async def get_ancestors(self, urn, *a, **kw):
        self.calls.append(("ancestors", urn))
        return []


@pytest.fixture
async def client(test_client: AsyncClient):
    from backend.app.main import app
    from backend.app.api.v1.endpoints.graph import get_context_engine

    engine = _RecordingEngine()

    async def _override():
        return engine

    app.dependency_overrides[get_context_engine] = _override
    yield test_client, engine
    app.dependency_overrides.pop(get_context_engine, None)


BASE = "/api/v1/test-ws/graph/nodes"
S3 = "urn:li:dataset:(urn:li:dataPlatform:s3,bucket/path/to/key,PROD)"


def enc(urn: str) -> str:
    from urllib.parse import quote
    return quote(urn, safe="")


async def test_children_of_a_slash_bearing_urn(client):
    c, engine = client
    resp = await c.get(f"{BASE}/{enc(S3)}/children-with-edges")
    assert resp.status_code == 200, resp.text
    assert engine.calls[-1] == ("children_with_edges", S3)


async def test_the_node_itself(client):
    c, engine = client
    resp = await c.get(f"{BASE}/{enc(S3)}")
    assert resp.status_code == 200, resp.text
    assert engine.calls[-1] == ("get_node", S3)


async def test_ancestors(client):
    c, engine = client
    resp = await c.get(f"{BASE}/{enc(S3)}/ancestors")
    assert resp.status_code == 200, resp.text
    assert engine.calls[-1] == ("ancestors", S3)


async def test_a_urn_ending_in_children_is_a_node_lookup(client):
    c, engine = client
    urn = "urn:x:folder/children"
    resp = await c.get(f"{BASE}/{enc(urn)}")
    assert resp.status_code == 200, resp.text
    assert engine.calls[-1] == ("get_node", urn)


async def test_an_ordinary_urn_is_unaffected(client):
    c, engine = client
    resp = await c.get(f"{BASE}/{enc('urn:li:domain:finance')}/children-with-edges")
    assert resp.status_code == 200, resp.text
    assert engine.calls[-1] == ("children_with_edges", "urn:li:domain:finance")


async def test_an_encoded_percent_is_not_mistaken_for_a_slash(client):
    # "%2F" typed literally in a URN is sent as %252F; it must arrive as "%2F".
    c, engine = client
    urn = "urn:x:literal%2Fnot-a-slash"
    resp = await c.get(f"{BASE}/{enc(urn)}/children-with-edges")
    assert resp.status_code == 200, resp.text
    assert engine.calls[-1] == ("children_with_edges", urn)
