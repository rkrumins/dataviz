"""A deleted graph's way out — trash, restore, expiry, purge, retry — against a real Postgres.

* a trashed graph is gone to every reader; a restore brings it back until a purge is queued;
* a purge that fails half way still blocks the restore, and the reaper queues the same job again;
* the trash is told where the purge stands, and why it stopped: its failure, or the live forks;
* the purge cancels the graph's other jobs as it starts, and leaves no row of the graph behind;
* a purge that "Delete permanently" queued is revived although its data source row is gone;
* a graph that forks still read is never purged, whoever asks;
* a trashed fork is no reader, unless a fork of its own reads through it; the parent's purge
  takes it along, and a purge refused for forks is retried once they are gone;
* a trashed fork past its grace is purged by the reaper, which drops the fork's own key and
  never its parent's — a customer's;
* a restore that wins the race with the reaper keeps its graph, and so does a fork's restore
  that wins the race with its parent's purge; a fork made during a parent's purge loses.

The data-source rows the reaper reads live in the management database; they are faked here.
Unit level: ``test_purge_reaper_unit.py``.
"""
from __future__ import annotations

import asyncio
import os
from types import SimpleNamespace

import pytest
from sqlalchemy import func, select, text

from backend.app.services.versioning import config, db, models, purge_worker
from backend.app.services.versioning.errors import ForkNotRestorable
from backend.app.services.versioning.job_lease import Lease
from backend.app.services.versioning.models import GraphORM, JobORM
from backend.app.services.versioning.purge_worker import (
    PurgeRefused,
    PurgeRunner,
    Reaper,
    create_purge_job,
    PurgeState,
    purge_state_for_data_source,
    restore_graphs_for_data_source,
    tombstone_graphs_for_data_source,
)
from backend.app.services.versioning.service import GraphVersioningService
from backend.tests.integration.test_versioning_projection import _edit_publish, _node

pytestmark = pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"),
                                reason="set GRAPHVER_E2E=1 + a live Postgres to run")

WS = "ws_purge"


@pytest.fixture(autouse=True)
async def _schema(monkeypatch):
    await models.create_schema_and_partitions()
    monkeypatch.setattr(Reaper, "_orphaned_package_sources", _no_orphans)
    yield
    await db.dispose_engine()


async def _no_orphans(_self):
    return 0


async def _nobody(*_a):
    return []


def _runner() -> PurgeRunner:
    # No FalkorDB here: the graph is never projected, and nothing else reads its key.
    return PurgeRunner(None, key_in_use=_nobody)


class _Rows:
    def __init__(self, rows):
        self._rows = rows

    def all(self):
        return list(self._rows)


def _app(expired):
    """The management database's data-source rows: ``expired`` are past their grace."""
    gone = []

    class _Session:
        async def execute(self, _stmt):
            return _Rows([(ds, WS, "alice") for ds in expired])

        async def get(self, _model, ident):
            if ident in expired and ident not in gone:
                return SimpleNamespace(id=ident, deleted_at="2020-01-01T00:00:00+00:00")
            return None

        async def delete(self, row):
            gone.append(row.id)

        async def commit(self):
            pass

    def sessions():
        return _Ctx(_Session())

    return sessions, gone


class _Ctx:
    def __init__(self, s):
        self._s = s

    async def __aenter__(self):
        return self._s

    async def __aexit__(self, *_exc):
        return False


async def _graph(svc, *, published=True, **kw):
    ds = "ds_purge_" + os.urandom(4).hex()
    gid = (await svc.create_graph(data_source_id=ds, workspace_id=WS, actor="alice",
                                  **kw))["graph_id"]
    if published:
        await _edit_publish(svc, gid, "alice", [
            {"op": "create", "entity_kind": "node", "entity_id": "A", "payload": _node("Alpha")},
            {"op": "create", "entity_kind": "node", "entity_id": "B", "payload": _node("Beta")},
        ], "seed")
    return ds, gid


async def _take(job_id) -> Lease:
    async with db.graphver_session() as s:
        job = await s.get(JobORM, job_id)
        job.retry_count += 1
        job.status = "running"
        job.updated_at = models._now()
        return Lease(job_id=job.id, job_type=job.job_type, epoch=job.retry_count,
                     workspace_id=job.workspace_id, graph_id=job.graph_id)


