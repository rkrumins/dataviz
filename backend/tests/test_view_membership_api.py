"""``POST /{ws_id}/graph/members`` — the route around the membership resolver.

Its switches, the specs it refuses, and a query seed: the search panel's own search,
held to the checks a search makes on its caller — BEFORE the cache, which keeps one
answer for every caller, could answer it. (The resolver's own logic is
``test_view_membership_resolver.py``.)
"""
import time

import pytest
from fastapi import HTTPException
from httpx import AsyncClient

from backend.app.api.v1.endpoints import graph_members
from backend.app.services.advanced_search_service import AdvancedSearchService, ValidationError
from backend.app.services.feature_flags import feature_flags
from backend.common.models.graph import GraphNode
from backend.common.models.search import SearchHit, SearchResultPage
from backend.common.models.view_membership import MemberEntry, MembershipResult
from backend.tests.test_view_membership_resolver import FakeEngine

URL = "/api/v1/test-ws/graph/members?viewId=v1"
QUERY = {"kind": "text", "value": "orders"}


def _flags(**values):
    feature_flags._cache = {**(feature_flags._cache or {}), **values}
    feature_flags._cache_ts = time.monotonic()


@pytest.fixture()
def membership_on():
    """The preview on, and the Lineage trace with it."""
    _flags(viewMembershipEnabled=True, traceEnabled=True)


@pytest.fixture()
def post(test_client: AsyncClient, db_session):
    """POST a body to the route, answered by ``engine`` (the fake graph by default)."""
    from backend.app.api.v1.endpoints.graph import get_context_engine
    from backend.app.main import app

    async def _post(body, engine=None, url=URL):
        engine = engine or FakeEngine()
        engine._db_session = db_session  # the session a real engine holds (get_engine_session)

        async def _override():
            return engine

        app.dependency_overrides[get_context_engine] = _override
        try:
            return await test_client.post(url, json=body)
        finally:
            app.dependency_overrides.pop(get_context_engine, None)

    return _post


class _Scope:
    scope_hash = "boundary-1"


@pytest.fixture()
def search(monkeypatch):
    """The search a query seed runs: the view resolves, and the hits are ``search.hits``."""
    seen = {"queries": [], "hits": ["col_a1", "tbl_b"], "page": {}}

    async def resolve_scope(self, requested):
        return _Scope()

    async def run(self, query, *, deadline_ms=None, run_context=None):
        seen["queries"].append(query)
        hits = [SearchHit(node=GraphNode(urn=u, displayName=u, entityType="thing")) for u in seen["hits"]]
        return SearchResultPage(hits=hits, elapsedMs=1, **seen["page"]), None

    monkeypatch.setattr(AdvancedSearchService, "resolve_scope", resolve_scope)
    monkeypatch.setattr(AdvancedSearchService, "search", run)
    return seen


# ── Switches ────────────────────────────────────────────────────────────────


async def test_the_preview_ships_off(post):
    resp = await post({"spec": {"seeds": {"urns": ["tbl_a"]}}})
    assert resp.status_code == 403
    assert resp.json()["detail"]["feature"] == "viewMembershipEnabled"


async def test_lineage_answers_to_the_trace_switch(post, membership_on):
    _flags(traceEnabled=False)
    lineage = await post({"spec": {"seeds": {"urns": ["col_a1"]}, "expand": {"upstream": 1}}})
    assert lineage.status_code == 403
    assert lineage.json()["detail"]["feature"] == "traceEnabled"

    inside = await post({"spec": {"seeds": {"urns": ["dom"]}, "expand": {"children": 1}}})
    assert inside.status_code == 200


# ── The answer ──────────────────────────────────────────────────────────────


async def test_a_scope_answers_its_members_and_why(post, membership_on):
    resp = await post({"spec": {"seeds": {"urns": ["dom", "ghost"]}, "expand": {"children": 1}}})
    assert resp.status_code == 200
    body = resp.json()
    assert {m["urn"]: m["via"] for m in body["members"]} == {"dom": "seed", "tbl_a": "inside", "tbl_b": "inside"}
    assert body["counts"] == {
        "seeds": 1, "inside": 2, "upstream": 0, "downstream": 0, "partnerInside": 0, "total": 3}
    assert body["missingSeeds"] == 1
    assert body["chains"] == {"dom": [], "tbl_a": ["dom"], "tbl_b": ["dom"]}
    assert len(body["specHash"]) == 32
    assert body["wholeSubtree"] == [] and body["truncated"] == []


async def test_counts_alone(post, membership_on):
    resp = await post({
        "spec": {"seeds": {"urns": ["col_a1"]}, "expand": {"upstream": "all"}}, "includeMembers": False})
    body = resp.json()
    assert body["members"] == [] and body["chains"] == {}
    assert body["counts"]["upstream"] == 3 and body["counts"]["total"] == 4


