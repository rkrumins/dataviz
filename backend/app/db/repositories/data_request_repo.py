"""Repository: data_requests — asking for data to be connected to a workspace.

A request is open while ``pending`` (nobody has taken it) or ``in_progress``
(someone is connecting it). It closes as ``connected``, ``declined`` or
``withdrawn``.

No business logic here — ``backend.app.services.data_requests`` owns validation,
authorisation, outbox events and notifications. This module wraps the table's
reads and writes.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import DataRequestORM


OPEN_STATUSES = ("pending", "in_progress")
VALID_STATUSES = {*OPEN_STATUSES, "connected", "declined", "withdrawn"}
#: Where a request may go from where it is.
_MOVES = {
    "pending": {"in_progress", "connected", "declined", "withdrawn"},
    "in_progress": {"connected", "declined"},
}
_CLOSED = {"connected", "declined", "withdrawn"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def ids_of(raw: Optional[str]) -> list[str]:
    """A stored JSON list of ids; empty for anything unreadable."""
    try:
        value = json.loads(raw or "[]")
    except (TypeError, ValueError):
        return []
    return [str(v) for v in value] if isinstance(value, list) else []


async def create(
    session: AsyncSession,
    *,
    workspace_id: str,
    requested_by: str,
    title: str,
    system: str,
    details: Optional[str],
    purpose: Optional[str],
    urgency: str,
    contact_ids: list[str],
) -> DataRequestORM:
    now = _now()
    row = DataRequestORM(
        workspace_id=workspace_id, requested_by=requested_by, title=title, system=system,
        details=details, purpose=purpose, urgency=urgency, contact_ids=json.dumps(contact_ids),
        status="pending", created_at=now, updated_at=now,
    )
    session.add(row)
    await session.flush()
    return row


async def get(
    session: AsyncSession, request_id: str, *, for_update: bool = False,
) -> Optional[DataRequestORM]:
    """One request. ``for_update`` locks the row, so two answers to it decide one
    after the other."""
    stmt = select(DataRequestORM).where(DataRequestORM.id == request_id)
    if for_update:
        stmt = stmt.with_for_update()
    return (await session.execute(stmt)).scalar_one_or_none()


async def first_connected_as(session: AsyncSession, data_source_id: str) -> Optional[DataRequestORM]:
    """The request connected first as this data source, or None (``idx_data_requests_source``)."""
    return (await session.execute(
        select(DataRequestORM).where(
            DataRequestORM.data_source_id == data_source_id, DataRequestORM.status == "connected",
        ).order_by(DataRequestORM.resolved_at, DataRequestORM.id).limit(1)
    )).scalar_one_or_none()


def _status_clause(status: Optional[str]):
    """``None`` or ``'all'`` → every request; ``'open'`` → the two open states;
    otherwise one status."""
    if status in (None, "all"):
        return None
    if status == "open":
        return DataRequestORM.status.in_(OPEN_STATUSES)
    if status not in VALID_STATUSES:
        raise ValueError(
            f"status must be 'open', 'all' or one of {sorted(VALID_STATUSES)}, got {status!r}"
        )
    return DataRequestORM.status == status


async def _list(session: AsyncSession, *where, status: Optional[str], limit: int) -> list[DataRequestORM]:
    stmt = select(DataRequestORM).where(*where)
    clause = _status_clause(status)
    if clause is not None:
        stmt = stmt.where(clause)
    stmt = stmt.order_by(DataRequestORM.created_at.desc()).limit(limit)
    return list((await session.execute(stmt)).scalars().all())


async def list_for_workspace(
    session: AsyncSession, workspace_id: str, *, status: Optional[str] = "all", limit: int = 200,
) -> list[DataRequestORM]:
    """A workspace's requests, newest first."""
    return await _list(session, DataRequestORM.workspace_id == workspace_id, status=status, limit=limit)


async def list_for_requester(session: AsyncSession, user_id: str, *, limit: int = 200) -> list[DataRequestORM]:
    """The person's own requests, in every workspace, newest first."""
    return await _list(session, DataRequestORM.requested_by == user_id, status="all", limit=limit)


async def list_by_status(
    session: AsyncSession, *, status: Optional[str] = "open", limit: int = 200,
) -> list[DataRequestORM]:
    """Every request in ``status`` (see :func:`_status_clause`), newest first."""
    return await _list(session, status=status, limit=limit)


def can_move(current: str, new_status: str) -> bool:
    return new_status in _MOVES.get(current, set())


async def transition(
    session: AsyncSession,
    row: DataRequestORM,
    new_status: str,
    *,
    actor_id: str,
    note: Optional[str] = None,
    data_source_id: Optional[str] = None,
) -> DataRequestORM:
    """Move ``row`` to ``new_status``. Raises ``ValueError`` when it can't go there
    from where it is (already connected, say) — the caller turns that into a 409.

    Taking it on assigns the actor; closing it records who and when (and ``note``),
    and connecting it the data source it became."""
    if not can_move(row.status, new_status):
        raise ValueError(f"Cannot move request {row.id!r} to {new_status}: it is {row.status}")
    now = _now()
    row.status = new_status
    row.updated_at = now
    if new_status == "in_progress":
        row.assignee_id = actor_id
    if new_status in _CLOSED:
        row.resolved_at = now
        row.resolved_by = actor_id
        row.resolution_note = note
    if data_source_id is not None:
        row.data_source_id = data_source_id
    await session.flush()
    return row
