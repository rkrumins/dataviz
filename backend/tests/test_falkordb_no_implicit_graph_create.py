"""Background index DDL must never resurrect a deleted FalkorDB graph.

FalkorDB has no ``CREATE GRAPH``: a write-mode ``GRAPH.QUERY`` creates the graph
key implicitly, and ``CREATE INDEX`` is a write-mode query. ``ensure_indices`` /
``ensure_projections`` are fired fire-and-forget from ``_schedule_reconcile_once``
on every provider instance's first connect — so before this guard, an operator
who deleted a graph in the FalkorDB UI got it back, empty (0 nodes / 0 edges),
as soon as any discovery job, counts poll, probe or aggregation job next touched
the provider. The list-all discovery job, whose provider defaults to the
``nexus_lineage`` graph name, did the same on instances that never had one.

The guard is an ``EXISTS`` probe — a KEYED command, so cluster clients route it to
the node that owns the graph — and it fails CLOSED: missing indexes are
best-effort and heal on the next connect; a resurrected graph does not heal.
"""
import asyncio
import logging
from types import SimpleNamespace

import pytest


def _run(coro):
    return asyncio.run(coro)


class _RecordingGraph:
    """A graph handle that records every write-mode statement sent to it."""

    def __init__(self):
        self.queries = []

    async def query(self, cypher, timeout=None, **kw):
        self.queries.append(cypher)
        return SimpleNamespace(result_set=[])


def _provider(exists, *, projection_mode="in_source", proj_exists=None):
    """A bare provider whose ``EXISTS`` probe answers ``exists``.

    ``exists`` is an int, or an exception instance to raise. ``proj_exists``
    gives the dedicated projection client its own answer so a test can prove
    which key was probed on which client.
    """
    from backend.app.providers.falkordb_provider import FalkorDBProvider

    p = object.__new__(FalkorDBProvider)
    p._graph_name = "deleted_graph"
    p._graph = _RecordingGraph()
    p._projection_mode = projection_mode
    p._proj_graph = _RecordingGraph() if projection_mode == "dedicated" else None
    p.probed = []

    def _client(answer):
        async def _execute_command(cmd, *args):
            assert cmd == "EXISTS"
            p.probed.append((answer_label(answer), args[0]))
            if isinstance(answer, BaseException):
                raise answer
            return answer
        return SimpleNamespace(execute_command=_execute_command)

    def answer_label(a):
        return "proj" if a is proj_exists and proj_exists is not None else "db"

    p._db = _client(exists)
    p._proj_db = _client(proj_exists) if proj_exists is not None else None

    proj_calls = []

    async def _proj_query(cypher, params=None, **kw):
        proj_calls.append(cypher)
        return SimpleNamespace(result_set=[])

    p._proj_query = _proj_query
    p.proj_calls = proj_calls
    return p


# ── ensure_indices ───────────────────────────────────────────────────────


def test_absent_graph_issues_no_index_ddl():
    """The whole point: a graph that is gone stays gone."""
    p = _provider(0)
    _run(p.ensure_indices(["table"]))
    assert p._graph.queries == []
    assert p.probed == [("db", "deleted_graph")]


def test_present_graph_still_gets_its_indices():
    p = _provider(1)
    _run(p.ensure_indices(["table"]))
    assert any("CREATE INDEX" in q for q in p._graph.queries)


def test_a_caller_about_to_populate_may_create_the_graph():
    """``save_custom_graph`` and the bulk loader index BEFORE their first write,
    deliberately — without the index every MERGE is a full label scan."""
    p = _provider(0)
    _run(p.ensure_indices(["table"], may_create_graph=True))
    assert any("CREATE INDEX" in q for q in p._graph.queries)
    assert p.probed == []          # opting in skips the probe entirely


def test_probe_failure_fails_closed(caplog):
    p = _provider(RuntimeError("connection reset"))
    with caplog.at_level(
        logging.WARNING, logger="backend.app.providers.falkordb_provider",
    ):
        _run(p.ensure_indices(["table"]))
    assert p._graph.queries == []
    assert any("EXISTS probe" in r.getMessage() for r in caplog.records)


def test_skipping_ddl_still_records_the_indexed_vocabulary():
    """``get_nodes_by_layer`` anchors its label union on this. Skipping the DDL
    must not also strip the anchor out from under the readers."""
    p = _provider(0)
    _run(p.ensure_indices(["table", "column"]))
    assert p._indexed_entity_type_ids == ["table", "column"]


# ── ensure_projections ───────────────────────────────────────────────────


def test_ensure_projections_skips_an_absent_graph():
    p = _provider(0)
    _run(p.ensure_projections())
    assert p.proj_calls == []


def test_in_source_projection_probes_the_source_key():
    """``_proj`` IS the source graph in in_source mode, so unguarded DDL here
    would recreate the deleted SOURCE graph, not a projection."""
    p = _provider(0, projection_mode="in_source")
    _run(p.ensure_projections())
    assert p.probed == [("db", "deleted_graph")]


def test_dedicated_projection_probes_its_own_key_on_its_own_client():
    """On a cluster ``{graph}_proj`` can hash to a different shard, so it has its
    own client; probing it through ``_db`` would ask the wrong node."""
    p = _provider(1, projection_mode="dedicated", proj_exists=0)
    _run(p.ensure_projections())
    assert p.probed == [("proj", "deleted_graph_proj")]
    assert p.proj_calls == []
