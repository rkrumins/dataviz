"""Profiling — counts and composition over time.

A time-series API over the durable profile of every onboarded data source.
Pure Postgres reads: no provider IO, nothing enqueued, no cache warmed. That
is a property worth protecting deliberately rather than a coincidence — it
means the board stays up during a provider outage, which is precisely when
someone opens it.

**One shape, four scopes.** ``source``, ``workspace``, ``provider`` and
``all`` are the same query with a different filter, so a workspace user and a
platform operator read the same endpoint and the authorisation decides what
"all" means for them. The alternative — a per-persona endpoint — guarantees
the two drift.

**Window tokens, not absolute ranges.** A client sends ``window=30d`` and the
server resolves and returns the bounds it used, quantised to the grain. A
client computing ``to=now()`` on every render produces a new value every time,
which is a cache key that never hits and, on the previous implementation, a
React Query key that re-fetched forever.
"""
from __future__ import annotations

import csv
import io
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Sequence

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Response
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.v1.endpoints.aggregation import _require_ingestion_read
from backend.app.auth.dependencies import get_permission_claims
from backend.app.config import resilience
from backend.app.db.engine import get_db_session
from backend.app.db.repositories import (
    count_alerts_repo, profiling_repo, stats_history_repo,
)
from backend.app.services.permission_service import PermissionClaims
from backend.app.services import profiling_series
from backend.app.services.workspace_visibility import (
    compute_visible_data_source_ids,
    ensure_data_source_visible,
)

logger = logging.getLogger(__name__)

#: Gated by the Ingestion-surface read permission, the same one Freshness and
#: Job History use. Profiling is a member of that section, not a platform-admin
#: tool: a workspace data-source manager who can already see a source's current
#: counts must be able to see how they moved, and gating this at
#: ``system:admin`` is what made the whole feature invisible to the people who
#: onboard the data.
router = APIRouter(dependencies=[Depends(_require_ingestion_read)])

#: Named windows the UI offers. Anything else must come as explicit bounds,
#: so a typo widens to the default rather than silently meaning something.
_WINDOWS = {
    "24h": timedelta(hours=24),
    "7d": timedelta(days=7),
    "30d": timedelta(days=30),
    "90d": timedelta(days=90),
}
_DEFAULT_WINDOW = "30d"

#: Rows per page on the listing endpoints. All three were unbounded before.
_DEFAULT_LIMIT = 100
_MAX_LIMIT = 500


def _resolve_window(
    window: Optional[str], frm: Optional[str], to: Optional[str],
    *, now: Optional[datetime] = None,
) -> tuple[str, str, str]:
    """(from, to, window_label) for a request.

    Explicit bounds win. Otherwise the token, defaulting rather than erroring:
    a bad window should show you the usual view, not an error page.
    """
    at = now or datetime.now(timezone.utc)
    if frm and to:
        return (frm, to, "custom") if frm <= to else (to, frm, "custom")
    label = window if window in _WINDOWS else _DEFAULT_WINDOW
    start = at - _WINDOWS[label]
    return start.isoformat(), at.isoformat(), label


async def _visible(session: AsyncSession, claims) -> Optional[List[str]]:
    """The caller's data sources, or None for a platform operator.

    An EMPTY set is not None and must never be conflated with it: it means a
    caller bound to no workspace, and the correct answer for them is nothing.
    """
    visible = await compute_visible_data_source_ids(session, claims)
    return None if visible is None else sorted(visible)


async def _scope_for(
    session: AsyncSession, claims, *, scope: str, scope_id: Optional[str],
) -> tuple[str, Optional[str], Optional[List[str]], bool]:
    """Validate a scope request and resolve the caller's visibility.

    Returns ``(scope, scope_id, visible, platform_wide)``. ``platform_wide``
    is returned to the client because "nothing moved" means very different
    things at the two altitudes, and a board that cannot say which one it is
    showing invites the wrong conclusion.
    """
    if scope not in profiling_repo.SCOPES:
        raise HTTPException(status_code=400, detail=f"Unknown scope '{scope}'")
    if scope != "all" and not scope_id:
        raise HTTPException(
            status_code=400, detail=f"scope='{scope}' requires an id",
        )

    if scope == "source" and scope_id:
        # The routable page and the Ingestion drawer are keyed on the catalog
        # item; profiling is keyed on the data source. Resolved BEFORE the
        # visibility check, so authorisation always runs against the id that
        # will actually be read.
        scope_id = await profiling_repo.resolve_source_id(session, scope_id)

    visible = await _visible(session, claims)
    if scope == "source":
        # 404 rather than 403: refusing by existence lets a caller enumerate
        # other tenants' data sources by watching which ids answer differently.
        await ensure_data_source_visible(session, claims, scope_id)
    return scope, scope_id, visible, visible is None


