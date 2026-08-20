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
from backend.app.services import analytics_cache
from backend.auth_service.interface import User

logger = logging.getLogger(__name__)

router = APIRouter()

#: Either permission opens the section. ``system:admin`` implies both.
ANALYTICS_PERMISSIONS = ("system:audit:read", "system:org-admin")

_analytics_gate = requires_any(*ANALYTICS_PERMISSIONS)

#: The presets the range picker offers. Bounded so a caller can't ask for an
#: unbounded scan; 365 matches the telemetry endpoint's ceiling.
_DAYS = Query(30, ge=1, le=365, description="Trailing window, in days.")

#: A custom range. ``from``/``to`` are the natural names and both are Python
#: keywords or builtins, so they are aliased rather than spelled awkwardly in
#: the URL. Both inclusive; supplying either one requires the other.
_FROM = Query(
    None, alias="from", description="Range start, inclusive (YYYY-MM-DD).",
)
_TO = Query(
    None, alias="to", description="Range end, inclusive (YYYY-MM-DD).",
)


def _window_args(days: int, start: str | None, end: str | None) -> dict[str, Any]:
    """Custom range wins when supplied; otherwise the trailing-day preset.

    ``days`` always has a value (its default is 30), so "did the caller ask for
    a custom range?" is decided by the dates, never by days being unset.
    """
    if start or end:
        return {"start": start, "end": end}
    return {"days": days}


def _cache_key(scope: str, args: dict[str, Any]) -> str:
    """Stable key for one window.

    Built from the RESOLVED window arguments rather than the raw query string,
    so ``?days=30`` and ``?days=30&from=`` land on the same entry. Deliberately
    NOT per-user: the documents are platform-wide aggregates, identical for
    every caller who is allowed to see them, and the permission gate runs
    before the cache is consulted.
    """
    if "days" in args:
        return f"{scope}:d{args['days']}"
    return f"{scope}:{args.get('start')}:{args.get('end')}"


@router.get("/summary")
async def analytics_summary(
    days: int = _DAYS,
    date_from: str | None = _FROM,
    date_to: str | None = _TO,
    _user: User = Depends(_analytics_gate),
    session: AsyncSession = Depends(get_db_session),
) -> dict[str, Any]:
    """Platform-wide KPIs, time series, breakdowns, leaderboards, and funnel."""
    args = _window_args(days, date_from, date_to)
    try:
        return await analytics_cache.cached(
            _cache_key("summary", args),
            lambda: analytics_repo.platform_summary(session, **args),
        )
    except analytics_repo.InvalidWindow as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/workspaces")
async def analytics_workspaces(
    days: int = _DAYS,
    date_from: str | None = _FROM,
    date_to: str | None = _TO,
    _user: User = Depends(_analytics_gate),
    session: AsyncSession = Depends(get_db_session),
) -> list[dict[str, Any]]:
    """One aggregate row per live workspace — the Workspaces tab's table."""
    args = _window_args(days, date_from, date_to)
    try:
        return await analytics_cache.cached(
            _cache_key("workspaces", args),
            lambda: analytics_repo.workspace_rows(session, **args),
        )
    except analytics_repo.InvalidWindow as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/workspaces/{workspace_id}")
async def analytics_workspace_detail(
    workspace_id: str = Path(..., description="Workspace id to drill into."),
    days: int = _DAYS,
    date_from: str | None = _FROM,
    date_to: str | None = _TO,
    _user: User = Depends(_analytics_gate),
    session: AsyncSession = Depends(get_db_session),
) -> dict[str, Any]:
    """Full insights for one workspace, in the same shape as the summary."""
    args = _window_args(days, date_from, date_to)
    try:
        detail = await analytics_cache.cached(
            _cache_key(f"ws:{workspace_id}", args),
            lambda: analytics_repo.workspace_detail(session, workspace_id, **args),
        )
    except analytics_repo.InvalidWindow as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if detail is None:
        raise HTTPException(
            status_code=404, detail=f"Workspace '{workspace_id}' not found",
        )
    return detail
