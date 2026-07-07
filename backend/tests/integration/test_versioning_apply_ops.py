"""apply_ops is O(ops), not O(graph) (redesign Phase C) — needs Postgres.

A write resolves only the affected entities: a node delete cascades to just its incident
edges (bounded by degree, via ix_ev_source/ix_ev_target), referential integrity rejects a
dangling edge, an update touches only its entity, and unrelated entities are never rewritten
(verified through their version history).
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.service import ConcurrencyError, GraphVersioningService


def _n(eid):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": eid, "entityType": "Dataset", "displayName": eid}}


def _e(eid, s, t):
    return {"op": "create", "entity_kind": "edge", "entity_id": eid,
            "payload": {"edgeType": "REL", "sourceEntityId": s, "targetEntityId": t}}


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    G = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="u")
    gid, main = G["graph_id"], G["main_branch_id"]

    # seed: A,B,C,D + edges A->B (e1), A->C (e2), B->D (e3)
    await svc.apply_ops(graph_id=gid, actor="u", message="seed", ops=[
        _n("A"), _n("B"), _n("C"), _n("D"), _e("e1", "A", "B"), _e("e2", "A", "C"), _e("e3", "B", "D")])
    st = await svc.materialize_state(graph_id=gid, branch_id=main)
    assert set(st["nodes"]) == {"A", "B", "C", "D"} and set(st["edges"]) == {"e1", "e2", "e3"}

    # delete A → cascades only its incident edges (e1, e2); e3 (B->D) survives untouched
    await svc.apply_ops(graph_id=gid, actor="u", message="del A",
                        ops=[{"op": "delete", "entity_kind": "node", "entity_id": "A", "payload": None}])
    st = await svc.materialize_state(graph_id=gid, branch_id=main)
    assert set(st["nodes"]) == {"B", "C", "D"} and set(st["edges"]) == {"e3"}
    # bounded: e3 was NOT rewritten by the delete-A commit; e1 got exactly create + cascade-delete
    assert len(await svc.entity_history(graph_id=gid, entity_id="e3")) == 1
    assert len(await svc.entity_history(graph_id=gid, entity_id="e1")) == 2

    # a dangling edge is rejected by the bounded integrity check
    with pytest.raises(ConcurrencyError):
        await svc.apply_ops(graph_id=gid, actor="u", message="dangle", ops=[_e("e4", "B", "NOPE")])

    # update touches only its entity
    await svc.apply_ops(graph_id=gid, actor="u", message="upd B", ops=[
        {"op": "update", "entity_kind": "node", "entity_id": "B",
         "payload": {"urn": "B", "entityType": "Dataset", "displayName": "B2"}}])
    st = await svc.materialize_state(graph_id=gid, branch_id=main)
    assert st["nodes"]["B"]["displayName"] == "B2" and st["nodes"]["C"]["displayName"] == "C"
    assert len(await svc.entity_history(graph_id=gid, entity_id="C")) == 1   # C never rewritten

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_apply_ops_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning apply_ops O(ops) bounded cascade/integrity e2e: OK")
