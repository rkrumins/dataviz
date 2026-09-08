"""A read must never bring a deleted graph back.

FalkorDB decides per COMMAND whether a missing graph key is created
(``should_command_create_graph``, ``src/commands/cmd_dispatcher.c``)::

    CMD_QUERY / CMD_PROFILE    -> shouldCreate = true
    CMD_RO_QUERY / CMD_EXPLAIN -> shouldCreate = false

so every ``GRAPH.QUERY`` issued purely to OBSERVE re-materialises a graph an
operator deleted as an empty 0-node / 0-edge graph. Three scheduled paths did
exactly that: the connect-time index reconcile (``CREATE INDEX`` is a
``GRAPH.QUERY``), the projector's reachability probe, and the versioning
reconcile's drift counts and scans.

These tests pin the contract: observability probes first and stays silent when
the graph is gone; write paths still create.
"""
import asyncio
import logging

import pytest

from backend.app.providers.falkordb_provider import FalkorDBProvider


def _run(coro):
    return asyncio.run(coro)


class _RecordingGraph:
    """Records every ``GRAPH.QUERY`` the DDL would have issued."""

    def __init__(self):
        self.queries = []

    async def query(self, cypher, timeout=None, params=None):
        self.queries.append(cypher)
        return None


def _provider(graph, *, exists, name="acme_graph"):
    """A bare provider whose EXISTS probe answers ``exists``.

    ``exists`` is passed straight through as the Redis reply, so ``None``
    models a probe that could not answer at all.
    """

    class _Db:
        def __init__(self):
            self.commands = []

        async def execute_command(self, *args):
            self.commands.append(args)
            if exists is None:
                raise RuntimeError("instance unreachable")
            return 1 if exists else 0

    p = object.__new__(FalkorDBProvider)
    p._graph = graph
    p._graph_name = name
    p._db = _Db()
    p._projection_mode = "in_source"

    async def _connected():
        return None

    p._ensure_connected = _connected
    return p


# ── the probe itself ─────────────────────────────────────────────────────


def test_graph_key_exists_maps_the_redis_reply():
    assert _run(_provider(_RecordingGraph(), exists=True).graph_key_exists()) is True
    assert _run(_provider(_RecordingGraph(), exists=False).graph_key_exists()) is False


def test_graph_key_exists_is_unknown_not_false_when_it_cannot_ask():
    """An unreachable instance must not be reported as "graph absent" — and it
    must not raise either, or ``ensure_indices``'s never-raises contract breaks."""
    assert _run(_provider(_RecordingGraph(), exists=None).graph_key_exists()) is None


def test_graph_key_exists_probes_the_named_key():
    p = _provider(_RecordingGraph(), exists=True)
    _run(p.graph_key_exists("other_proj"))
    assert p._db.commands == [("EXISTS", "other_proj")]


# ── ensure_indices ───────────────────────────────────────────────────────


def test_ensure_indices_skips_ddl_when_the_graph_is_gone():
    graph = _RecordingGraph()
    _run(_provider(graph, exists=False).ensure_indices(["table"]))
    assert graph.queries == []


def test_ensure_indices_skips_ddl_when_existence_is_unknown():
    """Unknown is treated as absent: an index is best-effort and retried on the
    next connect, whereas creating a graph an operator deleted is not something
    this process can undo."""
    graph = _RecordingGraph()
    _run(_provider(graph, exists=None).ensure_indices(["table"]))
    assert graph.queries == []


def test_ensure_indices_runs_ddl_when_the_graph_exists():
    graph = _RecordingGraph()
    _run(_provider(graph, exists=True).ensure_indices(["table"]))
    assert any("CREATE INDEX" in q for q in graph.queries)


def test_ensure_indices_allow_graph_create_never_probes():
    """The write path indexes BEFORE its MERGEs, on a graph that does not exist
    yet — so it must not be gated on the graph existing."""
    graph = _RecordingGraph()
    p = _provider(graph, exists=False)
    _run(p.ensure_indices(["table"], allow_graph_create=True))
    assert any("CREATE INDEX" in q for q in graph.queries)
    assert p._db.commands == []


