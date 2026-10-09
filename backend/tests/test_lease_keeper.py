"""The lease heartbeat thread (``job_lease.LeaseKeeper``).

It keeps a process's jobs alive from a thread of its own, so a window holding the event loop for a
minute of CPU never looks dead. Proven here: the renewal binds typed arrays (asyncpg can't guess an
empty or all-NULL array's type); a lease is marked lost ONLY when a successful renewal didn't return
its row — a failed statement marks nothing, or a Postgres blip would kill every job in the process;
the thread outlives a failing tick; and a wedged event loop takes a standalone worker down instead
of keeping its jobs leased forever. With ``GRAPHVER_E2E=1`` the renewal also runs on Postgres.
"""
from __future__ import annotations

import contextlib
import os
import threading
import time
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import Integer, Text, update
from sqlalchemy.dialects.postgresql import ARRAY

from backend.app.observability import event_loop_monitor
from backend.app.services.versioning import db, job_lease, models
from backend.app.services.versioning.job_lease import Lease, LeaseKeeper
from backend.app.services.versioning.models import JobORM


def _lease(job_id, epoch=1) -> Lease:
    return Lease(job_id=job_id, job_type="ingest", epoch=epoch, workspace_id="ws1", graph_id="g1")


class _Engine:
    """An engine whose renewal returns ``alive`` (id, epoch) rows, or raises ``error``."""

    def __init__(self, alive=(), error=None):
        self.alive, self.error = list(alive), error
        self.calls = []

    @contextlib.asynccontextmanager
    async def begin(self):
        engine = self

        class _Conn:
            async def execute(self, stmt, params=None):
                engine.calls.append((str(stmt), params))
                if params is None:
                    return None                      # SET LOCAL lock_timeout
                if engine.error is not None:
                    raise engine.error
                return iter(engine.alive)

        yield _Conn()

    async def dispose(self):
        pass


def test_the_renewal_binds_typed_arrays():
    binds = job_lease._RENEW._bindparams
    assert isinstance(binds["ids"].type, ARRAY) and isinstance(binds["ids"].type.item_type, Text)
    assert isinstance(binds["epochs"].type, ARRAY)
    assert isinstance(binds["epochs"].type.item_type, Integer)
    sql = str(job_lease._RENEW)
    assert "unnest(:ids, :epochs)" in sql and "j.retry_count = v.epoch" in sql
    assert "j.status = 'running'" in sql and "RETURNING j.id, j.retry_count" in sql


async def test_only_a_lease_missing_from_a_successful_renewal_is_lost():
    kept, gone, moved = _lease("vjob_1"), _lease("vjob_2"), _lease("vjob_3", epoch=2)
    engine = _Engine(alive=[("vjob_1", 1), ("vjob_3", 3)])  # vjob_3 is at another epoch now
    keeper = LeaseKeeper(engine_factory=lambda: engine)
    for lease in (kept, gone, moved):
        keeper.register(lease)

    assert await keeper.renew_once() == {"vjob_2", "vjob_3"}
    assert not kept.lost.is_set() and gone.lost.is_set() and moved.lost.is_set()
    set_local, (sql, params) = engine.calls
    assert "lock_timeout" in set_local[0]
    assert dict(zip(params["ids"], params["epochs"])) == {"vjob_1": 1, "vjob_2": 1, "vjob_3": 2}


async def test_a_failed_renewal_marks_nothing_lost():
    lease = _lease("vjob_1")
    keeper = LeaseKeeper(engine_factory=lambda: _Engine(error=OSError("connection refused")))
    keeper.register(lease)
    with pytest.raises(OSError):
        await keeper.renew_once()
    assert not lease.lost.is_set()


async def test_nothing_registered_means_no_statement():
    engine = _Engine()
    keeper = LeaseKeeper(engine_factory=lambda: engine)
    lease = _lease("vjob_1")
    keeper.register(lease)
    keeper.unregister(lease)
    assert await keeper.renew_once() == set() and engine.calls == []


