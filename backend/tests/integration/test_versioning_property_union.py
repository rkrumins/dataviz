"""Property-level UNION across branches — non-overlapping property edits all merge; only a property
changed on BOTH sides is a conflict.

The exact scenario asked about: one branch ADDS properties A + B; the other branch (already on main)
UPDATES property C, ADDS property D, and DELETES property E. None of these touch the same property,
so the 3-way merge unions them ALL with ZERO conflicts — the merged entity ends up with A, B, the
updated C, D, and E removed. (A property changed differently on both sides would be the only clash.)
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.service import GraphVersioningService


def _node(eid, props):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": f"urn:{eid}", "entityType": "Dataset", "displayName": eid, "properties": props}}


def _upd(eid, props):
    return {"op": "update", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": f"urn:{eid}", "entityType": "Dataset", "displayName": eid, "properties": props}}


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    G = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="u")
    gid = G["graph_id"]

    # base: E has properties C and E.
    d0 = await svc.open_draft(graph_id=gid, owner="u")
    await svc.apply_ops(graph_id=gid, branch_id=d0, actor="u", ops=[_node("N", {"C": "c0", "E": "e0"})])
    await svc.publish(graph_id=gid, branch_id=d0, actor="u", message="seed")   # main: N{C:c0,E:e0}

    d1 = await svc.open_draft(graph_id=gid, owner="alice")   # ADDS A + B
    d2 = await svc.open_draft(graph_id=gid, owner="bob")     # UPDATES C, ADDS D, DELETES E
    await svc.apply_ops(graph_id=gid, branch_id=d1, actor="alice",
                        ops=[_upd("N", {"A": "a", "B": "b", "C": "c0", "E": "e0"})])
    # C updated, D added, E DELETED (explicit sentinel — omission alone would NOT delete it).
    await svc.apply_ops(graph_id=gid, branch_id=d2, actor="bob",
                        ops=[_upd("N", {"C": "c-new", "D": "d", "E": "__nx_prop_delete__"})])
    await svc.publish(graph_id=gid, branch_id=d2, actor="bob", message="bob: C/D/E")  # main takes bob's

    # d1 pulls: disjoint properties → CLEAN union, no conflicts.
    rc = await svc.rebase_draft(graph_id=gid, branch_id=d1, actor="alice")
    assert rc["clean"] is True, rc                            # <-- union, not a clash

    v = await svc.entity_value(graph_id=gid, entity_id="N", branch_id=d1)
    props = v.get("properties") or {}
    assert props.get("A") == "a", props        # alice's add survives
    assert props.get("B") == "b", props        # alice's add survives
    assert props.get("C") == "c-new", props    # bob's update survives
    assert props.get("D") == "d", props        # bob's add survives
    assert "E" not in props, props             # bob's delete survives
    assert set(props) == {"A", "B", "C", "D"}, props

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres")
def test_versioning_property_union():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("property union (A+B / C-upd+D-add+E-del) merges clean: OK")
