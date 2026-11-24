"""``POST /nodes/children-batch`` — the first pages of many containers in one round trip.

Opening a level of a hundred small containers was a hundred /children-with-edges
requests. The batch answers each parent exactly as that endpoint would, and is no
way past its limits. Pinned here, without infrastructure (the FalkorDB statement
itself is proven against the real engine in
integration/test_children_batch_live.py):

  * its limits: 1–50 parents, up to 200 rows each;
  * mixed parents: each its own page and its own ``hasMore``; an unknown parent an
    empty page, never an error; a parent named twice answered once;
  * the fair share is charged per parent;
  * each parent goes through the response cache under /children-with-edges' own key,
    and the parents the cache cannot answer are read together, in one call;
  * a bad cursor is the client's error (400), as on the single endpoint;
  * the provider default reads each parent through ``get_children_with_edges``, a
    few at a time, so every reader without a bulk path (another adapter, a draft
    overlay, a versioned branch) answers it correctly as it stands.
"""
import asyncio
import json

import pytest
from httpx import AsyncClient

from backend.common.interfaces.provider import (
    CHILDREN_BATCH_CONCURRENCY, GraphDataProvider, children_batch_by_query,
)
from backend.common.models.graph import ChildrenBatchParent, ChildrenWithEdgesResult, GraphEdge, GraphNode
from backend.app.providers.falkordb_provider import CursorMismatchError
from backend.app.services.context_engine import ContextEngine

URL = "/api/v1/test-ws/graph/nodes/children-batch"
KIDS = {"urn:x:P": 250, "urn:x:Q": 3, "urn:x:E": 0}


def _page(urn: str, offset: int = 0, limit: int = 100) -> ChildrenWithEdgesResult:
    """What the graph holds under ``urn``: KIDS[urn] children, paged by offset."""
    total = KIDS.get(urn, 0)
    idx = range(offset, min(total, offset + limit))
    kids = [GraphNode(urn=f"{urn}/c{i:03d}", entityType="table", displayName=f"c{i:03d}") for i in idx]
    return ChildrenWithEdgesResult(
        children=kids,
        containmentEdges=[GraphEdge(id=f"{urn}>{k.urn}", sourceUrn=urn, targetUrn=k.urn, edgeType="CONTAINS") for k in kids],
        lineageEdges=[],
        totalChildren=offset + len(kids) + (1 if offset + limit < total else 0),
        hasMore=offset + limit < total,
        nextOffset=offset + len(kids),
    )


class _Engine:
    """Stands in for ContextEngine at the endpoint boundary: a graph that knows P, Q
    and E (empty), and says nothing about any other urn."""

    def __init__(self):
        self.batches = []
        self.singles = []
        self.provider = None

    async def get_children_batch(self, parents, **kw):
        self.batches.append(([p.urn for p in parents], kw))
        for p in parents:
            if p.cursor == "other-direction":
                raise CursorMismatchError("cursor minted for the other direction")
        return {p.urn: _page(p.urn, p.offset, kw["limit"]) for p in parents if p.urn in KIDS}

    async def get_children_with_edges(self, urn, **kw):
        self.singles.append(urn)
        return _page(urn, kw.get("offset", 0), kw.get("limit", 100))


@pytest.fixture
async def batch_client(test_client: AsyncClient):
    from backend.app.main import app
    from backend.app.api.v1.endpoints.graph import get_context_engine

    engine = _Engine()

    async def _override():
        return engine

    app.dependency_overrides[get_context_engine] = _override
    yield test_client, engine
    app.dependency_overrides.pop(get_context_engine, None)


def _body(*parents, **kw):
    return {"parents": [p if isinstance(p, dict) else {"urn": p} for p in parents], **kw}


# ── limits ───────────────────────────────────────────────────────────────

@pytest.mark.parametrize("body", [
    _body(),                                                    # no parent
    _body(*[f"urn:x:{i}" for i in range(51)]),                  # past 50
    _body("urn:x:P", limit=201),                                 # past 200 a parent
    _body({"urn": "urn:x:P", "offset": -1}),
    _body("urn:x:P", lineageScope="everything"),
    _body("urn:x:P", sortDirection="sideways"),
])
async def test_a_batch_past_its_limits_is_refused(batch_client, body):
    client, engine = batch_client
    resp = await client.post(URL, json=body)
    assert resp.status_code == 422, resp.text
    assert engine.batches == []


async def test_fifty_parents_of_two_hundred_rows_are_one_read(batch_client):
    client, engine = batch_client
    resp = await client.post(URL, json=_body(*[f"urn:x:{i}" for i in range(50)], limit=200))
    assert resp.status_code == 200, resp.text
    assert len(engine.batches) == 1 and len(engine.batches[0][0]) == 50
    assert engine.batches[0][1]["limit"] == 200


