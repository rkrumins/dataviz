"""
Thin FastAPI adapter for the aggregation service.

This is the ONLY monolith file that imports FROM the aggregation package.
It translates HTTP request/response to domain service calls.
"""
import logging
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.engine import get_db_session
from backend.app.services.aggregation import (
    AggregationService,
    AggregationTriggerRequest,
    AggregationSkipRequest,
    AggregationScheduleRequest,
    AggregationJobResponse,
    PaginatedJobsResponse,
    DataSourceReadinessResponse,
    DriftCheckResponse,
)
from backend.app.services.aggregation.service import ConflictError, NotFoundError

logger = logging.getLogger(__name__)

router = APIRouter()


# ── Dependency: extract AggregationService from app.state ────────────

def get_aggregation_service(request: Request) -> AggregationService:
    """FastAPI dependency — retrieves the AggregationService singleton from app.state."""
    svc = getattr(request.app.state, "aggregation_service", None)
    if svc is None:
        raise HTTPException(
            status_code=503,
            detail="Aggregation service is not available. The server may still be starting up.",
        )
    return svc


# ── GET /aggregation-jobs/summary ────────────────────────────────────

@router.get(
    "/aggregation-jobs/summary",
    summary="Get aggregation job summary stats (KPIs)",
)
async def get_jobs_summary(
    svc: AggregationService = Depends(get_aggregation_service),
    session: AsyncSession = Depends(get_db_session),
):
    """Return aggregate stats: total count, counts by status, success rate, avg duration."""
    return await svc.get_jobs_summary(session)


# ── GET /aggregation-jobs (global, cross-workspace) ─────────────────

@router.get(
    "/aggregation-jobs",
    response_model=PaginatedJobsResponse,
    summary="List all aggregation jobs (global, cross-workspace)",
)
async def list_jobs_global(
    svc: AggregationService = Depends(get_aggregation_service),
    session: AsyncSession = Depends(get_db_session),
    job_status: Optional[List[str]] = Query(None, alias="status"),
    workspace_id: Optional[str] = Query(None, alias="workspaceId"),
    data_source_id: Optional[List[str]] = Query(None, alias="dataSourceId"),
    projection_mode: Optional[str] = Query(None, alias="projectionMode"),
    trigger_source: Optional[str] = Query(None, alias="triggerSource"),
    date_from: Optional[str] = Query(None, alias="dateFrom"),
    date_to: Optional[str] = Query(None, alias="dateTo"),
    limit: int = Query(25, ge=1, le=100),
    offset: int = Query(0, ge=0),
):
    """List aggregation jobs across all data sources and workspaces with filtering."""
    return await svc.list_jobs_global(
        session,
        status=job_status,
        workspace_id=workspace_id,
        data_source_ids=data_source_id,
        projection_mode=projection_mode,
        trigger_source=trigger_source,
        date_from=date_from,
        date_to=date_to,
        limit=limit,
        offset=offset,
    )


# ── POST /data-sources/{ds_id}/aggregation-jobs ──────────────────────

@router.post(
    "/data-sources/{ds_id}/aggregation-jobs",
    response_model=AggregationJobResponse,
    status_code=status.HTTP_202_ACCEPTED,
    summary="Trigger aggregation for a data source",
)
async def trigger_aggregation(
    ds_id: str,
    body: AggregationTriggerRequest,
    response: Response,
    svc: AggregationService = Depends(get_aggregation_service),
    session: AsyncSession = Depends(get_db_session),
    trigger_source: str = Query("manual", alias="triggerSource"),
):
    """Create a new aggregation job and dispatch it to the worker.

    Returns 202 Accepted with the job in 'pending' status.
    Returns 409 Conflict if a job is already active for this data source.
    Returns 422 if no ontology is assigned.
    """
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


# ── GET /data-sources/{ds_id}/readiness ──────────────────────────────

@router.get(
    "/data-sources/{ds_id}/readiness",
    response_model=DataSourceReadinessResponse,
    summary="Get aggregation readiness status",
)
async def get_readiness(
    ds_id: str,
    svc: AggregationService = Depends(get_aggregation_service),
    session: AsyncSession = Depends(get_db_session),
):
    """Check if a data source is ready for view creation."""
    try:
        return await svc.get_readiness(ds_id, session)
    except NotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))


# ── GET /data-sources/{ds_id}/aggregation-jobs ───────────────────────

@router.get(
    "/data-sources/{ds_id}/aggregation-jobs",
    response_model=list[AggregationJobResponse],
    summary="List aggregation jobs",
)
async def list_jobs(
    ds_id: str,
    svc: AggregationService = Depends(get_aggregation_service),
    session: AsyncSession = Depends(get_db_session),
    job_status: Optional[str] = Query(None, alias="status"),
    limit: int = Query(20, ge=1, le=100),
):
    """List aggregation jobs for a data source, newest first."""
    try:
        return await svc.list_jobs(ds_id, session, status=job_status, limit=limit)
    except NotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))


