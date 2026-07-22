"""Projection rebuild + reconcile e2e — needs Postgres.

Proves the operational guarantee around "Postgres is the SoR, FalkorDB is a rebuildable cache":
you can force a full replay of committed ``main`` from Postgres (``request_projection_rebuild``),
and you can VALIDATE that the whole cache matches the SoR (``ProjectionReconciler``) — catching an
entity missing from the cache, an extra one, and (deep) a drifted field.

Reuses the fake-FalkorDB pattern from ``test_versioning_projection`` (which interprets the exact
reader-compatible Cypher the projector emits over an in-memory graph), extended with the three
scan/fetch queries the reconciler emits. The live socket is covered by the real-FalkorDB module.
"""
import asyncio
import contextlib
import os

import pytest

from backend.app.services.versioning import config as _vcfg
from backend.app.services.versioning import db, models
from backend.app.services.versioning.models import ProjectionStateORM
from backend.app.services.versioning.projection import FalkorProjector


@contextlib.contextmanager
def _deep_verify_on():
    """The single-scan deep CONTENT verify is ON by default now, but make it explicit for the holdback
    tests so they still exercise it if an env var flips the default off."""
    prev = _vcfg.PROJECTION_VERIFY_DEEP
    _vcfg.PROJECTION_VERIFY_DEEP = True
    try:
        yield
    finally:
        _vcfg.PROJECTION_VERIFY_DEEP = prev


@contextlib.contextmanager
def _deep_verify_cap(n: int):
    """Temporarily set the deep-verify entity ceiling (above which the hot-path deep pass is skipped
    and only the count verify runs)."""
    prev = _vcfg.PROJECTION_VERIFY_DEEP_MAX_ENTITIES
    _vcfg.PROJECTION_VERIFY_DEEP_MAX_ENTITIES = n
    try:
        yield
    finally:
        _vcfg.PROJECTION_VERIFY_DEEP_MAX_ENTITIES = prev


@contextlib.contextmanager
def _deep_verify_timeout(secs: float):
    """Temporarily set the deep-verify wall-clock budget; on timeout the deep pass degrades to the
    (already-passed) count verify and the rebuild publishes rather than hanging."""
    prev = _vcfg.PROJECTION_VERIFY_DEEP_TIMEOUT_S
    _vcfg.PROJECTION_VERIFY_DEEP_TIMEOUT_S = secs
    try:
        yield
    finally:
        _vcfg.PROJECTION_VERIFY_DEEP_TIMEOUT_S = prev
from backend.app.services.versioning.reconcile import ProjectionReconciler
from backend.app.services.versioning.service import GraphVersioningService

# Reuse the projector-Cypher-interpreting fake + e2e helpers verbatim (see that module's docstring).
from backend.tests.integration.test_versioning_projection import (
    FakeFalkor,
    FakeGraph,
    _assert_matches_main,
    _edit_publish,
    _edge,
    _graph_name,
    _node,
    _watermark,
)


class ReconcileFakeGraph(FakeGraph):
    """The base FakeGraph is now reconciler-complete — its ``_SCAN_NODES`` / ``_SCAN_EDGES`` handlers
    carry the deep fields (displayName + labels; type + confidence + properties), so the single-scan
    content diff runs against it directly. Kept as a named subclass for the ``ReconcileFakeFalkor``
    factory and the drift subclasses below."""


class ReconcileFakeFalkor(FakeFalkor):
    def __call__(self, name: str, provider_id=None) -> ReconcileFakeGraph:
        return self.graphs.setdefault(name, ReconcileFakeGraph())


async def _seed(svc, fake) -> tuple:
    """Create a PINNED graph (unpinned graphs are never projected), seed A,B + edge E1, project,
    and assert the cache equals materialized main. Returns (graph_id, projector, falkor_name)."""
    name = "gvt_" + os.urandom(3).hex()
    G = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                               actor="alice", falkor_graph_name=name)
    gid = G["graph_id"]
    proj = FalkorProjector(graph_client_factory=fake, batch_size=2)
    await _edit_publish(svc, gid, "alice", [
        {"op": "create", "entity_kind": "node", "entity_id": "A", "payload": _node("Alpha")},
        {"op": "create", "entity_kind": "node", "entity_id": "B", "payload": _node("Beta")},
        {"op": "create", "entity_kind": "edge", "entity_id": "E1", "payload": _edge("A", "B")},
    ], "seed")
    await proj.project_graph(gid)
    await _assert_matches_main(svc, fake, gid)
    return gid, proj, name


