"""``excludeInternal`` on /edges/aggregated: a container's roll-ups without
the cells it has with what it holds, or with what holds it.

Selecting a collapsed container asks for every cell out of it (no targets
named) and into it (no sources named). Those answers hold a cell to each of
its own descendants a flow inside it reaches, at every level, and to the
ancestors it shares with a far end. Such a cell is the container summarised
against itself: the canvas drops it, but only when it knows the far end's
containment, and it never does for the rows of a closed container. Heavy
internal cells then filled the canvas's bound on cells and cut off the
partners it asked for. With ``excludeInternal`` the server drops them first,
placing both ends through their ancestor chains.
"""
import asyncio
from unittest.mock import AsyncMock

from fastapi import Response

from backend.app.api.v1.endpoints import graph as graph_module
from backend.app.services.context_engine import ContextEngine
from backend.common.models.graph import (
    AggregatedEdgeInfo,
    AggregatedEdgeRequest,
    AggregatedEdgeResult,
    OntologyMetadata,
)

# C sits in DB and holds C.t, which holds C.t.col. X sits in DB2. "far" has
# no known chain.
CHAINS = {
    "DB": [], "C": ["DB"], "C.t": ["C", "DB"], "C.t.col": ["C.t", "C", "DB"],
    "DB2": [], "X": ["DB2"],
}


def _cell(s, t, w):
    return AggregatedEdgeInfo(id=f"agg-{s}-{t}", sourceUrn=s, targetUrn=t, edgeCount=w,
                              edgeTypes=["FLOWS_TO"], confidence=1.0, sourceEdgeIds=[])


class _Provider:
    def __init__(self, cells):
        self.cells = cells
        self.chains_asked = []

    async def get_aggregated_edges_between(self, source_urns, target_urns, granularity,
                                           containment_edges, lineage_edges, *, timeout=None):
        return AggregatedEdgeResult(
            aggregatedEdges=[_cell(s, t, w) for s, t, w in self.cells],
            totalSourceEdges=sum(w for _, _, w in self.cells), lastMaterializedAt="t0")

    async def get_ancestor_chains(self, urns):
        self.chains_asked.append(sorted(urns))
        return {u: CHAINS[u] for u in urns if u in CHAINS}


def _engine(provider):
    e = ContextEngine(provider=provider)

    async def _meta():
        return OntologyMetadata(
            containmentEdgeTypes=["HAS"], lineageEdgeTypes=["FLOWS_TO"],
            edgeTypeMetadata={}, entityTypeHierarchy={}, rootEntityTypes=[],
        )

    e.get_ontology_metadata = _meta
    return e


def _pairs(result):
    return [(e.source_urn, e.target_urn) for e in result.aggregated_edges]


OUT = [("C", "C.t", 10), ("C", "C.t.col", 10), ("C", "DB", 3),
       ("C", "X", 1), ("C", "DB2", 1), ("C", "far", 1)]


def test_a_containers_cells_out_leave_out_what_it_holds_and_what_holds_it():
    p = _Provider(OUT)
    got = asyncio.run(_engine(p).get_aggregated_edges(
        AggregatedEdgeRequest(sourceUrns=["C"], excludeInternal=True)))
    # A far end with no known chain cannot be told inside: it is kept.
    assert _pairs(got) == [("C", "X"), ("C", "DB2"), ("C", "far")]
    assert got.total_source_edges == 3
    assert got.last_materialized_at == "t0"
    assert p.chains_asked == [["C", "C.t", "C.t.col", "DB", "DB2", "X", "far"]]


def test_a_containers_cells_in_leave_out_what_it_holds_and_what_holds_it():
    p = _Provider([("C.t.col", "C", 4), ("DB", "C", 2), ("X", "C", 1)])
    got = asyncio.run(_engine(p).get_aggregated_edges(
        AggregatedEdgeRequest(sourceUrns=[], targetUrns=["C"], excludeInternal=True)))
    assert _pairs(got) == [("X", "C")]
    assert got.total_source_edges == 1


def test_without_the_flag_the_answer_is_the_readers_own():
    p = _Provider(OUT)
    got = asyncio.run(_engine(p).get_aggregated_edges(AggregatedEdgeRequest(sourceUrns=["C"])))
    assert _pairs(got) == [(s, t) for s, t, _ in OUT]
    assert p.chains_asked == []


class _Engine:
    """A workspace-scoped stand-in, so the route takes the response cache."""

    def __init__(self):
        self._workspace_id = "ws1"
        self._data_source_id = "ds1"
        self._branch_id = ""
        self.provider = object()

    async def get_aggregated_edges(self, request):
        return AggregatedEdgeResult(aggregatedEdges=[], totalSourceEdges=0)


class _Cache:
    def __init__(self):
        self.params = []

    async def get_or_compute(self, *, params, compute, **kw):
        self.params.append(params)
        return await compute()


def test_the_flag_is_part_of_the_cache_key_and_only_when_set(monkeypatch):
    """An answer without internal cells must not be served for an ask that
    wants them, nor the other way round; an ask without the flag keeps the
    key it had, so the entries already cached still answer it."""
    cache = _Cache()
    monkeypatch.setattr(graph_module, "get_graph_cache", lambda: cache)
    monkeypatch.setattr(graph_module, "get_source_stale_reason", AsyncMock(return_value=None))
    for flag in (False, True):
        asyncio.run(graph_module.get_aggregated_edges(
            Response(), AggregatedEdgeRequest(sourceUrns=["C"], excludeInternal=flag), _Engine()))
    assert "excludeInternal" not in cache.params[0]
    assert cache.params[1]["excludeInternal"] is True
