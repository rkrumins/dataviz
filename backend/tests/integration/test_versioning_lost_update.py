"""Same-branch concurrent-write safety — NO silent lost update.

Reproduces the audited Finding-4 race: writer B reads entity E's state, and writer A tries to
commit a change to a DIFFERENT field of E *in between*. Without serialization B's head write then
overwrites E against pre-A state, so A's committed change is lost from the live head (it survives
only in append-only history).

We force the interleaving by wrapping `_current_values` (the writer's state read): A starts right
after B has read. B holds the draft's row lock (`_lock_branch`), so A must still be waiting after a
pause; once B commits, A runs against B's result and both edits survive (disjoint fields
auto-merge). The per-entity head CAS (`occ_guard`) stays as the backstop behind the lock.

Writes to `main` take the graph lock before reading, the same way.
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
    draft = await svc.open_draft(graph_id=gid, owner="u")

    # Force the losing interleaving: right after B's state read returns, A writes a DIFFERENT field.
    orig = svc._current_values
    race = {}

    async def racing(s, graph_id, bid, ids):
        vals = await orig(s, graph_id, bid, ids)          # B reads (still pre-A)
        if "A" not in race and "A" in list(ids):
            race["A"] = asyncio.create_task(svc.apply_ops(  # A tries to commit
                graph_id=gid, branch_id=draft, actor="u", message="A",
                ops=[_upd("A", description="ALICE")]))
            await asyncio.sleep(0.2)
            assert not race["A"].done(), "A did not wait for B's draft lock"
        return vals                                        # B proceeds; A waits for its commit

    svc._current_values = racing
    try:
        await svc.apply_ops(graph_id=gid, branch_id=draft, actor="u", message="B",
                            ops=[_upd("A", displayName="BOB")])
    finally:
        svc._current_values = orig
        await asyncio.gather(*race.values(), return_exceptions=True)
    await race["A"]

    v = await svc.entity_value(graph_id=gid, entity_id="A", branch_id=draft)
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
