"""Repository: workspace_requests — asking for a workspace of your own.

A request is open while ``pending`` (nobody has answered) or ``changes_requested``
(an approver asked a question; the requester edits and resubmits). It closes as
``approved``, ``declined`` or ``withdrawn``.

No business logic here — ``backend.app.services.workspace_requests`` owns
validation, authorisation, creating the workspace, outbox events and
notifications. This module wraps the table's reads and writes.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import WorkspaceRequestORM


OPEN_STATUSES = ("pending", "changes_requested")
VALID_STATUSES = {*OPEN_STATUSES, "approved", "declined", "withdrawn"}
#: Where a request may go from where it is.
_MOVES = {
    "pending": {"changes_requested", "approved", "declined", "withdrawn"},
    "changes_requested": {"pending", "withdrawn", "declined"},
}
_CLOSED = {"approved", "declined", "withdrawn"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def ids_of(raw: Optional[str]) -> list[str]:
    """A stored JSON list of ids; empty for anything unreadable."""
    try:
        value = json.loads(raw or "[]")
    except (TypeError, ValueError):
        return []
    return [str(v) for v in value] if isinstance(value, list) else []


async def find_open_for(session: AsyncSession, requester_id: str) -> Optional[WorkspaceRequestORM]:
    """The person's open request, if they have one."""
    return (await session.execute(
        select(WorkspaceRequestORM).where(
            WorkspaceRequestORM.requester_id == requester_id,
            WorkspaceRequestORM.status.in_(OPEN_STATUSES),
        )
    )).scalars().first()


async def create(
    session: AsyncSession,
    *,
    requester_id: str,
    name: str,
    description: Optional[str],
    purpose: str,
    team_name: Optional[str],
    teammate_ids: list[str],
    playground_source_ids: list[str],
    data_needs: Optional[str],
    note: Optional[str],
) -> tuple[WorkspaceRequestORM, bool]:
    """Open a request, or return the person's open one.

    Returns ``(row, created)``. One open request per person is a unique index, so
    two submits racing each other end with one row: the loser's insert fails
    inside a savepoint and it returns the winner's.
    """
    existing = await find_open_for(session, requester_id)
    if existing is not None:
        return existing, False
    now = _now()
    row = WorkspaceRequestORM(
        requester_id=requester_id, name=name, description=description, purpose=purpose,
        team_name=team_name, teammate_ids=json.dumps(teammate_ids),
        playground_source_ids=json.dumps(playground_source_ids), data_needs=data_needs,
        note=note, status="pending", created_at=now, updated_at=now,
    )
    try:
        async with session.begin_nested():
            session.add(row)
            await session.flush()
    except IntegrityError:
        winner = await find_open_for(session, requester_id)
        if winner is None:
            raise
        return winner, False
    return row, True


async def get(
    session: AsyncSession, request_id: str, *, for_update: bool = False,
) -> Optional[WorkspaceRequestORM]:
    """One request. ``for_update`` locks the row, so two answers to it decide one
    after the other."""
    stmt = select(WorkspaceRequestORM).where(WorkspaceRequestORM.id == request_id)
    if for_update:
        stmt = stmt.with_for_update()
    return (await session.execute(stmt)).scalar_one_or_none()


def _status_clause(status: Optional[str]):
    """``None`` or ``'all'`` → every request; ``'open'`` → the two open states;
    otherwise one status."""
    if status in (None, "all"):
        return None
    if status == "open":
        return WorkspaceRequestORM.status.in_(OPEN_STATUSES)
    if status not in VALID_STATUSES:
        raise ValueError(
            f"status must be 'open', 'all' or one of {sorted(VALID_STATUSES)}, got {status!r}"
        )
    return WorkspaceRequestORM.status == status


async def list_for_requester(session: AsyncSession, requester_id: str) -> list[WorkspaceRequestORM]:
    """The person's own requests, newest first."""
    return list((await session.execute(
        select(WorkspaceRequestORM)
        .where(WorkspaceRequestORM.requester_id == requester_id)
        .order_by(WorkspaceRequestORM.created_at.desc())
    )).scalars().all())


async def list_by_status(
    session: AsyncSession, *, status: Optional[str] = "open", limit: int = 200,
) -> list[WorkspaceRequestORM]:
    """Every request in ``status`` (see :func:`_status_clause`), newest first."""
    stmt = select(WorkspaceRequestORM)
    clause = _status_clause(status)
    if clause is not None:
        stmt = stmt.where(clause)
    stmt = stmt.order_by(WorkspaceRequestORM.created_at.desc()).limit(limit)
    return list((await session.execute(stmt)).scalars().all())


def can_move(current: str, new_status: str) -> bool:
    return new_status in _MOVES.get(current, set())


async def transition(
    session: AsyncSession,
    row: WorkspaceRequestORM,
    new_status: str,
    *,
    actor_id: str,
    note: Optional[str] = None,
    question: Optional[str] = None,
    workspace_id: Optional[str] = None,
) -> WorkspaceRequestORM:
    """Move ``row`` to ``new_status``. Raises ``ValueError`` when it can't go there
    from where it is (already answered, say) — the caller turns that into a 409.

    Closing it records who and when (and ``note``); sending it back records the
    ``question``; resubmitting clears the question."""
    if not can_move(row.status, new_status):
        raise ValueError(f"Cannot move request {row.id!r} to {new_status}: it is {row.status}")
    now = _now()
    row.status = new_status
    row.updated_at = now
    if new_status == "changes_requested":
        row.question = question
    elif new_status == "pending":
        row.question = None
    if new_status in _CLOSED:
        row.resolved_at = now
        row.resolved_by = actor_id
        row.resolution_note = note
    if workspace_id is not None:
        row.workspace_id = workspace_id
    await session.flush()
    return row
