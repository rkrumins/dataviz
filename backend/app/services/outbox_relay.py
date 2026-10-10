"""Outbox relay — drains ``outbox_events`` into the activity ledger.

The transactional outbox records every meaningful domain event in the
same transaction as the state change (see
``db/repositories/outbox_event_repo.py``). This relay is its consumer: it
copies each unprocessed event verbatim into ``auth_audit_log`` — the
activity ledger — together with the event's projection (category,
audience, actor, target, workspace, stated reason; see
``services.activity.catalogue.project``), and flips ``processed = true``
in the **same transaction**, so the record and the flag commit or roll
back together.

It runs on the aggregation control plane (and a dev-role monolith — see
``runtime/role.py``), and is built to run on several replicas at once and
to outlast anything a single event can do:

* **Single-flight without coordination.** A batch is claimed with
  ``FOR UPDATE SKIP LOCKED``: two replicas never take the same event, and
  neither waits for the other.
* **Idempotent.** ``auth_audit_log.source_event_id`` is UNIQUE and a batch
  skips events that already have a row, so a crash between the insert and
  the processed-flag commit cannot double-record on retry.
* **Newest first.** An install upgrading into this has its whole outbox
  history pending. Draining newest-first means the activity people come
  looking for — today's — is there in seconds while the long tail imports
  behind it.
* **Set-based.** One SELECT, one existence check, one multi-row INSERT and
  one UPDATE per batch, not a round trip per event.
* **A bad event costs its own projection, never the relay.** ``project``
  never raises and cleans every value it returns; a batch the database
  refuses anyway is bisected down to the event it refuses, which is
  recorded with what its type alone implies. One malformed payload
  — from a failed sign-in, say, which anyone can cause — must not stop the
  audit trail behind it.

When there is no backlog the relay re-projects ledger rows whose
``projection_version`` trails the catalogue's, a batch at a time. That is
how a better classification reaches history: no data migration, and no
pause in recording.
"""
from __future__ import annotations

import asyncio
import logging
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import select, update
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import AuthAuditLogORM, OutboxEventORM
from backend.app.services.activity import catalogue

logger = logging.getLogger(__name__)

#: Events per transaction. Large enough that a backlog of millions drains in
#: minutes, small enough that a batch never holds a JOBS-pool connection, or
#: its row locks, for long.
_BATCH = 500
#: Ledger rows re-projected per transaction once the backlog is empty.
_REPROJECT_BATCH = 1_000
#: Idle poll interval. A few seconds of lag is invisible to a person reading
#: an activity log, and an idle poll is one indexed query.
_DEFAULT_INTERVAL_SECONDS = 5.0
#: How often a long drain reports its progress.
_PROGRESS_EVERY_SECONDS = 10.0
#: Between full batches, pause for this fraction of the time the batch took.
#: A backlog — an install's whole history, on its first start — then gets at
#: most two thirds of one database backend, and backs off by itself when the
#: database slows, which is exactly when a backfill should not press it. New
#: events are unaffected: newest first, they lead every batch.
_BACKLOG_PAUSE_RATIO = 0.5


def canonical_timestamp(value: Optional[str]) -> Optional[str]:
    """``value`` as UTC ISO-8601 with microseconds, so text order is time order.

    The ledger's timeline is a TEXT column, ordered and range-filtered as
    text. ``isoformat()`` drops the fraction when it is zero, and a writer
    may use ``Z`` or no offset at all — each of which sorts out of place
    beside its neighbours. A value that does not parse is kept as it came:
    a misplaced row beats a lost one.
    """
    if not value:
        return value
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return value
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat(timespec="microseconds")


def _ledger_id() -> str:
    # 80 bits: the ledger keeps every event the platform emits, and at tens
    # of millions of rows a 48-bit id is a birthday collision waiting.
    return f"aud_{uuid.uuid4().hex[:20]}"


def _record(event: Any, recorded_at: str) -> dict[str, Any]:
    """The ledger row for one outbox event: the record, and its projection."""
    return {
        "id": _ledger_id(),
        "source_event_id": event.id,
        "event_type": event.event_type,
        "event_version": event.event_version,
        "aggregate_type": event.aggregate_type,
        "aggregate_id": event.aggregate_id,
        "payload": event.payload,
        "occurred_at": canonical_timestamp(event.created_at),
        "recorded_at": recorded_at,
        **catalogue.project(
            event_type=event.event_type,
            payload=event.payload,
            event_version=event.event_version,
            aggregate_type=event.aggregate_type,
            aggregate_id=event.aggregate_id,
        ),
    }


#: A Core INSERT, not the ORM's bulk insert: that one leaves out a row's
#: ``None`` values and batches only consecutive rows whose remaining keys
#: match. Events of different types project to different ``None``s, so a
#: mixed batch degraded to an INSERT per row. Every record here carries every
#: key, so this is one statement for the batch.
_INSERT = AuthAuditLogORM.__table__.insert()