async def _status(gid: str) -> tuple:
    async with db.graphver_session() as s:
        ps = await s.get(ProjectionStateORM, gid)
        return ps.status, ps.projected_commit_seq, ps.target_commit_seq


# --------------------------------------------------------------------------- #
# 1. Rebuild: full replay from seq 0, idempotent while a rebuild is pending.   #
# --------------------------------------------------------------------------- #
async def _run_rebuild() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    fake = ReconcileFakeFalkor()
    gid, proj, name = await _seed(svc, fake)
    assert await _watermark(gid) == 2

    # request rebuild → True; state flips to rebuilding with the watermark reset to 0.
    assert await svc.request_projection_rebuild(gid) is True
    assert await _status(gid) == ("rebuilding", 0, 2)
    # a second request while that rebuild is pending is a no-op → False (never rewinds an apply).
    assert await svc.request_projection_rebuild(gid) is False
    assert await _status(gid) == ("rebuilding", 0, 2)

    # project again → clean wipe + full reseed from seq 0 converges identically.
    r = await proj.project_graph(gid)
    assert not r["noop"] and r["projected"] == 2, r
    g = await _assert_matches_main(svc, fake, gid)
    assert g.entity_ids() == {"A", "B"} and set(g.edges) == {"E1"}
    assert await _status(gid) == ("idle", 2, 2)

    # caught up now → a fresh rebuild request is allowed again (not "in flight").
    assert await svc.request_projection_rebuild(gid) is True
    await db.dispose_engine()


# --------------------------------------------------------------------------- #
# 2. Drift injection: reconcile catches a missing node/edge and an extra node. #
# --------------------------------------------------------------------------- #
async def _run_drift() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    fake = ReconcileFakeFalkor()
    gid, proj, name = await _seed(svc, fake)

    # baseline: the freshly projected cache reconciles clean.
    rep = await ProjectionReconciler(db.graphver_session, fake).reconcile(gid)
    assert rep.skipped_reason is None and rep.in_sync is True, rep
    assert rep.pg_nodes == rep.falkor_nodes == 2 and rep.pg_edges == rep.falkor_edges == 1
    assert not rep.missing_nodes and not rep.extra_nodes

    # drop B (and its incident edge E1) straight out of the cache → reconcile reports B missing; the
    # dropped edge surfaces as a DISTINCT-triple COUNT shortfall, NOT an id sample. Edge id-samples
    # are collapse-noise (N parallel edges share ONE FalkorDB relationship, so a "missing" id is not
    # edge loss) so reconcile no longer reports them — edge COVERAGE is owned by the triple count.
    g = fake.graphs[name]
    g.nodes.pop(g.node("B")["urn"])
    g.edges.pop("E1")
    rep = await ProjectionReconciler(db.graphver_session, fake).reconcile(gid)
    assert rep.in_sync is False
    assert [m["entityId"] for m in rep.missing_nodes] == ["B"], rep.missing_nodes
    assert rep.missing_edges == [], rep.missing_edges             # id-samples dropped (collapse-noise)
    assert rep.falkor_nodes == 1 and rep.falkor_edges == 0        # counts caught both
    assert rep.pg_edges == 1 and rep.falkor_edges == 0            # triple-count shortfall = edge coverage signal

    # rebuild + project → cache is whole again, reconcile clean.
    assert await svc.request_projection_rebuild(gid) is True
    await proj.project_graph(gid)
    rep = await ProjectionReconciler(db.graphver_session, fake).reconcile(gid)
    assert rep.in_sync is True, rep

    # inject an EXTRA node the SoR never had → reported as extra (never auto-deleted).
    fake.graphs[name].nodes["gv:GHOST"] = {
        "urn": "gv:GHOST", "entityId": "GHOST", "displayName": "ghost", "_label": "Dataset"}
    rep = await ProjectionReconciler(db.graphver_session, fake).reconcile(gid)
    assert rep.in_sync is False
    assert [x["entityId"] for x in rep.extra_nodes] == ["GHOST"], rep.extra_nodes
    assert rep.falkor_nodes == rep.pg_nodes + 1
    await db.dispose_engine()