@pytest.mark.parametrize("spec", [
    {"seeds": {}},
    {"seeds": {"urns": []}},
    {"seeds": {"urns": ["a"], "query": QUERY}},
    {"seeds": {"urns": ["a"]}, "expand": {"upstream": 26}},
    {"seeds": {"urns": ["a"]}, "expand": {"children": 3}},
    {"seeds": {"urns": ["a"]}, "expand": {"partnerChildren": 2}},
    {"seeds": {"urns": ["a"]}, "expand": {"sideways": 1}},
    {"seeds": {"urns": ["a"]}, "within": "galaxy"},
    {"v": 2, "seeds": {"urns": ["a"]}},
])
async def test_a_spec_out_of_bounds_is_refused(post, membership_on, spec):
    resp = await post({"spec": spec})
    assert resp.status_code == 422


async def test_a_scope_is_read_in_a_view(post, membership_on):
    resp = await post({"spec": {"seeds": {"urns": ["a"]}}}, url="/api/v1/test-ws/graph/members")
    assert resp.status_code == 422


# ── Query seeds ─────────────────────────────────────────────────────────────


async def test_query_seeds_are_the_searchs_hits_in_the_view(post, membership_on, search):
    resp = await post({"spec": {"seeds": {"query": QUERY}}})
    assert resp.status_code == 200
    assert {m["urn"] for m in resp.json()["members"]} == {"col_a1", "tbl_b"}
    query = search["queries"][0]
    assert (query.scope.view_id, query.scope.scope_mode) == ("v1", "view")
    assert (query.options.results, query.options.page_size) == ("hits", 5000)


async def test_query_seeds_can_be_looked_for_in_the_whole_data_source(post, membership_on, search):
    await post({"spec": {"seeds": {"query": QUERY}, "within": "dataSource"}})
    assert search["queries"][0].scope.scope_mode == "data_source"


@pytest.mark.parametrize("page", [{"truncated": True}, {"totalCount": 9}, {"cursor": "c1"}])
async def test_a_search_that_found_more_says_so(post, membership_on, search, page):
    search["page"] = page
    resp = await post({"spec": {"seeds": {"query": QUERY}}})
    assert [t["reason"] for t in resp.json()["truncated"]] == ["seed_cap"]


async def test_a_running_search_is_continued_to_its_end(post, membership_on, search, monkeypatch):
    pages = iter([{"status": "running", "sessionId": "s1"}, {"status": "complete", "sessionId": "s1"}])
    original = AdvancedSearchService.search

    async def stepwise(self, query, **kw):
        search["page"] = next(pages)
        return await original(self, query, **kw)

    monkeypatch.setattr(AdvancedSearchService, "search", stepwise)
    resp = await post({"spec": {"seeds": {"query": QUERY}}})
    assert resp.json()["truncated"] == []
    assert [q.options.session_id for q in search["queries"]] == [None, "s1"]


# ── The checks run before the cache can answer ──────────────────────────────


class _ScopedEngine(FakeEngine):
    """An engine with a workspace scope, so the route reads through the cache."""
    _workspace_id = "test-ws"
    _data_source_id = "ds1"


class _CacheHoldingAnAnswer:
    """A cache that already holds an answer for every key — what a caller would
    receive if the checks ran only when the answer is computed."""

    def __init__(self):
        self.params = []

    async def get_or_compute(self, *, params, **_):
        self.params.append(params)
        return MembershipResult(specHash="cached", members=[MemberEntry(urn="secret", via="seed")])

    async def content_generation(self, scope):
        return "7"


@pytest.fixture()
def cached(monkeypatch):
    cache = _CacheHoldingAnAnswer()
    monkeypatch.setattr(graph_members, "get_graph_cache", lambda: cache)
    return cache


async def test_a_share_link_is_held_to_its_view_before_the_cache(post, membership_on, search, cached, monkeypatch):
    def outside_the_link(request, query=None):
        raise HTTPException(status_code=403, detail="This link can only search inside its view.")

    monkeypatch.setattr(graph_members, "_guard_capability_scope", outside_the_link)
    resp = await post({"spec": {"seeds": {"query": QUERY}, "within": "dataSource"}}, _ScopedEngine())
    assert resp.status_code == 403
    assert cached.params == []


async def test_a_view_the_caller_cannot_read_is_refused_before_the_cache(post, membership_on, cached, monkeypatch):
    async def unreadable(self, requested):
        raise ValidationError("view_not_found: view 'v1' not found")

    monkeypatch.setattr(AdvancedSearchService, "resolve_scope", unreadable)
    resp = await post({"spec": {"seeds": {"query": QUERY}}}, _ScopedEngine())
    assert resp.status_code == 404
    assert cached.params == []


async def test_the_boundary_is_in_the_key_for_query_seeds_only(post, membership_on, search, cached):
    await post({"spec": {"seeds": {"query": QUERY}}}, _ScopedEngine())
    await post({"spec": {"seeds": {"urns": ["a"]}}}, _ScopedEngine())
    assert [p["boundary"] for p in cached.params] == ["boundary-1", ""]
    assert cached.params[0]["spec"] != cached.params[1]["spec"]


def test_one_walk_is_shared_by_everyone_asking():
    """The cache takes only the endpoints it is switched on for — an endpoint it does not
    know is never cached, and every caller would pay for its own walk."""
    from backend.app.services.graph_cache import _ENABLED_ENDPOINTS, ENDPOINT_MEMBERS

    assert _ENABLED_ENDPOINTS.get(ENDPOINT_MEMBERS) is True
