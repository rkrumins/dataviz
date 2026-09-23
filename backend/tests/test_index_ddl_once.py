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

And the other direction — the storm that DOES happen, because the marker is
written only on a clean sweep. When the NODE refuses (`-NOREPLICAS` from
`min-replicas-to-write`, `-LOADING`, a socket that is not there), every one of
the 131 statements fails, no marker is written, and the next ontology-cache
miss runs the whole set again. On the interactive read path
(`context_engine._resolve_ontology`) that is 131 doomed round trips per
reader, for as long as the condition lasts — an hour-long node restart, say.
So a refusal that is about the node stops the set at the first statement and
silences it for everyone for a short while.
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

    async def delete(self, key):
        self.kv.pop(key, None)


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
            if cypher.startswith("CALL db.indexes()"):
                return None                      # a read of the catalogue, not DDL
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
            if cypher.startswith("CALL db.indexes()"):
                return None                      # a read of the catalogue, not DDL
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


# ── the node refusing, rather than the statement failing ────────────────


class _Refusing:
    """A node that answers every DDL the same way, because the refusal is
    about the node and not about the statement."""

    def __init__(self, error):
        self.error = error
        self.issued = []

    async def query(self, cypher, **kw):
        if cypher.startswith("CALL db.indexes()"):
            return None                      # a read of the catalogue, not DDL
        self.issued.append(cypher)
        raise self.error


def _refusing_provider(error):
    p = FalkorDBProvider(host="x", graph_name="g")
    graph = _Refusing(error)
    p._graph = graph
    p._redis = _FakeRedis()
    p.issued = graph.issued

    async def _connected():
        return None

    p._ensure_connected = _connected
    return p


class ReadOnlyError(Exception):
    """The sentinel spelling of a failover: this node was the master when the
    pool connected and has been demoted. Matched by class name, like the
    cluster errors, because it is a ResponseError and not a ConnectionError."""


class ClusterDownError(Exception):
    """Named to match: the cluster classifier keys on the exception CLASS
    NAME, not the message, so a fake raising a bare RuntimeError would test
    the wrong thing — redis-py raises this class for ``-CLUSTERDOWN``."""


NODE_REFUSALS = [
    RuntimeError("NOREPLICAS Not enough good replicas to write."),
    RuntimeError("LOADING FalkorDB is loading the dataset in memory"),
    ConnectionRefusedError("Connection refused"),
    ClusterDownError("CLUSTERDOWN The cluster is down"),
    ReadOnlyError("READONLY You can't write against a read only replica"),
    asyncio.TimeoutError(),
]


@pytest.mark.parametrize("error", NODE_REFUSALS)
def test_a_node_that_refuses_stops_the_set_at_the_first_statement(error):
    """Every remaining statement would be refused for the same reason, so
    they buy nothing and cost an interactive reader a round trip each."""
    p = _refusing_provider(error)
    _run(p.ensure_indices(TYPES))
    assert len(p.issued) == 1, p.issued


@pytest.mark.parametrize("error", NODE_REFUSALS)
def test_the_refusal_silences_the_set_for_everyone(error):
    """The marker is where every pod looks. Without it the fail-fast only
    shortens one storm and the herd behind it starts the next."""
    p = _refusing_provider(error)
    _run(p.ensure_indices(TYPES))
    _run(p.ensure_indices(TYPES))
    _run(p.ensure_indices(TYPES))
    assert len(p.issued) == 1, "the set was re-entered while the node was refusing"


def test_a_refusal_does_not_record_the_set_as_applied():
    """It says nothing about whether the indices exist — so a graph that was
    genuinely missing them must still get them once the node recovers."""
    p = _refusing_provider(RuntimeError("NOREPLICAS Not enough good replicas to write."))
    _run(p.ensure_indices(TYPES))
    assert not any(k.endswith(":indices_ensured") for k in p._redis.kv)

    # The condition lifts (here: the backoff expires and the node answers).
    p._redis.kv.clear()
    healthy = _provider()
    healthy._redis = p._redis
    _run(healthy.ensure_indices(TYPES))
    assert len(healthy.issued) == _expected_count(TYPES)


def test_force_still_reaches_a_refusing_node():
    """An operator asking for it explicitly is not the herd the backoff is
    for, and the answer they need is the node's, not the marker's."""
    p = _refusing_provider(RuntimeError("NOREPLICAS Not enough good replicas to write."))
    _run(p.ensure_indices(TYPES))
    _run(p.ensure_indices(TYPES, force=True))
    assert len(p.issued) == 2


def test_a_clean_sweep_clears_the_backoff():
    """Whatever the node was refusing for is over, and leaving the key to
    expire would keep a forced run's success from unblocking everyone else."""
    shared = _FakeRedis()
    refused = _refusing_provider(RuntimeError("NOREPLICAS Not enough good replicas to write."))
    refused._redis = shared
    _run(refused.ensure_indices(TYPES))
    assert any(k.endswith(":indices_deferred") for k in shared.kv)

    healthy = _provider()
    healthy._redis = shared
    _run(healthy.ensure_indices(TYPES, force=True))
    assert not any(k.endswith(":indices_deferred") for k in shared.kv)