# ── GET /data-sources/{ds_id}/aggregation-jobs/{job_id} ──────────────

@router.get(
    "/data-sources/{ds_id}/aggregation-jobs/{job_id}",
    response_model=AggregationJobResponse,
    summary="Get aggregation job status",
)
async def get_job(
    ds_id: str,
    job_id: str,
    svc: AggregationService = Depends(get_aggregation_service),
    session: AsyncSession = Depends(get_db_session),
):
    """Get the current status of a specific aggregation job."""
    try:
        return await svc.get_job(ds_id, job_id, session)
    except NotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))


# ── POST /data-sources/{ds_id}/aggregation-jobs/{job_id}/resume ──────

@router.post(
    "/data-sources/{ds_id}/aggregation-jobs/{job_id}/resume",
    response_model=AggregationJobResponse,
    status_code=status.HTTP_202_ACCEPTED,
    summary="Resume a failed aggregation job",
)
async def resume_job(
    ds_id: str,
    job_id: str,
    svc: AggregationService = Depends(get_aggregation_service),
    session: AsyncSession = Depends(get_db_session),
):
    """Resume a failed job from its last checkpoint."""
    try:
        return await svc.resume(ds_id, job_id, session)
    except NotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


# ── POST /data-sources/{ds_id}/aggregation-jobs/{job_id}/cancel ──────

@router.post(
    "/data-sources/{ds_id}/aggregation-jobs/{job_id}/cancel",
    response_model=AggregationJobResponse,
    summary="Cancel an aggregation job",
)
async def cancel_job(
    ds_id: str,
    job_id: str,
    svc: AggregationService = Depends(get_aggregation_service),
    session: AsyncSession = Depends(get_db_session),
):
    """Cancel a pending or running aggregation job."""
    try:
        return await svc.cancel(ds_id, job_id, session)
    except NotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


# ── DELETE /aggregation-jobs/{job_id} ────────────────────────────────

@router.delete(
    "/aggregation-jobs/{job_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a terminal aggregation job from history",
)
async def delete_job(
    job_id: str,
    svc: AggregationService = Depends(get_aggregation_service),
    session: AsyncSession = Depends(get_db_session),
):
    """Delete a completed, failed, or cancelled job record.

    Returns 422 if the job is still pending or running.
    """
    try:
        await svc.delete_job(job_id, session)
    except NotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


# ── POST /data-sources/{ds_id}/purge-aggregation ────────────────────

@router.post(
    "/data-sources/{ds_id}/purge-aggregation",
    summary="Remove all aggregated edges for a data source",
)
async def purge_aggregation(
    ds_id: str,
    svc: AggregationService = Depends(get_aggregation_service),
    session: AsyncSession = Depends(get_db_session),
):
    """Purge all materialized AGGREGATED edges from the graph.

    Returns 409 if an aggregation job is currently active.
    """
    try:
        return await svc.purge(ds_id, session)
    except NotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ConflictError as e:
        raise HTTPException(status_code=409, detail=str(e))


# ── POST /data-sources/{ds_id}/skip-aggregation ──────────────────────

@router.post(
    "/data-sources/{ds_id}/skip-aggregation",
    response_model=DataSourceReadinessResponse,
    summary="Skip aggregation for a data source",
)
async def skip_aggregation(
    ds_id: str,
    body: AggregationSkipRequest,
    svc: AggregationService = Depends(get_aggregation_service),
    session: AsyncSession = Depends(get_db_session),
):
    """Skip aggregation — enables view creation without aggregated edges.

    Requires confirmed=true in the request body.
    """
    try:
        return await svc.skip(ds_id, body, session)
    except NotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


# ── PUT /data-sources/{ds_id}/aggregation-schedule ───────────────────

@router.put(
    "/data-sources/{ds_id}/aggregation-schedule",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Set aggregation schedule",
)
async def set_schedule(
    ds_id: str,
    body: AggregationScheduleRequest,
    svc: AggregationService = Depends(get_aggregation_service),
    session: AsyncSession = Depends(get_db_session),
):
    """Set or clear the aggregation check schedule (cron expression).

    Pass null cronExpression to disable scheduling.
    """
    try:
        await svc.set_schedule(ds_id, body.cron_expression, session)
    except NotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))


# ── GET /data-sources/{ds_id}/check-drift ────────────────────────────

@router.get(
    "/data-sources/{ds_id}/check-drift",
    response_model=DriftCheckResponse,
    summary="Check for graph drift",
)
async def check_drift(
    ds_id: str,
    svc: AggregationService = Depends(get_aggregation_service),
    session: AsyncSession = Depends(get_db_session),
):
    """Check if the underlying graph has changed since last aggregation."""
    try:
        return await svc.check_drift(ds_id, session)
    except NotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
