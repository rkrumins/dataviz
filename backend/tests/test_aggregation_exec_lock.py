"""Tests for the single-active aggregation execution lock + lock-aware
reconciler auto-resume + durable cancel. No real Redis/DB — an in-memory
fake Redis and fake sessions stand in.
"""
import asyncio

import types

import pytest

from backend.app.services.aggregation.__main__ import _JobConsumer
from backend.app.services.aggregation import reconciler as recon_mod
from backend.app.services.aggregation.models import AggregationJobORM
from backend.app.services.aggregation.redis_client import (
    exec_lock_key, cancel_flag_key,
)


class FakeRedis:
    def __init__(self):
        self.store: dict = {}
        self.xadds: list = []
        self.expires: list = []

    async def set(self, key, value, nx=False, px=None, ex=None):
        if nx and key in self.store:
            return None
        self.store[key] = value
        return True

    async def get(self, key):
        return self.store.get(key)

    async def exists(self, key):
        return 1 if key in self.store else 0

    async def incr(self, key):
        v = int(self.store.get(key, 0)) + 1
        self.store[key] = v
        return v

    async def expire(self, key, ttl):
        self.expires.append((key, ttl))
        return True

    async def delete(self, key):
        return 1 if self.store.pop(key, None) is not None else 0

    async def xack(self, *a):
        return 1

    async def xadd(self, stream, fields, maxlen=None):
        self.xadds.append((stream, dict(fields)))
        return "1-0"

    async def eval(self, script, numkeys, *args):
        key, token = args[0], args[1]
        if self.store.get(key) == token:
            if "del" in script:
                self.store.pop(key, None)
            return 1
        return 0


class _Res:
    def __init__(self, row):
        self._row = row

    def first(self):
        return self._row


class FakeSession:
    def __init__(self, status="running"):
        self._status = status

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def execute(self, stmt, params=None):
        if "select status" in str(stmt).lower():
            return _Res((self._status,))
        return _Res(None)

    async def commit(self):
        return None


def _factory(status="running"):
    def f():
        return FakeSession(status)
    return f


class FakeWorker:
    def __init__(self):
        self.runs: list = []

    async def run(self, job_id):
        self.runs.append(job_id)
        await asyncio.sleep(0.05)


def _consumer(redis, worker, status="running"):
    c = _JobConsumer(worker=worker, session_factory=_factory(status), redis_client=redis)
    c._message_ids["J"] = "msg-1"
    return c


# ── single-active execution lock ────────────────────────────────────

@pytest.mark.asyncio
async def test_only_one_executor_runs_a_job():
    redis = FakeRedis()
    worker = FakeWorker()
    c = _consumer(redis, worker)
    # Two deliveries of the SAME job race; exactly one must run.
    await asyncio.gather(c._execute_job("J"), c._execute_job("J"))
    assert worker.runs == ["J"], f"expected single execution, got {worker.runs}"
    # Lock released after completion.
    assert exec_lock_key("J") not in redis.store


@pytest.mark.asyncio
async def test_duplicate_delivery_while_locked_skips():
    redis = FakeRedis()
    # Pre-hold the lock as if another executor owns it.
    redis.store[exec_lock_key("J")] = "other-holder"
    worker = FakeWorker()
    c = _consumer(redis, worker)
    await c._execute_job("J")
    assert worker.runs == []  # skipped — lock held elsewhere
    # We must NOT have deleted someone else's lock.
    assert redis.store[exec_lock_key("J")] == "other-holder"


@pytest.mark.asyncio
async def test_cancel_flag_prevents_run():
    redis = FakeRedis()
    redis.store[cancel_flag_key("J")] = "1"
    worker = FakeWorker()
    c = _consumer(redis, worker)
    await c._execute_job("J")
    assert worker.runs == []  # cancelled → never runs
    assert exec_lock_key("J") not in redis.store  # never acquired


