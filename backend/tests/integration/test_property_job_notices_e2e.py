"""The person who started a bulk property job hears what became of it — against Postgres.

Real jobs on a real draft, ended every way a job ends — run to the end, failed by its worker,
stopped by someone else or by its owner, undone — and the notices sweep (``job_notices``) run over
them, as the transfer lane runs it every minute:

* the owner is told, once each, of a job that completed after a minute or more (an undo too, as an
  undo), one that failed and one someone else stopped — linked to the draft in its view;
* not of one that completed quickly, nor of their own stop, nor of one that ended over an hour ago;
* a sweep that dies between telling and stamping tells nobody twice, two sweeps at once tell each
  person once, and a sweep takes at most ``BATCH`` jobs, by ``ix_jobs_property_unnotified``;
* the migration builds that index concurrently, and builds it again over one a stopped build left;
  a store alembic never reaches gets it at start-up.
"""
import asyncio
import importlib.util
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from sqlalchemy import select, text, update
from sqlalchemy.dialects import postgresql

from backend.app.services.versioning import db, models
from backend.app.services.versioning.import_export import job_notices
from backend.app.services.versioning.import_export.import_worker import lease_job
from backend.app.services.versioning.import_export.job_notices import JobNotices
from backend.app.services.versioning.import_export.service import ImportExportService
from backend.app.services.versioning.service import GraphVersioningService

pytestmark = pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"),
                                reason="set GRAPHVER_E2E=1 + a live Postgres to run")

SET = {"kind": "set", "key": "owner", "value": "ops"}
IDS = {"ids": [f"urn:n{i}" for i in range(4)]}


def _ago(secs: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(seconds=secs)).isoformat()


async def _setup():
    """A graph of four nodes on main, a draft of it opened from a view called Sales."""
    from backend.app.db.engine import get_async_session
    from backend.app.db.models import ViewORM, WorkspaceORM

    await models.create_schema_and_partitions()
    view = "view_" + os.urandom(4).hex()
    async with get_async_session() as m:
        if await m.get(WorkspaceORM, "ws1") is None:
            m.add(WorkspaceORM(id="ws1", name="Notices"))
            await m.flush()
        m.add(ViewORM(id=view, name="Sales", workspace_id="ws1"))
    svc = GraphVersioningService()
    ds = "ds_" + os.urandom(4).hex()
    gid = (await svc.create_graph(data_source_id=ds, workspace_id="ws1", actor="alice"))["graph_id"]
    await svc.apply_ops(graph_id=gid, actor="alice", message="seed", ops=[
        {"op": "create", "entity_kind": "node", "entity_id": f"N{i}",
         "payload": {"urn": f"urn:n{i}", "entityType": "Dataset", "displayName": f"N{i}",
                     "properties": {"owner": f"o{i}"}}} for i in range(4)])
    draft = await svc.open_draft(graph_id=gid, owner="alice", originating_view_id=view)
    return svc, ImportExportService(versioning=svc), ds, gid, draft, view


async def _job(ie, ds, gid, draft, key, *, cancel_by=None, op=SET):
    job_id = (await ie.create_property_job(workspace_id="ws1", data_source_id=ds, graph_id=gid,
                                           branch_id=draft, actor="alice", op=op, target=IDS,
                                           message=None, key=key))["job_id"]
    if cancel_by:
        assert await ie.cancel_property_job(job_id, actor=cancel_by)
    return job_id


async def _set(job_id, **values):
    async with db.graphver_session() as s:
        await s.execute(update(models.JobORM).where(models.JobORM.id == job_id).values(**values))


async def _waited(job_id, secs=90):
    """As though it was asked for ``secs`` before it ended."""
    async with db.graphver_session() as s:
        done = await s.scalar(select(models.JobORM.completed_at).where(models.JobORM.id == job_id))
    await _set(job_id, created_at=(datetime.fromisoformat(done) - timedelta(seconds=secs)).isoformat())