# ── what it answers ──────────────────────────────────────────────────────

async def test_each_parent_has_its_own_page_and_its_own_has_more(batch_client):
    client, _ = batch_client
    resp = await client.post(URL, json=_body("urn:x:P", "urn:x:Q", "urn:x:E", lineageScope="siblings"))
    assert resp.status_code == 200, resp.text
    results = resp.json()["results"]
    assert len(results["urn:x:P"]["children"]) == 100
    assert results["urn:x:P"]["hasMore"] is True and results["urn:x:P"]["nextOffset"] == 100
    assert [c["urn"] for c in results["urn:x:Q"]["children"]] == [f"urn:x:Q/c{i:03d}" for i in range(3)]
    assert results["urn:x:Q"]["hasMore"] is False
    assert results["urn:x:E"]["children"] == [] and results["urn:x:E"]["hasMore"] is False


async def test_an_unknown_parent_answers_an_empty_page_never_an_error(batch_client):
    client, _ = batch_client
    resp = await client.post(URL, json=_body("urn:x:Q", {"urn": "urn:x:gone", "offset": 100}))
    assert resp.status_code == 200, resp.text
    gone = resp.json()["results"]["urn:x:gone"]
    assert gone["children"] == [] and gone["hasMore"] is False and gone["nextOffset"] == 100
    assert len(resp.json()["results"]["urn:x:Q"]["children"]) == 3


async def test_a_parent_named_twice_is_read_once(batch_client):
    client, engine = batch_client
    resp = await client.post(URL, json=_body({"urn": "urn:x:P", "offset": 100}, "urn:x:P"))
    assert resp.status_code == 200, resp.text
    assert engine.batches[0][0] == ["urn:x:P"]
    assert resp.json()["results"]["urn:x:P"]["children"][0]["urn"] == "urn:x:P/c100"   # the first ask


async def test_it_pages_on_like_the_single_endpoint(batch_client):
    client, _ = batch_client
    one = (await client.post(URL, json=_body("urn:x:P"))).json()["results"]["urn:x:P"]
    two = (await client.post(URL, json=_body({"urn": "urn:x:P", "offset": one["nextOffset"]}))).json()["results"]["urn:x:P"]
    single = (await client.get("/api/v1/test-ws/graph/nodes/urn:x:P/children-with-edges", params={"offset": 100})).json()
    assert two == single


async def test_a_cursor_for_the_other_direction_is_the_clients_error(batch_client):
    client, _ = batch_client
    resp = await client.post(URL, json=_body({"urn": "urn:x:P", "cursor": "other-direction"}))
    assert resp.status_code == 400, resp.text


# ── no way past the limits ───────────────────────────────────────────────

async def test_the_fair_share_is_charged_per_parent(batch_client, monkeypatch):
    from backend.app.api.v1.endpoints import graph as graph_mod

    client, engine = batch_client
    engine._workspace_id = "ws-1"
    charged = []

    class _Bucket:
        def is_enabled(self):
            return True

        async def enforce(self, endpoint, ws, cost=1):
            charged.append((endpoint, ws, cost))

    monkeypatch.setattr(graph_mod, "get_fair_share", lambda: _Bucket())
    monkeypatch.setattr(graph_mod, "_cache_scope", lambda _engine: None)
    resp = await client.post(URL, json=_body("urn:x:P", "urn:x:Q", "urn:x:E", "urn:x:Q"))
    assert resp.status_code == 200, resp.text
    # Three parents (one named twice): what three /children-with-edges would cost.
    assert charged == [(graph_mod.ENDPOINT_CHILDREN, "ws-1", 3)]


async def test_a_batch_never_costs_more_than_a_full_bucket(monkeypatch):
    """Else a batch wider than the burst could never be admitted at all."""
    from backend.app.services import fair_share

    seen = []

    class _Bucket(fair_share.WorkspaceTokenBucket):
        def __init__(self):
            async def script(keys, args):
                seen.append(args[2])
                return [1, 0]
            self._take_script = script

    monkeypatch.setitem(fair_share._CONFIGS, fair_share.ENDPOINT_CHILDREN, fair_share.BucketConfig(30.0, 20))
    await _Bucket().enforce(fair_share.ENDPOINT_CHILDREN, "ws-1", cost=50)
    assert seen == [20]


class _Cache:
    """GraphCache's contract, in memory: a hit never computes."""

    def __init__(self):
        self.store = {}

    async def get_or_compute(self, *, scope, endpoint, params, compute, model_cls, on_stale=None, expected_compute_s=None):
        key = (endpoint, json.dumps(params, sort_keys=True))
        if key not in self.store:
            self.store[key] = await compute()
        return self.store[key]


