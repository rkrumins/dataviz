"""Widened aggregation self-heal trigger (WS3): the read path enqueues a
re-materialization whenever the provider reports a heal-able stale answer —
not only on the old "empty AND never materialized" predicate, which let any
graph whose cells predate the depth-stamp contract degrade forever (reads
returned rows, so nothing ever re-materialized). The terminal-failure key
(stamped by the worker on budget/precondition failures) suppresses re-enqueue
churn on doomed graphs.
"""
import asyncio

from backend.app.services.context_engine import ContextEngine
from backend.common.models.graph import (
    AggregatedEdgeRequest,
    AggregatedEdgeResult,
    OntologyMetadata,
)


class _FakeRedis:
    def __init__(self):
        self.store = {}

    async def get(self, key):
        return self.store.get(key)

    async def set(self, key, value, nx=False, ex=None):
        if nx and key in self.store:
            return False
        self.store[key] = value
        return True

    async def delete(self, key):
        self.store.pop(key, None)


class _Provider:
    """Just enough surface for engine.get_aggregated_edges + the trigger."""

    def __init__(self, result):
        self._result = result
        self._redis = _FakeRedis()

    async def get_aggregated_edges_between(self, **kw):
        return self._result

    async def materialize_aggregated_edges_batch(self, *a, **kw):  # pragma: no cover
        raise AssertionError("read path must never materialize inline")


def _engine(provider):
    e = ContextEngine(provider=provider)
    e._workspace_id = "ws1"
    e._data_source_id = "ds1"

    async def _meta():
        return OntologyMetadata(
            containmentEdgeTypes=["HAS"], lineageEdgeTypes=["FLOWS_TO"],
            edgeTypeMetadata={}, entityTypeHierarchy={}, rootEntityTypes=[],
        )

    e.get_ontology_metadata = _meta
    enqueued = {"n": 0}

    async def _fake_job_create():
        enqueued["n"] += 1
        return True

    # Bypass the real aggregation-service dispatch; keep the dedupe/terminal
    # logic in _trigger_materialize_in_background intact by stubbing only the
    # job-creation step it awaits.
    e._create_materialize_job = _fake_job_create  # used if refactor extracts it
    e._enqueued = enqueued
    return e


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def _result(**kw):
    base = dict(aggregatedEdges=[], totalSourceEdges=0)
    base.update(kw)
    return AggregatedEdgeResult(**base)


def _request():
    return AggregatedEdgeRequest(
        sourceUrns=["urn:a"], targetUrns=["urn:b"], granularity=None,
    )


def _patch_trigger(e, calls):
    async def _fake_trigger(**kw):
        calls["n"] += 1
        return True
    e._trigger_materialize_in_background = _fake_trigger


def test_trigger_fires_on_stale_legacy_cells():
    p = _Provider(_result(stale=True, staleReason="legacy_cells",
                          stampVersion=1, regime="boundary",
                          lastMaterializedAt="2026-07-01T00:00:00Z"))
    e = _engine(p)
    calls = {"n": 0}
    _patch_trigger(e, calls)
    result = _run(e.get_aggregated_edges(_request()))
    assert calls["n"] == 1
    assert result.materialization_triggered is True


def test_trigger_fires_on_unmaterialized_even_with_rows():
    p = _Provider(_result(
        aggregatedEdges=[], totalSourceEdges=0,
        stale=True, staleReason="unmaterialized", stampVersion=1,
        regime="unknown",
    ))
    e = _engine(p)
    calls = {"n": 0}
    _patch_trigger(e, calls)
    _run(e.get_aggregated_edges(_request()))
    assert calls["n"] == 1


def test_no_trigger_on_healthy_result():
    p = _Provider(_result(stale=False, stampVersion=2, regime="boundary",
                          lastMaterializedAt="2026-07-11T00:00:00Z"))
    e = _engine(p)
    calls = {"n": 0}
    _patch_trigger(e, calls)
    result = _run(e.get_aggregated_edges(_request()))
    assert calls["n"] == 0
    assert result.materialization_triggered is False


def test_terminal_key_suppresses_real_trigger():
    """The un-patched trigger path: terminal key present → no enqueue, no
    dedupe claim consumed."""
    p = _Provider(_result(stale=True, staleReason="legacy_cells",
                          stampVersion=1, regime="boundary"))
    e = _engine(p)
    _run(p._redis.set("materialize:terminal:ds1", "budget exceeded"))
    triggered = _run(e._trigger_materialize_in_background(
        containment_types=["HAS"], lineage_types=["FLOWS_TO"],
    ))
    assert triggered is False
    assert "materialize:in-flight:ds1" not in p._redis.store
