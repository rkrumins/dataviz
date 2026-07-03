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
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.models import ProjectionStateORM
from backend.app.services.versioning.projection import FalkorProjector
from backend.app.services.versioning.reconcile import (
    ProjectionReconciler,
    _DEEP_FETCH,
    _SCAN_EDGES,
    _SCAN_NODES,
)
from backend.app.services.versioning.service import GraphVersioningService

# Reuse the projector-Cypher-interpreting fake + e2e helpers verbatim (see that module's docstring).
from backend.tests.integration.test_versioning_projection import (
    FakeFalkor,
    FakeGraph,
    _Result,
    _assert_matches_main,
    _edit_publish,
    _edge,
    _graph_name,
    _node,
    _watermark,
)


class ReconcileFakeGraph(FakeGraph):
    """FakeGraph + the reconciler's read queries (ordered id scans + the deep urn fetch),
    delegating everything else to the projector-Cypher interpreter it inherits."""

    async def query(self, cypher: str, params: dict = None):
        params = params or {}
        if cypher == _SCAN_NODES:
            # Mirror the scan's `entityId IS NOT NULL` guard — legacy never-versioned cache entries
            # carry no id and are excluded from the id-diff (they surface via count drift instead).
            rows = sorted(([n["entityId"], n.get("urn")] for n in self.nodes.values()
                           if n.get("_label") != "_GVRollupMeta" and n.get("entityId") is not None),
                          key=lambda r: r[0])
            return _Result(rows[params["s"]: params["s"] + params["l"]])
        if cypher == _SCAN_EDGES:
            rows = sorted(([eid] for eid, e in self.edges.items()
                           if e.get("type") != "AGGREGATED" and eid is not None),
                          key=lambda r: r[0])
            return _Result(rows[params["s"]: params["s"] + params["l"]])
        if cypher == _DEEP_FETCH:
            out = []
            for u in params["urns"]:
                n = self.nodes.get(u)                    # nodes are keyed by urn (MATCH semantics)
                if n is not None:
                    out.append([n["urn"], n["entityId"], n.get("displayName"), [n.get("_label")]])
            return _Result(out)
        return await super().query(cypher, params)


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

    # drop B (and its incident edge E1) straight out of the cache → reconcile reports both missing.
    g = fake.graphs[name]
    g.nodes.pop(g.node("B")["urn"])
    g.edges.pop("E1")
    rep = await ProjectionReconciler(db.graphver_session, fake).reconcile(gid)
    assert rep.in_sync is False
    assert [m["entityId"] for m in rep.missing_nodes] == ["B"], rep.missing_nodes
    assert rep.missing_edges == ["E1"], rep.missing_edges
    assert rep.falkor_nodes == 1 and rep.falkor_edges == 0        # counts caught it too

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


if __name__ == "__main__":
    for _fn in (_run_rebuild, _run_drift, _run_deep, _run_rollup_hook, _run_legacy_null_id):
        asyncio.run(_fn())
    print("versioning projection rebuild + reconcile e2e: OK")
