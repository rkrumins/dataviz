"""Slow-query telemetry: every Cypher through the guarded wrappers logs one
WARNING line when DB execution OR semaphore-queue wait exceeds
FALKORDB_SLOW_QUERY_MS — and stays silent below it.

query_ms and queue_ms are reported separately: queue time is the saturation
signal (work waiting on the per-provider semaphore / FalkorDB threads),
query time attributes cost to the query shape. This is the measuring stick
for the read-path perf work — op= labels let a log line be attributed to
children/aggregated/trace sub-queries without guessing from Cypher text.

No live FalkorDB required — the graph handle is a stub.
"""
import asyncio
import logging

import pytest

from backend.app.providers.falkordb_provider import FalkorDBProvider


class _FakeResult:
    def __init__(self, rows):
        self.result_set = rows


class _FakeGraph:
    """ro_query/query stub with a configurable artificial delay."""

    def __init__(self, delay_s=0.0, rows=None):
        self.delay_s = delay_s
        self.rows = rows if rows is not None else [[1]]

    async def ro_query(self, cypher, params=None, timeout=None):
        if self.delay_s:
            await asyncio.sleep(self.delay_s)
        return _FakeResult(self.rows)

    async def query(self, cypher, params=None, timeout=None):
        if self.delay_s:
            await asyncio.sleep(self.delay_s)
        return _FakeResult(self.rows)


def _make_provider(delay_s=0.0):
    p = FalkorDBProvider(host="x", graph_name="slowlog-test")

    async def _noop_connect():
        return None

    p._ensure_connected = _noop_connect
    p._graph = _FakeGraph(delay_s=delay_s)
    return p


def _slow_lines(caplog):
    return [r for r in caplog.records if "falkordb slow" in r.getMessage()]


def test_fast_query_logs_nothing(caplog, monkeypatch):
    from backend.app.config import resilience
    monkeypatch.setattr(resilience, "FALKORDB_SLOW_QUERY_MS", 500)
    p = _make_provider(delay_s=0.0)
    with caplog.at_level(logging.WARNING):
        asyncio.get_event_loop().run_until_complete(
            p._ro_query("MATCH (n) RETURN n LIMIT 1", op="nodes.get")
        )
    assert _slow_lines(caplog) == []


def test_slow_query_logs_one_warning_with_op_and_timings(caplog, monkeypatch):
    from backend.app.config import resilience
    monkeypatch.setattr(resilience, "FALKORDB_SLOW_QUERY_MS", 10)
    p = _make_provider(delay_s=0.05)
    with caplog.at_level(logging.WARNING):
        asyncio.get_event_loop().run_until_complete(
            p._ro_query("MATCH (n) WHERE n.urn IN $urns RETURN n", op="children.page")
        )
    lines = _slow_lines(caplog)
    assert len(lines) == 1
    msg = lines[0].getMessage()
    assert "op=children.page" in msg
    assert "graph=slowlog-test" in msg
    assert "query_ms=" in msg and "queue_ms=" in msg
    assert "rows=1" in msg
    assert "MATCH (n) WHERE n.urn IN $urns" in msg


def test_slow_query_logs_error_class_on_failure(caplog, monkeypatch):
    from backend.app.config import resilience
    monkeypatch.setattr(resilience, "FALKORDB_SLOW_QUERY_MS", 10)
    p = _make_provider()

    async def _boom(cypher, params=None, timeout=None):
        await asyncio.sleep(0.05)
        raise RuntimeError("synthetic failure")

    p._graph.ro_query = _boom
    with caplog.at_level(logging.WARNING):
        with pytest.raises(RuntimeError):
            asyncio.get_event_loop().run_until_complete(
                p._ro_query("MATCH (n) RETURN n", op="agg.cells")
            )
    lines = _slow_lines(caplog)
    assert len(lines) == 1
    msg = lines[0].getMessage()
    assert "err=RuntimeError" in msg
    assert "op=agg.cells" in msg


def test_queue_wait_alone_triggers_the_log(caplog, monkeypatch):
    """Saturation visibility: a fast query that WAITED long for a slot still
    logs, with the wait attributed to queue_ms (not query_ms)."""
    from backend.app.config import resilience
    monkeypatch.setattr(resilience, "FALKORDB_SLOW_QUERY_MS", 30)
    p = _make_provider(delay_s=0.0)
    p._query_semaphore = asyncio.Semaphore(1)

    async def _scenario():
        async def _hold():
            async with p._query_semaphore:
                await asyncio.sleep(0.06)

        holder = asyncio.ensure_future(_hold())
        await asyncio.sleep(0.005)  # let the holder grab the slot
        await p._ro_query("MATCH (n) RETURN n LIMIT 1", op="nodes.get")
        await holder

    with caplog.at_level(logging.WARNING):
        asyncio.get_event_loop().run_until_complete(_scenario())
    lines = _slow_lines(caplog)
    assert len(lines) == 1
    msg = lines[0].getMessage()
    q_ms = int(msg.split("query_ms=")[1].split(" ")[0])
    queue_ms = int(msg.split("queue_ms=")[1].split(" ")[0])
    assert queue_ms >= 30
    assert q_ms < 30
