"""Multi-user "no silent override" — optimistic concurrency + auto-rebase (needs Postgres).

Proves both collaboration shapes are override-safe:
  * SAME branch via apply_ops (the canvas save path) — a `base_version` (the content-hash the client
    read) makes a concurrent SAME-field edit raise MergeConflict; DIFFERENT fields still auto-merge;
    no token ⇒ plain patch (backward-compat). The token round-trips through the real reader.
  * SAME branch via stage→checkpoint on a SHARED draft — a stale single-actor checkpoint (head moved
    since staging, e.g. a concurrent apply_ops) conflicts instead of silently overwriting.
  * INDEPENDENT branches — concurrent merges both land (the stale one auto-rebases when clean); a
    genuine same-field clash raises MergeConflict; concurrent rebases are crash-free.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.service import (
    GraphVersioningService, MergeConflict, NotUpToDate, ConcurrencyError,
)


def _node(urn, **extra):
    return {"op": "create", "entity_kind": "node", "entity_id": urn,
            "payload": {"urn": urn, "entityType": "dataset", "displayName": urn[-6:], **extra}}


def _upd(urn, **fields):
    return {"op": "update", "entity_kind": "node", "entity_id": urn, "payload": fields}


async def _head_hash(svc, gid, bid, eid):
    async with db.graphver_session() as s:
        return await svc._effective_head_hash(s, gid, bid, eid)


async def _new_graph(svc, ws="ws_occ"):
    g = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id=ws, actor="bot")
    return g["graph_id"], g["main_branch_id"]


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()

    # ── S1: concurrent apply_ops, SAME field, one draft → exactly one wins + one MergeConflict ──
    gid, _ = await _new_graph(svc)
    d = await svc.open_draft(graph_id=gid, owner="bot")
    A = "urn:li:dataset:s1_" + os.urandom(3).hex()
    await svc.apply_ops(graph_id=gid, branch_id=d, actor="bot", ops=[_node(A, displayName="v0")])
    tok = await _head_hash(svc, gid, d, A)
    res = await asyncio.gather(
        svc.apply_ops(graph_id=gid, branch_id=d, actor="alice",
                      ops=[{**_upd(A, displayName="alice"), "base_version": tok}]),
        svc.apply_ops(graph_id=gid, branch_id=d, actor="bob",
                      ops=[{**_upd(A, displayName="bob"), "base_version": tok}]),
        return_exceptions=True)
    assert sum(isinstance(r, MergeConflict) for r in res) == 1, res
    assert sum(not isinstance(r, Exception) for r in res) == 1, res

    # ── S2: concurrent apply_ops, DISJOINT fields → both survive (auto-merge) ──
    gid, _ = await _new_graph(svc)
    d = await svc.open_draft(graph_id=gid, owner="bot")
    A = "urn:li:dataset:s2_" + os.urandom(3).hex()
    await svc.apply_ops(graph_id=gid, branch_id=d, actor="bot",
                        ops=[_node(A, displayName="v0", description="d0")])
    tok = await _head_hash(svc, gid, d, A)
    await asyncio.gather(
        svc.apply_ops(graph_id=gid, branch_id=d, actor="alice",
                      ops=[{**_upd(A, displayName="alice"), "base_version": tok}]),
        svc.apply_ops(graph_id=gid, branch_id=d, actor="bob",
                      ops=[{**_upd(A, description="bob"), "base_version": tok}]))
    v = await svc.entity_value(graph_id=gid, entity_id=A, branch_id=d)
    assert v["displayName"] == "alice" and v["description"] == "bob", v

    # ── S3: no token → plain patch applies (backward-compat) ──
    gid, _ = await _new_graph(svc)
    d = await svc.open_draft(graph_id=gid, owner="bot")
    A = "urn:li:dataset:s3_" + os.urandom(3).hex()
    await svc.apply_ops(graph_id=gid, branch_id=d, actor="bot", ops=[_node(A, displayName="v0")])
    await svc.apply_ops(graph_id=gid, branch_id=d, actor="bot", ops=[_upd(A, displayName="v1")])
    assert (await svc.entity_value(graph_id=gid, entity_id=A, branch_id=d))["displayName"] == "v1"

    # ── S3b: the OCC token round-trips through the real reader ──
    node = await svc.get_node_from_state(graph_id=gid, branch_id=d, as_of_seq=None, urn=A,
                                         containment_edge_types=[])
    assert node and node.get("version"), node
    res = await asyncio.gather(
        svc.apply_ops(graph_id=gid, branch_id=d, actor="x",
                      ops=[{**_upd(A, displayName="x"), "base_version": node["version"]}]),
        svc.apply_ops(graph_id=gid, branch_id=d, actor="y",
                      ops=[{**_upd(A, displayName="y"), "base_version": node["version"]}]),
        return_exceptions=True)
    assert sum(isinstance(r, MergeConflict) for r in res) == 1, res

    # ── S4: cross-checkpoint stale on a SHARED draft → MergeConflict (no silent overwrite) ──
    gid, _ = await _new_graph(svc)
    d = await svc.open_draft(graph_id=gid, owner="bob", shared=True)
    await svc.add_branch_member(graph_id=gid, branch_id=d, subject_type="user",
                                subject_id="carol", role="editor", actor="bob")
    A = "urn:li:dataset:s4_" + os.urandom(3).hex()
    await svc.apply_ops(graph_id=gid, branch_id=d, actor="bob", ops=[_node(A, x=0)])
    await svc.stage_changes(graph_id=gid, branch_id=d, actor="bob", ops=[_upd(A, x=9)])
    await svc.apply_ops(graph_id=gid, branch_id=d, actor="carol", ops=[_upd(A, x=7)])  # head moves
    with pytest.raises(MergeConflict):
        await svc.checkpoint(graph_id=gid, branch_id=d, actor="bob")

    # ── S5/S6: concurrent + sequential independent merges both land (auto-rebase when clean) ──
    gid, main = await _new_graph(svc)
    A = "urn:li:dataset:s5A_" + os.urandom(3).hex()
    B = "urn:li:dataset:s5B_" + os.urandom(3).hex()
    d0 = await svc.open_draft(graph_id=gid, owner="bot")
    await svc.apply_ops(graph_id=gid, branch_id=d0, actor="bot", ops=[_node(A), _node(B)])
    await svc.publish(graph_id=gid, branch_id=d0, actor="bot", message="seed")
    dA = await svc.open_draft(graph_id=gid, owner="bot")
    dB = await svc.open_draft(graph_id=gid, owner="bot")
    await svc.apply_ops(graph_id=gid, branch_id=dA, actor="bot", ops=[_upd(A, displayName="A2")])
    await svc.apply_ops(graph_id=gid, branch_id=dB, actor="bot", ops=[_upd(B, displayName="B2")])
    await svc.publish(graph_id=gid, branch_id=dA, actor="bot", message="A")     # main advances
    await svc.publish(graph_id=gid, branch_id=dB, actor="bot", message="B")     # stale + clean → auto-rebase
    st = await svc.materialize_state(graph_id=gid, branch_id=main)
    assert st["nodes"][A]["displayName"] == "A2" and st["nodes"][B]["displayName"] == "B2"

    # ── S7: auto-rebase blocked on a real same-field clash → MergeConflict ──
    gid, main = await _new_graph(svc)
    A = "urn:li:dataset:s7_" + os.urandom(3).hex()
    d0 = await svc.open_draft(graph_id=gid, owner="bot")
    await svc.apply_ops(graph_id=gid, branch_id=d0, actor="bot", ops=[_node(A, f=0)])
    await svc.publish(graph_id=gid, branch_id=d0, actor="bot", message="seed")
    dA = await svc.open_draft(graph_id=gid, owner="bot")
    dB = await svc.open_draft(graph_id=gid, owner="bot")
    await svc.apply_ops(graph_id=gid, branch_id=dA, actor="bot", ops=[_upd(A, f=10)])
    await svc.apply_ops(graph_id=gid, branch_id=dB, actor="bot", ops=[_upd(A, f=20)])
    await svc.publish(graph_id=gid, branch_id=dA, actor="bot", message="A")
    with pytest.raises((MergeConflict, NotUpToDate)):
        await svc.publish(graph_id=gid, branch_id=dB, actor="bot", message="B")

    # ── S8: concurrent rebases of one draft → crash-free ──
    gid, _ = await _new_graph(svc)
    A = "urn:li:dataset:s8A_" + os.urandom(3).hex()
    B = "urn:li:dataset:s8B_" + os.urandom(3).hex()
    d0 = await svc.open_draft(graph_id=gid, owner="bot")
    await svc.apply_ops(graph_id=gid, branch_id=d0, actor="bot", ops=[_node(A), _node(B)])
    await svc.publish(graph_id=gid, branch_id=d0, actor="bot", message="seed")
    d = await svc.open_draft(graph_id=gid, owner="bot")
    await svc.apply_ops(graph_id=gid, branch_id=d, actor="bot", ops=[_upd(A, displayName="A2")])
    dx = await svc.open_draft(graph_id=gid, owner="bot")
    await svc.apply_ops(graph_id=gid, branch_id=dx, actor="bot", ops=[_upd(B, displayName="B2")])
    await svc.publish(graph_id=gid, branch_id=dx, actor="bot", message="advance")
    res = await asyncio.gather(
        svc.rebase_draft(graph_id=gid, branch_id=d, actor="bot"),
        svc.rebase_draft(graph_id=gid, branch_id=d, actor="bot"),
        return_exceptions=True)
    for r in res:
        assert not isinstance(r, Exception) or isinstance(r, (ConcurrencyError, MergeConflict)), r

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_occ_concurrency_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning OCC + auto-rebase concurrency e2e: OK")
