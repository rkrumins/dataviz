"""Repository: access_requests — Phase 4.3 self-service access asks.

A request lives on the row's lifecycle ``pending → approved | denied``.
Approval is the only path that creates a ``role_bindings`` row; that
write is performed by the endpoint inside the same transaction so the
two-step state change is atomic.

The repo deliberately keeps no business logic — endpoints own
authorisation, outbox emission, and binding creation. This module
just wraps the table reads/writes.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import AccessRequestORM


VALID_TARGET_TYPES = {"workspace"}
VALID_STATUSES = {"pending", "approved", "denied"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def create(
    session: AsyncSession,
    *,
    requester_id: str,
    target_type: str,
    target_id: str,
    requested_role: str,
    justification: Optional[str] = None,
) -> AccessRequestORM:
    """Insert a fresh ``pending`` request.

    Caller is responsible for: (a) confirming the target exists, (b)
    confirming the role exists in the ``roles`` table and is bindable
    in the target scope, and (c) preventing double-creates when the
    requester already has a pending request for the same target +
    role (use ``find_pending_for`` first).
    """
    if target_type not in VALID_TARGET_TYPES:
        raise ValueError(
            f"target_type must be one of {VALID_TARGET_TYPES}, got {target_type!r}"
        )
    row = AccessRequestORM(
        requester_id=requester_id,
        target_type=target_type,
        target_id=target_id,
        requested_role=requested_role,
        justification=(justification.strip() if justification else None) or None,
        status="pending",
    )
    session.add(row)
    await session.flush()
    return row


async def get(session: AsyncSession, request_id: str) -> Optional[AccessRequestORM]:
    result = await session.execute(
        select(AccessRequestORM).where(AccessRequestORM.id == request_id)
    )
    return result.scalar_one_or_none()


async def list_for_target(
    session: AsyncSession,
    *,
    target_type: str,
    target_id: str,
    status: Optional[str] = None,
) -> list[AccessRequestORM]:
    """Admin inbox query — every request against one workspace."""
    stmt = select(AccessRequestORM).where(
        AccessRequestORM.target_type == target_type,
        AccessRequestORM.target_id == target_id,
    )
    if status is not None:
        if status not in VALID_STATUSES:
            raise ValueError(f"status must be one of {VALID_STATUSES}, got {status!r}")
        stmt = stmt.where(AccessRequestORM.status == status)
    stmt = stmt.order_by(AccessRequestORM.created_at.desc())
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
    if status is not None:
        if status not in VALID_STATUSES:
            raise ValueError(f"status must be one of {VALID_STATUSES}, got {status!r}")
        stmt = stmt.where(AccessRequestORM.status == status)
    stmt = stmt.order_by(AccessRequestORM.created_at.desc())
    result = await session.execute(stmt)
    return list(result.scalars().all())


async def find_pending_for(
    session: AsyncSession,
    *,
    requester_id: str,
    target_type: str,
    target_id: str,
    requested_role: str,
) -> Optional[AccessRequestORM]:
    """Return an existing pending row for this exact (requester, target,
    role) tuple. Endpoints use this to short-circuit duplicate
    submissions and surface the existing request to the user.
    """
    result = await session.execute(
        select(AccessRequestORM).where(
            AccessRequestORM.requester_id == requester_id,
            AccessRequestORM.target_type == target_type,
            AccessRequestORM.target_id == target_id,
            AccessRequestORM.requested_role == requested_role,
            AccessRequestORM.status == "pending",
        )
    )
    return result.scalar_one_or_none()


async def resolve(
    session: AsyncSession,
    *,
    request_id: str,
    new_status: str,
    resolver_id: str,
    note: Optional[str] = None,
) -> Optional[AccessRequestORM]:
    """Transition ``pending`` → ``approved`` or ``denied``.

    Returns the resolved row, or ``None`` when the request id is
    unknown. Raises ``ValueError`` when the new status is invalid or
    when the row is already resolved (idempotent re-resolves are not
    allowed — the caller should handle that case explicitly).
    """
    if new_status not in {"approved", "denied"}:
        raise ValueError("new_status must be 'approved' or 'denied'")
    row = await get(session, request_id)
    if row is None:
        return None
    if row.status != "pending":
        raise ValueError(
            f"Cannot resolve request {request_id!r}: already {row.status}"
        )
    row.status = new_status
    row.resolved_at = _now()
    row.resolved_by = resolver_id
    row.resolution_note = (note.strip() if note else None) or None
    await session.flush()
    return row
