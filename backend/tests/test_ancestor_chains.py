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


async def test_the_route_answers_every_reader(test_client: AsyncClient):
    """Where an unloaded lineage end sits is how the canvas tells lineage in
    the view from lineage that leaves it, so `canvasLineageRollupEnabled` is
    retired: a deployment whose stored value is still off is answered too."""
    feature_flags._cache = {**(feature_flags._cache or {}), "canvasLineageRollupEnabled": False}
    feature_flags._cache_ts = time.monotonic()
    resp = await _post(test_client, ContextEngine(provider=_ChainStub()), {"urns": [LEAF]})
    assert resp.status_code == 200
    assert resp.json() == {"chains": {LEAF: [PARENT, ROOT]}}


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
    """The chain hash: a pipelined HGET answers from ``stored`` (else misses),
    and HSETs are recorded."""

    def __init__(self, stored=None):
        self.written: List[str] = []
        self.stored = stored or {}

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
                queued.append(redis.stored.get(urn) if cmd == "HGET" else None)
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


def test_a_walk_on_a_spent_read_clock_asks_nothing_and_says_why():
    """The aggregated read's chain read-through runs on the read's clock:
    once too little is left to start a query, a bucket is not asked, its
    urns stay unknown, and the loss is recorded as a timeout."""
    from backend.app.providers import falkordb_provider as fp

    p = _walker([("Dataset", [LEAF])], {LEAF: [PARENT, ROOT]})
    pressure = fp._ReadPressure()
    chains = asyncio.run(p._compute_ancestor_chains_bulk_cypher(
        [LEAF], deadline=time.monotonic(), pressure=pressure,
    ))
    assert chains == {}
    assert p.queried == []
    assert pressure.truncation_reason == "timeout"


def test_a_failed_chain_bucket_is_recorded_on_the_read():
    """The aggregated read drops the roll-ups a chain it could not get would
    have resolved, so the loss must mark the answer short."""
    from backend.app.providers import falkordb_provider as fp

    p = _walker(
        [("Column", [COLUMN]), ("Dataset", [LEAF])],
        {LEAF: [PARENT, ROOT], COLUMN: [LEAF, PARENT, ROOT]},
        failing=("Column",),
    )
    pressure = fp._ReadPressure()
    chains = asyncio.run(p._compute_ancestor_chains_bulk_cypher([LEAF, COLUMN], pressure=pressure))
    assert chains == {LEAF: [PARENT, ROOT]}
    assert pressure.truncation_reason == "failed"


def test_an_urn_with_no_row_or_no_label_marks_nothing():
    """A partner that no longer exists, or a residue left unscanned, is not a
    failed read. Marking it would pin every such answer to the negative TTL
    and recompute it for ever."""
    from backend.app.providers import falkordb_provider as fp

    residue = [f"urn:test:{i}" for i in range(fp._ANCESTOR_UNLABELED_MAX + 1)]
    p = _walker([("", residue), ("Dataset", [LEAF, "urn:test:ghost"])], {LEAF: [PARENT, ROOT]})
    pressure = fp._ReadPressure()
    chains = asyncio.run(p._compute_ancestor_chains_bulk_cypher(
        [LEAF, "urn:test:ghost", *residue], pressure=pressure,
    ))
    assert chains == {LEAF: [PARENT, ROOT]}
    assert pressure.degraded_batches == 0


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

    async def _bulk(urns, **kw):
        return {LEAF: [PARENT, ROOT]}

    p._compute_ancestor_chains_bulk_cypher = _bulk
    result = asyncio.run(p._compute_and_store_ancestors_bulk([LEAF, COLUMN]))
    assert result == {LEAF: [PARENT, ROOT]}
    assert p._redis.written == [LEAF]


def test_the_per_urn_fallback_caches_no_failure():
    p = _walker()

    async def _bulk(urns, **kw):
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

    async def _bulk(urns, **kw):
        raise ProviderBusy("falkordb", "shed")

    async def _one(urn):
        per_urn.append(urn)
        return []

    p._compute_ancestor_chains_bulk_cypher = _bulk
    p._compute_ancestor_chain = _one
    with pytest.raises(ProviderBusy):
        asyncio.run(p._compute_and_store_ancestors_bulk([LEAF, COLUMN]))
    assert per_urn == []


