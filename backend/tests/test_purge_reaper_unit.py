"""The purge and its reaper, with their sessions faked: what they refuse, and what they leave alone.

* the reaper takes each expired data source on its own — one that fails does not stop the rest;
* a graph restored while the reaper looked is left standing, and so is its data source;
* a graph that forks still read is never purged: a person's "delete permanently" is refused, the
  reaper skips it, and the purge itself refuses at its count;
* a trashed fork reads its parent only while forks of its own read through it; the parent's purge
  locks its forks before counting them, and takes its trashed leaf forks along;
* once a purge starts, the graph's other queued and running jobs are cancelled with it;
* the reaper re-queues a purge that failed on infrastructure, or was refused for forks since
  gone, never one refused for anything else;
* a pull request cannot be opened into a trashed parent.

The same paths against a real Postgres: ``integration/test_graph_lifecycle_purge.py``.
"""
from __future__ import annotations

from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy.dialects import postgresql

from backend.app.services.versioning import purge_worker
from backend.app.services.versioning.models import GraphORM, JobORM
from backend.app.services.versioning.purge_worker import PurgeRefused


def _sql(stmt) -> str:
    return str(stmt.compile(dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True}))


class _Rows:
    def __init__(self, rows):
        self._rows = list(rows)

    def all(self):
        return list(self._rows)

    def scalars(self):
        return self

    def first(self):
        return self._rows[0] if self._rows else None


def _app(expired, rows):
    """The management database: the expired data sources, and the rows the reaper may delete."""
    deleted = []

    class _Session:
        async def execute(self, _stmt):
            return _Rows(expired)

        async def get(self, _model, ident):
            return rows.get(ident)

        async def delete(self, row):
            deleted.append(row)

        async def commit(self):
            pass

    @asynccontextmanager
    async def sessions():
        yield _Session()

    return sessions, deleted


def _gv(graphs_by_ds, failed=()):
    """The version store: each data source's graphs, no unfinished purge, and the graphs whose
    purge failed (what the revive pass selects)."""
    seen = []

    class _Session:
        async def execute(self, stmt):
            seen.append(stmt)
            if "JOIN" in str(stmt):
                return _Rows(failed)
            params = stmt.compile().params.values()
            return _Rows(next((graphs_by_ds[v] for v in params if v in graphs_by_ds), []))

        async def scalar(self, _stmt):
            return 0

    @asynccontextmanager
    async def sessions():
        yield _Session()

    return sessions, seen


async def _no_orphans(_self):
    return 0


# ── the reaper ────────────────────────────────────────────────────────────────


async def test_one_failing_data_source_does_not_stop_the_pass(monkeypatch):
    app, deleted = _app([("ds_a", "ws1", "alice"), ("ds_b", "ws1", "bob")], {})
    gv, _ = _gv({"ds_a": ["g_a"], "ds_b": ["g_b"]})
    asked = []

    async def purge(*, data_source_id, workspace_id, actor, **_kw):
        asked.append(data_source_id)
        if data_source_id == "ds_a":
            raise ConnectionError("the version store blinked")
        return ["vjob_b"]

    monkeypatch.setattr(purge_worker, "purge_graph_for_data_source", purge)
    monkeypatch.setattr(purge_worker.Reaper, "_orphaned_package_sources", _no_orphans)
    out = await purge_worker.Reaper(app_session_factory=app, graphver_session_factory=gv).run_once()

    assert asked == ["ds_a", "ds_b"]
    assert out == {"queued": 1, "reaped": 0, "orphans": 0, "revived": 0}
    assert deleted == []


