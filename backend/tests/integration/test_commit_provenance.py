"""Every commit says who made it and how, and automation never blocks a person (doc 19, phase 1).

* **Provenance.** A commit records its actor's kind (human, service, system), the API key it came
  through and the request it came from, read from the request's bound activity context — and a
  job's commits name the key and request that queued the job, though a worker writes them.
* **History splits.** The commit log answers People or Automation alone; a commit from before the
  columns existed is classed from its actor.
* **People first.** A draft behind main publishes without a pull when everything since its base is
  automation's and touched nothing it changed. Anyone else's change, or automation's change of the
  same entity, still asks for a pull — and says which (``reason``).
* **Original editor.** A publish credits each entity's version on main to whoever edited it in the
  draft; the commit itself is the publisher's.
"""
import asyncio
import os
from contextlib import contextmanager

import pytest
from sqlalchemy import select, update

from backend.app.common import activity_context
from backend.app.services.versioning import config, db, models, provenance
from backend.app.services.versioning.import_export.service import ImportExportService
from backend.app.services.versioning.models import CommitORM, NodeVersionORM
from backend.app.services.versioning.service import GraphVersioningService, NotUpToDate

pytestmark = pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"),
                                reason="set GRAPHVER_E2E=1 + a live Postgres to run")


@contextmanager
def _as(actor, key=None, request=None):
    token = activity_context.bind(activity_context.ActivityContext(
        actor_id=actor, api_key_id=key, correlation_id=request))
    try:
        yield
    finally:
        activity_context.reset(token)


def _node(eid, name):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": eid, "entityType": "domain", "displayName": name}}


def _rename(eid, name):
    return {"op": "update", "entity_kind": "node", "entity_id": eid, "payload": {"displayName": name}}


def _edge(eid, src, tgt):
    return {"op": "create", "entity_kind": "edge", "entity_id": eid,
            "payload": {"sourceEntityId": src, "targetEntityId": tgt, "edgeType": "RELATED"}}


def _delete(eid):
    return {"op": "delete", "entity_kind": "node", "entity_id": eid, "payload": None}


async def _graph(svc, *nodes):
    gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                                  actor="alice"))["graph_id"]
    if nodes:
        await svc.apply_ops(graph_id=gid, actor="alice", ops=[_node(n, n) for n in nodes])
    return gid


async def _commit(gid, commit_id):
    async with db.graphver_session() as s:
        return await s.get(CommitORM, (gid, commit_id))


async def _latest_main_commit(svc, gid):
    return (await svc.commit_log(graph_id=gid, limit=1))[0]


async def _names(svc, gid):
    main = await svc.main_branch_id(gid)
    return {k: v.get("displayName") for k, v in
            (await svc.materialize_state(graph_id=gid, branch_id=main))["nodes"].items()}


def _ie(svc):
    """The transfer service, publishing a job's draft as the app's hook does (queued)."""
    async def publish(job):
        if job.get("mergedCommitId"):
            return {"commitId": job["mergedCommitId"]}
        try:
            cid = await svc.publish(graph_id=job["graphId"], branch_id=job["branchId"],
                                    actor=job["actor"], message=job.get("message") or "ship",
                                    queued=True)
        except NotUpToDate as exc:
            return {"error": {"status": 409, "detail": {"type": "not_up_to_date", "reason": exc.reason}}}
        return {"commitId": cid}
    return ImportExportService(versioning=svc, store=object(), publish_hook=publish)


def _run(coro_fn):
    async def go():
        await models.create_schema_and_partitions()
        try:
            await coro_fn(GraphVersioningService())
        finally:
            await db.dispose_engine()
    asyncio.run(go())


# --------------------------------------------------------------------------------------------- #
# Provenance and the commit log
# --------------------------------------------------------------------------------------------- #

