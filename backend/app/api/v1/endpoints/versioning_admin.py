"""Platform administration of the versioned graphs' FalkorDB projections, under
``/admin/versioning``.

Every route needs ``system:admin``. None is on the API-key surface (``auth/api_key_surface``), so
an API key is refused.
"""
from typing import Literal, Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.dependencies import requires
from backend.app.db.engine import get_db_session
from backend.app.services.activity import recorder
from backend.app.services.system_status import probes
from backend.auth_service.interface import User

from .versioning import get_versioning_service

router = APIRouter()


class WatermarkResetRequest(BaseModel):
    provider: str = Field(..., min_length=1,
                          description="FalkorDB provider id; 'default' for the env instance")
    dry_run: bool = Field(False, alias="dryRun",
                          description="Count the graphs it would reseed, and change nothing")


@router.post("/watermarks/reset",
             summary="Reseed every versioned graph on a FalkorDB provider from Postgres")
async def reset_watermarks(
    body: WatermarkResetRequest,
    user: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
) -> dict:
    """Run after restoring a FalkorDB instance or shard, or rebuilding a region: its keys may
    hold an older state than the platform's watermarks say, and graphs projected before pass
    markers existed cannot tell. Every live versioned graph on the provider is reseeded in place
    by the projection worker; reads fall back to Postgres until each one catches up. A dry run
    answers how many that is, for the confirm, and is not recorded."""
    ids = await get_versioning_service().reset_projection_watermarks(
        provider=body.provider, actor=user.id, dry_run=body.dry_run)
    if body.dry_run:
        return {"provider": body.provider, "graphsToReset": len(ids)}
    await recorder.record_for_request(
        session, "platform.versioning.watermarks_reset",
        details={"provider": body.provider, "graphsReset": len(ids)},
        best_effort=True,   # the watermarks are already reset
    )
    return {"provider": body.provider, "graphsReset": len(ids)}


@router.get("/graphs",
            summary="Every versioned graph with its FalkorDB provider, key and projection state")
async def list_graphs(
    provider: Optional[str] = Query(
        None, min_length=1, description="FalkorDB provider id; 'default' for the env instance"),
    status: Optional[Literal["fresh", "lagging", "projecting", "rebuilding", "evicted",
                             "failed"]] = None,
    workspace_id: Optional[str] = Query(None, alias="workspaceId", min_length=1),
    kind: Optional[Literal["main", "fork", "orphan"]] = None,
    q: Optional[str] = Query(None, min_length=1, max_length=200),
    cursor: Optional[str] = Query(None, max_length=200,
                                  description="The previous page's nextCursor"),
    limit: int = Query(50, ge=1, le=200),
    _user: User = Depends(requires("system:admin")),
) -> dict:
    """The fleet inventory: one page of every versioned graph, by graph id, including the forks
    and orphans the Infrastructure projection rollup leaves out — so the ninth failing graph, a
    fork's key or a graph whose data source was deleted can be found and acted on."""
    return await probes.list_versioned_graphs(
        provider=provider, status=status, workspace_id=workspace_id, kind=kind, q=q,
        cursor=cursor, limit=limit)
