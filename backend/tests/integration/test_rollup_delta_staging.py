"""A window's lineage-summary deltas write the same whether they net in memory or through
``rollup_deltas`` (live Postgres; the deltas come from Postgres, so FalkorDB is a recording fake).

Past ``GRAPHVER_ROLLUP_NET_MAX_CELLS`` cells, ``_compute_rollup_deltas`` stops holding a window's
cells: it adds them to ``graphver.rollup_deltas``, one row per cell keyed by its ends' urns, and
``_apply_rollups`` writes them a page at a time. Pins:
- A window that creates and deletes lineage, moves several edges into one cell, and moves a
  container, staged (one cell held in memory, one edge or cell a page), writes exactly what the
  same window netted in memory writes: into a boundary and a cube store, with level stamps, and
  with no containment types (no canonical delta at all) where the summaries job stores the leaf
  mirror; where it does not, that window moves no cell.
- Rows a pass that stopped left behind are deleted by the next one before it stages: nothing
  counts twice.
- However the apply returns, the graph's rows are gone after it: written, or skipped because the
  window was already applied.
"""
from __future__ import annotations

import asyncio
import os

import pytest
from sqlalchemy import func, insert, select

from backend.app.services.versioning import config, db, models
from backend.app.services.versioning.models import GraphORM, RollupDeltaORM
from backend.app.services.versioning.projection import FalkorProjector, _CellNet
from backend.app.services.versioning.service import GraphVersioningService

pytestmark = pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"),
                                reason="set GRAPHVER_E2E=1 + a live Postgres to run")

CONT, LIN = ["CONTAINS"], ["FLOWS_TO"]


async def _canonical(_svc, _gid):
    return (CONT, LIN, {"Table": 0, "Column": 1})


async def _flat(_svc, _gid):
    return ([], LIN)


def _node(urn, etype):
    return {"op": "create", "entity_kind": "node", "entity_id": urn,
            "payload": {"urn": urn, "entityType": etype, "displayName": urn.rsplit(":", 1)[-1]}}


def _edge(eid, src, tgt, etype):
    return {"op": "create", "entity_kind": "edge", "entity_id": eid,
            "payload": {"edgeType": etype, "sourceEntityId": src, "targetEntityId": tgt}}


def _del(eid):
    return {"op": "delete", "entity_kind": "edge", "entity_id": eid, "payload": None}


class _Store:
    """A FalkorDB key at summaries watermark ``marker``, in storage ``regime``, whose every cell
    already holds weight 10, so each cell a window moves is written, a negative one too. Records
    the writes' rows."""

    def __init__(self, marker: int = 0, regime: str = "boundary"):
        self.marker, self.regime, self.upserts = marker, regime, []

    async def query(self, cypher, params=None, timeout=None):
        rows: list = []
        batch = (params or {}).get("batch") or []
        if "_GVRollupMeta) RETURN" in cypher:
            rows = [[self.marker]]
        elif "_AggMeta {id: 'singleton'}) RETURN m.regime" in cypher:
            rows = [[self.regime]]
        elif "RETURN item.s, item.t, r.weight" in cypher:
            rows = [[item["s"], item["t"], 10, [], 0] for item in batch]
        elif "MERGE (a)-[r:AGGREGATED]->(b)" in cypher:
            self.upserts.extend(batch)
            rows = [[len(batch)]]                        # the key holds every end: each lands
        return type("R", (), {"result_set": rows})()


async def _head(gid) -> int:
    async with db.graphver_session() as s:
        return (await s.get(GraphORM, gid)).main_head_commit_seq


async def _window(gid, resolver, from_seq, to_seq):
    proj = FalkorProjector(graph_client_factory=lambda *a, **k: None, edge_types_resolver=resolver)
    async with db.graphver_session() as s:
        graph = await s.get(GraphORM, gid)
        main_id = await proj._svc._main_branch_id(s, gid)
        return proj, await proj._compute_rollup_deltas(s, graph, main_id, from_seq, to_seq)


async def _written(proj, pairs, from_seq, to_seq, marker=0, regime="boundary"):
    store = _Store(marker, regime)
    assert await proj._apply_rollups(store, pairs, from_seq, to_seq)
    return sorted(store.upserts, key=lambda u: (u["s"], u["t"]))


async def _staged_rows(gid) -> int:
    async with db.graphver_session() as s:
        return await s.scalar(select(func.count()).select_from(RollupDeltaORM)
                              .where(RollupDeltaORM.graph_id == gid))


