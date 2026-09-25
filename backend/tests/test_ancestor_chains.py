"""Containment chains for many urns at once — ``POST /nodes/ancestor-chains``.

The canvas holds lineage edges whose far end it never loaded: a partner
inside a collapsed container. Measured on a live view, 909 of 998 loaded
lineage edges were in that state, every one counted "outside this view"
although the partner sat inside it. The chain is what lets the canvas file
such an end under the container the reader can see — without loading it.
"""
import asyncio
import time
from typing import List

import pytest
from httpx import AsyncClient

from backend.app.providers.falkordb_provider import FalkorDBProvider
from backend.app.services.context_engine import ContextEngine
from backend.app.services.feature_flags import feature_flags
from backend.common.models.graph import GraphNode

from backend.tests.test_api_graph import _BaseWithoutClosure, _StubProvider


ROOT = "urn:test:platform"
PARENT = "urn:test:container"
LEAF = "urn:test:dataset"


class _ChainStub(_StubProvider):
    """A three-level hierarchy, answered one urn at a time."""

    def __init__(self):
        super().__init__()
        self.asked: List[str] = []

    async def get_ancestors(self, urn: str, limit: int = 100, offset: int = 0) -> List[GraphNode]:
        self.asked.append(urn)
        if urn == "urn:test:boom":
            raise OSError("provider hiccup")
        chain = {LEAF: [PARENT, ROOT], PARENT: [ROOT]}.get(urn, [])
        return [GraphNode(urn=u, displayName=u, entityType="container") for u in chain]


class _BulkStub(_ChainStub):
    """A provider with its own bulk path — the default must not run."""

    async def get_ancestor_chains(self, urns: List[str]):
        return {u: ["urn:bulk:parent"] for u in urns}


def _rollup(on: bool) -> None:
    """The route answers only while `canvasLineageRollupEnabled` is on — an
    experimental flag, seeded OFF. Primed in the cache, which is the path the
    gate reads in production (see conftest's `signup_enabled`)."""
    feature_flags._cache = {**(feature_flags._cache or {}), "canvasLineageRollupEnabled": on}
    feature_flags._cache_ts = time.monotonic()


@pytest.fixture(autouse=True)
def rollup_on():
    _rollup(True)
    yield


async def _post(client: AsyncClient, engine: ContextEngine, body):
    from backend.app.main import app
    from backend.app.api.v1.endpoints.graph import get_context_engine

    async def _override():
        return engine

    app.dependency_overrides[get_context_engine] = _override
    try:
        return await client.post("/api/v1/test-ws/graph/nodes/ancestor-chains", json=body)
    finally:
        app.dependency_overrides.pop(get_context_engine, None)


async def test_chains_come_parent_first_root_last(test_client: AsyncClient):
    resp = await _post(test_client, ContextEngine(provider=_ChainStub()), {"urns": [LEAF, PARENT, ROOT]})
    assert resp.status_code == 200
    assert resp.json() == {"chains": {LEAF: [PARENT, ROOT], PARENT: [ROOT], ROOT: []}}


async def test_an_urn_the_provider_failed_on_is_unknown_not_a_root(test_client: AsyncClient):
    resp = await _post(test_client, ContextEngine(provider=_ChainStub()), {"urns": [LEAF, "urn:test:boom"]})
    assert resp.status_code == 200
    chains = resp.json()["chains"]
    assert chains[LEAF] == [PARENT, ROOT]
    assert "urn:test:boom" not in chains


async def test_duplicates_are_asked_once(test_client: AsyncClient):
    provider = _ChainStub()
    await _post(test_client, ContextEngine(provider=provider), {"urns": [LEAF, LEAF, LEAF]})
    assert provider.asked == [LEAF]


async def test_a_provider_bulk_path_answers_instead(test_client: AsyncClient):
    provider = _BulkStub()
    resp = await _post(test_client, ContextEngine(provider=provider), {"urns": [LEAF, PARENT]})
    assert resp.json() == {"chains": {LEAF: ["urn:bulk:parent"], PARENT: ["urn:bulk:parent"]}}
    assert provider.asked == []


