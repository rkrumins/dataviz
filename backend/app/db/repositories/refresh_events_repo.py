"""refresh_events audit trail — the OPS Freshness Cockpit's per-source
history ("when did this last refresh and what happened").

``emit_refresh_event`` is a best-effort recorder: it opens its OWN short
session (never reuses the caller's mid-transaction session) so a failure
here — a broken session factory, a constraint violation, a dead pool —
can never block or fail the operation it records. Any exception is
logged at WARNING and swallowed; the caller gets ``None`` back instead of
a propagated error.

``list_refresh_events`` / ``latest_refresh_event_map`` are plain reads
against the caller's own session, mirroring the ``view_activity_repo``
reader shape.
"""
from __future__ import annotations

import json
import logging
import uuid
from typing import Any, Callable, Optional

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from backend.app.db.engine import get_async_session
from backend.app.db.models import RefreshEventORM

logger = logging.getLogger(__name__)


async def emit_refresh_event(
    session_factory_or_none: Optional[Callable[[], Any]],
    *,
    workspace_id: Optional[str],
    data_source_id: str,
    provider_id: Optional[str] = None,
    origin: str,
    actor: str = "internal",
    scope: str,
    gate: str,
    actions: Optional[dict] = None,
    outcome: str,
    detail: Optional[str] = None,
    reason: Optional[str] = None,
    evidence: Optional[dict] = None,
    job_id: Optional[str] = None,
    run_id: Optional[str] = None,
) -> Optional[str]:
    """Record one refresh/audit event. Returns the new event id, or
    ``None`` on any failure (broken factory, DB error, etc.) — never
    raises.

    ``reason`` and ``evidence`` are the reconciliation sweep's "why": a typed
    detector code plus the counts behind it. They are deliberately separate
    from ``actions``, which is contractually "what the signal DID" and is
    surfaced as a ``List[str]`` on the wire — overloading it would break both
    readers.

    ``job_id`` names the aggregation job this event produced, when it produced
    one. It is what lets a reader cross from "why we rebuilt" to "what the
    rebuild did" and back; without it the two audit trails never meet.

    ``run_id`` names the reconciliation sweep that produced this event, when
    one did. The overnight ledger joins on it."""
    factory = session_factory_or_none or get_async_session
    try:
        async with factory() as session:
            row = RefreshEventORM(
                id=uuid.uuid4().hex,
                workspace_id=workspace_id,
                data_source_id=data_source_id,
                provider_id=provider_id,
                origin=origin,
                actor=actor,
                scope=scope,
                gate=gate,
                actions=json.dumps(actions) if actions else None,
                outcome=outcome,
                detail=detail,
                reason=reason,
                evidence=json.dumps(evidence) if evidence else None,
                job_id=job_id,
                run_id=run_id,
            )
            session.add(row)
            await session.commit()
            return row.id
    except Exception as exc:  # noqa: BLE001 — audit writes must never raise
        logger.warning(
            "emit_refresh_event failed (ds=%s origin=%s scope=%s): %s",
            data_source_id, origin, scope, exc,
        )
        return None


async def list_refresh_events(
    session: AsyncSession, data_source_id: str, limit: int = 20,
) -> list[RefreshEventORM]:
    """Most recent events for a data source, newest first."""
    rows = (await session.execute(
        select(RefreshEventORM)
        .where(RefreshEventORM.data_source_id == data_source_id)
        .order_by(RefreshEventORM.ts.desc())
        .limit(limit)
    )).scalars().all()
    return list(rows)


async def latest_refresh_event_map(
    session: AsyncSession, data_source_ids: list[str],
) -> dict[str, RefreshEventORM]:
    """The newest event per data source, in one query (window function)."""
    if not data_source_ids:
        return {}
    ranked = (
        select(
            RefreshEventORM,
            func.row_number().over(
                partition_by=RefreshEventORM.data_source_id,
                order_by=RefreshEventORM.ts.desc(),
            ).label("rn"),
        )
        .where(RefreshEventORM.data_source_id.in_(data_source_ids))
        .subquery()
    )
    latest = aliased(RefreshEventORM, ranked)
    rows = (await session.execute(
        select(latest).where(ranked.c.rn == 1)
    )).scalars().all()
    return {row.data_source_id: row for row in rows}