async def _provenance_is_recorded_and_splits_the_log(svc):
    gid = await _graph(svc)

    await svc.apply_ops(graph_id=gid, actor="alice", ops=[_node("A", "A")])
    by_hand = await _latest_main_commit(svc, gid)
    assert (by_hand["actor_kind"], by_hand["api_key_id"], by_hand["correlation_id"],
            by_hand["automation"]) == ("human", None, None, False), by_hand

    with _as("svc_bot", key="apk_1", request="req-1"):
        await svc.apply_ops(graph_id=gid, actor="svc_bot", ops=[_node("B", "B")])
    bot = await _latest_main_commit(svc, gid)
    assert (bot["actor_kind"], bot["api_key_id"], bot["correlation_id"], bot["automation"]) == \
        ("service", "apk_1", "req-1", True), bot

    # A person's own key is a script acting as them: automation.
    with _as("carol", key="apk_2", request="req-2"):
        await svc.apply_ops(graph_id=gid, actor="carol", ops=[_node("C", "C")])
    script = await _latest_main_commit(svc, gid)
    assert (script["actor_kind"], script["api_key_id"], script["automation"]) == \
        ("human", "apk_2", True), script

    # Written in someone else's name: the request's key is not theirs.
    with _as("svc_bot", key="apk_1", request="req-3"):
        await svc.apply_ops(graph_id=gid, actor="dave", ops=[_node("D", "D")])
    other = await _latest_main_commit(svc, gid)
    assert (other["actor"], other["actor_kind"], other["api_key_id"], other["correlation_id"]) == \
        ("dave", "human", None, "req-3"), other

    people = {c["commit_id"] for c in await svc.commit_log(graph_id=gid, origin="people")}
    automation = {c["commit_id"] for c in await svc.commit_log(graph_id=gid, origin="automation")}
    assert {by_hand["commit_id"], other["commit_id"]} <= people, people
    assert automation == {bot["commit_id"], script["commit_id"]}, automation
    assert not people & automation
    everything = {c["commit_id"] for c in await svc.commit_log(graph_id=gid)}
    assert everything == people | automation

    # Commits from before the columns existed are classed from their actor alone.
    async with db.graphver_session() as s:
        await s.execute(update(CommitORM).where(CommitORM.id.in_(
            [bot["commit_id"], other["commit_id"]])).values(actor_kind=None))
        await s.commit()
    automation = {c["commit_id"] for c in await svc.commit_log(graph_id=gid, origin="automation")}
    people = {c["commit_id"] for c in await svc.commit_log(graph_id=gid, origin="people")}
    assert bot["commit_id"] in automation and other["commit_id"] in people
    legacy = next(c for c in await svc.commit_log(graph_id=gid) if c["commit_id"] == bot["commit_id"])
    assert legacy["actor_kind"] == "service" and legacy["automation"], legacy


def test_provenance_is_recorded_and_splits_the_log():
    _run(_provenance_is_recorded_and_splits_the_log)


async def _a_job_commits_as_the_request_that_queued_it(svc):
    gid = await _graph(svc, "A")
    ds = (await svc.get_graph(gid))["data_source_id"]
    ie = _ie(svc)

    draft = await svc.open_draft(graph_id=gid, owner="svc_bot")
    await svc.apply_ops(graph_id=gid, branch_id=draft, actor="svc_bot", ops=[_rename("A", "A2")])
    with _as("svc_bot", key="apk_9", request="req-9"):
        job = await ie.create_publish_job(workspace_id="ws1", data_source_id=ds, graph_id=gid,
                                          branch_id=draft, actor="svc_bot", message="ship")

    # The worker: no request bound, until the runner binds what the job kept.
    assert activity_context.current().api_key_id is None
    saved = await provenance.job_provenance(job["job_id"])
    assert saved == {"actor": "svc_bot", "apiKeyId": "apk_9", "correlationId": "req-9"}, saved
    with provenance.bound(saved):
        result = await ie.run_publish(job["job_id"])
    assert not result.get("error"), result

    squash = await _latest_main_commit(svc, gid)
    assert squash["kind"] == "squash_publish", squash
    assert (squash["actor"], squash["actor_kind"], squash["api_key_id"], squash["correlation_id"]) == \
        ("svc_bot", "service", "apk_9", "req-9"), squash

    # A job that kept nothing, or whose row is gone, runs unattributed rather than not at all.
    assert await provenance.job_provenance("job_missing") is None