async def _job(job_id):
    async with db.graphver_session() as s:
        return await s.get(JobORM, job_id)


async def _purges(gid):
    async with db.graphver_session() as s:
        return (await s.execute(select(JobORM).where(
            JobORM.job_type == "purge", JobORM.graph_id == gid))).scalars().all()


async def _rows_of(gid, table):
    async with db.graphver_session() as s:
        return int(await s.scalar(text(
            f'SELECT count(*) FROM "{purge_worker._sch()}"."{table}" WHERE graph_id = :g'),
            {"g": gid}))


def _boom_on_nodes(monkeypatch, seen=None):
    """Fail the purge, once, as it reaches node_versions — not a transient fault, so it is
    recorded rather than waited out."""
    original = PurgeRunner._delete_window
    fired = []

    async def window(self, lease, graph_id, table, pk):
        if table == "node_versions" and not fired:
            fired.append(1)
            if seen is not None:
                await seen()
            raise RuntimeError("boom")
        return await original(self, lease, graph_id, table, pk)

    monkeypatch.setattr(PurgeRunner, "_delete_window", window)


async def test_tombstone_restore_expire_purge_retry(monkeypatch):
    svc = GraphVersioningService()
    ds, gid = await _graph(svc)

    # 1. Trash, then undo.
    assert await tombstone_graphs_for_data_source(data_source_id=ds, workspace_id=WS,
                                                  actor="alice") == 1
    assert await restore_graphs_for_data_source(data_source_id=ds, workspace_id=WS) == PurgeState()
    assert await svc.get_graph(gid) is not None

    # 2. Trash again: the graph is gone to every reader.
    await tombstone_graphs_for_data_source(data_source_id=ds, workspace_id=WS, actor="alice")
    assert await svc.get_graph(gid) is None

    # 3. A job of the graph's still queued.
    async with db.graphver_session() as s:
        export = JobORM(job_type="export", graph_id=gid, workspace_id=WS, data_source_id=ds,
                        status="pending")
        s.add(export)
        await s.flush()
        export_id = export.id

    # 4. The grace runs out: the reaper queues the purge, and restore is now refused.
    app, gone = _app([ds])
    out = await Reaper(app_session_factory=app).run_once()
    assert out["queued"] == 1 and gone == []
    (purge,) = await _purges(gid)
    queued = PurgeState("queued", final=True)
    assert await restore_graphs_for_data_source(data_source_id=ds, workspace_id=WS) == queued
    assert await purge_state_for_data_source(data_source_id=ds) == queued

    # 5. The purge fails half way. By then its count phase has cancelled the export.
    states = []

    async def export_state():
        states.append((await _job(export_id)).status)

    _boom_on_nodes(monkeypatch, export_state)
    assert (await _runner().run_job(await _take(purge.id)))["status"] == "failed"
    assert states == ["cancelled"]
    failed = await _job(purge.id)
    assert (failed.status, failed.current_phase) == ("failed", "nodes")
    assert failed.summary["failure"]["code"] == "infrastructure"

    # 6. Half a graph is past the point of no return, and the trash says why it stopped.
    stopped = PurgeState("failed", "boom", final=True)
    assert await restore_graphs_for_data_source(data_source_id=ds, workspace_id=WS) == stopped
    assert await purge_state_for_data_source(data_source_id=ds) == stopped

    # 7. The reaper queues the SAME job again, from where it stopped (a regression guard).
    await Reaper(app_session_factory=app).run_once()
    again = await _job(purge.id)
    assert (again.status, again.current_phase) == ("pending", "nodes")
    assert [j.id for j in await _purges(gid)] == [purge.id]

    # 8. It finishes, and nothing of the graph is left but the purge's own receipt.
    assert (await _runner().run_job(await _take(purge.id)))["status"] == "completed"
    async with db.graphver_session() as s:
        assert await s.get(GraphORM, gid) is None
        assert await s.get(JobORM, export_id) is None
    for table in [t for t, _ in purge_worker._BULK] + ["branches", "projection_state"]:
        assert await _rows_of(gid, table) == 0, table

    # 9. The next pass removes the data source row.
    out = await Reaper(app_session_factory=app).run_once()
    assert out["reaped"] == 1 and gone == [ds]


