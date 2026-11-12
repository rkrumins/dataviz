"""A publish or merge says what it did to ``main``, and the revision of ``main`` that holds it
(live Postgres).

Pins: ``published``, as the commit it landed as, at that commit's sequence number on ``main`` —
what ``asOfSeq`` reads ``main`` as of, and ``main`` as of it holds the draft's change. A draft that
changed nothing is ``unchanged``: it commits nothing (``main``'s head and its commits stay as they
were), names no commit, and is held by ``main``'s head; an id ``main`` never had (a draft's own
head, as an older publish answered) is answered the same. A graph that is gone, with nothing.
"""
from __future__ import annotations

import asyncio
import os

import pytest
from sqlalchemy import func, select

from backend.app.services.versioning import db, models
from backend.app.services.versioning.models import CommitORM, GraphORM
from backend.app.services.versioning.service import GraphVersioningService

pytestmark = pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"),
                                reason="set GRAPHVER_E2E=1 + a live Postgres to run")


def _node(eid, **p):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": f"urn:{eid}", "entityType": "Table", "displayName": eid, **p}}


async def _head(gid):
    async with db.graphver_session() as s:
        return (await s.get(GraphORM, gid)).main_head_commit_seq


async def _commits(gid):
    async with db.graphver_session() as s:
        return await s.scalar(select(func.count()).select_from(CommitORM).where(CommitORM.graph_id == gid))


async def _cases(svc):
    gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(),
                                  workspace_id="ws1", actor="u"))["graph_id"]
    await svc.apply_ops(graph_id=gid, actor="u", message="seed", ops=[_node("N"), _node("M")])

    draft = await svc.open_draft(graph_id=gid, owner="u")
    await svc.apply_ops(graph_id=gid, branch_id=draft, actor="u", message="edit", ops=[
        {"op": "update", "entity_kind": "node", "entity_id": "N", "payload": {"description": "new"}}])
    commit_id = await svc.publish(graph_id=gid, branch_id=draft, actor="u", message="publish")
    async with db.graphver_session() as s:
        seq = await s.scalar(select(CommitORM.commit_seq).where(CommitORM.id == commit_id))
    landed = await svc.publish_outcome(graph_id=gid, commit_id=commit_id)
    revision = landed["revision_id"]
    assert landed == {"outcome": "published", "commit_id": commit_id, "revision_id": seq}, landed
    assert revision == seq == await _head(gid), (revision, seq)
    state = await svc.materialize_state(graph_id=gid, branch_id=await svc.main_branch_id(gid),
                                        as_of_seq=revision)
    assert state["nodes"]["N"]["description"] == "new", "main as of the revision holds the change"

    commits = await _commits(gid)
    idle = await svc.open_draft(graph_id=gid, owner="u")                 # changes nothing
    answered = await svc.publish(graph_id=gid, branch_id=idle, actor="u", message="nothing")
    assert answered == "", "nothing committed, so no commit — not the draft's own"
    unchanged = {"outcome": "unchanged", "commit_id": None, "revision_id": revision}
    assert await svc.publish_outcome(graph_id=gid, commit_id=answered) == unchanged
    assert (await _head(gid), await _commits(gid)) == (revision, commits), "main did not move"
    assert await svc.publish_outcome(graph_id=gid, commit_id="cmt_never_on_main") == unchanged
    assert await svc.publish_outcome(graph_id="graph_" + os.urandom(4).hex(), commit_id=commit_id) is None


def test_a_publish_says_the_revision_of_main_that_holds_it():
    async def run():
        await models.create_schema_and_partitions()
        try:
            await _cases(GraphVersioningService())
        finally:
            await db.dispose_engine()
    asyncio.run(run())
