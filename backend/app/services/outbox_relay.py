"""Outbox relay — drains ``outbox_events`` into the append-only
``auth_audit_log``.

The transactional outbox records every meaningful domain event in the
same transaction as the state change (see
``db/repositories/outbox_event_repo.py``). Until now nothing consumed
it, so events piled up with ``processed = false`` and there was no
durable audit trail.

This relay is that consumer. It runs as a background loop in the
aggregation control plane (``services/aggregation/controlplane.py``) and in
a dev monolith (``main.py``), copies each unprocessed event verbatim into
``auth_audit_log``, and flips ``processed = true`` in the **same
transaction** so the record and the flag commit or roll back together.
Each pass claims an advisory lock first, so two control planes never
relay at once.

Idempotency: ``auth_audit_log.source_event_id`` is UNIQUE and we skip
events that already have an audit row, so a crash between the audit
insert and the processed-flag commit cannot double-record on retry.
"""
from __future__ import annotations

import asyncio
import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.advisory import claim_this_pass
from backend.app.db.models import AuthAuditLogORM, OutboxEventORM

logger = logging.getLogger(__name__)

# How many events to drain per transaction. Keeps each relay
# transaction short so it never holds a JOBS-pool connection long.
_BATCH = 200
# Idle poll interval. Auth events are low-volume; a few seconds of
# audit lag is acceptable and keeps DB load negligible.
_DEFAULT_INTERVAL_SECONDS = 5.0


async def drain_once(session: AsyncSession) -> int:
    """Drain one batch. Returns the number of events recorded.

    Caller's session scope commits on success — this function only
    stages the audit rows and the processed flips.
    """
    rows = (
        await session.execute(
            select(OutboxEventORM)
            .where(OutboxEventORM.processed.is_(False))
            .order_by(OutboxEventORM.created_at)
            .limit(_BATCH)
        )
    ).scalars().all()

    if not rows:
        return 0

    recorded = 0
    for ev in rows:
        already = (
            await session.execute(
                select(AuthAuditLogORM.id).where(
                    AuthAuditLogORM.source_event_id == ev.id
                )
            )
        ).first()
        if already is None:
            session.add(
                AuthAuditLogORM(
                    source_event_id=ev.id,
                    event_type=ev.event_type,
                    aggregate_type=ev.aggregate_type,
                    aggregate_id=ev.aggregate_id,
                    payload=ev.payload,
                    occurred_at=ev.created_at,
                )
            )
            recorded += 1
        ev.processed = True

    await session.flush()
    return recorded


async def run_relay(
    session_factory,
    shutdown: asyncio.Event,
    *,
    interval: float = _DEFAULT_INTERVAL_SECONDS,
) -> None:
    """Background loop: drain until ``shutdown`` is set.

    Each batch opens its own session (the factory's scope commits on
    success / rolls back on error). A drain failure is logged and retried
    next tick — a transient DB blip must not kill the relay.

    Drains greedily within a tick: an install whose relay never ran has a
    backlog of every event since it was installed, and one batch per tick
    would take hours to clear it.
    """
    logger.info("Outbox relay started (interval=%.0fs)", interval)
    while not shutdown.is_set():
        try:
            while not shutdown.is_set():
                async with session_factory() as session:
                    if not await claim_this_pass(session, "outbox:relay"):
                        break  # another process is relaying
                    count = await drain_once(session)
                if count:
                    logger.info("Outbox relay recorded %d event(s)", count)
                # A short batch means the backlog is gone.
                if count < _BATCH:
                    break
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — loop must survive blips
            logger.warning("Outbox relay drain failed: %s", exc, exc_info=True)

        try:
            await asyncio.wait_for(shutdown.wait(), timeout=interval)
        except asyncio.TimeoutError:
            pass

    logger.info("Outbox relay stopped")
