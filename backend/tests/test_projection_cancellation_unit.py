"""Regression: ``FalkorProjector.project_graph`` must not strand its Postgres status row
at "projecting"/"rebuilding" when the coroutine is cancelled mid-flight (e.g. the
``asyncio.wait_for`` timeout around ``project_now`` cancelling a slow FalkorDB apply).

``asyncio.CancelledError`` is a ``BaseException`` (Python 3.8+), so a bare
``except Exception:`` around the apply/verify/commit span does NOT catch it — the status
row was left at "projecting" forever, and the UI's "Refreshing…" badge (which polls while
status is in {projecting, rebuilding}) spun indefinitely. This test cancels
``project_graph`` while it is stuck inside a stubbed FalkorDB apply and asserts both that
CancelledError still propagates (the asyncio cancellation contract is honored, never
swallowed) and that the status row is reset rather than left stranded.

Pure unit test — no Postgres, no FalkorDB; fake session/graph/projection-state stand in
for the store (same style as ``test_projection_verify_unit.py``).
"""
import asyncio
import contextlib

import pytest

from backend.app.services.versioning.models import GraphORM, ProjectionStateORM
from backend.app.services.versioning.projection import FalkorProjector


class _FakePS:
    def __init__(self):
        self.status = "idle"
        self.last_error = None
        self.projected_commit_seq = 3
        self.target_commit_seq = 5
        self.falkor_graph_name = "real_pinned_graph"   # != default_graph_name → not "unpinned"
        self.falkor_provider = None
        self.last_projected_at = None


class _FakeGraph:
    data_source_id = "ds1"
    workspace_id = "ws1"
    fork_parent_graph_id = None


class _FakeSession:
    def __init__(self, ps, graph):
        self._ps, self._graph = ps, graph

    async def get(self, model, key):
        if model is ProjectionStateORM:
            return self._ps
        if model is GraphORM:
            return self._graph
        raise AssertionError(f"unexpected get({model!r})")

    async def scalar(self, clause):
        # Single-flight advisory-lock acquire — project_graph holds it for the run; it always
        # grants here (contention is covered by test_projection_single_flight).
        assert "pg_try_advisory_lock" in str(clause), str(clause)
        return True

    async def execute(self, clause):
        # Single-flight advisory-lock release, run in project_graph's finally.
        assert "pg_advisory_unlock" in str(clause), str(clause)
        return None


def _fake_session_factory(ps, graph):
    @contextlib.asynccontextmanager
    async def _session():
        yield _FakeSession(ps, graph)
    return _session


async def _run(monkeypatch, hang_at: str) -> _FakePS:
    """Cancel ``project_graph`` while it is suspended at ``hang_at`` — ``"apply"`` (mid
    FalkorDB apply, the original timeout bug) or ``"client"`` (the provider-lookup/handle
    build, a suspension point OUTSIDE the try until this fix moved it in)."""
    ps = _FakePS()
    graph = _FakeGraph()
    proj = FalkorProjector(
        graph_client_factory=lambda name, provider_id=None: object(),
        session_factory=_fake_session_factory(ps, graph),
    )

    async def fake_main_branch_id(s, graph_id):
        return "main1"
    monkeypatch.setattr(proj._svc, "_main_branch_id", fake_main_branch_id)

    async def fake_compute_changes(s, graph, main_id, from_seq, to_seq):
        return [], [], [], []
    monkeypatch.setattr(proj, "_compute_changes", fake_compute_changes)

    started = asyncio.Event()

    async def hang(*args, **kwargs):
        started.set()
        await asyncio.Event().wait()          # never completes on its own — only via cancellation
    monkeypatch.setattr(proj, "_graph_client" if hang_at == "client" else "_apply", hang)

    task = asyncio.ensure_future(proj.project_graph("g1"))
    await asyncio.wait_for(started.wait(), timeout=1)   # cancel at the suspension point, not before/after
    assert ps.status == "projecting"                    # sanity: status IS committed before cancellation

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task                                       # must propagate — never swallowed

    return ps


def test_cancelled_projection_does_not_strand_status(monkeypatch):
    ps = asyncio.run(_run(monkeypatch, hang_at="apply"))
    assert ps.status == "idle", ps.status                # NOT left stranded at "projecting"
    assert ps.last_error == "projection cancelled (timeout)", ps.last_error


def test_cancelled_during_client_acquisition_does_not_strand_status(monkeypatch):
    # The FalkorDB handle build (provider lookup + connect) is a real suspension point; a
    # cancel there must reset the already-committed "projecting" row too (regression for the
    # acquisition running outside the cleanup try).
    ps = asyncio.run(_run(monkeypatch, hang_at="client"))
    assert ps.status == "idle", ps.status
    assert ps.last_error == "projection cancelled (timeout)", ps.last_error
