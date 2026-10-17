"""Projection liveness and the operator's watermark reset, against Postgres (FakeFalkor for the
cache, with ``ro_query`` and a key that can go missing).

* A key dropped out of band resets the idle graph's watermark to 0; the poll reseeds it.
* A key restored to an older state (its marker behind the watermark) resets to the marker's seq;
  the next pass re-applies the lost window.
* A healthy key, an unreachable one and an unmarked one are left alone, as are tombstoned graphs,
  graphs still being enabled for version control, and graphs at genesis.
* A pass that claims the row between liveness's read and its reset wins: the reset does not land.
* ``reset_projection_watermarks`` resets exactly the provider's live, pinned, projected graphs, to
  ``reseeding`` rather than to an error, and its dry run counts the same graphs. A graph parked at
  genesis on a key it does not own is left alone: the key is its data source's own graph.

Needs ``GRAPHVER_E2E=1`` and Postgres.
"""
import asyncio
import copy
import os

import pytest
from sqlalchemy import update

from backend.app.services.versioning import db, models, projection
from backend.app.services.versioning.models import GraphORM, JobORM, ProjectionStateORM
from backend.app.services.versioning.projection import FalkorProjector
from backend.app.services.versioning.service import GraphVersioningService

from backend.tests.integration.test_versioning_projection import (
    FakeFalkor,
    FakeGraph,
    _Result,
    _assert_matches_main,
    _edit_publish,
    _node,
)

pytestmark = pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"),
                                reason="set GRAPHVER_E2E=1 + a live Postgres to run")


class _Missing(Exception):
    pass


class LiveGraph(FakeGraph):
    """A FakeGraph that answers GRAPH.RO_QUERY like FalkorDB: a missing key raises, and only a
    write (GRAPH.QUERY) creates it again."""

    def __init__(self):
        super().__init__()
        self.exists = True
        self.unreachable = False
        self.on_marker_read = None

    async def ro_query(self, cypher, params=None, timeout=None):
        if self.unreachable:
            raise ConnectionError("connection refused")
        if not self.exists:
            raise _Missing("Invalid graph operation on empty key")
        if cypher == projection._MARKER_READ:
            if self.on_marker_read is not None:
                await self.on_marker_read()
            return _Result([[self.proj_meta["seq"]]] if self.proj_meta else [])
        return await super().query(cypher, params)

    async def query(self, cypher, params=None):
        self.exists = True
        return await super().query(cypher, params)

    def drop(self):
        """GRAPH.DELETE behind the platform's back."""
        self.nodes.clear()
        self.edges.clear()
        self._ids.clear()
        self.proj_meta = {}
        self.exists = False


class LiveFalkor(FakeFalkor):
    """Only this test's keys answer RO_QUERY; every other graph in the store gets a plain fake,
    which liveness cannot read and leaves alone."""

    def __init__(self):
        super().__init__()
        self.ours: set = set()

    def __call__(self, name, provider_id=None):
        if name in self.ours:
            return self.graphs.setdefault(name, LiveGraph())
        return FakeGraph()


def _create(entity_id: str) -> list:
    return [{"op": "create", "entity_kind": "node", "entity_id": entity_id,
             "payload": _node(entity_id)}]


async def _seed(svc, fake: LiveFalkor, *, provider=None) -> tuple:
    """A pinned graph projected at seq 3 (genesis is 1). Returns ``(graph_id, projector, graph)``."""
    await models.create_schema_and_partitions()
    name = "gvl_" + os.urandom(4).hex()
    fake.ours.add(name)
    gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                                  actor="a", falkor_graph_name=name, falkor_provider=provider,
                                  owns_falkor_graph=True))["graph_id"]
    proj = FalkorProjector(graph_client_factory=fake)
    await _edit_publish(svc, gid, "a", _create("A") + _create("B"), "seed")
    await proj.project_graph(gid)
    await _edit_publish(svc, gid, "a", _create("C"), "more")
    await proj.project_graph(gid)
    row = await _row(gid)
    assert (row["projected"], row["status"]) == (3, "idle"), row
    return gid, proj, fake.graphs[name]


async def _row(gid: str) -> dict:
    async with db.graphver_session() as s:
        ps = await s.get(ProjectionStateORM, gid)
        return {"projected": ps.projected_commit_seq, "status": ps.status, "epoch": ps.epoch,
                "last_error": ps.last_error, "failed_attempts": ps.failed_attempts}


async def _ours(proj, gid: str) -> list:
    return [r for r in await proj.check_liveness() if r["graph_id"] == gid]


async def _run_a_dropped_key_is_reseeded() -> None:
    svc, fake = GraphVersioningService(), LiveFalkor()
    gid, proj, graph = await _seed(svc, fake)
    before = await _row(gid)

    graph.drop()
    assert [r["reset_to"] for r in await _ours(proj, gid)] == [0]
    row = await _row(gid)
    assert row["projected"] == 0 and row["epoch"] == before["epoch"] + 1, row
    assert row["last_error"] == "liveness: projection key missing", row
    # The watermark names the reset as a liveness failure, until a pass clears it.
    assert (await svc.projection_watermark(gid))["liveness_error"] == row["last_error"]
    assert await _ours(proj, gid) == [], "a second sweep must not reset it again"

    assert (await proj.project_graph(gid))["projected"] == 3
    assert (await svc.projection_watermark(gid))["liveness_error"] is None
    await _assert_matches_main(svc, fake, gid)
    assert graph.proj_meta["seq"] == 3
    await db.dispose_engine()


def test_a_dropped_key_is_reseeded():
    asyncio.run(_run_a_dropped_key_is_reseeded())