@pytest.mark.parametrize("urns", [[], [f"urn:test:{i}" for i in range(1001)]])
async def test_the_batch_is_bounded(test_client: AsyncClient, urns):
    resp = await _post(test_client, ContextEngine(provider=_ChainStub()), {"urns": urns})
    assert resp.status_code == 422


async def test_a_reader_with_no_containment_walk_says_so(test_client: AsyncClient):
    """A draft on a stale projection has no ancestors at all: an honest 501,
    as for its other unsupported reads, never an AttributeError 500."""
    from backend.app.providers.draft_overlay_provider import DraftOverlayProvider

    overlay = DraftOverlayProvider(_BaseWithoutClosure(), svc=None, graph_id="g1", branch_id="draft1")
    resp = await _post(test_client, ContextEngine(provider=overlay), {"urns": [LEAF]})
    assert resp.status_code == 501


async def test_the_route_is_closed_while_the_rollup_is_off(test_client: AsyncClient):
    """Off means off: the canvas stops asking, and anyone who knows the URL is
    refused too — a flag that only hides a button is a lie."""
    _rollup(False)
    resp = await _post(test_client, ContextEngine(provider=_ChainStub()), {"urns": [LEAF]})
    assert resp.status_code == 403


def test_falkordb_answers_from_its_bulk_chain_path():
    """One pipelined cache read + one bulk Cypher for the misses — never a
    node fetch, never one query per urn."""
    p = FalkorDBProvider.__new__(FalkorDBProvider)
    seen = {}

    async def _connected():
        return None

    async def _bulk(urns):
        seen["urns"] = urns
        return {u: [PARENT] for u in urns}

    p._ensure_connected = _connected  # type: ignore[method-assign]
    p._compute_and_store_ancestors_bulk = _bulk  # type: ignore[method-assign]

    out = asyncio.run(p.get_ancestor_chains([LEAF, LEAF, ROOT]))
    assert seen["urns"] == [LEAF, ROOT]
    assert out == {LEAF: [PARENT], ROOT: [PARENT]}


# ── what the walk could not answer is unknown, and is never cached ───────
#
# Every reader of the chain hash reads "[]" as "a root". A failed bucket, a
# row the query never returned, or a failed per-urn fallback all used to come
# back as [] and be written into a hash whose TTL is re-armed on every write,
# so they never aged out: an in-view partner read as "outside the view" for
# good.

COLUMN = "urn:test:column"


class _FakeRedis:
    """The chain hash: every pipelined HGET misses, and HSETs are recorded."""

    def __init__(self):
        self.written: List[str] = []

    async def execute_command(self, cmd, key, urn, *value):
        if cmd == "HSET":
            self.written.append(urn)
        return None

    async def expire(self, *args):
        return True

    def pipeline(self, transaction=False):
        redis, queued = self, []

        class _Pipe:
            def execute_command(self, cmd, key, urn, *value):
                queued.append(None)
                if cmd == "HSET":
                    redis.written.append(urn)

            def expire(self, *args):
                queued.append(True)

            async def execute(self):
                return list(queued)

        return _Pipe()


def _walker(buckets=None, answers=None, *, failing=()):
    """A FalkorDB provider whose chain query answers ``answers`` for the urns
    of each bucket it is asked about, and fails for the ``failing`` labels."""
    from types import SimpleNamespace

    p = FalkorDBProvider(host="x", graph_name="g")
    p._redis = _FakeRedis()
    p.set_containment_edge_types(["CONTAINS"], from_ontology=True)
    p.queried = []

    async def _buckets(urns):
        return buckets

    async def _ro(cypher, params=None, timeout=None, op=None):
        p.queried.append(cypher)
        if any(f"(child:{label})" in cypher for label in failing):
            raise RuntimeError("bucket failed")
        return SimpleNamespace(result_set=[
            [u, answers[u]] for u in params["urns"] if u in (answers or {})
        ])

    p._label_buckets = _buckets
    p._ro_query = _ro
    return p