async def test_a_failed_permanent_purge_is_revived_without_its_data_source(monkeypatch):
    svc = GraphVersioningService()
    _ds, gid = await _graph(svc)
    job_id = await create_purge_job(graph_id=gid, workspace_id=WS, actor="alice")
    _boom_on_nodes(monkeypatch)
    assert (await _runner().run_job(await _take(job_id)))["status"] == "failed"

    app, _ = _app([])                              # "Delete permanently" removed the row
    out = await Reaper(app_session_factory=app).run_once()
    assert out["revived"] >= 1
    assert (await _job(job_id)).status == "pending"


async def test_a_graph_that_forks_read_is_never_purged():
    svc = GraphVersioningService()
    ds, gid = await _graph(svc)
    await svc.fork_graph(parent_graph_id=gid, workspace_id=WS, actor="bob")
    await tombstone_graphs_for_data_source(data_source_id=ds, workspace_id=WS, actor="alice")
    blocked = PurgeState("blocked", "1 fork(s) still read this graph's history", forks=1)
    assert await purge_state_for_data_source(data_source_id=ds) == blocked

    with pytest.raises(PurgeRefused) as exc:
        await create_purge_job(graph_id=gid, workspace_id=WS, actor="alice")
    assert exc.value.code == "live_forks"
    assert await create_purge_job(graph_id=gid, workspace_id=WS, actor="reaper",
                                  require_tombstoned=True) is None
    assert await _purges(gid) == []

    # A purge queued some other way refuses at its count, and deletes nothing.
    nodes = await _rows_of(gid, "node_versions")
    async with db.graphver_session() as s:
        job = JobORM(job_type="purge", graph_id=gid, workspace_id=WS, data_source_id=ds,
                     status="pending", current_phase="count", idempotency_key=f"purge:{gid}",
                     summary={"actor": "test"})
        s.add(job)
        await s.flush()
        job_id = job.id
    assert (await _runner().run_job(await _take(job_id)))["status"] == "failed"
    refused = await _job(job_id)
    assert refused.summary["failure"]["code"] == "live_forks"
    assert await _rows_of(gid, "node_versions") == nodes > 0
    # Still blocked by the forks, not "failed"; and, a purge job now standing, not restorable.
    assert await purge_state_for_data_source(data_source_id=ds) == PurgeState(
        "blocked", "1 fork(s) still read this graph's history", forks=1, final=True)

    # The reaper does not re-run a refusal while the fork still reads the graph.
    app, _ = _app([])
    await Reaper(app_session_factory=app).run_once()
    assert (await _job(job_id)).status == "failed"


async def test_a_restore_holding_the_graph_wins_the_race_with_the_reaper():
    svc = GraphVersioningService()
    ds, gid = await _graph(svc)
    await tombstone_graphs_for_data_source(data_source_id=ds, workspace_id=WS, actor="alice")

    async with db.graphver_session() as s1:          # commits on exit
        g = (await s1.execute(select(GraphORM).where(GraphORM.id == gid)
                              .with_for_update())).scalars().one()
        g.deleted_at = g.deleted_by = None
        await s1.flush()
        reaper = asyncio.create_task(create_purge_job(
            graph_id=gid, workspace_id=WS, actor="reaper", require_tombstoned=True))
        await asyncio.sleep(0.3)
        assert not reaper.done(), "the reaper must wait for the graph row the restore holds"

    assert await reaper is None
    assert await _purges(gid) == []
    assert await svc.get_graph(gid) is not None


async def test_the_reaper_skips_a_graph_restored_mid_pass(monkeypatch):
    svc = GraphVersioningService()
    ds, gid = await _graph(svc)
    await tombstone_graphs_for_data_source(data_source_id=ds, workspace_id=WS, actor="alice")
    original = purge_worker.purge_graph_for_data_source

    async def restored_first(**kw):
        assert not (await restore_graphs_for_data_source(data_source_id=ds,
                                                         workspace_id=WS)).final
        return await original(**kw)

    monkeypatch.setattr(purge_worker, "purge_graph_for_data_source", restored_first)
    app, gone = _app([ds])
    out = await Reaper(app_session_factory=app).run_once()

    assert out["queued"] == 0 and gone == []
    assert await _purges(gid) == []
    assert await svc.get_graph(gid) is not None


