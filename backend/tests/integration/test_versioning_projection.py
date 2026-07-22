"""FalkorDB projection worker e2e — needs Postgres.

There's no FalkorDB socket here, so we inject a fake graph client that
*interprets* the exact (reader-compatible) Cypher the worker emits — urn-keyed
nodes labelled by entityType, edges typed by edgeType — over an in-memory
node/edge map.  That proves the real projection logic end-to-end on Postgres:
the projected graph (by stable entityId) equals ``materialize_state(main)``,
incremental advance + deletes apply, re-running a window is idempotent (crash
recovery), and a fork projects its copy-on-write composition into its own graph.
The live socket is covered by the real-FalkorDB module (CI / ``dev.sh infra``).
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.models import ProjectionStateORM
from backend.app.services.versioning.projection import (
    FalkorProjector,
    _DELETE_EDGES_FALLBACK,
)
from backend.app.services.versioning.reconcile import (
    _SCAN_EDGES,
    _SCAN_NODES,
)
from backend.app.services.versioning.service import GraphVersioningService


class _Result:
    """Minimal FalkorDB query result (only ``.result_set`` is read by the projector)."""

    def __init__(self, result_set):
        self.result_set = result_set


class FakeGraph:
    """Interprets the projector's reader-compatible Cypher into an in-memory graph."""

    def __init__(self):
        self.nodes: dict = {}   # urn -> item dict (carries entityId)
        self.edges: dict = {}   # eid -> {src, tgt, ...}

    async def query(self, cypher: str, params: dict = None):
        params = params or {}
        # Connectivity probe the non-destructive rebuild issues BEFORE the full-seed drop
        # (a trivial read that never touches the graph); a reachable instance answers it.
        if cypher == "RETURN 1":
            return _Result([[1]])
        # projection verify (Part 1E) — mirrors _falkor_counts: exclude rollup-derived artifacts
        # (the :AGGREGATED layer and its _GVRollupMeta marker) the same way FalkorDB's WHERE does.
        if cypher == "MATCH (n) WHERE NOT '_GVRollupMeta' IN labels(n) RETURN count(n) AS c":
            return _Result([[sum(1 for n in self.nodes.values() if n.get("_label") != "_GVRollupMeta")]])
        if cypher == "MATCH ()-[r]->() WHERE type(r) <> 'AGGREGATED' RETURN count(r) AS c":
            return _Result([[sum(1 for e in self.edges.values() if e.get("type") != "AGGREGATED")]])
        # Content-verify scans (reconciler primitives the full-seed verify now runs): the sorted
        # id-set streams + the deep urn fetch, over the same in-memory graph. entityId IS NOT NULL
        # / rollup exclusion mirror the real scan's guards.
        if cypher == _SCAN_NODES:
            # RETURN n.entityId, n.urn, n.displayName, labels(n) — the scan now carries the deep fields
            rows = sorted(([n["entityId"], n.get("urn"), n.get("displayName"), [n.get("_label")]]
                           for n in self.nodes.values()
                           if n.get("_label") != "_GVRollupMeta" and n.get("entityId") is not None),
                          key=lambda r: r[0])
            return _Result(rows[params["s"]: params["s"] + params["l"]])
        if cypher == _SCAN_EDGES:
            # RETURN r.id, type(r), r.confidence, r.properties (r.id == eid; parallel edges already
            # collapsed to one entry in self.edges by the MERGE interpreter above)
            rows = sorted(([eid, e.get("type"), e.get("conf"), e.get("props")]
                           for eid, e in self.edges.items()
                           if e.get("type") != "AGGREGATED" and eid is not None),
                          key=lambda r: r[0])
            return _Result(rows[params["s"]: params["s"] + params["l"]])
        # Node upsert: UNWIND $batch AS item MERGE (n:{label} {urn: item.urn}) SET ... REMOVE ...
        if cypher.startswith("UNWIND $batch AS item MERGE (n:"):
            label = cypher[len("UNWIND $batch AS item MERGE (n:"):].split(" {urn:", 1)[0]
            for it in params["batch"]:
                self.nodes[it["urn"]] = {**it, "_label": label}
            return None
        # Edge upsert (LABEL-ANCHORED): UNWIND $batch AS item MATCH (a:{slb} {urn: item.src})
        #   MATCH (b:{tlb} {urn: item.tgt}) MERGE (a)-[r:{rel}]->(b) SET ...
        if cypher.startswith("UNWIND $batch AS item MATCH (a:") and "MERGE (a)-[r:" in cypher:
            slb = cypher.split("MATCH (a:", 1)[1].split(" {urn:", 1)[0]
            tlb = cypher.split("MATCH (b:", 1)[1].split(" {urn:", 1)[0]
            rel = cypher.split("MERGE (a)-[r:", 1)[1].split("]->", 1)[0]
            for it in params["batch"]:
                a, b = self.nodes.get(it["src"]), self.nodes.get(it["tgt"])
                # Label-anchored MATCH: BOTH endpoints must exist WITH the anchored label, else the
                # row binds nothing and the edge is silently not created (models the real drop).
                if a and b and a.get("_label") == slb and b.get("_label") == tlb:
                    # id-less MERGE collapses parallel edges: FalkorDB keys a relationship on the
                    # (src, type, tgt) TRIPLE, so N edges sharing a triple become ONE (r.id = last
                    # writer). Drop any existing same-triple edge before (re-)adding — a no-op for a
                    # graph with no parallel edges, faithful for one that has them.
                    for _k in [k for k, e in self.edges.items()
                               if e["src"] == it["src"] and e["tgt"] == it["tgt"] and e["type"] == rel]:
                        self.edges.pop(_k, None)
                    self.edges[it["eid"]] = {"src": it["src"], "tgt": it["tgt"], "type": rel,
                                             "props": it.get("props"), "conf": it.get("conf")}
            return None
        # Typed + anchored edge delete: ...-[r:{rel} {id: item.eid}]->... DELETE r
        if "DELETE r" in cypher and "$batch" in cypher and "{id: item.eid}" in cypher:
            for it in params["batch"]:
                self.edges.pop(it["eid"], None)
            return None
        # Legacy fallback edge delete: UNWIND $ids AS i MATCH ()-[r {id: i}]->() DELETE r
        if cypher == _DELETE_EDGES_FALLBACK:
            for i in params["ids"]:
                self.edges.pop(i, None)
            return None
        # Node delete by (label, urn): UNWIND $urns AS u MATCH (n:{label} {urn: u}) DETACH DELETE n
        if cypher.startswith("UNWIND $urns AS u MATCH (n:") and "DETACH DELETE n" in cypher:
            for u in params["urns"]:
                self._drop_node(u)
            return None
        # Heal-path node delete confirming entityId: UNWIND $pairs AS p MATCH (n:{label} {urn: p.urn})
        #   WHERE n.entityId = p.eid DETACH DELETE n
        if cypher.startswith("UNWIND $pairs AS p MATCH (n:") and "DETACH DELETE n" in cypher:
            for p in params["pairs"]:
                n = self.nodes.get(p["urn"])
                if n is not None and n.get("entityId") == p["eid"]:
                    self._drop_node(p["urn"])
            return None
        raise AssertionError(f"unexpected cypher emitted: {cypher!r}")

    def _drop_node(self, urn: str) -> None:
        self.nodes.pop(urn, None)
        for k in [k for k, e in self.edges.items() if e["src"] == urn or e["tgt"] == urn]:
            self.edges.pop(k, None)

    async def delete(self):
        """GRAPH.DELETE — drops the whole graph key (used by the clean-rebuild seed)."""
        self.nodes.clear()
        self.edges.clear()

    def entity_ids(self) -> set:
        return {n["entityId"] for n in self.nodes.values()}

    def node(self, entity_id: str) -> dict:
        return next(n for n in self.nodes.values() if n["entityId"] == entity_id)