def test_a_shed_chain_query_is_raised_not_answered_short():
    """Only a shed while bucketing labels was raised. A shed chain query was
    swallowed like any failure, so /nodes/ancestor-chains answered 200 with
    those urns missing instead of 429 + Retry-After."""
    from backend.common.adapters import ProviderBusy

    p = _walker([("Dataset", [LEAF])], {LEAF: [PARENT, ROOT]})

    async def _shed(cypher, params=None, timeout=None, op=None):
        raise ProviderBusy("falkordb", "queue")

    p._ro_query = _shed
    with pytest.raises(ProviderBusy):
        asyncio.run(p._compute_and_store_ancestors_bulk([LEAF]))
    assert p._redis.written == []


def test_a_single_urn_read_caches_nothing_it_could_not_answer():
    p = _walker()

    async def _bulk(urns, **kw):
        return {}

    p._compute_ancestor_chains_bulk_cypher = _bulk
    assert asyncio.run(p._get_ancestor_chain(LEAF)) == []
    assert p._redis.written == []


def test_chains_cached_before_the_fix_are_not_read():
    """Those entries include [] for urns the walk failed on; a new key
    abandons them, and the ':ancestors:*' sweeps still match it."""
    assert ":ancestors:v2:" in _walker()._ancestors_cache_key()


# ── a chain deeper than the hop bound is walked on, not cut ──────────────
#
# The chain query climbs at most _containment_hop_bound() hops — 16 for a
# folder nested in folders. A deeper row's chain stopped there, so the drawn
# container above the cut never appeared in it: the canvas filed the row
# "outside this view", and the aggregated read lost its roll-ups.

def _folders(depth):
    """f0 ⊃ f1 ⊃ … ⊃ f{depth-1}, one label: parent map child → parent."""
    return {f"f{i}": f"f{i - 1}" for i in range(1, depth)}


def _deep_walker(parent, *, stored=None):
    """A provider over a single-parent containment map whose chain query
    climbs no further than the ``*1..N`` bound in its Cypher, as FalkorDB's."""
    import re
    from types import SimpleNamespace

    p = FalkorDBProvider(host="x", graph_name="g")
    p._entity_type_levels = {"Folder": 0}                  # bound: max(2, 16)
    p._redis = _FakeRedis(stored)
    p.set_containment_edge_types(["CONTAINS"], from_ontology=True)
    p.queried = []

    async def _buckets(urns):
        return [("Folder", list(urns))]

    async def _ro(cypher, params=None, timeout=None, op=None):
        bound = int(re.search(r"\*1\.\.(\d+)", cypher).group(1))
        p.queried.append(list(params["urns"]))
        rows = []
        for u in params["urns"]:
            chain, cur = [], parent.get(u)
            while cur is not None and len(chain) < bound:
                chain.append(cur)
                cur = parent.get(cur)
            rows.append([u, chain])
        return SimpleNamespace(result_set=rows)

    p._label_buckets = _buckets
    p._ro_query = _ro
    return p


def test_a_chain_deeper_than_the_hop_bound_reaches_its_root():
    p = _deep_walker(_folders(50))
    chains = asyncio.run(p._compute_ancestor_chains_bulk_cypher(["f49", "f10"]))
    assert chains["f49"] == [f"f{i}" for i in range(48, -1, -1)]
    assert chains["f10"] == [f"f{i}" for i in range(9, -1, -1)]
    # One pass for both, then one per further 16 hops, from the top reached.
    assert p.queried == [["f49", "f10"], ["f33"], ["f17"], ["f1"]]


def test_the_walk_goes_on_from_an_ancestor_chain_already_cached():
    import json

    p = _deep_walker(_folders(50), stored={"f33": json.dumps([f"f{i}" for i in range(32, -1, -1)])})
    chains = asyncio.run(p._compute_ancestor_chains_bulk_cypher(["f49"]))
    assert chains["f49"] == [f"f{i}" for i in range(48, -1, -1)]
    assert p.queried == [["f49"]]


def test_a_containment_cycle_ends_the_walk():
    """Only the materializer breaks cycles; a read path that walked on until
    a chain came back shorter would never stop."""
    parent = {f"c{i}": f"c{(i + 1) % 40}" for i in range(40)}
    p = _deep_walker(parent)
    chains = asyncio.run(p._compute_ancestor_chains_bulk_cypher(["c0"]))
    assert chains["c0"] == [f"c{i}" for i in range(1, 40)]


def test_a_chain_still_going_at_the_hard_cap_is_unknown_never_a_root(monkeypatch):
    from backend.app.providers import falkordb_provider as fp

    monkeypatch.setattr(fp, "_ANCESTOR_CHAIN_HOP_CAP", 40)
    p = _deep_walker(_folders(50))
    chains = asyncio.run(p._compute_and_store_ancestors_bulk(["f49", "f10"]))
    assert "f49" not in chains
    assert p._redis.written == ["f10"]