# --------------------------------------------------------------------------- #
# 3. Deep field check: catches a drifted displayName that id-sets/counts miss. #
# --------------------------------------------------------------------------- #
async def _run_deep() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    fake = ReconcileFakeFalkor()
    gid, proj, name = await _seed(svc, fake)

    # tamper with a cached node's displayName (same id-set, same counts).
    fake.graphs[name].node("A")["displayName"] = "TAMPERED"

    # non-deep reconcile does NOT flag it — id-sets + counts are unchanged.
    rep = await ProjectionReconciler(db.graphver_session, fake).reconcile(gid, deep=False)
    assert rep.in_sync is True and not rep.mismatched, rep

    # deep reconcile field-compares every node and catches the drift.
    rep = await ProjectionReconciler(db.graphver_session, fake).reconcile(gid, deep=True)
    assert rep.in_sync is False
    hit = [m for m in rep.mismatched if m["entityId"] == "A" and m["field"] == "displayName"]
    assert hit and hit[0]["pg"] == "Alpha" and hit[0]["falkor"] == "TAMPERED", rep.mismatched
    await db.dispose_engine()


# --------------------------------------------------------------------------- #
# 4. Rollup hook: the rebuild-triggered full seed fires on_rollups_stale.      #
# --------------------------------------------------------------------------- #
async def _run_rollup_hook() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    fake = ReconcileFakeFalkor()
    fired: list = []

    async def hook(graph_id: str) -> None:
        fired.append(graph_id)

    name = "gvt_" + os.urandom(3).hex()
    G = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                               actor="alice", falkor_graph_name=name)
    gid = G["graph_id"]
    proj = FalkorProjector(graph_client_factory=fake, batch_size=2, on_rollups_stale=hook)
    await _edit_publish(svc, gid, "alice", [
        {"op": "create", "entity_kind": "node", "entity_id": "A", "payload": _node("Alpha")},
    ], "seed")
    await proj.project_graph(gid)
    assert fired == [gid], "first projection is itself a full seed and fires the hook"

    fired.clear()
    assert await svc.request_projection_rebuild(gid) is True
    await proj.project_graph(gid)                         # projected==0 → clean reseed → fires again
    assert fired == [gid]
    await db.dispose_engine()


# --------------------------------------------------------------------------- #
# 5. Legacy never-versioned cache entry (null entityId): reconcile must not     #
#    500 on the sorted-merge — it surfaces via count drift instead.             #
# --------------------------------------------------------------------------- #
async def _run_legacy_null_id() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    fake = ReconcileFakeFalkor()
    gid, proj, name = await _seed(svc, fake)

    # A legacy cache node written before entity ids existed — no entityId key at all. The scan's
    # `entityId IS NOT NULL` guard keeps it out of the sorted-merge (a null key would blow up the
    # id comparison); it still shows in the counts, which is the coherent "extra in cache" signal.
    fake.graphs[name].nodes["gv:LEGACY"] = {
        "urn": "gv:LEGACY", "displayName": "legacy", "_label": "Dataset"}

    rep = await ProjectionReconciler(db.graphver_session, fake).reconcile(gid)
    assert rep.in_sync is False
    assert rep.falkor_nodes == rep.pg_nodes + 1               # counts caught the extra entity
    assert not rep.missing_nodes                              # not mistaken for a missing SoR entity

    # deep scan must also complete (the legacy node is never fetched — it's not in the SoR stream).
    rep = await ProjectionReconciler(db.graphver_session, fake).reconcile(gid, deep=True)
    assert rep.in_sync is False and rep.falkor_nodes == rep.pg_nodes + 1
    await db.dispose_engine()