# ── series ───────────────────────────────────────────────────────────


@router.get("/series", summary="Counts and composition over time")
async def get_series(
    scope: str = Query("source", description="source | workspace | provider | all"),
    id: Optional[str] = Query(None, description="Required unless scope=all"),
    window: Optional[str] = Query(None, description="24h | 7d | 30d | 90d"),
    frm: Optional[str] = Query(None, alias="from"),
    to: Optional[str] = Query(None),
    grain: Optional[str] = Query(None, description="raw | hour | day | auto"),
    metric: str = Query("total", description="total | nodes | edges"),
    breakdown: str = Query("none", description="none | entity_type | edge_type"),
    top: int = Query(profiling_series.DEFAULT_TOP, ge=1, le=20),
    compare: bool = Query(False, description="Also return the preceding window"),
    session: AsyncSession = Depends(get_db_session),
    claims: PermissionClaims = Depends(get_permission_claims),
) -> dict:
    """The series a chart draws, series-major.

    ``compare`` returns the immediately preceding window of the same length as
    a second payload, so "is this normal for us" can be answered on the same
    axis rather than from memory.
    """
    scope, scope_id, visible, platform_wide = await _scope_for(
        session, claims, scope=scope, scope_id=id,
    )
    frm_iso, to_iso, label = _resolve_window(window, frm, to)
    resolved_grain = await profiling_repo.choose_grain(
        session, scope=scope, scope_id=scope_id, visible=visible,
        frm=frm_iso, to=to_iso, requested=grain,
    )

    observations, truncated = await profiling_repo.read_observations(
        session, scope=scope, scope_id=scope_id, visible=visible,
        frm=frm_iso, to=to_iso, grain=resolved_grain,
    )
    payload = profiling_series.build_series(
        observations, metric=metric, breakdown=breakdown, top=top,
    )
    payload.update({
        "scope": scope,
        "id": scope_id,
        "from": frm_iso,
        "to": to_iso,
        "window": label,
        "grain": resolved_grain,
        "requested_metric": metric,
        "breakdown": breakdown,
        "platform_wide": platform_wide,
        "truncated": truncated,
        "vanished_types": profiling_series.types_that_vanished(
            observations, breakdown=breakdown,
        ),
        "coverage_from": await profiling_repo.coverage_from(
            session, scope=scope, scope_id=scope_id, visible=visible,
        ),
        "sources_observed": len({o.data_source_id for o in observations}),
    })

    if compare:
        start, end = _parse_iso(frm_iso), _parse_iso(to_iso)
        if start and end:
            span = end - start
            prev_from, prev_to = (start - span).isoformat(), start.isoformat()
            prev_obs, _ = await profiling_repo.read_observations(
                session, scope=scope, scope_id=scope_id, visible=visible,
                frm=prev_from, to=prev_to, grain=resolved_grain,
            )
            payload["previous"] = profiling_series.build_series(
                prev_obs, metric=metric, breakdown=breakdown, top=top,
            )
            payload["previous"].update({"from": prev_from, "to": prev_to})

    return {"data": payload}


def _parse_iso(value: str) -> Optional[datetime]:
    try:
        parsed = datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


# ── the board: what moved ────────────────────────────────────────────


