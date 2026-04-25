"""
Thin FastAPI adapter for the aggregation service.

Supports two modes controlled by ``AGGREGATION_PROXY_ENABLED`` env var:

  - **Direct mode** (default, ``false``):
    Calls AggregationService in-process. Used for dev / single-process mode.

  - **Proxy mode** (``true``):
    Forwards all requests to the Aggregation Control Plane via HTTP.
    The viz-service becomes a transparent proxy — the Control Plane owns
    all job lifecycle logic.  This is the production deployment model.

This is the ONLY monolith file that imports FROM the aggregation package.
"""
import logging
import os
from typing import List, Optional

import httpx
from fastapi import (
    APIRouter, Body, Depends, HTTPException, Query, Request, Response, status,
)
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.engine import get_db_session
from backend.app.services.aggregation.schemas import ResumeOverrides

logger = logging.getLogger(__name__)

router = APIRouter()

# ── Feature flag ────────────────────────────────────────────────────

_PROXY_ENABLED = os.getenv("AGGREGATION_PROXY_ENABLED", "false").lower() == "true"
_PROXY_BASE_URL = os.getenv("AGGREGATION_SERVICE_URL", "http://localhost:8091")

# ── Proxy client (lazy singleton) ──────────────────────────────────

_httpx_client: httpx.AsyncClient | None = None


def _get_proxy_client() -> httpx.AsyncClient:
    """Return a reusable httpx.AsyncClient pointed at the Control Plane."""
    global _httpx_client
    if _httpx_client is None:
        _httpx_client = httpx.AsyncClient(
            base_url=_PROXY_BASE_URL,
            timeout=httpx.Timeout(30.0, connect=5.0),
        )
    return _httpx_client


async def _proxy(method: str, path: str, request: Request, body: bytes | None = None) -> Response:
    """Forward a request to the Control Plane and return its response."""
    client = _get_proxy_client()
    try:
        # Forward query params as-is
        url = httpx.URL(path, params=dict(request.query_params))
        resp = await client.request(
            method,
            str(url),
            content=body,
            headers={"content-type": "application/json"} if body else {},
        )
        return Response(
            content=resp.content,
            status_code=resp.status_code,
            media_type=resp.headers.get("content-type", "application/json"),
        )
    except httpx.ConnectError:
        raise HTTPException(
            status_code=503,
            detail="Aggregation Control Plane is unreachable. It may still be starting up.",
        )
    except httpx.TimeoutException:
        raise HTTPException(
            status_code=504,
            detail="Aggregation Control Plane request timed out.",
        )


# ── Direct-mode dependencies (only imported when proxy is disabled) ─

def _get_svc(request: Request):
    """FastAPI dependency — retrieves AggregationService from app.state.

    In proxy mode, returns None (the endpoint short-circuits to the proxy
    before using svc). In direct mode, raises 503 if not yet initialized.
    """
    if _PROXY_ENABLED:
        return None
    svc = getattr(request.app.state, "aggregation_service", None)
    if svc is None:
        raise HTTPException(
            status_code=503,
            detail="Aggregation service is not available. The server may still be starting up.",
        )
    return svc


# ── Lazy imports for direct mode (avoid importing if proxy-only) ────

def _direct_imports():
    from backend.app.services.aggregation import (
        AggregationTriggerRequest,
        AggregationSkipRequest,
        AggregationScheduleRequest,
    )
    from backend.app.services.aggregation.service import ConflictError, NotFoundError
    return AggregationTriggerRequest, AggregationSkipRequest, AggregationScheduleRequest, ConflictError, NotFoundError


# ── Path mapping: viz-service paths -> Control Plane paths ──────────
# Viz-service mounts this router at /admin, so full paths are like:
#   /api/v1/admin/aggregation-jobs/summary
# The Control Plane uses:
#   /aggregation/jobs/summary


# ── GET /aggregation-jobs/summary ───────────────────────────────────

@router.get("/aggregation-jobs/summary", summary="Get aggregation job summary stats (KPIs)")
async def get_jobs_summary(
    request: Request,
    svc=Depends(_get_svc),
    session: AsyncSession = Depends(get_db_session),
):
    if _PROXY_ENABLED:
        return await _proxy("GET", "/aggregation/jobs/summary", request)
    return await svc.get_jobs_summary(session)


# ── GET /aggregation-jobs (global) ──────────────────────────────────

@router.get("/aggregation-jobs", summary="List all aggregation jobs (global)")
async def list_jobs_global(
    request: Request,
    svc=Depends(_get_svc),
    session: AsyncSession = Depends(get_db_session),
    job_status: Optional[List[str]] = Query(None, alias="status"),
    workspace_id: Optional[str] = Query(None, alias="workspaceId"),
    data_source_id: Optional[List[str]] = Query(None, alias="dataSourceId"),
    projection_mode: Optional[str] = Query(None, alias="projectionMode"),
    trigger_source: Optional[str] = Query(None, alias="triggerSource"),
    date_from: Optional[str] = Query(None, alias="dateFrom"),
    date_to: Optional[str] = Query(None, alias="dateTo"),
    search: Optional[str] = Query(None, alias="search"),
    limit: int = Query(25, ge=1, le=100),
    offset: int = Query(0, ge=0),
):
    if _PROXY_ENABLED:
        return await _proxy("GET", "/aggregation/jobs", request)
    return await svc.list_jobs_global(
        session,
        status=job_status,
        workspace_id=workspace_id,
        data_source_ids=data_source_id,
        projection_mode=projection_mode,
        trigger_source=trigger_source,
        date_from=date_from,
        date_to=date_to,
        search=search,
        limit=limit,
        offset=offset,
    )


