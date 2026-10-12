"""A draft too large to lay out as a change tree is counted, not listed.

The Changes panel's tree nests every changed entity under its containers, built from every changed
payload plus their ancestors — for a bulk change of 100k entities, a gigabyte in the web process to
draw a panel nobody could scroll. Past ``DIFF_TREE_MAX_CHANGES`` the summary answers counts and
per-type impact from the narrow change index, says so (``tooLarge``), and has no children to page.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import config, db, models
from backend.app.services.versioning.service import DiffTooLarge, GraphVersioningService

CONT = ["CONTAINS"]


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                                  actor="alice"))["graph_id"]
    await svc.bulk_ingest(graph_id=gid, actor="alice", rows=[
        {"kind": "node", "entity_id": "D", "urn": "urn:D", "entityType": "Dataset", "displayName": "D"},
        *({"kind": "node", "entity_id": k, "urn": f"urn:{k}", "entityType": "SchemaField",
           "displayName": k, "properties": {"v": 1}} for k in ("F1", "F2", "F3", "F4")),
        {"kind": "edge", "entity_id": "C1", "edgeType": "CONTAINS", "source": "urn:D", "target": "urn:F1"},
        {"kind": "edge", "entity_id": "L1", "edgeType": "TRANSFORMS", "source": "urn:F1", "target": "urn:F2"},
    ])
    d = await svc.open_draft(graph_id=gid, owner="alice")

    def upd(eid, kind="node", **payload):
        return {"op": "update", "entity_kind": kind, "entity_id": eid, "payload": payload}

    await svc.apply_ops(graph_id=gid, branch_id=d, actor="alice", containment_edge_types=CONT, ops=[
        upd("F1", properties={"v": 2}), upd("F2", properties={"v": 2}), upd("F3", properties={"v": 2}),
        {"op": "create", "entity_kind": "node", "entity_id": "N", "payload": {
            "urn": "urn:N", "entityType": "Dataset", "displayName": "N"}},
        {"op": "delete", "entity_kind": "node", "entity_id": "F4", "payload": None},
        upd("L1", kind="edge", properties={"w": 1}),
    ])

    small = await svc.diff_branch_summary(graph_id=gid, branch_id=d, containment_edge_types=CONT)
    assert small["groups"] and "tooLarge" not in small, "a draft the tree can list is listed"

    limit = config.DIFF_TREE_MAX_CHANGES
    config.DIFF_TREE_MAX_CHANGES = 3
    try:
        big = await svc.diff_branch_summary(graph_id=gid, branch_id=d, containment_edge_types=CONT)
        assert big["tooLarge"] == {"changed": 6, "limit": 3}, big
        assert big["groups"] == [] and big["groupTotal"] == 0
        # The same tally the tree gives, from the narrow index.
        assert big["counts"] == small["counts"] == {"added": 1, "modified": 4, "removed": 1}, (big, small)
        assert big["entityCounts"] == small["entityCounts"], (big, small)
        assert big["edgeCounts"] == small["edgeCounts"] == {"added": 0, "modified": 1, "removed": 0}
        assert big["impact"] == {"SchemaField": 4, "Dataset": 1}, big
        with pytest.raises(DiffTooLarge):
            await svc.diff_branch_children(graph_id=gid, branch_id=d, container_key="urn:D",
                                           containment_edge_types=CONT)
    finally:
        config.DIFF_TREE_MAX_CHANGES = limit
    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_a_draft_too_large_for_the_tree_is_counted_not_listed():
    asyncio.run(_run())
