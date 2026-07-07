"""Super-admin infrastructure status endpoint.

One read-only GET returning the fan-in snapshot assembled by
``services/system_status`` (all probes concurrent + ~10s shared cache).
Router-level ``system:admin`` gate is applied at registration in
``api.py`` — mirrors the features / insights admin routers.
"""
from fastapi import APIRouter, Request

from backend.app.services.system_status import get_system_snapshot

router = APIRouter()


@router.get("/status", summary="Infrastructure status snapshot (super-admin)")
async def get_status(request: Request) -> dict:
    return await get_system_snapshot(request.app.state)
