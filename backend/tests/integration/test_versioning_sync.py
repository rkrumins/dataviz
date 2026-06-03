"""Authoritative re-sync as commits (unification Phase 4) — needs Postgres.

A re-sync merges an external snapshot into main without clobbering user edits: a user's
edit to a field the external source didn't touch survives while the external change to a
different field applies (matched in place, no duplicates); a field both sides changed
conflicts under strategy='merge' or takes the external value under 'external_wins'; and
re-running an idempotencyKey replays. The change lands as a single 'sync' commit.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.service import GraphVersioningService, MergeConflict


def _node(urn, **kw):
    return {"kind": "node", "urn": urn, "entityType": "Dataset", **kw}


_EDGE = {"kind": "edge", "edgeType": "FLOWS_TO", "source": "u:A", "target": "u:B"}


async def _user_set(svc, gid, eid, payload, actor="user"):
    d = await svc.open_draft(graph_id=gid, owner=actor)
    await svc.stage_changes(graph_id=gid, branch_id=d, actor=actor, ops=[
        {"op": "update", "entity_kind": "node", "entity_id": eid, "payload": payload}])
    await svc.checkpoint(graph_id=gid, branch_id=d, actor=actor)
    await svc.publish(graph_id=gid, branch_id=d, actor=actor, message="user edit")


def _eid_of(state, urn):
    return next(eid for eid, p in state["nodes"].items() if p.get("urn") == urn)


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    G = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="ext")
    gid, main = G["graph_id"], G["main_branch_id"]

    # ── day-0 import: A(owner team1), B, A->B ──
    imp = await svc.bulk_ingest(graph_id=gid, rows=[
        _node("u:A", displayName="A", owner="team1"), _node("u:B", displayName="B"), _EDGE,
    ], actor="ext", idempotency_key="imp1")
    assert imp["commit_id"]
    st = await svc.materialize_state(graph_id=gid, branch_id=main)
    eidA = _eid_of(st, "u:A")
    assert st["nodes"][eidA]["owner"] == "team1"

    # ── user edits A.displayName (keeps owner) ──
    await _user_set(svc, gid, eidA, {**st["nodes"][eidA], "displayName": "A-edited"})

    # ── sync 1: external changes A.owner -> team2 (displayName untouched) → both survive ──
    r1 = await svc.sync_ingest(graph_id=gid, rows=[
        _node("u:A", displayName="A", owner="team2"), _node("u:B", displayName="B"), _EDGE,
    ], actor="ext", idempotency_key="sync1", strategy="merge")
    assert r1["commit_id"]
    st = await svc.materialize_state(graph_id=gid, branch_id=main)
    a = st["nodes"][eidA]
    assert a["displayName"] == "A-edited" and a["owner"] == "team2"     # user edit kept + external applied
    assert len([p for p in st["nodes"].values() if p.get("urn") == "u:A"]) == 1   # matched in place
    assert len(st["edges"]) == 1                                        # edge not duplicated

    # ── user re-edits A.displayName; external also changes it → conflict ──
    await _user_set(svc, gid, eidA, {**st["nodes"][eidA], "displayName": "A-user2"})
    clash = [_node("u:A", displayName="A-ext", owner="team2"), _node("u:B", displayName="B"), _EDGE]
    with pytest.raises(MergeConflict):
        await svc.sync_ingest(graph_id=gid, rows=clash, actor="ext", strategy="merge")
    # external_wins resolves the clash in the external source's favour
    r2 = await svc.sync_ingest(graph_id=gid, rows=clash, actor="ext",
                               idempotency_key="sync2", strategy="external_wins")
    assert r2["commit_id"]
    assert (await svc.materialize_state(graph_id=gid, branch_id=main))["nodes"][eidA]["displayName"] == "A-ext"

    # ── idempotency: re-running sync2 replays, no new commit ──
    head = (await svc.get_graph(gid))["main_head_commit_seq"]
    r2b = await svc.sync_ingest(graph_id=gid, rows=clash, actor="ext",
                                idempotency_key="sync2", strategy="external_wins")
    assert r2b["idempotent_replay"] is True and r2b["commit_id"] == r2["commit_id"]
    assert (await svc.get_graph(gid))["main_head_commit_seq"] == head

    # ── each sync landed as a single 'sync' commit ──
    assert sum(1 for c in await svc.commit_log(graph_id=gid, limit=50) if c["kind"] == "sync") == 2

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_sync_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning authoritative re-sync e2e: OK")
