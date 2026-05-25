"""
Unit tests for the aggregation scheduler retention task (P0-3).

Exercises the gating logic of ``AggregationScheduler._maybe_run_retention``:
disabled when ``AGGREGATION_JOBS_RETENTION_DAYS<=0``, debounced by
``AGGREGATION_RETENTION_TICK_SECS``, swallows DB errors without crashing
the scheduler. The actual DELETE SQL is exercised in integration tests
against a live Postgres; here we verify the surrounding control flow.

Designed to load with ``--noconftest``.
"""
from __future__ import annotations

import importlib
import os
import sys
from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from unittest.mock import AsyncMock

import pytest

_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)


def _reload_scheduler_with_env() -> Any:
    """Reload the scheduler module so the env-driven module-level
    constants (`_RETENTION_DAYS`, `_RETENTION_TICK_SECS`) reflect the
    current ``os.environ``. Required because the constants are bound
    at import time."""
    import backend.app.services.aggregation.scheduler as sched_mod
    return importlib.reload(sched_mod)


class _FakeSession:
    """Minimal async-context-manager session that records the DELETE
    call and returns a configurable rowcount."""

    def __init__(self, rowcount: int = 0, raise_on_execute: Optional[Exception] = None) -> None:
        self._rowcount = rowcount
        self._raise = raise_on_execute
        self.executed: list[Any] = []
        self.commits = 0

    async def __aenter__(self) -> "_FakeSession":
        return self

    async def __aexit__(self, *_exc) -> bool:
        return False

    async def execute(self, stmt: Any, params: Optional[dict] = None) -> Any:
        self.executed.append((stmt, params))
        if self._raise is not None:
            raise self._raise

        class _R:
            rowcount = self._rowcount

        return _R()

    async def commit(self) -> None:
        self.commits += 1


def _session_factory_from(session: _FakeSession):
    def _factory():
        return session
    return _factory


def _make_scheduler(session: _FakeSession):
    sched_mod = _reload_scheduler_with_env()
    return sched_mod.AggregationScheduler(
        session_factory=_session_factory_from(session),
        registry=AsyncMock(),
    )


# ── Disabled path ────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_retention_disabled_when_days_zero(monkeypatch):
    """``AGGREGATION_JOBS_RETENTION_DAYS=0`` means 'never delete'."""
    monkeypatch.setenv("AGGREGATION_JOBS_RETENTION_DAYS", "0")
    session = _FakeSession()
    scheduler = _make_scheduler(session)

    await scheduler._maybe_run_retention()

    assert session.executed == [], "DELETE must not run when retention disabled"
    assert session.commits == 0


@pytest.mark.asyncio
async def test_retention_disabled_when_days_negative(monkeypatch):
    """Negative retention is treated as disabled, not 'delete everything'."""
    monkeypatch.setenv("AGGREGATION_JOBS_RETENTION_DAYS", "-1")
    session = _FakeSession()
    scheduler = _make_scheduler(session)

    await scheduler._maybe_run_retention()

    assert session.executed == []


# ── Happy path ───────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_retention_runs_and_commits_when_enabled(monkeypatch):
    """First call with retention enabled fires the DELETE + COMMIT."""
    monkeypatch.setenv("AGGREGATION_JOBS_RETENTION_DAYS", "30")
    monkeypatch.setenv("AGGREGATION_RETENTION_TICK_SECS", "3600")
    session = _FakeSession(rowcount=5)
    scheduler = _make_scheduler(session)

    await scheduler._maybe_run_retention()

    assert len(session.executed) == 1, "DELETE should fire once"
    _stmt, params = session.executed[0]
    assert "cutoff" in params
    # cutoff should be 30 days ago, ISO format
    cutoff_dt = datetime.fromisoformat(params["cutoff"])
    expected = datetime.now(tz=timezone.utc) - timedelta(days=30)
    delta = abs((cutoff_dt - expected).total_seconds())
    assert delta < 5, f"cutoff drift {delta}s exceeds tolerance"
    assert session.commits == 1


# ── Debounce ─────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_retention_debounced_within_tick_window(monkeypatch):
    """Second invocation within the tick window must be a no-op."""
    monkeypatch.setenv("AGGREGATION_JOBS_RETENTION_DAYS", "30")
    monkeypatch.setenv("AGGREGATION_RETENTION_TICK_SECS", "3600")
    session = _FakeSession(rowcount=0)
    scheduler = _make_scheduler(session)

    await scheduler._maybe_run_retention()
    await scheduler._maybe_run_retention()

    assert len(session.executed) == 1, "second call within tick window must skip"
    assert session.commits == 1


@pytest.mark.asyncio
async def test_retention_runs_again_after_tick_window(monkeypatch):
    """After enough wall-clock time has passed the next call fires again."""
    monkeypatch.setenv("AGGREGATION_JOBS_RETENTION_DAYS", "30")
    monkeypatch.setenv("AGGREGATION_RETENTION_TICK_SECS", "1")
    session = _FakeSession(rowcount=0)
    scheduler = _make_scheduler(session)

    await scheduler._maybe_run_retention()
    # Simulate elapsed time by rewinding the bookkeeping field.
    scheduler._last_retention_at = datetime.now(tz=timezone.utc) - timedelta(seconds=10)
    await scheduler._maybe_run_retention()

    assert len(session.executed) == 2, "second call after tick window must run"


# ── Error swallowing ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_retention_swallows_db_errors(monkeypatch):
    """A failing DELETE must not propagate — scheduler keeps ticking."""
    monkeypatch.setenv("AGGREGATION_JOBS_RETENTION_DAYS", "30")
    monkeypatch.setenv("AGGREGATION_RETENTION_TICK_SECS", "3600")
    session = _FakeSession(raise_on_execute=RuntimeError("connection lost"))
    scheduler = _make_scheduler(session)

    # Should not raise.
    await scheduler._maybe_run_retention()

    assert len(session.executed) == 1
    assert session.commits == 0
    # Cooldown still set, so we don't retry-storm on the next tick.
    assert scheduler._last_retention_at is not None
