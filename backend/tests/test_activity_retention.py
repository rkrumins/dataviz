"""How long who-did-what is kept.

The ledger and the outbox it is copied from both grow with every change
anyone makes; ``ACTIVITY_RETENTION_DAYS`` gives them a horizon. These tests
pin what the sweep may and may never delete:

* history before the horizon goes, from both tables, oldest first, a batch
  at a time — and nothing after it;
* the outbox keeps every row the relay has not copied yet;
* the outbox keeps the password events sign-in reads back, whatever their
  age — or long-standing administrators would be made to change a password
  they chose years ago;
* ``0`` keeps everything, and nothing shorter than a year is accepted;
* a summary whose comparison period reaches past the horizon drops the
  comparison rather than compare with half a period.
"""
from __future__ import annotations

import asyncio
import json
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import AuthAuditLogORM, OutboxEventORM
from backend.app.services import activity_retention, analytics_cache
from backend.app.services.activity_retention import (
    KEPT_IN_OUTBOX, drain, horizon, retention_days, run_sweeper,
    sweep_ledger_once, sweep_outbox_once,
)
from backend.app.services.outbox_relay import drain_once

NOW = datetime.now(timezone.utc)


@pytest.fixture(autouse=True)
def _fresh_cache():
    analytics_cache.clear()
    yield
    analytics_cache.clear()


def _days_ago(days: float) -> str:
    return (NOW - timedelta(days=days)).isoformat()


def _outbox(db_session, *, days_ago: float, processed: bool,
            event_type: str = "user.logged_in") -> str:
    event_id = f"evt_{uuid.uuid4().hex[:12]}"
    db_session.add(OutboxEventORM(
        id=event_id, event_type=event_type, aggregate_type="user", aggregate_id="usr_1",
        payload=json.dumps({"user_id": "usr_1"}), processed=processed,
        created_at=_days_ago(days_ago),
    ))
    return event_id


async def _ledger_ages(db_session) -> list[str]:
    return sorted((await db_session.execute(select(AuthAuditLogORM.occurred_at))).scalars())


# ── The setting ─────────────────────────────────────────────────────


@pytest.mark.parametrize("raw, days", [
    (None, 730), ("", 730), ("1000", 1000), ("banana", 730), ("100", 365), ("365", 365),
])
def test_two_years_unless_set_and_never_less_than_a_year(monkeypatch, raw, days):
    if raw is None:
        monkeypatch.delenv("ACTIVITY_RETENTION_DAYS", raising=False)
    else:
        monkeypatch.setenv("ACTIVITY_RETENTION_DAYS", raw)
    assert retention_days() == days


def test_zero_keeps_everything(monkeypatch):
    monkeypatch.setenv("ACTIVITY_RETENTION_DAYS", "0")
    assert retention_days() is None
    assert horizon() is None


def test_the_horizon_is_the_start_of_a_utc_day(monkeypatch):
    monkeypatch.delenv("ACTIVITY_RETENTION_DAYS", raising=False)
    at = datetime(2026, 10, 12, 19, 41, 7, tzinfo=timezone.utc)
    assert horizon(at) == datetime(2024, 10, 12, tzinfo=timezone.utc)


def test_the_outbox_keeps_every_event_sign_in_reads_back():
    from backend.app.auth.bootstrap import _OWN_PASSWORD_EVENTS

    assert set(_OWN_PASSWORD_EVENTS) <= KEPT_IN_OUTBOX


# ── The sweeps ──────────────────────────────────────────────────────