async def _run_reconcile_ignores_derived_meta() -> None:
    """CONTRAST with the legacy-null-id case above: after the projector publishes, the
    on_rollups_stale hook runs the aggregation pipeline, which stamps an ``_AggMeta`` singleton (and
    ``:AGGREGATED`` rollup edges) into the SAME graph. Those are derived CACHE artifacts, NOT
    committed main — and ``_AggMeta`` carries no entityId. falkor_counts must exclude EVERY derived
    label, not just ``_GVRollupMeta``; counting ``_AggMeta`` made ``falkor_nodes == pg_nodes + 1`` so
    Check sync reported a faithful graph as out-of-sync with NO detail (the scan skips it on
    entityId-null, so there's nothing to show). Unlike the legacy node (a REAL label → a genuine
    extra), a derived-label node must NOT move the graph out of sync."""
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    fake = ReconcileFakeFalkor()
    gid, proj, name = await _seed(svc, fake)

    rep = await ProjectionReconciler(db.graphver_session, fake).reconcile(gid, deep=True)
    assert rep.in_sync is True, rep                        # baseline: clean

    # Post-publish aggregation output on the SAME graph: the _AggMeta singleton (no entityId, like the
    # real MERGE (m:_AggMeta {id:'singleton'})) + an :AGGREGATED rollup edge between real nodes.
    g = fake.graphs[name]
    urns = list(g.nodes.keys())
    g.nodes["_aggmeta"] = {"urn": "_aggmeta", "_label": "_AggMeta"}      # derived meta node — no entityId
    g.edges["_agg1"] = {"src": urns[0], "tgt": urns[1], "type": "AGGREGATED"}

    rep = await ProjectionReconciler(db.graphver_session, fake).reconcile(gid, deep=True)
    assert rep.in_sync is True, rep                        # STILL in sync — derived artifacts ignored
    assert rep.pg_nodes == rep.falkor_nodes, rep           # _AggMeta not counted
    assert rep.pg_edges == rep.falkor_edges, rep           # :AGGREGATED not counted
    assert not rep.extra_nodes and not rep.mismatched, rep # and nothing spuriously flagged
    await db.dispose_engine()


# --------------------------------------------------------------------------- #
# 6. Failure honesty: a dead cache instance leaves status=idle + last_error     #
#    (no stranded spinner state), the watermark exposes it, and a later rebuild #
#    clears it. This is the terminal-state contract the Data health UI needs.   #
# --------------------------------------------------------------------------- #
class ExplodingGraph(ReconcileFakeGraph):
    """Fails every write query — a reachable-then-erroring FalkorDB."""

    async def query(self, cypher: str, params: dict = None):
        if "MERGE" in cypher or "UNWIND" in cypher:
            raise RuntimeError("boom: cache instance unreachable")
        return await super().query(cypher, params)


class ExplodingFalkor(ReconcileFakeFalkor):
    def __call__(self, name: str, provider_id=None) -> ReconcileFakeGraph:
        return self.graphs.setdefault(name, ExplodingGraph())


async def _run_failure_honesty() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    fake = ExplodingFalkor()
    name = "gvt_" + os.urandom(3).hex()
    G = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                               actor="alice", falkor_graph_name=name)
    gid = G["graph_id"]
    proj = FalkorProjector(graph_client_factory=fake, batch_size=2)
    await _edit_publish(svc, gid, "alice", [
        {"op": "create", "entity_kind": "node", "entity_id": "A", "payload": _node("Alpha")},
    ], "seed")

    with pytest.raises(RuntimeError):
        await proj.project_graph(gid)

    st, projected, _target = await _status(gid)
    assert st == "idle" and projected == 0, "failed projection must not strand status or advance"
    wm = await svc.projection_watermark(gid)
    assert wm["fresh"] is False and "boom" in (wm["last_error"] or ""), wm
    assert wm["progress_done"] is None and wm["progress_total"] is None, \
        "a failed full seed must not strand a stale progress bar"

    # Recovery: healthy instance again → rebuild converges and CLEARS the error.
    fake.graphs[name] = ReconcileFakeGraph()
    assert await svc.request_projection_rebuild(gid) is True
    await proj.project_graph(gid)
    wm = await svc.projection_watermark(gid)
    assert wm["fresh"] is True and wm["last_error"] is None, wm
    assert wm["progress_done"] is None and wm["progress_total"] is None
    await db.dispose_engine()


# --------------------------------------------------------------------------- #
# 7. Progress writer: first + final chunk always persist; the full-seed pass    #
#    reports status=rebuilding while an incremental window reports projecting.  #
# --------------------------------------------------------------------------- #
async def _run_progress_writer() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    fake = ReconcileFakeFalkor()
    gid, proj, name = await _seed(svc, fake)

    async def _progress_row():
        async with db.graphver_session() as s:
            ps = await s.get(ProjectionStateORM, gid)
            return ps.progress_done, ps.progress_total

    w = proj._progress_writer(gid, 10)
    await w(4)                                            # first write bypasses the throttle
    assert await _progress_row() == (4, 10)
    await w(6)                                            # done == total → final write bypasses too
    assert await _progress_row() == (10, 10)

    # A successful full reseed ends with the progress columns CLEARED.
    assert await svc.request_projection_rebuild(gid) is True
    await proj.project_graph(gid)
    assert await _progress_row() == (None, None)
    assert (await _status(gid))[0] == "idle"
    await db.dispose_engine()