# ── ensure_projections ───────────────────────────────────────────────────


def test_ensure_projections_skips_when_the_projection_graph_is_gone():
    p = _provider(_RecordingGraph(), exists=False)
    calls = []

    async def _proj_query(cypher, *a, **kw):
        calls.append(cypher)

    p._proj_query = _proj_query
    _run(p.ensure_projections())
    assert calls == []


def test_ensure_projections_probes_the_dedicated_companion_key():
    """In "dedicated" mode the target is the SEPARATE ``<graph>_proj`` key, so an
    ungated reconcile recreated both the source graph and its companion."""
    p = _provider(_RecordingGraph(), exists=False)
    p._projection_mode = "dedicated"
    p._proj_query = lambda *a, **kw: None
    _run(p.ensure_projections())
    assert p._db.commands == [("EXISTS", "acme_graph_proj")]


# ── the versioning reconcile's drift reads ───────────────────────────────


class _EmptyKeyGraph:
    """A client whose graph key does not exist. ``query`` would CREATE it —
    calling it at all is the failure this fixture detects."""

    def __init__(self):
        self.ro_calls = []

    async def ro_query(self, cypher, params=None, timeout=None):
        self.ro_calls.append(cypher)
        raise RuntimeError("Invalid graph operation on empty key")

    async def query(self, cypher, params=None, timeout=None):
        raise AssertionError(
            "a drift check used GRAPH.QUERY — that recreates the deleted graph"
        )


class _CountingGraph:
    def __init__(self, node_count, edge_count):
        self._counts = [node_count, edge_count]
        self.ro_calls = []

    async def ro_query(self, cypher, params=None, timeout=None):
        self.ro_calls.append(cypher)

        class _Res:
            result_set = [[self._counts[len(self.ro_calls) - 1]]]

        return _Res()

    async def query(self, cypher, params=None, timeout=None):
        raise AssertionError("drift counts must be read-only")


def test_falkor_counts_reads_read_only():
    from backend.app.services.versioning.reconcile import falkor_counts

    graph = _CountingGraph(7, 11)
    assert _run(falkor_counts(graph)) == (7, 11)
    assert len(graph.ro_calls) == 2


def test_falkor_counts_reports_a_deleted_graph_as_empty():
    from backend.app.services.versioning.reconcile import falkor_counts

    assert _run(falkor_counts(_EmptyKeyGraph())) == (0, 0)


def test_falkor_counts_still_propagates_real_errors():
    from backend.app.services.versioning.reconcile import falkor_counts

    class _Broken:
        async def ro_query(self, cypher, params=None, timeout=None):
            raise RuntimeError("connection reset by peer")

    with pytest.raises(RuntimeError, match="connection reset"):
        _run(falkor_counts(_Broken()))


def test_scan_falkor_yields_nothing_for_a_deleted_graph():
    from backend.app.services.versioning.reconcile import ProjectionReconciler

    rec = object.__new__(ProjectionReconciler)

    async def _drain():
        return [row async for row in rec._scan_falkor(_EmptyKeyGraph(), "MATCH (n) RETURN n")]

    assert _run(_drain()) == []


# ── the projector's helpers ──────────────────────────────────────────────


def test_q_ro_prefers_ro_query():
    from backend.app.services.versioning.projection import _q_ro

    graph = _CountingGraph(1, 1)
    _run(_q_ro(graph, "RETURN 1"))
    assert graph.ro_calls == ["RETURN 1"]


def test_q_ro_falls_back_for_clients_without_ro_query():
    """Test fakes and older client shims have no ``ro_query``; their behaviour
    must not change."""
    from backend.app.services.versioning.projection import _q_ro

    class _OldClient:
        def __init__(self):
            self.calls = []

        async def query(self, cypher, params=None, timeout=None):
            self.calls.append(cypher)

    client = _OldClient()
    _run(_q_ro(client, "RETURN 1"))
    assert client.calls == ["RETURN 1"]
