"""Same-branch concurrent-write safety — NO silent lost update (per-entity head CAS / Git-model OCC).

Reproduces the audited Finding-4 race deterministically: writer B reads entity E's state, writer A
commits a change to a DIFFERENT field of E *in between*, then B writes. Without a head-level
compare-and-swap the head upsert blindly overwrites E against pre-A state, so A's committed change is
lost from the live head (it survives only in append-only history). With per-entity head OCC, B's
stale head write is a CAS miss → `_retry_seq` re-runs against fresh state → both edits survive
(disjoint fields auto-merge; the same field would raise MergeConflict).

We force the exact interleaving by wrapping `_current_values` (the writer's state read) so that A
commits immediately after B has read — no timing luck, so this is a reliable RED→GREEN test.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.service import GraphVersioningService


def _node(eid, **p):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": f"urn:{eid}", "entityType": "Table", **p}}


def _upd(eid, **fields):
    return {"op": "update", "entity_kind": "node", "entity_id": eid, "payload": fields}


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    G = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="u")
    gid = G["graph_id"]
    await svc.apply_ops(graph_id=gid, actor="u", message="seed",
                        ops=[_node("A", displayName="v0", description="d0")])

    # Force the losing interleaving: right after B's state read returns, A commits a DIFFERENT field.
    orig = svc._current_values
    fired = {}

    async def racing(s, graph_id, bid, ids):
        vals = await orig(s, graph_id, bid, ids)          # B reads (still pre-A)
        if not fired.get("x") and "A" in list(ids):
            fired["x"] = True
            await svc.apply_ops(graph_id=gid, actor="alice", message="A",  # A commits, own txn
                                ops=[_upd("A", description="ALICE")])
        return vals                                        # B proceeds against STALE state

    svc._current_values = racing
    try:
        await svc.apply_ops(graph_id=gid, actor="bob", message="B", ops=[_upd("A", displayName="BOB")])
    finally:
        svc._current_values = orig

    v = await svc.entity_value(graph_id=gid, entity_id="A")
    assert v is not None, "entity A vanished"
    assert v.get("displayName") == "BOB", v                # B's change
    assert v.get("description") == "ALICE", v              # A's change — LOST from head without the CAS

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres")
def test_versioning_lost_update():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("same-branch lost-update guard: OK")
