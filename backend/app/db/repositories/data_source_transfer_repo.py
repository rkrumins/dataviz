"""Repository: data_source_transfers — a data source moving to another workspace.

A direct move is recorded ``completed``; a request is ``pending`` until the
destination's admins accept it (``completed``) or decline it, the proposer
cancels it or it expires. A completed move may later be ``undone``.

The repo deliberately keeps no business logic — the transfer service owns
authorisation, the move itself, events and notifications. This module just
wraps the table reads/writes.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Iterable, Optional

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import DataSourceTransferORM

#: Rows that record a move that happened (and possibly was undone since).
_HAPPENED = ("completed", "undone")
#: The most rows one list returns: a page, not the table.
LIST_LIMIT = 200


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _status_clause(status: str):
    if status == "open":
        return DataSourceTransferORM.status == "pending"
    if status == "all":
        return None
    raise ValueError(f"status must be 'open' or 'all', got {status!r}")


async def get(
    session: AsyncSession, transfer_id: str, *, for_update: bool = False,
) -> Optional[DataSourceTransferORM]:
    stmt = select(DataSourceTransferORM).where(DataSourceTransferORM.id == transfer_id)
    if for_update:
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
    return (await session.execute(stmt)).scalar_one_or_none()


async def pending_for_source(
    session: AsyncSession, data_source_id: str,
) -> Optional[DataSourceTransferORM]:
    return (await session.execute(
        select(DataSourceTransferORM).where(
            DataSourceTransferORM.data_source_id == data_source_id,
            DataSourceTransferORM.status == "pending",
        )
    )).scalar_one_or_none()


async def latest_move_for_source(
    session: AsyncSession, data_source_id: str,
) -> Optional[DataSourceTransferORM]:
    """The source's most recent move that happened, undone or not."""
    return (await session.execute(
        select(DataSourceTransferORM)
        .where(
            DataSourceTransferORM.data_source_id == data_source_id,
            DataSourceTransferORM.status.in_(_HAPPENED),
        )
        .order_by(DataSourceTransferORM.completed_at.desc())
        .limit(1)
    )).scalar_one_or_none()


async def list_for_source(
    session: AsyncSession, data_source_id: str, *, limit: int = 50,
) -> list[DataSourceTransferORM]:
    """The source's history, newest first."""
    return list((await session.execute(
        select(DataSourceTransferORM)
        .where(DataSourceTransferORM.data_source_id == data_source_id)
        .order_by(DataSourceTransferORM.created_at.desc())
        .limit(limit)
    )).scalars().all())


async def list_for_workspace(
    session: AsyncSession, workspace_id: str, *, status: str = "open",
    limit: Optional[int] = LIST_LIMIT,
) -> list[DataSourceTransferORM]:
    """Requests into or out of one workspace, newest first — at most ``limit`` (None: all)."""
    stmt = select(DataSourceTransferORM).where(
        (DataSourceTransferORM.to_workspace_id == workspace_id)
        | (DataSourceTransferORM.from_workspace_id == workspace_id),
        DataSourceTransferORM.kind == "request",
    )
    clause = _status_clause(status)
    if clause is not None:
        stmt = stmt.where(clause)
    stmt = stmt.order_by(DataSourceTransferORM.created_at.desc())
    if limit is not None:
        stmt = stmt.limit(limit)
    return list((await session.execute(stmt)).scalars().all())


async def list_incoming(
    session: AsyncSession, to_workspace_ids: Optional[Iterable[str]], *, status: str = "open",
) -> list[DataSourceTransferORM]:
    """Requests into the given workspaces (every workspace when None), newest first — at most
    :data:`LIST_LIMIT`."""
    stmt = select(DataSourceTransferORM).where(DataSourceTransferORM.kind == "request")
    if to_workspace_ids is not None:
        ids = list(to_workspace_ids)
        if not ids:
            return []
        stmt = stmt.where(DataSourceTransferORM.to_workspace_id.in_(ids))
    clause = _status_clause(status)
    if clause is not None:
        stmt = stmt.where(clause)
    return list((await session.execute(
        stmt.order_by(DataSourceTransferORM.created_at.desc()).limit(LIST_LIMIT)
    )).scalars().all())


async def expire_lapsed(session: AsyncSession) -> list[DataSourceTransferORM]:
    """Close every pending request whose window has passed, as of its expiry, and return them.

    A row another transaction holds — someone answering it right now — is skipped: that answer
    decides it, or the next call expires it. So each expiry happens, and is reported, once."""
    rows = list((await session.execute(
        select(DataSourceTransferORM)
        .where(
            DataSourceTransferORM.status == "pending",
            DataSourceTransferORM.expires_at <= _now(),
        )
        .with_for_update(skip_locked=True)
    )).scalars().all())
    for row in rows:
        row.status = "expired"
        row.resolved_at = row.expires_at
    if rows:
        await session.flush()
    return rows


async def create_pending(session: AsyncSession, **fields) -> tuple[DataSourceTransferORM, bool]:
    """Open a request, or return the one already waiting for this source.

    Returns ``(row, created)``. One open request per source is a unique
    index, so two proposals racing each other end with one row: the loser's
    insert fails inside a savepoint and it returns the winner's.
    """
    row = DataSourceTransferORM(kind="request", status="pending", **fields)
    try:
        async with session.begin_nested():
            session.add(row)
            await session.flush()
    except IntegrityError:
        winner = await pending_for_source(session, fields["data_source_id"])
        if winner is None:
            raise
        return winner, False
    return row, True


async def record_move(session: AsyncSession, **fields) -> DataSourceTransferORM:
    """Record a direct move, which is born completed."""
    row = DataSourceTransferORM(kind="move", status="completed", **fields)
    session.add(row)
    await session.flush()
    return row


async def resolve(
    session: AsyncSession, row: DataSourceTransferORM, *, status: str,
    resolver_id: Optional[str], note: Optional[str] = None,
) -> DataSourceTransferORM:
    """Close a pending request without moving anything."""
    if status not in ("declined", "cancelled", "expired"):
        raise ValueError(f"cannot resolve a request as {status!r}")
    row.status = status
    row.resolved_by = resolver_id
    row.resolved_at = _now()
    row.resolution_note = (note.strip() if note else None) or None
    await session.flush()
    return row


async def open_for_workspace(
    session: AsyncSession, workspace_id: str,
) -> list[DataSourceTransferORM]:
    """Pending requests into or out of a workspace — what deleting it closes. All of them."""
    return await list_for_workspace(session, workspace_id, status="open", limit=None)