# --------------------------------------------------------------------------- #
# 8. Hold-back on an UNFAITHFUL reseed (the data-integrity guarantee): a full   #
#    seed that does not verify against committed main MUST NOT advance the      #
#    watermark — reads keep serving Postgres instead of a corrupt cache.        #
# --------------------------------------------------------------------------- #
async def _run_holdback_on_count_shortfall() -> None:
    """A reseed that silently drops an entity (a persistent count shortfall) must be HELD BACK,
    not published. This is the class the old code advanced-on-error and served as 'fresh'."""
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    fake = ReconcileFakeFalkor()
    gid, proj, name = await _seed(svc, fake)
    assert (await svc.projection_watermark(gid))["fresh"] is True

    # Force the cache count to under-report by one node so verify can never reconcile — the heal
    # reseed runs, still under-reports, and the pass must return a verify_error and hold back.
    real_counts = proj._falkor_counts
    async def _short(client):
        n, e = await real_counts(client)
        return max(0, n - 1), e
    proj._falkor_counts = _short

    assert await svc.request_projection_rebuild(gid) is True
    r = await proj.project_graph(gid)
    assert r["verify_error"] and r["projected"] == 0, r          # held back at from_seq (0)
    st, projected, target = await _status(gid)
    assert st == "idle" and projected == 0, (st, projected)
    assert target == 0, "target must pin to the held-back seq so the poll stops re-running it"
    wm = await svc.projection_watermark(gid)
    assert wm["fresh"] is False and wm["last_error"], wm

    # The poll loop must NOT resurrect a deterministic-fail seed (projected==target ⇒ not selected).
    await proj.project_pending()
    assert (await _status(gid))[1] == 0, "project_pending must not advance a held-back seed"

    # Recovery: real counts again → a fresh rebuild converges and CLEARS the error.
    proj._falkor_counts = real_counts
    assert await svc.request_projection_rebuild(gid) is True
    await proj.project_graph(gid)
    wm = await svc.projection_watermark(gid)
    assert wm["fresh"] is True and wm["last_error"] is None, wm
    await db.dispose_engine()


class _FieldDriftGraph(ReconcileFakeGraph):
    """Writes every node with a corrupted displayName: counts AND id-sets still match, so ONLY the
    deep content check can catch it — exercises the full-seed CONTENT verify (counts are blind)."""

    async def query(self, cypher: str, params: dict = None):
        if cypher.startswith("UNWIND $batch AS item MERGE (n:") and params:
            params = {**params, "batch": [{**it, "displayName": f"DRIFT::{it.get('displayName')}"}
                                          for it in params["batch"]]}
        return await super().query(cypher, params)


class _FieldDriftFalkor(ReconcileFakeFalkor):
    def __call__(self, name: str, provider_id=None) -> _FieldDriftGraph:
        return self.graphs.setdefault(name, _FieldDriftGraph())


class _EdgeAttrDriftGraph(ReconcileFakeGraph):
    """Writes every edge with its confidence + properties DROPPED — exactly the pre-fix flattening
    corruption. Counts, id-sets AND node fields all still match (same edge ids, same nodes), so ONLY
    the deep EDGE attribute check can catch it: proof the verify is no longer edge-attribute-blind."""

    async def query(self, cypher: str, params: dict = None):
        if (cypher.startswith("UNWIND $batch AS item MATCH (a:") and "MERGE (a)-[r:" in cypher
                and params):
            params = {**params, "batch": [{**it, "conf": None, "props": "{}"}
                                          for it in params["batch"]]}
        return await super().query(cypher, params)


class _EdgeAttrDriftFalkor(ReconcileFakeFalkor):
    def __call__(self, name: str, provider_id=None) -> _EdgeAttrDriftGraph:
        return self.graphs.setdefault(name, _EdgeAttrDriftGraph())