# ── POST /data-sources/{ds_id}/aggregation-jobs ─────────────────────

@router.post(
    "/data-sources/{ds_id}/aggregation-jobs",
    status_code=status.HTTP_202_ACCEPTED,
    summary="Trigger aggregation for a data source",
)
async def trigger_aggregation(
    ds_id: str,
    request: Request,
    response: Response,
    svc=Depends(_get_svc),
    session: AsyncSession = Depends(get_db_session),
    trigger_source: str = Query("manual", alias="triggerSource"),
):
    if _PROXY_ENABLED:
        body = await request.body()
        return await _proxy(
            "POST",
            f"/aggregation/data-sources/{ds_id}/jobs?triggerSource={trigger_source}",
            request,
            body=body,
        )

    AggregationTriggerRequest, _, _, ConflictError, NotFoundError = _direct_imports()
    import json
    body_data = json.loads(await request.body())
    body = AggregationTriggerRequest(**body_data)
    try:
        job = await svc.trigger(ds_id, body, trigger_source, session)
        response.headers["Location"] = (
            f"/api/v1/admin/data-sources/{ds_id}/aggregation-jobs/{job.id}"
        )
        return job
    except ConflictError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except NotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))


# ── GET /data-sources/{ds_id}/readiness ─────────────────────────────

@router.get("/data-sources/{ds_id}/readiness", summary="Get aggregation readiness")
async def get_readiness(
    ds_id: str,
    request: Request,
    svc=Depends(_get_svc),
    session: AsyncSession = Depends(get_db_session),
):
    if _PROXY_ENABLED:
        return await _proxy("GET", f"/aggregation/data-sources/{ds_id}/readiness", request)
    _, _, _, _, NotFoundError = _direct_imports()
    try:
        return await svc.get_readiness(ds_id, session)
    except NotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))


# ── GET /data-sources/{ds_id}/aggregation-jobs ──────────────────────

@router.get("/data-sources/{ds_id}/aggregation-jobs", summary="List aggregation jobs")
async def list_jobs(
    ds_id: str,
    request: Request,
    svc=Depends(_get_svc),
    session: AsyncSession = Depends(get_db_session),
    job_status: Optional[str] = Query(None, alias="status"),
    limit: int = Query(20, ge=1, le=100),
):
    if _PROXY_ENABLED:
        return await _proxy("GET", f"/aggregation/data-sources/{ds_id}/jobs", request)
    _, _, _, _, NotFoundError = _direct_imports()
    try:
        return await svc.list_jobs(ds_id, session, status=job_status, limit=limit)
    except NotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))


# ── GET /data-sources/{ds_id}/aggregation-jobs/{job_id} ─────────────

@router.get("/data-sources/{ds_id}/aggregation-jobs/{job_id}", summary="Get job status")
async def get_job(
    ds_id: str,
    job_id: str,
    request: Request,
    svc=Depends(_get_svc),
    session: AsyncSession = Depends(get_db_session),
):
    if _PROXY_ENABLED:
        return await _proxy("GET", f"/aggregation/data-sources/{ds_id}/jobs/{job_id}", request)
    _, _, _, _, NotFoundError = _direct_imports()
    try:
        return await svc.get_job(ds_id, job_id, session)
    except NotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))


# ── POST .../resume ─────────────────────────────────────────────────

@router.post(
    "/data-sources/{ds_id}/aggregation-jobs/{job_id}/resume",
    status_code=status.HTTP_202_ACCEPTED,
    summary="Resume a failed aggregation job",
)
async def resume_job(
    ds_id: str,
    job_id: str,
    request: Request,
    svc=Depends(_get_svc),
    session: AsyncSession = Depends(get_db_session),
    overrides: ResumeOverrides | None = Body(default=None),
):
    if _PROXY_ENABLED:
        # Forward the (possibly empty) body so the Control Plane can
        # apply the same overrides. body() returns b"" when no body
        # was sent — _proxy treats that as no content.
        body = await request.body()
        return await _proxy(
            "POST",
            f"/aggregation/data-sources/{ds_id}/jobs/{job_id}/resume",
            request,
            body=body if body else None,
        )
    _, _, _, _, NotFoundError = _direct_imports()
    try:
        return await svc.resume(ds_id, job_id, session, overrides=overrides)
    except NotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


# ── POST .../cancel ─────────────────────────────────────────────────

