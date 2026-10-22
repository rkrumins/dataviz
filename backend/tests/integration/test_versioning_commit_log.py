"""Commit-log read (P10) — needs Postgres.

commit_log returns a graph's main-branch history newest-first, with the genesis at
the tail, parent-chain links, per-commit kind/message/actor/stats, limit/offset
pagination, exclusive ``commit_seq`` bounds that page without skips or repeats, and
nothing above main's head.
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
            "payload": {"entityType": "Dataset", "displayName": eid, **kw}}


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

    # sequence bounds: exclusive, newest first, and they combine into a window
    def seqs(commits):
        return [c["commit_seq"] for c in commits]

    assert seqs(await svc.commit_log(graph_id=pg, after=2)) == [4, 3]
    assert seqs(await svc.commit_log(graph_id=pg, before=3)) == [2, 1]
    assert seqs(await svc.commit_log(graph_id=pg, before=4, after=1)) == [3, 2]
    assert await svc.commit_log_page(graph_id=pg, limit=2) == (log[:2], True)
    assert (await svc.commit_log_page(graph_id=pg, limit=2, before=3))[1] is False

    # a walk by `before` neither skips nor repeats while commits land between its pages
    first, more = await svc.commit_log_page(graph_id=pg, limit=2)
    await _edit_publish(svc, pg, "alice", [_n("C")], "add C")          # seq 5, mid-walk
    rest, more = await svc.commit_log_page(graph_id=pg, limit=2, before=first[-1]["commit_seq"])
    assert seqs(first + rest) == [4, 3, 2, 1] and more is False
    assert seqs(await svc.commit_log(graph_id=pg, after=4)) == [5]      # what's new since

    # main's log stops at its head: a commit written above it (enabling version control writes
    # its import before the head moves to it) doesn't show until the head reaches it
    main = await svc.main_branch_id(pg)
    async with db.graphver_session() as s:
        s.add(models.CommitORM(graph_id=pg, id="cmt_not_landed", branch_id=main, commit_seq=6,
                               parent_commit_id=log[0]["commit_id"], kind="import", actor="system"))
    assert (await svc.commit_log(graph_id=pg, limit=1))[0]["commit_seq"] == 5
    assert (await svc.commit_log(graph_id=pg, branch_id=main, limit=1))[0]["commit_seq"] == 5
    assert await svc.commit_log(graph_id=pg, after=5) == []
    async with db.graphver_session() as s:
        (await s.get(models.GraphORM, pg)).main_head_commit_seq = 6
    assert (await svc.commit_log(graph_id=pg, limit=1))[0]["commit_id"] == "cmt_not_landed"

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_commit_log_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning commit-log e2e: OK")
