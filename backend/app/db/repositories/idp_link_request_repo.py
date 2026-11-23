"""Repository: idp_link_requests — asking a platform administrator to link a group
to an identity-provider group.

A request is ``pending`` until it is ``linked``, ``declined`` or ``cancelled``. One
pending per group, held by a partial unique index.

No business logic here — ``backend.app.services.idp_links`` owns authorisation, the
link itself, outbox events and notifications. This module wraps the table's reads
and writes.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Iterable, Optional

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import IdpLinkRequestORM

STATUSES = ("pending", "linked", "declined", "cancelled")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def get(session: AsyncSession, request_id: str, *, for_update: bool = False) -> Optional[IdpLinkRequestORM]:
    stmt = select(IdpLinkRequestORM).where(IdpLinkRequestORM.id == request_id)
    if for_update:
        stmt = stmt.with_for_update()
    return (await session.execute(stmt)).scalar_one_or_none()


async def pending_for_groups(session: AsyncSession, group_ids: Iterable[str]) -> dict[str, IdpLinkRequestORM]:
    """``{group_id: its pending request}`` for the groups that have one."""
    ids = list(dict.fromkeys(group_ids))
    if not ids:
        return {}
    rows = (await session.execute(
        select(IdpLinkRequestORM).where(
            IdpLinkRequestORM.group_id.in_(ids), IdpLinkRequestORM.status == "pending",
        )
    )).scalars().all()
    return {r.group_id: r for r in rows}


async def create(
    session: AsyncSession,
    *,
    group_id: str,
    workspace_id: str,
    idp_group: str,
    provider_id: Optional[str],
    requested_by: str,
    source: str,
    source_id: Optional[str] = None,
) -> tuple[IdpLinkRequestORM, bool]:
    """Open a request, or return the group's pending one: ``(row, created)``. Two
    racing each other end with one row — the loser's insert fails inside a savepoint
    and it returns the winner's."""
    existing = (await pending_for_groups(session, [group_id])).get(group_id)
    if existing is not None:
        return existing, False
    row = IdpLinkRequestORM(
        group_id=group_id, workspace_id=workspace_id, idp_group=idp_group, provider_id=provider_id,
        requested_by=requested_by, requested_at=_now(), status="pending", source=source,
        source_id=source_id,
    )
    try:
        async with session.begin_nested():
            session.add(row)
            await session.flush()
    except IntegrityError:
        winner = (await pending_for_groups(session, [group_id])).get(group_id)
        if winner is None:
            raise
        return winner, False
    return row, True


async def list_by_status(session: AsyncSession, *, status: Optional[str] = "pending",
                         limit: int = 200) -> list[IdpLinkRequestORM]:
    """``'pending'`` (the default), ``'all'``/``None``, or one status; newest first."""
    stmt = select(IdpLinkRequestORM)
    if status not in (None, "all"):
        if status not in STATUSES:
            raise ValueError(f"status must be 'all' or one of {list(STATUSES)}, got {status!r}")
        stmt = stmt.where(IdpLinkRequestORM.status == status)
    stmt = stmt.order_by(IdpLinkRequestORM.requested_at.desc()).limit(limit)
    return list((await session.execute(stmt)).scalars().all())


async def resolve(
    session: AsyncSession,
    row: IdpLinkRequestORM,
    status: str,
    *,
    actor_id: Optional[str],
    note: Optional[str] = None,
    mapping_id: Optional[str] = None,
) -> IdpLinkRequestORM:
    """Close a pending request as ``linked``, ``declined`` or ``cancelled``. Raises
    ``ValueError`` when it is no longer pending — the caller turns that into a 409."""
    if row.status != "pending":
        raise ValueError(f"Link request {row.id!r} is {row.status}, not pending")
    if status not in STATUSES or status == "pending":
        raise ValueError(f"Cannot resolve a link request as {status!r}")
    row.status = status
    row.resolved_by = actor_id
    row.resolved_at = _now()
    row.resolution_note = note
    row.mapping_id = mapping_id
    await session.flush()
    return row
