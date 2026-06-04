"""Audit-log read endpoint (Phase 7).

Mounted at ``/api/v1/admin/audit``. Backed by the ``outbox_events``
table — every RBAC mutation already writes there (see Phase 5/6/7
endpoints). This module just gives operators + compliance officers a
filterable, paginated read surface so they don't have to query SQL
or wait for SIEM ingestion.

Gate: ``system:admin`` only. Audit history can contain sensitive
provenance (who promoted whom) so we don't expose it to org_admin.
"""
from __future__ import annotations

import json
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.dependencies import requires
from backend.app.db.engine import get_db_session
from backend.app.db.models import OutboxEventORM
from backend.auth_service.interface import User
from backend.common.models.audit import (
    AuditEventResponse,
    AuditListResponse,
)


logger = logging.getLogger(__name__)
router = APIRouter()


# Event-type prefixes operators care about. ``event_type`` is a free
# string in the outbox; the UI filter chips below map to these. We
# expose the prefix list to the frontend via ``GET /audit/event-types``
# so the chip set stays in sync with whatever the backend emits.
_AUDIT_PREFIXES = (
    "rbac.workspace.",   # member_bound / member_revoked / member_expiry_updated
    "rbac.role.",        # created / updated / deleted / cascade_revoked
    "rbac.permission.",  # updated
    "user.",             # access_denied / role_changed / approved / etc.
)

_MAX_LIMIT = 500
_DEFAULT_LIMIT = 50


def _row_to_response(row: OutboxEventORM) -> AuditEventResponse:
    """Decode the JSON payload + surface payload-derived fields the
    UI keys off (actor_id, target_user_id, target_role).

    Bad JSON is treated as ``{}`` rather than 500'd — an event with a
    malformed payload is operationally rare and shouldn't break the
    audit lens for everything else.
    """
    try:
        payload = json.loads(row.payload) if row.payload else {}
    except (TypeError, ValueError):
        payload = {}
    if not isinstance(payload, dict):
        payload = {}

    return AuditEventResponse(
        event_id=row.id,
        event_type=row.event_type,
        event_version=row.event_version,
        aggregate_type=row.aggregate_type,
        aggregate_id=row.aggregate_id,
        created_at=row.created_at,
        actor_id=payload.get("actor_id") or payload.get("changed_by")
            or payload.get("granted_by"),
        target_user_id=(
            payload.get("user_id")
            or (payload.get("subject_id") if payload.get("subject_type") == "user" else None)
        ),
        target_role=payload.get("role")
            or payload.get("new_role")
            or payload.get("role_name")
            or payload.get("name"),
        workspace_id=payload.get("workspace_id"),
        payload=payload,
    )