def test_a_job_commits_as_the_request_that_queued_it():
    _run(_a_job_commits_as_the_request_that_queued_it)


# --------------------------------------------------------------------------------------------- #
# People first: the publish gate
# --------------------------------------------------------------------------------------------- #

async def _bot_writes(svc, gid, ops):
    with _as("svc_bot", key="apk_1", request="req-bot"):
        await svc.apply_ops(graph_id=gid, actor="svc_bot", ops=ops)


async def _a_draft_publishes_past_automation_that_touched_nothing_of_it(svc):
    gid = await _graph(svc, "A", "B", "C")
    draft = await svc.open_draft(graph_id=gid, owner="alice")
    await svc.apply_ops(graph_id=gid, branch_id=draft, actor="alice", ops=[_rename("A", "Alice's A")])

    await _bot_writes(svc, gid, [_rename("B", "Bot's B")])
    await _bot_writes(svc, gid, [_node("E", "E")])

    f = await svc.branch_freshness(graph_id=gid, branch_id=draft)
    assert (f["behind"], f["behind_by"], f["behind_by_people"], f["pull_required"], f["pull_reason"]) == \
        (True, 2, 0, False, None), f

    await svc.publish(graph_id=gid, branch_id=draft, actor="alice", message="rename A")
    assert await _names(svc, gid) == {"A": "Alice's A", "B": "Bot's B", "C": "C", "E": "E"}


def test_a_draft_publishes_past_automation_that_touched_nothing_of_it():
    _run(_a_draft_publishes_past_automation_that_touched_nothing_of_it)


async def _a_draft_still_pulls_for_people_and_for_overlap(svc):
    gid = await _graph(svc, "A", "B", "C")

    # Someone else changed main by hand: pull, as before.
    d1 = await svc.open_draft(graph_id=gid, owner="alice")
    await svc.apply_ops(graph_id=gid, branch_id=d1, actor="alice", ops=[_rename("A", "A1")])
    await svc.apply_ops(graph_id=gid, actor="bob", ops=[_rename("B", "Bob's B")])
    f = await svc.branch_freshness(graph_id=gid, branch_id=d1)
    assert (f["behind_by_people"], f["pull_required"], f["pull_reason"]) == (1, True, "people"), f
    with pytest.raises(NotUpToDate) as refused:
        await svc.publish(graph_id=gid, branch_id=d1, actor="alice", message="x")
    assert refused.value.reason == "people"

    # Automation changed the very entity the draft changed: pull, to see what came in.
    d2 = await svc.open_draft(graph_id=gid, owner="alice")
    await svc.apply_ops(graph_id=gid, branch_id=d2, actor="alice", ops=[_rename("C", "Alice's C")])
    await _bot_writes(svc, gid, [_rename("C", "Bot's C")])
    f = await svc.branch_freshness(graph_id=gid, branch_id=d2)
    assert (f["behind_by_people"], f["pull_required"], f["pull_reason"]) == (0, True, "overlap"), f
    with pytest.raises(NotUpToDate) as refused:
        await svc.publish(graph_id=gid, branch_id=d2, actor="alice", message="x")
    assert refused.value.reason == "overlap"

    # …or met it at an edge. Publishing the draft's delete of A would delete, with it, the edge
    # automation just made onto A.
    d3 = await svc.open_draft(graph_id=gid, owner="alice")
    await svc.apply_ops(graph_id=gid, branch_id=d3, actor="alice", ops=[_delete("A")])
    await _bot_writes(svc, gid, [_edge("e_ba", "B", "A")])
    with pytest.raises(NotUpToDate) as refused:
        await svc.publish(graph_id=gid, branch_id=d3, actor="alice", message="x")
    assert refused.value.reason == "overlap"

    # An edge the draft makes, onto a node automation deleted.
    await svc.apply_ops(graph_id=gid, actor="alice", ops=[_node("G", "G")])
    d4 = await svc.open_draft(graph_id=gid, owner="alice")
    await svc.apply_ops(graph_id=gid, branch_id=d4, actor="alice", ops=[_edge("e_bg", "B", "G")])
    await _bot_writes(svc, gid, [_delete("G")])
    with pytest.raises(NotUpToDate) as refused:
        await svc.publish(graph_id=gid, branch_id=d4, actor="alice", message="x")
    assert refused.value.reason == "overlap"

    # An edge onto a node the other side only renamed merges cleanly: no pull.
    d5 = await svc.open_draft(graph_id=gid, owner="alice")
    await svc.apply_ops(graph_id=gid, branch_id=d5, actor="alice", ops=[_edge("e_bc", "B", "C")])
    await _bot_writes(svc, gid, [_rename("B", "Bot's B again")])
    await svc.publish(graph_id=gid, branch_id=d5, actor="alice", message="link B to C")

    # After a pull, a draft refused for people publishes.
    await svc.rebase_draft(graph_id=gid, branch_id=d1, actor="alice")
    await svc.publish(graph_id=gid, branch_id=d1, actor="alice", message="A1")
    names = await _names(svc, gid)
    assert names["A"] == "A1" and names["B"] == "Bot's B again", names
    main = await svc.main_branch_id(gid)
    edges = (await svc.materialize_state(graph_id=gid, branch_id=main))["edges"]
    assert "e_bc" in edges and "e_ba" in edges, sorted(edges)


