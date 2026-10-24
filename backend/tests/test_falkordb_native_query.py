"""Native queries on FalkorDB run apart from the provider's own reads: on a
replica first, over connections of their own whose parser caps the reply,
once — never retried, never re-run on the master — and a failure says what
went wrong with the query, or benches the replica that failed.
"""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from redis.exceptions import ConnectionError as RedisConnectionError
from redis.exceptions import MovedError, ResponseError

from backend.app.providers import falkordb_native
from backend.app.providers.falkordb_native import NativePools, run_native
from backend.common.interfaces.native_query import (
    NativeQueryError,
    NativeQuerySyntaxError,
    NativeQueryTimeout,
    NativeQueryTooLarge,
    NativeQueryWriteRefused,
)


class FakeGraph:
    def __init__(self, answer):
        self.answer = answer
        self.calls = []

    async def ro_query(self, query, timeout=None):
        self.calls.append((query, timeout))
        if isinstance(self.answer, BaseException):
            raise self.answer
        if callable(self.answer):
            return await self.answer()
        return self.answer


class FakeProvider:
    """What ``run_native`` asks of a provider — and the provider's own read
    path, which it must never touch."""

    def __init__(self, *, replica=None, mode="standalone", cap_ms=0, missing=False):
        self._graph_name = "g"
        self._conn_cfg = SimpleNamespace(mode=mode)
        self._replica = replica
        self._cap_ms = cap_ms
        self._missing = missing
        self.benched = []

    async def _ensure_connected(self):
        pass

    async def _replica_for(self, graph_key, *, include_master=False):
        assert not include_master
        return self._replica

    def _server_timeout_cap_ms(self):
        return self._cap_ms

    def _penalise_replica(self, node, exc):
        self.benched.append((node, type(exc).__name__))

    async def _is_verified_missing_graph(self, exc):
        return self._missing

    async def _read_query(self, *a, **k):              # pragma: no cover — must not run
        raise AssertionError("a native query went through the provider's read path")

    _guarded_timed = _read_query


@pytest.fixture
def engine(monkeypatch):
    """Hand ``run_native`` a fake graph, and record the endpoint it asked for."""
    asked = []

    def install(answer):
        graph = FakeGraph(answer)

        async def fake_graph(self, provider, endpoint, **kwargs):
            asked.append((endpoint, kwargs))
            return graph

        monkeypatch.setattr(NativePools, "graph", fake_graph)
        return graph

    install.asked = asked
    return install


def result(header, rows):
    return SimpleNamespace(header=header, result_set=rows)


async def run(provider, **kwargs):
    args = dict(row_cap=3, timeout_ms=5000, max_reply_bytes=1 << 20, pool_size=2)
    args.update(kwargs)
    return await run_native(provider, "MATCH (n) RETURN n.x AS x LIMIT 3", **args)


async def test_a_replica_answers_first(engine):
    graph = engine(result([[1, "x"]], [[1], [2]]))
    replica = SimpleNamespace(host="10.0.0.7", port=6380)
    answer = await run(FakeProvider(replica=replica))
    assert answer.columns == ["x"] and answer.rows == [[1], [2]]
    assert engine.asked[0][0] == ("10.0.0.7", 6380, False)
    assert graph.calls == [("MATCH (n) RETURN n.x AS x LIMIT 3", 5000)]


async def test_a_cluster_replica_is_asked_on_a_read_only_connection(engine):
    engine(result([], []))
    await run(FakeProvider(replica=SimpleNamespace(host="r", port=1), mode="cluster"))
    assert engine.asked[0][0] == ("r", 1, True)


async def test_the_master_answers_when_no_replica_may(engine):
    engine(result([], []))
    await run(FakeProvider())
    assert engine.asked[0][0] is None


async def test_the_pool_is_the_native_one(engine):
    engine(result([], []))
    await run(FakeProvider(), max_reply_bytes=4096, pool_size=3)
    kwargs = engine.asked[0][1]
    assert kwargs["max_reply_bytes"] == 4096 and kwargs["pool_size"] == 3


async def test_rows_stop_at_the_cap_and_values_become_cells(engine):
    engine(result([[1, b"a"], [1, "b"]], [[1, 2 ** 60], [3, None], [5, "x"], [7, "y"]]))
    answer = await run(FakeProvider(), row_cap=2)
    assert answer.columns == ["a", "b"]
    assert answer.rows == [[1, {"kind": "number", "text": str(2 ** 60)}], [3, None]]