async def _staged_equals_in_memory(svc, monkeypatch):
    sfx = os.urandom(3).hex()
    gid = (await svc.create_graph(data_source_id="ds_rd_" + sfx, workspace_id="ws_rd",
                                  actor="bot", falkor_graph_name="gvt_rd_" + sfx))["graph_id"]
    table = {x: f"urn:t:rd{x}_{sfx}" for x in "ABC"}

    def col(x, i):
        return f"{table[x]}.c{i}"

    await svc.apply_ops(graph_id=gid, actor="bot", containment_edge_types=CONT, ops=[
        *(_node(table[x], "Table") for x in "ABC"),
        *(_node(col(x, i), "Column") for x in "ABC" for i in (1, 2)),
        *(_edge(f"c{x}{i}_{sfx}", table[x], col(x, i), "CONTAINS") for x in "ABC" for i in (1, 2)),
        _edge(f"L0_{sfx}", col("A", 1), col("B", 1), "FLOWS_TO"),
        _edge(f"L4_{sfx}", col("C", 1), col("B", 2), "FLOWS_TO")])
    from_seq = await _head(gid)
    # The window: three lineage edges into one pair of tables, one deleted, and B.c2 moved to C.
    await svc.apply_ops(graph_id=gid, actor="bot", containment_edge_types=CONT, ops=[
        _edge(f"L1_{sfx}", col("A", 1), col("B", 2), "FLOWS_TO"),
        _edge(f"L2_{sfx}", col("A", 2), col("B", 1), "FLOWS_TO"),
        _edge(f"L3_{sfx}", col("A", 2), col("B", 2), "FLOWS_TO")])
    await svc.apply_ops(graph_id=gid, actor="bot", containment_edge_types=CONT, ops=[
        _del(f"L0_{sfx}"), _del(f"cB2_{sfx}"),
        _edge(f"cC2_{sfx}", table["C"], col("B", 2), "CONTAINS")])
    to_seq = await _head(gid)

    for resolver, regime in ((_canonical, "boundary"), (_canonical, "cube"), (_flat, "boundary")):
        def written(proj, pairs, marker=0):
            return _written(proj, pairs, from_seq, to_seq, marker=marker, regime=regime)

        monkeypatch.setattr(config, "ROLLUP_NET_MAX_CELLS", 200000)
        monkeypatch.setattr(config, "PROJECTION_PAGE", 5000)
        if resolver is _flat:
            # With no containment types a lineage edge's only cell is its own ends': the leaf
            # mirror, which the summaries job stores only with AGGREGATION_MATERIALIZE_LEAF_PAIRS.
            monkeypatch.setenv("AGGREGATION_MATERIALIZE_LEAF_PAIRS", "false")
            assert (await _window(gid, resolver, from_seq, to_seq))[1] is None
            monkeypatch.setenv("AGGREGATION_MATERIALIZE_LEAF_PAIRS", "true")
        proj, netted = await _window(gid, resolver, from_seq, to_seq)
        assert isinstance(netted, dict) and netted, netted
        expect = await written(proj, netted)
        assert expect and min(u["w"] for u in expect) < 10, "the window moves a cell down"

        monkeypatch.setattr(config, "ROLLUP_NET_MAX_CELLS", 1)
        monkeypatch.setattr(config, "PROJECTION_PAGE", 1)
        proj, staged = await _window(gid, resolver, from_seq, to_seq)
        assert isinstance(staged, _CellNet) and staged.staged
        assert await _staged_rows(gid) >= len(expect)
        assert await written(proj, staged) == expect, (resolver.__name__, regime)
        assert await _staged_rows(gid) == 0

        # A pass that stopped left rows (here a cell it had netted to 99): the next one deletes
        # them before it stages, so nothing it nets is counted twice.
        async with db.graphver_session() as s:
            await s.execute(insert(RollupDeltaORM).values(
                graph_id=gid, to_seq=to_seq, s=table["A"], t=table["B"], dw=99, dwc=99, types=[]))
        proj, staged = await _window(gid, resolver, from_seq, to_seq)
        assert await written(proj, staged) == expect, (resolver.__name__, regime)
        assert await _staged_rows(gid) == 0

        # A window already applied writes nothing, and leaves no rows behind either.
        proj, staged = await _window(gid, resolver, from_seq, to_seq)
        assert await written(proj, staged, marker=to_seq) == []
        assert await _staged_rows(gid) == 0


def test_a_window_writes_the_same_summaries_staged_as_in_memory(monkeypatch):
    async def run():
        await models.create_schema_and_partitions()
        try:
            await _staged_equals_in_memory(GraphVersioningService(), monkeypatch)
        finally:
            await db.dispose_engine()
    asyncio.run(run())