@router.get(
    "",
    response_model=AuditListResponse,
    response_model_by_alias=True,
)
async def list_audit_events(
    event_type: Optional[str] = Query(
        None, alias="eventType",
        description=(
            "Exact event type or a wildcard prefix (e.g. "
            "``rbac.role.*``). Suffix ``*`` triggers prefix match."
        ),
    ),
    actor_id: Optional[str] = Query(None, alias="actorId"),
    target_user_id: Optional[str] = Query(None, alias="targetUserId"),
    target_role: Optional[str] = Query(None, alias="targetRole"),
    workspace_id: Optional[str] = Query(None, alias="workspaceId"),
    from_ts: Optional[str] = Query(
        None, alias="fromTs",
        description="ISO timestamp inclusive lower bound on created_at.",
    ),
    to_ts: Optional[str] = Query(
        None, alias="toTs",
        description="ISO timestamp exclusive upper bound on created_at.",
    ),
    cursor: Optional[str] = Query(
        None,
        description=(
            "Opaque cursor returned by the previous page's "
            "``next_cursor``. Pass to fetch the next page."
        ),
    ),
    limit: int = Query(_DEFAULT_LIMIT, ge=1, le=_MAX_LIMIT),
    _admin: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
) -> AuditListResponse:
    """Filter + paginate the outbox-events audit trail.

    The handler keeps the SQL simple: indexable predicates on
    ``event_type`` / ``created_at`` / ``aggregate_*`` filter at the
    DB layer; the per-event payload predicates (actor_id / target_*)
    filter in Python after JSON-decoding. This is fine because the
    pre-filtered set is small (a tight ``event_type`` + ``created_at``
    window usually drops the count by orders of magnitude before the
    Python pass runs).

    Pagination uses ``(created_at, id)`` as the cursor — both columns
    are part of the ``idx_outbox_processed_created`` index so the
    ``created_at`` predicate is cheap, and ``id`` breaks ties when
    multiple events share a millisecond (uuid suffix makes them
    deterministic).
    """
    stmt = select(OutboxEventORM)

    # ── DB-level predicates ──────────────────────────────────────
    if event_type:
        if event_type.endswith("*"):
            prefix = event_type[:-1]
            stmt = stmt.where(OutboxEventORM.event_type.like(f"{prefix}%"))
        else:
            stmt = stmt.where(OutboxEventORM.event_type == event_type)
    else:
        # Default: only RBAC + user lifecycle events, never the
        # everything-else outbox noise (graph cache invalidation,
        # aggregation jobs, etc.).
        stmt = stmt.where(
            or_(*[
                OutboxEventORM.event_type.like(f"{p}%")
                for p in _AUDIT_PREFIXES
            ])
        )
    if from_ts:
        stmt = stmt.where(OutboxEventORM.created_at >= from_ts)
    if to_ts:
        stmt = stmt.where(OutboxEventORM.created_at < to_ts)
    if workspace_id:
        # Most rbac.workspace.* events carry workspace_id in the
        # ``aggregate_id`` slot too. We OR both so a future change to
        # the aggregate_id contract doesn't silently break the
        # filter.
        stmt = stmt.where(
            or_(
                OutboxEventORM.aggregate_id == workspace_id,
                OutboxEventORM.payload.like(f'%"workspace_id": "{workspace_id}"%'),
            )
        )

    # ── Cursor ───────────────────────────────────────────────────
    if cursor:
        try:
            cursor_ts, cursor_id = cursor.split("|", 1)
        except ValueError:
            raise HTTPException(
                status_code=400, detail="Malformed cursor",
            )
        # Newer first: continue with strictly older entries OR same
        # ts with smaller id (lexicographic).
        stmt = stmt.where(
            or_(
                OutboxEventORM.created_at < cursor_ts,
                and_(
                    OutboxEventORM.created_at == cursor_ts,
                    OutboxEventORM.id < cursor_id,
                ),
            )
        )

    stmt = stmt.order_by(
        OutboxEventORM.created_at.desc(),
        OutboxEventORM.id.desc(),
    ).limit(limit + 1)  # +1 to detect "has next page"

    rows = list((await session.execute(stmt)).scalars().all())
    has_more = len(rows) > limit
    rows = rows[:limit]

    # ── Python-level predicates (payload introspection) ───────────
    out: list[AuditEventResponse] = []
    for row in rows:
        ev = _row_to_response(row)
        if actor_id and ev.actor_id != actor_id:
            continue
        if target_user_id and ev.target_user_id != target_user_id:
            continue
        if target_role and ev.target_role != target_role:
            continue
        out.append(ev)

    next_cursor = None
    if has_more and rows:
        last = rows[-1]
        next_cursor = f"{last.created_at}|{last.id}"

    return AuditListResponse(events=out, next_cursor=next_cursor)


@router.get(
    "/event-types",
    response_model=list[str],
)
async def list_event_types(
    _admin: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
) -> list[str]:
    """Distinct event types that have ever been emitted into the
    RBAC / user lifecycle namespace. Powers the FE filter dropdown
    so the chip list stays in sync with whatever the backend has
    actually produced (not whatever the FE thinks it knows about).
    """
    stmt = (
        select(OutboxEventORM.event_type)
        .distinct()
        .where(
            or_(*[
                OutboxEventORM.event_type.like(f"{p}%")
                for p in _AUDIT_PREFIXES
            ])
        )
        .order_by(OutboxEventORM.event_type)
    )
    rows = (await session.execute(stmt)).scalars().all()
    return list(rows)