class FakeFalkor:
    def __init__(self):
        self.graphs: dict = {}

    def __call__(self, name: str, provider_id=None) -> FakeGraph:
        return self.graphs.setdefault(name, FakeGraph())


async def _edit_publish(svc, graph_id, actor, ops, msg):
    d = await svc.open_draft(graph_id=graph_id, owner=actor)
    await svc.stage_changes(graph_id=graph_id, branch_id=d, actor=actor, ops=ops)
    await svc.checkpoint(graph_id=graph_id, branch_id=d, actor=actor)
    await svc.publish(graph_id=graph_id, branch_id=d, actor=actor, message=msg)


async def _watermark(graph_id: str) -> int:
    async with db.graphver_session() as s:
        ps = await s.get(ProjectionStateORM, graph_id)
        return ps.projected_commit_seq


async def _graph_name(graph_id: str) -> str:
    async with db.graphver_session() as s:
        ps = await s.get(ProjectionStateORM, graph_id)
        return ps.falkor_graph_name or FalkorProjector.default_graph_name(graph_id)


async def _assert_matches_main(svc, fake: FakeFalkor, graph_id: str) -> FakeGraph:
    """Projected FalkorDB graph (by entityId) == PG-materialized main state."""
    g = fake.graphs[await _graph_name(graph_id)]
    mid = await svc.main_branch_id(graph_id)
    st = await svc.materialize_state(graph_id=graph_id, branch_id=mid)
    assert g.entity_ids() == set(st["nodes"]), (g.entity_ids(), set(st["nodes"]))
    assert set(g.edges) == set(st["edges"]), (set(g.edges), set(st["edges"]))
    return g


