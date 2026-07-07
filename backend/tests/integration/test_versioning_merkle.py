"""Persisted CoW Merkle (P3b) — needs Postgres.

A non-fork main's merkle root is now built incrementally and persisted CoW. We
verify: the persisted root at each commit equals a full rebuild (correctness);
each commit writes only changed-path rows (not the whole tree); merkle_diff(M,N)
equals the O(changed) range-scan set; and the root detects tampering.
"""
import asyncio
import os

import pytest
from sqlalchemy import func, select, text

from backend.app.services.versioning import db, models
from backend.app.services.versioning.merkle import MerkleTree, content_hash
from backend.app.services.versioning.models import MerkleNodeORM
from backend.app.services.versioning.service import GraphVersioningService


def _node(name, etype="Dataset"):
    return {"displayName": name, "entityType": etype}


async def _publish(svc, gid, ops, msg):
    d = await svc.open_draft(graph_id=gid, owner="a")
    await svc.stage_changes(graph_id=gid, branch_id=d, actor="a", ops=ops)
    await svc.checkpoint(graph_id=gid, branch_id=d, actor="a")
    await svc.publish(graph_id=gid, branch_id=d, actor="a", message=msg)


async def _live_hashes(svc, gid, mid, seq):
    async with db.graphver_session() as s:
        st = await svc._state_as_of(s, gid, mid, seq)
    return {eid: content_hash(p) for eid, p in st.items() if p is not None}


async def _rows_at(gid, seq) -> int:
    async with db.graphver_session() as s:
        return (await s.execute(select(func.count()).select_from(MerkleNodeORM).where(
            MerkleNodeORM.graph_id == gid, MerkleNodeORM.commit_seq == seq))).scalar_one()


async def _run() -> None:
    # recreate merkle_nodes so the new branch_id/commit_seq/bucket columns exist
    await models.create_schema_and_partitions()
    async with db.graphver_session() as s:
        await s.execute(text('DROP TABLE IF EXISTS graphver.merkle_nodes CASCADE'))
    await models.create_schema_and_partitions()

    svc = GraphVersioningService()
    gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="a"))["graph_id"]
    mid = await svc.main_branch_id(gid)

    await _publish(svc, gid, [
        {"op": "create", "entity_kind": "node", "entity_id": "A", "payload": _node("Alpha")},
        {"op": "create", "entity_kind": "node", "entity_id": "B", "payload": _node("Beta")},
        {"op": "create", "entity_kind": "edge", "entity_id": "E1", "payload": {"edgeType": "R", "sourceEntityId": "A", "targetEntityId": "B"}},
    ], "c2")
    await _publish(svc, gid, [
        {"op": "update", "entity_kind": "node", "entity_id": "A", "payload": _node("Alpha2")},
        {"op": "create", "entity_kind": "node", "entity_id": "C", "payload": _node("Gamma")},
    ], "c3")
    await _publish(svc, gid, [
        {"op": "delete", "entity_kind": "edge", "entity_id": "E1", "payload": None},
        {"op": "delete", "entity_kind": "node", "entity_id": "B", "payload": None},
    ], "c4")

    # ── persisted root == full rebuild, at every commit ──────────────────
    async with db.graphver_session() as s:
        for seq in (2, 3, 4):
            live = await _live_hashes(svc, gid, mid, seq)
            persisted = await svc._merkle.root_at(s, gid, mid, seq)
            assert persisted == MerkleTree.build(live).root, f"seq {seq}: incremental != full build"
            assert await svc._merkle.verify(s, gid, mid, seq, live) is True

    # ── each commit writes only changed-path rows (not the whole tree) ───
    assert 0 < await _rows_at(gid, 3) < 32, await _rows_at(gid, 3)     # changed {A,C}, not 65536 buckets

    # ── merkle_diff == O(changed) range-scan set ─────────────────────────
    async with db.graphver_session() as s:
        d23 = set(await svc._merkle.diff(s, gid, mid, 2, 3))
        rng23 = await svc._changed_in_window(s, gid, mid, 2, 3)
        assert d23 == rng23 == {"A", "C"}, (d23, rng23)
        d24 = set(await svc._merkle.diff(s, gid, mid, 2, 4))
        assert d24 == {"A", "B", "C", "E1"}, d24      # A updated, B+E1 deleted, C added

    # ── tamper detection: root must not match an altered live set ────────
    async with db.graphver_session() as s:
        good = await _live_hashes(svc, gid, mid, 4)
        tampered = dict(good)
        tampered["B"] = content_hash(_node("Beta"))   # pretend B is still live
        assert await svc._merkle.verify(s, gid, mid, 4, tampered) is False

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_merkle_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning persisted CoW Merkle e2e: OK")