async def _run_holdback_on_content_drift() -> None:
    """A reseed whose COUNTS match but whose field content drifted (here every displayName) must
    still be held back — the count-only verify was blind to exactly this class."""
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    fake = _FieldDriftFalkor()
    name = "gvt_" + os.urandom(3).hex()
    G = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                               actor="alice", falkor_graph_name=name)
    gid = G["graph_id"]
    proj = FalkorProjector(graph_client_factory=fake, batch_size=2)
    await _edit_publish(svc, gid, "alice", [
        {"op": "create", "entity_kind": "node", "entity_id": "A", "payload": _node("Alpha")},
        {"op": "create", "entity_kind": "node", "entity_id": "B", "payload": _node("Beta")},
        {"op": "create", "entity_kind": "edge", "entity_id": "E1", "payload": _edge("A", "B")},
    ], "seed")

    with _deep_verify_on():
        r = await proj.project_graph(gid)                # first projection == full seed
    assert r["verify_error"] and "content drift" in r["verify_error"], r
    assert r["projected"] == 0, r                        # held back — never published
    wm = await svc.projection_watermark(gid)
    assert wm["fresh"] is False and "content drift" in (wm["last_error"] or ""), wm
    await db.dispose_engine()


async def _run_holdback_on_edge_attr_drift() -> None:
    """A reseed that drops each edge's confidence + properties (the exact pre-fix flattening bug)
    keeps counts, id-sets and node fields identical — only the deep EDGE attribute check sees it.
    The watermark must be held back so reads stay on Postgres rather than serve attribute-blanked
    edges. This is the safety net that makes the S1 contract enforceable, not just tested."""
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    fake = _EdgeAttrDriftFalkor()
    name = "gvt_" + os.urandom(3).hex()
    G = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                               actor="alice", falkor_graph_name=name)
    gid = G["graph_id"]
    proj = FalkorProjector(graph_client_factory=fake, batch_size=2)
    await _edit_publish(svc, gid, "alice", [
        {"op": "create", "entity_kind": "node", "entity_id": "A", "payload": _node("Alpha")},
        {"op": "create", "entity_kind": "node", "entity_id": "B", "payload": _node("Beta")},
        {"op": "create", "entity_kind": "edge", "entity_id": "E1",
         "payload": {"edgeType": "FLOWS_TO", "sourceEntityId": "A", "targetEntityId": "B",
                     "confidence": 0.9, "properties": {"sql": "select 1"}}},
    ], "seed")

    with _deep_verify_on():
        r = await proj.project_graph(gid)                # first projection == full seed
    assert r["verify_error"] and "edge attr mismatch" in r["verify_error"], r
    assert r["projected"] == 0, r                        # held back — never published
    wm = await svc.projection_watermark(gid)
    assert wm["fresh"] is False and "content drift" in (wm["last_error"] or ""), wm
    await db.dispose_engine()


async def _run_publishes_with_parallel_edges() -> None:
    """Parallel edges — same ``(src, type, tgt)`` triple, different ids — collapse to ONE
    relationship in FalkorDB (the id-less ``MERGE``). The count verify must model that (compare
    Postgres' DISTINCT-triple count against FalkorDB's edge count) or it reports a permanent false
    shortfall and holds EVERY parallel-edge graph back forever — the "60058/60058 then stuck" bug."""
    from backend.app.services.versioning.reconcile import pg_live_counts, pg_live_counts_projectable
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    fake = FakeFalkor()
    name = "gvt_" + os.urandom(3).hex()
    G = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                               actor="alice", falkor_graph_name=name)
    gid = G["graph_id"]
    proj = FalkorProjector(graph_client_factory=fake, batch_size=2)
    # Parallel edges arrive via BOOTSTRAP (bulk import), not write-through — the versioned publish
    # gate rejects undiscriminated duplicate triples, but a source FalkorDB can legitimately hold
    # them and bulk_ingest imports them verbatim (this IS the 60k-entity enable-versioning path).
    await svc.bulk_ingest(graph_id=gid, actor="alice", idempotency_key="k1", rows=[
        {"kind": "node", "id": "A", "urn": "A", "entityType": "Dataset", "displayName": "Alpha"},
        {"kind": "node", "id": "B", "urn": "B", "entityType": "Dataset", "displayName": "Beta"},
        {"kind": "edge", "id": "E1", "edgeType": "FLOWS_TO", "source": "A", "target": "B"},
        {"kind": "edge", "id": "E2", "edgeType": "FLOWS_TO", "source": "A", "target": "B"},  # same triple
    ])

    # Premise: Postgres holds BOTH edges (2 raw) but only ONE distinct triple.
    mid = await svc.main_branch_id(gid)
    async with db.graphver_session() as s:
        assert (await pg_live_counts(s, gid, mid))[1] == 2, "expected two raw parallel edges"
        assert (await pg_live_counts_projectable(s, gid, mid))[1] == 1, "expected one distinct triple"

    # The reseed collapses E1/E2 to one relationship; the collapse-correct count (1 == 1) must PUBLISH.
    assert await svc.request_projection_rebuild(gid) is True
    r = await proj.project_graph(gid)
    assert not r.get("verify_error"), r
    wm = await svc.projection_watermark(gid)
    assert wm["fresh"] is True and wm["projected"] == wm["committed"], wm
    await db.dispose_engine()


