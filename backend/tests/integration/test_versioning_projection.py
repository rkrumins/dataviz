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
    _DELETE_EDGES,
    _DELETE_NODES,
)
from backend.app.services.versioning.service import GraphVersioningService


class FakeGraph:
    """Interprets the projector's reader-compatible Cypher into an in-memory graph."""

    def __init__(self):
        self.nodes: dict = {}   # urn -> item dict (carries entityId)
        self.edges: dict = {}   # eid -> {src, tgt, ...}

    async def query(self, cypher: str, params: dict = None):
        params = params or {}
        if cypher.startswith("UNWIND $batch AS item MERGE (n:"):
            for it in params["batch"]:
                self.nodes[it["urn"]] = dict(it)
        elif cypher.startswith("UNWIND $batch AS item MATCH (a {urn: item.src})"):
            for it in params["batch"]:
                if it["src"] in self.nodes and it["tgt"] in self.nodes:   # MATCH semantics
                    self.edges[it["eid"]] = {"src": it["src"], "tgt": it["tgt"],
                                             "props": it.get("props"), "conf": it.get("conf")}
        elif cypher == _DELETE_EDGES:
            for i in params["ids"]:
                self.edges.pop(i, None)
        elif cypher == _DELETE_NODES:
            for u in params["urns"]:
                self.nodes.pop(u, None)
                for k in [k for k, e in self.edges.items() if e["src"] == u or e["tgt"] == u]:
                    self.edges.pop(k, None)
        else:
            raise AssertionError(f"unexpected cypher emitted: {cypher!r}")
        return None

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

    def __call__(self, name: str) -> FakeGraph:
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

    # ── seed + first projection ──────────────────────────────────────────
    G = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="alice")
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

    # ── self-healing re-point: a graph auto-created without its real FalkorDB name is pinned to the
    # orphan gv_<id>. ensure_projection_target re-points it to the data source's real graph and resets
    # the watermark; the next projection REBUILDS that graph clean — a stale row main no longer has
    # must be gone (the additive seed alone would leave it: the reported "deletes still show on Main").
    real_name = "real_ds_graph"
    fake(real_name).nodes["gv:STALE"] = {"urn": "gv:STALE", "entityId": "STALE", "displayName": "stale"}
    old = await svc.ensure_projection_target(graph_id=gid, falkor_graph_name=real_name)
    assert old == f"gv_{gid}", old                                     # returns the now-orphaned name to drop
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


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning FalkorDB projection e2e: OK")