def _node(displayName, props=None, etype="Dataset"):
    p = {"displayName": displayName, "entityType": etype}
    if props is not None:
        p["properties"] = props
    return p


def _edge(src, tgt, etype="FLOWS_TO"):
    return {"edgeType": etype, "sourceEntityId": src, "targetEntityId": tgt}


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    fake = FakeFalkor()
    proj = FalkorProjector(graph_client_factory=fake, batch_size=2)   # tiny batch → UNWIND chunking

    # ── seed + first projection (pinned target: unpinned graphs are no longer projected) ──
    first_name = "gvt_" + os.urandom(3).hex()
    G = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                               actor="alice", falkor_graph_name=first_name)
    gid = G["graph_id"]
    await _edit_publish(svc, gid, "alice", [
        {"op": "create", "entity_kind": "node", "entity_id": "A",
         "payload": _node("Alpha", {"owner": "team-a", "meta": {"k": 1}})},
        {"op": "create", "entity_kind": "node", "entity_id": "B", "payload": _node("Beta")},
        {"op": "create", "entity_kind": "edge", "entity_id": "E1", "payload": _edge("A", "B")},
    ], "seed")
    r = await proj.project_graph(gid)
    assert r["projected"] == 2 and not r["noop"], r
    g = await _assert_matches_main(svc, fake, gid)
    assert g.entity_ids() == {"A", "B"} and set(g.edges) == {"E1"}
    a = g.node("A")
    assert a["displayName"] == "Alpha"
    assert a["nativeProps"] == {"owner": "team-a"}           # scalar user prop → native
    assert a["propertiesRaw"] == '{"meta": {"k": 1}}'        # nested user prop → JSON residual
    assert g.nodes[a["urn"]]                                  # node is keyed by urn (gv:A here)
    assert a["urn"] == "gv:A"                                 # no urn in payload → stable fallback
    assert await _watermark(gid) == 2

    # ── idempotent no-op when caught up ──────────────────────────────────
    assert (await proj.project_graph(gid))["noop"] is True

    # ── incremental: update A, add C + edge A->C ─────────────────────────
    await _edit_publish(svc, gid, "alice", [
        {"op": "update", "entity_kind": "node", "entity_id": "A", "payload": _node("Alpha2")},
        {"op": "create", "entity_kind": "node", "entity_id": "C", "payload": _node("Gamma")},
        {"op": "create", "entity_kind": "edge", "entity_id": "E2", "payload": _edge("A", "C")},
    ], "grow")
    assert (await proj.project_graph(gid))["projected"] == 3
    g = await _assert_matches_main(svc, fake, gid)
    assert g.entity_ids() == {"A", "B", "C"} and set(g.edges) == {"E1", "E2"}
    assert g.node("A")["displayName"] == "Alpha2"

    # ── deletes: drop E1 then B ──────────────────────────────────────────
    await _edit_publish(svc, gid, "alice", [
        {"op": "delete", "entity_kind": "edge", "entity_id": "E1", "payload": None},
        {"op": "delete", "entity_kind": "node", "entity_id": "B", "payload": None},
    ], "prune")
    assert (await proj.project_graph(gid))["projected"] == 4
    g = await _assert_matches_main(svc, fake, gid)
    assert g.entity_ids() == {"A", "C"} and set(g.edges) == {"E2"}

    # ── crash recovery: rewind the watermark, re-apply window — idempotent ─
    async with db.graphver_session() as s:
        ps = await s.get(ProjectionStateORM, gid)
        ps.projected_commit_seq = 3                  # apply landed but watermark write was "lost"
    assert (await proj.project_graph(gid))["projected"] == 4
    g = await _assert_matches_main(svc, fake, gid)
    assert g.entity_ids() == {"A", "C"} and set(g.edges) == {"E2"}   # converged, no dup/loss

    # ── fork projects its copy-on-write composition into its OWN graph ───
    F = await svc.fork_graph(parent_graph_id=gid, workspace_id="ws1", actor="bob")
    fr = await proj.project_graph(F["graph_id"])
    assert not fr["noop"]
    fg = await _assert_matches_main(svc, fake, F["graph_id"])
    assert fg.entity_ids() == {"A", "C"} and set(fg.edges) == {"E2"}   # inherited base, nothing copied
    assert "__fork_" in await _graph_name(F["graph_id"])               # fork has its own graph name

    # ── self-healing re-point: ensure_projection_target re-points a graph to the data source's
    # real graph and resets the watermark; the next projection REBUILDS that graph clean — a stale
    # row main no longer has must be gone (the additive seed alone would leave it: the reported
    # "deletes still show on Main").
    real_name = "real_ds_graph"
    fake(real_name).nodes["gv:STALE"] = {"urn": "gv:STALE", "entityId": "STALE", "displayName": "stale"}
    old = await svc.ensure_projection_target(graph_id=gid, falkor_graph_name=real_name)
    assert old == first_name, old                                      # returns the now-orphaned name to drop
    assert await _graph_name(gid) == real_name                         # re-pointed to the real graph
    assert await _watermark(gid) == 0                                  # reset → next projection is a full reseed
    assert (await proj.project_graph(gid))["projected"] == 4
    rg = fake.graphs[real_name]
    assert "STALE" not in rg.entity_ids(), rg.entity_ids()             # clean rebuild dropped the stale node
    assert rg.entity_ids() == {"A", "C"} and set(rg.edges) == {"E2"}   # == materialized main
    assert (await proj.project_graph(gid))["noop"] is True             # caught up; no churn on the next call

    # a fork is left untouched — it legitimately owns its __fork_ graph (no re-point, returns None).
    assert await svc.ensure_projection_target(graph_id=F["graph_id"], falkor_graph_name=real_name) is None
    assert "__fork_" in await _graph_name(F["graph_id"])

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_projection_e2e():
    asyncio.run(_run())