async def test_a_restored_graph_keeps_its_data_source(monkeypatch, caplog):
    row = SimpleNamespace(id="ds_restored_unit", deleted_at="2026-01-01T00:00:00+00:00")
    app, deleted = _app([("ds_restored_unit", "ws1", "alice")], {"ds_restored_unit": row})
    gv, _ = _gv({"ds_restored_unit": ["g_r"]})
    asked = []

    async def purge(*, data_source_id, workspace_id, actor, **kw):
        asked.append(kw)
        return []                                    # create_purge_job found the graph live

    monkeypatch.setattr(purge_worker, "purge_graph_for_data_source", purge)
    monkeypatch.setattr(purge_worker.Reaper, "_orphaned_package_sources", _no_orphans)
    reaper = purge_worker.Reaper(app_session_factory=app, graphver_session_factory=gv)
    first = await reaper.run_once()
    second = await reaper.run_once()

    assert asked == [{"require_tombstoned": True}] * 2
    assert deleted == [], "the data source of a graph still standing was hard-deleted"
    assert first["reaped"] == second["reaped"] == 0
    warned = [r for r in caplog.records
              if r.levelname == "WARNING" and "ds_restored_unit" in r.getMessage()]
    assert len(warned) == 1, "the reaper should say so once per data source, not every pass"


async def test_the_reaper_revives_only_purges_that_failed_on_infrastructure_or_forks_since_gone(
        monkeypatch):
    app, _ = _app([], {})
    gv, seen = _gv({}, failed=["g_failed"])
    revived = []

    async def create(**kw):
        revived.append(kw)
        return "vjob_p"

    monkeypatch.setattr(purge_worker, "create_purge_job", create)
    monkeypatch.setattr(purge_worker.Reaper, "_orphaned_package_sources", _no_orphans)
    out = await purge_worker.Reaper(app_session_factory=app, graphver_session_factory=gv).run_once()

    assert out["revived"] == 1
    assert revived == [{"graph_id": "g_failed", "workspace_id": None, "actor": "reaper",
                        "require_tombstoned": True, "session_factory": gv}]
    (sql,) = [_sql(s) for s in seen if "JOIN" in str(s)]
    assert "'purge'" in sql and "'failed'" in sql
    assert "'infrastructure'" in sql, "a refused purge must not be re-run every pass"
    assert "'live_forks'" in sql, "a purge refused for forks is retried once they are gone"
    assert "deleted_at IS NOT NULL" in sql


# ── create_purge_job ──────────────────────────────────────────────────────────


class _PurgeSession:
    """``create_purge_job``'s transaction: the graph, its latest purge job, its fork count, and
    the fork rows a select of the graph's forks answers."""

    def __init__(self, graph, existing=None, forks=0, fork_rows=()):
        self.graph, self.existing, self.forks = graph, existing, forks
        self.fork_rows = list(fork_rows)
        self.statements, self.added = [], []

    async def execute(self, stmt):
        self.statements.append(stmt)
        if stmt.column_descriptions[0]["entity"] is JobORM:
            return _Rows([self.existing] if self.existing is not None else [])
        if "graphs.fork_parent_graph_id = " in str(stmt):
            return _Rows(self.fork_rows)
        return _Rows([self.graph])

    async def get(self, _model, _ident):
        return self.graph

    async def scalar(self, stmt):
        self.statements.append(stmt)
        return self.forks

    def add(self, obj):
        obj.id = obj.id or "vjob_new"
        self.added.append(obj)

    async def flush(self):
        pass


def _graph(*, head, deleted_at=None):
    return SimpleNamespace(id="g1", deleted_at=deleted_at, deleted_by=None, workspace_id="ws1",
                           data_source_id="ds1", main_head_commit_seq=head)


def _failed(code):
    return SimpleNamespace(id="vjob_p", status="failed", summary={"failure": {"code": code}},
                           error_message="boom", completed_at="t", updated_at="t")


async def test_the_purge_job_is_locked_before_the_graph():
    s = _PurgeSession(_graph(head=5, deleted_at="t"))
    await purge_worker.create_purge_job(graph_id="g1", workspace_id=None, actor="u", session=s)

    selects = [st for st in s.statements if hasattr(st, "column_descriptions")
               and st.column_descriptions[0]["entity"] in (JobORM, GraphORM)]
    assert [st.column_descriptions[0]["entity"] for st in selects[:2]] == [JobORM, GraphORM]
    assert all(st._for_update_arg is not None for st in selects[:2]), \
        "jobs then graphs, both FOR UPDATE (15 §8)"


