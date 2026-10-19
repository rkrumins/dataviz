"""Repository: access_requests — asking to join a workspace.

A request is open while ``pending`` (nobody has answered) or ``awaiting_idp``
(an approver pointed the person to the identity-provider group that grants
it). It closes as ``approved``, ``denied`` or ``withdrawn``. Approval grants
the access in the same transaction — the endpoint does that write, so the
two-step change is atomic.

The repo deliberately keeps no business logic — endpoints own
authorisation, outbox emission, and granting access. This module
just wraps the table reads/writes.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Iterable, Optional

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import AccessRequestORM


VALID_TARGET_TYPES = {"workspace"}
OPEN_STATUSES = ("pending", "awaiting_idp")
VALID_STATUSES = {*OPEN_STATUSES, "approved", "denied", "withdrawn"}
#: Where each answer may come from: approving or denying works on any open
#: request; pointing to the identity provider only while nobody has answered.
_TRANSITIONS = {
    "awaiting_idp": {"pending"},
    "approved": set(OPEN_STATUSES),
    "denied": set(OPEN_STATUSES),
    "withdrawn": set(OPEN_STATUSES),
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _status_clause(status: Optional[str]):
    """``None`` or ``'all'`` → every request; ``'open'`` → the two open
    states; otherwise one status."""
    if status in (None, "all"):
        return None
    if status == "open":
        return AccessRequestORM.status.in_(OPEN_STATUSES)
    if status not in VALID_STATUSES:
        raise ValueError(
            f"status must be 'open', 'all' or one of {sorted(VALID_STATUSES)}, got {status!r}"
        )
    return AccessRequestORM.status == status


async def create(
    session: AsyncSession,
    *,
    requester_id: str,
    target_type: str,
    target_id: str,
    requested_role: str,
    justification: Optional[str] = None,
) -> tuple[AccessRequestORM, bool]:
    """Open a request, or return the person's open one for this target.

    Returns ``(row, created)``. One open request per person per target is a
    unique index, so two submits racing each other end with one row: the
    loser's insert fails inside a savepoint and it returns the winner's.

    Caller is responsible for confirming the target exists and the role is
    one that may be asked for there.
    """
    if target_type not in VALID_TARGET_TYPES:
        raise ValueError(
            f"target_type must be one of {VALID_TARGET_TYPES}, got {target_type!r}"
        )
    existing = await find_open_for(
        session, requester_id=requester_id, target_type=target_type, target_id=target_id,
    )
    if existing is not None:
        return existing, False
    row = AccessRequestORM(
        requester_id=requester_id,
        target_type=target_type,
        target_id=target_id,
        requested_role=requested_role,
        justification=(justification.strip() if justification else None) or None,
        status="pending",
    )
    try:
        async with session.begin_nested():
            session.add(row)
            await session.flush()
    except IntegrityError:
        winner = await find_open_for(
            session, requester_id=requester_id, target_type=target_type, target_id=target_id,
        )
        if winner is None:
            raise
        return winner, False
    return row, True


async def get(
    session: AsyncSession, request_id: str, *, for_update: bool = False,
) -> Optional[AccessRequestORM]:
    """One request. ``for_update`` locks the row, so two approvers answering
    at once decide one after the other."""
    stmt = select(AccessRequestORM).where(AccessRequestORM.id == request_id)
    if for_update:
        stmt = stmt.with_for_update()
    result = await session.execute(stmt)
    return result.scalar_one_or_none()


async def find_open_for(
    session: AsyncSession,
    *,
    requester_id: str,
    target_type: str,
    target_id: str,
) -> Optional[AccessRequestORM]:
    """The person's open request for this target, if they have one."""
    result = await session.execute(
        select(AccessRequestORM).where(
            AccessRequestORM.requester_id == requester_id,
            AccessRequestORM.target_type == target_type,
            AccessRequestORM.target_id == target_id,
            AccessRequestORM.status.in_(OPEN_STATUSES),
        )
    )
    return result.scalars().first()


async def list_for_target(
    session: AsyncSession,
    *,
    target_type: str,
    target_id: str,
    status: Optional[str] = None,
) -> list[AccessRequestORM]:
    """Every request against one workspace, newest first."""
    stmt = select(AccessRequestORM).where(
        AccessRequestORM.target_type == target_type,
        AccessRequestORM.target_id == target_id,
    )
    clause = _status_clause(status)
    if clause is not None:
        stmt = stmt.where(clause)
    stmt = stmt.order_by(AccessRequestORM.created_at.desc())
    result = await session.execute(stmt)
    return list(result.scalars().all())


async def list_for_targets(
    session: AsyncSession,
    *,
    target_ids: Optional[Iterable[str]],
    status: Optional[str] = None,
    limit: int = 200,
) -> list[AccessRequestORM]:
    """Requests against any of ``target_ids`` (``None`` = every workspace),
    newest first — one list for someone who answers several workspaces."""
    stmt = select(AccessRequestORM).where(AccessRequestORM.target_type == "workspace")
    if target_ids is not None:
        ids = list(target_ids)
        if not ids:
            return []
        stmt = stmt.where(AccessRequestORM.target_id.in_(ids))
    clause = _status_clause(status)
    if clause is not None:
        stmt = stmt.where(clause)
    stmt = stmt.order_by(AccessRequestORM.created_at.desc()).limit(limit)
    result = await session.execute(stmt)
    return list(result.scalars().all())


async def list_for_requester(
    session: AsyncSession,
    *,
    requester_id: str,
    status: Optional[str] = None,
) -> list[AccessRequestORM]:
    """Requester's own queue — backs the My Access page."""
    stmt = select(AccessRequestORM).where(AccessRequestORM.requester_id == requester_id)
    clause = _status_clause(status)
    if clause is not None:
        stmt = stmt.where(clause)
    stmt = stmt.order_by(AccessRequestORM.created_at.desc())
    result = await session.execute(stmt)
    return list(result.scalars().all())


async def resolve(
    session: AsyncSession,
    *,
    request_id: str,
    new_status: str,
    resolver_id: str,
    note: Optional[str] = None,
    granted_role: Optional[str] = None,
    granted_group_id: Optional[str] = None,
    idp_group: Optional[str] = None,
    access_expires_at: Optional[str] = None,
    idp_exception: bool = False,
) -> Optional[AccessRequestORM]:
    """Answer an open request: approve, deny, point to the identity
    provider (``awaiting_idp``), or withdraw it.

    Returns the updated row, or ``None`` when the request id is unknown.
    Raises ``ValueError`` when the status is invalid or the request can't
    move there from where it is (already answered, say) — the caller should
    handle that case explicitly.
    """
    allowed_from = _TRANSITIONS.get(new_status)
    if allowed_from is None:
        raise ValueError(f"new_status must be one of {sorted(_TRANSITIONS)}")
    row = await get(session, request_id)
    if row is None:
        return None
    if row.status not in allowed_from:
        raise ValueError(
            f"Cannot move request {request_id!r} to {new_status}: it is {row.status}"
        )
    row.status = new_status
    row.resolved_at = _now()
    row.resolved_by = resolver_id
    row.resolution_note = (note.strip() if note else None) or None
    if new_status == "awaiting_idp":
        row.idp_group = idp_group
    elif new_status == "approved":
        row.granted_role = granted_role
        row.granted_group_id = granted_group_id
        row.access_expires_at = access_expires_at
        row.idp_exception = idp_exception
        if idp_group is not None:
            row.idp_group = idp_group
    await session.flush()
    return row
