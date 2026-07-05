"""Foundation for one-commit-per-save: a SINGLE apply_ops call may contain node creates AND an edge
between those freshly-created nodes — validated against the batch's own creates, not just
pre-existing state — landing as ONE commit. This is what lets a Review & Save (creates + their
containment/lineage edges) be one atomic commit instead of N.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.service import GraphVersioningService

CET = ["CONTAINS"]


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    G = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="u")
    gid = G["graph_id"]

    # ONE call: create a Layer, an Object, and the CONTAINS edge between them.
    commit = await svc.apply_ops(
        graph_id=gid, actor="u", message="Canvas edits", containment_edge_types=CET,
        ops=[
            {"op": "create", "entity_kind": "node", "entity_id": "L",
             "payload": {"urn": "urn:L", "entityType": "Layer", "displayName": "L"}},
            {"op": "create", "entity_kind": "node", "entity_id": "O",
             "payload": {"urn": "urn:O", "entityType": "Object", "displayName": "O"}},
            {"op": "create", "entity_kind": "edge", "entity_id": "e_LO",
             "payload": {"edgeType": "CONTAINS", "sourceEntityId": "L", "targetEntityId": "O"}},
        ],
    )
    assert commit is not None, "batch create+edge produced no commit"

    st = await svc.materialize_state(graph_id=gid, branch_id=await svc.main_branch_id(gid))
    assert set(st["nodes"]) >= {"L", "O"}, st["nodes"]
    edge = st.get("edges", {}).get("e_LO")
    assert edge is not None, f"edge not created: {st.get('edges')}"
    src = edge.get("sourceEntityId") or edge.get("source_entity_id")
    tgt = edge.get("targetEntityId") or edge.get("target_entity_id")
    assert src == "L" and tgt == "O", edge      # edge points at the same-batch creates

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres")
def test_versioning_batch_create_edge():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("batch create+edge in one commit: OK")
