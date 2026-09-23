"""`lineageScope` on /children-with-edges — plumbing and draft overlay (no infra).

The FalkorDB query itself is proven against the real engine in
integration/test_children_sibling_lineage_live.py. This pins what surrounds it:

  * the endpoint validates the value and forwards it to the engine;
  * the engine forwards it to the provider ONLY when widened, so a provider
    override written before the parameter existed keeps working for every
    default-scope caller;
  * the draft overlay hands over its own lineage edges that touch the page in
    siblings scope (their far end may sit on a page not loaded yet), and keeps
    the old both-ends-on-page rule in page scope.
"""
import asyncio

import pytest
from httpx import AsyncClient

from backend.common.models.graph import ChildrenWithEdgesResult, GraphNode
from backend.app.providers.draft_overlay_provider import DraftOverlayProvider
from backend.app.services.context_engine import ContextEngine

_EMPTY_RESULT = ChildrenWithEdgesResult(
    children=[], containmentEdges=[], lineageEdges=[], totalChildren=0, hasMore=False, nextCursor=None,
)


class _RecordingEngine:
    """Stands in for ContextEngine at the endpoint boundary."""

    def __init__(self):
        self.calls = []
        self.provider = None

    async def get_children_with_edges(self, urn, **kw):
        self.calls.append((urn, kw))
        return _EMPTY_RESULT


@pytest.fixture
async def recording_client(test_client: AsyncClient):
    from backend.app.main import app
    from backend.app.api.v1.endpoints.graph import get_context_engine

    engine = _RecordingEngine()

    async def _override():
        return engine

    app.dependency_overrides[get_context_engine] = _override
    yield test_client, engine
    app.dependency_overrides.pop(get_context_engine, None)


async def test_endpoint_forwards_siblings_scope(recording_client):
    client, engine = recording_client
    resp = await client.get(
        "/api/v1/test-ws/graph/nodes/urn:x:P/children-with-edges",
        params={"lineageScope": "siblings", "limit": 10},
    )
    assert resp.status_code == 200, resp.text
    assert engine.calls[-1][1]["lineage_scope"] == "siblings"


async def test_endpoint_defaults_to_page_scope(recording_client):
    client, engine = recording_client
    resp = await client.get("/api/v1/test-ws/graph/nodes/urn:x:P/children-with-edges")
    assert resp.status_code == 200, resp.text
    assert engine.calls[-1][1]["lineage_scope"] == "page"


async def test_endpoint_rejects_an_unknown_scope(recording_client):
    client, _ = recording_client
    resp = await client.get(
        "/api/v1/test-ws/graph/nodes/urn:x:P/children-with-edges",
        params={"lineageScope": "everything"},
    )
    assert resp.status_code == 422


class _LegacyProvider:
    """A provider override written before `lineage_scope` existed."""

    def __init__(self):
        self.kwargs = None

    async def get_children_with_edges(self, parent_urn, edge_types=None, lineage_edge_types=None,
                                      search_query=None, offset=0, limit=100,
                                      include_lineage_edges=True, sort_property="displayName",
                                      cursor=None, sort_direction="asc"):
        self.kwargs = dict(edge_types=edge_types)
        return _EMPTY_RESULT


def test_engine_keeps_legacy_providers_working_in_page_scope(monkeypatch):
    provider = _LegacyProvider()
    engine = ContextEngine(provider=provider)

    async def _types(_):
        return ["CONTAINS"]

    async def _no_ontology():
        return None

    monkeypatch.setattr(engine, "_ensure_containment_edge_types", _types)
    monkeypatch.setattr(engine, "_resolve_ontology", _no_ontology)
    asyncio.run(engine.get_children_with_edges("urn:x:P", lineage_edge_types=["T"]))
    assert provider.kwargs is not None, "a default-scope call must not pass lineage_scope"


# ── draft overlay ────────────────────────────────────────────────────────

class _PagedBase:
    """Base with P's children split over pages; page 1 = P.a, P.b."""

    def __init__(self):
        self.last_kw = None

    def set_containment_edge_types(self, ets, from_ontology=False):
        pass

    async def get_children_with_edges(self, parent_urn, **kw):
        self.last_kw = kw
        kids = [GraphNode(urn=u, entityType="Column", displayName=u) for u in ("P.a", "P.b")]
        return ChildrenWithEdgesResult(children=kids, containmentEdges=[], lineageEdges=[],
                                       totalChildren=3, hasMore=True, nextCursor="k")


class _FakeSvc:
    def __init__(self, delta):
        self._delta = delta

    async def branch_overlay_delta(self, *, graph_id, branch_id):
        return self._delta

    async def aggregated_overlay_adjust(self, **kw):
        return {}


def _lin(eid, s, t):
    return {"id": eid, "sourceUrn": s, "targetUrn": t, "edgeType": "LINEAGE",
            "confidence": 1.0, "properties": {}}


_DELTA = {"nodesUpsert": [], "nodesRemove": [], "edgesRemove": [], "edgesUpsert": [
    _lin("in-page", "P.a", "P.b"),         # both ends on page 1
    _lin("cross-page", "P.a", "P.z"),      # far end on a later page
    _lin("elsewhere", "Q.x", "Q.y"),       # does not touch the page
]}


def _overlay(base):
    p = DraftOverlayProvider(base, svc=_FakeSvc(_DELTA), graph_id="g", branch_id="d")
    p.set_containment_edge_types(["CONTAINS"])
    return p


def test_draft_overlay_siblings_scope_hands_over_page_touching_edges():
    base = _PagedBase()
    res = asyncio.run(_overlay(base).get_children_with_edges("P", lineage_scope="siblings"))
    assert {e.id for e in res.lineage_edges} == {"in-page", "cross-page"}
    assert base.last_kw.get("lineage_scope") == "siblings"


def test_draft_overlay_page_scope_is_unchanged():
    base = _PagedBase()
    res = asyncio.run(_overlay(base).get_children_with_edges("P"))
    assert {e.id for e in res.lineage_edges} == {"in-page"}
    assert "lineage_scope" not in base.last_kw
