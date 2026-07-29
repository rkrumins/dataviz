"""The revocation table has to shed rows.

``revoked_refresh_jti`` gains a row per rotation and a sentinel per
revoked family. ``expires_at`` was written from the start and documented
as the marker for reclaiming a row — and nothing ever read it, so the
table grew for the life of the deployment and shed nothing. At a
15-minute access TTL that is roughly ``users x tabs x 32`` rows a day.

It never surfaced as slowness because every read against it is a
primary-key lookup, which is exactly why it went unnoticed.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import RevokedRefreshJtiORM
from backend.app.db.repositories.refresh_token_repo import (
    make_refresh_store,
    purge_expired,
)
from backend.app.services.refresh_token_gc import run_sweeper, sweep_once


def _iso(offset_days: float) -> str:
    return (
        datetime.now(timezone.utc) + timedelta(days=offset_days)
    ).isoformat()


async def _add(session: AsyncSession, jti: str, expires_in_days: float) -> None:
    session.add(
        RevokedRefreshJtiORM(
            jti=jti,
            family_id="fam",
            revoked_at=_iso(-1),
            expires_at=_iso(expires_in_days),
        )
    )
    await session.flush()


async def _count(session: AsyncSession) -> int:
    return (
        await session.execute(select(func.count()).select_from(RevokedRefreshJtiORM))
    ).scalar_one()


async def test_expired_rows_are_reclaimed(db_session):
    await _add(db_session, "old-1", -1)
    await _add(db_session, "old-2", -30)
    assert await purge_expired(db_session) == 2
    assert await _count(db_session) == 0


async def test_live_rows_are_left_alone(db_session):
    """A consumed jti whose token could still be presented must stay.

    Deleting it early would make a genuine replay undetectable — the
    reuse check reads exactly this table.
    """
    await _add(db_session, "live", 3)
    await _add(db_session, "expired", -3)
    assert await purge_expired(db_session) == 1
    remaining = (
        await db_session.execute(select(RevokedRefreshJtiORM.jti))
    ).scalars().all()
    assert remaining == ["live"]


async def test_family_sentinels_are_reclaimable(db_session):
    """Sentinels used to be stamped year 9999 so the sweep skipped them.

    A dead family is dead forever, so that reasoning held — and it made
    every revocation a permanent row, the one kind that can never be
    reclaimed. A sentinel only has to outlive the newest token in its
    family, which is one refresh TTL from the revocation.
    """
    store = make_refresh_store(db_session)
    await store.revoke_family("doomed-family")
    await db_session.flush()

    row = (
        await db_session.execute(
            select(RevokedRefreshJtiORM).where(
                RevokedRefreshJtiORM.family_id == "doomed-family"
            )
        )
    ).scalar_one()
    assert not row.expires_at.startswith("9999"), (
        "a sentinel the sweep can never reclaim is a permanent row"
    )

    # Still guards the family for longer than any token in it can live.
    assert row.expires_at > _iso(7)


async def test_the_batch_is_bounded(db_session):
    """One sweep must not hold a long transaction on the jobs pool."""
    for i in range(10):
        await _add(db_session, f"bulk-{i}", -1)
    assert await purge_expired(db_session, batch=4) == 4
    assert await _count(db_session) == 6


async def test_an_empty_table_is_a_no_op(db_session):
    assert await purge_expired(db_session) == 0


async def test_sweeper_drains_the_backlog_then_waits(db_session):
    """A deployment upgrading into this has months of rows.

    Waiting a full interval between batches would take weeks to clear,
    so the first tick drains greedily and only then settles into the
    schedule.
    """
    for i in range(9):
        await _add(db_session, f"backlog-{i}", -1)
    await db_session.commit()

    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def factory():
        yield db_session

    shutdown = asyncio.Event()
    # A batch smaller than the backlog forces more than one pass.
    import backend.app.services.refresh_token_gc as gc_mod
    original = gc_mod._BATCH
    gc_mod._BATCH = 4
    try:
        task = asyncio.create_task(run_sweeper(factory, shutdown, interval=30.0))
        for _ in range(50):
            await asyncio.sleep(0.01)
            if await _count(db_session) == 0:
                break
        shutdown.set()
        await asyncio.wait_for(task, timeout=2.0)
    finally:
        gc_mod._BATCH = original

    assert await _count(db_session) == 0, "the backlog should drain on the first tick"


async def test_sweep_once_survives_a_failure(db_session, monkeypatch):
    """A transient DB blip must not kill the loop.

    Nothing downstream depends on any single pass succeeding, so the
    right behaviour is to log and retry on the next tick.
    """
    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def broken_factory():
        raise RuntimeError("pool exhausted")
        yield  # pragma: no cover

    shutdown = asyncio.Event()
    task = asyncio.create_task(run_sweeper(broken_factory, shutdown, interval=0.01))
    await asyncio.sleep(0.05)
    assert not task.done(), "the sweeper must survive a failing session factory"
    shutdown.set()
    await asyncio.wait_for(task, timeout=2.0)


def test_sweep_once_is_exported():
    """The single-pass entry point stays callable for an ops one-shot."""
    assert callable(sweep_once)