@router.post(
    "/data-sources/{ds_id}/aggregation-jobs/{job_id}/cancel",
    summary="Cancel an aggregation job",
)
async def cancel_job(
    ds_id: str,
    job_id: str,
    request: Request,
    svc=Depends(_get_svc),
    session: AsyncSession = Depends(get_db_session),
):
    if _PROXY_ENABLED:
        return await _proxy("POST", f"/aggregation/data-sources/{ds_id}/jobs/{job_id}/cancel", request)
    _, _, _, _, NotFoundError = _direct_imports()
    try:
        return await svc.cancel(ds_id, job_id, session)
    except NotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


# ── DELETE /aggregation-jobs/{job_id} ───────────────────────────────

@router.delete(
    "/aggregation-jobs/{job_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a terminal aggregation job",
)
async def delete_job(
    job_id: str,
    request: Request,
    svc=Depends(_get_svc),
    session: AsyncSession = Depends(get_db_session),
):
    if _PROXY_ENABLED:
        return await _proxy("DELETE", f"/aggregation/jobs/{job_id}", request)
    _, _, _, _, NotFoundError = _direct_imports()
    try:
        await svc.delete_job(job_id, session)
    except NotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


# ── POST /data-sources/{ds_id}/purge-aggregation ───────────────────

@router.post(
    "/data-sources/{ds_id}/purge-aggregation",
    status_code=status.HTTP_202_ACCEPTED,
    summary="Purge aggregated edges (asynchronous)",
)
async def purge_aggregation(
    ds_id: str,
    request: Request,
    response: Response,
    svc=Depends(_get_svc),
    session: AsyncSession = Depends(get_db_session),
):
    """Queue a purge job. Returns 202 with the job row immediately; the
    actual ``MATCH ... DELETE`` runs as a regular insights-service
    Redis Streams job, which gets us retry, DLQ, and crash recovery
    via XAUTOCLAIM (a FastAPI ``BackgroundTasks`` would die on
    rolling restart and leave the job stuck in ``running``).

    Frontend polls the returned ``jobId`` via the standard
    aggregation-jobs endpoints (Job History UI handles this).
    """
    if _PROXY_ENABLED:
        return await _proxy("POST", f"/aggregation/data-sources/{ds_id}/purge", request)

    from backend.insights_service.enqueue import enqueue_purge_job_safe

    _, _, _, ConflictError, NotFoundError = _direct_imports()
    try:
        job = await svc.claim_purge_job(ds_id, session)
    except NotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ConflictError as e:
        raise HTTPException(status_code=409, detail=str(e))

    # Hand the job off to the insights worker. Redis-down → enqueue
    # returns None and the row stays ``pending``; an operator can
    # redrive from Job History without losing the audit record.
    await enqueue_purge_job_safe(job.id, ds_id, job.workspace_id)

    response.headers["Location"] = (
        f"/api/v1/admin/data-sources/{ds_id}/aggregation-jobs/{job.id}"
    )
    return {
        "deletedEdges": 0,
        "dataSourceId": ds_id,
        "jobId": job.id,
        "status": "pending",
    }


# ── POST /data-sources/{ds_id}/skip-aggregation ────────────────────

@router.post("/data-sources/{ds_id}/skip-aggregation", summary="Skip aggregation")
async def skip_aggregation(
    ds_id: str,
    request: Request,
    svc=Depends(_get_svc),
    session: AsyncSession = Depends(get_db_session),
):
    if _PROXY_ENABLED:
        body = await request.body()
        return await _proxy("POST", f"/aggregation/data-sources/{ds_id}/skip", request, body=body)
    AggregationTriggerRequest, AggregationSkipRequest, _, _, NotFoundError = _direct_imports()
    import json
    body_data = json.loads(await request.body())
    body = AggregationSkipRequest(**body_data)
    try:
        return await svc.skip(ds_id, body, session)
    except NotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


# ── PUT /data-sources/{ds_id}/aggregation-schedule ──────────────────

@router.put(
    "/data-sources/{ds_id}/aggregation-schedule",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Set aggregation schedule",
)
async def set_schedule(
    ds_id: str,
    request: Request,
    svc=Depends(_get_svc),
    session: AsyncSession = Depends(get_db_session),
):
    if _PROXY_ENABLED:
        body = await request.body()
        return await _proxy("PUT", f"/aggregation/data-sources/{ds_id}/schedule", request, body=body)
    _, _, AggregationScheduleRequest, _, NotFoundError = _direct_imports()
    import json
    body_data = json.loads(await request.body())
    body = AggregationScheduleRequest(**body_data)
    try:
        await svc.set_schedule(ds_id, body.cron_expression, session)
    except NotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))


# ── GET /data-sources/{ds_id}/check-drift ──────────────────────────

@router.get("/data-sources/{ds_id}/check-drift", summary="Check for graph drift")
async def check_drift(
    ds_id: str,
    request: Request,
    svc=Depends(_get_svc),
    session: AsyncSession = Depends(get_db_session),
):
    if _PROXY_ENABLED:
        return await _proxy("GET", f"/aggregation/data-sources/{ds_id}/drift", request)
    _, _, _, _, NotFoundError = _direct_imports()
    try:
        return await svc.check_drift(ds_id, session)
    except NotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
