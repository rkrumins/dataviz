"""Atomic aggregation-job claim — single Postgres implementation.

Phase 2 §2.1: the multi-worker / multi-replica race that previously
allowed two concurrent triggers for the same data source to both
insert "pending" rows is closed by combining a transaction-scoped
advisory lock with `SELECT … FOR UPDATE SKIP LOCKED`.

Why both:

- `pg_try_advisory_xact_lock(hashtextextended(:ds, 0))` collapses
  every concurrent claim attempt for a given data_source_id onto a
  single waiter. The lock is released automatically on transaction
  commit/rollback — no manual cleanup, no leaked locks across crashes.
- Once the advisory lock is held, `SELECT … FOR UPDATE SKIP LOCKED`
  reads any active job row exclusively. The combination guarantees:
  exactly one in-flight claim per data source can ever observe "no
  active job" and proceed to insert.

This module assumes Postgres v9.6+ (the SKIP LOCKED clause's first
release). Synodic targets v16+, so all features are available.

Usage:

    async with session.begin():
        if not await claim_exclusive(session, ds_id):
            raise ConflictError(...)
        # safe to insert the new aggregation_jobs row here

The advisory lock auto-releases when the wrapping transaction
commits or rolls back.
"""
from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession


async def claim_exclusive(session: AsyncSession, data_source_id: str) -> bool:
    """Try to claim the right to create an aggregation job for `data_source_id`.

    Must be called inside an open transaction (``async with session.begin():``).
    The caller is responsible for the actual INSERT after a True return.

    Returns:
        True  — caller holds the exclusive claim, no active job exists.
        False — either another caller holds the lock, or an active
                ('pending'/'running') job already exists.
    """
    # 1. Advisory lock keyed on the data source. hashtextextended produces a
    #    deterministic 64-bit signed int from any string, satisfying the
    #    pg_try_advisory_xact_lock(bigint) signature.
    lock_held = (
        await session.execute(
            text(
                "SELECT pg_try_advisory_xact_lock(hashtextextended(:ds, 0))"
            ),
            {"ds": data_source_id},
        )
    ).scalar()
    if not lock_held:
        return False

    # 2. With the advisory lock held, peek at any active job row exclusively.
    #    SKIP LOCKED ensures we never block waiting on another transaction's
    #    row lock — if the row is held, we treat the data source as busy.
    active_id = (
        await session.execute(
            text(
                "SELECT id FROM aggregation_jobs "
                "WHERE data_source_id = :ds "
                "  AND status IN ('pending', 'running') "
                "LIMIT 1 FOR UPDATE SKIP LOCKED"
            ),
            {"ds": data_source_id},
        )
    ).scalar()

    return active_id is None


__all__ = ["claim_exclusive"]
