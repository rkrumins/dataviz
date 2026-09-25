"""A shard that is FULL must not answer with a fraction of the rollup.

Two refusals mean "ask again in a moment", not "here is what I could get":
FalkorDB's ``MAX_QUEUED_QUERIES`` reply (a shard past its queue depth) and
redis-py's ``MaxConnectionsError`` (this process's own pool out of sockets).
Both used to be swallowed:

* the aggregated-edge read caught the store's queue-full reply below the
  breaker proxy that would have relabelled it, kept the pages it had and
  returned HTTP 200 with a prefix of the rollup — missing lineage that the
  response cache then pinned for an hour and mirrored as last-known-good;
* the pool's own exhaustion SUBCLASSES redis ``ConnectionError``, so the
  breaker counted client-side saturation against a healthy store and three
  of them refused every shard.

And when a batch IS lost for some other reason, the result has to say so in
a machine-readable way: ``degraded_detail`` names a store limit and is
therefore None when no limit was involved, which left the cache's
determinism test with nothing to read.
"""
from __future__ import annotations

import asyncio

import pytest
from redis.exceptions import MaxConnectionsError, ResponseError

from backend.app.providers import falkordb_provider as fp
from backend.common.adapters.circuit import (
    CircuitBreakerProxy,
    ProviderBusy,
    breaker_stats,
    is_queue_full_reply,
)
from backend.common.models.graph import AggregatedEdgeResult

#: The server's own wording (FalkorDB ``error_msgs.h``).
QUEUE_FULL = ResponseError("Max pending queries exceeded")


# ── what counts as a shed ────────────────────────────────────────────────


def test_the_stores_queue_full_reply_is_a_shed_not_a_query_error():
    assert is_queue_full_reply(QUEUE_FULL)
    assert fp._is_load_shed(QUEUE_FULL)
    # …and it is recognised through a wrapper, as the ladders see it.
    try:
        try:
            raise QUEUE_FULL
        except ResponseError as exc:
            raise RuntimeError("batch failed") from exc
    except RuntimeError as wrapped:
        assert fp._is_load_shed(wrapped)


def test_our_own_pool_running_dry_is_a_shed_not_a_connection_drop():
    exc = MaxConnectionsError("Too many connections")
    assert fp._is_load_shed(exc)
    assert fp._is_pool_exhausted_error(exc)
    # The two things it must NOT be: a transient drop (which would redial
    # and, in cluster mode, rebuild the client — throwing away the pooled
    # sockets that were the scarce resource), or a replica's fault.
    assert not fp._is_transient_connection_error(exc)
    assert not fp._replica_at_fault(exc)


def test_a_real_query_error_is_still_just_a_query_error():
    assert not fp._is_load_shed(ResponseError("Invalid input 'x'"))
    assert not fp._is_load_shed(RuntimeError("boom"))


def test_every_lost_batch_gets_a_name():
    assert fp._lost_batch_kind(QUEUE_FULL) == "queue_full"
    assert fp._lost_batch_kind(MaxConnectionsError("Too many connections")) == "pool_full"
    assert fp._lost_batch_kind(Exception("Query's mem consumption exceeded capacity")) == "memory"
    assert fp._lost_batch_kind(asyncio.TimeoutError()) == "timeout"
    assert fp._lost_batch_kind(RuntimeError("boom")) == "failed"


# ── the breaker ──────────────────────────────────────────────────────────


class _Provider:
    def __init__(self, exc):
        self.calls = 0
        self._exc = exc

    @property
    def name(self) -> str:
        return "p"

    async def get_nodes(self) -> list:
        self.calls += 1
        raise self._exc


async def test_pool_exhaustion_sheds_as_busy_and_never_opens_the_breaker():
    before = breaker_stats()["network_failures_counted"]
    target = _Provider(MaxConnectionsError("Too many connections"))
    proxy = CircuitBreakerProxy(target, name="p", fail_max=2)

    for _ in range(5):
        with pytest.raises(ProviderBusy) as exc:
            await proxy.get_nodes()
    assert proxy.breaker_state == "closed"
    assert target.calls == 5                       # no fast-fail either
    assert exc.value.retry_after_seconds > 0       # …and the client is told when
    assert breaker_stats()["network_failures_counted"] == before
    assert breaker_stats()["pool_exhaustion_not_counted"] >= 5


