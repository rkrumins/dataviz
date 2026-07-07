"""Conflict resolution must settle ONLY the conflicting field — not wholesale-replace the entity.

Audited data-loss vector: when a user resolves a same-field conflict, the resolution payload was
applied as a whole-entity replace, silently DROPPING any non-conflicting field the other branch
committed to that same entity (if the resolution payload omitted it). The fix overlays the
resolution only at the conflicting field-paths on top of the 3-way auto-merge, so a field the OTHER
side changed (and this resolution didn't touch) survives.

Scenario: main changes A.f1 AND A.f2; a draft changes only A.f1 (→ f1 conflicts, f2 auto-merges to
main's value). Resolving the f1 clash with a payload that omits f2 must KEEP main's f2.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.service import GraphVersioningService


def _node(eid, **p):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": f"urn:{eid}", "entityType": "Dataset", "displayName": eid, **p}}


def _upd(eid, **fields):
    return {"op": "update", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": f"urn:{eid}", "entityType": "Dataset", "displayName": eid, **fields}}


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    G = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="u")
    gid = G["graph_id"]

    d0 = await svc.open_draft(graph_id=gid, owner="u")
    await svc.apply_ops(graph_id=gid, branch_id=d0, actor="u", ops=[_node("A", f1=0, f2=0)])
    await svc.publish(graph_id=gid, branch_id=d0, actor="u", message="seed")   # main: A{f1:0,f2:0}

    d1 = await svc.open_draft(graph_id=gid, owner="alice")
    d2 = await svc.open_draft(graph_id=gid, owner="bob")                        # both based on seed
    await svc.apply_ops(graph_id=gid, branch_id=d1, actor="alice", ops=[_upd("A", f1=10, f2=99)])
    await svc.apply_ops(graph_id=gid, branch_id=d2, actor="bob", ops=[_upd("A", f1=20)])  # only f1
    await svc.publish(graph_id=gid, branch_id=d1, actor="alice", message="main sets f1+f2")  # main A{f1:10,f2:99}

    # d2 is behind → pull. f1 clashes (0/20/10); f2 auto-merges to main's 99 (d2 never touched it).
    rc = await svc.rebase_draft(graph_id=gid, branch_id=d2, actor="bob")
    assert rc["clean"] is False and rc["conflicts"][0]["entity_id"] == "A", rc
    assert rc["conflicts"][0]["path"] == ["f1"], rc                             # only f1 conflicts

    # Resolve the f1 clash to 30, with a payload that OMITS f2. f2=99 (main's non-conflicting change)
    # must survive — the resolution settles only f1.
    rc2 = await svc.rebase_draft(graph_id=gid, branch_id=d2, actor="bob",
                                 resolutions={"A": {"urn": "urn:A", "entityType": "Dataset",
                                                    "displayName": "A", "f1": 30}})
    assert rc2["clean"] is True, rc2
    v = await svc.entity_value(graph_id=gid, entity_id="A", branch_id=d2)
    assert v["f1"] == 30, v                    # resolved value
    assert v.get("f2") == 99, v                # main's non-conflicting change PRESERVED (dropped by the bug)

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres")
def test_versioning_resolution_preserves():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("resolution preserves non-conflicting fields: OK")
