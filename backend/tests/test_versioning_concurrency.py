"""Concurrency hardening for the main-ref write path (Task R).

Two disciplines advance a graph's ``main`` head: ``publish``/``merge``/``revert`` already
serialize on a per-graph advisory lock (``_lock_graph``); ``_apply_ops_once`` (the direct
write-through primitive) did NOT, so a write-through racing a merge could read a stale head,
spuriously trip ``NotUpToDate`` and flap the projection target. These tests pin the fix:

* a ``main``-branch ``_apply_ops_once`` takes ``_lock_graph`` before reading the head;
* a draft-branch write stays lock-free (unique-constraint + ``_retry_seq`` CAS, unchanged);
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


def _factory(rows):
    @contextlib.asynccontextmanager
    async def _session():
        yield _FakeSession(rows)
    return _session


def _svc_with_spy(rows, monkeypatch):
    svc = GraphVersioningService(session_factory=_factory(rows))
    lock_calls = []

    async def spy_lock(s, gid):                 # shadows the _lock_graph staticmethod
        lock_calls.append(gid)
    monkeypatch.setattr(svc, "_lock_graph", spy_lock)

    async def stop(*a, **k):                    # first awaited service call after the lock point
        raise _StopAfterLock
    monkeypatch.setattr(svc, "_current_values", stop)
    return svc, lock_calls


_DEL_OP = [{"op": "delete", "entity_id": "n1", "entity_kind": "node"}]


def test_apply_ops_main_takes_graph_lock(monkeypatch):
    rows = {(GraphORM, "g1"): _Obj(id="g1"),
            (BranchORM, "main1"): _Obj(id="main1", kind="main")}
    svc, lock_calls = _svc_with_spy(rows, monkeypatch)

    async def main_bid(s, gid):
        return "main1"
    monkeypatch.setattr(svc, "_main_branch_id", main_bid)

    with pytest.raises(_StopAfterLock):
        asyncio.run(svc.apply_ops(graph_id="g1", actor="u", ops=_DEL_OP))
    assert lock_calls == ["g1"]


def test_apply_ops_draft_skips_lock(monkeypatch):
    rows = {(GraphORM, "g1"): _Obj(id="g1"),
            (BranchORM, "draft1"): _Obj(id="draft1", kind="draft")}
    svc, lock_calls = _svc_with_spy(rows, monkeypatch)

    with pytest.raises(_StopAfterLock):
        asyncio.run(svc.apply_ops(graph_id="g1", actor="u", branch_id="draft1", ops=_DEL_OP))
    assert lock_calls == []


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