@router.get("/sources", summary="Per-source movement, ranked")
async def get_board(
    window: Optional[str] = Query(None),
    frm: Optional[str] = Query(None, alias="from"),
    to: Optional[str] = Query(None),
    workspace_id: Optional[str] = Query(None, alias="workspaceId"),
    provider_id: Optional[str] = Query(None, alias="providerId"),
    metric: str = Query("nodes", description="nodes | edges"),
    unusual_only: bool = Query(False, alias="unusualOnly"),
    limit: int = Query(_DEFAULT_LIMIT, ge=1, le=_MAX_LIMIT),
    offset: int = Query(0, ge=0),
    session: AsyncSession = Depends(get_db_session),
    claims: PermissionClaims = Depends(get_permission_claims),
) -> dict:
    """One row per data source, ordered by how much it moved.

    Every other read starts from a source you already chose. This one starts
    from the question an operator actually opens the page with — *what moved*
    — and lets the source be the answer rather than the input.

    Sources with no observation in the window are COUNTED, never listed at
    zero. A source that was not observed did not drop to nothing, and a board
    that showed it at zero would invent an outage.
    """
    visible = await _visible(session, claims)
    frm_iso, to_iso, label = _resolve_window(window, frm, to)

    rows, unobserved = await profiling_repo.movement_board(
        session, visible=visible, frm=frm_iso, to=to_iso,
        workspace_id=workspace_id, provider_id=provider_id, metric=metric,
    )
    if unusual_only:
        rows = [r for r in rows if r["significance"] != "normal"]

    total = len(rows)
    page = rows[offset : offset + limit]
    return {"data": {
        "from": frm_iso, "to": to_iso, "window": label,
        "metric": metric,
        "platform_wide": visible is None,
        "rows": page,
        "total": total,
        "offset": offset,
        "limit": limit,
        "unobserved": unobserved,
    }}


# ── the ledger: what happened, observation by observation ────────────


@router.get("/observations", summary="The change ledger for one source")
async def get_observations(
    id: str = Query(..., description="Data source id"),
    window: Optional[str] = Query(None),
    frm: Optional[str] = Query(None, alias="from"),
    to: Optional[str] = Query(None),
    only_notable: bool = Query(False, alias="onlyNotable"),
    limit: int = Query(_DEFAULT_LIMIT, ge=1, le=_MAX_LIMIT),
    offset: int = Query(0, ge=0),
    session: AsyncSession = Depends(get_db_session),
    claims: PermissionClaims = Depends(get_permission_claims),
) -> dict:
    """Every recorded observation, newest first, with what moved and why.

    Always raw: this is the record of what was OBSERVED, and a bucket-closing
    value cannot answer "which run did this". Bound to the run that caused it
    where one did, so "counts per run, per type in the run" is an exact join
    rather than a time-window guess.
    """
    id = await profiling_repo.resolve_source_id(session, id)
    await ensure_data_source_visible(session, claims, id)
    frm_iso, to_iso, label = _resolve_window(window, frm, to)

    rows, total, baselines = await profiling_repo.observations_for_source(
        session, ds_id=id, frm=frm_iso, to=to_iso,
        only_notable=only_notable, limit=limit, offset=offset,
    )
    events = await profiling_repo.refresh_events_for_source(
        session, ds_id=id, frm=frm_iso, to=to_iso,
    )
    counts = await profiling_repo.window_counts(
        session, ds_id=id, frm=frm_iso, to=to_iso,
    )
    return {"data": {
        "id": id, "from": frm_iso, "to": to_iso, "window": label,
        "observations": rows,
        "total": total,
        "offset": offset,
        "limit": limit,
        "baselines": baselines,
        # Facts about the PERIOD, counted in SQL. The ledger says "214
        # observations, 5 moved" — a claim about the window that cannot be
        # derived from whichever page of it was returned.
        "counts": counts,
        # Read separately, never JOINed: refresh_events belongs to the
        # aggregation domain. Absence is informative and surfaced as such —
        # if nothing of ours ran, whatever changed the graph came from outside.
        "events": events,
    }}


# ── export ───────────────────────────────────────────────────────────


