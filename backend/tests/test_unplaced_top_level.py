"""``POST /nodes/top-level/unplaced`` — the top-level entities a view does not place.

A view's health check asks, once per load, which top-level entities of the types the view is
about are not placed in it: new ones an ingestion or a sync brought, another draft's published
roots, or ones it leaves out on purpose. The canvas sends the urns it places of those types and
gets back how many are not placed, by type, and the first of them by name. Pinned here, without
infrastructure:

  * the answer: the top-level entities of the asked types, minus the placed ones, counted by
    type, the first page by name;
  * it pages the provider's own top-level read (label-indexed, keyset-paged) to the end, and no
    further than a ceiling: past it, the counts are a lower bound and say so;
  * on a draft it reads the draft: a root the draft adds is not placed, one it deletes is gone;
  * the endpoint, on main and with ``?branchId=``, and its limits.
"""
import asyncio
from typing import List, Optional

import pytest
from fastapi import Query
from httpx import AsyncClient

from backend.app.providers.draft_overlay_provider import DraftOverlayProvider
from backend.app.services.unplaced_top_level import unplaced_top_level
from backend.common.models.graph import GraphNode, TopLevelNodesResult

URL = "/api/v1/test-ws/graph/nodes/top-level/unplaced"


def _n(urn: str, entity_type: str = "domain") -> GraphNode:
    return GraphNode(urn=urn, entityType=entity_type, displayName=urn)


class Main:
    """Main's top-level set, paged by name with a keyset cursor, as the providers page it."""

    def __init__(self, roots: List[GraphNode]):
        self.roots = sorted(roots, key=lambda n: n.urn)
        self.reads: List[dict] = []

    def set_containment_edge_types(self, *a, **k):
        pass

    async def get_top_level_or_orphan_nodes(self, *, entity_types=None, limit=100, cursor=None,
                                            include_child_count=True, **kw):
        self.reads.append({"entity_types": entity_types, "limit": limit, "cursor": cursor})
        rows = [n for n in self.roots if not entity_types or n.entity_type in entity_types]
        start = next((i + 1 for i, n in enumerate(rows) if n.urn == cursor), 0) if cursor else 0
        page = rows[start:start + limit]
        more = start + limit < len(rows)
        return TopLevelNodesResult(nodes=page, totalCount=len(rows), hasMore=more,
                                   nextCursor=page[-1].urn if more else None)

    async def get_nodes(self, query):
        return [n for n in self.roots if n.urn in (query.urns or [])]


def _reader(provider, types: List[str]):
    async def read(cursor: Optional[str], size: int) -> TopLevelNodesResult:
        return await provider.get_top_level_or_orphan_nodes(
            entity_types=types, limit=size, cursor=cursor, include_child_count=True)
    return read


def _run(coro):
    return asyncio.run(coro)


# ── what it answers ──────────────────────────────────────────────────────

def test_the_roots_of_the_asked_types_less_the_placed_ones_by_type_and_by_name():
    main = Main([_n("Finance"), _n("Sales"), _n("Legal"), _n("Lake", "platform"), _n("Ops")])
    got = _run(unplaced_top_level(_reader(main, ["domain", "platform"]),
                                  placed={"Finance", "Sales"}, limit=10))
    assert [n.urn for n in got.nodes] == ["Lake", "Legal", "Ops"]
    assert got.by_type == {"domain": 2, "platform": 1}
    assert got.total_count == 3
    assert got.complete is True


def test_the_first_page_is_only_a_page_and_the_counts_are_of_them_all():
    main = Main([_n(f"D{i:02d}") for i in range(30)])
    got = _run(unplaced_top_level(_reader(main, ["domain"]), placed={"D00"}, limit=5))
    assert [n.urn for n in got.nodes] == ["D01", "D02", "D03", "D04", "D05"]
    assert got.total_count == 29 and got.by_type == {"domain": 29}


def test_nothing_unplaced_is_an_empty_answer():
    main = Main([_n("Finance")])
    got = _run(unplaced_top_level(_reader(main, ["domain"]), placed={"Finance"}, limit=10))
    assert got.nodes == [] and got.total_count == 0 and got.by_type == {} and got.complete


def test_it_follows_the_providers_pages_to_the_end():
    main = Main([_n(f"D{i:02d}") for i in range(25)])
    got = _run(unplaced_top_level(_reader(main, ["domain"]), placed=set(), limit=3, page_size=10))
    assert got.total_count == 25 and got.complete
    assert [r["cursor"] for r in main.reads] == [None, "D09", "D19"]
    assert all(r["limit"] == 10 for r in main.reads)


def test_past_its_ceiling_it_stops_and_says_the_count_is_a_lower_bound():
    main = Main([_n(f"D{i:02d}") for i in range(50)])
    got = _run(unplaced_top_level(_reader(main, ["domain"]), placed=set(), limit=3,
                                  page_size=10, ceiling=20))
    assert len(main.reads) == 2
    assert got.total_count == 20 and got.complete is False