async def test_a_trashed_fork_holds_its_parent_only_while_forks_of_its_own_read_through_it():
    seen = []

    class _S:
        async def scalar(self, stmt):
            seen.append(_sql(stmt))
            return 0

    assert await purge_worker._forks_reading(_S(), _graph(head=5)) == 0
    (sql,) = seen
    assert "graphs.fork_parent_graph_id = 'g1'" in sql
    assert "graphs.deleted_at IS NULL OR (EXISTS" in sql, sql
    assert "graphs_1.fork_parent_graph_id = graphver.graphs.id" in sql, \
        "a fork of a trashed fork still reads the parent through it"


async def test_a_purge_locks_the_graphs_forks_before_counting_them():
    s = _PurgeSession(_graph(head=5, deleted_at="t"))
    await purge_worker.create_purge_job(graph_id="g1", workspace_id=None, actor="u", session=s)

    lock = s.statements[2]
    assert getattr(lock, "column_descriptions", None), f"no fork-row select: {s.statements}"
    assert lock.column_descriptions[0]["entity"] is GraphORM
    assert "graphs.fork_parent_graph_id = " in str(lock)
    assert lock._for_update_arg is not None
    assert (lock._for_update_arg.read, lock._for_update_arg.key_share) == (True, True), \
        "FOR KEY SHARE: a restore's FOR UPDATE waits for it, a fork's commit does not"
    assert "count" in str(s.statements[3]), "the lock comes before the count"


async def test_a_parent_purge_queues_its_trashed_leaf_forks():
    def fork():
        return SimpleNamespace(id="f1", deleted_at="t", workspace_id="ws1",
                               data_source_id="dsfork_1")

    s = _PurgeSession(_graph(head=5, deleted_at="t"), fork_rows=[fork()])
    await purge_worker.create_purge_job(graph_id="g1", workspace_id=None, actor="u", session=s)
    jobs = {j.idempotency_key: j for j in s.added}
    assert set(jobs) == {"purge:g1", "purge:f1"}
    assert (jobs["purge:f1"].graph_id, jobs["purge:f1"].workspace_id,
            jobs["purge:f1"].data_source_id) == ("f1", "ws1", "dsfork_1")
    assert jobs["purge:f1"].summary == {"actor": "u", "parentGraphId": "g1"}
    cascade = _sql(s.statements[-1])
    assert "graphs.deleted_at IS NOT NULL" in cascade and "'purge'" in cascade
    assert "NOT (EXISTS" in cascade, cascade

    # The re-queue of a purge that failed on infrastructure goes ahead too, and so cascades.
    s = _PurgeSession(_graph(head=5, deleted_at="t"), existing=_failed("infrastructure"),
                      fork_rows=[fork()])
    assert await purge_worker.create_purge_job(
        graph_id="g1", workspace_id=None, actor="reaper", require_tombstoned=True,
        session=s) == "vjob_p"
    assert [j.idempotency_key for j in s.added] == ["purge:f1"]

    # A reaper call that skips adds nothing: the graph was restored, or forks still read it.
    for graph, forks in ((_graph(head=5), 0), (_graph(head=5, deleted_at="t"), 1)):
        s = _PurgeSession(graph, forks=forks, fork_rows=[fork()])
        assert await purge_worker.create_purge_job(
            graph_id="g1", workspace_id=None, actor="reaper", require_tombstoned=True,
            session=s) is None
        assert s.added == []


@pytest.mark.parametrize("head", [5, 1])
async def test_a_permanent_purge_refuses_a_graph_that_forks_read(head):
    graph = _graph(head=head)
    s = _PurgeSession(graph, forks=1)
    if head > 1:
        with pytest.raises(PurgeRefused) as exc:
            await purge_worker.create_purge_job(graph_id="g1", workspace_id="ws1", actor="u",
                                                session=s)
        assert exc.value.code == "live_forks"
        assert s.added == [] and graph.deleted_at is None
    else:
        # Regression guard: a graph with no history of its own (an abandoned enablement) gives
        # its forks nothing, so abandoning it is never refused.
        assert await purge_worker.create_purge_job(
            graph_id="g1", workspace_id="ws1", actor="u", session=s) == "vjob_new"


async def test_the_reaper_leaves_a_graph_that_forks_read_alone():
    graph = _graph(head=5, deleted_at="t")
    s = _PurgeSession(graph, forks=2)
    assert await purge_worker.create_purge_job(
        graph_id="g1", workspace_id=None, actor="reaper", require_tombstoned=True,
        session=s) is None
    assert s.added == []