@router.get("/export.csv", summary="The same series as CSV")
async def export_csv(
    scope: str = Query("source"),
    id: Optional[str] = Query(None),
    window: Optional[str] = Query(None),
    frm: Optional[str] = Query(None, alias="from"),
    to: Optional[str] = Query(None),
    grain: Optional[str] = Query(None),
    breakdown: str = Query("none"),
    session: AsyncSession = Depends(get_db_session),
    claims: PermissionClaims = Depends(get_permission_claims),
) -> Response:
    """One row per bucket, one column per series. Always the drawn values, so
    an export and the chart it came from can never disagree."""
    scope, scope_id, visible, _wide = await _scope_for(
        session, claims, scope=scope, scope_id=id,
    )
    frm_iso, to_iso, _label = _resolve_window(window, frm, to)
    resolved_grain = await profiling_repo.choose_grain(
        session, scope=scope, scope_id=scope_id, visible=visible,
        frm=frm_iso, to=to_iso, requested=grain,
    )

    observations, _truncated = await profiling_repo.read_observations(
        session, scope=scope, scope_id=scope_id, visible=visible,
        frm=frm_iso, to=to_iso, grain=resolved_grain,
    )
    built = profiling_series.build_series(
        observations, metric="total", breakdown=breakdown,
        top=profiling_series.DEFAULT_TOP,
    )

    buffer = io.StringIO()
    writer = csv.writer(buffer)
    headers = ["bucket"] + [s["label"] for s in built["series"]]
    writer.writerow(headers)
    for i, bucket in enumerate(built["buckets"]):
        writer.writerow(
            [bucket] + [s["points"][i]["v"] for s in built["series"]]
        )

    name = f"profiling-{scope}-{scope_id or 'all'}-{resolved_grain}.csv"
    return Response(
        content=buffer.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{name}"'},
    )


# ── alerts ───────────────────────────────────────────────────────────


@router.get("/alerts", summary="Recorded findings with frozen evidence")
async def list_alerts(
    id: Optional[str] = Query(None, description="Scope to one data source"),
    open_only: bool = Query(False, alias="openOnly"),
    limit: int = Query(_DEFAULT_LIMIT, ge=1, le=_MAX_LIMIT),
    offset: int = Query(0, ge=0),
    session: AsyncSession = Depends(get_db_session),
    claims: PermissionClaims = Depends(get_permission_claims),
) -> dict:
    if id:
        id = await profiling_repo.resolve_source_id(session, id)
        await ensure_data_source_visible(session, claims, id)
    visible = await _visible(session, claims)
    rows, total, open_count = await profiling_repo.list_findings(
        session, data_source_id=id, visible=visible,
        open_only=open_only, limit=limit, offset=offset,
    )
    return {"data": {
        "alerts": rows, "total": total, "openCount": open_count,
        "offset": offset, "limit": limit,
        "platform_wide": visible is None,
    }}


@router.post("/alerts/{alert_id}/acknowledge", summary="Mark a finding seen")
async def acknowledge_alert(
    alert_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
    claims: PermissionClaims = Depends(get_permission_claims),
) -> dict:
    alert = await count_alerts_repo.get_alert(session, alert_id)
    if alert is None:
        raise HTTPException(status_code=404, detail="Finding not found")
    await ensure_data_source_visible(
        session, claims, alert.data_source_id,
        not_found_detail="Finding not found",
    )
    actor = getattr(claims, "user_id", None) or "unknown"
    updated = await count_alerts_repo.acknowledge(
        session, alert_id, actor_id=actor,
    )
    await session.commit()
    return {"data": profiling_repo.finding_model(updated or alert)}


# ── policy ───────────────────────────────────────────────────────────


class PolicyRequest(BaseModel):
    """Retention and alerting, edited together.

    One object because in practice they are one decision: how much evidence to
    keep and how loudly to react to it. ``-1`` clears an override back to the
    environment default, so a field can be un-set without a second verb.
    """

    rawRetentionDays: Optional[int] = Field(None, ge=-1)
    hourlyRetentionDays: Optional[int] = Field(None, ge=-1)
    dailyRetentionDays: Optional[int] = Field(None, ge=-1)
    maxRowsPerSource: Optional[int] = Field(None, ge=-1)
    heartbeatSecs: Optional[int] = Field(None, ge=-1)
    silentAfterSecs: Optional[int] = Field(None, ge=-1)
    alertsEnabled: Optional[bool] = None
    alertMinSeverity: Optional[str] = None
    alertCooldownSecs: Optional[int] = Field(None, ge=-1)