async def _run_deep_verify_size_gated() -> None:
    """Above the deep-verify entity ceiling the hot-path deep pass is SKIPPED (only the count verify
    runs), so a huge rebuild can't hang on the scan — the trade is that a drift only the deep check
    sees will publish. Proven by dropping the cap below this tiny graph's size: the same edge-attr
    drift that is held back at the default cap now PUBLISHES."""
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    fake = _EdgeAttrDriftFalkor()
    name = "gvt_" + os.urandom(3).hex()
    G = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                               actor="alice", falkor_graph_name=name)
    gid = G["graph_id"]
    proj = FalkorProjector(graph_client_factory=fake, batch_size=2)
    await _edit_publish(svc, gid, "alice", [
        {"op": "create", "entity_kind": "node", "entity_id": "A", "payload": _node("Alpha")},
        {"op": "create", "entity_kind": "node", "entity_id": "B", "payload": _node("Beta")},
        {"op": "create", "entity_kind": "edge", "entity_id": "E1",
         "payload": {"edgeType": "FLOWS_TO", "sourceEntityId": "A", "targetEntityId": "B",
                     "confidence": 0.9, "properties": {"sql": "select 1"}}},
    ], "seed")

    with _deep_verify_cap(1):                             # 3 entities > cap → deep pass skipped
        r = await proj.project_graph(gid)
    assert not r.get("verify_error"), r                  # count-only → the attr drift is not caught
    wm = await svc.projection_watermark(gid)
    assert wm["fresh"] is True, wm                        # published (no hang, no hold-back)
    await db.dispose_engine()


async def _run_deep_verify_time_boxed() -> None:
    """The deep verify's FalkorDB scan re-sorts the whole graph per SKIP/LIMIT page, so on a
    large/dense graph it can grind for many minutes and — before this fix — overran the 900s rebuild
    budget, got the whole rebuild cancelled, and (a cancelled full seed being left retryable) re-ran
    forever: the "stuck at N of N items rebuilt" loop. The deep pass is now hard-time-boxed WELL under
    the rebuild budget; on timeout it degrades to the (passed) count verify and PUBLISHES. Proven by
    making the content diff hang and pinning a tiny budget: the rebuild still converges to fresh."""
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    fake = ReconcileFakeFalkor()
    name = "gvt_" + os.urandom(3).hex()
    G = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                               actor="alice", falkor_graph_name=name)
    gid = G["graph_id"]
    proj = FalkorProjector(graph_client_factory=fake, batch_size=2)
    await _edit_publish(svc, gid, "alice", [
        {"op": "create", "entity_kind": "node", "entity_id": "A", "payload": _node("Alpha")},
        {"op": "create", "entity_kind": "node", "entity_id": "B", "payload": _node("Beta")},
        {"op": "create", "entity_kind": "edge", "entity_id": "E1", "payload": _edge("A", "B")},
    ], "seed")

    # Make the deep content diff hang; the wall-clock budget must cut it off and publish. The stub is
    # cancelled by wait_for at the budget, so the 30s sleep never actually elapses — the test is fast.
    orig = ProjectionReconciler.content_drift

    async def _slow(self, *a, **k):
        await asyncio.sleep(30)                           # never completes within the tiny budget
        return [], [], [], [], [], []

    ProjectionReconciler.content_drift = _slow
    try:
        with _deep_verify_on(), _deep_verify_timeout(0.1):
            r = await proj.project_graph(gid)
    finally:
        ProjectionReconciler.content_drift = orig

    assert not r.get("verify_error"), r                  # degraded to count verify — not held back
    wm = await svc.projection_watermark(gid)
    assert wm["fresh"] is True and wm["projected"] == wm["committed"], wm   # published, no hang/loop
    await db.dispose_engine()