def test_a_failed_label_bucket_leaves_its_urns_unknown():
    p = _walker(
        [("Column", [COLUMN]), ("Dataset", [LEAF])],
        {LEAF: [PARENT, ROOT], COLUMN: [LEAF, PARENT, ROOT]},
        failing=("Column",),
    )
    chains = asyncio.run(p._compute_ancestor_chains_bulk_cypher([LEAF, COLUMN]))
    assert chains == {LEAF: [PARENT, ROOT]}


def test_an_urn_the_query_returned_no_row_for_is_unknown():
    p = _walker([("Dataset", [LEAF, "urn:test:ghost"])], {LEAF: [PARENT, ROOT]})
    chains = asyncio.run(p._compute_ancestor_chains_bulk_cypher([LEAF, "urn:test:ghost"]))
    assert chains == {LEAF: [PARENT, ROOT]}


def test_a_root_is_still_answered_as_a_root():
    p = _walker([("Platform", [ROOT])], {ROOT: []})
    assert asyncio.run(p._compute_ancestor_chains_bulk_cypher([ROOT])) == {ROOT: []}


def test_a_large_unlabeled_residue_is_never_scanned():
    """An unlabeled anchor is a full node scan. A residue this large means
    label resolution failed wholesale: better unknown, and asked again."""
    from backend.app.providers import falkordb_provider as fp

    urns = [f"urn:test:{i}" for i in range(fp._ANCESTOR_UNLABELED_MAX + 1)]
    p = _walker([("", urns)], {u: [] for u in urns})
    assert asyncio.run(p._compute_ancestor_chains_bulk_cypher(urns)) == {}
    assert p.queried == []


def test_only_answered_chains_are_cached():
    p = _walker()

    async def _bulk(urns):
        return {LEAF: [PARENT, ROOT]}

    p._compute_ancestor_chains_bulk_cypher = _bulk
    result = asyncio.run(p._compute_and_store_ancestors_bulk([LEAF, COLUMN]))
    assert result == {LEAF: [PARENT, ROOT]}
    assert p._redis.written == [LEAF]


def test_the_per_urn_fallback_caches_no_failure():
    p = _walker()

    async def _bulk(urns):
        raise RuntimeError("planner hiccup")

    async def _one(urn):
        if urn == COLUMN:
            raise RuntimeError("still failing")
        return [PARENT, ROOT]

    p._compute_ancestor_chains_bulk_cypher = _bulk
    p._compute_ancestor_chain = _one
    result = asyncio.run(p._compute_and_store_ancestors_bulk([LEAF, COLUMN]))
    assert result == {LEAF: [PARENT, ROOT]}
    assert p._redis.written == [LEAF]


def test_a_shed_is_not_asked_again_one_urn_at_a_time():
    """The per-urn fallback after a shed would multiply one refusal by up to
    a thousand, each refused in turn."""
    from backend.common.adapters import ProviderBusy

    p = _walker()
    per_urn: List[str] = []

    async def _bulk(urns):
        raise ProviderBusy("falkordb", "shed")

    async def _one(urn):
        per_urn.append(urn)
        return []

    p._compute_ancestor_chains_bulk_cypher = _bulk
    p._compute_ancestor_chain = _one
    with pytest.raises(ProviderBusy):
        asyncio.run(p._compute_and_store_ancestors_bulk([LEAF, COLUMN]))
    assert per_urn == []


def test_a_single_urn_read_caches_nothing_it_could_not_answer():
    p = _walker()

    async def _bulk(urns):
        return {}

    p._compute_ancestor_chains_bulk_cypher = _bulk
    assert asyncio.run(p._get_ancestor_chain(LEAF)) == []
    assert p._redis.written == []


def test_chains_cached_before_the_fix_are_not_read():
    """Those entries include [] for urns the walk failed on; a new key
    abandons them, and the ':ancestors:*' sweeps still match it."""
    assert ":ancestors:v2:" in _walker()._ancestors_cache_key()
