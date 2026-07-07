"""PR approval + checks gate (P8) — needs Postgres.

A fork PR into a parent's main is gated by (1) every requested reviewer's approval
and (2) re-validation of the merged result against the *parent's* ontology. Both
are checked before any write; a no-reviewer PR over a clean ontology merges as
before.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.service import (
    AccessDenied,
    ApprovalRequired,
    GraphVersioningService,
    OntologyViolation,
)


async def _edit_publish(svc, gid, actor, ops, msg):
    d = await svc.open_draft(graph_id=gid, owner=actor)
    await svc.stage_changes(graph_id=gid, branch_id=d, actor=actor, ops=ops)
    await svc.checkpoint(graph_id=gid, branch_id=d, actor=actor)
    return await svc.publish(graph_id=gid, branch_id=d, actor=actor, message=msg)


def _node(eid, et="Dataset", **kw):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"displayName": eid, "entityType": et, **kw}}


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    ds = lambda: "ds_" + os.urandom(4).hex()

    # ══ A. approval gate (parent has no ontology → checks always pass) ════
    P = await svc.create_graph(data_source_id=ds(), workspace_id="ws1", actor="alice")
    pg, pmain = P["graph_id"], P["main_branch_id"]
    await _edit_publish(svc, pg, "alice", [_node("A", f=1)], "seed")
    F = await svc.fork_graph(parent_graph_id=pg, workspace_id="ws1", actor="bob")
    await _edit_publish(svc, F["graph_id"], "bob", [_node("A", f=10)], "fork edit")

    pr = await svc.open_pr(source_graph_id=F["graph_id"], actor="bob", reviewers=["carol"])
    assert (await svc.get_pr(pr))["approval_status"] == "pending"
    with pytest.raises(ApprovalRequired) as ei:                  # unapproved → blocked
        await svc.merge_pr(pr_id=pr, actor="dave", message="merge")
    assert ei.value.pending == ["carol"]
    with pytest.raises(AccessDenied):                            # author can't self-approve
        await svc.approve_pr(pr_id=pr, actor="bob")
    meta = await svc.approve_pr(pr_id=pr, actor="carol")
    assert meta["approval_status"] == "approved" and meta["status"] == "approved"
    assert await svc.merge_pr(pr_id=pr, actor="dave", message="merge")   # now allowed
    assert (await svc.materialize_state(graph_id=pg, branch_id=pmain))["nodes"]["A"]["f"] == 10
    assert (await svc.get_pr(pr))["checks_status"]["ontology"]["ok"] is True

    # ══ B. checks gate (parent enforces a strict Dataset-only ontology) ═══
    async with db.graphver_session() as s:
        await s.execute(__import__("sqlalchemy").text(
            "ALTER TABLE graphver.graphs ADD COLUMN IF NOT EXISTS ontology_spec jsonb"))
    Q = await svc.create_graph(data_source_id=ds(), workspace_id="ws1", actor="alice",
                               ontology_spec={"entityTypes": ["Dataset"]}, ontology_enforcement="strict")
    qg, qmain = Q["graph_id"], Q["main_branch_id"]
    await _edit_publish(svc, qg, "alice", [_node("A", et="Dataset", f=1)], "seed")

    # fork has no ontology, so it can stage an out-of-vocab type freely…
    Fbad = await svc.fork_graph(parent_graph_id=qg, workspace_id="ws1", actor="bob")
    await _edit_publish(svc, Fbad["graph_id"], "bob", [_node("X", et="Bad")], "bad type")
    prbad = await svc.open_pr(source_graph_id=Fbad["graph_id"], actor="bob")   # no reviewers
    with pytest.raises(OntologyViolation) as ev:                 # …but the gate rejects the merge
        await svc.merge_pr(pr_id=prbad, actor="alice", message="merge bad")
    assert any(v["entity_id"] == "X" for v in ev.value.violations)
    assert (await svc.materialize_state(graph_id=qg, branch_id=qmain))["nodes"].get("X") is None

    # a valid-type fork PR passes the gate and merges (no reviewers required)
    Fok = await svc.fork_graph(parent_graph_id=qg, workspace_id="ws1", actor="bob")
    await _edit_publish(svc, Fok["graph_id"], "bob", [_node("Y", et="Dataset")], "good type")
    prok = await svc.open_pr(source_graph_id=Fok["graph_id"], actor="bob")
    assert await svc.merge_pr(pr_id=prok, actor="alice", message="merge ok")
    assert "Y" in (await svc.materialize_state(graph_id=qg, branch_id=qmain))["nodes"]

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_pr_gate_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning PR approval + checks gate e2e: OK")
