"""FalkorDB projection worker e2e — needs Postgres.

There's no FalkorDB socket in this environment, so we inject a fake graph client
that *interprets* the exact Cypher the worker emits (MERGE/DELETE over an
in-memory node/edge map).  That proves the real projection logic end-to-end on
Postgres: the projected graph equals ``materialize_state(main)``, incremental
advance and deletes apply, re-running a window is idempotent (crash recovery),
and a fork projects its copy-on-write composition.  The only thing left unproven
is the live socket — wire :func:`make_falkor_graph_factory` against a FalkorDB in
CI to cover that.
"""
import asyncio
import os

import pytest
from sqlalchemy import select

from backend.app.services.versioning import db, models
from backend.app.services.versioning.models import ProjectionStateORM
from backend.app.services.versioning.projection import (
    FalkorProjector,
    _DELETE_EDGES,
    _DELETE_NODES,
    _UPSERT_EDGES,
    _UPSERT_NODES,
)
from backend.app.services.versioning.service import GraphVersioningService


class FakeGraph:
    """Interprets the worker's four Cypher shapes into an in-memory graph."""

    def __init__(self):
        self.nodes: dict = {}
        self.edges: dict = {}

    async def query(self, cypher: str, params: dict = None):
        params = params or {}
        if cypher == _UPSERT_NODES:
            for r in params["rows"]:
                self.nodes[r["eid"]] = dict(r["props"])
        elif cypher == _UPSERT_EDGES:
            for r in params["rows"]:
                if r["src"] in self.nodes and r["tgt"] in self.nodes:   # MATCH semantics
                    self.edges[r["eid"]] = {"src": r["src"], "tgt": r["tgt"], "props": dict(r["props"])}
        elif cypher == _DELETE_EDGES:
            for x in params["ids"]:
                self.edges.pop(x, None)
        elif cypher == _DELETE_NODES:
            for x in params["ids"]:
                self.nodes.pop(x, None)
                for k in [k for k, e in self.edges.items() if e["src"] == x or e["tgt"] == x]:
                    self.edges.pop(k, None)
        else:
            raise AssertionError(f"unexpected cypher emitted: {cypher!r}")
        return None


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


async def _assert_matches_main(svc, fake: FakeFalkor, graph_id: str):
    """Projected FalkorDB graph == PG-materialized main state."""
    name = FalkorProjector.default_graph_name(graph_id)
    g = fake.graphs[name]
    mid = await svc.main_branch_id(graph_id)
    st = await svc.materialize_state(graph_id=graph_id, branch_id=mid)
    assert set(g.nodes) == set(st["nodes"]), (set(g.nodes), set(st["nodes"]))
    assert set(g.edges) == set(st["edges"]), (set(g.edges), set(st["edges"]))
    return g


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    fake = FakeFalkor()
    proj = FalkorProjector(graph_client_factory=fake, batch_size=2)   # tiny batch → exercises UNWIND chunking

    # ── seed + first projection ──────────────────────────────────────────
    G = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="alice")
    gid = G["graph_id"]
    await _edit_publish(svc, gid, "alice", [
        {"op": "create", "entity_kind": "node", "entity_id": "A", "payload": {"displayName": "Alpha", "meta": {"k": 1}}},
        {"op": "create", "entity_kind": "node", "entity_id": "B", "payload": {"displayName": "Beta"}},
        {"op": "create", "entity_kind": "edge", "entity_id": "E1", "payload": {"edgeType": "R", "sourceEntityId": "A", "targetEntityId": "B"}},
    ], "seed")
    r = await proj.project_graph(gid)
    assert r["projected"] == 2 and not r["noop"], r
    g = await _assert_matches_main(svc, fake, gid)
    assert set(g.nodes) == {"A", "B"} and set(g.edges) == {"E1"}
    assert g.nodes["A"]["displayName"] == "Alpha"
    assert g.nodes["A"]["meta"] == '{"k": 1}'              # nested → JSON-encoded prop
    assert await _watermark(gid) == 2

    # ── idempotent no-op when caught up ──────────────────────────────────
    assert (await proj.project_graph(gid))["noop"] is True

    # ── incremental: update A, add C + edge A->C ─────────────────────────
    await _edit_publish(svc, gid, "alice", [
        {"op": "update", "entity_kind": "node", "entity_id": "A", "payload": {"displayName": "Alpha2"}},
        {"op": "create", "entity_kind": "node", "entity_id": "C", "payload": {"displayName": "Gamma"}},
        {"op": "create", "entity_kind": "edge", "entity_id": "E2", "payload": {"edgeType": "R", "sourceEntityId": "A", "targetEntityId": "C"}},
    ], "grow")
    assert (await proj.project_graph(gid))["projected"] == 3
    g = await _assert_matches_main(svc, fake, gid)
    assert set(g.nodes) == {"A", "B", "C"} and set(g.edges) == {"E1", "E2"}
    assert g.nodes["A"]["displayName"] == "Alpha2"

    # ── deletes: drop E1 then B ──────────────────────────────────────────
    await _edit_publish(svc, gid, "alice", [
        {"op": "delete", "entity_kind": "edge", "entity_id": "E1", "payload": None},
        {"op": "delete", "entity_kind": "node", "entity_id": "B", "payload": None},
    ], "prune")
    assert (await proj.project_graph(gid))["projected"] == 4
    g = await _assert_matches_main(svc, fake, gid)
    assert set(g.nodes) == {"A", "C"} and set(g.edges) == {"E2"}

    # ── crash recovery: rewind the watermark, re-apply window — idempotent ─
    async with db.graphver_session() as s:
        ps = await s.get(ProjectionStateORM, gid)
        ps.projected_commit_seq = 3                        # pretend the apply landed but the watermark write was lost
    assert (await proj.project_graph(gid))["projected"] == 4
    g = await _assert_matches_main(svc, fake, gid)
    assert set(g.nodes) == {"A", "C"} and set(g.edges) == {"E2"}   # converged, no duplication/loss

    # ── fork projects its copy-on-write composition (separate graph) ─────
    F = await svc.fork_graph(parent_graph_id=gid, workspace_id="ws1", actor="bob")
    fr = await proj.project_graph(F["graph_id"])
    assert not fr["noop"]
    fg = await _assert_matches_main(svc, fake, F["graph_id"])
    assert set(fg.nodes) == {"A", "C"} and set(fg.edges) == {"E2"}   # inherited base, nothing copied in PG
    assert FalkorProjector.default_graph_name(F["graph_id"]) in fake.graphs

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_projection_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning FalkorDB projection e2e: OK")
