"""Concurrency hardening for the main-ref write path (Task R).

Two disciplines advance a graph's ``main`` head: ``publish``/``merge``/``revert`` already
serialize on a per-graph advisory lock (``_lock_graph``); ``_apply_ops_once`` (the direct
write-through primitive) did NOT, so a write-through racing a merge could read a stale head,
spuriously trip ``NotUpToDate`` and flap the projection target. These tests pin the fix:

* a ``main``-branch ``_apply_ops_once`` takes ``_lock_graph`` before reading the head;
* a draft-branch write takes the draft's row lock (``_lock_branch``), not the graph lock, and
  is refused when the draft is not open;
* a write that names main (its id or ``'main'``) is refused unless the caller allows it;
* every write checks the graph is writable: a draft write before the draft's lock, after the
  graph's lifecycle key shared, a main write after the graph lock; a paused graph's refusal comes after the idempotent replay (a save that
  landed still answers with its commit) and before the draft's open check;
* ``_compute_fork_merge`` fails loud on a fork row with no ``fork_base_commit_seq`` instead
  of silently merging against an empty (genesis) base.

Pure unit tests — no Postgres, no FalkorDB; fakes stand in for the store (same style as
``test_projection_cancellation_unit.py``). ``_current_values`` is stubbed to raise right
after the lock decision so the test exercises only the locking branch, not the full commit
machinery.
"""
import asyncio
import contextlib

import pytest

from backend.app.services.versioning.errors import BranchNotOpen, GraphNotWritable, MainWriteForbidden
from backend.app.services.versioning.models import BranchORM, GraphORM
from backend.app.services.versioning.service import ConcurrencyError, GraphVersioningService


class _StopAfterLock(Exception):
    """Short-circuits ``_apply_ops_once`` right after the branch-kind lock decision."""


class _Obj:
    def __init__(self, **kw):
        self.__dict__.update(kw)


class _FakeSession:
    def __init__(self, rows, bootstrap_status=None):
        self._rows = rows                       # {(Model, key): obj}
        self._bootstrap_status = bootstrap_status

    async def get(self, model, key):
        return self._rows.get((model, key))

    async def scalar(self, _stmt):
        # `_apply_ops_once` first asks whether an "enable version control" job is still
        # unfinished for this graph (writing to a half-imported graph is destructive —
        # see GraphVersioningService._assert_not_bootstrapping). None = no such job.
        return self._bootstrap_status

    async def refresh(self, _obj):
        pass


def _factory(rows):
    @contextlib.asynccontextmanager
    async def _session():
        yield _FakeSession(rows)
    return _session


def _svc_with_spy(rows, monkeypatch, refuse=None):
    svc = GraphVersioningService(session_factory=_factory(rows))
    lock_calls = []
    svc.branch_locks = []
    svc.calls = []                              # every lock and lifecycle check, in order

    async def spy_lock(s, gid):                 # shadows the _lock_graph staticmethod
        lock_calls.append(gid)
        svc.calls.append(("graph lock", gid))
    monkeypatch.setattr(svc, "_lock_graph", spy_lock)

    async def spy_lifecycle(s, gid, *, shared=False):
        svc.calls.append(("lifecycle shared" if shared else "lifecycle", gid))
    monkeypatch.setattr(svc, "_lock_lifecycle", spy_lifecycle)

    async def spy_writable(s, gid):
        svc.calls.append(("writable", gid))
        if refuse is not None:
            raise refuse
    monkeypatch.setattr(svc, "_assert_writable", spy_writable)

    async def main_bid(s, gid):
        return "main1"
    monkeypatch.setattr(svc, "_main_branch_id", main_bid)

    async def spy_lock_branch(s, gid, bid):     # shadows the _lock_branch staticmethod
        svc.branch_locks.append(bid)
        svc.calls.append(("branch lock", bid))
        return rows[(BranchORM, bid)]
    monkeypatch.setattr(svc, "_lock_branch", spy_lock_branch)

    async def stop(*a, **k):                    # first awaited service call after the lock point
        raise _StopAfterLock
    monkeypatch.setattr(svc, "_current_values", stop)
    return svc, lock_calls


