"""Profiling retention: the raw-tier cap, and the tick that drives it.

The age side of retention is now tiered and lives in
``test_profiling_compaction.py`` — raw is compacted into hour buckets before
it is deleted, so how far back history goes is no longer a function of how
volatile a source is.

What survives here is the RAW-TIER CAP. It exists for a different failure mode
than any cutoff: a source thrashing under a broken loader changes on every 60s
probe, and 43k rows a month of one source is how the raw table comes to be
dominated by its least healthy member. It bounds that between passes, and —
crucially, unlike the flat scheme it replaces — it can no longer shorten
coverage, because the buckets were built before raw became eligible for
deletion.
"""
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import (
    DataSourceCountRollupORM,
    DataSourceCountSnapshotORM,
)
from backend.app.db.repositories import count_alerts_repo, profiling_repo


def _iso(days_ago: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days_ago)).isoformat()


async def _add(session: AsyncSession, ds_id: str, captured_at: str, nodes: int = 1):
    session.add(DataSourceCountSnapshotORM(
        id=f"snp_{ds_id}_{captured_at}",
        data_source_id=ds_id,
        captured_at=captured_at,
        node_count=nodes,
        edge_count=0,
        entity_type_counts="{}",
        edge_type_counts="{}",
        counts_digest="d",
        lane="probe",
        capture_reason="changed",
    ))
    await session.flush()


async def _count(session: AsyncSession, ds_id: str | None = None) -> int:
    stmt = select(func.count(DataSourceCountSnapshotORM.id))
    if ds_id:
        stmt = stmt.where(DataSourceCountSnapshotORM.data_source_id == ds_id)
    return int((await session.execute(stmt)).scalar_one())


async def test_purge_over_cap_keeps_the_newest_rows_per_source(
    db_session: AsyncSession,
):
    for day in range(10):
        await _add(db_session, "ds_a", _iso(day), nodes=day)

    removed = await profiling_repo.purge_over_cap(
        db_session, max_rows_per_source=3,
    )
    assert removed == 7

    rows = list((await db_session.execute(
        select(DataSourceCountSnapshotORM)
        .where(DataSourceCountSnapshotORM.data_source_id == "ds_a")
        .order_by(DataSourceCountSnapshotORM.captured_at.desc())
    )).scalars().all())
    assert len(rows) == 3
    # Newest kept: days 0, 1, 2 ago.
    assert [r.node_count for r in rows] == [0, 1, 2]


async def test_the_cap_is_applied_per_source_not_globally(
    db_session: AsyncSession,
):
    """One noisy source must not evict a quiet one's history."""
    for day in range(8):
        await _add(db_session, "ds_noisy", _iso(day))
    await _add(db_session, "ds_quiet", _iso(3))

    await profiling_repo.purge_over_cap(db_session, max_rows_per_source=2)
    assert await _count(db_session, "ds_noisy") == 2
    assert await _count(db_session, "ds_quiet") == 1


async def test_purge_over_cap_is_idempotent(db_session: AsyncSession):
    for day in range(6):
        await _add(db_session, "ds_a", _iso(day))
    assert await profiling_repo.purge_over_cap(
        db_session, max_rows_per_source=2) == 4
    assert await profiling_repo.purge_over_cap(
        db_session, max_rows_per_source=2) == 0


# ── both together ────────────────────────────────────────────────────

async def test_the_cap_only_ever_touches_raw(db_session: AsyncSession):
    """The behaviour change that makes the cap safe.

    Under the flat scheme the cap deleted history outright. Now the buckets
    are built first, so trimming raw back to two rows leaves the record of
    what happened intact.
    """
    now = datetime(2026, 8, 24, 12, 0, tzinfo=timezone.utc)
    for hours in range(6):
        await _add(db_session, "ds_a", (now - timedelta(hours=hours)).isoformat(), nodes=100 + hours)

    for _ in range(10):
        if not await profiling_repo.compact(db_session, grain="hour", now=now):
            break

    removed = await profiling_repo.purge_over_cap(db_session, max_rows_per_source=2)
    assert removed == 4
    assert await _count(db_session, "ds_a") == 2

    buckets = (await db_session.execute(
        select(func.count()).select_from(DataSourceCountRollupORM.__table__)
    )).scalar_one()
    assert buckets == 6, "every hour still on the record"


async def test_retention_on_a_clean_table_deletes_nothing(
    db_session: AsyncSession,
):
    policy = profiling_repo.RetentionPolicy(
        raw_days=7, hourly_days=45, daily_days=400, max_rows_per_source=5000,
    )
    result = await profiling_repo.run_retention(db_session, policy)
    assert result == {"raw": 0, "over_cap": 0, "hour": 0, "day": 0}


async def test_the_batch_bounds_a_single_pass(db_session: AsyncSession):
    """A large backlog drains over ticks rather than in one long transaction
    against a table the counts path is actively writing to."""
    for i in range(12):
        await _add(db_session, "ds_a", _iso(100 + i))

    removed = await profiling_repo.purge_over_cap(
        db_session, max_rows_per_source=1, batch=5,
    )
    assert removed == 5
    assert await _count(db_session, "ds_a") == 7


# ── the tick ─────────────────────────────────────────────────────────


