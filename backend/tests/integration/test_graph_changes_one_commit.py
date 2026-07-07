"""One Review & Save = ONE commit. The /graph/changes op-resolver turns a batch of canvas edits —
creates + the edges/updates/layer-moves that reference those fresh nodes by a temp `ref` — into a
single apply_ops op list; feeding it to apply_ops lands exactly ONE commit (not one per entity).
Covers the two things that make this safe: temp-ref resolution and same-batch edge validation.
"""
import asyncio
import os
from types import SimpleNamespace

import pytest
from sqlalchemy import func, select

from backend.app.api.v1.endpoints.graph import _resolve_change_ops
from backend.app.ontology.urn import make_urn
from backend.app.services.versioning import db, models
from backend.app.services.versioning.ids import prefixed_id
from backend.app.services.versioning.models import BranchORM, CommitORM
from backend.app.services.versioning.service import GraphVersioningService


def _op(op, kind, id=None, ref=None, payload=None, base_version=None):
    return SimpleNamespace(op=op, kind=kind, id=id, ref=ref, payload=payload, base_version=base_version)


async def _count_commits(gid, bid):
    async with db.graphver_session() as s:
        return (await s.execute(select(func.count()).select_from(CommitORM).where(
            CommitORM.graph_id == gid, CommitORM.branch_id == bid))).scalar()


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    G = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="u")
    gid = G["graph_id"]
    async with db.graphver_session() as s:
        main_id = (await s.execute(select(BranchORM.id).where(
            BranchORM.graph_id == gid, BranchORM.kind == "main"))).scalar_one()

    # A batch exactly as the collapsed frontend save would send it: two creates by temp ref, a
    # CONTAINS edge between them (by ref), and a layer update on the fresh Object (by ref).
    request_ops = [
        _op("create", "node", ref="tmp:L", payload={"urn": "urn:L", "entityType": "Layer", "displayName": "L"}),
        _op("create", "node", ref="tmp:O", payload={"urn": "urn:O", "entityType": "Object", "displayName": "O"}),
        _op("create", "edge", ref="tmp:e",
            payload={"edgeType": "CONTAINS", "sourceEntityId": "tmp:L", "targetEntityId": "tmp:O"}),
        _op("update", "node", id="tmp:O", payload={"layerAssignment": "blank-layer-1"}),
    ]
    ops, assigned = _resolve_change_ops(request_ops, prefixed_id, make_urn)

    # temp refs resolved to real, minted ids
    L, O = assigned["tmp:L"], assigned["tmp:O"]
    assert L and O and L != "tmp:L" and O != "tmp:O", assigned
    edge_op = next(o for o in ops if o["entity_kind"] == "edge")
    assert edge_op["payload"]["sourceEntityId"] == L and edge_op["payload"]["targetEntityId"] == O, edge_op
    upd_op = next(o for o in ops if o["op"] == "update")
    assert upd_op["entity_id"] == O, upd_op                          # update's temp id resolved

    before = await _count_commits(gid, main_id)
    commit = await svc.apply_ops(graph_id=gid, actor="u", message="Canvas edits",
                                 containment_edge_types=["CONTAINS"], ops=ops)
    after = await _count_commits(gid, main_id)

    assert commit is not None, "no commit produced"
    assert after == before + 1, f"expected exactly ONE commit, got {after - before}"   # the whole point

    st = await svc.materialize_state(graph_id=gid, branch_id=main_id)
    assert {L, O} <= set(st["nodes"]), st["nodes"]
    assert (st["nodes"][O].get("layerAssignment")) == "blank-layer-1", st["nodes"][O]   # layer landed too

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres")
def test_graph_changes_one_commit():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("one Review & Save = one commit (creates+edge+layer): OK")
