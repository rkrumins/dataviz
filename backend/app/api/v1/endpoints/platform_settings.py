"""Platform-wide defaults.

Currently just the node-identity mapping — the bottom of the resolution chain
in ``backend.app.services.node_identity``, applied to every data source that
does not resolve one from its own row, its provider, or its workspace.

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
