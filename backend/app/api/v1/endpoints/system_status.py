"""Super-admin infrastructure status endpoint.

One read-only GET returning the fan-in snapshot assembled by
``services/system_status`` (all probes concurrent + ~10s shared cache).
Router-level ``system:admin`` gate is applied at registration in
``api.py`` — mirrors the features / insights admin routers.
"""
from fastapi import APIRouter, HTTPException, Request
from sqlalchemy.exc import SQLAlchemyError
from starlette.concurrency import run_in_threadpool

from backend.app.services.system_status import get_system_snapshot
from backend.app.services.system_status.schema import schema_status

router = APIRouter()


@router.get("/status", summary="Infrastructure status snapshot (super-admin)")
async def get_status(request: Request) -> dict:
    return await get_system_snapshot(request.app.state)


@router.get("/schema", summary="Database schema: where it stands, what an upgrade would do, its history (super-admin)")
async def get_schema(request: Request) -> dict:
    """Read live: the startup snapshot would say what was true when this server started."""
    try:
        status = await run_in_threadpool(schema_status)
    except SQLAlchemyError as error:
        raise HTTPException(status_code=503, detail=f"The database couldn't be read: {error.__class__.__name__}") from error
    status["build"]["version"] = request.app.version
    return status