# ── the pressure record ──────────────────────────────────────────────────


def test_a_shed_outranks_a_pressure_reason_and_a_plain_failure_still_has_one():
    p = fp._ReadPressure()
    assert p.truncation_reason is None             # nothing lost, nothing to say

    p.degrade("failed")
    assert p.truncation_reason == "failed"
    assert p.stale_reason is None                  # "failed" is not a store limit
    assert p.as_detail(endpoint="n:6379", query_mem_capacity=None) is None

    p.degrade("timeout")
    assert p.truncation_reason == "timeout" and p.stale_reason == "timeout"
    assert p.as_detail(endpoint="n:6379", query_mem_capacity=None)["kind"] == "timeout"

    p.degrade("queue_full")
    assert p.truncation_reason == "queue_full"     # the one to act on first
    assert p.as_detail(endpoint="n:6379", query_mem_capacity=None)["kind"] == "queue_full"


def test_the_detail_still_names_the_ceiling_for_the_limits_dialog():
    p = fp._ReadPressure()
    p.narrowed_pages = 2
    p.degrade("memory")
    assert p.as_detail(endpoint="10.0.0.1:6379", query_mem_capacity=512) == {
        "kind": "query_memory", "narrowedPages": 2, "narrowedBatches": 0,
        "degradedBatches": 1, "floorRetries": 0,
        "endpoint": "10.0.0.1:6379", "queryMemCapacity": 512,
    }


# ── the result, and what the cache makes of it ───────────────────────────


def test_the_result_carries_a_truncation_reason_under_both_names():
    r = AggregatedEdgeResult(
        aggregatedEdges=[], totalSourceEdges=0, truncated=True,
        truncationReason="queue_full",
    )
    assert r.truncation_reason == "queue_full"
    assert r.model_dump(by_alias=True)["truncationReason"] == "queue_full"
    # Absent by default, so a complete answer is not marked.
    assert AggregatedEdgeResult(
        aggregatedEdges=[], totalSourceEdges=0,
    ).truncation_reason is None


def test_the_cache_now_sees_a_lost_batch_as_incomplete():
    """The point of the field. A partial the read GAVE UP on must get the
    negative TTL and must not be mirrored as last-known-good; a cut that
    recomputes to the identical bytes keeps the full TTL."""
    from backend.app.services.graph_cache import _is_incomplete_result

    gave_up = AggregatedEdgeResult(
        aggregatedEdges=[], totalSourceEdges=0, truncated=True,
        truncationReason="failed",
    )
    assert _is_incomplete_result(gave_up)

    capped = AggregatedEdgeResult(
        aggregatedEdges=[], totalSourceEdges=0, truncated=True,
    )
    assert not _is_incomplete_result(capped)


# ── end to end through the aggregated-edge read ──────────────────────────


def _paging_provider(page_rows, then):
    """The materialized-cell read as a fake: one good page, then ``then``."""
    from test_falkordb_ondemand_pairs import (           # noqa: E402 - test helper
        _FakeGraph, _Result, _make_provider, _seed_deep_chains,
    )

    fake = _FakeGraph()
    levels = _seed_deep_chains(fake, depth=3)
    p = _make_provider(fake, levels)
    calls = {"n": 0}

    async def _connected():
        return None

    async def _buckets(urns):
        return [("LabelA", ["urn:a"])]

    async def _proj_ro_query(cypher, params=None, timeout=None, **kw):
        if ":AGGREGATED]->" not in cypher or "LIMIT" not in cypher:
            return _Result([])
        calls["n"] += 1
        if calls["n"] == 1:
            return _Result(list(page_rows))
        raise then

    async def _meta():
        return fp.AggRunMeta("boundary", 2, None, "2026-07-17T00:00:00Z")

    p._ensure_connected = _connected
    p._label_buckets = _buckets
    p._proj_ro_query = _proj_ro_query
    p._aggregation_run_meta = _meta
    return p


