"""The draft bar's diff names what changed without shipping every changed payload.

The canvas versioning bar loads a draft's diff whenever a draft is open, to count its changes and
ring changed nodes. The full diff carries each modified entity's whole before and after payloads —
for a bulk change of 100k entities that is hundreds of megabytes built in the web process for a
count. ``payloads="changes"`` answers the same classification from content hashes: modified
entities by id alone, and added/removed ones still with the payload the canvas draws them from
(a draft-created node, a deletion ghost).
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.service import GraphVersioningService


def _by_id(entries):
    return {e["entityId"]: e for e in entries}


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                                  actor="alice"))["graph_id"]
    await svc.bulk_ingest(graph_id=gid, actor="alice", rows=[
        *({"kind": "node", "entity_id": k, "urn": f"urn:{k}", "entityType": "Dataset",
           "displayName": k, "properties": {"v": 1}} for k in ("A", "B", "C", "D")),
        {"kind": "edge", "entity_id": "E1", "edgeType": "FLOWS_TO", "source": "urn:A", "target": "urn:B"},
    ])
    d = await svc.open_draft(graph_id=gid, owner="alice")

    def upd(eid, kind="node", **payload):
        return {"op": "update", "entity_kind": kind, "entity_id": eid, "payload": payload}

    await svc.apply_ops(graph_id=gid, branch_id=d, actor="alice", ops=[
        {"op": "create", "entity_kind": "node", "entity_id": "N", "payload": {
            "urn": "urn:N", "entityType": "Dataset", "displayName": "N"}},
        upd("A", properties={"v": 2}),
        {"op": "delete", "entity_kind": "node", "entity_id": "C", "payload": None},
        upd("D", properties={"v": 9}),
        upd("E1", kind="edge", properties={"w": 2}),
    ])
    await svc.apply_ops(graph_id=gid, branch_id=d, actor="alice", ops=[upd("D", properties={"v": 1})])

    full = await svc.diff_branch_vs_base(graph_id=gid, branch_id=d)
    slim = await svc.diff_branch_vs_base(graph_id=gid, branch_id=d, payloads="changes")

    for bucket in ("added", "removed", "modified"):
        assert set(_by_id(slim[bucket])) == set(_by_id(full[bucket])), bucket
    assert set(_by_id(slim["added"])) == {"N"}
    assert set(_by_id(slim["removed"])) == {"C"}
    assert set(_by_id(slim["modified"])) == {"A", "E1"}, "D was changed and changed back"

    assert _by_id(slim["added"]) == _by_id(full["added"]), "a draft-created node keeps its payload"
    assert _by_id(slim["removed"]) == _by_id(full["removed"]), "a deletion ghost keeps its payload"
    assert _by_id(slim["modified"]) == {"A": {"entityId": "A", "kind": "node"},
                                        "E1": {"entityId": "E1", "kind": "edge"}}
    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_the_slim_diff_classifies_like_the_full_one_without_modified_payloads():
    asyncio.run(_run())
