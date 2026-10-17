"""Platform administration of the versioned graphs' FalkorDB projections, under
``/admin/versioning``.

Every route needs ``system:admin``. None is on the API-key surface (``auth/api_key_surface``), so
an API key is refused.
"""
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.dependencies import requires
from backend.app.db.engine import get_db_session
from backend.app.services.activity import recorder
from backend.auth_service.interface import User

from .versioning import get_versioning_service

router = APIRouter()


class WatermarkResetRequest(BaseModel):
    provider: str = Field(..., min_length=1,
                          description="FalkorDB provider id; 'default' for the env instance")


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
    by the projection worker; reads fall back to Postgres until each one catches up."""
    ids = await get_versioning_service().reset_projection_watermarks(
        provider=body.provider, actor=user.id)
    await recorder.record_for_request(
        session, "platform.versioning.watermarks_reset",
        details={"provider": body.provider, "graphsReset": len(ids)},
        best_effort=True,   # the watermarks are already reset
    )
    return {"provider": body.provider, "graphsReset": len(ids)}
