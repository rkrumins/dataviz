"""A fork of a graph of millions costs what changes in it, not the graph — needs Postgres.

A fork copies no rows: its ``main`` reads its parent's at the fork point for what it has not
changed. Forking hashed every entity of the parent for the fork point's fingerprint, under the
parent's lock, and every commit on the fork hashed its whole state again, for a fingerprint nothing
reads. The fork point carries the root the parent stored at its head instead, and a commit on the
fork none, as a draft's.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.models import BranchORM, CommitORM
from backend.app.services.versioning.service import GraphVersioningService
from backend.tests.integration.test_versioning_bounded_reads import _edge, _node, _upd

pytestmark = [pytest.mark.integration, pytest.mark.skipif(
    not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")]

N = 120          # baseline nodes; edges N0->N1 … N59->N60; S contains N0 … N9
CONT = ["CONTAINS"]


async def _publish(svc, gid, actor, ops, msg):
    d = await svc.open_draft(graph_id=gid, owner=actor)
    await svc.stage_changes(graph_id=gid, branch_id=d, actor=actor, ops=ops)
    await svc.checkpoint(graph_id=gid, branch_id=d, actor=actor, containment_edge_types=CONT)
    return await svc.publish(graph_id=gid, branch_id=d, actor=actor, message=msg,
                             containment_edge_types=CONT)


async def _parent(svc):
    g = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                               actor="alice")
    await _publish(svc, g["graph_id"], "alice",
                   [_node(f"N{i}") for i in range(N)] + [_node("S")]
                   + [_edge(f"E{i}", f"N{i}", f"N{i + 1}") for i in range(60)]
                   + [_edge(f"C{i}", "S", f"N{i}", "CONTAINS") for i in range(10)], "baseline")
    return g["graph_id"], g["main_branch_id"]


async def _root(gid, cid):
    async with db.graphver_session() as s:
        return (await s.get(CommitORM, (gid, cid))).merkle_root


async def _head(bid):
    async with db.graphver_session() as s:
        return (await s.get(BranchORM, bid)).head_commit_id


async def _forking_builds_no_whole_graph_fingerprint(svc):
    pg, pmain = await _parent(svc)
    fork = await svc.fork_graph(parent_graph_id=pg, workspace_id="ws1", actor="bob")
    fg, fmain = fork["graph_id"], fork["main_branch_id"]
    point = await _head(fmain)
    cid = await _publish(svc, fg, "bob", [_upd("N1", "one"), _node("X")], "fork work")
    # The fork point is the parent's head: it carries the root the parent stored there. A commit
    # on the fork carries none, as a draft's: nothing reads a fork's.
    parents = await _root(pg, await _head(pmain))
    assert parents is not None and await _root(fg, point) == parents
    assert await _root(fg, cid) is None


async def _run(case) -> None:
    await models.create_schema_and_partitions()
    try:
        await case(GraphVersioningService())
    finally:
        await db.dispose_engine()


def test_forking_builds_no_whole_graph_fingerprint():
    asyncio.run(_run(_forking_builds_no_whole_graph_fingerprint))
