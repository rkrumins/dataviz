"""How long who-did-what is kept: the activity retention sweep.

``auth_audit_log`` — the activity ledger — and the outbox it is copied from
both grow with every change anyone makes, and neither had a horizon. This
gives them one: ``ACTIVITY_RETENTION_DAYS``, two years unless set, so every
range the explorer and Analytics offer (a year at most) can still be compared
with the full period before it.

Two tables, one horizon, both measured in whole UTC days:

- The ledger: events that happened before the horizon go, oldest first, along
  the ``occurred_at`` index every read already uses.
- The outbox: rows the relay has already copied, written before the horizon.
  Never a row it has not copied, and never the password events sign-in reads
  back to decide whether an account chose its own password
  (``auth/bootstrap``). Those are facts about an account, not activity:
  dropping them would make long-standing administrators change a password
  they chose years ago.

``0`` keeps everything. Less than a year counts as a year: the explorer's
longest range must never be quietly cut short by this sweep.

Runs on the aggregation control plane (and a dev monolith) beside the other
retention sweeps. Each batch is one short transaction behind an advisory lock
(``db/advisory``), so replicas take turns, and a first run clearing years of
history paces itself rather than monopolising the database.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from datetime import datetime, timedelta, timezone
from typing import Awaitable, Callable, Optional

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.advisory import claim_this_pass
from backend.app.db.models import AuthAuditLogORM, OutboxEventORM

logger = logging.getLogger(__name__)

#: Two years: a year-long range and the year before it, compared in full.
DEFAULT_RETENTION_DAYS = 730

#: The explorer's and Analytics' longest range. A shorter setting would cut
#: a year-long view short without saying so.
FLOOR_DAYS = 365

#: Rows per transaction, the discipline of the other retention sweeps.
BATCH = 5_000

#: Daily. History crosses the horizon a day at a time.
_DEFAULT_INTERVAL_SECONDS = 86_400.0

#: Outbox events sign-in reads back as facts about an account
#: (``auth.bootstrap._OWN_PASSWORD_EVENTS``; a test keeps the two in step —
#: this loop may not import the auth package, which needs the signing secret).
KEPT_IN_OUTBOX = frozenset({
    "user.password_changed",
    "user.password_reset_completed",
    "user.password_reset_by_admin",
})


def retention_days() -> Optional[int]:
    """Days of activity kept; ``None`` when everything is kept."""
    raw = os.getenv("ACTIVITY_RETENTION_DAYS")
    if not raw:
        return DEFAULT_RETENTION_DAYS
    try:
        days = int(raw)
    except ValueError:
        logger.warning(
            "ACTIVITY_RETENTION_DAYS=%r is not a whole number of days; keeping %d",
            raw, DEFAULT_RETENTION_DAYS,
        )
        return DEFAULT_RETENTION_DAYS
    if days == 0:
        return None
    if days < FLOOR_DAYS:
        logger.warning(
            "ACTIVITY_RETENTION_DAYS=%d is shorter than the explorer's longest "
            "range; keeping %d days so a year-long view stays whole.", days, FLOOR_DAYS,
        )
        return FLOOR_DAYS
    return days


def _start_of_day(days_ago: int, now: Optional[datetime] = None) -> datetime:
    then = (now or datetime.now(timezone.utc)).astimezone(timezone.utc) - timedelta(days=days_ago)
    return then.replace(hour=0, minute=0, second=0, microsecond=0)


def horizon(now: Optional[datetime] = None) -> Optional[datetime]:
    """The start of the oldest UTC day kept, or ``None`` when all of it is."""
    days = retention_days()
    return None if days is None else _start_of_day(days, now)


def _as_text(at: datetime) -> str:
    """The ledger's own timestamp form (``outbox_relay.canonical_timestamp``),
    so a text comparison orders exactly as the instants do."""
    return at.astimezone(timezone.utc).isoformat(timespec="microseconds")


async def sweep_ledger_once(session: AsyncSession, *, before: datetime, batch: int = BATCH) -> int:
    """Delete one batch of ledger events that happened before ``before``."""
    doomed = (await session.execute(
        select(AuthAuditLogORM.id)
        .where(AuthAuditLogORM.occurred_at < _as_text(before))
        .order_by(AuthAuditLogORM.occurred_at)
        .limit(batch)
    )).scalars().all()
    if doomed:
        await session.execute(delete(AuthAuditLogORM).where(AuthAuditLogORM.id.in_(doomed)))
    return len(doomed)


async def sweep_outbox_once(session: AsyncSession, *, before: datetime, batch: int = BATCH) -> int:
    """Delete one batch of relayed outbox rows written before ``before``."""
    doomed = (await session.execute(
        select(OutboxEventORM.id)
        .where(
            OutboxEventORM.processed.is_(True),
            OutboxEventORM.created_at < _as_text(before),
            OutboxEventORM.event_type.not_in(KEPT_IN_OUTBOX),
        )
        .order_by(OutboxEventORM.created_at)
        .limit(batch)
    )).scalars().all()
    if doomed:
        await session.execute(delete(OutboxEventORM).where(OutboxEventORM.id.in_(doomed)))
    return len(doomed)


Sweep = Callable[..., Awaitable[int]]


async def drain(
    session_factory, shutdown: asyncio.Event, *, lock: str, sweep: Sweep, before: datetime,
) -> int:
    """Run ``sweep`` a batch at a time until a batch comes back short.

    Each batch rests half as long as it took before the next, so years of
    backlog on a first run share the database with everything else.
    """
    total = 0
    while not shutdown.is_set():
        started = time.monotonic()
        async with session_factory() as session:
            if not await claim_this_pass(session, lock):
                break  # another process is sweeping this table
            deleted = await sweep(session, before=before)
        total += deleted
        if deleted < BATCH:
            break
        await asyncio.sleep(min(5.0, 0.5 * (time.monotonic() - started)))
    return total


async def run_sweeper(
    session_factory,
    shutdown: asyncio.Event,
    *,
    interval: float = _DEFAULT_INTERVAL_SECONDS,
) -> None:
    """Background loop: keep both tables inside the horizon until ``shutdown``."""
    days = retention_days()
    if days is None:
        logger.info("Activity retention: keeping every event (ACTIVITY_RETENTION_DAYS=0)")
        return
    logger.info("Activity retention sweep started (retention=%dd, interval=%.0fs)", days, interval)
    while not shutdown.is_set():
        try:
            before = _start_of_day(days)
            for table, lock, sweep in (
                ("ledger", "activity:ledger-retention", sweep_ledger_once),
                ("outbox", "activity:outbox-retention", sweep_outbox_once),
            ):
                deleted = await drain(
                    session_factory, shutdown, lock=lock, sweep=sweep, before=before,
                )
                if deleted:
                    logger.info(
                        "Activity retention removed %d %s row(s) from before %s",
                        deleted, table, before.date().isoformat(),
                    )
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — the loop must outlive a bad pass
            logger.warning("Activity retention sweep failed: %s", exc, exc_info=True)

        try:
            await asyncio.wait_for(shutdown.wait(), timeout=interval)
        except asyncio.TimeoutError:
            pass

    logger.info("Activity retention sweep stopped")