# --------------------------------------------------------------------------- #
# 9. A rebuild invalidates the reader's ontology→observed alias cache so raw    #
#    lineage edges render against the reseeded graph immediately (not after the #
#    TTL). Bumped on full-seed/heal publish; NOT on a noop or a held-back seed. #
# --------------------------------------------------------------------------- #
async def _run_rebuild_bumps_ontology_cache() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    fake = ReconcileFakeFalkor()

    import backend.app.services.resolved_ontology_cache as roc
    calls: list = []
    orig_bump = roc.bump_ontology_generation

    async def _spy(ws, ds):
        calls.append((ws, ds))

    roc.bump_ontology_generation = _spy
    try:
        gid, proj, name = await _seed(svc, fake)          # first projection == full seed → bump
        assert calls and calls[-1][0] == "ws1" and calls[-1][1].startswith("ds_"), calls

        calls.clear()
        await proj.project_graph(gid)                     # already fresh → noop → NO bump
        assert calls == [], calls

        assert await svc.request_projection_rebuild(gid) is True
        await proj.project_graph(gid)                     # explicit full-seed rebuild → bump again
        assert calls and calls[-1][0] == "ws1", calls

        # A held-back (unfaithful) reseed must NOT bump — reads stay on Postgres, no cache churn.
        calls.clear()
        real_counts = proj._falkor_counts
        async def _short(client):
            n, e = await real_counts(client)
            return max(0, n - 1), e
        proj._falkor_counts = _short
        assert await svc.request_projection_rebuild(gid) is True
        r = await proj.project_graph(gid)
        assert r["verify_error"] and calls == [], (r, calls)
    finally:
        roc.bump_ontology_generation = orig_bump
    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_projection_rebuild_bumps_ontology_cache_e2e():
    asyncio.run(_run_rebuild_bumps_ontology_cache())


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_projection_holdback_on_count_shortfall_e2e():
    asyncio.run(_run_holdback_on_count_shortfall())


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_projection_holdback_on_content_drift_e2e():
    asyncio.run(_run_holdback_on_content_drift())


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_projection_holdback_on_edge_attr_drift_e2e():
    asyncio.run(_run_holdback_on_edge_attr_drift())


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_projection_publishes_with_parallel_edges_e2e():
    asyncio.run(_run_publishes_with_parallel_edges())


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_projection_deep_verify_size_gated_e2e():
    asyncio.run(_run_deep_verify_size_gated())


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_projection_deep_verify_time_boxed_e2e():
    asyncio.run(_run_deep_verify_time_boxed())


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_projection_rebuild_full_replay_e2e():
    asyncio.run(_run_rebuild())


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_projection_reconcile_drift_e2e():
    asyncio.run(_run_drift())


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_projection_reconcile_deep_e2e():
    asyncio.run(_run_deep())


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_projection_rebuild_fires_rollup_hook_e2e():
    asyncio.run(_run_rollup_hook())


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_projection_reconcile_legacy_null_id_e2e():
    asyncio.run(_run_legacy_null_id())


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_projection_reconcile_ignores_derived_meta_e2e():
    asyncio.run(_run_reconcile_ignores_derived_meta())


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_projection_failure_honesty_e2e():
    asyncio.run(_run_failure_honesty())


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_projection_progress_writer_e2e():
    asyncio.run(_run_progress_writer())


if __name__ == "__main__":
    for _fn in (_run_rebuild, _run_drift, _run_deep, _run_rollup_hook, _run_legacy_null_id,
                _run_failure_honesty, _run_progress_writer,
                _run_holdback_on_count_shortfall, _run_holdback_on_content_drift,
                _run_holdback_on_edge_attr_drift, _run_publishes_with_parallel_edges,
                _run_deep_verify_size_gated, _run_deep_verify_time_boxed,
                _run_reconcile_ignores_derived_meta, _run_rebuild_bumps_ontology_cache):
        asyncio.run(_fn())
    print("versioning projection rebuild + reconcile e2e: OK")
