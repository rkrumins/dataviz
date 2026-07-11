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


async def _materialize(p, *, last_cursor=None, tuning=None):
    # Scenario tests pin the BOUNDARY mode (the at-scale path); the auto
    # full-cube default has its own live scenario below.
    merged = {"materialize_fine_pairs": False}
    merged.update(tuning or {})
    return await mat.materialize_aggregated_edges(
        p,
        containment_edge_types=["CONTAINS"],      # graph spells it 'contains'
        lineage_edge_types=["flows"],             # graph spells it 'FLOWS'
        last_cursor=last_cursor,
        progress_callback=None,
        intra_batch_callback=None,
        should_cancel=None,
        tuning=merged,
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


@skip_if_down
async def test_self_nesting_type_materializes_every_containment_depth():
    """CRITICAL live regression (2026-07-11): a self-nesting type
    (Node ⊃ Node) under a two-level ontology materialized ONLY the root
    diagonal (9 cells on a graph with 246 Node→Node containments) —
    Context View showed no aggregated lineage below the roots. The
    structural boundary materializes every containment depth, and each
    depth's weights sum to the raw lineage total (the quotient
    invariant)."""
    host, port = _host_port()
    name = f"gvt_agg_{uuid.uuid4().hex[:8]}"
    p = FalkorDBProvider(host=host, port=port, graph_name=name)
    p._entity_type_levels = {"Roots": 0, "Node": 1}
    p._level_digest = "live-digest-sn"
    await p._ensure_connected()
    try:
        await p._graph.query(
            "CREATE (r1:Roots {urn:'r1'}), (m1:Node {urn:'m1'}), (l1:Node {urn:'l1'}), "
            "(r2:Roots {urn:'r2'}), (m2:Node {urn:'m2'}), (l2:Node {urn:'l2'}), "
            "(r1)-[:contains]->(m1), (m1)-[:contains]->(l1), "
            "(r2)-[:contains]->(m2), (m2)-[:contains]->(l2), "
            "(l1)-[:FLOWS]->(l2), (l1)-[:FLOWS]->(l2), (l1)-[:FLOWS]->(l2)"
        )
        result = await _materialize(p)
        assert result["errors"] == 0
        rows = await _agg_rows(p)
        weights = {k: v[0] for k, v in rows.items()}
        assert weights == {
            ("m1", "m2"): 3,       # Node-container depth — the missing cells
            ("r1", "r2"): 3,       # Roots depth
        }, weights
        # Anchored drill both directions: what does m1 feed / what feeds m2.
        res = await p._graph.ro_query(
            "MATCH (a:Node {urn:'m1'})-[r:AGGREGATED]->(b) RETURN b.urn, r.weight"
        )
        assert [list(r) for r in res.result_set] == [["m2", 3]]
        res = await p._graph.ro_query(
            "MATCH (a)-[r:AGGREGATED]->(b:Node {urn:'m2'}) RETURN a.urn, r.weight"
        )
        assert [list(r) for r in res.result_set] == [["m1", 3]]
    finally:
        await _drop(p)


@skip_if_down
async def test_auto_mode_stores_full_cube_and_answers_every_granularity():
    """Default (auto) on a within-budget graph: the FULL ancestor
    cross-product is stored — leaf→container, leaf→root, container→root,
    every combination — so drilling/expanding in Context View always has
    stored answers (the 2026-07-11 incident: root→root rendered, any
    expansion showed nothing)."""
    host, port = _host_port()
    name = f"gvt_agg_{uuid.uuid4().hex[:8]}"
    p = FalkorDBProvider(host=host, port=port, graph_name=name)
    p._entity_type_levels = {"Roots": 0, "Node": 1}
    p._level_digest = "live-digest-auto"
    await p._ensure_connected()
    try:
        await p._graph.query(
            "CREATE (r1:Roots {urn:'r1'}), (m1:Node {urn:'m1'}), (l1:Node {urn:'l1'}), "
            "(r2:Roots {urn:'r2'}), (m2:Node {urn:'m2'}), (l2:Node {urn:'l2'}), "
            "(r1)-[:contains]->(m1), (m1)-[:contains]->(l1), "
            "(r2)-[:contains]->(m2), (m2)-[:contains]->(l2), "
            "(l1)-[:FLOWS]->(l2), (l1)-[:FLOWS]->(l2)"
        )
        result = await _materialize(p, tuning={"materialize_fine_pairs": "auto"})
        assert result["errors"] == 0
        weights = {k: v[0] for k, v in (await _agg_rows(p)).items()}
        assert weights == {
            ("l1", "m2"): 2, ("l1", "r2"): 2,
            ("m1", "l2"): 2, ("m1", "m2"): 2, ("m1", "r2"): 2,
            ("r1", "l2"): 2, ("r1", "m2"): 2, ("r1", "r2"): 2,
        }, weights
    finally:
        await _drop(p)


@skip_if_down
async def test_multi_parent_containment_links_both_ancestries_live():
    """A leaf under TWO parents (each under its own root) must aggregate
    into BOTH ancestries — the old longest-chain collapse dropped one —
    and a diamond's shared grandparent must receive each raw edge's
    weight exactly once (set-semantics closures on the real engine)."""
    host, port = _host_port()
    name = f"gvt_agg_{uuid.uuid4().hex[:8]}"
    p = FalkorDBProvider(host=host, port=port, graph_name=name)
    p._entity_type_levels = {"Roots": 0, "Node": 1}
    p._level_digest = "live-digest-mp"
    await p._ensure_connected()
    try:
        await p._graph.query(
            # leaf l1 under BOTH x1 and y1; x1/y1 under the SAME root g1
            # (diamond); target side a plain chain.
            "CREATE (g1:Roots {urn:'g1'}), (x1:Node {urn:'x1'}), (y1:Node {urn:'y1'}), "
            "(l1:Node {urn:'l1'}), "
            "(r2:Roots {urn:'r2'}), (m2:Node {urn:'m2'}), (l2:Node {urn:'l2'}), "
            "(g1)-[:contains]->(x1), (g1)-[:contains]->(y1), "
            "(x1)-[:contains]->(l1), (y1)-[:contains]->(l1), "
            "(r2)-[:contains]->(m2), (m2)-[:contains]->(l2), "
            "(l1)-[:FLOWS]->(l2)"
        )
        result = await _materialize(p, tuning={"materialize_fine_pairs": "auto"})
        assert result["errors"] == 0
        weights = {k: v[0] for k, v in (await _agg_rows(p)).items()}
        # BOTH parents linked, diamond grandparent counted once.
        assert weights[("x1", "m2")] == 1
        assert weights[("y1", "m2")] == 1
        assert weights[("g1", "r2")] == 1
        assert weights[("x1", "r2")] == 1 and weights[("y1", "r2")] == 1
        assert weights[("l1", "m2")] == 1 and weights[("l1", "r2")] == 1
    finally:
        await _drop(p)


@skip_if_down
async def test_cube_run_stamps_meta_depths_and_serves_every_reader():
    """Full-stack contract on the real engine: an auto (cube) run writes
    the _AggMeta singleton + sourceDepth/targetDepth on every row, the
    browse reader answers the canvas's visible-set request at every
    expansion combination (child↔child, child↔root), and the trace
    drill-down returns non-empty deltas one AND two levels below the
    root pair — the exact flows that rendered empty in the incident."""
    host, port = _host_port()
    name = f"gvt_agg_{uuid.uuid4().hex[:8]}"
    p = FalkorDBProvider(host=host, port=port, graph_name=name)
    p._entity_type_levels = {"Roots": 0, "Node": 1}
    p._level_digest = "live-digest-full"
    await p._ensure_connected()
    # Governed graphs are canonicalized to uppercase types; the trace
    # drill uppercases its declared types, so seed uppercase (the
    # casing seam has its own scenario above).
    p.set_containment_edge_types(["CONTAINS"], from_ontology=True)
    try:
        await p._graph.query(
            "CREATE (r1:Roots {urn:'r1'}), (m1:Node {urn:'m1'}), (l1:Node {urn:'l1'}), "
            "(r2:Roots {urn:'r2'}), (m2:Node {urn:'m2'}), (l2:Node {urn:'l2'}), "
            "(r1)-[:CONTAINS]->(m1), (m1)-[:CONTAINS]->(l1), "
            "(r2)-[:CONTAINS]->(m2), (m2)-[:CONTAINS]->(l2), "
            "(l1)-[:FLOWS]->(l2), (l1)-[:FLOWS]->(l2)"
        )
        result = await _materialize(p, tuning={"materialize_fine_pairs": "auto"})
        assert result["errors"] == 0

        # _AggMeta stamped in the graph — deterministic regime for readers.
        res = await p._graph.ro_query(
            "MATCH (m:_AggMeta {id:'singleton'}) "
            "RETURN m.regime, m.stampVersion, m.maxDepth, m.edgeCount"
        )
        assert res.result_set and res.result_set[0][0] == "cube"
        assert int(res.result_set[0][1]) == 2
        assert int(res.result_set[0][2]) == 2      # leaves at depth 2
        assert int(res.result_set[0][3]) == 8

        # Depth stamps on every row, no NULLs.
        res = await p._graph.ro_query(
            "MATCH ()-[r:AGGREGATED]->() "
            "WHERE r.sourceDepth IS NULL OR r.targetDepth IS NULL RETURN count(r)"
        )
        assert int(res.result_set[0][0]) == 0

        # Browse reader (System A): the canvas's visible-set request at
        # every expansion state. Weights stable across repeats.
        async def visible(sources, targets):
            r = await p.get_aggregated_edges_between(
                sources, targets, granularity=None,
                containment_edges=["CONTAINS"], lineage_edges=["FLOWS"],
            )
            return {
                (e.source_urn, e.target_urn): e.edge_count
                for e in r.aggregated_edges
            }

        assert await visible(["r1"], ["r2"]) == {("r1", "r2"): 2}
        assert await visible(["m1"], ["r2"]) == {("m1", "r2"): 2}   # child↔root
        assert await visible(["m1"], ["m2"]) == {("m1", "m2"): 2}   # child↔child
        assert await visible(["l1"], ["m2", "r2"]) == {
            ("l1", "m2"): 2, ("l1", "r2"): 2,                        # leaf↔containers
        }
        assert await visible(["l1"], ["l2"]) == {("l1", "l2"): 2}   # raw mirror
        # Repeat — no additive drift.
        assert await visible(["m1"], ["r2"]) == {("m1", "r2"): 2}

        # Trace drill-down (System B): root pair → child pair → leaf pair.
        drill1 = await p.expand_aggregated(
            "r1", "r2", next_level=1,
            lineage_edge_types=["FLOWS"], containment_edge_types=["CONTAINS"],
            max_nodes=100, timeout_ms=5000,
        )
        assert {(e.source_urn, e.target_urn) for e in drill1.edges} == {("m1", "m2")}
        drill2 = await p.expand_aggregated(
            "m1", "m2", next_level=2,
            lineage_edge_types=["FLOWS"], containment_edge_types=["CONTAINS"],
            max_nodes=100, timeout_ms=5000,
        )
        assert {(e.source_urn, e.target_urn) for e in drill2.edges} == {("l1", "l2")}
    finally:
        await _drop(p)


@skip_if_down
async def test_boundary_regime_serves_mixed_depths_on_demand_live():
    """Forced boundary (the over-budget path) on a self-nesting shape:
    only the depth-diagonal is stored, and the depth-keyed on-demand
    derivation serves the mixed cells (child↔root) with exact additive
    weights — the combination that was impossible under type levels."""
    host, port = _host_port()
    name = f"gvt_agg_{uuid.uuid4().hex[:8]}"
    p = FalkorDBProvider(host=host, port=port, graph_name=name)
    p._entity_type_levels = {"Roots": 0, "Node": 1}
    p._level_digest = "live-digest-bnd"
    await p._ensure_connected()
    try:
        await p._graph.query(
            "CREATE (r1:Roots {urn:'r1'}), (m1:Node {urn:'m1'}), (l1:Node {urn:'l1'}), "
            "(r2:Roots {urn:'r2'}), (m2:Node {urn:'m2'}), (l2:Node {urn:'l2'}), "
            "(r1)-[:contains]->(m1), (m1)-[:contains]->(l1), "
            "(r2)-[:contains]->(m2), (m2)-[:contains]->(l2), "
            "(l1)-[:FLOWS]->(l2), (l1)-[:FLOWS]->(l2), (l1)-[:FLOWS]->(l2)"
        )
        result = await _materialize(p)          # suite default: boundary
        assert result["errors"] == 0
        weights = {k: v[0] for k, v in (await _agg_rows(p)).items()}
        assert weights == {("m1", "m2"): 3, ("r1", "r2"): 3}, weights

        res = await p._graph.ro_query(
            "MATCH (m:_AggMeta {id:'singleton'}) RETURN m.regime"
        )
        assert res.result_set and res.result_set[0][0] == "boundary"

        async def visible(sources, targets):
            r = await p.get_aggregated_edges_between(
                sources, targets, granularity=None,
                containment_edges=["contains"], lineage_edges=["FLOWS"],
            )
            return {
                (e.source_urn, e.target_urn): e.edge_count
                for e in r.aggregated_edges
            }

        # Mixed-depth cell derived from the stored diagonal (Q3, depth-keyed).
        assert await visible(["m1"], ["r2"]) == {("m1", "r2"): 3}
        # Leaf-involving cells derived from raw lineage (Q1/Q2, structural).
        assert await visible(["l1"], ["r2"]) == {("l1", "r2"): 3}
        assert await visible(["m1"], ["l2"]) == {("m1", "l2"): 3}
    finally:
        await _drop(p)