async def _insert(session: AsyncSession, records: list[dict[str, Any]]) -> None:
    """Write ``records`` in one statement, isolating any the database refuses.

    A refused batch is halved and each half retried, so one bad event among
    500 is found in about twenty statements — not 500 savepoints, which would
    overflow Postgres's per-transaction subtransaction cache and slow every
    other session while this one is open. The event it isolates is recorded
    with the projection its type alone implies; if even that is refused, the
    error propagates and the whole batch retries on the next tick.
    """
    try:
        async with session.begin_nested():
            await session.execute(_INSERT, records)
        return
    except DBAPIError as exc:
        refused = exc
    if len(records) > 1:
        half = len(records) // 2
        await _insert(session, records[:half])
        await _insert(session, records[half:])
        return
    record = records[0]
    logger.error(
        "Outbox relay: the database refused event %s (%s) as projected (%s); "
        "recording it with its type's projection",
        record["source_event_id"], record["event_type"], refused,
    )
    async with session.begin_nested():
        await session.execute(_INSERT, [{
            **record, **catalogue.fallback_projection(record["event_type"]),
        }])


async def _drain_batch(session: AsyncSession) -> tuple[int, int]:
    """Record one batch: ``(recorded, claimed)``.

    ``claimed`` short of a full batch means the backlog is empty.
    """
    events = (
        await session.execute(
            select(
                OutboxEventORM.id,
                OutboxEventORM.event_type,
                OutboxEventORM.event_version,
                OutboxEventORM.aggregate_type,
                OutboxEventORM.aggregate_id,
                OutboxEventORM.payload,
                OutboxEventORM.created_at,
            )
            .where(OutboxEventORM.processed.is_(False))
            .order_by(OutboxEventORM.created_at.desc())
            .limit(_BATCH)
            # Another replica's batch is skipped, not waited for. (SQLite,
            # single-writer, renders no locking clause.)
            .with_for_update(skip_locked=True)
        )
    ).all()
    if not events:
        return 0, 0

    ids = [event.id for event in events]
    already = set(
        (
            await session.execute(
                select(AuthAuditLogORM.source_event_id)
                .where(AuthAuditLogORM.source_event_id.in_(ids))
            )
        ).scalars()
    )
    recorded_at = datetime.now(timezone.utc).isoformat(timespec="microseconds")
    records = [_record(e, recorded_at) for e in events if e.id not in already]
    if records:
        await _insert(session, records)
    await session.execute(
        update(OutboxEventORM)
        .where(OutboxEventORM.id.in_(ids))
        .values(processed=True)
    )
    return len(records), len(events)


async def drain_once(session: AsyncSession) -> int:
    """Drain one batch. Returns the number of events recorded.

    Caller's session scope commits on success — this function only
    stages the ledger rows and the processed flips.
    """
    recorded, _claimed = await _drain_batch(session)
    return recorded


async def reproject_once(session: AsyncSession) -> int:
    """Re-project one batch of rows recorded under an older catalogue.

    Only the projection columns are written; the record is never touched.
    A replica running older code finds nothing to do here, because it only
    looks for rows behind ITS version — so a rolling deploy can never
    project history backwards.
    """
    rows = (
        await session.execute(
            select(
                AuthAuditLogORM.id,
                AuthAuditLogORM.event_type,
                AuthAuditLogORM.event_version,
                AuthAuditLogORM.aggregate_type,
                AuthAuditLogORM.aggregate_id,
                AuthAuditLogORM.payload,
            )
            .where(AuthAuditLogORM.projection_version < catalogue.PROJECTION_VERSION)
            .limit(_REPROJECT_BATCH)
            .with_for_update(skip_locked=True)
        )
    ).all()
    if not rows:
        return 0
    await session.execute(
        update(AuthAuditLogORM),
        [
            {
                "id": row.id,
                **catalogue.project(
                    event_type=row.event_type,
                    payload=row.payload,
                    event_version=row.event_version,
                    aggregate_type=row.aggregate_type,
                    aggregate_id=row.aggregate_id,
                ),
            }
            for row in rows
        ],
    )
    return len(rows)


async def run_relay(
    session_factory,
    shutdown: asyncio.Event,
    *,
    interval: float = _DEFAULT_INTERVAL_SECONDS,
) -> None:
    """Background loop: drain until ``shutdown`` is set.

    While batches come back full it goes on to the next after a short,
    self-pacing pause (``_BACKLOG_PAUSE_RATIO``), so a backlog drains at the
    database's pace rather than a batch per tick, and it spends idle ticks
    re-projecting history. Each batch is its own transaction (the factory's
    scope commits on success / rolls back on error). A failure is logged and
    retried after a tick — a transient DB blip must not kill the relay, and a
    persistent one must not spin it.
    """
    logger.info("Outbox relay started (interval=%.0fs, batch=%d)", interval, _BATCH)
    recorded_since_report = 0
    last_report = time.monotonic()
    while not shutdown.is_set():
        busy = False
        started = time.monotonic()
        try:
            async with session_factory() as session:
                recorded, claimed = await _drain_batch(session)
            recorded_since_report += recorded
            busy = claimed >= _BATCH
            if not busy:
                async with session_factory() as session:
                    busy = await reproject_once(session) >= _REPROJECT_BATCH
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — loop must survive blips
            logger.warning("Outbox relay drain failed: %s", exc, exc_info=True)

        now = time.monotonic()
        if recorded_since_report and (
            not busy or now - last_report >= _PROGRESS_EVERY_SECONDS
        ):
            logger.info(
                "Outbox relay recorded %d event(s)%s", recorded_since_report,
                "; still draining the backlog" if busy else "",
            )
            recorded_since_report, last_report = 0, now

        if busy:
            await asyncio.sleep((now - started) * _BACKLOG_PAUSE_RATIO)
            continue
        try:
            await asyncio.wait_for(shutdown.wait(), timeout=interval)
        except asyncio.TimeoutError:
            pass

    logger.info("Outbox relay stopped")