@pytest.mark.asyncio
async def test_terminal_job_not_rerun():
    redis = FakeRedis()
    worker = FakeWorker()
    c = _consumer(redis, worker, status="completed")
    await c._execute_job("J")
    assert worker.runs == []  # already completed → skip
    assert exec_lock_key("J") not in redis.store  # lock released


# ── reconciler lock-aware auto-resume ───────────────────────────────

def _job(status="running"):
    return AggregationJobORM(
        id="J", data_source_id="ds", status=status, last_cursor="2:10",
        last_checkpoint_at=None, started_at=None,
    )


class _ReconRes:
    def __init__(self, items):
        self._items = items

    def scalars(self):
        return self

    def all(self):
        return self._items

    def __iter__(self):
        return iter(self._items)


class _ReconSession:
    def __init__(self, jobs):
        self._jobs = jobs
        self.committed = False

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def execute(self, stmt):
        return _ReconRes(self._jobs)

    async def commit(self):
        self.committed = True


def _recon_factory(jobs):
    def f():
        return _ReconSession(jobs)
    return f


@pytest.mark.asyncio
async def test_reconciler_auto_resumes_when_lock_absent():
    redis = FakeRedis()  # no exec lock → executor dead
    job = _job()
    n = await recon_mod._reconcile_once(_recon_factory([job]), redis)
    assert n == 1
    assert redis.xadds and redis.xadds[0][1]["job_id"] == "J"  # re-dispatched
    assert job.status == "running"  # left running for the resuming worker


@pytest.mark.asyncio
async def test_reconciler_skips_when_lock_present():
    redis = FakeRedis()
    redis.store[exec_lock_key("J")] = "alive-holder"
    job = _job()
    n = await recon_mod._reconcile_once(_recon_factory([job]), redis)
    assert n == 0
    assert redis.xadds == []  # live executor → no re-dispatch


@pytest.mark.asyncio
async def test_reconciler_caps_auto_resume(monkeypatch):
    monkeypatch.setattr(recon_mod, "_MAX_AUTO_RESUMES", 2)
    redis = FakeRedis()
    redis.store["agg:redispatch:J"] = 2  # already at cap; next incr -> 3
    job = _job()
    n = await recon_mod._reconcile_once(_recon_factory([job]), redis)
    assert n == 1
    assert redis.xadds == []  # capped — no further re-dispatch
    assert job.status == "failed"


@pytest.mark.asyncio
async def test_reconciler_marks_cancelled_when_flagged():
    redis = FakeRedis()
    redis.store[cancel_flag_key("J")] = "1"  # cancelled + lock absent
    job = _job()
    n = await recon_mod._reconcile_once(_recon_factory([job]), redis)
    assert n == 1
    assert job.status == "cancelled"
    assert redis.xadds == []


# ── the auto-resume cap is real: the counter does not slide ─────────


@pytest.mark.asyncio
async def test_reconciler_counter_ttl_is_set_once():
    """The old counter refreshed its TTL on every increment, so a job that
    ran longer than the window between two executor deaths was resumed
    forever. The TTL is now set on creation only."""
    redis = FakeRedis()
    job = _job()
    await recon_mod._reconcile_once(_recon_factory([job]), redis)
    await recon_mod._reconcile_once(_recon_factory([job]), redis)
    assert redis.store["agg:redispatch:J"] == 2
    assert redis.expires == [("agg:redispatch:J", recon_mod._REDISPATCH_TTL_SECS)]
    assert len(redis.xadds) == 2


@pytest.mark.asyncio
async def test_reconciler_sixth_resume_fails_the_job_with_a_way_back():
    redis = FakeRedis()
    redis.store["agg:redispatch:J"] = 5  # the default cap, already spent
    job = _job()
    n = await recon_mod._reconcile_once(_recon_factory([job]), redis)
    assert n == 1
    assert job.status == "failed"
    assert "resume from cursor=2:10 is still possible" in job.error_message
    assert redis.xadds == []


# ── crash recovery shares the counter, honours the cancel flag ──────


class _Dispatcher:
    def __init__(self):
        self.dispatched: list = []

    async def dispatch(self, job_id):
        self.dispatched.append(job_id)


