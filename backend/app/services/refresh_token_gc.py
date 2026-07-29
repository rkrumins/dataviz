"""Refresh-token revocation sweep.

``revoked_refresh_jti`` records one row per rotation — the consumed
``jti``, so presenting it again is detectable — plus a sentinel per
revoked family. ``expires_at`` has been written since the table existed
and is documented as the marker for reclaiming a row, but nothing ever
read it. The table therefore grew by one row per rotation for the life
of the deployment and shed nothing: at a 15-minute access TTL that is
roughly ``users x tabs x 32`` rows a day.

It never showed up as slowness, because every read against it is a
primary-key lookup. It is storage and vacuum pressure, which is the kind
of problem that stays invisible right up until it isn't.

This runs on the CONTROLPLANE/DEV role only — the same ``runs_scheduler``
gate the outbox relay uses. Three web replicas each sweeping the same
table would just contend for the same rows.
"""
from __future__ import annotations

import asyncio
import logging

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.repositories.refresh_token_repo import purge_expired

logger = logging.getLogger(__name__)

# Rows per transaction. Bounded so one sweep never holds a long
# transaction on the jobs pool, matching the outbox relay's discipline.
_BATCH = 5_000

# Expired rows are inert — a token past ``expires_at`` is refused on its
# own signature — so reclaiming them is housekeeping, not a control.
# Hourly clears far more than a day accrues while staying invisible.
_DEFAULT_INTERVAL_SECONDS = 3600.0


async def sweep_once(session: AsyncSession) -> int:
    """Delete one batch of expired rows. Returns how many went."""
    return await purge_expired(session, batch=_BATCH)


async def run_sweeper(
    session_factory,
    shutdown: asyncio.Event,
    *,
    interval: float = _DEFAULT_INTERVAL_SECONDS,
) -> None:
    """Background loop: sweep until ``shutdown`` is set.

    Each iteration opens its own session (the factory's scope commits on
    success / rolls back on error). A failure is logged and retried on
    the next tick — a transient DB blip must not kill the sweeper, and
    nothing downstream depends on any single pass succeeding.

    Drains greedily on the first tick after boot: a deployment upgrading
    into this has a backlog measured in months, and waiting an hour
    between 5000-row batches would take weeks to clear it.
    """
    logger.info("Refresh-token sweeper started (interval=%.0fs)", interval)
    while not shutdown.is_set():
        try:
            while not shutdown.is_set():
                async with session_factory() as session:
                    deleted = await sweep_once(session)
                if deleted:
                    logger.info(
                        "Refresh-token sweep reclaimed %d expired row(s)", deleted,
                    )
                # A short batch means the backlog is gone; wait for the
                # next tick rather than spinning on an empty table.
                if deleted < _BATCH:
                    break
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — loop must survive blips
            logger.warning(
                "Refresh-token sweep failed: %s", exc, exc_info=True,
            )

        try:
            await asyncio.wait_for(shutdown.wait(), timeout=interval)
        except asyncio.TimeoutError:
            pass

    logger.info("Refresh-token sweeper stopped")