@router.get("/policy", summary="Retention and alerting policy")
async def get_policy(
    session: AsyncSession = Depends(get_db_session),
    claims: PermissionClaims = Depends(get_permission_claims),
) -> dict:
    """Readable by anyone who can read profiling; writable by platform admins.

    Readable deliberately: the previous version gated the READ at
    ``system:admin`` while the UI showed the control to everyone, so every
    non-admin got a permanent spinner and a global access-denied modal. A
    policy someone cannot change is still a policy they need to see, because
    it explains why the window they are looking at stops where it does.
    """
    retention, overrides = await profiling_repo.resolve_retention_policy(session)
    env = profiling_repo.env_retention_policy()
    alerts = await count_alerts_repo.resolve_alert_policy(session)
    # RESOLVED, not env. Reporting the environment value for a field the
    # operator can override means their saved change reads back as ignored —
    # and the capture path honours it, so the page would be contradicting the
    # behaviour rather than describing it.
    capture = await stats_history_repo.resolve_history_policy(session)
    silent_after = (
        overrides.get("silentAfterSecs") or resilience.PROFILING_SILENT_AFTER_SECS
    )
    return {"data": {
        "rawRetentionDays": retention.raw_days,
        "hourlyRetentionDays": retention.hourly_days,
        "dailyRetentionDays": retention.daily_days,
        "maxRowsPerSource": retention.max_rows_per_source,
        "heartbeatSecs": capture.heartbeat_secs,
        "silentAfterSecs": silent_after,
        "alertsEnabled": alerts.enabled,
        "alertMinSeverity": alerts.min_severity,
        "alertCooldownSecs": alerts.cooldown_secs,
        # What the deployment would use with nothing persisted, so the editor
        # can show it as the placeholder and a blank field can mean "inherit"
        # rather than pinning today's default forever.
        # What the deployment would use with nothing persisted, so the editor
        # can show it as a placeholder and a blank field can mean "inherit"
        # rather than pinning today's default forever.
        "defaults": {
            "rawRetentionDays": env.raw_days,
            "hourlyRetentionDays": env.hourly_days,
            "dailyRetentionDays": env.daily_days,
            "maxRowsPerSource": env.max_rows_per_source,
            "heartbeatSecs": resilience.PROFILING_HEARTBEAT_SECS,
            "silentAfterSecs": resilience.PROFILING_SILENT_AFTER_SECS,
            "alertMinSeverity": count_alerts_repo.env_alert_policy().min_severity,
            "alertCooldownSecs": count_alerts_repo.env_alert_policy().cooldown_secs,
        },
        "overridden": sorted(overrides),
        "editable": _can_edit_policy(claims),
        # Deployment concerns, reported so an operator can SEE the cadences
        # without being able to wedge retention from a settings page: the
        # purge cannot delete raw beyond the compaction watermark, so a
        # live-editable compaction interval is a way to stall retention.
        "cadences": {
            "captureHeartbeatSecs": resilience.PROFILING_HEARTBEAT_SECS,
            "compactIntervalSecs": resilience.PROFILING_COMPACT_INTERVAL_SECS,
            "retentionIntervalSecs": resilience.PROFILING_RETENTION_INTERVAL_SECS,
            "alertIntervalSecs": resilience.PROFILING_ALERT_INTERVAL_SECS,
            "readOnly": True,
        },
    }}


def _can_edit_policy(claims) -> bool:
    """Platform admins only. Retention is fleet-wide configuration, not a
    per-workspace view, and one workspace shortening it would silently shorten
    everyone else's evidence."""
    return "system:admin" in (claims.global_perms or ())


@router.put("/policy", summary="Set the retention and alerting policy")
async def put_policy(
    body: PolicyRequest,
    session: AsyncSession = Depends(get_db_session),
    claims: PermissionClaims = Depends(get_permission_claims),
) -> dict:
    if not _can_edit_policy(claims):
        raise HTTPException(
            status_code=403,
            detail="Changing the profiling policy requires system:admin",
        )
    values = body.model_dump(exclude_none=True)
    current, _overrides = await profiling_repo.resolve_retention_policy(session)
    try:
        # Rejected, not clamped. Silently rewriting a number someone typed is
        # how a settings page stops being trustworthy.
        profiling_repo.validate_policy(values, current)
    except profiling_repo.PolicyConflict as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    await profiling_repo.persist_policy(session, values)
    await session.commit()
    return await get_policy(session=session, claims=claims)
