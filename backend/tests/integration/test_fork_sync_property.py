"""Updates and merges interleaved converge — Postgres and FalkorDB.

Random interleavings, from fixed seeds, of commits on a root graph and on a fork of it (tables and
columns made, renamed, deleted; flows drawn, weighed, re-pointed, deleted; columns moved), Updates
from parent and merges of the fork's reviews. A conflict an update raises is settled with the
fork's own values. The root is projected into a FalkorDB key of its own after each of its commits,
for real, and after every step the fork read through its overlay over that key is what Postgres
composes. And:

* a conflict an update raises is on an entity the fork changed since its last merged review and
  its parent changed since the fork last agreed with it — never on one only one side changed, so
  never on one the fork merged and has not changed since;
* a merge needs the fork up to date, and after it the parent is the fork at the head the merge
  took — every entity the fork changed among them;
* at the end, an update and a merge leave the two the same.
"""
import asyncio
import os
import random

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.errors import ForkNotUpToDate, ForkUpdateConflicts
from backend.app.services.versioning.service import GraphVersioningService
from backend.tests.integration.test_fork_overlay_property import CONT, _check, _urns, _Writer

pytestmark = [pytest.mark.integration, pytest.mark.skipif(
    not os.getenv("GRAPHVER_E2E") or os.getenv("RUN_FALKOR_LIVE") != "1",
    reason="set GRAPHVER_E2E=1 and RUN_FALKOR_LIVE=1 with FalkorDB reachable")]

STEPS = 40


async def _state(svc, gid, main, as_of=None):
    return await svc.materialize_state(graph_id=gid, branch_id=main, as_of_seq=as_of)


async def _windows(svc, fork, fmain, parent, pmain):
    """What the fork changed since its last merged review, and what its parent changed since the
    fork last agreed with it."""
    from backend.app.services.versioning.models import GraphORM
    async with db.graphver_session() as s:
        f = await s.get(GraphORM, fork)
        head = f.main_head_commit_seq
        mine = await svc._own_window(s, fork, fmain, await svc._fork_merge_base(s, f), head)
        theirs = await svc._changed_in_window(
            s, parent, pmain, await svc._fork_agreed_base(s, f, head),
            (await s.get(GraphORM, parent)).main_head_commit_seq)
    return mine, theirs


async def _update(svc, fork, fmain, parent, pmain, label):
    """Update from parent, its conflicts settled with the fork's own values; each conflict on
    something both changed."""
    mine, theirs = await _windows(svc, fork, fmain, parent, pmain)
    try:
        return await svc.update_fork_from_parent(fork_graph_id=fork, actor="sync")
    except ForkUpdateConflicts as exc:
        clashed = {c["entity_id"] for c in exc.conflicts}
        assert clashed <= mine & theirs, (label, clashed - (mine & theirs))
        return await svc.update_fork_from_parent(fork_graph_id=fork, actor="sync",
                                                 resolutions=exc.seeds)


async def _merge(svc, fork, fmain, parent, pmain, label):
    """Merge the fork's review, updating it first when its parent moved. The parent is then the
    fork at the head the merge took."""
    pr = await svc.open_pr(source_graph_id=fork, actor="bob")
    try:
        await svc.merge_pr(pr_id=pr, actor="carol", message=label, containment_edge_types=CONT)
    except ForkNotUpToDate:
        await _update(svc, fork, fmain, parent, pmain, label)
        await svc.merge_pr(pr_id=pr, actor="carol", message=label, containment_edge_types=CONT)
    took = (await svc.get_pr(pr))
    from sqlalchemy import select

    from backend.app.services.versioning.models import MergeRequestORM
    async with db.graphver_session() as s:
        seq = await s.scalar(select(MergeRequestORM.merged_source_seq).where(MergeRequestORM.id == pr))
    assert took["status"] == "merged", (label, took)
    assert await _state(svc, parent, pmain) == await _state(svc, fork, fmain, as_of=seq), label


async def _run(seed: int) -> None:
    from falkordb.asyncio import FalkorDB
    from redis.asyncio import ConnectionPool

    from backend.app.providers.falkordb_provider import FalkorDBProvider
    from backend.app.services.versioning.projection import FalkorProjector

    await models.create_schema_and_partitions()
    host, port = os.getenv("FALKORDB_HOST", "localhost"), int(os.getenv("FALKORDB_PORT", "6379"))
    rng = random.Random(seed)
    svc = GraphVersioningService()
    key = "gvt_sync_" + os.urandom(4).hex()
    pool = ConnectionPool(host=host, port=port, max_connections=4)
    handle = FalkorDB(connection_pool=pool)
    base = FalkorDBProvider(host=host, port=port, graph_name=key)
    base.set_containment_edge_types(CONT)
    try:
        root = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(),
                                       workspace_id="ws1", actor="alice", falkor_graph_name=key,
                                       owns_falkor_graph=True))["graph_id"]
        rmain = await svc.main_branch_id(root)
        projector = FalkorProjector(lambda _name, _provider=None: handle.select_graph(key))
        parent = _Writer(svc, root, rmain, "r", rng)
        for _ in range(6):
            await parent.step()
        await projector.project_graph(root)
        f = await svc.fork_graph(parent_graph_id=root, workspace_id="ws1", actor="bob")
        fork = _Writer(svc, f["graph_id"], f["main_branch_id"], "f", rng)
        for step in range(STEPS):
            label = f"seed {seed} step {step}"
            what = rng.choice(["root"] * 4 + ["fork"] * 4 + ["update"] * 2 + ["merge"] * 2)
            if what == "root":
                await parent.step()
            elif what == "fork":
                await fork.step()
            elif what == "update":
                await _update(svc, fork.gid, fork.main, root, rmain, label)
            else:
                await _merge(svc, fork.gid, fork.main, root, rmain, label)
            if what in ("root", "merge"):
                result = await projector.project_graph(root)
                assert not result.get("verify_error"), result
            urns = await _urns(svc, parent) | await _urns(svc, fork)
            await _check(svc, base, fork.gid, fork.main, urns, f"{label} ({what})")
        # At the end, an update and a merge leave the two the same.
        await _update(svc, fork.gid, fork.main, root, rmain, f"seed {seed} end")
        await _merge(svc, fork.gid, fork.main, root, rmain, f"seed {seed} end")
        assert await _state(svc, root, rmain) == await _state(svc, fork.gid, fork.main)
    finally:
        try:
            await handle.select_graph(key).delete()
        except Exception:
            pass
        await pool.disconnect()
        await db.dispose_engine()


@pytest.mark.parametrize("seed", [11, 2026, 4242])
def test_updates_and_merges_interleaved_converge(seed):
    asyncio.run(_run(seed))