_DEL_OP = [{"op": "delete", "entity_id": "n1", "entity_kind": "node"}]


def test_apply_ops_main_takes_graph_lock(monkeypatch):
    rows = {(GraphORM, "g1"): _Obj(id="g1"),
            (BranchORM, "main1"): _Obj(id="main1", kind="main")}
    svc, lock_calls = _svc_with_spy(rows, monkeypatch)

    with pytest.raises(_StopAfterLock):
        asyncio.run(svc.apply_ops(graph_id="g1", actor="u", ops=_DEL_OP))
    assert lock_calls == ["g1"]


def test_apply_ops_draft_takes_branch_lock(monkeypatch):
    """A draft write takes the draft's row lock, not the graph lock."""
    rows = {(GraphORM, "g1"): _Obj(id="g1"),
            (BranchORM, "draft1"): _Obj(id="draft1", kind="draft", status="open",
                                          owner="u", is_shared=False)}
    svc, lock_calls = _svc_with_spy(rows, monkeypatch)

    with pytest.raises(_StopAfterLock):
        asyncio.run(svc.apply_ops(graph_id="g1", actor="u", branch_id="draft1", ops=_DEL_OP))
    assert lock_calls == [] and svc.branch_locks == ["draft1"]


def test_apply_ops_named_main_is_forbidden(monkeypatch):
    """Naming main (its id or 'main') is refused before any lock; only allow_main writes through."""
    rows = {(GraphORM, "g1"): _Obj(id="g1"),
            (BranchORM, "main1"): _Obj(id="main1", kind="main", status="open")}
    svc, lock_calls = _svc_with_spy(rows, monkeypatch)

    for bid in ("main1", "main"):
        with pytest.raises(MainWriteForbidden):
            asyncio.run(svc.apply_ops(graph_id="g1", actor="u", branch_id=bid, ops=_DEL_OP))
    assert lock_calls == [] and svc.branch_locks == []

    with pytest.raises(_StopAfterLock):
        asyncio.run(svc.apply_ops(graph_id="g1", actor="u", branch_id="main1", ops=_DEL_OP,
                                  allow_main=True))
    assert lock_calls == ["g1"]


@pytest.mark.parametrize("status", ["merged", "abandoned", "publishing"])
def test_apply_ops_closed_draft_refused(monkeypatch, status):
    rows = {(GraphORM, "g1"): _Obj(id="g1"),
            (BranchORM, "draft1"): _Obj(id="draft1", kind="draft", status=status)}
    svc, _ = _svc_with_spy(rows, monkeypatch)

    with pytest.raises(BranchNotOpen) as exc:     # before _current_values (_StopAfterLock)
        asyncio.run(svc.apply_ops(graph_id="g1", actor="u", branch_id="draft1", ops=_DEL_OP))
    assert exc.value.status == status and exc.value.branch_id == "draft1"


def test_a_draft_write_checks_the_lifecycle_before_the_draft_lock(monkeypatch):
    rows = {(GraphORM, "g1"): _Obj(id="g1"),
            (BranchORM, "draft1"): _Obj(id="draft1", kind="draft", status="open",
                                          owner="u", is_shared=False)}
    svc, _ = _svc_with_spy(rows, monkeypatch)

    with pytest.raises(_StopAfterLock):
        asyncio.run(svc.apply_ops(graph_id="g1", actor="u", branch_id="draft1", ops=_DEL_OP))
    assert svc.calls == [("lifecycle shared", "g1"), ("writable", "g1"), ("branch lock", "draft1")]


def test_a_main_write_checks_the_lifecycle_after_the_graph_lock(monkeypatch):
    rows = {(GraphORM, "g1"): _Obj(id="g1"),
            (BranchORM, "main1"): _Obj(id="main1", kind="main")}
    svc, _ = _svc_with_spy(rows, monkeypatch)

    with pytest.raises(_StopAfterLock):
        asyncio.run(svc.apply_ops(graph_id="g1", actor="u", ops=_DEL_OP))
    assert svc.calls == [("graph lock", "g1"), ("writable", "g1")]


