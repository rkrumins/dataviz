"""Product-event retention sweep.

``product_events`` began life as a store of rare, deliberate signals — a docs
vote, a finished tour, an onboarding step — so it shipped with no retention and
that was the right call: a handful of rows a day never needs pruning.

Instrumenting the product changed the arithmetic. There is now a row per view
open, per lineage trace, and per graph search, so the table grows with USAGE —
precisely the number the Analytics dashboard exists to make go up. A table that
grows with success and never shrinks is a slow leak with a business incentive
behind it.

Nothing reads past the analytics windows (365 days is the hard ceiling on both
the ``days`` query param and a custom range), so rows older than the retention
horizon cost storage and vacuum pressure and buy nothing back.

Runs on the CONTROLPLANE/DEV role only — the same ``runs_scheduler`` gate the
outbox relay and the refresh-token sweeper use. Three web replicas each
sweeping the same table would only contend for the same rows.
"""
from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.repositories.product_event_repo import purge_older_than

logger = logging.getLogger(__name__)

#: Rows per transaction, matching the refresh-token sweeper's discipline.
_BATCH = 5_000

#: How much history to keep. Comfortably beyond the 365-day analytics ceiling,
#: so a year-long chart is always backed by real rows and never silently
#: truncated by this sweep. Operators who want longer retention for their own
#: analysis can raise it.
_DEFAULT_RETENTION_DAYS = 400

#: Daily. The backlog this clears accrues slowly, and the sweep is pure
#: housekeeping — nothing downstream depends on any single pass.
_DEFAULT_INTERVAL_SECONDS = 86_400.0


def retention_days() -> int:
    """Retention horizon, overridable for deployments with longer needs."""
    raw = os.getenv("PRODUCT_EVENT_RETENTION_DAYS")
    if not raw:
        return _DEFAULT_RETENTION_DAYS
    try:
        parsed = int(raw)
    except ValueError:
        logger.warning(
            "PRODUCT_EVENT_RETENTION_DAYS=%r is not an integer; using %d",
            raw, _DEFAULT_RETENTION_DAYS,
        )
        return _DEFAULT_RETENTION_DAYS
    # Never let a misconfiguration delete the window the dashboard reads. A
    # value below the analytics ceiling would make a 365-day chart lie.
    if parsed < 365:
        logger.warning(
            "PRODUCT_EVENT_RETENTION_DAYS=%d is below the 365-day analytics "
            "ceiling; clamping to 365 so year-long charts stay honest.", parsed,
        )
        return 365
    return parsed


async def sweep_once(
    session: AsyncSession, *, days: int | None = None,
    now: datetime | None = None,
) -> int:
    """Delete one batch of expired rows. Returns how many went."""
    return await purge_older_than(
        session, days=days if days is not None else retention_days(),
        batch=_BATCH, now=now,
    )


async def run_sweeper(
    session_factory,
    shutdown: asyncio.Event,
    *,
    interval: float = _DEFAULT_INTERVAL_SECONDS,
) -> None:
    """Background loop: sweep until ``shutdown`` is set.

    Drains greedily within a tick — an install upgrading into this may have a
    long backlog, and one 5000-row batch a day would take years to clear it.
    """
    days = retention_days()
    logger.info(
        "Product-event sweeper started (retention=%dd, interval=%.0fs)",
        days, interval,
    )
    while not shutdown.is_set():
        try:
            while not shutdown.is_set():
                async with session_factory() as session:
                    deleted = await sweep_once(session, days=days)
                if deleted:
                    logger.info(
                        "Product-event sweep reclaimed %d expired row(s)", deleted,
                    )
                # A short batch means the backlog is gone; wait for the next
                # tick rather than spinning on an empty table.
                if deleted < _BATCH:
                    break
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — loop must survive blips
            logger.warning(
                "Product-event sweep failed: %s", exc, exc_info=True,
            )

        try:
            await asyncio.wait_for(shutdown.wait(), timeout=interval)
        except asyncio.TimeoutError:
            pass

    logger.info("Product-event sweeper stopped")
