"""The people indexer — backfills People analytics from history, then keeps it current.

Each step is one bounded unit of ``people_index_repo`` work — one UTC day of all three activity
stores folded into the daily rollup, or the grants made since the last pass — taken under an
advisory lock in its own short transaction. So a first run on a platform with a year of history
works through it a day at a time, newest first, without holding a long transaction on the
tables people are writing to; and a restart resumes where it stopped, because a day is either
computed or it is not.

Runs where ``runs_scheduler()`` is true — the control plane, or a dev monolith — like the
analytics warmer and the retention sweeps. It is the only writer of the index. Nothing on a
request path depends on it having run: the pages read live data for every window, and say
"indexing history" over the few figures that come from here while it catches up.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from datetime import datetime
from typing import Optional

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.advisory import claim_this_pass
from backend.app.db.repositories import people_index_repo as repo

logger = logging.getLogger(__name__)

_LOCK = "people:index"
_DEFAULT_INTERVAL_SECONDS = 60.0

#: Work per tick before yielding until the next one. Catching up runs at this duty cycle,
#: which keeps a backfill from becoming the busiest thing on the database.
_DEFAULT_BUDGET_SECONDS = 20.0


def interval_seconds() -> float:
    raw = os.getenv("PEOPLE_INDEX_INTERVAL_SECONDS")
    try:
        value = float(raw) if raw else _DEFAULT_INTERVAL_SECONDS
    except ValueError:
        logger.warning("PEOPLE_INDEX_INTERVAL_SECONDS=%r is not a number; using %.0f",
                       raw, _DEFAULT_INTERVAL_SECONDS)
        value = _DEFAULT_INTERVAL_SECONDS
    # Floor it: a one-second loop would make this a load generator.
    return max(value, 15.0)


async def step(session: AsyncSession, *, now: Optional[datetime] = None) -> int:
    """One unit of the most urgent work — joins, today, yesterday, a dirty day, or one day of
    history — in its own transaction. Returns how much was done; 0 means caught up."""
    return await repo.step(session, now=now)


async def catch_up(session: AsyncSession, *, now: Optional[datetime] = None,
                   max_steps: int = 100_000) -> int:
    """Run steps on one session until there is nothing left. For tests, and for a one-off
    backfill from a shell; the loop below is what production runs."""
    total = 0
    for _ in range(max_steps):
        done = await step(session, now=now)
        if not done:
            break
        total += done
    return total


async def run_indexer(
    session_factory,
    shutdown: asyncio.Event,
    *,
    interval: Optional[float] = None,
    budget: float = _DEFAULT_BUDGET_SECONDS,
) -> None:
    """Background loop: index until ``shutdown`` is set."""
    interval = interval if interval is not None else interval_seconds()
    logger.info("People indexer started (interval=%.0fs, budget=%.0fs)", interval, budget)
    while not shutdown.is_set():
        deadline = time.monotonic() + budget
        try:
            while not shutdown.is_set() and time.monotonic() < deadline:
                async with session_factory() as session:
                    if not await claim_this_pass(session, _LOCK):
                        break  # another process holds the index this pass
                    done = await step(session)
                if not done:
                    break
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — the loop must survive a bad pass
            logger.warning("People indexer pass failed: %s", exc, exc_info=True)
        try:
            await asyncio.wait_for(shutdown.wait(), timeout=interval)
        except asyncio.TimeoutError:
            pass
    logger.info("People indexer stopped")
