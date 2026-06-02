"""Commit-log read (P10) — needs Postgres.

commit_log returns a graph's main-branch history newest-first, with the genesis at
the tail, parent-chain links, per-commit kind/message/actor/stats, and limit/offset
pagination.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.service import GraphVersioningService


async def _edit_publish(svc, gid, actor, ops, msg):
    d = await svc.open_draft(graph_id=gid, owner=actor)
    await svc.stage_changes(graph_id=gid, branch_id=d, actor=actor, ops=ops)
    await svc.checkpoint(graph_id=gid, branch_id=d, actor=actor)
    return await svc.publish(graph_id=gid, branch_id=d, actor=actor, message=msg)


def _n(eid, **kw):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"displayName": eid, **kw}}


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()

    P = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(),
                               workspace_id="ws1", actor="alice")     # genesis @ seq 1
    pg = P["graph_id"]
    await _edit_publish(svc, pg, "alice", [_n("A", f=1)], "add A")     # seq 2
    c3 = await _edit_publish(svc, pg, "bob", [_n("B")], "add B")       # seq 3
    await svc.revert_commit(graph_id=pg, commit_id=c3, actor="carol")  # seq 4 (revert)

    log = await svc.commit_log(graph_id=pg)
    assert [c["commit_seq"] for c in log] == [4, 3, 2, 1], log         # newest-first
    assert log[0]["kind"] == "revert" and log[0]["actor"] == "carol"
    assert log[-1]["kind"] == "genesis"
    assert {c["kind"] for c in log if c["commit_seq"] in (2, 3)} == {"squash_publish"}
    assert log[2]["message"] == "add A" and log[2]["actor"] == "alice"
    assert log[0]["parent_commit_id"] == log[1]["commit_id"]           # parent chain
    assert isinstance(log[2]["stats"], dict)                          # publish carries stats

    # pagination: limit + offset slice the same newest-first order
    assert [c["commit_seq"] for c in await svc.commit_log(graph_id=pg, limit=2)] == [4, 3]
    assert [c["commit_seq"] for c in await svc.commit_log(graph_id=pg, limit=2, offset=2)] == [2, 1]

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_commit_log_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning commit-log e2e: OK")
