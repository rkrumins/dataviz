"""Tests for the single-active aggregation execution lock + lock-aware
reconciler auto-resume + durable cancel. No real Redis/DB — an in-memory
fake Redis and fake sessions stand in.
"""
import asyncio

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
