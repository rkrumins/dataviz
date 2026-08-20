"""Platform-wide defaults.

Two of them: the node-identity mapping — the bottom of the resolution chain in
``backend.app.services.node_identity``, applied to every data source that does
not resolve one from its own row, its provider, or its workspace — and the
counts-history retention policy.

This is the level an operator reaches for when a whole deployment's graphs are
shaped the same way (everything keys on ``id``, everything names on ``title``),
and it is the level the previous ``AGGREGATION_NODE_IDENTITY_PROPERTY`` env var
tried and failed to be: an env var applied invisibly, could not be changed
without a redeploy, and recorded nobody as having set it.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Body, Depends
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.dependencies import requires
from backend.app.db.engine import get_db_session
from backend.app.db.models import PlatformSettingsORM
from backend.app.services.node_identity import (
    DEFAULT_IDENTITY_PROPERTY,
    DEFAULT_NAME_PROPERTY,
    invalidate_global_defaults_cache,
    invalidate_node_identity,
    scopes_resolving_through,
)
from backend.auth_service.interface import User

logger = logging.getLogger(__name__)

router = APIRouter()

_REQUIRES_SYSTEM_ADMIN = requires("system:admin")


class NodeIdentityDefaultsRequest(BaseModel):
    """Partial update. Absent = untouched; ``""`` = clear back to the code
    default."""

    identity_property: Optional[str] = Field(None, alias="identityProperty")
    name_property: Optional[str] = Field(None, alias="nameProperty")

    class Config:
        populate_by_name = True


class NodeIdentityDefaultsResponse(BaseModel):
    #: What is persisted. ``None`` = nothing set at this level.
    identity_property: Optional[str] = Field(None, alias="identityProperty")
    name_property: Optional[str] = Field(None, alias="nameProperty")
    #: The code defaults, always reported so the editor can seed its fields
    #: from ``persisted ?? default`` and show what "unset" actually means —
    #: the same contract the aggregation settings editor uses for its env
    #: defaults.
    default_identity_property: str = Field(
        DEFAULT_IDENTITY_PROPERTY, alias="defaultIdentityProperty")
    default_name_property: str = Field(
        DEFAULT_NAME_PROPERTY, alias="defaultNameProperty")
    updated_at: Optional[str] = Field(None, alias="updatedAt")
    updated_by: Optional[str] = Field(None, alias="updatedBy")

    class Config:
        populate_by_name = True


def _to_response(row: Optional[PlatformSettingsORM]) -> NodeIdentityDefaultsResponse:
    if row is None:
        return NodeIdentityDefaultsResponse()
    return NodeIdentityDefaultsResponse(
        identityProperty=row.identity_property,
        nameProperty=row.name_property,
        updatedAt=row.updated_at,
        updatedBy=row.updated_by,
    )


@router.get(
    "/node-identity",
    response_model=NodeIdentityDefaultsResponse,
    summary="Get the platform-wide node-identity defaults",
    dependencies=[Depends(_REQUIRES_SYSTEM_ADMIN)],
)
async def get_node_identity_defaults(
    session: AsyncSession = Depends(get_db_session),
):
    return _to_response(await session.get(PlatformSettingsORM, 1))


@router.put(
    "/node-identity",
    response_model=NodeIdentityDefaultsResponse,
    summary="Set the platform-wide node-identity defaults",
    dependencies=[Depends(_REQUIRES_SYSTEM_ADMIN)],
)
async def put_node_identity_defaults(
    req: NodeIdentityDefaultsRequest = Body(...),
    user: User = Depends(_REQUIRES_SYSTEM_ADMIN),
    session: AsyncSession = Depends(get_db_session),
):
    row = await session.get(PlatformSettingsORM, 1)
    if row is None:
        row = PlatformSettingsORM(id=1)
        session.add(row)
    before = (row.identity_property, row.name_property)

    if req.identity_property is not None:
        row.identity_property = req.identity_property.strip() or None
    if req.name_property is not None:
        row.name_property = req.name_property.strip() or None
    row.updated_at = datetime.now(timezone.utc).isoformat()
    row.updated_by = getattr(user, "id", None)
    await session.commit()

    # Same-process readers see the new value immediately; other pods are bounded
    # by the resolver's short TTL.
    invalidate_global_defaults_cache()

    if before != (row.identity_property, row.name_property):
        # The widest possible blast radius: every data source that does not
        # override the mapping now resolves differently. Mark them, don't run
        # them — see invalidate_node_identity.
        scopes = await scopes_resolving_through(session)
        logger.info(
            "Platform node-identity defaults changed (%s → %s) — %d data "
            "source(s) marked for re-aggregation.",
            before, (row.identity_property, row.name_property), len(scopes),
        )
        await invalidate_node_identity(session, scopes, "platform_identity_changed")

    return _to_response(await session.get(PlatformSettingsORM, 1))


# ── Counts-history retention ────────────────────────────────────────
#
# Same "persisted ?? default" contract as the node-identity block above, for
# the same reason: retention is a knob an operator reaches for in response to
# something (a table growing faster than expected, an audit that needs a
# longer window), and making that a redeploy — with nobody recorded as having
# done it — is exactly the failure mode ``platform_settings`` exists to fix.

_UNSET = -1


class HistoryRetentionRequest(BaseModel):
    """Partial update. Absent = untouched; ``-1`` = clear back to the env
    default. ``-1`` rather than ``null`` as the clear sentinel because absent
    and null are indistinguishable over JSON for an optional int, and the
    difference between "don't touch this" and "reset this" is the whole point
    of a partial update."""

    retention_days: Optional[int] = Field(None, alias="retentionDays", ge=_UNSET)
    max_rows_per_source: Optional[int] = Field(
        None, alias="maxRowsPerSource", ge=_UNSET)
    heartbeat_secs: Optional[int] = Field(None, alias="heartbeatSecs", ge=_UNSET)

    class Config:
        populate_by_name = True


class HistoryRetentionResponse(BaseModel):
    #: What is persisted. ``None`` = inheriting the env default.
    retention_days: Optional[int] = Field(None, alias="retentionDays")
    max_rows_per_source: Optional[int] = Field(None, alias="maxRowsPerSource")
    heartbeat_secs: Optional[int] = Field(None, alias="heartbeatSecs")
    #: The env defaults behind them, so the editor seeds from the real value
    #: and a no-op save round-trips it instead of pinning what the UI rendered.
    env_retention_days: int = Field(0, alias="envRetentionDays")
    env_max_rows_per_source: int = Field(0, alias="envMaxRowsPerSource")
    env_heartbeat_secs: int = Field(0, alias="envHeartbeatSecs")
    #: What is actually in force right now, after the ?? and the clamps.
    effective_retention_days: int = Field(0, alias="effectiveRetentionDays")
    effective_max_rows_per_source: int = Field(0, alias="effectiveMaxRowsPerSource")
    effective_heartbeat_secs: int = Field(0, alias="effectiveHeartbeatSecs")
    #: False when INSIGHTS_HISTORY_ENABLED is off — the editor then explains
    #: that nothing is being captured rather than showing live-looking knobs.
    enabled: bool = True

    class Config:
        populate_by_name = True


async def _history_response(session: AsyncSession) -> HistoryRetentionResponse:
    from backend.app.db.repositories import stats_history_repo

    policy = await stats_history_repo.resolve_history_policy(session)
    return HistoryRetentionResponse(
        retentionDays=policy.persisted_retention_days,
        maxRowsPerSource=policy.persisted_max_rows_per_source,
        heartbeatSecs=policy.persisted_heartbeat_secs,
        envRetentionDays=policy.env_retention_days,
        envMaxRowsPerSource=policy.env_max_rows_per_source,
        envHeartbeatSecs=policy.env_heartbeat_secs,
        effectiveRetentionDays=policy.retention_days,
        effectiveMaxRowsPerSource=policy.max_rows_per_source,
        effectiveHeartbeatSecs=policy.heartbeat_secs,
        enabled=policy.enabled,
    )


@router.get(
    "/history-retention",
    response_model=HistoryRetentionResponse,
    summary="Get the counts-history retention policy",
    dependencies=[Depends(_REQUIRES_SYSTEM_ADMIN)],
)
async def get_history_retention(
    session: AsyncSession = Depends(get_db_session),
):
    return await _history_response(session)


@router.put(
    "/history-retention",
    response_model=HistoryRetentionResponse,
    summary="Set the counts-history retention policy",
    dependencies=[Depends(_REQUIRES_SYSTEM_ADMIN)],
)
async def put_history_retention(
    req: HistoryRetentionRequest = Body(...),
    user: User = Depends(_REQUIRES_SYSTEM_ADMIN),
    session: AsyncSession = Depends(get_db_session),
):
    from backend.app.db.repositories.stats_history_repo import (
        invalidate_history_policy_cache,
    )

    row = await session.get(PlatformSettingsORM, 1)
    if row is None:
        row = PlatformSettingsORM(id=1)
        session.add(row)

    for field, column in (
        ("retention_days", "history_retention_days"),
        ("max_rows_per_source", "history_max_rows_per_source"),
        ("heartbeat_secs", "history_heartbeat_secs"),
    ):
        value = getattr(req, field)
        if value is None:
            continue
        setattr(row, column, None if value == _UNSET else value)

    row.updated_at = datetime.now(timezone.utc).isoformat()
    row.updated_by = getattr(user, "id", None)
    await session.commit()

    # Same-process readers see it immediately; other pods are bounded by the
    # policy memo's 30s TTL. Nothing needs re-aggregating — unlike the
    # node-identity defaults above, this changes only how long rows are kept.
    invalidate_history_policy_cache()
    logger.info(
        "Counts-history retention updated by %s: days=%s rows=%s heartbeat=%s",
        getattr(user, "id", None), row.history_retention_days,
        row.history_max_rows_per_source, row.history_heartbeat_secs,
    )
    return await _history_response(session)
