"""The one job contract every worker lane runs on (``versioning/job_lease.py``).

What it promises, and where each promise is proven:

* a claim takes a job no other claimer can take (``FOR UPDATE SKIP LOCKED``), and EVERY claim is a
  new epoch — a pending claim as much as a stale takeover;
* every write to the job row is fenced on (id, epoch, running[, cursor]) inside the work's own
  transaction, so a superseded worker's window rolls back and its finish is a no-op;
* a claim is fair (per workspace, work-conserving), runs inspections first, honours a per
  (provider, origin) cap, skips a bootstrap paused for a decision, fails a job whose worker keeps
  dying (poison) and an import staged before leases existed, and ``release`` hands a job back.

The lease's own logic is tested against a faked session; the claim SQL only means something on
Postgres, so those tests run with ``GRAPHVER_E2E=1`` (``MANAGEMENT_DB_URL`` pointing at a database
this test may fill with jobs).
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import os
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import insert, select, update

from backend.app.services.versioning import config, db, job_lease, models
from backend.app.services.versioning.job_lease import (
    AWAITING_DECISION,
    BOOTSTRAP_READY,
    INTERRUPTED,
    PURGE_READY,
    QUEUED,
    TRANSFER_READY,
    Draining,
    Lease,
    Superseded,
)
from backend.app.services.versioning.models import ImportRowORM, JobORM


def _ago(secs: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(seconds=secs)).isoformat()


def _lease(job_type="ingest", **kw) -> Lease:
    return Lease(job_id=kw.pop("job_id", "vjob_1"), job_type=job_type, epoch=kw.pop("epoch", 2),
                 workspace_id="ws1", graph_id="g1", **kw)


class _Result:
    def __init__(self, rowcount):
        self.rowcount = rowcount


def _recording(rowcount=1):
    """A session factory whose sessions record each statement and report ``rowcount``."""
    seen = []

    @contextlib.asynccontextmanager
    async def factory():
        class _S:
            async def execute(self, stmt, params=None):
                seen.append((stmt, params))
                return _Result(rowcount)
        yield _S()

    return factory, seen


def _params(stmt) -> dict:
    return stmt.compile().params


# ── The lease, without a database ────────────────────────────────────────────


def test_check_says_superseded_before_draining():
    lease = _lease()
    lease.check()                                          # neither: carry on
    lease.drain.set()
    with pytest.raises(Draining):
        lease.check()
    lease.lost.set()
    with pytest.raises(Superseded):                        # lost wins: a release would be fenced
        lease.check()


async def test_a_checkpoint_is_fenced_on_epoch_status_and_cursor():
    factory, seen = _recording(rowcount=1)
    lease = _lease(session_factory=factory)
    async with factory() as s:
        await lease.checkpoint(s, expect_cursor="node:10", last_cursor="node:20", processed=20)
    (stmt, _), = seen
    sql = str(stmt.compile())
    assert "jobs.retry_count = " in sql and "jobs.status = " in sql
    assert "last_cursor IS NOT DISTINCT FROM" in sql
    params = _params(stmt)
    assert params["id_1"] == "vjob_1" and params["retry_count_1"] == 2
    assert params["status_1"] == "running" and params["last_cursor_1"] == "node:10"
    assert params["last_cursor"] == "node:20" and params["processed"] == 20
    assert params["updated_at"] and "last_sequence" in sql


async def test_a_checkpoint_that_matches_no_row_raises_superseded():
    factory, _ = _recording(rowcount=0)
    async with factory() as s:
        with pytest.raises(Superseded):
            await _lease().checkpoint(s, last_cursor="edge:5")


async def test_without_expect_cursor_the_cursor_is_not_compared():
    factory, seen = _recording()
    async with factory() as s:
        await _lease().checkpoint(s, processed=1)
    assert "last_cursor IS NOT DISTINCT FROM" not in str(seen[0][0].compile())


@pytest.mark.parametrize("job_type, phase", [("ingest", QUEUED), ("package_inspect", QUEUED),
                                             ("bootstrap", None), ("purge", None)])
async def test_release_requeues_a_transfer_job_and_keeps_anothers_phase(job_type, phase):
    factory, seen = _recording()
    assert await _lease(job_type, session_factory=factory).release() is True
    (stmt, _), = seen
    params = _params(stmt)
    assert params["status"] == "pending" and params["status_1"] == "running"
    assert params["retry_count_1"] == 2, "fenced on the epoch, which it does not bump"
    assert params.get("current_phase") == phase
    assert "last_cursor" not in params, "the cursor is kept for the next claim to resume from"


async def test_finish_and_fail_report_false_when_superseded():
    factory, seen = _recording(rowcount=0)
    lease = _lease(session_factory=factory)
    assert await lease.finish("completed", summary={"new": 1}) is False
    assert await lease.fail("boom", "integrity", "restart") is False
    stmt, params = seen[1]
    assert json.loads(params["failure"]) == {"code": "integrity", "action": "restart",
                                             "reason": "boom"}
    assert params["epoch"] == 2 and params["phase"] is None


async def test_retry_transient_waits_out_an_outage_and_not_a_bug(monkeypatch):
    real_sleep = asyncio.sleep
    monkeypatch.setattr(job_lease.asyncio, "sleep", lambda _d: real_sleep(0))
    lease = _lease()
    calls, noted = [], []

    async def flaky():
        calls.append(1)
        if len(calls) < 3:
            raise ConnectionResetError("connection reset by peer")
        return "done"

    async def note(exc):
        noted.append(type(exc).__name__)

    assert await lease.retry_transient(flaky, 60, on_retry=note) == "done"
    assert len(calls) == 3 and noted == ["ConnectionResetError"] * 2

    async def bug():
        raise KeyError("not an outage")

    with pytest.raises(KeyError):
        await lease.retry_transient(bug, 60)

    class Deliberate(Exception):
        pass

    async def deliberate():
        raise Deliberate("the server is loading")          # text that reads as transient

    with pytest.raises(Deliberate):
        await lease.retry_transient(deliberate, 60, never=(Deliberate,))


async def test_retry_transient_stops_when_the_lease_is_lost(monkeypatch):
    lease = _lease()

    async def sleep(_d):
        lease.lost.set()                                   # taken over while we waited

    monkeypatch.setattr(job_lease.asyncio, "sleep", sleep)

    async def down():
        raise ConnectionRefusedError("connection refused")

    with pytest.raises(Superseded):
        await lease.retry_transient(down, 60)


def test_the_claim_sql_caps_providers_only_when_asked():
    plain = str(job_lease._claim_sql(TRANSFER_READY, provider_capped=False))
    capped = str(job_lease._claim_sql(BOOTSTRAP_READY, provider_capped=True))
    assert "FOR UPDATE OF j SKIP LOCKED" in plain and ":provider_cap" not in plain
    assert ":provider_cap" in capped and "summary->>'origin'" in capped
    assert "awaiting_decision" in capped
    # Inspect first, then under-share workspaces, then fewest running, then oldest.
    assert plain.index("package_inspect") < plain.index(":ws_cap") < plain.index("j.created_at")


# ── The claim, on Postgres ───────────────────────────────────────────────────

e2e = pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres")


@pytest.fixture
async def pg():
    db._engine = None                       # an engine cached by another test's loop is unusable
    db._session_factory = None
    await models.create_schema_and_partitions()
    async with db.graphver_session() as s:   # nothing left claimable from an earlier run
        await s.execute(update(JobORM).where(JobORM.status.in_(("pending", "running")))
                        .values(status="cancelled", error_message="cleared by test_job_lease"))
    yield
    await db.dispose_engine()


async def _job(job_type="export", *, status="pending", phase=QUEUED, ws="ws1", provider=None,
               created=0.0, updated=None, epoch=0, cursor=None, summary=None,
               max_retries=3) -> str:
    async with db.graphver_session() as s:
        job = JobORM(job_type=job_type, graph_id="g_lease", workspace_id=ws, provider_id=provider,
                     status=status, current_phase=phase, created_at=_ago(created),
                     updated_at=_ago(updated) if updated is not None else _ago(created),
                     retry_count=epoch, last_cursor=cursor, summary=summary,
                     max_retries=max_retries)
        s.add(job)
        await s.flush()
        return job.id


async def _row(job_id) -> JobORM:
    async with db.graphver_session() as s:
        return await s.get(JobORM, job_id)


def _claim(types=job_lease.TRANSFER_TYPES, pred=TRANSFER_READY, **kw):
    return job_lease.claim(db.graphver_session, types, phase_pred=pred, **kw)


@e2e
async def test_concurrent_claims_never_share_a_job(pg):
    jobs = [await _job(created=10 - i) for i in range(3)]
    got = await asyncio.gather(*[_claim() for _ in range(8)])
    claimed = [lease.job_id for lease in got if lease]
    assert sorted(claimed) == sorted(jobs)
    for job_id in jobs:
        row = await _row(job_id)
        assert (row.status, row.retry_count, row.current_phase) == ("running", 1, None)


@e2e
async def test_every_claim_is_a_new_epoch_and_a_stale_one_is_taken_over(pg):
    job_id = await _job()
    first = await _claim()
    assert first.epoch == 1
    assert await first.release() is True                   # handed back: same epoch, queued
    row = await _row(job_id)
    assert (row.status, row.current_phase, row.retry_count) == ("pending", QUEUED, 1)
    second = await _claim()
    assert second.epoch == 2, "a re-claim of a released job is a new ownership"
    assert await _claim() is None, "a running job with a fresh heartbeat is nobody else's"

    async with db.graphver_session() as s:                 # its worker went quiet
        await s.execute(update(JobORM).where(JobORM.id == job_id)
                        .values(updated_at=_ago(config.INGEST_STALE_SECS + 5)))
    third = await _claim()
    assert third.job_id == job_id and third.epoch == 3
    row = await _row(job_id)
    assert row.summary["takeovers"] == 1 and row.status == "running"


@e2e
async def test_a_zombies_window_rolls_back_and_its_finish_is_a_no_op(pg):
    job_id = await _job("ingest")
    zombie = await _claim()
    async with db.graphver_session() as s:
        await s.execute(update(JobORM).where(JobORM.id == job_id)
                        .values(updated_at=_ago(config.INGEST_STALE_SECS + 5)))
    owner = await _claim()
    assert owner.epoch == zombie.epoch + 1

    with pytest.raises(Superseded):
        async with db.graphver_session() as s:             # the zombie's window: work + checkpoint
            await s.execute(insert(ImportRowORM.__table__), [
                {"job_id": job_id, "row_index": 0, "kind": "node", "raw": {"urn": "urn:z"}}])
            await zombie.checkpoint(s, last_cursor="parse:1")
    async with db.graphver_session() as s:
        staged = (await s.execute(select(ImportRowORM).where(ImportRowORM.job_id == job_id))).all()
    assert staged == [], "the window rolled back with the fenced write"
    assert await zombie.finish("completed") is False
    assert await zombie.fail("late") is False
    assert await zombie.release() is False
    assert await owner.finish("completed", processed=7) is True
    row = await _row(job_id)
    assert (row.status, row.processed, row.error_message) == ("completed", 7, None)


@e2e
async def test_a_checkpoint_expecting_a_moved_cursor_is_superseded(pg):
    await _job("ingest")
    lease = await _claim()
    async with db.graphver_session() as s:
        await lease.checkpoint(s, expect_cursor=None, last_cursor="node:100")
    with pytest.raises(Superseded):
        async with db.graphver_session() as s:             # replaying the same window
            await lease.checkpoint(s, expect_cursor=None, last_cursor="node:100")
    async with db.graphver_session() as s:
        await lease.checkpoint(s, expect_cursor="node:100", last_cursor="edge:0")
    row = await _row(lease.job_id)
    assert row.last_cursor == "edge:0" and row.last_sequence == 2


@e2e
async def test_fail_records_the_failure_with_the_current_phase(pg):
    job_id = await _job("bootstrap", phase="nodes")
    lease = await _claim(job_lease.BOOTSTRAP_TYPES, BOOTSTRAP_READY)
    assert await lease.fail("graph service down", "infrastructure", "resume") is True
    row = await _row(job_id)
    assert row.status == "failed" and row.error_message == "graph service down"
    assert row.summary["failure"] == {"code": "infrastructure", "action": "resume",
                                      "phase": "nodes", "reason": "graph service down"}
    assert row.completed_at


@e2e
async def test_a_bootstrap_paused_for_a_decision_is_never_claimed(pg):
    await _job("bootstrap", phase=AWAITING_DECISION, created=20)
    ready = await _job("bootstrap", phase="nodes", created=10)
    lease = await _claim(job_lease.BOOTSTRAP_TYPES, BOOTSTRAP_READY)
    assert lease.job_id == ready
    assert await _claim(job_lease.BOOTSTRAP_TYPES, BOOTSTRAP_READY) is None
    row = await _row(ready)
    assert row.current_phase == "nodes", "only a transfer job's 'queued' phase is cleared"


@e2e
async def test_claims_are_fair_per_workspace_and_work_conserving(pg):
    for _ in range(2):                                     # busy runs two already
        await _job(status="running", phase=None, ws="busy", updated=1)
    busy = await _job(ws="busy", created=60)               # queued first
    quiet = await _job(ws="quiet", created=10)
    assert (await _claim()).job_id == quiet, "the workspace under its share goes first"
    assert (await _claim()).job_id == busy, "a soft cap: nobody else waits, so it runs"


@e2e
async def test_an_inspection_is_claimed_before_older_imports(pg):
    await _job("ingest", created=60)
    inspect = await _job("package_inspect", created=1)
    lease = await _claim(job_lease.TRANSFER_TYPES + job_lease.INSPECT_TYPES)
    assert lease.job_id == inspect and lease.job_type == "package_inspect"


@e2e
async def test_the_provider_cap_counts_per_provider_and_origin(pg):
    for _ in range(2):
        await _job("bootstrap", status="running", phase="nodes", provider="p1", updated=1)
    capped = await _job("bootstrap", phase=None, provider="p1", created=30)
    seed = await _job("bootstrap", phase=None, provider="p1", created=20,
                      summary={"origin": "package"})
    other = await _job("bootstrap", phase=None, provider="p2", created=10)
    claim = lambda: _claim(job_lease.BOOTSTRAP_TYPES, BOOTSTRAP_READY, provider_cap=2,  # noqa: E731
                           lane="bootstrap")
    got = {(await claim()).job_id, (await claim()).job_id}
    assert got == {seed, other}
    assert await claim() is None, "p1's graph bootstraps are at the cap"
    assert (await _row(capped)).status == "pending"


@e2e
async def test_a_job_whose_worker_keeps_dying_fails_as_poison(pg):
    poison = await _job("purge", status="running", phase="edges", epoch=4, created=60,
                        updated=config.INGEST_STALE_SECS + 5, summary={"takeovers": 3})
    healthy = await _job("purge", phase="count", created=1)
    lease = await _claim(job_lease.PURGE_TYPES, PURGE_READY)
    assert lease.job_id == healthy, "the claim fails the poison job and moves on"
    row = await _row(poison)
    assert row.status == "failed" and "stopped 4 times" in row.error_message
    assert row.summary["failure"]["code"] == "infrastructure"
    assert row.summary["failure"]["action"] == "resume"
    assert row.summary["failure"]["phase"] == "edges"


@e2e
async def test_an_import_staged_before_leases_fails_instead_of_resuming(pg):
    legacy = await _job("ingest", status="running", phase=None,
                        updated=config.INGEST_STALE_SECS + 5, created=50)
    fresh = await _job("ingest", status="running", phase=None,
                       updated=config.INGEST_STALE_SECS + 5, created=40)
    async with db.graphver_session() as s:
        await s.execute(insert(ImportRowORM.__table__), [
            {"job_id": legacy, "row_index": 0, "kind": "node", "raw": {"urn": "urn:a"}}])
    lease = await _claim()
    assert lease.job_id == fresh, "nothing staged: it simply starts again"
    row = await _row(legacy)
    assert (row.status, row.error_message) == ("failed", INTERRUPTED)


@e2e
async def test_the_backlog_reports_each_lanes_oldest_claimable_job(pg):
    await _job("export", created=300)
    await _job("bootstrap", phase=AWAITING_DECISION, created=900)       # paused: not claimable
    await _job("purge", phase="count", created=120)
    async with db.graphver_session() as s:
        backlog = await job_lease.claimable_backlog(s)
    assert backlog["transfer"]["claimable"] == 1
    assert 290 <= backlog["transfer"]["oldestClaimableSecs"] <= 400
    assert backlog["bootstrap"]["claimable"] == 1
    assert 110 <= backlog["bootstrap"]["oldestClaimableSecs"] <= 200
