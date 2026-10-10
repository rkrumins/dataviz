"""Capture one person-initiated operation in the activity ledger.

The ledger is projected from the outbox by the relay, so capturing an
operation means writing ONE outbox event in the transaction that performed
it: the event exists exactly when the change does. Nothing here reads the
database — the names of people, workspaces and sources are resolved when the
ledger is read, in batches — so capture costs one INSERT, flushed with the
caller's own commit.

Events written here use a canonical envelope, marked ``event_version = 2``, so
the projection can read who, where and what without a per-type extractor:

    actor_id · workspace_id · data_source_id · target_type · target_id
    · target_label · stated_reason · correlation_id · details

``target_label`` is the name AT THE TIME, deliberately denormalised: a source
deleted next month must still read as the source it was.
"""
from __future__ import annotations

import logging
from typing import Any, Optional

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.common.activity_context import (
    CORRELATION_KEY,
    STATED_REASON_KEY,
    Provenance,
)
from backend.app.db.repositories import outbox_event_repo

logger = logging.getLogger(__name__)

#: ``outbox_events.event_version`` of the canonical envelope.
ENVELOPE_VERSION = 2


def build_payload(
    *,
    provenance: Optional[Provenance],
    workspace_id: Optional[str] = None,
    data_source_id: Optional[str] = None,
    target_type: Optional[str] = None,
    target_id: Optional[str] = None,
    target_label: Optional[str] = None,
    details: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    """The canonical envelope, without keys that have nothing to say."""
    payload: dict[str, Any] = {
        "actor_id": provenance.actor_id if provenance else None,
        "workspace_id": workspace_id,
        "data_source_id": data_source_id,
        "target_type": target_type,
        "target_id": target_id,
        "target_label": target_label,
        STATED_REASON_KEY: provenance.stated_reason if provenance else None,
        CORRELATION_KEY: provenance.correlation_id if provenance else None,
        "details": details or None,
    }
    return {k: v for k, v in payload.items() if v is not None}


async def record_activity(
    session: AsyncSession,
    *,
    event_type: str,
    provenance: Optional[Provenance],
    workspace_id: Optional[str] = None,
    data_source_id: Optional[str] = None,
    target_type: Optional[str] = None,
    target_id: Optional[str] = None,
    target_label: Optional[str] = None,
    details: Optional[dict[str, Any]] = None,
    best_effort: bool = False,
) -> None:
    """Add the event to ``session``; the caller's commit makes it durable.

    ``provenance.record`` False records nothing — the caller is attributing
    work to a person whose action is captured elsewhere, once.

    By default the write is atomic with the change: if the operation commits,
    so does its record, and a failed record fails the operation, which is the
    trade an audit trail should make. ``best_effort=True`` is for operations
    whose change already happened in ANOTHER store (a versioned-graph write,
    say) — there, failing the request would not undo anything, so the event
    is written under a savepoint and a failure is logged instead of raised.
    """
    if provenance is not None and not provenance.record:
        return

    kwargs = dict(
        event_type=event_type,
        aggregate_id=target_id or data_source_id or workspace_id or "platform",
        aggregate_type=target_type,
        payload=build_payload(
            provenance=provenance,
            workspace_id=workspace_id,
            data_source_id=data_source_id,
            target_type=target_type,
            target_id=target_id,
            target_label=target_label,
            details=details,
        ),
        event_version=ENVELOPE_VERSION,
    )
    if not best_effort:
        await outbox_event_repo.emit(session, **kwargs)
        return

    try:
        async with session.begin_nested():
            await outbox_event_repo.emit(session, **kwargs)
            # Inside the savepoint, so a failing INSERT rolls back only itself.
            await session.flush()
    except Exception:  # noqa: BLE001 — the change it records already happened
        logger.warning(
            "activity: could not record %s for %s", event_type,
            kwargs["aggregate_id"], exc_info=True,
        )