async def test_each_parent_is_cached_under_the_single_endpoints_key(batch_client, monkeypatch):
    from backend.app.api.v1.endpoints import graph as graph_mod

    client, engine = batch_client
    cache = _Cache()
    monkeypatch.setattr(graph_mod, "get_graph_cache", lambda: cache)
    monkeypatch.setattr(graph_mod, "_cache_scope", lambda _engine: object())

    single = await client.get("/api/v1/test-ws/graph/nodes/urn:x:Q/children-with-edges",
                              params={"lineageScope": "siblings"})
    assert single.status_code == 200, single.text
    resp = await client.post(URL, json=_body("urn:x:Q", "urn:x:P", "urn:x:E", lineageScope="siblings"))
    assert resp.status_code == 200, resp.text
    # Q came from the page the single endpoint cached; the two misses in ONE read.
    assert engine.batches == [(["urn:x:P", "urn:x:E"], engine.batches[0][1])]
    assert resp.json()["results"]["urn:x:Q"] == single.json()

    # …and what the batch read is there for the single endpoint, and the next batch.
    engine.singles.clear()
    again = await client.get("/api/v1/test-ws/graph/nodes/urn:x:P/children-with-edges",
                             params={"lineageScope": "siblings"})
    assert again.json() == resp.json()["results"]["urn:x:P"]
    assert engine.singles == []
    await client.post(URL, json=_body("urn:x:P", "urn:x:Q", lineageScope="siblings"))
    assert len(engine.batches) == 1


# ── the provider default ─────────────────────────────────────────────────

class _OneByOne:
    """A reader with no bulk path: what another adapter, a draft overlay or a
    versioned branch is to the batch."""

    def __init__(self):
        self.calls = []
        self.at_once = 0
        self.most = 0

    async def get_children_with_edges(self, urn, **kw):
        self.calls.append((urn, kw))
        self.at_once += 1
        self.most = max(self.most, self.at_once)
        try:
            await asyncio.sleep(0.001)
            return _page(urn, kw.get("offset", 0), kw.get("limit", 100))
        finally:
            self.at_once -= 1


async def test_the_default_reads_each_parent_through_its_single_read_a_few_at_a_time():
    reader = _OneByOne()
    parents = [ChildrenBatchParent(urn="urn:x:P", offset=100), ChildrenBatchParent(urn="urn:x:Q", cursor="k")] + [
        ChildrenBatchParent(urn=f"urn:x:{i}") for i in range(10)]
    got = await GraphDataProvider.get_children_batch(
        reader, parents, edge_types=["CONTAINS"], limit=50, lineage_scope="siblings")
    assert set(got) == {p.urn for p in parents}
    assert got["urn:x:P"] == _page("urn:x:P", 100, 50)
    assert reader.most <= CHILDREN_BATCH_CONCURRENCY
    kw = dict(reader.calls)
    assert kw["urn:x:P"]["offset"] == 100 and kw["urn:x:Q"]["cursor"] == "k"
    assert kw["urn:x:P"]["lineage_scope"] == "siblings" and kw["urn:x:P"]["edge_types"] == ["CONTAINS"]


async def test_the_default_passes_no_scope_a_page_scope_reader_predates():
    reader = _OneByOne()
    await GraphDataProvider.get_children_batch(reader, [ChildrenBatchParent(urn="urn:x:Q")])
    assert "lineage_scope" not in reader.calls[0][1]


async def test_one_parent_failing_fails_the_batch_and_stops_the_rest():
    stopped = []

    class _Failing:
        async def get_children_with_edges(self, urn, **kw):
            if urn == "urn:x:0":
                await asyncio.sleep(0.01)
                raise TimeoutError("one read past its deadline")
            try:
                await asyncio.sleep(10)
            except asyncio.CancelledError:
                stopped.append(urn)
                raise

    with pytest.raises(TimeoutError):
        await children_batch_by_query(_Failing(), [ChildrenBatchParent(urn=f"urn:x:{i}") for i in range(3)])
    await asyncio.sleep(0)
    assert sorted(stopped) == ["urn:x:1", "urn:x:2"]


def test_the_engine_reads_a_reader_without_a_bulk_path_one_parent_at_a_time(monkeypatch):
    reader = _OneByOne()
    engine = ContextEngine(provider=reader)

    async def _types(_):
        return ["CONTAINS"]

    async def _no_ontology():
        return None

    monkeypatch.setattr(engine, "_ensure_containment_edge_types", _types)
    monkeypatch.setattr(engine, "_resolve_ontology", _no_ontology)
    got = asyncio.run(engine.get_children_batch(
        [ChildrenBatchParent(urn="urn:x:Q"), ChildrenBatchParent(urn="urn:x:E")], lineage_scope="siblings"))
    assert set(got) == {"urn:x:Q", "urn:x:E"}
    assert [c[0] for c in reader.calls] == ["urn:x:Q", "urn:x:E"]
    assert reader.calls[0][1]["edge_types"] == ["CONTAINS"]