def test_the_thread_renews_on_a_timer_and_outlives_a_failing_tick():
    engine = _Engine(error=OSError("the database system is starting up"))
    keeper = LeaseKeeper(every=0.01, engine_factory=lambda: engine)
    lease = _lease("vjob_1")
    keeper.register(lease)
    keeper.start()
    try:
        assert job_lease.running_keeper() is keeper
        deadline = time.monotonic() + 5
        while len(engine.calls) < 6:                       # three failed ticks, and it kept going
            assert time.monotonic() < deadline
            time.sleep(0.01)
        engine.error, engine.alive = None, [("vjob_1", 1)]
        seen = len(engine.calls)
        while len(engine.calls) < seen + 2:
            assert time.monotonic() < deadline
            time.sleep(0.01)
        assert not lease.lost.is_set()
        with pytest.raises(RuntimeError):
            LeaseKeeper().start()                          # one keeper per process
    finally:
        keeper.stop()
    assert job_lease.running_keeper() is None
    assert not any(t.name == "graphver-lease-keeper" and t.is_alive()
                   for t in threading.enumerate())


@pytest.fixture
def wedge(monkeypatch):
    """A loop that last ticked ``stalled`` seconds ago, and a process exit that is recorded."""
    exits, dumps = [], []
    state = {"stalled": 0.0}
    monkeypatch.setattr(event_loop_monitor, "last_tick",
                        lambda: time.monotonic() - state["stalled"])
    monkeypatch.setattr(job_lease.os, "_exit", exits.append)
    monkeypatch.setattr(job_lease.faulthandler, "dump_traceback",
                        lambda **kw: dumps.append(kw))
    return state, exits, dumps


def test_a_wedged_loop_exits_a_standalone_worker(wedge):
    state, exits, dumps = wedge
    keeper = LeaseKeeper(exit_on_wedge=True, wedge_secs=900)
    state["stalled"] = 10
    assert keeper.wedged() is False and exits == []
    state["stalled"] = 901
    assert keeper.wedged() is True
    assert exits == [70] and dumps == [{"all_threads": True}]


def test_a_wedged_dev_server_stops_renewing_but_stays_up(wedge):
    state, exits, dumps = wedge
    keeper = LeaseKeeper(exit_on_wedge=False, wedge_secs=900)
    state["stalled"] = 901
    assert keeper.wedged() is True and keeper.wedged() is True
    assert exits == [] and len(dumps) == 1, "the stacks are dumped once per wedge"
    state["stalled"] = 1
    assert keeper.wedged() is False                        # it recovered


def test_without_a_loop_monitor_nothing_is_judged_wedged(monkeypatch):
    monkeypatch.setattr(event_loop_monitor, "last_tick", lambda: 0.0)
    assert LeaseKeeper(exit_on_wedge=True, wedge_secs=0).wedged() is False


# ── On Postgres ──────────────────────────────────────────────────────────────


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres")
async def test_renewal_on_postgres_beats_its_own_epoch_only():
    db._engine = None
    db._session_factory = None
    await models.create_schema_and_partitions()
    old = (datetime.now(timezone.utc) - timedelta(seconds=60)).isoformat()
    try:
        async with db.graphver_session() as s:
            mine = JobORM(job_type="export", graph_id="g_keeper", status="running",
                          retry_count=3, updated_at=old)
            theirs = JobORM(job_type="export", graph_id="g_keeper", status="running",
                            retry_count=5, updated_at=old)
            s.add_all([mine, theirs])
            await s.flush()
            ids = (mine.id, theirs.id)
        keeper = LeaseKeeper()
        held, taken = _lease(ids[0], epoch=3), _lease(ids[1], epoch=4)
        keeper.register(held)
        keeper.register(taken)
        assert await keeper.renew_once() == {ids[1]}
        async with db.graphver_session() as s:
            beat = await s.get(JobORM, ids[0])
            other = await s.get(JobORM, ids[1])
            assert beat.updated_at > old and other.updated_at == old
            await s.execute(update(JobORM).where(JobORM.id.in_(ids))
                            .values(status="cancelled"))
        if keeper._engine is not None:
            await keeper._engine.dispose()
    finally:
        await db.dispose_engine()