async def test_an_abandoned_enablement_does_not_block_a_later_restore():
    """Regression guard: abandoning an enablement purges its graph and leaves the data source
    live. Trashing that data source later must still be undoable."""
    svc = GraphVersioningService()
    ds, gid = await _graph(svc, published=False)
    job_id = await create_purge_job(graph_id=gid, workspace_id=WS, actor="alice",
                                    data_source_id=ds)
    assert (await _runner().run_job(await _take(job_id)))["status"] == "completed"

    assert await restore_graphs_for_data_source(data_source_id=ds, workspace_id=WS) == PurgeState()
    assert await purge_state_for_data_source(data_source_id=ds) == PurgeState()
    async with db.graphver_session() as s:
        assert int(await s.scalar(select(func.count()).select_from(GraphORM).where(
            GraphORM.data_source_id == ds))) == 0


async def _fork(svc, gid, actor="bob"):
    """A fork of ``gid``, and its minted data-source id: the handle a fork is trashed by."""
    fid = (await svc.fork_graph(parent_graph_id=gid, workspace_id=WS, actor=actor))["graph_id"]
    return fid, (await svc.get_graph(fid))["data_source_id"]


async def _trash(ds):
    assert await tombstone_graphs_for_data_source(data_source_id=ds, workspace_id=WS,
                                                  actor="alice") == 1


async def _row(gid):
    async with db.graphver_session() as s:
        return await s.get(GraphORM, gid)


async def test_a_parent_purge_ignores_a_trashed_fork_and_takes_it_along():
    svc = GraphVersioningService()
    ds, gid = await _graph(svc)
    fid, fds = await _fork(svc, gid)
    await svc.delete_fork(graph_id=fid, workspace_id=WS, actor="bob")
    await _trash(ds)

    assert await purge_state_for_data_source(data_source_id=ds) == PurgeState()
    job_id = await create_purge_job(graph_id=gid, workspace_id=WS, actor="alice")
    assert job_id
    (fork_job,) = await _purges(fid)
    assert fork_job.summary["parentGraphId"] == gid
    # The fork's purge is queued: past the point of no return, so either restore is refused.
    with pytest.raises(ForkNotRestorable):
        await svc.restore_fork(graph_id=fid, workspace_id=WS)
    assert (await restore_graphs_for_data_source(data_source_id=fds, workspace_id=WS)).final
    assert (await _row(fid)).deleted_at is not None

    for jid in (job_id, fork_job.id):
        assert (await _runner().run_job(await _take(jid)))["status"] == "completed"
    assert await _row(gid) is None and await _row(fid) is None


async def test_a_trashed_fork_that_another_fork_reads_still_holds_its_parent():
    svc = GraphVersioningService()
    ds, gid = await _graph(svc)
    f1, f1ds = await _fork(svc, gid)
    f2, f2ds = await _fork(svc, f1)
    await _trash(f1ds)                       # trashed under its live fork: the legacy path
    await _trash(ds)

    with pytest.raises(PurgeRefused) as exc:
        await create_purge_job(graph_id=gid, workspace_id=WS, actor="alice")
    assert exc.value.code == "live_forks"
    assert await purge_state_for_data_source(data_source_id=ds) == PurgeState(
        "blocked", "1 fork(s) still read this graph's history", forks=1)

    await _trash(f2ds)
    f2_job = await create_purge_job(graph_id=f2, workspace_id=WS, actor="alice")
    assert (await _runner().run_job(await _take(f2_job)))["status"] == "completed"

    assert await create_purge_job(graph_id=gid, workspace_id=WS, actor="alice")
    (f1_job,) = await _purges(f1)
    assert f1_job.summary["parentGraphId"] == gid


async def test_a_fork_row_held_by_a_restore_wins_against_the_parent_purge():
    svc = GraphVersioningService()
    ds, gid = await _graph(svc)
    fid, fds = await _fork(svc, gid)
    await _trash(fds)
    await _trash(ds)

    async with db.graphver_session() as s1:          # commits on exit
        f = (await s1.execute(select(GraphORM).where(GraphORM.id == fid)
                              .with_for_update())).scalars().one()
        f.deleted_at = f.deleted_by = None
        await s1.flush()
        purge = asyncio.create_task(create_purge_job(graph_id=gid, workspace_id=WS,
                                                     actor="alice"))
        await asyncio.sleep(0.3)
        assert not purge.done(), "the parent's purge must wait for the fork row a restore holds"

    with pytest.raises(PurgeRefused) as exc:
        await purge
    assert exc.value.code == "live_forks"
    assert await _purges(fid) == [] and await _purges(gid) == []


