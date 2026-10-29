"""A draft held ``publishing`` by a publish job that ended without landing is handed back.

``create_publish_job`` sets the draft ``publishing``; the job's refusal reopens it at once
(``run_publish``). Every other ending — the lease failed, the job poisoned, the reaper timing out a
queued job — is reconciled by ``release_publishing`` on the transfer lane's reap loop, about every
minute: a ``publishing`` draft with no pending or running publish job is ``open`` again. It skips a
draft whose row is locked (a ``create_publish_job`` in flight), so it never reopens a publish that is
being queued. The statement and the loop are checked here; integration/test_versioning_publish_fence.py
runs them on Postgres.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging

from sqlalchemy.dialects import postgresql

from backend.app.services.versioning import service as service_mod
from backend.app.services.versioning import worker as worker_mod
from backend.app.services.versioning.service import GraphVersioningService
from backend.app.services.versioning.worker import ProjectionWorker


def _release_sql(**kwargs):
    seen = []

    class _Result:
        def scalars(self):
            return self

        def all(self):
            return ["br1"]

    class _S:
        async def execute(self, stmt):
            seen.append(stmt)
            return _Result()

    @contextlib.asynccontextmanager
    async def session():
        yield _S()

    out = asyncio.run(GraphVersioningService(session_factory=session).release_publishing(**kwargs))
    (stmt,) = seen
    return out, " ".join(str(stmt.compile(dialect=postgresql.dialect())).split())


def test_release_reopens_publishing_drafts_with_no_active_publish_job():
    out, sql = _release_sql()
    assert out == ["br1"]
    assert sql.startswith("UPDATE graphver.branches SET status=%(status)s"), sql
    assert "RETURNING graphver.branches.id" in sql, sql
    assert "NOT (EXISTS (SELECT" in sql and "graphver.jobs.job_type = %(job_type_1)s" in sql, sql
    assert "graphver.jobs.status IN" in sql, sql
    # The candidate select reads its own alias of branches (not the UPDATE's row), locks the rows
    # it reopens, and skips a row a create_publish_job holds.
    assert "FROM graphver.branches AS " in sql, sql
    assert "FOR NO KEY UPDATE SKIP LOCKED) RETURNING" in sql, sql


def test_release_can_be_narrowed_to_one_draft():
    _out, sql = _release_sql(graph_id="g1", branch_id="br1")
    assert ".graph_id = %(graph_id_1)s" in sql and ".id = %(id_1)s" in sql, sql


class _Reaper:
    def __init__(self):
        self.runs = 0

    async def run_once(self):
        self.runs += 1
        return {"timedOut": 0, "neverQueued": 0}


def test_the_reap_loop_releases_publishing_drafts_and_survives_an_error(monkeypatch, caplog):
    reaper = _Reaper()
    worker = ProjectionWorker(object(), lanes=["transfer"], job_reaper=reaper)
    calls = []

    async def release(self, **kwargs):
        calls.append(kwargs)
        if len(calls) == 1:
            raise RuntimeError("database went away")
        worker.stop()
        return ["br1"]

    monkeypatch.setattr(service_mod.GraphVersioningService, "release_publishing", release)
    monkeypatch.setattr(worker_mod, "_JOB_REAP_SECS", 0.01)
    with caplog.at_level(logging.ERROR, logger=worker_mod.logger.name):
        asyncio.run(asyncio.wait_for(worker._job_reap_loop(), timeout=5))
    assert calls == [{}, {}], "every draft, every round — and the round after an error still runs"
    assert reaper.runs == 2
    assert any("publishing" in r.getMessage() for r in caplog.records), caplog.text
