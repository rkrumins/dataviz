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
        return True

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