async def test_the_ledger_loses_what_happened_before_the_horizon_and_nothing_after(db_session):
    for days in (900, 800, 740, 700, 10):
        _outbox(db_session, days_ago=days, processed=False)
    await db_session.flush()
    while await drain_once(db_session):
        pass
    await db_session.commit()

    before = NOW - timedelta(days=730)
    # A batch at a time, oldest first.
    assert await sweep_ledger_once(db_session, before=before, batch=2) == 2
    ages = await _ledger_ages(db_session)
    assert len(ages) == 3
    assert round((NOW - datetime.fromisoformat(ages[0])) / timedelta(days=1)) == 740
    assert await sweep_ledger_once(db_session, before=before, batch=2) == 1
    assert await sweep_ledger_once(db_session, before=before, batch=2) == 0
    await db_session.commit()

    left = (await db_session.execute(select(func.count()).select_from(AuthAuditLogORM))).scalar()
    assert left == 2  # 700 days and 10 days ago


async def test_the_outbox_keeps_unrelayed_rows_and_password_facts(db_session):
    old_relayed = _outbox(db_session, days_ago=800, processed=True)
    old_waiting = _outbox(db_session, days_ago=800, processed=False)
    recent_relayed = _outbox(db_session, days_ago=5, processed=True)
    password = [
        _outbox(db_session, days_ago=2000, processed=True, event_type=t) for t in sorted(KEPT_IN_OUTBOX)
    ]
    await db_session.commit()

    deleted = await sweep_outbox_once(db_session, before=NOW - timedelta(days=730))
    await db_session.commit()

    assert deleted == 1
    left = set((await db_session.execute(select(OutboxEventORM.id))).scalars())
    assert old_relayed not in left
    assert {old_waiting, recent_relayed, *password} <= left


async def test_a_backlog_drains_in_batches_until_a_short_one(db_engine, monkeypatch):
    monkeypatch.setattr(activity_retention, "BATCH", 2)
    calls: list[int] = []

    @asynccontextmanager
    async def sessions():
        async with AsyncSession(db_engine) as session:
            yield session

    async def sweep(session, *, before):
        calls.append(1)
        return 2 if len(calls) < 3 else 1

    deleted = await drain(
        sessions, asyncio.Event(), lock="test:retention", sweep=sweep, before=NOW,
    )
    assert deleted == 5
    assert len(calls) == 3


async def test_keeping_everything_runs_no_sweep_at_all(monkeypatch):
    monkeypatch.setenv("ACTIVITY_RETENTION_DAYS", "0")

    def _never():
        raise AssertionError("no session should be opened")

    await asyncio.wait_for(run_sweeper(_never, asyncio.Event()), timeout=1)


# ── What readers are told ───────────────────────────────────────────


async def test_the_log_says_how_far_back_it_goes(test_client: AsyncClient, monkeypatch):
    monkeypatch.setenv("ACTIVITY_RETENTION_DAYS", "400")
    res = await test_client.get("/api/v1/admin/activity/events")
    assert res.status_code == 200, res.text
    assert res.json()["ledger"]["retentionDays"] == 400

    monkeypatch.setenv("ACTIVITY_RETENTION_DAYS", "0")
    analytics_cache.clear()
    res = await test_client.get("/api/v1/admin/activity/events")
    assert res.json()["ledger"]["retentionDays"] is None


async def test_a_comparison_reaching_past_the_horizon_is_dropped(
    test_client: AsyncClient, db_session, monkeypatch,
):
    _outbox(db_session, days_ago=3, processed=False)
    await db_session.flush()
    while await drain_once(db_session):
        pass
    await db_session.commit()

    monkeypatch.setenv("ACTIVITY_RETENTION_DAYS", "400")
    year = (await test_client.get("/api/v1/admin/activity/summary?days=365")).json()
    # The year before this one is mostly gone: no comparison, and a reason.
    assert year["totals"]["events"]["current"] == 1
    assert year["totals"]["events"]["previous"] is None
    assert year["totals"]["events"]["delta"] is None
    assert year["window"]["keptFrom"] is not None

    month = (await test_client.get("/api/v1/admin/activity/summary?days=30")).json()
    assert month["totals"]["events"]["previous"] == 0
    assert month["window"]["keptFrom"] is None