async def _told(*job_ids):
    """{job id: [(kind, user, title, link, actor)]}"""
    from backend.app.db.engine import get_async_session
    from backend.app.db.models import NotificationORM

    async with get_async_session() as m:
        rows = (await m.execute(select(NotificationORM).where(
            NotificationORM.resource_type == "property_job",
            NotificationORM.resource_id.in_(job_ids)))).scalars().all()
    out = {j: [] for j in job_ids}
    for r in rows:
        out[r.resource_id].append((r.kind, r.user_id, r.title, r.link, r.actor_id))
    return out


async def _stamped(*job_ids):
    async with db.graphver_session() as s:
        rows = (await s.execute(select(models.JobORM.id, models.JobORM.summary).where(
            models.JobORM.id.in_(job_ids)))).all()
    return {r.id: bool((r.summary or {}).get("notifiedAt")) for r in rows}


async def _drain():
    """Every recent job a run before this one left unstamped, looked at."""
    while (await JobNotices().run_once())["looked"]:
        pass


async def _notices_run(monkeypatch) -> None:
    svc, ie, ds, gid, draft, view = await _setup()
    await _drain()

    long_ = await _job(ie, ds, gid, draft, "key-notices-long")
    await ie.run_property(long_)
    await _waited(long_)
    quick = await _job(ie, ds, gid, draft, "key-notices-quick")
    await ie.run_property(quick)

    failed = await _job(ie, ds, gid, draft, "key-notices-failed", op={**SET, "value": "eng"})

    async def boom(**_kw):
        raise ValueError("boom: the write was refused")
    monkeypatch.setattr(svc, "apply_ops", boom)
    await ie.run_property_safe(failed, await lease_job(failed))
    monkeypatch.undo()

    by_bob = await _job(ie, ds, gid, draft, "key-notices-bob", cancel_by="bob")
    own = await _job(ie, ds, gid, draft, "key-notices-own", cancel_by="alice")
    old = await _job(ie, ds, gid, draft, "key-notices-old", cancel_by="bob")
    await _set(old, completed_at=_ago(2 * 3600))           # ended before the sweep's hour

    undo = (await ie.create_undo_job(workspace_id="ws1", data_source_id=ds, graph_id=gid,
                                     job_id=long_, actor="alice", key="key-notices-undo"))["job_id"]
    await ie.run_property(undo)
    await _waited(undo)
    assert [(await ie.get_property_job(j))["status"] for j in (long_, quick, failed, undo)] == \
        ["completed", "completed", "failed", "completed"]

    assert await JobNotices().run_once() == {"looked": 6, "told": 4}
    told = await _told(long_, quick, failed, by_bob, own, old, undo)
    where = f"/views/{view}?branch={draft}"
    assert told[long_] == [("property_job_completed", "alice",
                            "Set owner finished on 4 entities in your Sales draft", where, None)]
    assert told[undo] == [("property_job_completed", "alice",
                           "Undo of “Set owner” finished: 4 entities put back in your Sales draft",
                           where, None)]
    assert told[failed] == [("property_job_failed", "alice",
                             "Set owner failed: boom: the write was refused", where, None)]
    assert told[by_bob] == [("property_job_cancelled", "alice",
                             "Set owner was stopped in your Sales draft", where, "bob")]
    assert told[quick] == told[own] == told[old] == []
    assert await _stamped(long_, quick, failed, by_bob, own, old, undo) == {
        long_: True, quick: True, failed: True, by_bob: True, own: True, old: False, undo: True}
    # Old jobs — this one, and whatever earlier runs left on this database — are never announced.
    async with db.graphver_session() as s:
        assert await s.scalar(text(
            "SELECT count(*) FROM graphver.jobs WHERE job_type = 'property' AND completed_at < :cut "
            "AND summary ->> 'notifiedAt' IS NOT NULL"), {"cut": _ago(3600)}) == 0

    # Told once: the next sweep finds nothing left to look at.
    assert await JobNotices().run_once() == {"looked": 0, "told": 0}
    assert sum(len(v) for v in (await _told(long_, failed, by_bob, undo)).values()) == 4

    # A sweep that dies between telling and stamping: the next one tells nobody again.
    crash = await _job(ie, ds, gid, draft, "key-notices-crash", cancel_by="bob")
    monkeypatch.setattr(job_notices, "_STAMP", text("SELECT 1 / 0"))
    with pytest.raises(Exception):
        await JobNotices().run_once()
    monkeypatch.undo()
    assert len((await _told(crash))[crash]) == 1 and not (await _stamped(crash))[crash]
    assert await JobNotices().run_once() == {"looked": 1, "told": 0}
    assert len((await _told(crash))[crash]) == 1 and (await _stamped(crash))[crash]

    # Two sweeps at once (two workers): each job is told of once.
    both = [await _job(ie, ds, gid, draft, f"key-notices-both-{i}", cancel_by="bob") for i in range(4)]
    runs = await asyncio.gather(JobNotices().run_once(), JobNotices().run_once())
    assert sum(r["told"] for r in runs) == 4
    assert [len(v) for v in (await _told(*both)).values()] == [1, 1, 1, 1]

    # At most BATCH a sweep, the oldest first.
    capped = [await _job(ie, ds, gid, draft, f"key-notices-cap-{i}", cancel_by="bob") for i in range(3)]
    monkeypatch.setattr(job_notices, "BATCH", 2)
    assert await JobNotices().run_once() == {"looked": 2, "told": 2}
    assert await _stamped(*capped) == {capped[0]: True, capped[1]: True, capped[2]: False}
    assert await JobNotices().run_once() == {"looked": 1, "told": 1}
    monkeypatch.undo()

    # The sweep's read is the index's.
    sql = str(job_notices.pick(cutoff=_ago(3600), limit=200).compile(
        dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True}))
    async with db.graphver_session() as s:
        await s.execute(text("SET LOCAL enable_seqscan = off"))
        plan = "\n".join((await s.execute(text("EXPLAIN " + sql))).scalars())
    assert "ix_jobs_property_unnotified" in plan, plan
    await db.dispose_engine()


