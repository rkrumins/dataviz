"""THE INDEX DDL IS A ONE-OFF, NOT A PER-RUN TAX.

`ensure_indices` creates `(5 + N_ontology_types) × 5` node indices plus six
`:AGGREGATED` edge indices. For a twenty-type ontology that is 131 statements,
issued serially on the WRITE path. It ran unconditionally on every aggregation
job, every skip, every ontology-cache miss and every provider connect — and
before the write lease is taken and before the admission controller is
attached, so none of the pipeline's pacing applied to any of it.

Re-issuing it can only ever be a no-op, because nothing in this codebase ever
issues DROP INDEX: the set on a graph is monotonically non-decreasing for its
lifetime. So the whole cost was a parse, a plan and a write-path lock per
statement, on a graph other people are reading, once per job per source.

These tests pin: the set is applied once per graph; a changed ontology
re-applies it; a partial failure is retried rather than remembered; and `force`
overrides the marker for a caller that knows the graph was rebuilt.
"""
import asyncio

import pytest

from backend.app.providers.falkordb_provider import (
    _AGGREGATED_EDGE_INDEXES, FalkorDBProvider,
)
from backend.app.providers.index_policy import INDEXED_NODE_PROPS, indexed_labels


def _run(coro):
    return asyncio.run(coro)


class _FakeRedis:
    """Just enough of the marker store, and it starts empty like a new graph."""

    def __init__(self):
        self.kv = {}

    async def get(self, key):
        return self.kv.get(key)

    async def setex(self, key, ttl, value):
        self.kv[key] = value


def _provider(*, fail_on=None):
    """A provider whose graph records every DDL it is handed.

    ``fail_on`` is a substring; a statement containing it raises, standing in
    for a server that rejects one index (an unsupported edge-index syntax, a
    timeout) while accepting the rest.
    """
    p = FalkorDBProvider(host="x", graph_name="g")
    issued = []

    class _Graph:
        async def query(self, cypher, **kw):
            issued.append(cypher)
            if fail_on and fail_on in cypher:
                raise RuntimeError("server said no")
            return None

    p._graph = _Graph()
    p._redis = _FakeRedis()
    p.issued = issued

    async def _connected():
        return None

    p._ensure_connected = _connected
    return p


def _expected_count(types):
    return len(indexed_labels(types)) * len(INDEXED_NODE_PROPS) + len(_AGGREGATED_EDGE_INDEXES)


TYPES = ["table", "column", "report"]


def test_the_set_is_applied_once_and_then_never_again():
    p = _provider()
    _run(p.ensure_indices(TYPES))
    first = len(p.issued)
    assert first == _expected_count(TYPES)

    # Every subsequent job, skip, cache miss and connect for this graph.
    for _ in range(5):
        _run(p.ensure_indices(TYPES))
    assert len(p.issued) == first, "the DDL was re-issued for an unchanged set"


def test_a_changed_ontology_re_applies_it():
    """The set is a pure function of the entity types and the property list, so
    a new type has to bring its indices with it. No explicit invalidation
    anywhere — the digest simply stops matching."""
    p = _provider()
    _run(p.ensure_indices(TYPES))
    first = len(p.issued)

    _run(p.ensure_indices(TYPES + ["dashboard"]))
    assert len(p.issued) > first
    assert any("dashboard" in c for c in p.issued)


def test_a_partial_failure_is_retried_not_remembered():
    """A marker written over a half-applied set would leave a graph
    permanently missing an index, with nothing to notice: no code path reads
    the index catalogue to reconcile it, and none ever will while DROP INDEX
    does not exist here."""
    p = _provider(fail_on="targetDepth")
    _run(p.ensure_indices(TYPES))
    first = len(p.issued)

    _run(p.ensure_indices(TYPES))
    assert len(p.issued) == 2 * first, "a failed sweep was recorded as applied"


def test_already_indexed_is_success_not_failure():
    """FalkorDB answers an existing index with an error. That IS the idempotent
    outcome — treating it as a failure would mean the marker never gets written
    and the storm never stops."""

    class _Existing(_FakeRedis):
        pass

    p = FalkorDBProvider(host="x", graph_name="g")
    issued = []

    class _Graph:
        async def query(self, cypher, **kw):
            issued.append(cypher)
            raise RuntimeError("Attribute 'urn' is already indexed")

    p._graph = _Graph()
    p._redis = _Existing()

    async def _connected():
        return None

    p._ensure_connected = _connected

    _run(p.ensure_indices(TYPES))
    n = len(issued)
    _run(p.ensure_indices(TYPES))
    assert len(issued) == n, "an all-already-indexed sweep was not recorded"


def test_force_reapplies_over_the_marker():
    p = _provider()
    _run(p.ensure_indices(TYPES))
    first = len(p.issued)

    _run(p.ensure_indices(TYPES, force=True))
    assert len(p.issued) == 2 * first


def test_a_marker_store_that_is_down_does_not_skip_the_work():
    """No marker must mean "do the work", never "assume it is done" — the
    failure has to land on the safe side."""
    p = _provider()

    class _Broken:
        async def get(self, key):
            raise ConnectionError("redis down")

        async def setex(self, key, ttl, value):
            raise ConnectionError("redis down")

    p._redis = _Broken()
    _run(p.ensure_indices(TYPES))
    assert len(p.issued) == _expected_count(TYPES)
    _run(p.ensure_indices(TYPES))
    assert len(p.issued) == 2 * _expected_count(TYPES)


def test_the_edge_index_set_is_declared_once():
    """Three of these were also issued by the materializer's own ensure, from a
    second copy of the list. Sharing the declaration is what lets the two be
    compared rather than drift apart."""
    assert len(_AGGREGATED_EDGE_INDEXES) == 6
    assert all(c.startswith("CREATE INDEX FOR ()-[r:AGGREGATED]-()")
               for c in _AGGREGATED_EDGE_INDEXES)
