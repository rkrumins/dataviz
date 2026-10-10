"""One replica at a time, for housekeeping every replica runs.

A loop on the aggregation control plane runs on every replica of it, so work
that must not happen twice at once needs a claim. ``try_xact_lock`` takes a
Postgres transaction-scoped advisory lock: held until the session commits or
rolls back, released by the database even if the process dies mid-batch, and
never waited for — a replica that does not get it skips this pass.

The same contract as the reconcile sweep's lock
(``aggregation/reconcile_sweeper.py``): another backend (SQLite, in tests) is a
single process, so it always proceeds; on Postgres an error fails CLOSED,
because skipping one pass is strictly cheaper than two replicas doing it.
"""
from __future__ import annotations

import asyncio
import logging

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)


async def try_xact_lock(session: AsyncSession, key: str) -> bool:
    """Whether this transaction holds ``key``'s lock; never blocks."""
    dialect = getattr(getattr(session, "bind", None), "dialect", None)
    if getattr(dialect, "name", None) != "postgresql":
        return True
    try:
        got = (
            await session.execute(
                text("SELECT pg_try_advisory_xact_lock(hashtextextended(:key, 0))"),
                {"key": key},
            )
        ).scalar()
        return got not in (False, 0, None)
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 — fail closed, see the module docstring
        logger.warning("could not claim the %r lock (%s); skipping this pass", key, exc)
        return False
