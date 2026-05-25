"""
Unit tests for the aggregation scheduler watchdog (P2-3).

The watchdog is responsible for marking two kinds of stuck jobs as
failed: running jobs whose worker died silently, and pending jobs
that never reached 'running' (trigger or skip-decision crash). P2-3
added the second branch — these tests pin down its behaviour.

Designed to load with ``--noconftest``.
"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta, timezone
from typing import Any, List, Optional
from types import SimpleNamespace

import pytest

_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from backend.app.services.aggregation.scheduler import AggregationScheduler  # noqa: E402


# ── Fakes ────────────────────────────────────────────────────────────────


def _iso(dt: datetime) -> str:
    return dt.isoformat()


class _FakeJob:
    """Stand-in for AggregationJobORM that supports attribute mutation
    + the fields the watchdog reads/writes."""

    def __init__(
        self,
        job_id: str,
        data_source_id: str,
        status: str,
        created_at: datetime,
        updated_at: Optional[datetime] = None,
    ) -> None:
        self.id = job_id
        self.data_source_id = data_source_id
        self.status = status
        self.created_at = _iso(created_at)
        self.updated_at = _iso(updated_at or created_at)
        self.error_message: Optional[str] = None


class _FakeState:
    def __init__(self, data_source_id: str, aggregation_status: str) -> None:
        self.data_source_id = data_source_id
        self.aggregation_status = aggregation_status


class _FakeResult:
    def __init__(self, items: list) -> None:
        self._items = items

    def scalars(self) -> "_FakeResult":
        return self

    def all(self) -> list:
        return self._items


class _FakeSession:
    """Routes execute() by query inspection — distinguishes the
    running-stale select from the pending-stuck select by sniffing
    the bound parameters / WHERE clause text. Both are select stmts
    over the same table; we differentiate via the order of execute()
    calls, which mirrors _run_watchdog's two sequential queries."""

    def __init__(
        self,
        running_stale: List[_FakeJob],
        pending_stuck: List[_FakeJob],
        states: dict,
    ) -> None:
        self._results_queue = [
            _FakeResult(running_stale),
            _FakeResult(pending_stuck),
        ]
        self._states = states
        self.commits = 0

    async def execute(self, _stmt: Any) -> _FakeResult:
        return self._results_queue.pop(0)

    async def get(self, _cls: Any, key: str) -> Optional[_FakeState]:
        return self._states.get(key)

    async def commit(self) -> None:
        self.commits += 1


# ── Tests ────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_stuck_pending_job_is_marked_failed():
    """A pending job older than the cutoff gets flipped to failed
    with a watchdog error message, and the DS state advances to
    failed."""
    now = datetime.now(tz=timezone.utc)
    stuck = _FakeJob(
        "job-1", "ds-a", status="pending", created_at=now - timedelta(hours=2),
    )
    state = _FakeState("ds-a", "pending")
    session = _FakeSession(running_stale=[], pending_stuck=[stuck], states={"ds-a": state})

    scheduler = AggregationScheduler(session_factory=None, registry=None)
    await scheduler._run_watchdog(session)

    assert stuck.status == "failed"
    assert "never reached 'running'" in (stuck.error_message or "")
    assert state.aggregation_status == "failed"
    assert session.commits == 1


@pytest.mark.asyncio
async def test_ds_state_not_clobbered_if_already_advanced():
    """If a subsequent successful run already moved the DS state to
    'ready' before the watchdog catches the stuck pending row, the
    watchdog must NOT clobber that state back to 'failed'."""
    now = datetime.now(tz=timezone.utc)
    stuck = _FakeJob(
        "job-1", "ds-a", status="pending", created_at=now - timedelta(hours=2),
    )
    state = _FakeState("ds-a", "ready")  # already advanced
    session = _FakeSession(running_stale=[], pending_stuck=[stuck], states={"ds-a": state})

    scheduler = AggregationScheduler(session_factory=None, registry=None)
    await scheduler._run_watchdog(session)

    # Job row still gets flipped — that's a no-op row, fine.
    assert stuck.status == "failed"
    # But the DS state is preserved.
    assert state.aggregation_status == "ready"


@pytest.mark.asyncio
async def test_no_stuck_jobs_means_no_commit():
    """An idle watchdog tick must not commit. Avoids pointless WAL
    churn under load and lets the caller distinguish 'we did
    nothing' from 'we did something'."""
    session = _FakeSession(running_stale=[], pending_stuck=[], states={})
    scheduler = AggregationScheduler(session_factory=None, registry=None)
    await scheduler._run_watchdog(session)
    assert session.commits == 0


@pytest.mark.asyncio
async def test_both_branches_in_one_commit():
    """When both a stale-running and a stuck-pending row exist in
    the same tick, both get marked failed and the session commits
    exactly once (not twice). Avoids partial-failure windows where
    one branch is durable and the other isn't."""
    now = datetime.now(tz=timezone.utc)
    stale_running = _FakeJob(
        "job-r", "ds-r",
        status="running",
        created_at=now - timedelta(hours=10),
        updated_at=now - timedelta(hours=8),
    )
    stuck_pending = _FakeJob(
        "job-p", "ds-p", status="pending", created_at=now - timedelta(hours=1),
    )
    states = {
        "ds-r": _FakeState("ds-r", "running"),
        "ds-p": _FakeState("ds-p", "pending"),
    }
    session = _FakeSession(
        running_stale=[stale_running],
        pending_stuck=[stuck_pending],
        states=states,
    )

    scheduler = AggregationScheduler(session_factory=None, registry=None)
    await scheduler._run_watchdog(session)

    assert stale_running.status == "failed"
    assert stuck_pending.status == "failed"
    assert states["ds-r"].aggregation_status == "failed"
    assert states["ds-p"].aggregation_status == "failed"
    assert session.commits == 1


@pytest.mark.asyncio
async def test_missing_ds_state_does_not_crash():
    """The DS state row may have been deleted (operator cleanup) by
    the time the watchdog fires. The job row still flips to failed;
    the state side-effect is just skipped."""
    now = datetime.now(tz=timezone.utc)
    stuck = _FakeJob(
        "job-1", "ds-gone", status="pending", created_at=now - timedelta(hours=2),
    )
    session = _FakeSession(running_stale=[], pending_stuck=[stuck], states={})

    scheduler = AggregationScheduler(session_factory=None, registry=None)
    await scheduler._run_watchdog(session)

    assert stuck.status == "failed"
    assert session.commits == 1