async def _run_target_resolver() -> None:
    """B1: a worker-driven projection self-heals its target via the injected ``target_resolver``.

    A graph projected before its real FalkorDB name was injected lives in an orphan ``gv_<id>`` that
    the canvas never reads, so merged main never surfaces ("merge reverts to old state"). The async
    worker has no access to the app-layer ``project_now`` repair, so its projector is given a
    ``target_resolver`` (mirrors ``FalkorProjector(target_resolver=repair_projection_target)``): every
    ``project_graph`` re-points to the real graph, rebuilds there, and drops the orphan."""
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    fake = FakeFalkor()

    G = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="alice")
    gid = G["graph_id"]
    await _edit_publish(svc, gid, "alice", [
        {"op": "create", "entity_kind": "node", "entity_id": "A", "payload": _node("Alpha")},
        {"op": "create", "entity_kind": "node", "entity_id": "B", "payload": _node("Beta")},
    ], "seed")

    # Pre-B1 legacy state: the row was once pinned to (and projected into) its orphan gv_<id>.
    # A resolver-less projection NO LONGER creates that state — unpinned graphs are skipped
    # outright (nothing reads a synthetic gv_ key) — so first pin the new invariant, then
    # simulate the legacy row by pinning the orphan name explicitly.
    orphan_name = FalkorProjector.default_graph_name(gid)
    r0 = await FalkorProjector(graph_client_factory=fake, batch_size=2).project_graph(gid)
    assert r0["noop"] and r0.get("skipped") == "unpinned", r0
    assert fake.graphs.get(orphan_name) is None                      # no orphan key was created
    await svc.ensure_projection_target(graph_id=gid, falkor_graph_name=orphan_name)

    # The worker's projector carries a target_resolver pinning the data source's REAL graph.
    real_name = "real_ds_graph_b1"

    async def resolver(s, graph_id):                 # same contract as repair_projection_target(svc, gid)
        return await s.ensure_projection_target(graph_id=graph_id, falkor_graph_name=real_name)

    worker_proj = FalkorProjector(graph_client_factory=fake, batch_size=2, target_resolver=resolver)
    await _edit_publish(svc, gid, "alice",
                        [{"op": "create", "entity_kind": "node", "entity_id": "C", "payload": _node("Gamma")}],
                        "grow")

    r = await worker_proj.project_graph(gid)
    assert not r["noop"], r
    assert await _graph_name(gid) == real_name                       # self-healed: re-pointed to the real graph
    assert fake.graphs[real_name].entity_ids() == {"A", "B", "C"}    # full rebuild == materialized main
    assert fake(orphan_name).entity_ids() == set()                   # orphan dropped (RAM reclaimed)
    assert (await worker_proj.project_graph(gid))["noop"] is True    # caught up; idempotent

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_projection_target_resolver_e2e():
    asyncio.run(_run_target_resolver())