async def test_the_server_timeout_is_held_to_its_ceiling(engine):
    graph = engine(result([], []))
    await run(FakeProvider(cap_ms=4000), timeout_ms=30_000)
    assert graph.calls[0][1] == 4000


async def test_a_failed_replica_is_benched_and_nothing_is_run_again(engine):
    graph = engine(RedisConnectionError("Error 111 connecting. Connection refused."))
    replica = SimpleNamespace(host="r", port=1)
    provider = FakeProvider(replica=replica)
    with pytest.raises(RedisConnectionError):
        await run(provider)
    assert len(graph.calls) == 1 and len(engine.asked) == 1
    assert provider.benched == [(replica, "ConnectionError")]


async def test_a_node_that_never_answers_times_out_and_is_benched(engine, monkeypatch):
    monkeypatch.setattr(falkordb_native, "CLIENT_GRACE_S", 0.05)

    async def never():
        await asyncio.sleep(10)

    graph = engine(never)
    replica = SimpleNamespace(host="r", port=1)
    provider = FakeProvider(replica=replica)
    with pytest.raises(NativeQueryTimeout):
        await run(provider, timeout_ms=10)
    assert len(graph.calls) == 1
    assert provider.benched == [(replica, "TimeoutError")]


async def test_the_server_timing_a_query_out_is_the_querys_not_the_replicas(engine):
    engine(ResponseError("Query timed out"))
    provider = FakeProvider(replica=SimpleNamespace(host="r", port=1))
    with pytest.raises(NativeQueryTimeout):
        await run(provider)
    assert provider.benched == []


@pytest.mark.parametrize("reply, error, position", [
    ("graph.RO_QUERY is to be executed only on read-only queries", NativeQueryWriteRefused, None),
    ("errMsg: Invalid input 'R': expected a label line: 1, column: 10, offset: 9 errCtx: MATCH (n "
     "RETURN n errCtxOffset: 9", NativeQuerySyntaxError, 9),
    ("Query's mem consumption exceeded capacity", NativeQueryTooLarge, None),
    ("Unknown function 'foo'", NativeQueryError, None),
])
async def test_what_the_server_says_about_the_query_reaches_the_person(engine, reply, error, position):
    engine(ResponseError(reply))
    with pytest.raises(error) as caught:
        await run(FakeProvider())
    assert type(caught.value) is error
    assert caught.value.position == position
    assert "errCtx" not in str(caught.value)


async def test_a_graph_that_does_not_exist_yet_answers_no_rows(engine):
    engine(ResponseError("Invalid graph operation on empty key"))
    answer = await run(FakeProvider(missing=True))
    assert answer.columns == [] and answer.rows == []


async def test_a_moved_graph_drops_the_masters_client(engine, monkeypatch):
    engine(MovedError("3999 10.0.0.9:6379"))
    dropped = []

    async def drop(self, endpoint):
        dropped.append(endpoint)

    monkeypatch.setattr(NativePools, "drop", drop)
    with pytest.raises(MovedError):
        await run(FakeProvider(mode="cluster"))
    assert dropped == [None]


async def test_one_client_per_endpoint_with_the_capped_parser(monkeypatch):
    built = []

    async def build(provider, endpoint, kwargs, socket_timeout):
        built.append((endpoint, kwargs))
        return SimpleNamespace(select_graph=lambda name: name), object()

    monkeypatch.setattr(falkordb_native, "_build", build)
    provider = SimpleNamespace(_graph_name="g",
                               _build_pool_kwargs=lambda timeout: {"socket_timeout": timeout})
    pools = NativePools()
    for _ in range(3):
        assert await pools.graph(provider, None, max_reply_bytes=2048, pool_size=2,
                                 socket_timeout=40) == "g"
    await pools.graph(provider, ("r", 1, False), max_reply_bytes=2048, pool_size=2,
                      socket_timeout=40)
    assert [endpoint for endpoint, _ in built] == [None, ("r", 1, False)]
    kwargs = built[0][1]
    assert kwargs["max_connections"] == 2 and kwargs["socket_timeout"] == 40
    assert kwargs["parser_class"].cap == 2048