async def _run_a_restored_key_rewinds_to_its_marker() -> None:
    svc, fake = GraphVersioningService(), LiveFalkor()
    gid, proj, graph = await _seed(svc, fake)
    snapshot = copy.deepcopy((graph.nodes, graph.edges, graph._ids, graph.proj_meta))
    await _edit_publish(svc, gid, "a", _create("D"), "after the snapshot")
    assert (await proj.project_graph(gid))["projected"] == 4

    graph.nodes, graph.edges, graph._ids, graph.proj_meta = snapshot   # an RDB from seq 3
    assert [r["reset_to"] for r in await _ours(proj, gid)] == [3]
    row = await _row(gid)
    assert row["projected"] == 3 and row["last_error"] == "liveness: marker seq 3 < projected 4"

    r = await proj.project_graph(gid)
    assert r["projected"] == 4 and r.get("applied"), r          # the window (3, 4], not a reseed
    await _assert_matches_main(svc, fake, gid)
    await db.dispose_engine()


def test_a_restored_key_rewinds_to_its_marker():
    asyncio.run(_run_a_restored_key_rewinds_to_its_marker())


async def _run_what_liveness_leaves_alone() -> None:
    svc, fake = GraphVersioningService(), LiveFalkor()

    healthy, proj, _ = await _seed(svc, fake)

    unreachable, _, g = await _seed(svc, fake)
    g.unreachable = True

    unmarked, _, g = await _seed(svc, fake)
    g.proj_meta = {}                       # projected before markers existed

    deleted, _, g = await _seed(svc, fake)
    g.drop()
    async with db.graphver_session() as s:
        (await s.get(GraphORM, deleted)).deleted_at = models._now()

    bootstrapping, _, g = await _seed(svc, fake)
    g.drop()
    async with db.graphver_session() as s:
        s.add(JobORM(job_type="bootstrap", graph_id=bootstrapping, workspace_id="ws1",
                     status="running"))

    genesis, _, g = await _seed(svc, fake)
    g.drop()
    async with db.graphver_session() as s:
        (await s.get(ProjectionStateORM, genesis)).projected_commit_seq = 1

    ids = (healthy, unreachable, unmarked, deleted, bootstrapping, genesis)
    before = {gid: await _row(gid) for gid in ids}
    reset = {r["graph_id"] for r in await proj.check_liveness()}
    assert not reset & set(ids), reset & set(ids)
    assert {gid: await _row(gid) for gid in ids} == before
    await db.dispose_engine()


def test_what_liveness_leaves_alone():
    asyncio.run(_run_what_liveness_leaves_alone())


async def _run_a_pass_that_claims_first_wins() -> None:
    svc, fake = GraphVersioningService(), LiveFalkor()
    gid, proj, graph = await _seed(svc, fake)

    async def claim():                     # a pass takes the row between the read and the reset
        async with db.graphver_session() as s:
            await s.execute(update(ProjectionStateORM)
                            .where(ProjectionStateORM.graph_id == gid)
                            .values(epoch=ProjectionStateORM.epoch + 1))

    graph.on_marker_read = claim
    graph.proj_meta = {"seq": 2, "epoch": 0}   # a marker behind the watermark
    before = await _row(gid)
    assert await _ours(proj, gid) == []
    row = await _row(gid)
    assert row["projected"] == 3 and row["epoch"] == before["epoch"] + 1, row
    await db.dispose_engine()


def test_a_pass_that_claims_first_wins():
    asyncio.run(_run_a_pass_that_claims_first_wins())


async def _run_the_operator_reset_is_scoped_to_a_provider() -> None:
    svc, fake = GraphVersioningService(), LiveFalkor()
    provider, other = "p_" + os.urandom(4).hex(), "p_" + os.urandom(4).hex()
    mine, proj, _ = await _seed(svc, fake, provider=provider)
    theirs, _, _ = await _seed(svc, fake, provider=other)
    deleted, _, _ = await _seed(svc, fake, provider=provider)
    bootstrapping, _, _ = await _seed(svc, fake, provider=provider)
    async with db.graphver_session() as s:
        (await s.get(GraphORM, deleted)).deleted_at = models._now()
        s.add(JobORM(job_type="bootstrap", graph_id=bootstrapping, workspace_id="ws1",
                     status="failed"))
    parked = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(),
                                     workspace_id="ws1", actor="a",
                                     falkor_graph_name="orders_" + os.urandom(4).hex(),
                                     falkor_provider=provider))["graph_id"]
    assert (await _row(parked))["projected"] == 1
    before = {gid: await _row(gid) for gid in (mine, theirs, deleted, bootstrapping, parked)}

    # The confirm dialog's count: the same graphs, and nothing changes.
    assert await svc.reset_projection_watermarks(provider=provider, actor="usr_admin",
                                                 dry_run=True) == [mine]
    assert await _row(mine) == before[mine]

    assert await svc.reset_projection_watermarks(provider=provider, actor="usr_admin") == [mine]
    row = await _row(mine)
    assert row["projected"] == 0 and row["epoch"] == before[mine]["epoch"] + 1, row
    # Reseeding, not failed: no error is recorded.
    assert (row["status"], row["last_error"]) == ("reseeding", None), row
    for gid in (theirs, deleted, bootstrapping, parked):
        assert await _row(gid) == before[gid], gid

    await proj.project_graph(mine)
    row = await _row(mine)
    assert (row["projected"], row["status"], row["last_error"]) == (3, "idle", None), row
    await db.dispose_engine()


def test_the_operator_reset_is_scoped_to_a_provider():
    asyncio.run(_run_the_operator_reset_is_scoped_to_a_provider())