def test_the_owner_hears_once_how_a_long_failed_or_stopped_job_ended(monkeypatch):
    asyncio.run(_notices_run(monkeypatch))


# ── the migration ─────────────────────────────────────────────────────────────
def test_the_migration_builds_the_index_concurrently_and_again_over_a_broken_build():
    from alembic.migration import MigrationContext
    from alembic.operations import Operations
    from sqlalchemy import create_engine

    path = Path(__file__).resolve().parents[2] / "alembic" / "versions" / "20261122_1200_gv_job_notices.py"
    spec = importlib.util.spec_from_file_location(path.stem, path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    asyncio.run(models.create_schema_and_partitions())
    asyncio.run(db.dispose_engine())
    url = os.environ["MANAGEMENT_DB_URL"].replace("+asyncpg", "+psycopg2")
    engine = create_engine(url)
    valid = text("SELECT indisvalid FROM pg_index WHERE indexrelid = "
                 "to_regclass('graphver.ix_jobs_property_unnotified')")

    def run(step):
        with engine.connect() as c:
            ctx = MigrationContext.configure(c, opts={"transaction_per_migration": True})
            with Operations.context(ctx), ctx.begin_transaction(_per_migration=True):
                step()
            c.commit()
            return c.execute(valid).scalar()

    try:
        assert run(migration.downgrade) is None
        # A store alembic never reaches gets it at start-up.
        with engine.begin() as c:
            models.ensure_jobs_unnotified_index(c)
            assert c.execute(valid).scalar() is True
        assert run(migration.downgrade) is None
        assert run(migration.upgrade) is True
        assert run(migration.upgrade) is True                      # a no-op once it is there
        with engine.connect() as c:                                # as a build that gave up leaves it
            c.execute(text("UPDATE pg_index SET indisvalid = false WHERE indexrelid = "
                           "to_regclass('graphver.ix_jobs_property_unnotified')"))
            c.commit()
        assert run(migration.upgrade) is True
    finally:
        engine.dispose()