# ── Non-destructive rebuild: probe before the full-seed drop; abort on a drop failure ──────────
#
# A full seed DROPs the FalkorDB graph key and re-MERGEs it from Postgres. If the resolved client
# is unreachable/misrouted, the drop must NOT run (it would wipe the read cache with no way to
# re-seed it) and a drop that FAILS on an existing graph must NOT fall through to the MERGE
# (which cannot repair a partial/failed wipe). These fakes make the probe / the drop fail on
# demand and assert: nothing dropped, MERGE never runs, existing cache intact, watermark unmoved.

class _ProbeFailGraph(FakeGraph):
    """A reachable-check that fails: the connectivity probe (``RETURN 1``) raises, as an
    unreachable/misrouted instance would. ``delete`` records whether it was ever called."""

    def __init__(self):
        super().__init__()
        self.delete_called = False

    async def query(self, cypher: str, params: dict = None):
        if cypher == "RETURN 1":
            raise ConnectionError("Connection refused")
        return await super().query(cypher, params)

    async def delete(self):
        self.delete_called = True
        await super().delete()


class _DropFailGraph(FakeGraph):
    """Reachable (the probe answers) but ``delete`` raises the injected error. ``apply_ran``
    flips on the first MERGE/DELETE apply query, so a test can assert the MERGE never ran."""

    def __init__(self, drop_exc: Exception):
        super().__init__()
        self._drop_exc = drop_exc
        self.apply_ran = False

    async def query(self, cypher: str, params: dict = None):
        if cypher.startswith("UNWIND"):
            self.apply_ran = True
        return await super().query(cypher, params)

    async def delete(self):
        raise self._drop_exc


async def _seed_pinned_graph(svc, name: str) -> str:
    """Create + publish a two-node graph pinned to ``name`` (a real FalkorDB target), left at
    watermark 0 so the next ``project_graph`` takes the full-seed (drop-then-reseed) path."""
    G = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                               actor="alice", falkor_graph_name=name)
    gid = G["graph_id"]
    await _edit_publish(svc, gid, "alice", [
        {"op": "create", "entity_kind": "node", "entity_id": "A", "payload": _node("Alpha")},
        {"op": "create", "entity_kind": "node", "entity_id": "B", "payload": _node("Beta")},
    ], "seed")
    return gid


async def _projection_state(gid: str):
    async with db.graphver_session() as s:
        ps = await s.get(ProjectionStateORM, gid)
        return ps.status, ps.last_error, ps.projected_commit_seq


async def _run_probe_fails_no_drop() -> None:
    """Unreachable target: ``project_graph`` RAISES before any drop — nothing dropped, the
    existing cache survives untouched, the watermark does not advance, ``last_error`` is set."""
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    fake = FakeFalkor()
    name = "gvt_" + os.urandom(3).hex()
    g = _ProbeFailGraph()
    g.nodes["gv:OLD"] = {"urn": "gv:OLD", "entityId": "OLD", "_label": "Dataset", "displayName": "old"}
    fake.graphs[name] = g
    gid = await _seed_pinned_graph(svc, name)

    proj = FalkorProjector(graph_client_factory=fake, batch_size=2)
    raised = False
    try:
        await proj.project_graph(gid)
    except ConnectionError:
        raised = True
    assert raised, "project_graph must RAISE when the connectivity probe fails"
    assert not g.delete_called, "the graph key must NOT be dropped when the probe fails"
    assert "OLD" in g.entity_ids(), "the existing read cache must be left intact"

    status, last_error, projected = await _projection_state(gid)
    assert status == "idle", status                  # outer handler reset the 'rebuilding' row
    assert last_error, "last_error must record the surfaced failure"
    assert projected == 0, projected                 # watermark did NOT advance
    await db.dispose_engine()


