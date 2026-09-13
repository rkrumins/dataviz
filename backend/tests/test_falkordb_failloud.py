"""Fail-loud read path: a FalkorDB *connection* failure must surface (raise),
while a genuinely-empty / never-created graph still returns empty.

The bug: the three read catch sites swallowed *every* exception and returned
`[]` / 0, so a connection-refused (provider unreachable) looked identical to an
empty graph — the CircuitBreakerProxy saw a SUCCESS, never opened, and the UI
showed an empty "no entities" state instead of a "Provider Unavailable" banner.

Fix: reuse `_is_missing_graph_error` to split the two cases —
  * missing-graph / empty key -> return [] (legitimately no data),
  * connection failure        -> raise (surface it -> breaker -> 503 -> banner).

No live FalkorDB required — `_ro_query` is monkeypatched.
"""
import pytest
from redis.exceptions import ResponseError

from backend.app.providers.falkordb_provider import FalkorDBProvider
from backend.common.models.graph import NodeQuery


_EMPTY_KEY = ResponseError("Invalid graph operation on empty key")
_CONN_REFUSED = ConnectionError("Connection refused")


def _make_provider():
    p = FalkorDBProvider(host="x", graph_name="g")
    p._SCHEMA_CACHE_TTL = 0  # skip the redis cache read/write path

    async def _noop_connect():
        return None

    p._ensure_connected = _noop_connect
    # Empty containment set = flat graph (a valid resolved state); this keeps
    # `_get_containment_edge_types()` from raising ProviderConfigurationError so
    # the test exercises the read catch sites, not the ontology gate.
    p._resolved_containment_types = set()
    p._resolved_containment_types_set = True
    return p


def _raiser(exc):
    async def _raise(*a, **k):
        raise exc
    return _raise


# ── get_nodes ───────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_get_nodes_raises_on_connection_failure(monkeypatch):
    """Connection refused is an outage, not empty data — it must surface."""
    p = _make_provider()
    monkeypatch.setattr(p, "_ro_query", _raiser(_CONN_REFUSED))
    with pytest.raises(ConnectionError):
        await p.get_nodes(NodeQuery(include_child_count=False))


@pytest.mark.asyncio
async def test_get_nodes_empty_graph_returns_empty(monkeypatch):
    """A never-created (empty key) graph is a valid 0-node state -> []."""
    p = _make_provider()
    monkeypatch.setattr(p, "_ro_query", _raiser(_EMPTY_KEY))
    assert await p.get_nodes(NodeQuery(include_child_count=False)) == []


# ── get_top_level_or_orphan_nodes ───────────────────────────────────

@pytest.mark.asyncio
async def test_get_top_level_raises_on_connection_failure(monkeypatch):
    """The page-query catch site must re-raise a connection failure."""
    p = _make_provider()
    monkeypatch.setattr(p, "_ro_query", _raiser(_CONN_REFUSED))
    with pytest.raises(ConnectionError):
        await p.get_top_level_or_orphan_nodes(include_child_count=False)


@pytest.mark.asyncio
async def test_get_top_level_empty_graph_returns_empty(monkeypatch):
    """Empty key on BOTH the page and count queries -> empty 0/0 result."""
    p = _make_provider()
    monkeypatch.setattr(p, "_ro_query", _raiser(_EMPTY_KEY))
    result = await p.get_top_level_or_orphan_nodes(include_child_count=False)
    assert result.nodes == []
    assert result.total_count == 0


@pytest.mark.asyncio
async def test_get_top_level_count_query_raises_on_connection_failure(monkeypatch):
    """A page that succeeds-empty but a count query that hits a connection
    failure must still surface — the count catch site fails loud too."""
    p = _make_provider()

    class _Empty:
        result_set = []

    async def _ro_query(cypher, params=None, **k):
        # The page query returns an empty (but valid) result; the count query
        # then fails to connect.
        if "count(" in cypher.lower():
            raise _CONN_REFUSED
        return _Empty()

    monkeypatch.setattr(p, "_ro_query", _ro_query)
    with pytest.raises(ConnectionError):
        await p.get_top_level_or_orphan_nodes(include_child_count=False)


# ── _is_query_memory_error ───────────────────────────────────────────────
#
# QUERY_MEM_CAPACITY exhaustion arrives as a generic ResponseError (no
# distinct class), so it is matched by message like _is_missing_graph_error.
# Getting this wrong in either direction is costly: a false negative sends a
# deterministic failure back through the retry budget and the breaker, and a
# false positive would treat a real maxmemory OOM as a shrinkable query.


_QUERY_MEM = ResponseError("Query's mem consumption exceeded capacity")


def test_query_memory_error_detected_bare():
    from backend.app.providers.falkordb_provider import _is_query_memory_error
    assert _is_query_memory_error(_QUERY_MEM)


def test_query_memory_error_detected_through_cause_chain():
    """The signal routinely arrives wrapped — the pipeline re-raises through
    its own guards and the breaker relabels it further up."""
    from backend.app.providers.falkordb_provider import _is_query_memory_error
    try:
        try:
            raise _QUERY_MEM
        except ResponseError as inner:
            raise RuntimeError("aggregation pipeline on g failed") from inner
    except RuntimeError as outer:
        assert _is_query_memory_error(outer)


def test_instance_level_oom_is_not_a_query_memory_error():
    """maxmemory exhaustion is a different ceiling with a different fix —
    narrowing the query cannot help, so it must NOT enter the shrink ladder."""
    from backend.app.providers.falkordb_provider import _is_query_memory_error
    assert not _is_query_memory_error(
        ResponseError("OOM command not allowed when used memory > 'maxmemory'.")
    )
    assert not _is_query_memory_error(_EMPTY_KEY)
    assert not _is_query_memory_error(_CONN_REFUSED)