async def test_the_reaper_skips_a_graph_restored_under_it():
    graph = _graph(head=5)
    s = _PurgeSession(graph)
    assert await purge_worker.create_purge_job(
        graph_id="g1", workspace_id=None, actor="reaper", require_tombstoned=True,
        session=s) is None
    assert s.added == [] and graph.deleted_at is None


@pytest.mark.parametrize("require_tombstoned, code, out, status", [
    (True, "live_forks", "vjob_p", "pending"),     # its forks are gone: nothing refuses now
    (True, "graph_not_deleted", None, "failed"),   # the reaper never re-runs another refusal
    (True, "infrastructure", "vjob_p", "pending"),
    (False, "live_forks", "vjob_p", "pending"),    # a person asking again does
])
async def test_which_failed_purge_is_revived(require_tombstoned, code, out, status):
    existing = _failed(code)
    s = _PurgeSession(_graph(head=5, deleted_at="t"), existing=existing)
    assert await purge_worker.create_purge_job(
        graph_id="g1", workspace_id=None, actor="reaper", require_tombstoned=require_tombstoned,
        session=s) == out
    assert existing.status == status


# ── the purge's count phase ──────────────────────────────────────────────────


def _count(graph, forks):
    log = []
    job = SimpleNamespace(summary={})

    class _Session:
        async def get(self, model, _ident):
            return graph if model is GraphORM else job

        async def scalar(self, stmt, *_a):
            log.append(("scalar", str(stmt)))
            return forks if "fork_parent_graph_id" in str(stmt) else 0

        async def execute(self, stmt, *_a):
            log.append(("execute", _sql(stmt)))
            return SimpleNamespace(rowcount=0)

    @asynccontextmanager
    async def sessions():
        yield _Session()

    class _Lease:
        job_id, epoch = "vjob_purge", 1

        async def checkpoint(self, _s, **values):
            log.append(("checkpoint", values))

    return purge_worker.PurgeRunner(session_factory=sessions), _Lease(), log


async def test_count_refuses_a_graph_that_forks_read():
    runner, lease, log = _count(_graph(head=5, deleted_at="t"), forks=1)
    with pytest.raises(PurgeRefused) as exc:
        await runner._phase_count(lease, "g1")
    assert exc.value.code == "live_forks"
    assert [kind for kind, _ in log] == ["scalar"], \
        f"nothing counted or cancelled before the refusal: {log}"


async def test_count_cancels_the_graphs_other_jobs_before_its_checkpoint():
    runner, lease, log = _count(_graph(head=5, deleted_at="t"), forks=0)
    assert await runner._phase_count(lease, "g1") is True

    updates = [i for i, (kind, sql) in enumerate(log)
               if kind == "execute" and sql.startswith("UPDATE") and "jobs" in sql]
    assert len(updates) == 1, log
    sql = log[updates[0]][1]
    assert "status='cancelled'" in sql
    assert "'pending', 'running'" in sql and "'vjob_purge'" in sql and "'g1'" in sql
    checkpoint = next(i for i, (kind, _) in enumerate(log) if kind == "checkpoint")
    assert updates[0] < checkpoint, "the cancel commits with the fenced checkpoint"


# ── a trashed graph is gone to the API ──────────────────────────────────────


async def test_a_pull_request_into_a_trashed_parent_is_404(monkeypatch):
    from backend.app.api.v1.endpoints import versioning as ep

    opened = []

    async def hold(_request, _ds, _ws):
        return None

    class _Svc:
        async def get_graph(self, _graph_id):
            return None                               # the parent is in the trash, or purging

        async def open_pr(self, **kw):
            opened.append(kw)
            return "pr_1"

    monkeypatch.setattr(ep.api_key_auth, "hold_to_data_source", hold)
    with pytest.raises(HTTPException) as exc:
        await ep.open_pull_request(ws_id="ws1", graph_id="g_fork", request=None, body=None,
                                   user=SimpleNamespace(id="alice"),
                                   _meta={"fork_parent_graph_id": "g_parent"}, svc=_Svc())
    assert exc.value.status_code == 404
    assert opened == []