def _read(p):
    return asyncio.run(p.get_aggregated_edges_between(
        ["urn:a"], [], granularity=None,
        containment_edges=["CONTAINS"], lineage_edges=[],
    ))


def _page(n, size):
    return [[f"urn:s{i:08d}", f"urn:t{i:08d}", 5, ["X"]] for i in range(size)]


def test_a_queue_full_shard_raises_instead_of_answering_with_half_a_rollup(monkeypatch):
    """It must reach the breaker proxy, which turns it into 429 +
    Retry-After. Folding it into a partial answered 200 with a prefix that
    the cache kept for an hour."""
    from backend.app.config import resilience

    monkeypatch.setattr(resilience, "AGGREGATED_EDGE_PAGE_SIZE", 5)
    p = _paging_provider(_page(0, 5), QUEUE_FULL)
    with pytest.raises(ResponseError) as exc:
        _read(p)
    assert is_queue_full_reply(exc.value)


def test_our_own_pool_exhaustion_gets_out_too(monkeypatch):
    from backend.app.config import resilience

    monkeypatch.setattr(resilience, "AGGREGATED_EDGE_PAGE_SIZE", 5)
    p = _paging_provider(_page(0, 5), MaxConnectionsError("Too many connections"))
    with pytest.raises(MaxConnectionsError):
        _read(p)


def test_a_batch_lost_to_anything_else_keeps_its_prefix_and_says_why(monkeypatch):
    from backend.app.config import resilience

    monkeypatch.setattr(resilience, "AGGREGATED_EDGE_PAGE_SIZE", 5)
    p = _paging_provider(_page(0, 5), RuntimeError("connection reset mid-page"))
    result = _read(p)
    assert len(result.aggregated_edges) == 5       # the prefix is still worth having
    assert result.truncated and result.stale
    assert result.stale_reason == "degraded"       # the stale vocabulary is unchanged
    assert result.truncation_reason == "failed"    # …and the cache now has a reason


# ── /edges/between: one label bucket failing fails the read ──────────────


def _bucketed_edges_provider(fail_with):
    """``get_edges`` over two label buckets, where urn:b's bucket raises."""
    from types import SimpleNamespace

    p = fp.FalkorDBProvider(host="x", graph_name="g")

    async def _connected():
        return None

    async def _buckets(urns):
        return [("A", ["urn:a"]), ("B", ["urn:b"])]

    async def _ro_query(cypher, params=None, timeout=None, **kw):
        if params["anchorUrns"] == ["urn:b"]:
            raise fail_with
        return SimpleNamespace(result_set=[["urn:a", "urn:b", "FLOWS_TO", {}]])

    p._ensure_connected = _connected
    p._label_buckets = _buckets
    p._ro_query = _ro_query
    return p


def _between():
    from backend.common.models.graph import EdgeQuery

    return EdgeQuery(source_urns=["urn:a", "urn:b"], target_urns=["urn:a", "urn:b"])


async def test_a_failed_label_bucket_fails_edges_between_instead_of_answering_part_of_it():
    """Answering with the other buckets' edges was a 200 missing a whole
    label's lineage, which the response cache kept for its full TTL."""
    p = _bucketed_edges_provider(QUEUE_FULL)
    with pytest.raises(ResponseError):
        await p.get_edges(_between())


async def test_through_the_breaker_a_full_bucket_is_a_429_not_a_short_200():
    proxy = CircuitBreakerProxy(_bucketed_edges_provider(QUEUE_FULL), name="p")
    with pytest.raises(ProviderBusy):
        await proxy.get_edges(_between())


async def test_a_graph_that_does_not_exist_yet_still_has_no_edges():
    p = _bucketed_edges_provider(ResponseError("Invalid graph operation on empty key"))
    edges = await p.get_edges(_between())
    assert [(e.source_urn, e.target_urn) for e in edges] == [("urn:a", "urn:b")]
