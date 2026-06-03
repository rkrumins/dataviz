"""Bounded O(neighborhood) neighbor reads (redesign Phase D) — needs Postgres.

neighbors_from_state walks the graph hop-by-hop from the seed, querying only the
frontier's incident live edges (ix_ev_source/ix_ev_target) — never composing full state.
Verifies depth, direction, edge-type filtering, the limit cap, an unknown seed, and as-of
(a deleted edge reappears when reading at an earlier commit).
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.service import GraphVersioningService


def _n(eid):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": eid, "entityType": "Dataset", "displayName": eid}}


def _e(eid, s, t, etype):
    return {"op": "create", "entity_kind": "edge", "entity_id": eid,
            "payload": {"edgeType": etype, "sourceEntityId": s, "targetEntityId": t}}


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    G = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="u")
    gid, main = G["graph_id"], G["main_branch_id"]

    # A-FLOWS->B-FLOWS->C-FLOWS->D ; A-KNOWS->E
    await svc.apply_ops(graph_id=gid, actor="u", message="seed", ops=[
        _n("A"), _n("B"), _n("C"), _n("D"), _n("E"),
        _e("e_ab", "A", "B", "FLOWS"), _e("e_bc", "B", "C", "FLOWS"),
        _e("e_cd", "C", "D", "FLOWS"), _e("e_ae", "A", "E", "KNOWS")])
    seed_seq = (await svc.get_graph(gid))["main_head_commit_seq"]

    async def nb(urn, **kw):
        r = await svc.neighbors_from_state(graph_id=gid, branch_id=main, urn=urn, **kw)
        return {n["entityId"] for n in r["nodes"]}, {e["id"] for e in r["edges"]}

    # depth-1 both: A's direct neighbours
    assert await nb("A", depth=1) == ({"A", "B", "E"}, {"e_ab", "e_ae"})
    # depth-2 out: A->B->C and A->E
    assert await nb("A", depth=2, direction="out") == ({"A", "B", "C", "E"}, {"e_ab", "e_bc", "e_ae"})
    # direction in on C: only B->C
    assert await nb("C", depth=1, direction="in") == ({"C", "B"}, {"e_bc"})
    # edge-type filter
    assert await nb("A", depth=1, edge_types=["KNOWS"]) == ({"A", "E"}, {"e_ae"})
    # limit caps the neighbourhood
    n, _ = await nb("A", depth=5, limit=2)
    assert len(n) <= 2
    # unknown seed → empty
    r = await svc.neighbors_from_state(graph_id=gid, branch_id=main, urn="NOPE", depth=1)
    assert r["nodes"] == [] and r["edges"] == []

    # delete A->B; now B is not a depth-1 neighbour, but an as-of read at the seed shows it
    await svc.apply_ops(graph_id=gid, actor="u", message="del e_ab",
                        ops=[{"op": "delete", "entity_kind": "edge", "entity_id": "e_ab", "payload": None}])
    assert await nb("A", depth=1) == ({"A", "E"}, {"e_ae"})
    r = await svc.neighbors_from_state(graph_id=gid, branch_id=main, urn="A", depth=1, as_of_seq=seed_seq)
    assert {e["id"] for e in r["edges"]} == {"e_ab", "e_ae"}

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_neighbors_bounded_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning bounded O(neighborhood) reads e2e: OK")
