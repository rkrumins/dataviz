"""The refresh-token table has to shed rows, and shedding must be safe.

``refresh_tokens`` gains a row per rotation, so at a 15-minute access TTL
it grows by roughly ``users x tabs x 32`` rows a day. ``expires_at`` marks
when a row stops being able to matter, and the sweep reads it.

It never surfaces as slowness because every read against it is a
primary-key lookup, which is exactly the kind of growth that goes
unnoticed.

The sweep is also where allow-by-record pays off most plainly. Against
the old denylist these same deletes removed the only thing making a
consumed or revoked token invalid, so an early prune or a restore from a
stale backup could revive a dead credential. Now a deleted row can only
cause a refusal — see ``test_pruning_cannot_revive_a_dead_token``.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import RefreshTokenORM
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
        RefreshTokenORM(
            jti=jti,
            family_id="fam",
            user_id="usr_gc",
            mint_ms=0,
            created_at=_iso(-1),
            expires_at=_iso(expires_in_days),
        )
    )
    await session.flush()


async def _count(session: AsyncSession) -> int:
    return (
        await session.execute(select(func.count()).select_from(RefreshTokenORM))
    ).scalar_one()


async def test_expired_rows_are_reclaimed(db_session):
    await _add(db_session, "old-1", -1)
    await _add(db_session, "old-2", -30)
    assert await purge_expired(db_session) == 2
    assert await _count(db_session) == 0


async def test_live_rows_are_left_alone(db_session):
    """A token that could still be presented must keep its row.

    Under allow-by-record the row IS the token's licence, so deleting it
    early signs the holder out rather than — as under the denylist —
    making a genuine replay undetectable. Both are wrong; only one of
    them is quiet.
    """
    await _add(db_session, "live", 3)
    await _add(db_session, "expired", -3)
    assert await purge_expired(db_session) == 1
    remaining = (
        await db_session.execute(select(RefreshTokenORM.jti))
    ).scalars().all()
    assert remaining == ["live"]


async def test_revocation_no_longer_leaves_a_row_to_reclaim(db_session):
    """Family revocation marks tokens; it does not add a row of its own.

    It used to insert a ``family-revoked:<id>`` sentinel whose expiry had
    to be hand-sized to outlive every token it guarded — first stamped
    year 9999, making every revocation permanent, then sized to the
    refresh TTL plus a grace day. Marking the rows themselves removes the
    whole question: there is nothing left that has to outlive anything.
    """
    store = make_refresh_store(db_session)
    await store.record_mint(
        jti="doomed-1", family_id="doomed-family", user_id="usr_x",
        auth_time=None, mint_ms=0, expires_at_iso=_iso(7),
    )
    before = await _count(db_session)

    await store.revoke_family("doomed-family")
    await db_session.flush()

    assert await _count(db_session) == before, "revocation added a row"
    row = (
        await db_session.execute(
            select(RefreshTokenORM).where(
                RefreshTokenORM.family_id == "doomed-family"
            )
        )
    ).scalar_one()
    assert row.revoked_at is not None


async def test_pruning_cannot_revive_a_dead_token(db_session):
    """The property the inversion exists for.

    Sweeping the old denylist deleted the rows that made consumed and
    revoked tokens invalid, so a prune that ran early — a clock skew, a
    mis-set expiry, a restore from a backup taken before the revocation —
    handed a live credential back to whoever held it. Here the sweep
    deletes the licence, so the same mistake can only refuse.
    """
    store = make_refresh_store(db_session)
    await store.record_mint(
        jti="revoked-and-swept", family_id="fam-dead", user_id="usr_x",
        auth_time=None, mint_ms=0,
        # Already expired, so the sweep is entitled to take it.
        expires_at_iso=_iso(-1),
    )
    await store.revoke_family("fam-dead")
    await db_session.flush()

    assert await purge_expired(db_session) == 1

    # The row is gone; the token it described is not thereby valid.
    assert await store.get_record("revoked-and-swept") is None
    assert await store.consume(
        "revoked-and-swept", successor_jti="whatever",
    ) is False


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
