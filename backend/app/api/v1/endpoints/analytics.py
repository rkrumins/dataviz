"""Platform Analytics API — business insights over the whole application.

Three read-only endpoints backing the Analytics section: a platform-wide
summary, one aggregate row per workspace, and a per-workspace drill-down.
All aggregation lives in ``analytics_repo``; this module is the HTTP contract.

**Access.** Gated on ``system:audit:read`` OR ``system:org-admin`` (and
``system:admin``, which implies everything). Growth and per-user activity is
the same class of read as the audit log — but cross-workspace operators are a
legitimate second audience, and neither permission implies the other.

**Window.** ``days`` matches the ``/admin/telemetry/summary?days=`` convention
already in the codebase. Totals are all-time; everything else is measured over
the trailing window, with an equal-length preceding window supplying the deltas.

Responses are typed loosely (``dict[str, Any]``) on purpose. The payload is a
wide, evolving analytics document rather than a domain entity, and pinning ~60
nested fields into Pydantic models here would buy schema noise rather than
safety — the frontend's ``analyticsService`` types are the consumed contract.
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.dependencies import requires_any
from backend.app.db.engine import get_db_session
from backend.app.db.repositories import analytics_repo
from backend.auth_service.interface import User

logger = logging.getLogger(__name__)

router = APIRouter()

#: Either permission opens the section. ``system:admin`` implies both.
ANALYTICS_PERMISSIONS = ("system:audit:read", "system:org-admin")

_analytics_gate = requires_any(*ANALYTICS_PERMISSIONS)

#: The presets the range picker offers. Bounded so a caller can't ask for an
#: unbounded scan; 365 matches the telemetry endpoint's ceiling.
_DAYS = Query(30, ge=1, le=365, description="Trailing window, in days.")


@router.get("/summary")
async def analytics_summary(
    days: int = _DAYS,
    _user: User = Depends(_analytics_gate),
    session: AsyncSession = Depends(get_db_session),
) -> dict[str, Any]:
    """Platform-wide KPIs, time series, breakdowns, leaderboards, and funnel."""
    return await analytics_repo.platform_summary(session, days=days)


@router.get("/workspaces")
async def analytics_workspaces(
    days: int = _DAYS,
    _user: User = Depends(_analytics_gate),
    session: AsyncSession = Depends(get_db_session),
) -> list[dict[str, Any]]:
    """One aggregate row per live workspace — the Workspaces tab's table."""
    return await analytics_repo.workspace_rows(session, days=days)


@router.get("/workspaces/{workspace_id}")
async def analytics_workspace_detail(
    workspace_id: str = Path(..., description="Workspace id to drill into."),
    days: int = _DAYS,
    _user: User = Depends(_analytics_gate),
    session: AsyncSession = Depends(get_db_session),
) -> dict[str, Any]:
    """Full insights for one workspace, in the same shape as the summary."""
    detail = await analytics_repo.workspace_detail(session, workspace_id, days=days)
    if detail is None:
        raise HTTPException(
            status_code=404, detail=f"Workspace '{workspace_id}' not found",
        )
    return detail
