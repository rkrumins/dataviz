"""Reads stay on the FalkorDB key while it updates, at the version it holds — Postgres.

While the projection catches up after a publish or an import, or rebuilds the key in place, reads
of main are served from the key at the version it last published (``served``, ``serving_seq``),
complete with its lineage summaries, and the watermark says which, so the view can say an earlier
version is showing. Only a key that holds no version — lost, written from nothing after a move, or
out of FalkorDB — sends main to Postgres. ``served_commit_seq`` is what makes a rebuild servable: a
rebuild resets the watermark to 0, not what the key holds. A fake FalkorDB with ``ro_query`` and a
key that can go missing stands in for the store (the liveness test's).
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, keymigrate
from backend.app.services.versioning.models import ProjectionStateORM
from backend.app.services.versioning.service import GraphVersioningService
from backend.tests.integration.test_projection_liveness_e2e import (
    LiveFalkor,
    LiveGraph,
    _create,
    _ours,
    _seed,
)
from backend.tests.integration.test_versioning_projection import _assert_matches_main, _edit_publish

pytestmark = pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"),
                                reason="set GRAPHVER_E2E=1 + a live Postgres to run")


async def _serving(svc, gid: str) -> tuple:
    wm = await svc.projection_watermark(gid)
    return wm["served"], wm["read_route"]["main"], wm["fresh"]


async def _stored(gid: str):
    async with db.graphver_session() as s:
        return (await s.get(ProjectionStateORM, gid)).served_commit_seq


async def _run_reads_keep_the_published_version_while_it_catches_up_and_rebuilds() -> None:
    svc, fake = GraphVersioningService(), LiveFalkor()
    gid, proj, _graph = await _seed(svc, fake)                 # projected at seq 3
    assert await _serving(svc, gid) == (3, "falkordb", True)

    # Published, not yet written to the graph: the key serves seq 3, and says which revision.
    await _edit_publish(svc, gid, "a", _create("D"), "after the last pass")
    wm = await svc.projection_watermark(gid)
    assert (wm["served"], wm["read_route"]["main"], wm["fresh"], wm["committed"]) == (3, "falkordb", False, 4)
    assert wm["served_revision"] == wm["projected_revision"] and wm["served_revision"]["commit_id"]

    # A rebuild resets the watermark, not what the key holds: it is rebuilt in place.
    assert await svc.request_projection_rebuild(gid)
    wm = await svc.projection_watermark(gid)
    assert (wm["projected"], wm["status"], wm["served"], wm["read_route"]["main"]) == (0, "rebuilding", 3, "falkordb")
    assert wm["served_revision"]["commit_id"]

    assert (await proj.project_graph(gid))["projected"] == 4
    assert await _serving(svc, gid) == (4, "falkordb", True)
    assert await _stored(gid) == 4
    await _assert_matches_main(svc, fake, gid)
    await db.dispose_engine()


def test_reads_keep_the_published_version_while_it_catches_up_and_rebuilds(read_mode_in_place):
    asyncio.run(_run_reads_keep_the_published_version_while_it_catches_up_and_rebuilds())


async def _run_a_key_that_holds_nothing_sends_reads_to_postgres() -> None:
    svc, fake = GraphVersioningService(), LiveFalkor()
    gid, proj, graph = await _seed(svc, fake)

    graph.drop()                                               # lost behind the platform's back
    assert [r["reset_to"] for r in await _ours(proj, gid)] == [0]
    assert await _serving(svc, gid) == (None, "postgres", False)
    assert await _stored(gid) is None

    assert (await proj.project_graph(gid))["projected"] == 3   # reseeded: served again
    assert await _serving(svc, gid) == (3, "falkordb", True)

    # Moved: the new key is written from nothing, so nothing is served from it until it is.
    await _edit_publish(svc, gid, "a", _create("D"), "before the move")
    new = keymigrate.owned_key(gid, 1)
    fake.ours.add(new)
    res = await svc.move_projection(graph_id=gid, provider="prov_b", key=new, actor="a", shard_map={})
    assert res["changed"], res
    assert await _serving(svc, gid) == (None, "postgres", False)
    assert (await proj.project_graph(gid))["projected"] == 4
    assert await _serving(svc, gid) == (4, "falkordb", True)
    await db.dispose_engine()


def test_a_key_that_holds_nothing_sends_reads_to_postgres():
    asyncio.run(_run_a_key_that_holds_nothing_sends_reads_to_postgres())


class _ProbedGraph(LiveGraph):
    """Says what the watermark served when the full pass probed the key, after reading it."""

    def __init__(self):
        super().__init__()
        self.at_probe = []

    async def query(self, cypher, params=None):
        if cypher == "RETURN 1" and self.check is not None:
            self.at_probe.append(await self.check())
        return await super().query(cypher, params)


async def _run_a_lost_key_rebuilt_before_liveness_saw_it_serves_nothing_while_rewritten() -> None:
    svc, fake = GraphVersioningService(), LiveFalkor()
    gid, proj, graph = await _seed(svc, fake)
    probed = _ProbedGraph()
    probed.check = None
    name = next(n for n, g in fake.graphs.items() if g is graph)
    fake.graphs[name] = probed
    probed.drop()                                              # gone, and liveness has not run
    assert await svc.request_projection_rebuild(gid)
    assert await _stored(gid) == 3, "the service cannot see the key: a rebuild keeps it"

    async def check():
        return await _serving(svc, gid)
    probed.check = check
    assert (await proj.project_graph(gid))["projected"] == 3
    assert probed.at_probe == [(None, "postgres", False)], "the pass saw the key gone first"
    assert await _serving(svc, gid) == (3, "falkordb", True)
    await _assert_matches_main(svc, fake, gid)
    await db.dispose_engine()


def test_a_lost_key_rebuilt_before_liveness_saw_it_serves_nothing_while_rewritten():
    asyncio.run(_run_a_lost_key_rebuilt_before_liveness_saw_it_serves_nothing_while_rewritten())


async def _forget_column(gid: str, **values) -> None:
    """The row as a graph that last published before served_commit_seq existed has it."""
    from sqlalchemy import update
    async with db.graphver_session() as s:
        await s.execute(update(ProjectionStateORM).where(ProjectionStateORM.graph_id == gid)
                        .values(served_commit_seq=None, **values))
        await s.commit()


async def _run_a_graph_published_before_the_column_keeps_serving() -> None:
    from backend.app.services.versioning.models import backfill_ps_served
    svc, fake = GraphVersioningService(), LiveFalkor()

    # The upgrade fills an idle row from its watermark.
    gid, proj, _graph = await _seed(svc, fake)
    await _forget_column(gid)
    assert await _serving(svc, gid) == (3, "falkordb", True), "served at its watermark meanwhile"
    async with db.get_engine().begin() as conn:
        await conn.run_sync(backfill_ps_served)
    assert await _stored(gid) == 3

    # A rebuild of a row the upgrade missed: the pass restores it from the key's marker before it
    # writes anything, so reads stay on the key, not on Postgres.
    gid, proj, graph = await _seed(svc, fake)
    probed = _ProbedGraph()
    probed.check = None
    name = next(n for n, g in fake.graphs.items() if g is graph)
    probed.nodes, probed.edges, probed._ids, probed.proj_meta = (graph.nodes, graph.edges,
                                                                 graph._ids, graph.proj_meta)
    fake.graphs[name] = probed
    assert await svc.request_projection_rebuild(gid)
    await _forget_column(gid)
    assert await _serving(svc, gid) == (None, "postgres", False), "what the upgrade can't fill"

    async def check():
        return await _serving(svc, gid)
    probed.check = check
    assert (await proj.project_graph(gid))["projected"] == 3
    assert probed.at_probe == [(3, "falkordb", False)], "restored from the marker first"
    assert await _serving(svc, gid) == (3, "falkordb", True)

    # Liveness fills an idle row whose key's marker says it holds its watermark.
    gid, proj, _graph = await _seed(svc, fake)
    await _forget_column(gid)
    assert await _ours(proj, gid) == []
    assert await _stored(gid) == 3
    await db.dispose_engine()


def test_a_graph_published_before_the_column_keeps_serving():
    asyncio.run(_run_a_graph_published_before_the_column_keeps_serving())


async def _run_a_held_back_full_replay_is_reconciled_in_place_not_reloaded(monkeypatch) -> None:
    from backend.app.services.versioning import residency_policy
    svc, fake = GraphVersioningService(), LiveFalkor()
    gid, proj, _graph = await _seed(svc, fake)

    async def on(session=None):
        return True
    monkeypatch.setattr(residency_policy, "switch_state", on)
    # A full replay a verify held back left the row idle at 0, its cursor cleared: with residency
    # on, the next pass used to queue it as a first seed, reloaded into a fresh key while reads
    # went to Postgres. The key still holds seq 3, so it is reconciled in place, serving 3.
    await _forget_column(gid, projected_commit_seq=0, status="idle")
    res = await proj.project_graph(gid)
    assert res.get("skipped") != "waiting_capacity", res
    assert res["projected"] == 3, res
    assert await _serving(svc, gid) == (3, "falkordb", True)
    await db.dispose_engine()


def test_a_held_back_full_replay_is_reconciled_in_place_not_reloaded(monkeypatch):
    asyncio.run(_run_a_held_back_full_replay_is_reconciled_in_place_not_reloaded(monkeypatch))


async def _run_a_graph_read_latest_goes_to_postgres_until_falkordb_holds_its_head(monkeypatch) -> None:
    from backend.app.services.system_status.probes import list_versioned_graphs
    from backend.app.services.versioning import build_policy

    platform = {"readMode": "in_place"}

    async def resolve(session=None):
        return build_policy.BuildPolicy({**build_policy.defaults().values, **platform})

    monkeypatch.setattr(build_policy, "resolve", resolve)
    svc, fake = GraphVersioningService(), LiveFalkor()
    gid, proj, _graph = await _seed(svc, fake)                 # projected at seq 3
    await _edit_publish(svc, gid, "a", _create("D"), "after the last pass")     # head 4

    # The platform's mode, in place: the key keeps serving seq 3.
    wm = await svc.projection_watermark(gid)
    assert (wm["served"], wm["read_route"]["main"], wm["read_mode"], wm["read_mode_source"]) == (
        3, "falkordb", "in_place", "platform")

    # The graph's own mode, always the latest: behind its head, its reads go to Postgres.
    assert await svc.set_read_mode(gid, "latest") == (True, None)
    wm = await svc.projection_watermark(gid)
    assert (wm["served"], wm["read_route"]["main"], wm["read_mode"], wm["read_mode_source"]) == (
        None, "postgres", "latest", "graph")
    listed = await list_versioned_graphs(provider=None, status=None, workspace_id=None,
                                         kind=None, q=gid, cursor=None, limit=5)
    assert [(g["readMode"], g["readModeEffective"]) for g in listed["graphs"]] == [
        ("latest", "latest")]

    # At its head, the key serves it again, as it does every mode.
    assert (await proj.project_graph(gid))["projected"] == 4
    assert await _serving(svc, gid) == (4, "falkordb", True)

    # Back to the platform's; the platform's own mode set to latest reads the same way.
    await _edit_publish(svc, gid, "a", _create("E"), "another")                  # head 5
    assert await svc.set_read_mode(gid, None) == (True, "latest")
    assert (await _serving(svc, gid))[:2] == (4, "falkordb")
    platform["readMode"] = "latest"
    wm = await svc.projection_watermark(gid)
    assert (wm["served"], wm["read_mode"], wm["read_mode_source"]) == (None, "latest", "platform")
    await db.dispose_engine()


def test_a_graph_read_latest_goes_to_postgres_until_falkordb_holds_its_head(monkeypatch):
    asyncio.run(_run_a_graph_read_latest_goes_to_postgres_until_falkordb_holds_its_head(monkeypatch))
