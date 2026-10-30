"""A fork's reviews, one after another — needs Postgres.

A fork is merged into its parent more than once: a review, then more work and another review.
Each review merges what the fork changed since the last one merged, as git merges from the last
merged commit: a change the parent took and then undid is not proposed again, and a field only
the parent changed since is no conflict. A review that changes nothing is recorded as merged by
whom and when; one merged twice at once merges once; one refused for conflicts is left marked
so; and merged through the review screen it keeps the parent's rules.
"""
import asyncio
import os

import pytest
from sqlalchemy import func, select

from backend.app.services.versioning import db, models
from backend.app.services.versioning.ontology import EntityRule, OntologyRules
from backend.app.services.versioning.service import (
    GraphVersioningService, MergeConflict, OntologyViolation)

pytestmark = [pytest.mark.integration, pytest.mark.skipif(
    not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")]


def _node(eid, op="create", etype="Dataset", **props):
    return {"op": op, "entity_kind": "node", "entity_id": eid,
            "payload": {"entityType": etype, "displayName": eid, **props}}


async def _publish(svc, gid, actor, ops, msg):
    d = await svc.open_draft(graph_id=gid, owner=actor)
    await svc.apply_ops(graph_id=gid, branch_id=d, actor=actor, ops=ops)
    return await svc.publish(graph_id=gid, branch_id=d, actor=actor, message=msg)


async def _graph(svc):
    g = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                               actor="alice")
    return g["graph_id"], g["main_branch_id"]


async def _nodes(svc, gid, bid):
    return (await svc.materialize_state(graph_id=gid, branch_id=bid))["nodes"]


async def _a_second_review_merges_what_changed_since_the_first(svc):
    pg, pmain = await _graph(svc)
    await _publish(svc, pg, "alice", [_node("A", f=1), _node("B", g="orig")], "seed")
    fork = await svc.fork_graph(parent_graph_id=pg, workspace_id="ws1", actor="bob")
    fg = fork["graph_id"]
    await _publish(svc, fg, "bob", [_node("A", "update", f=10), _node("B", "update", g="fork")],
                   "fork work")
    first = await svc.open_pr(source_graph_id=fg, actor="bob")
    assert await svc.merge_pr(pr_id=first, actor="carol", message="first")
    parent = await _nodes(svc, pg, pmain)
    assert parent["A"]["f"] == 10 and parent["B"]["g"] == "fork", parent

    # The parent takes the fork's change to A back, and changes B again; the fork adds X.
    await _publish(svc, pg, "alice", [_node("A", "update", f=1), _node("B", "update", g="parent")],
                   "parent after the merge")
    await _publish(svc, fg, "bob", [_node("X")], "more fork work")

    second = await svc.open_pr(source_graph_id=fg, actor="bob")
    preview = await svc.preview_pr(pr_id=second)
    assert preview["clean"] is True, preview["conflicts"]       # B: only the parent changed it since
    assert preview["changes"]["create"] == 1 and preview["changes"]["update"] == 0, preview
    assert await svc.merge_pr(pr_id=second, actor="carol", message="second")
    parent = await _nodes(svc, pg, pmain)
    assert parent["A"]["f"] == 1, "the parent's undo of a merged change is not proposed again"
    assert parent["B"]["g"] == "parent", parent
    assert "X" in parent, parent


async def _a_review_that_changes_nothing_is_recorded(svc):
    pg, _ = await _graph(svc)
    await _publish(svc, pg, "alice", [_node("A")], "seed")
    fg = (await svc.fork_graph(parent_graph_id=pg, workspace_id="ws1", actor="bob"))["graph_id"]
    pr = await svc.open_pr(source_graph_id=fg, actor="bob")
    assert await svc.merge_pr(pr_id=pr, actor="carol", message="nothing") == ""
    row = await svc.get_pr(pr)
    assert row["status"] == "merged" and row["merged_by"] == "carol" and row["merged_at"], row


async def _a_review_merged_twice_at_once_merges_once(svc):
    pg, _ = await _graph(svc)
    await _publish(svc, pg, "alice", [_node("A", f=1)], "seed")
    fg = (await svc.fork_graph(parent_graph_id=pg, workspace_id="ws1", actor="bob"))["graph_id"]
    await _publish(svc, fg, "bob", [_node("A", "update", f=2)], "fork work")
    pr = await svc.open_pr(source_graph_id=fg, actor="bob")
    # Both read the review while the parent's lock is held elsewhere, then take it in turn.
    async with db.graphver_session() as hold, hold.begin():
        await hold.execute(select(func.pg_advisory_xact_lock(func.hashtext(pg))))
        both = [asyncio.create_task(svc.merge_pr(pr_id=pr, actor=a, message="m"))
                for a in ("carol", "dave")]
        await asyncio.sleep(0.5)
    done = await asyncio.gather(*both, return_exceptions=True)
    merged = [r for r in done if isinstance(r, str) and r]
    refused = [r for r in done if isinstance(r, ValueError) and "merged" in str(r)]
    assert len(merged) == 1 and len(refused) == 1, done


async def _a_review_refused_for_conflicts_is_marked_so(svc):
    pg, _ = await _graph(svc)
    await _publish(svc, pg, "alice", [_node("A", f=1)], "seed")
    fg = (await svc.fork_graph(parent_graph_id=pg, workspace_id="ws1", actor="bob"))["graph_id"]
    await _publish(svc, fg, "bob", [_node("A", "update", f=2)], "fork work")
    pr = await svc.open_pr(source_graph_id=fg, actor="bob")
    assert (await svc.get_pr(pr))["status"] == "mergeable"
    await _publish(svc, pg, "alice", [_node("A", "update", f=3)], "parent work")
    with pytest.raises(MergeConflict):
        await svc.merge_pr(pr_id=pr, actor="carol", message="m")
    row = await svc.get_pr(pr)
    assert row["status"] == "conflicts" and row["conflicts"], row


async def _the_review_screen_keeps_the_parents_rules(svc):
    pg, pmain = await _graph(svc)
    await _publish(svc, pg, "alice", [_node("A")], "seed")
    fg = (await svc.fork_graph(parent_graph_id=pg, workspace_id="ws1", actor="bob"))["graph_id"]
    await _publish(svc, fg, "bob", [_node("W", etype="Widget")], "a type the parent lacks")
    pr = await svc.open_pr(source_graph_id=fg, actor="bob")
    rules = OntologyRules(entity_types={"Dataset": EntityRule()})
    with pytest.raises(OntologyViolation):
        await svc.merge_mr(mr_id=pr, actor="carol", message="m", ontology_rules=rules)
    assert "W" not in await _nodes(svc, pg, pmain)


async def _run(case) -> None:
    await models.create_schema_and_partitions()
    try:
        await case(GraphVersioningService())
    finally:
        await db.dispose_engine()


def test_a_second_review_merges_what_changed_since_the_first():
    asyncio.run(_run(_a_second_review_merges_what_changed_since_the_first))


def test_a_review_that_changes_nothing_is_recorded():
    asyncio.run(_run(_a_review_that_changes_nothing_is_recorded))


def test_a_review_merged_twice_at_once_merges_once():
    asyncio.run(_run(_a_review_merged_twice_at_once_merges_once))


def test_a_review_refused_for_conflicts_is_marked_so():
    asyncio.run(_run(_a_review_refused_for_conflicts_is_marked_so))


def test_the_review_screen_keeps_the_parents_rules():
    asyncio.run(_run(_the_review_screen_keeps_the_parents_rules))
