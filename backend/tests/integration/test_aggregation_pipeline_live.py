"""Live end-to-end tests for the :AGGREGATED materialization pipeline
against a REAL FalkorDB — the completeness contract, observed on the
actual engine rather than the in-memory fakes:

* (i)  mixed-case seed → EXACT canonical cells, weights and level stamps
       (case-fold vocabulary matching in both directions, real per-label
       URN indexes, real aggKey edge index);
* (ii) mutate → re-run applies exactly the diff; an unchanged re-run
       writes nothing and never touches (much less wipes) good edges;
* (iv) resume mid-APPLY with a cursor past every computed key still
       creates every missing pair (the removed fast-forward hole);
* (v)  db.indexes() shape pin for the readiness probe on the deployed
       FalkorDB version.

The trigger-source constraint + idempotency index changes are verified
by unit pins plus the migration's scratch-database exercise (see
20260711_1200_agg_job_guards.py); the worker-kill → reconciler
auto-resume path is pinned by unit + topology-contract tests and the
manual soak recipe in docs/AGGREGATION_PIPELINE.md.

Run in the dev container (reaches ``falkordb:6379``)::

    docker exec -w /app synodic-dev-viz-service-1 sh -c \
      'RUN_FALKOR_LIVE=1 python -m pytest \
       backend/tests/integration/test_aggregation_pipeline_live.py -q'
"""
from __future__ import annotations

import os
import time
import uuid

import pytest

from backend.app.providers import falkordb_materialize as mat
from backend.app.providers.falkordb_provider import FalkorDBProvider

pytestmark = pytest.mark.asyncio

skip_if_down = pytest.mark.skipif(
    os.getenv("RUN_FALKOR_LIVE") != "1",
    reason="Set RUN_FALKOR_LIVE=1 (with FalkorDB reachable) to run the live pipeline E2E.",
)

_LEVELS = {"Domain": 0, "Table": 1, "Column": 2}


def _host_port():
    return os.getenv("FALKORDB_HOST", "localhost"), int(os.getenv("FALKORDB_PORT", "6379"))


async def _seeded_provider() -> FalkorDBProvider:
    """Two 3-level chains with MIXED casing: labels domain/Table/column,
    containment ``contains`` (lower), lineage ``FLOWS`` (upper) — while
    the declared ontology says CONTAINS / flows / Domain-Table-Column."""
    host, port = _host_port()
    name = f"gvt_agg_{uuid.uuid4().hex[:8]}"
    p = FalkorDBProvider(host=host, port=port, graph_name=name)
    p._entity_type_levels = dict(_LEVELS)
    p._level_digest = "live-digest-1"
    await p._ensure_connected()
    await p._graph.query(
        "CREATE (d1:domain {urn:'d1'}), (t1:Table {urn:'t1'}), (c1:column {urn:'c1'}), "
        "(d2:domain {urn:'d2'}), (t2:Table {urn:'t2'}), (c2:column {urn:'c2'}), "
        "(d1)-[:contains]->(t1), (t1)-[:contains]->(c1), "
        "(d2)-[:contains]->(t2), (t2)-[:contains]->(c2), "
        "(c1)-[:FLOWS]->(c2), (c1)-[:FLOWS]->(c2)"
    )
    return p


async def _drop(p: FalkorDBProvider) -> None:
    try:
        await p._graph.delete()
    except Exception:
        pass


async def _materialize(p, *, last_cursor=None):
    return await mat.materialize_aggregated_edges(
        p,
        containment_edge_types=["CONTAINS"],      # graph spells it 'contains'
        lineage_edge_types=["flows"],             # graph spells it 'FLOWS'
        last_cursor=last_cursor,
        progress_callback=None,
        intra_batch_callback=None,
        should_cancel=None,
    )


async def _agg_rows(p):
    res = await p._graph.ro_query(
        "MATCH (a)-[r:AGGREGATED]->(b) "
        "RETURN a.urn, b.urn, r.weight, r.sourceLevel, r.targetLevel, r.latestUpdate"
    )
    return {
        (row[0], row[1]): (row[2], row[3], row[4], row[5])
        for row in (res.result_set or [])
    }


@skip_if_down
async def test_mixed_case_seed_aggregates_exact_canonical_cells():
    p = await _seeded_provider()
    try:
        result = await _materialize(p)
        assert result["errors"] == 0
        rows = await _agg_rows(p)
        assert set(rows) == {("t1", "t2"), ("d1", "d2")}, rows
        assert rows[("t1", "t2")][0] == 2 and rows[("d1", "d2")][0] == 2
        assert rows[("t1", "t2")][1:3] == (1, 1)     # Table level stamps
        assert rows[("d1", "d2")][1:3] == (0, 0)     # Domain level stamps
    finally:
        await _drop(p)


@skip_if_down
async def test_diff_rerun_applies_exactly_the_delta_and_noop_never_touches():
    p = await _seeded_provider()
    try:
        await _materialize(p)
        before = await _agg_rows(p)

        # Mutate: one more raw lineage edge → weights 2 → 3.
        await p._graph.query(
            "MATCH (c1:column {urn:'c1'}), (c2:column {urn:'c2'}) "
            "CREATE (c1)-[:FLOWS]->(c2)"
        )
        second = await _materialize(p)
        assert second["errors"] == 0
        after = await _agg_rows(p)
        assert {k: v[0] for k, v in after.items()} == {
            ("t1", "t2"): 3, ("d1", "d2"): 3,
        }

        # Unchanged re-run: zero writes, zero deletes, latestUpdate frozen
        # — the observable "a re-run can never wipe or churn good edges".
        third = await _materialize(p)
        assert third["errors"] == 0
        assert third["writes"] == 0 and third["deletes"] == 0, third
        final = await _agg_rows(p)
        assert {k: v[3] for k, v in final.items()} == {
            k: v[3] for k, v in after.items()
        }, "no-op run must not touch latestUpdate"
        assert before.keys() == final.keys()
    finally:
        await _drop(p)


@skip_if_down
async def test_resume_mid_apply_creates_every_missing_pair():
    p = await _seeded_provider()
    try:
        # A cursor whose apply pos sorts PAST every computed key: with the
        # old fast-forward this skipped everything; now RECONCILE's
        # rebuilt view drives apply and every pair still lands.
        cursor = mat.make_cursor(
            int(time.time() * 1000), mat.PHASE_APPLY, mat._pack(1 << 34, 1 << 34),
        )
        result = await _materialize(p, last_cursor=cursor)
        assert result["errors"] == 0
        rows = await _agg_rows(p)
        assert set(rows) == {("t1", "t2"), ("d1", "d2")}
        assert all(v[0] == 2 for v in rows.values())
    finally:
        await _drop(p)


@skip_if_down
async def test_db_indexes_shape_supports_readiness_probe():
    p = await _seeded_provider()
    try:
        await _materialize(p)                      # creates the aggKey index
        res = await p._graph.ro_query("CALL db.indexes()")
        rows = res.result_set or []
        agg_rows = [
            row for row in rows
            if any("AGGREGATED" in str(c) for c in (row or []) if c is not None)
        ]
        assert agg_rows, f"no AGGREGATED index visible in db.indexes(): {rows!r}"
        # Steady state: the readiness probe must see it as built.
        assert not any(
            "UNDER CONSTRUCTION" in str(c).upper()
            for row in agg_rows for c in row if c is not None
        ), agg_rows
    finally:
        await _drop(p)
