"""Cross-branch colliding PROPERTY edits surface a conflict — and a newly-added property survives.

Reported scenario: two branches edit the same entity's properties at the same time — one changes a
shared property, one changes it differently AND adds a new one — and it "never got prompted for
conflict resolution." This proves (a) the colliding property raises a conflict at pull (rebase) time
rather than silently overwriting, and (b) resolving that conflict preserves the newly-added property
(the per-field resolution overlay, not a whole-entity replace).
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

    d0 = await svc.open_draft(graph_id=gid, owner="u")
    await svc.apply_ops(graph_id=gid, branch_id=d0, actor="u", ops=[_node("E", {"P1": "base"})])
    await svc.publish(graph_id=gid, branch_id=d0, actor="u", message="seed")     # main: E{P1:base}

    d1 = await svc.open_draft(graph_id=gid, owner="alice")
    d2 = await svc.open_draft(graph_id=gid, owner="bob")                          # both based on seed
    await svc.apply_ops(graph_id=gid, branch_id=d1, actor="alice", ops=[_upd("E", {"P1": "A"})])
    await svc.apply_ops(graph_id=gid, branch_id=d2, actor="bob",
                        ops=[_upd("E", {"P1": "B", "P2": "new"})])                # collide P1, add P2
    await svc.publish(graph_id=gid, branch_id=d1, actor="alice", message="alice P1")  # main: E{P1:A}

    # d2 behind → pull. P1 collides (base/B/A) → CONFLICT surfaced; P2 (new) auto-merges.
    rc = await svc.rebase_draft(graph_id=gid, branch_id=d2, actor="bob")
    assert rc["clean"] is False, rc
    paths = [c["path"] for c in rc["conflicts"] if c["entity_id"] == "E"]
    assert ["properties", "P1"] in paths or ["properties"] in paths, paths   # the collision IS prompted

    # Resolve P1; the resolution payload carries only P1 — P2 (the new property) must survive.
    rc2 = await svc.rebase_draft(
        graph_id=gid, branch_id=d2, actor="bob",
        resolutions={"E": {"urn": "urn:E", "entityType": "Dataset", "displayName": "E",
                           "properties": {"P1": "resolved"}}})
    assert rc2["clean"] is True, rc2
    v = await svc.entity_value(graph_id=gid, entity_id="E", branch_id=d2)
    props = v.get("properties") or {}
    assert props.get("P1") == "resolved", props        # resolved value
    assert props.get("P2") == "new", props             # newly-added property PRESERVED

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres")
def test_versioning_property_conflict():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("cross-branch property conflict surfaces + preserves new prop: OK")