async def _run_drop_failure_aborts() -> None:
    """A drop that FAILS on an existing graph (non-``empty key``) aborts: ``project_graph``
    RAISES and the MERGE apply NEVER runs, so a failed wipe can't be papered over by a merge."""
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    fake = FakeFalkor()
    name = "gvt_" + os.urandom(3).hex()
    g = _DropFailGraph(RuntimeError("WRONGTYPE Operation against a key holding the wrong kind of value"))
    g.nodes["gv:OLD"] = {"urn": "gv:OLD", "entityId": "OLD", "_label": "Dataset", "displayName": "old"}
    fake.graphs[name] = g
    gid = await _seed_pinned_graph(svc, name)

    proj = FalkorProjector(graph_client_factory=fake, batch_size=2)
    raised = False
    try:
        await proj.project_graph(gid)
    except RuntimeError:
        raised = True
    assert raised, "a non-'empty key' drop failure must RAISE (never proceed to MERGE)"
    assert not g.apply_ran, "the MERGE apply must NOT run after a failed drop"
    assert "OLD" in g.entity_ids(), "the existing read cache must be left intact"

    status, last_error, projected = await _projection_state(gid)
    assert status == "idle", status
    assert last_error, "last_error must record the surfaced failure"
    assert projected == 0, projected
    await db.dispose_engine()


async def _run_empty_key_proceeds() -> None:
    """The benign fresh-graph case: ``delete`` raises "empty key" (no graph yet) → the seed
    PROCEEDS and MERGEs committed main, exactly as before (a normal first projection)."""
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    fake = FakeFalkor()
    name = "gvt_" + os.urandom(3).hex()
    g = _DropFailGraph(RuntimeError("Invalid graph operation on empty key"))
    fake.graphs[name] = g
    gid = await _seed_pinned_graph(svc, name)

    proj = FalkorProjector(graph_client_factory=fake, batch_size=2)
    r = await proj.project_graph(gid)
    assert not r["noop"], r
    assert g.apply_ran, "the fresh-graph seed must proceed to the MERGE apply"
    assert g.entity_ids() == {"A", "B"}, g.entity_ids()
    status, _, projected = await _projection_state(gid)
    assert status == "idle" and projected == 2, (status, projected)
    await db.dispose_engine()


async def _run_healthy_full_seed() -> None:
    """A healthy client full-seeds exactly as today: the probe answers, the drop clears, the
    MERGE lands committed main. (The broad seed/incremental/reseed path is covered by _run.)"""
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    fake = FakeFalkor()
    name = "gvt_" + os.urandom(3).hex()
    gid = await _seed_pinned_graph(svc, name)

    proj = FalkorProjector(graph_client_factory=fake, batch_size=2)
    r = await proj.project_graph(gid)
    assert not r["noop"] and r["projected"] == 2, r
    assert fake.graphs[name].entity_ids() == {"A", "B"}
    status, _, projected = await _projection_state(gid)
    assert status == "idle" and projected == 2, (status, projected)
    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_projection_probe_fails_no_drop_e2e():
    asyncio.run(_run_probe_fails_no_drop())


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_projection_drop_failure_aborts_e2e():
    asyncio.run(_run_drop_failure_aborts())


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_projection_empty_key_proceeds_e2e():
    asyncio.run(_run_empty_key_proceeds())


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_projection_healthy_full_seed_e2e():
    asyncio.run(_run_healthy_full_seed())


if __name__ == "__main__":
    asyncio.run(_run())
    asyncio.run(_run_probe_fails_no_drop())
    asyncio.run(_run_drop_failure_aborts())
    asyncio.run(_run_empty_key_proceeds())
    asyncio.run(_run_healthy_full_seed())
    print("versioning FalkorDB projection e2e: OK")
