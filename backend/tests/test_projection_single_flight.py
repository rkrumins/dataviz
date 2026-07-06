"""Single-flight guard for ``FalkorProjector.project_graph`` (Task R).

Publish/merge fan out one ``project_now`` per operation, so two near-simultaneous first
merges on a blank graph could run overlapping DROP+reseed projections and corrupt the
FalkorDB cache. A full seed's DROP+MERGE happens OUTSIDE any Postgres transaction, so a
transaction-scoped lock cannot cover it; the guard is a SESSION-level advisory lock held on
a dedicated connection for the whole projection. A second concurrent projection finds the
lock held (``pg_try_advisory_lock`` → False) and returns immediately without touching the
cache; the lock is released (``pg_advisory_unlock``) in a finally so a later projection is
never wedged.

Pure unit test — no Postgres, no FalkorDB; a fake session models the advisory lock across
connections (same style as ``test_projection_cancellation_unit.py``).
"""
import asyncio
import contextlib

import pytest

from backend.app.services.versioning.models import GraphORM, ProjectionStateORM
from backend.app.services.versioning.projection import FalkorProjector


class _FakePS:
    def __init__(self, projected, target):
        self.status = "idle"
        self.last_error = None
        self.projected_commit_seq = projected
        self.target_commit_seq = target
        self.falkor_graph_name = "real_pinned_graph"   # != default_graph_name → not "unpinned"
        self.falkor_provider = None
        self.last_projected_at = None
        self.progress_done = None
        self.progress_total = None


class _FakeGraph:
    data_source_id = "ds1"
    fork_parent_graph_id = None


class _Advisory:
    """Postgres session-level advisory lock shared across every connection (one key)."""

    def __init__(self, initially_held=False):
        self.held = initially_held
        self.acquire_calls = 0
        self.release_calls = 0

    def try_acquire(self):
        self.acquire_calls += 1
        if self.held:
            return False
        self.held = True
        return True

    def release(self):
        self.release_calls += 1
        self.held = False
        return True


class _LockSession:
    def __init__(self, advisory, ps, graph):
        self._adv, self._ps, self._graph = advisory, ps, graph

    async def get(self, model, key):
        if model is ProjectionStateORM:
            return self._ps
        if model is GraphORM:
            return self._graph
        raise AssertionError(f"unexpected get({model!r})")

    async def scalar(self, clause):
        sql = str(clause)
        assert "pg_try_advisory_lock" in sql, f"unexpected scalar: {sql}"
        return self._adv.try_acquire()

    async def execute(self, clause):
        sql = str(clause)
        assert "pg_advisory_unlock" in sql, f"unexpected execute: {sql}"
        self._adv.release()
        return object()


def _factory(advisory, ps, graph):
    @contextlib.asynccontextmanager
    async def _session():
        yield _LockSession(advisory, ps, graph)
    return _session


def _projector(advisory, ps, graph, target_resolver=None):
    return FalkorProjector(
        graph_client_factory=lambda name, provider_id=None: object(),
        session_factory=_factory(advisory, ps, graph),
        target_resolver=target_resolver,
    )


def test_second_projection_skips_when_lock_held():
    # A concurrent projection already holds the lock → this call short-circuits.
    adv = _Advisory(initially_held=True)
    entered = {"body": False}

    async def resolver(svc, gid):               # first line of the projection body
        entered["body"] = True
        return None

    proj = _projector(adv, _FakePS(3, 5), _FakeGraph(), target_resolver=resolver)
    result = asyncio.run(proj.project_graph("g1"))

    assert result == {"noop": True, "skipped": "in-flight"}
    assert entered["body"] is False             # body never ran
    assert adv.release_calls == 0               # nothing acquired here → nothing to release


def test_projection_releases_lock_on_completion():
    # Lock free → acquire, run the (immediate-noop) body, release in finally so the next
    # projection is not wedged.
    adv = _Advisory(initially_held=False)
    proj = _projector(adv, _FakePS(5, 5), _FakeGraph())      # projected == target → noop
    result = asyncio.run(proj.project_graph("g1"))

    assert result == {"projected": 5, "applied": 0, "noop": True}
    assert adv.acquire_calls == 1
    assert adv.release_calls == 1
    assert adv.held is False