@pytest.mark.parametrize("error", [
    RuntimeError("Query's mem consumption exceeded maximum allowed size"),
    RuntimeError("Query timed out"),
])
def test_a_statement_too_big_for_the_node_does_not_stop_the_others(error):
    """The line ``_replica_at_fault`` already draws, and it matters more here.
    A per-query memory ceiling and a SERVER-aborted deadline are
    deterministic for that statement, so deferring on one would abandon every
    statement after it, re-issue the same prefix on every attempt, and never
    lift — the largest label's index would permanently cost every smaller
    label its own."""
    p = _refusing_provider(error)
    _run(p.ensure_indices(TYPES))
    assert len(p.issued) == _expected_count(TYPES)


def test_one_sweep_per_pod_and_the_rest_skip():
    """The provider instance is process-cached per graph and every concurrent
    reader shares it, but nothing else serialises them: the ontology resolve
    lock is per-REQUEST and the shared cache has no in-flight registry. So a
    cold window used to admit one full sweep per admitted reader."""
    p = _provider()
    entered = []

    async def _slow(cypher, **kw):
        entered.append(cypher)
        await asyncio.sleep(0)              # yield, so the herd gets its turn
        return None

    p._graph.query = _slow

    async def _herd():
        await asyncio.gather(*[p.ensure_indices(TYPES) for _ in range(8)])

    _run(_herd())
    # One sweep ran; the other seven found it in flight and went away. They
    # SKIP rather than queue: the work is idempotent and someone else is
    # doing it, so waiting would trade a storm for a stall on a request a
    # person is holding open.
    assert len(entered) == _expected_count(TYPES)


def test_the_flag_is_released_even_when_the_node_refuses():
    """A sweep that stops early must not leave the graph looking permanently
    busy — nothing would ever index it again in this process."""
    p = _refusing_provider(RuntimeError("NOREPLICAS Not enough good replicas to write."))
    _run(p.ensure_indices(TYPES))
    assert p._index_sweeping is False


def test_a_statement_the_server_rejects_still_lets_the_rest_run():
    """The other direction, and the one that must not change: a refusal about
    THE STATEMENT (a syntax an older server does not support) says nothing
    about the next statement, so the set carries on and the failure is
    reported."""
    p = _provider(fail_on="targetDepth")
    _run(p.ensure_indices(TYPES))
    assert len(p.issued) == _expected_count(TYPES)


def test_the_edge_index_set_is_declared_once():
    """The provider and the materializer read ONE list. They used to keep two
    copies, three of whose entries duplicated each other."""
    from backend.app.providers.index_policy import edge_index_ddl

    assert list(_AGGREGATED_EDGE_INDEXES) == edge_index_ddl()
    assert all(c.startswith("CREATE INDEX FOR ()-[r:AGGREGATED]-()")
               for c in _AGGREGATED_EDGE_INDEXES)


def test_no_declared_edge_index_is_single_column_on_a_paired_property():
    """The retirement, stated as a rule rather than a list.

    Every predicate on these four properties anywhere in the product is a PAIR
    — ``r.sourceDepth = $d AND r.targetDepth = $d``. Nothing filters on one
    alone, so no plan can enter through a single-column index on it. Declaring
    one again would cost a document per aggregated edge in memory, on every
    write, and again on every load, to serve nothing.
    """
    from backend.app.providers.index_policy import declared_edge_indexes

    paired = {"sourceLevel", "targetLevel", "sourceDepth", "targetDepth"}
    for ix in declared_edge_indexes():
        if len(ix.props) == 1 and ix.props[0] in paired:
            raise AssertionError(
                f"{ix.ddl} is single-column on a property only ever queried as "
                f"a pair — no query can enter through it")


def test_every_declared_index_names_the_query_that_enters_through_it():
    """An index with no named entry point is how the retired four came to
    exist: the DDL was accepted, and that was mistaken for the planner
    choosing it."""
    from backend.app.providers.index_policy import declared_edge_indexes

    for ix in declared_edge_indexes():
        assert ix.entered_by and "MATCH" in ix.entered_by, (
            f"{ix.ddl} declares no query shape that enters through it")


def test_the_retired_set_is_disjoint_from_the_declared_one():
    """The cleanup script drops what is retired. If a property appeared in
    both, it would be dropped and recreated on every run — a churn loop over
    an index rebuild on a multi-gigabyte graph."""
    from backend.app.providers.index_policy import (
        RETIRED_EDGE_INDEXES, declared_edge_indexes,
    )

    declared = {(ix.rel, ix.props) for ix in declared_edge_indexes()}
    retired = {(ix.rel, ix.props) for ix in RETIRED_EDGE_INDEXES}
    assert not (declared & retired)


def test_a_marker_over_a_graph_with_no_indexes_is_not_trusted():
    """GRAPH.DELETE takes every index with it, and the marker lives in Redis, outside
    the graph: after the 2026-09-22 heal the graph had 0 indexes while the marker still
    claimed the set was applied, so every read was a full scan. The graph itself is
    the authority — a definite "no indexes" re-applies the set."""
    p = _provider()
    _run(p.ensure_indices(TYPES))
    first = len(p.issued)

    class _Wiped:
        async def query(self, cypher, **kw):
            p.issued.append(cypher)
            if cypher.startswith("CALL db.indexes()"):
                return type("R", (), {"result_set": [[0]]})()
            return None
    p._graph = _Wiped()
    _run(p.ensure_indices(TYPES))
    ddl = [c for c in p.issued[first:] if not c.startswith("CALL db.indexes()")]
    assert len(ddl) == _expected_count(TYPES), "a wiped graph must get its indexes back"