def test_a_root_a_page_repeats_is_counted_once():
    class Repeats(Main):
        async def get_top_level_or_orphan_nodes(self, *, cursor=None, **kw):
            page = await super().get_top_level_or_orphan_nodes(cursor=cursor, **kw)
            if cursor:
                page.nodes = [_n("A"), *page.nodes]
            return page

    main = Repeats([_n("A"), _n("B"), _n("C")])
    got = _run(unplaced_top_level(_reader(main, ["domain"]), placed=set(), limit=10, page_size=2))
    assert [n.urn for n in got.nodes] == ["A", "B", "C"] and got.total_count == 3


# ── on a draft ───────────────────────────────────────────────────────────

class FakeSvc:
    def __init__(self, delta):
        self._delta = delta
        self._version = object()

    async def overlay_version(self, *, graph_id, branch_id):
        return (self._version,)

    async def branch_overlay_delta(self, *, graph_id, branch_id):
        return self._delta

    async def overlay_payloads(self, *, graph_id, branch_id, entity_ids):
        return []


def _draft(main: Main, *, add_roots=(), remove_roots=()) -> DraftOverlayProvider:
    delta = {
        "nodesUpsert": [{"urn": u, "entityType": "domain", "displayName": u} for u in add_roots],
        "nodesNew": list(add_roots),
        "nodesRemove": [{"urn": u} for u in remove_roots],
        "edgesUpsert": [],
        "edgesRemove": [],
    }
    p = DraftOverlayProvider(main, svc=FakeSvc(delta), graph_id="g", branch_id="d")
    p.set_containment_edge_types(["CONTAINS"])
    return p


def test_on_a_draft_a_root_it_adds_is_not_placed_and_one_it_deletes_is_gone():
    draft = _draft(Main([_n("Finance"), _n("Legal"), _n("Sales")]),
                   add_roots=["Treasury"], remove_roots=["Legal"])
    got = _run(unplaced_top_level(_reader(draft, ["domain"]), placed={"Finance"}, limit=10))
    assert sorted(n.urn for n in got.nodes) == ["Sales", "Treasury"]
    assert got.total_count == 2


# ── the endpoint ─────────────────────────────────────────────────────────

class _Engine:
    """ContextEngine at the endpoint boundary: reads one provider's top-level set."""

    def __init__(self, reader):
        self._reader = reader
        self.provider = None

    async def get_top_level_or_orphan_nodes(self, **kw):
        return await self._reader.get_top_level_or_orphan_nodes(**kw)


MAIN_ROOTS = [_n("Finance"), _n("Legal"), _n("Sales"), _n("Lake", "platform")]


@pytest.fixture
async def client(test_client: AsyncClient):
    from backend.app.main import app
    from backend.app.api.v1.endpoints.graph import get_context_engine

    seen = {}

    async def _override(branchId: Optional[str] = Query(None)):
        seen["branchId"] = branchId
        main = Main(MAIN_ROOTS)
        reader = _draft(main, add_roots=["Treasury"], remove_roots=["Legal"]) if branchId else main
        return _Engine(reader)

    app.dependency_overrides[get_context_engine] = _override
    yield test_client, seen
    app.dependency_overrides.pop(get_context_engine, None)


async def test_on_main_it_answers_the_unplaced_roots(client):
    http, seen = client
    resp = await http.post(URL, json={"entityTypes": ["domain"], "placedUrns": ["Finance"]})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert seen["branchId"] is None
    assert [n["urn"] for n in body["nodes"]] == ["Legal", "Sales"]
    assert body["byType"] == {"domain": 2}
    assert body["totalCount"] == 2 and body["complete"] is True


async def test_on_a_branch_it_answers_the_drafts_unplaced_roots(client):
    http, seen = client
    resp = await http.post(f"{URL}?branchId=br_draft",
                           json={"entityTypes": ["domain"], "placedUrns": ["Finance"]})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert seen["branchId"] == "br_draft"
    assert sorted(n["urn"] for n in body["nodes"]) == ["Sales", "Treasury"]
    assert body["totalCount"] == 2


@pytest.mark.parametrize("body", [
    {"entityTypes": [], "placedUrns": []},                               # no type
    {"placedUrns": []},                                                  # no type at all
    {"entityTypes": [f"t{i}" for i in range(51)], "placedUrns": []},     # past 50 types
    {"entityTypes": ["domain"], "placedUrns": [f"u{i}" for i in range(10_001)]},
    {"entityTypes": ["domain"], "placedUrns": [], "limit": 0},
    {"entityTypes": ["domain"], "placedUrns": [], "limit": 201},
])
async def test_a_request_past_its_limits_is_refused(client, body):
    http, _ = client
    resp = await http.post(URL, json=body)
    assert resp.status_code == 422, resp.text
