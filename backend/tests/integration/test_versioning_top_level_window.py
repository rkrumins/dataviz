"""Unfiltered top-level browse must find roots regardless of sample order.

Regression (2026-07-11, live): ``top_level_from_state`` discovered a fixed
``limit*4`` candidate window in arbitrary order and pruned the contained
nodes AFTER — on a Solidatus-imported graph (10 Roots among 275 contained
Nodes) the wizard's default "All Types" browse returned ZERO rows and
rendered "the graph may be empty", while the type-filter chips worked
(their predicate narrows discovery BEFORE the sample). Discovery now grows
the window until the page fills or candidates are exhausted.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.service import GraphVersioningService

CONT = ["HAS"]


def _n(eid, name, etype):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": eid, "entityType": etype, "displayName": name}}


def _e(eid, s, t):
    return {"op": "create", "entity_kind": "edge", "entity_id": eid,
            "payload": {"edgeType": "has", "sourceEntityId": s, "targetEntityId": t}}


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    G = await svc.create_graph(
        data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="u")
    gid, main = G["graph_id"], G["main_branch_id"]

    # ONE root that sorts late among 60 contained children: with limit=5
    # the old fixed window (limit*4+1 = 21 candidates) held only contained
    # nodes and the unfiltered browse returned nothing.
    ops = [_n("zz_root", "zz_root", "Roots")]
    for i in range(60):
        cid = f"aa_child_{i:03d}"
        ops.append(_n(cid, cid, "Node"))
        ops.append(_e(f"e_{i:03d}", "zz_root" if i == 0 else f"aa_child_{i-1:03d}", cid))
    await svc.apply_ops(graph_id=gid, actor="u", message="seed",
                        containment_edge_types=CONT, ops=ops)

    tl = await svc.top_level_from_state(
        graph_id=gid, branch_id=main, containment_edge_types=CONT,
        root_entity_types=["Roots"], limit=5)
    names = [n["displayName"] for n in tl["nodes"]]
    assert names == ["zz_root"], (
        f"unfiltered top-level browse missed the root: {names} "
        f"(total={tl['totalCount']})"
    )
    assert tl["totalCount"] == 1
    assert tl["rootTypeCount"] == 1 and tl["orphanCount"] == 0
    # Case-fold parity: containment declared HAS, stored has — the
    # classification is case-insensitive.
    assert tl["nodes"][0]["childCount"] == 1
    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_top_level_window_growth_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("top-level window growth e2e: OK")