async def test_the_retention_tick_respects_its_own_cadence(monkeypatch):
    """It runs on the profiling loop, not the hourly stream-trim tick.

    That move is the fix for a real defect: a cadence gate can never fire
    faster than the loop hosting it, so riding an hourly loop made every
    sub-hour interval — compaction at 300s, alerting at 900s — silently
    hourly.
    """
    from backend.insights_service import scheduler

    calls: list[int] = []

    class _Session:
        async def __aenter__(self): return self
        async def __aexit__(self, *exc): return False
        async def commit(self): return None

    async def fake_retention(_session, _policy, **_kw):
        calls.append(1)
        return {"raw": 0, "over_cap": 0, "hour": 0, "day": 0}

    async def fake_purge_alerts(_session, **_kw):
        return 0

    monkeypatch.setattr(scheduler, "get_jobs_session", lambda: _Session())
    monkeypatch.setattr(profiling_repo, "run_retention", fake_retention)
    monkeypatch.setattr(count_alerts_repo, "purge_alerts", fake_purge_alerts)
    monkeypatch.setattr(scheduler, "_RETENTION_INTERVAL_SECS", 3600.0)
    scheduler._retention_state["last_run_monotonic"] = 0.0

    await scheduler._maybe_run_profiling_retention()
    assert calls == [1], "the first tick must run"

    await scheduler._maybe_run_profiling_retention()
    assert calls == [1], "a second tick inside the interval must not"

    monkeypatch.setattr(scheduler, "_RETENTION_INTERVAL_SECS", 0.0)
    await scheduler._maybe_run_profiling_retention()
    assert calls == [1, 1]


async def test_the_retention_tick_reports_its_last_run(monkeypatch):
    """Surfaced on /health — a retention pass that silently stopped running is
    otherwise invisible until the table is enormous."""
    from backend.insights_service import scheduler

    class _Session:
        async def __aenter__(self): return self
        async def __aexit__(self, *exc): return False
        async def commit(self): return None

    async def fake_retention(_session, _policy, **_kw):
        return {"raw": 7, "over_cap": 3, "hour": 2, "day": 1}

    async def fake_purge_alerts(_session, **_kw):
        return 0

    monkeypatch.setattr(scheduler, "get_jobs_session", lambda: _Session())
    monkeypatch.setattr(profiling_repo, "run_retention", fake_retention)
    monkeypatch.setattr(count_alerts_repo, "purge_alerts", fake_purge_alerts)
    monkeypatch.setattr(scheduler, "_RETENTION_INTERVAL_SECS", 0.0)

    await scheduler._maybe_run_profiling_retention()
    status = scheduler.get_history_purge_status()
    assert status["last_raw"] == 7
    assert status["last_hour"] == 2
    assert status["last_day"] == 1
    assert status["last_run_at"] is not None
    assert status["last_error"] is None


async def test_the_compaction_tick_has_its_own_cadence(monkeypatch):
    """Compaction must be able to run far more often than retention: the
    purge cannot delete raw beyond the compaction watermark, so a compactor
    pinned to the retention cadence stalls retention behind itself."""
    from backend.insights_service import scheduler

    grains: list[str] = []

    class _Session:
        async def __aenter__(self): return self
        async def __aexit__(self, *exc): return False
        async def commit(self): return None

    async def fake_compact(_session, *, grain, **_kw):
        grains.append(grain)
        return 0

    monkeypatch.setattr(scheduler, "get_jobs_session", lambda: _Session())
    monkeypatch.setattr(profiling_repo, "compact", fake_compact)
    monkeypatch.setattr(scheduler, "_COMPACT_INTERVAL_SECS", 0.0)
    scheduler._compaction_state["last_run_monotonic"] = 0.0

    await scheduler._maybe_compact_profiling()
    assert grains == ["hour", "day"], (
        "hour before day — the day tier is built FROM the hour tier"
    )


# ── an operator override actually reaches the purge ──────────────────


async def test_the_retention_pass_uses_the_saved_policy_not_the_environment(
    db_session: AsyncSession, monkeypatch,
):
    """The worst of three outcomes would be a policy that persisted, displayed,
    and did nothing — the settings page confirming a change the purge never
    made. This pins that the tick resolves from the database."""
    from backend.app.db.models import PlatformSettingsORM
    from backend.insights_service import scheduler

    db_session.add(PlatformSettingsORM(id=1, profiling_raw_retention_days=3))
    await db_session.flush()

    seen: list = []

    class _Session:
        async def __aenter__(self): return _Committing(db_session)
        async def __aexit__(self, *exc): return False

    class _Committing:
        def __init__(self, inner): self._inner = inner
        def __getattr__(self, name): return getattr(self._inner, name)
        async def commit(self): return None

    async def fake_run_retention(_session, policy, **_kw):
        seen.append(policy)
        return {"raw": 0, "over_cap": 0, "hour": 0, "day": 0}

    async def fake_purge_alerts(_session, **_kw):
        return 0

    monkeypatch.setattr(scheduler, "get_jobs_session", lambda: _Session())
    monkeypatch.setattr(profiling_repo, "run_retention", fake_run_retention)
    monkeypatch.setattr(count_alerts_repo, "purge_alerts", fake_purge_alerts)
    monkeypatch.setattr(scheduler, "_RETENTION_INTERVAL_SECS", 0.0)

    await scheduler._maybe_run_profiling_retention()

    assert seen, "the pass must have run"
    assert seen[0].raw_days == 3, "the saved override, not the env default"