def test_a_draft_still_pulls_for_people_and_for_overlap():
    _run(_a_draft_still_pulls_for_people_and_for_overlap)


async def _a_too_big_draft_still_pulls(svc):
    gid = await _graph(svc, "A", "B")
    draft = await svc.open_draft(graph_id=gid, owner="alice")
    await svc.apply_ops(graph_id=gid, branch_id=draft, actor="alice", ops=[_rename("A", "A1")])
    await _bot_writes(svc, gid, [_rename("B", "B1")])
    was = config.SQUASH_PAGED_ABOVE
    config.SQUASH_PAGED_ABOVE = 0
    try:
        with pytest.raises(NotUpToDate) as refused:
            await svc.publish(graph_id=gid, branch_id=draft, actor="alice", message="x")
    finally:
        config.SQUASH_PAGED_ABOVE = was
    assert refused.value.reason == "size"


def test_a_too_big_draft_still_pulls():
    _run(_a_too_big_draft_still_pulls)


async def _a_review_and_a_publish_job_follow_the_same_gate(svc):
    gid = await _graph(svc, "A", "B", "C")
    ds = (await svc.get_graph(gid))["data_source_id"]
    ie = _ie(svc)

    # A merge request merges past disjoint automation…
    d1 = await svc.open_draft(graph_id=gid, owner="alice")
    await svc.apply_ops(graph_id=gid, branch_id=d1, actor="alice", ops=[_rename("A", "Reviewed A")])
    mr = await svc.open_draft_mr(graph_id=gid, branch_id=d1, actor="alice", title="A")
    await _bot_writes(svc, gid, [_rename("B", "Bot's B")])
    pr = await svc.get_pr(mr)
    assert (pr["behind"], pr["pull_required"]) == (True, False), pr
    await svc.merge_mr(mr_id=mr, actor="bob", message="merge")
    assert (await _names(svc, gid))["A"] == "Reviewed A"

    # …and not past automation's change of what it changes.
    d2 = await svc.open_draft(graph_id=gid, owner="alice")
    await svc.apply_ops(graph_id=gid, branch_id=d2, actor="alice", ops=[_rename("C", "Alice's C")])
    mr2 = await svc.open_draft_mr(graph_id=gid, branch_id=d2, actor="alice", title="C")
    await _bot_writes(svc, gid, [_rename("C", "Bot's C")])
    with pytest.raises(NotUpToDate) as refused:
        await svc.merge_mr(mr_id=mr2, actor="bob", message="merge")
    assert refused.value.reason == "overlap"

    # A publish job is queued past disjoint automation, and refused for overlap at once.
    d3 = await svc.open_draft(graph_id=gid, owner="alice")
    await svc.apply_ops(graph_id=gid, branch_id=d3, actor="alice", ops=[_node("F", "F")])
    await _bot_writes(svc, gid, [_rename("B", "Bot's B, later")])
    job = await ie.create_publish_job(workspace_id="ws1", data_source_id=ds, graph_id=gid,
                                      branch_id=d3, actor="alice", message="ship F")
    assert not (await ie.run_publish(job["job_id"])).get("error")
    assert "F" in await _names(svc, gid)

    d4 = await svc.open_draft(graph_id=gid, owner="alice")
    await svc.apply_ops(graph_id=gid, branch_id=d4, actor="alice", ops=[_rename("B", "Alice's B")])
    await _bot_writes(svc, gid, [_rename("B", "Bot's B, again")])
    with pytest.raises(NotUpToDate) as refused:
        await ie.create_publish_job(workspace_id="ws1", data_source_id=ds, graph_id=gid,
                                    branch_id=d4, actor="alice", message="x")
    assert refused.value.reason == "overlap"


