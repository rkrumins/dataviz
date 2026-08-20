"""Counts-history retention — the age cutoff and the per-source cap.

Both passes exist for different failure modes and neither replaces the other.
The age cutoff bounds how far back the table goes; the per-source cap bounds
how much ONE pathological source can contribute, which the age cutoff cannot
— a graph thrashing under a broken loader changes on every 60s probe, and 43k
rows a month of a single source is how this table would come to be dominated
by its least healthy member.
"""
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import DataSourceCountSnapshotORM
from backend.app.db.repositories import stats_history_repo


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


@pytest.fixture(autouse=True)
def _clear_policy_cache():
    stats_history_repo.invalidate_history_policy_cache()
    yield
    stats_history_repo.invalidate_history_policy_cache()


def _policy(**overrides) -> stats_history_repo.HistoryPolicy:
    base = stats_history_repo.env_history_policy()
    return stats_history_repo.HistoryPolicy(**{**base.__dict__, **overrides})


# ── age ──────────────────────────────────────────────────────────────

async def test_purge_by_age_removes_only_rows_past_the_cutoff(
    db_session: AsyncSession,
):
    await _add(db_session, "ds_a", _iso(100))
    await _add(db_session, "ds_a", _iso(95))
    await _add(db_session, "ds_a", _iso(10))
    await _add(db_session, "ds_a", _iso(1))

    removed = await stats_history_repo.purge_by_age(db_session, retention_days=90)
    assert removed == 2
    assert await _count(db_session) == 2


async def test_purge_by_age_is_idempotent(db_session: AsyncSession):
    await _add(db_session, "ds_a", _iso(100))
    assert await stats_history_repo.purge_by_age(db_session, retention_days=90) == 1
    assert await stats_history_repo.purge_by_age(db_session, retention_days=90) == 0


async def test_the_thirty_day_requirement_survives_the_default_retention(
    db_session: AsyncSession,
):
    """The product requirement is 30 days; the default keeps 90 so someone
    investigating a month-old incident can still see the month before it."""
    for day in (1, 15, 29, 45, 89):
        await _add(db_session, "ds_a", _iso(day))

    policy = stats_history_repo.env_history_policy()
    await stats_history_repo.purge_by_age(
        db_session, retention_days=policy.retention_days,
    )
    assert await _count(db_session) == 5


# ── per-source cap ───────────────────────────────────────────────────

async def test_purge_over_cap_keeps_the_newest_rows_per_source(
    db_session: AsyncSession,
):
    for day in range(10):
        await _add(db_session, "ds_a", _iso(day), nodes=day)

    removed = await stats_history_repo.purge_over_cap(
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

    await stats_history_repo.purge_over_cap(db_session, max_rows_per_source=2)
    assert await _count(db_session, "ds_noisy") == 2
    assert await _count(db_session, "ds_quiet") == 1


async def test_purge_over_cap_is_idempotent(db_session: AsyncSession):
    for day in range(6):
        await _add(db_session, "ds_a", _iso(day))
    assert await stats_history_repo.purge_over_cap(
        db_session, max_rows_per_source=2) == 4
    assert await stats_history_repo.purge_over_cap(
        db_session, max_rows_per_source=2) == 0


# ── both together ────────────────────────────────────────────────────

async def test_purge_snapshots_runs_both_passes(db_session: AsyncSession):
    await _add(db_session, "ds_a", _iso(200))
    for day in range(5):
        await _add(db_session, "ds_a", _iso(day))

    result = await stats_history_repo.purge_snapshots(
        db_session, _policy(retention_days=90, max_rows_per_source=2),
    )
    assert result == {"by_age": 1, "over_cap": 3}
    assert await _count(db_session) == 2


async def test_purge_on_a_clean_table_deletes_nothing(db_session: AsyncSession):
    result = await stats_history_repo.purge_snapshots(
        db_session, _policy(retention_days=90, max_rows_per_source=10),
    )
    assert result == {"by_age": 0, "over_cap": 0}


async def test_the_batch_bounds_a_single_pass(db_session: AsyncSession):
    """A retention window shortened from 90 days to 7 must drain over several
    ticks rather than holding one long transaction against a table the counts
    path is actively writing to."""
    for i in range(12):
        await _add(db_session, "ds_a", _iso(100 + i))

    first = await stats_history_repo.purge_by_age(
        db_session, retention_days=90, batch=5,
    )
    assert first == 5
    assert await _count(db_session) == 7


# ── the scheduler tick ────────────────────────────────────────────────

async def test_the_purge_tick_respects_its_own_cadence(monkeypatch):
    """It rides the hourly stream-trim tick but keeps its own interval, so
    retention can be tuned without changing Redis housekeeping. Without the
    gate it would run on every trim tick regardless."""
    from backend.insights_service import scheduler

    calls: list[int] = []

    class _Session:
        async def __aenter__(self): return self
        async def __aexit__(self, *exc): return False
        async def commit(self): return None

    async def fake_resolve(_session):
        return stats_history_repo.env_history_policy()

    async def fake_purge(_session, _policy, **_kw):
        calls.append(1)
        return {"by_age": 0, "over_cap": 0}

    monkeypatch.setattr(scheduler, "get_jobs_session", lambda: _Session())
    monkeypatch.setattr(stats_history_repo, "resolve_history_policy", fake_resolve)
    monkeypatch.setattr(stats_history_repo, "purge_snapshots", fake_purge)
    monkeypatch.setattr(scheduler, "_HISTORY_PURGE_INTERVAL_SECS", 3600.0)
    scheduler._history_purge_state["last_run_monotonic"] = 0.0

    await scheduler._maybe_purge_count_history()
    assert calls == [1], "the first tick must run"

    await scheduler._maybe_purge_count_history()
    assert calls == [1], "a second tick inside the interval must not"

    # Interval elapsed.
    monkeypatch.setattr(scheduler, "_HISTORY_PURGE_INTERVAL_SECS", 0.0)
    await scheduler._maybe_purge_count_history()
    assert calls == [1, 1]


async def test_the_purge_tick_reports_its_last_run(monkeypatch):
    """Surfaced on /health — a retention pass that silently stopped running is
    otherwise invisible until the table is enormous."""
    from backend.insights_service import scheduler

    class _Session:
        async def __aenter__(self): return self
        async def __aexit__(self, *exc): return False
        async def commit(self): return None

    async def fake_resolve(_session):
        return stats_history_repo.env_history_policy()

    async def fake_purge(_session, _policy, **_kw):
        return {"by_age": 7, "over_cap": 3}

    monkeypatch.setattr(scheduler, "get_jobs_session", lambda: _Session())
    monkeypatch.setattr(stats_history_repo, "resolve_history_policy", fake_resolve)
    monkeypatch.setattr(stats_history_repo, "purge_snapshots", fake_purge)
    monkeypatch.setattr(scheduler, "_HISTORY_PURGE_INTERVAL_SECS", 0.0)

    await scheduler._maybe_purge_count_history()
    status = scheduler.get_history_purge_status()
    assert status["last_by_age"] == 7
    assert status["last_over_cap"] == 3
    assert status["last_run_at"] is not None
    assert status["last_error"] is None