async def test_a_live_forks_refusal_is_retried_once_the_fork_is_deleted():
    svc = GraphVersioningService()
    ds, gid = await _graph(svc)
    fid, _fds = await _fork(svc, gid)
    await _trash(ds)
    async with db.graphver_session() as s:
        job = JobORM(job_type="purge", graph_id=gid, workspace_id=WS, data_source_id=ds,
                     status="pending", current_phase="count", idempotency_key=f"purge:{gid}",
                     summary={"actor": "test"})
        s.add(job)
        await s.flush()
        job_id = job.id
    assert (await _runner().run_job(await _take(job_id)))["status"] == "failed"
    assert (await _job(job_id)).summary["failure"]["code"] == "live_forks"

    await svc.delete_fork(graph_id=fid, workspace_id=WS, actor="bob")
    app, _ = _app([])
    await Reaper(app_session_factory=app).run_once()
    assert (await _job(job_id)).status == "pending"
    (fork_job,) = await _purges(fid)
    assert fork_job.summary["parentGraphId"] == gid
    assert (await _runner().run_job(await _take(job_id)))["status"] == "completed"
    assert await _row(gid) is None


async def test_the_reaper_purges_an_expired_trashed_fork_dropping_only_its_own_key():
    svc = GraphVersioningService()
    key = "cust_" + os.urandom(4).hex()           # the customer's graph: pinned, not ours
    _ds, gid = await _graph(svc, falkor_graph_name=key, owns_falkor_graph=False)
    fid, _ = await _fork(svc, gid)
    kept, _ = await _fork(svc, gid)
    for f in (fid, kept):
        await svc.delete_fork(graph_id=f, workspace_id=WS, actor="bob")
    async with db.graphver_session() as s:          # fid's grace ran out; kept's has not
        (await s.get(GraphORM, fid)).deleted_at = purge_worker._now_minus(
            (config.PURGE_GRACE_DAYS + 1) * 86400)

    app, _ = _app([])
    assert (await Reaper(app_session_factory=app).run_once())["queued"] >= 1
    (job,) = await _purges(fid)
    assert await _purges(kept) == [] and await _purges(gid) == []

    dropped = []

    class _Key:
        def __init__(self, name):
            self.name = name

        async def delete(self):
            dropped.append(self.name)

    runner = PurgeRunner(lambda name, provider_id=None: _Key(name), key_in_use=_nobody)
    assert (await runner.run_job(await _take(job.id)))["status"] == "completed"
    assert dropped == [f"{key}__fork_{fid}"]

    assert await _row(gid) is not None and await _row(kept) is not None
    assert await _rows_of(gid, "node_versions") > 0
    assert await _rows_of(gid, "projection_state") == 1
    for table in [t for t, _ in purge_worker._BULK] + ["branches", "projection_state"]:
        assert await _rows_of(fid, table) == 0, table


async def test_a_fork_waits_for_and_loses_to_a_parent_purge_being_queued():
    svc = GraphVersioningService()
    _ds, gid = await _graph(svc)

    async with db.graphver_session() as s1:          # commits on exit
        g = (await s1.execute(select(GraphORM).where(GraphORM.id == gid)
                              .with_for_update())).scalars().one()
        g.deleted_at, g.deleted_by = models._now(), "alice"
        await s1.flush()
        fork = asyncio.create_task(svc.fork_graph(parent_graph_id=gid, workspace_id=WS,
                                                  actor="bob"))
        await asyncio.sleep(0.3)
        assert not fork.done(), "a fork must wait for the parent row a purge holds"

    with pytest.raises(ValueError):
        await fork
    async with db.graphver_session() as s:
        assert int(await s.scalar(select(func.count()).select_from(GraphORM).where(
            GraphORM.fork_parent_graph_id == gid))) == 0