def test_a_review_and_a_publish_job_follow_the_same_gate():
    _run(_a_review_and_a_publish_job_follow_the_same_gate)


# --------------------------------------------------------------------------------------------- #
# Original editor on publish
# --------------------------------------------------------------------------------------------- #

async def _main_versions(gid, commit_id):
    async with db.graphver_session() as s:
        return dict((await s.execute(select(NodeVersionORM.entity_id, NodeVersionORM.actor).where(
            NodeVersionORM.graph_id == gid, NodeVersionORM.commit_id == commit_id))).all())


async def _publish_credits_each_entity_to_its_editor(svc, *, paged: bool, behind: bool):
    gid = await _graph(svc, "A", "B", "C")
    draft = await svc.open_draft(graph_id=gid, owner="alice", shared=True)
    await svc.add_branch_member(graph_id=gid, branch_id=draft, subject_type="user", subject_id="erin",
                                role="editor", actor="alice")
    await svc.add_branch_member(graph_id=gid, branch_id=draft, subject_type="user", subject_id="bob",
                                role="maintainer", actor="alice")
    await svc.apply_ops(graph_id=gid, branch_id=draft, actor="alice", ops=[_rename("A", "Alice's A")])
    await svc.apply_ops(graph_id=gid, branch_id=draft, actor="erin",
                        ops=[_rename("B", "Erin's B"), _node("N", "Erin's new")])
    if behind:
        await _bot_writes(svc, gid, [_rename("C", "Bot's C")])

    was = config.SQUASH_PAGED_ABOVE
    if paged:
        config.SQUASH_PAGED_ABOVE = 0
    try:
        commit_id = await svc.publish(graph_id=gid, branch_id=draft, actor="bob", message="ship")
    finally:
        config.SQUASH_PAGED_ABOVE = was

    c = await _commit(gid, commit_id)
    assert c.actor == "bob" and c.kind == "squash_publish", (c.actor, c.kind)
    assert await _main_versions(gid, commit_id) == {"A": "alice", "B": "erin", "N": "erin"}


def test_publish_credits_each_entity_to_its_editor():
    _run(lambda svc: _publish_credits_each_entity_to_its_editor(svc, paged=False, behind=False))


def test_publish_behind_automation_credits_each_entity_to_its_editor():
    _run(lambda svc: _publish_credits_each_entity_to_its_editor(svc, paged=False, behind=True))


def test_a_paged_publish_credits_each_entity_to_its_editor():
    _run(lambda svc: _publish_credits_each_entity_to_its_editor(svc, paged=True, behind=False))