def _service(jobs, dispatcher):
    from backend.app.services.aggregation.service import AggregationService
    return AggregationService(
        dispatcher=dispatcher, registry=None, session_factory=_recon_factory(jobs),
    )


@pytest.mark.asyncio
async def test_crash_recovery_counts_against_the_shared_cap(monkeypatch):
    redis = FakeRedis()
    monkeypatch.setattr(
        "backend.app.services.aggregation.redis_client.get_redis", lambda: redis,
    )
    d = _Dispatcher()
    job = _job()  # running, checkpointed
    n = await _service([job], d).recover_interrupted_jobs()
    assert n == 1 and d.dispatched == ["J"] and job.status == "pending"
    assert redis.store["agg:redispatch:J"] == 1
    assert redis.expires == [("agg:redispatch:J", recon_mod._REDISPATCH_TTL_SECS)]


@pytest.mark.asyncio
async def test_crash_recovery_stops_at_the_cap(monkeypatch):
    """A control plane that crash-loops must not re-dispatch the same job on
    every boot forever — the checkpointed branch had no cap at all."""
    redis = FakeRedis()
    redis.store["agg:redispatch:J"] = 5
    monkeypatch.setattr(
        "backend.app.services.aggregation.redis_client.get_redis", lambda: redis,
    )
    d = _Dispatcher()
    job = _job()
    await _service([job], d).recover_interrupted_jobs()
    assert d.dispatched == []
    assert job.status == "failed"
    assert "resume from cursor=2:10 is still possible" in job.error_message


@pytest.mark.asyncio
async def test_crash_recovery_never_resumes_a_cancelled_job(monkeypatch):
    redis = FakeRedis()
    redis.store[cancel_flag_key("J")] = "1"
    monkeypatch.setattr(
        "backend.app.services.aggregation.redis_client.get_redis", lambda: redis,
    )
    d = _Dispatcher()
    job = _job()
    await _service([job], d).recover_interrupted_jobs()
    assert d.dispatched == []
    assert job.status == "cancelled"
    assert "agg:redispatch:J" not in redis.store


@pytest.mark.asyncio
async def test_crash_recovery_falls_open_when_redis_is_down(monkeypatch):
    def _boom():
        raise RuntimeError("redis down")

    monkeypatch.setattr(
        "backend.app.services.aggregation.redis_client.get_redis", _boom,
    )
    d = _Dispatcher()
    job = _job()
    await _service([job], d).recover_interrupted_jobs()
    assert d.dispatched == ["J"] and job.status == "pending"


@pytest.mark.asyncio
async def test_manual_resume_clears_the_auto_resume_counter(monkeypatch):
    """The counter no longer expires on its own, so a hand Resume — which
    promises a fresh automated budget — must clear it, or the resumed job
    would fail at its first executor death."""
    redis = FakeRedis()
    redis.store["agg:redispatch:J"] = 5
    redis.store["agg:cancel:J"] = "1"   # cancelled under an hour ago
    monkeypatch.setattr(
        "backend.app.services.aggregation.redis_client.get_redis", lambda: redis,
    )
    d = _Dispatcher()
    job = _job(status="failed")
    # The resume response serialises the row; give it what a real row has.
    job.trigger_source, job.created_at = "manual", "2026-09-05T00:00:00+00:00"
    job.progress = job.total_edges = job.processed_edges = job.created_edges = 0
    job.batch_size = 1000

    class _Session:
        async def get(self, orm, key):
            return job if key == "J" else None

        async def commit(self):
            pass

    svc = _service([job], d)
    await svc.resume("ds", "J", _Session())
    assert job.status == "pending" and d.dispatched == ["J"]
    assert "agg:redispatch:J" not in redis.store
    # And the durable cancel flag: left in place, the resumed job would be
    # re-cancelled at pickup for up to an hour, with nothing shown.
    assert "agg:cancel:J" not in redis.store


# ── Cancel sticks ─────────────────────────────────────────────────────