class _LandedSession(_FakeSession):
    """No unfinished enablement; the idempotency key's commit is ``c_landed``."""

    def __init__(self, rows):
        super().__init__(rows)
        self._answers = [None, "c_landed"]

    async def scalar(self, _stmt):
        return self._answers.pop(0)


@pytest.mark.parametrize("branch_id", [None, "draft1"], ids=["main", "draft"])
def test_a_landed_save_still_replays_on_a_frozen_graph(monkeypatch, branch_id):
    rows = {(GraphORM, "g1"): _Obj(id="g1"),
            (BranchORM, "main1"): _Obj(id="main1", kind="main"),
            (BranchORM, "draft1"): _Obj(id="draft1", kind="draft", status="open",
                                          owner="u", is_shared=False)}
    svc, _ = _svc_with_spy(rows, monkeypatch, refuse=GraphNotWritable("frozen"))

    @contextlib.asynccontextmanager
    async def session():
        yield _LandedSession(rows)
    svc._session = session

    async def current(s, gid, bid, ids):
        return {}
    monkeypatch.setattr(svc, "_current_values", current)
    res = asyncio.run(svc.apply_ops_detailed(graph_id="g1", actor="u", branch_id=branch_id,
                                             ops=_DEL_OP, idempotency_key="k1"))
    assert res.commit_id == "c_landed"


def test_a_frozen_draft_save_is_refused_before_the_open_check(monkeypatch):
    rows = {(GraphORM, "g1"): _Obj(id="g1"),
            (BranchORM, "draft1"): _Obj(id="draft1", kind="draft", status="merged")}
    svc, _ = _svc_with_spy(rows, monkeypatch, refuse=GraphNotWritable("frozen"))

    with pytest.raises(GraphNotWritable):
        asyncio.run(svc.apply_ops(graph_id="g1", actor="u", branch_id="draft1", ops=_DEL_OP))
    assert ("branch lock", "draft1") in svc.calls, "refused under the draft's lock, after any replay"


def test_lock_branch_is_graph_scoped_no_key_update():
    """FOR NO KEY UPDATE (foreign-key inserts on branch_members do not wait on it), scoped to the
    graph so a foreign draft is unknown, and re-read so a waiter sees the committed status."""
    from sqlalchemy.dialects import postgresql

    seen = []

    class _Result:
        def scalar_one_or_none(self):
            return None

    class _S:
        async def execute(self, stmt, params=None):
            seen.append(stmt)
            return _Result()

    with pytest.raises(ValueError, match="unknown branch"):
        asyncio.run(GraphVersioningService._lock_branch(_S(), "g1", "draft1"))
    sql = str(seen[-1].compile(dialect=postgresql.dialect()))
    assert "FOR NO KEY UPDATE" in sql and "branches.graph_id" in sql, sql
    assert seen[-1].get_execution_options().get("populate_existing") is True


def test_fork_merge_missing_base_raises():
    svc = GraphVersioningService(session_factory=_factory({}))
    fork = _Obj(id="fk1", fork_parent_graph_id="parent1", fork_base_commit_seq=None)
    s = _FakeSession({(GraphORM, "parent1"): _Obj(id="parent1")})

    with pytest.raises(ValueError, match="fork_base_commit_seq"):
        asyncio.run(svc._compute_fork_merge(s, fork, {}))


@pytest.mark.parametrize("job_status,expected", [
    ("running", "still being enabled"),
    ("pending", "still being enabled"),
    # The dangerous one: a FAILED enablement leaves the graph's head and projection
    # watermark parked. A write would advance the head past the partial import commit,
    # un-park the watermark, and let the projector drop the pinned SOURCE graph and
    # reseed it from a fraction of the data. Editing around it is never allowed.
    ("failed", "didn't finish"),
])
def test_writes_refused_while_enablement_is_unfinished(job_status, expected):
    @contextlib.asynccontextmanager
    async def _session():
        yield _FakeSession({}, bootstrap_status=job_status)

    svc = GraphVersioningService(session_factory=_session)
    with pytest.raises(ConcurrencyError, match=expected):
        asyncio.run(svc.apply_ops(graph_id="g1", actor="u", branch_id=None, ops=_DEL_OP))