def _queued_job(status="pending", started_at=None):
    job = _job(status=status)
    job.started_at = started_at
    # The cancel response serialises the row; give it what a real row has.
    job.trigger_source, job.created_at = "reconcile", "2026-09-05T00:00:00+00:00"
    job.progress = job.total_edges = job.processed_edges = job.created_edges = 0
    job.batch_size, job.retry_count = 1000, 0
    return job


class _CancelSession:
    """The job and its source's state row, by ORM name; records whether the
    job was loaded under the row lock."""

    def __init__(self, job, state):
        self.job, self.state = job, state
        self.get_kwargs: list = []
        self.committed = False

    async def get(self, orm, key, **kw):
        self.get_kwargs.append((orm.__name__, kw))
        return {
            "AggregationJobORM": self.job,
            "AggregationDataSourceStateORM": self.state,
        }.get(orm.__name__)

    async def commit(self):
        self.committed = True


@pytest.mark.asyncio
@pytest.mark.parametrize("last_aggregated_at, expected", [
    (None, "none"),
    ("2026-09-01T00:00:00+00:00", "cancelled"),
])
async def test_cancelling_a_queued_job_releases_its_source(last_aggregated_at, expected):
    """``trigger()`` stamps the state row ``pending`` and only a worker would
    ever change it — so a cancel before any worker ran the job must, or the
    stale-marker reconciler defers the source as in-flight forever. A
    never-built source goes back to ``none`` so its first build can be queued
    again; a built one reads ``cancelled``, what a mid-run cancel writes."""
    job = _queued_job()
    state = types.SimpleNamespace(
        aggregation_status="pending", last_aggregated_at=last_aggregated_at,
    )
    session = _CancelSession(job, state)
    await _service([job], _Dispatcher()).cancel("ds", "J", session)
    assert job.status == "cancelled" and job.completed_at
    assert state.aggregation_status == expected
    assert session.committed
    # Loaded under the row lock, so this and a worker's start exclude each other.
    assert ("AggregationJobORM", {"with_for_update": True}) in session.get_kwargs


@pytest.mark.asyncio
async def test_cancelling_a_started_job_reads_cancelled_even_on_a_never_built_source():
    job = _queued_job(started_at="2026-09-05T00:00:00+00:00")
    state = types.SimpleNamespace(aggregation_status="pending", last_aggregated_at=None)
    await _service([job], _Dispatcher()).cancel("ds", "J", _CancelSession(job, state))
    assert state.aggregation_status == "cancelled"


_PAST_THE_START_GUARD = "past the start guard"


class _RowSession:
    """Hands out one job row under the lock; any other access proves the
    worker got past the start guard."""

    def __init__(self, job):
        self.job = job
        self.get_kwargs = None

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def get(self, orm, key, **kw):
        self.get_kwargs = kw
        return self.job

    def __getattr__(self, name):
        raise AssertionError(_PAST_THE_START_GUARD)


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["cancelled", "completed", "failed"])
async def test_the_worker_never_starts_a_row_that_is_no_longer_live(status):
    """A cancel that lands between pickup and start must not be flipped back
    to running — the one guard the in-process dispatcher gets, since it
    skips the consumer's status check."""
    from backend.app.services.aggregation.worker import AggregationWorker

    job = _job(status=status)
    session = _RowSession(job)
    worker = AggregationWorker(
        session_factory=lambda: session, registry=None, event_publisher=None,
    )
    await worker.run("J")
    assert job.status == status
    assert session.get_kwargs == {"with_for_update": True}


@pytest.mark.asyncio
async def test_the_worker_still_starts_a_running_row_the_reconciler_re_dispatched():
    """The stuck-job reconciler re-dispatches a job whose executor died
    without resetting its row, so ``running`` must still start."""
    from backend.app.services.aggregation.worker import AggregationWorker

    session = _RowSession(_job(status="running"))
    worker = AggregationWorker(
        session_factory=lambda: session, registry=None, event_publisher=None,
    )
    with pytest.raises(AssertionError, match=_PAST_THE_START_GUARD):
        await worker.run("J")
