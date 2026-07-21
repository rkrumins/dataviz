"""
Aggregation Control Plane — standalone FastAPI process.

Owns the aggregation API surface, job lifecycle, scheduling, crash
recovery, and drift detection. Dispatches job execution to Workers
(Data Plane) via Redis Streams.  Does NOT run any Worker logic —
heavy FalkorDB MERGE operations happen exclusively in the Workers.

Entry point:
    python -m backend.app.services.aggregation.controlplane

    or via uvicorn:
    uvicorn backend.app.services.aggregation.controlplane:app --port 8091

Architecture:
    - OWN ProviderManager with SHORT timeouts (5s) for drift checks and
      readiness probes. A slow FalkorDB returns degraded status rather
      than blocking the API.
    - OWN Postgres session factory (JOBS pool) for job state queries.
    - RedisStreamDispatcher for job dispatch to workers.
    - AggregationScheduler for periodic drift detection.
    - Crash recovery on startup (re-dispatches interrupted jobs).

Environment variables:
    MANAGEMENT_DB_URL          Postgres connection string (required)
    REDIS_URL                  Redis broker URL (default: redis://localhost:6380/0)
    FALKORDB_HOST              FalkorDB host (default: localhost)
    FALKORDB_PORT              FalkorDB port (default: 6379)
    FALKORDB_SOCKET_TIMEOUT    Socket timeout (default: 5 — short for API responsiveness)
    AGGREGATION_API_PORT       HTTP port (default: 8091)
    LOG_LEVEL                  Logging level (default: INFO)
"""
import asyncio
import json as _json
import logging
import os
from contextlib import asynccontextmanager
from typing import List, Optional, Tuple

from fastapi import (
    Body, Depends, FastAPI, HTTPException, Query, Request, Response, status,
)
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .internal_auth import log_auth_mode, require_internal_token

logger = logging.getLogger(__name__)

# Control Plane uses SHORT FalkorDB timeout — API responsiveness > completeness.
# Drift checks and readiness probes that hit FalkorDB will timeout quickly
# and return a degraded response rather than blocking.
if "FALKORDB_SOCKET_TIMEOUT" not in os.environ:
    os.environ["FALKORDB_SOCKET_TIMEOUT"] = "5"

# Small connection pools — Control Plane only does lightweight reads,
# not heavy MERGE operations.
if "FALKORDB_GRAPH_POOL_SIZE" not in os.environ:
    os.environ["FALKORDB_GRAPH_POOL_SIZE"] = "4"
if "FALKORDB_REDIS_POOL_SIZE" not in os.environ:
    os.environ["FALKORDB_REDIS_POOL_SIZE"] = "4"
# The provider cache client now sizes its pool from the central CACHE role
# (REDIS_CACHE_MAX_CONNECTIONS), not FALKORDB_REDIS_POOL_SIZE — mirror the
# same small-pool default there.
if "REDIS_CACHE_MAX_CONNECTIONS" not in os.environ:
    os.environ["REDIS_CACHE_MAX_CONNECTIONS"] = "4"


# ── Lifespan ────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Control Plane startup / shutdown lifecycle."""
    from backend.app.db.engine import close_db, get_jobs_session
    from backend.app.providers.manager import ProviderManager
    from .service import AggregationService
    from .dispatcher import RedisStreamDispatcher
    from .scheduler import AggregationScheduler
    from .redis_client import get_redis, close_redis
    from .db_init import init_aggregation_db

    logging.basicConfig(
        level=getattr(logging, os.getenv("LOG_LEVEL", "INFO")),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    logger.info("=== Aggregation Control Plane starting ===")
    log_auth_mode()

    # 1. Initialize aggregation DB (schema + tables, no Alembic needed)
    await init_aggregation_db()

    # 2. ProviderManager with short timeouts for drift/readiness
    registry = ProviderManager()

    # 3. Redis dispatcher
    redis_client = get_redis()
    dispatcher = RedisStreamDispatcher(redis_client)

    # 4. Ontology service (for monolith-mode resolution during trigger)
    ontology_svc = None
    try:
        from backend.app.ontology.adapters.sqlalchemy_repo import SQLAlchemyOntologyRepository
        from backend.app.ontology.service import LocalOntologyService
        ontology_svc = LocalOntologyService(
            SQLAlchemyOntologyRepository(None)
        )
    except Exception:
        logger.warning("Ontology service not available — will use DB fallback")

    # 5. AggregationService
    svc = AggregationService(
        dispatcher=dispatcher,
        registry=registry,
        session_factory=get_jobs_session,
        ontology_service=ontology_svc,
    )
    from .service import set_active_service
    set_active_service(svc)

    # 6. Crash recovery — OFF the startup critical path. It re-dispatches
    # interrupted jobs with a per-job exponential backoff sleep, which can
    # take minutes. Awaiting it here would delay the lifespan `yield`, so
    # uvicorn would not serve `/health` and the Docker healthcheck would
    # never pass. Run it as a background task instead.
    async def _run_crash_recovery() -> None:
        try:
            recovered = await svc.recover_interrupted_jobs()
            if recovered:
                logger.info("Recovered %d interrupted aggregation jobs", recovered)
        except Exception as e:
            logger.warning("Crash recovery failed: %s", e)

    recovery_task = asyncio.create_task(_run_crash_recovery())

    # 7. Start scheduler (drift detection). With the job-bus Redis in
    # hand its stale-job watchdog stands down in favor of the reconciler.
    scheduler = AggregationScheduler(
        get_jobs_session, registry, redis_client=redis_client,
    )
    scheduler_task = asyncio.create_task(scheduler.start())
    logger.info("Aggregation scheduler started")

    # 8. Stuck-job reconciler — the control plane is its home in the
    # split topology. Workers ACK stream messages BEFORE executing
    # (crash recovery is THIS loop's lock-aware re-dispatch, not stream
    # redelivery), so without it a dead worker's job stayed 'running'
    # forever with no auto-resume. The sweep's advisory lock keeps a
    # dev-role monolith or HA replicas from double-running it.
    from .reconciler import run_reconciler
    reconciler_shutdown = asyncio.Event()
    reconciler_task = asyncio.create_task(
        run_reconciler(get_jobs_session, reconciler_shutdown, redis_client),
        name="aggregation-stuck-job-reconciler",
    )
    logger.info("Stuck-job reconciler started")

    # 9. State-sync consumer (WS1.2). Projects aggregation status events
    # from the events stream into public.workspace_data_sources (the
    # viz-service's local read hint) and invalidates aggregated-read
    # caches. Lives HERE, not in the web tier: a consumer group delivers
    # each event to exactly ONE consumer, so scaling the stateless web
    # tier no longer multiplies the same row write. It is lightweight I/O
    # (a small UPDATE + cache DEL per event), so it sits comfortably beside
    # the readiness/drift API — well away from the heavy FalkorDB MERGE
    # work that is isolated in the worker fleet.
    from .event_listener import AggregationEventListener
    state_sync = AggregationEventListener(
        redis_client=redis_client, session_factory=get_jobs_session,
    )
    state_sync_task = asyncio.create_task(
        state_sync.start(), name="aggregation-state-sync",
    )
    logger.info("Aggregation state-sync consumer started")

    # Store in app state
    app.state.aggregation_service = svc
    app.state.session_factory = get_jobs_session

    port = os.getenv("AGGREGATION_API_PORT", "8091")
    logger.info("=== Aggregation Control Plane ready (port %s) ===", port)

    yield

    # Shutdown
    reconciler_shutdown.set()
    if not reconciler_task.done():
        try:
            await asyncio.wait_for(reconciler_task, timeout=2.0)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            reconciler_task.cancel()
    await state_sync.stop()
    state_sync_task.cancel()
    try:
        await state_sync_task
    except asyncio.CancelledError:
        pass
    await scheduler.stop()
    scheduler_task.cancel()
    recovery_task.cancel()
    try:
        await asyncio.wait_for(registry.evict_all(), timeout=5)
    except asyncio.TimeoutError:
        logger.warning("Provider shutdown timed out")
    await close_redis()
    await close_db()
    logger.info("=== Aggregation Control Plane stopped ===")


# ── App ─────────────────────────────────────────────────────────────

app = FastAPI(
    title="Aggregation Control Plane",
    description="Aggregation job lifecycle, scheduling, and status API.",
    version="0.1.0",
    lifespan=lifespan,
    # Internal service auth on every route except the exempt set (health +
    # docs). No-op when AGGREGATION_INTERNAL_TOKEN is unset, so a dev stack
    # with no token configured keeps working (see internal_auth.py).
    dependencies=[Depends(require_internal_token)],
)


# ── Dependencies ────────────────────────────────────────────────────

def _get_svc(request: Request):
    """FastAPI dependency — retrieves AggregationService from app.state."""
    from .service import AggregationService
    svc = getattr(request.app.state, "aggregation_service", None)
    if svc is None:
        raise HTTPException(
            status_code=503,
            detail="Aggregation service is not available. The server may still be starting up.",
        )
    return svc


async def _get_session(request: Request):
    """FastAPI dependency — yields a DB session from the JOBS pool."""
    session_factory = getattr(request.app.state, "session_factory", None)
    if session_factory is None:
        raise HTTPException(status_code=503, detail="Database not available")
    async with session_factory() as session:
        yield session


# ── Schemas (import here to avoid circular) ─────────────────────────

from .schemas import (  # noqa: E402
    AggregationTriggerRequest,
    AggregationSettingsRequest,
    AggregationSettingsResponse,
    AggregationSkipRequest,
    AggregationScheduleRequest,
    AggregationJobResponse,
    BatchRefreshRequestInternal,
    BatchStatus,
    FreshnessDoc,
    PaginatedJobsResponse,
    DataSourceReadinessResponse,
    DriftCheckResponse,
    FreshnessSettingsRequest,
    FreshnessSettingsResponse,
    RefreshRequestInternal,
    RefreshResponse,
    ResumeOverrides,
    SourceChangedRequest,
    SourceChangedResponse,
    WorkersResponse,
)
from .service import ConflictError, NotFoundError  # noqa: E402


# ── Health ──────────────────────────────────────────────────────────

@app.get("/health", tags=["health"])
async def health():
    """Health check for K8s liveness/readiness probes."""
    return {"status": "healthy", "role": "aggregation-controlplane"}


# ── GET /aggregation/jobs/summary ───────────────────────────────────

@app.get("/aggregation/jobs/summary", summary="Job summary KPIs")
async def get_jobs_summary(
    svc=Depends(_get_svc),
    session: AsyncSession = Depends(_get_session),
):
    return await svc.get_jobs_summary(session)


# ── GET /aggregation/jobs (global, cross-workspace) ─────────────────

@app.get(
    "/aggregation/jobs",
    response_model=PaginatedJobsResponse,
    summary="List all jobs (global)",
)
async def list_jobs_global(
    svc=Depends(_get_svc),
    session: AsyncSession = Depends(_get_session),
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


# ── POST /aggregation/data-sources/{ds_id}/jobs ─────────────────────

@app.post(
    "/aggregation/data-sources/{ds_id}/jobs",
    response_model=AggregationJobResponse,
    status_code=status.HTTP_202_ACCEPTED,
    summary="Trigger aggregation",
)
async def trigger_aggregation(
    ds_id: str,
    body: AggregationTriggerRequest,
    response: Response,
    svc=Depends(_get_svc),
    session: AsyncSession = Depends(_get_session),
    trigger_source: str = Query("manual", alias="triggerSource"),
):
    try:
        job = await svc.trigger(ds_id, body, trigger_source, session)
        response.headers["Location"] = (
            f"/aggregation/data-sources/{ds_id}/jobs/{job.id}"
        )
        return job
    except ConflictError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except NotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))


# ── GET /aggregation/data-sources/{ds_id}/readiness ──────────────────

@app.get(
    "/aggregation/data-sources/{ds_id}/readiness",
    response_model=DataSourceReadinessResponse,
    summary="Get aggregation readiness",
)
async def get_readiness(
    ds_id: str,
    svc=Depends(_get_svc),
    session: AsyncSession = Depends(_get_session),
):
    try:
        return await svc.get_readiness(ds_id, session)
    except NotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))


# ── GET /aggregation/data-sources/{ds_id}/jobs ───────────────────────

@app.get(
    "/aggregation/data-sources/{ds_id}/jobs",
    response_model=list[AggregationJobResponse],
    summary="List jobs for a data source",
)
async def list_jobs(
    ds_id: str,
    svc=Depends(_get_svc),
    session: AsyncSession = Depends(_get_session),
    job_status: Optional[str] = Query(None, alias="status"),
    limit: int = Query(20, ge=1, le=100),
):
    try:
        return await svc.list_jobs(ds_id, session, status=job_status, limit=limit)
    except NotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))


# ── GET /aggregation/data-sources/{ds_id}/jobs/{job_id} ─────────────

@app.get(
    "/aggregation/data-sources/{ds_id}/jobs/{job_id}",
    response_model=AggregationJobResponse,
    summary="Get job status",
)
async def get_job(
    ds_id: str,
    job_id: str,
    svc=Depends(_get_svc),
    session: AsyncSession = Depends(_get_session),
):
    try:
        return await svc.get_job(ds_id, job_id, session)
    except NotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))


# ── POST /aggregation/data-sources/{ds_id}/jobs/{job_id}/resume ──────

@app.post(
    "/aggregation/data-sources/{ds_id}/jobs/{job_id}/resume",
    response_model=AggregationJobResponse,
    status_code=status.HTTP_202_ACCEPTED,
    summary="Resume a failed job",
)
async def resume_job(
    ds_id: str,
    job_id: str,
    overrides: Optional[ResumeOverrides] = Body(default=None),
    svc=Depends(_get_svc),
    session: AsyncSession = Depends(_get_session),
):
    # The overrides body was previously dropped here, so resume tunables
    # (timeout / retries / tuning) silently never applied in proxy
    # deployments — accept and forward it.
    try:
        return await svc.resume(ds_id, job_id, session, overrides=overrides)
    except NotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


# ── POST /aggregation/data-sources/{ds_id}/jobs/{job_id}/cancel ──────

@app.post(
    "/aggregation/data-sources/{ds_id}/jobs/{job_id}/cancel",
    response_model=AggregationJobResponse,
    summary="Cancel a job",
)
async def cancel_job(
    ds_id: str,
    job_id: str,
    svc=Depends(_get_svc),
    session: AsyncSession = Depends(_get_session),
):
    try:
        return await svc.cancel(ds_id, job_id, session)
    except NotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


# ── DELETE /aggregation/jobs/{job_id} ────────────────────────────────

@app.delete(
    "/aggregation/jobs/{job_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a terminal job",
)
async def delete_job(
    job_id: str,
    svc=Depends(_get_svc),
    session: AsyncSession = Depends(_get_session),
):
    try:
        await svc.delete_job(job_id, session)
    except NotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


# ── POST /aggregation/data-sources/{ds_id}/purge ────────────────────

@app.post(
    "/aggregation/data-sources/{ds_id}/purge",
    status_code=status.HTTP_202_ACCEPTED,
    summary="Purge aggregated edges (asynchronous)",
)
async def purge_aggregation(
    ds_id: str,
    response: Response,
    svc=Depends(_get_svc),
    session: AsyncSession = Depends(_get_session),
    skip_reaggregate: bool = Query(False, alias="skipReaggregate"),
):
    """Claim a purge slot and hand off to the insights-service worker.
    The provider DELETE runs as a Redis Streams job with retry, DLQ,
    and crash recovery (see ``backend/insights_service/purge.py``)."""
    from backend.insights_service.enqueue import enqueue_purge_job_safe

    try:
        job = await svc.claim_purge_job(
            ds_id, session, skip_reaggregate=skip_reaggregate,
        )
    except NotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ConflictError as e:
        raise HTTPException(status_code=409, detail=str(e))

    await enqueue_purge_job_safe(job.id, ds_id, job.workspace_id)
    response.headers["Location"] = (
        f"/aggregation/data-sources/{ds_id}/jobs/{job.id}"
    )
    return {
        "deletedEdges": 0,
        "dataSourceId": ds_id,
        "jobId": job.id,
        "status": "pending",
    }


# ── POST /aggregation/data-sources/{ds_id}/skip ─────────────────────

@app.post(
    "/aggregation/data-sources/{ds_id}/skip",
    response_model=DataSourceReadinessResponse,
    summary="Skip aggregation",
)
async def skip_aggregation(
    ds_id: str,
    body: AggregationSkipRequest,
    svc=Depends(_get_svc),
    session: AsyncSession = Depends(_get_session),
):
    try:
        return await svc.skip(ds_id, body, session)
    except NotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


# ── GET/PUT /aggregation/settings — global tuning defaults ──────────

@app.get(
    "/aggregation/settings",
    response_model=AggregationSettingsResponse,
    summary="Get global aggregation tuning defaults",
)
async def get_settings(
    svc=Depends(_get_svc),
    session: AsyncSession = Depends(_get_session),
):
    return await svc.get_settings(session)


@app.put(
    "/aggregation/settings",
    response_model=AggregationSettingsResponse,
    summary="Replace global aggregation tuning defaults",
)
async def put_settings(
    body: AggregationSettingsRequest,
    svc=Depends(_get_svc),
    session: AsyncSession = Depends(_get_session),
):
    return await svc.put_settings(session, body.tuning, cadence=body.cadence)


# ── GET /aggregation/workers — worker fleet + queue depth ───────────

@app.get(
    "/aggregation/workers",
    response_model=WorkersResponse,
    summary="List live aggregation workers and job-queue depth",
)
async def list_workers():
    from .fleet import read_fleet

    return await read_fleet()


# ── PUT /aggregation/data-sources/{ds_id}/schedule ───────────────────

@app.put(
    "/aggregation/data-sources/{ds_id}/schedule",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Set aggregation schedule",
)
async def set_schedule(
    ds_id: str,
    body: AggregationScheduleRequest,
    svc=Depends(_get_svc),
    session: AsyncSession = Depends(_get_session),
):
    try:
        await svc.set_schedule(ds_id, body.cron_expression, session)
    except NotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))


# ── PATCH /aggregation/data-sources/{ds_id}/freshness-settings ────────

@app.patch(
    "/aggregation/data-sources/{ds_id}/freshness-settings",
    response_model=FreshnessSettingsResponse,
    summary="Set or clear a data source's rebuild-cadence override",
)
async def set_freshness_settings(
    ds_id: str,
    body: FreshnessSettingsRequest,
    svc=Depends(_get_svc),
    session: AsyncSession = Depends(_get_session),
):
    try:
        stored = await svc.set_source_rebuild_interval(
            ds_id, body.rebuild_min_interval_secs, session,
        )
    except NotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return FreshnessSettingsResponse(
        data_source_id=ds_id, rebuild_min_interval_secs=stored,
    )


# ── GET /aggregation/data-sources/{ds_id}/drift ──────────────────────

@app.get(
    "/aggregation/data-sources/{ds_id}/drift",
    response_model=DriftCheckResponse,
    summary="Check for graph drift",
)
async def check_drift(
    ds_id: str,
    svc=Depends(_get_svc),
    session: AsyncSession = Depends(_get_session),
):
    try:
        return await svc.check_drift(ds_id, session)
    except NotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))


# ── POST /aggregation/data-sources/{ds_id}/source-changed ────────────

@app.post(
    "/aggregation/data-sources/{ds_id}/source-changed",
    response_model=SourceChangedResponse,
    summary="Signal that a source's graph changed (external direct load)",
)
async def source_changed(
    ds_id: str,
    body: SourceChangedRequest = Body(default=SourceChangedRequest()),
    svc=Depends(_get_svc),
    session: AsyncSession = Depends(_get_session),
):
    return await svc.signal_source_changed(
        ds_id, session, reason=body.reason, force=body.force,
    )


# ── POST /aggregation/data-sources/{ds_id}/refresh ───────────────────

@app.post(
    "/aggregation/data-sources/{ds_id}/refresh",
    response_model=RefreshResponse,
    summary="Unified refresh verb (auto | read-caches | rollups | full)",
)
async def refresh_source(
    ds_id: str,
    body: RefreshRequestInternal = Body(default=RefreshRequestInternal()),
    svc=Depends(_get_svc),
    session: AsyncSession = Depends(_get_session),
):
    """Twin of the viz-service refresh route. ``origin`` is caller-asserted
    (script | connector | api); the web proxy leaves it ``api`` and the
    loader script sends ``script``. ``actor`` is forwarded by the proxy (the
    authenticated user id) or defaults to ``internal`` for direct callers
    like the script."""
    try:
        return await svc.refresh_source(
            ds_id, session,
            scope=body.scope, force=body.force, reason=body.reason,
            actor=body.actor, origin=body.origin, wait=body.wait,
        )
    except NotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))


# ── GET /aggregation/data-sources/{ds_id}/freshness ──────────────────

@app.get(
    "/aggregation/data-sources/{ds_id}/freshness",
    response_model=FreshnessDoc,
    summary="Per-source freshness detail",
)
async def source_freshness(
    ds_id: str,
    probe: bool = Query(False),
    svc=Depends(_get_svc),
    session: AsyncSession = Depends(_get_session),
):
    """Per-source freshness assembly — runs HERE so the probe uses the
    Control Plane's short-timeout provider registry. 404 when unknown."""
    doc = await svc.assemble_source_freshness(ds_id, session, probe=probe)
    if doc is None:
        raise HTTPException(status_code=404, detail=f"Data source {ds_id!r} not found")
    return doc


# ── Guarded provider refresh batch (F5) + fleet-wide twin (G2) ───────
#
# Bounded fan-out of ``refresh_source`` over a set of live data sources.
# The runner is a fire-and-forget ``asyncio.create_task`` background job:
# the route acquires a single-flight lock and returns immediately with a
# ``batch_id``; ``GET .../refresh-batches/{batch_id}`` polls progress from
# the Redis hash the runner writes to. Batch linkage lives entirely in that
# hash — items are refreshed with the REQUESTED scope, never a synthetic
# "batch-item" scope forced through ``refresh_source``.
#
# G2 reuses this SAME runner for a fleet-wide batch over EVERY live data
# source across every provider — the only differences are how ``ds_ids``
# is enumerated (unscoped vs. one provider, see ``_live_ds_rows``) and the
# lock's scope id (``_FLEET_LOCK_SCOPE`` vs. a provider id). A fleet batch
# does NOT also acquire every per-provider lock — a fleet batch and a
# provider batch may legitimately overlap on the same source, and that's
# safe: ``refresh_source`` is idempotent-safe (``auto`` gates on the change
# signal, ``rollups`` collapses onto the active job's window).

_REFRESH_BATCH_TTL_SECS = 86400
_REFRESH_BATCH_LOCK_TTL_SECS = 3600
_REFRESH_BATCH_MAX_CONCURRENT = 4
_FLEET_LOCK_SCOPE = "__fleet__"


async def _run_provider_batch(
    batch_id: str,
    provider_id: str,
    ds_rows: List[Tuple[str, Optional[str]]],
    body: BatchRefreshRequestInternal,
    *,
    svc,
    session_factory,
    redis,
) -> None:
    """Background fan-out over ``ds_rows``. Semaphore-bounded concurrency;
    each item gets a FRESH session and its outcome is written to the batch
    hash as it finishes. An item's own exception is recorded as ``error``
    and never aborts the batch. The single-flight lock is released in
    ``finally`` so it cannot leak — even if something here crashes outright
    (not just an individual item failing).

    ``provider_id`` is really a generic lock-scope id: the per-provider
    route passes the real provider id, the fleet-wide route (G2) passes
    ``_FLEET_LOCK_SCOPE``. This function doesn't care which — it only uses
    it to name the lock key and tag the batch hash."""
    hash_key = f"refreshbatch:{batch_id}"
    lock_key = f"refreshbatch:lock:{provider_id}"
    try:
        await redis.hset(hash_key, mapping={
            "provider_id": provider_id, "state": "running",
            "total": len(ds_rows), "done": 0,
        })
        await redis.expire(hash_key, _REFRESH_BATCH_TTL_SECS)

        concurrency = min(max(body.max_concurrent, 1), _REFRESH_BATCH_MAX_CONCURRENT)
        sem = asyncio.Semaphore(concurrency)

        async def _run_one(ds_id: str, ds_name: Optional[str]) -> None:
            async with sem:
                # The try wraps the WHOLE session block, not just
                # refresh_source — the commit happens at the `async with`
                # __aexit__ (session_factory's _session_scope commits on
                # exit), so a commit failure (deadlock, dropped connection
                # under concurrent load) must be caught here too, or it
                # escapes _run_one, propagates through asyncio.gather, and
                # strands the batch at state "running" forever.
                try:
                    async with session_factory() as session:
                        resp = await svc.refresh_source(
                            ds_id, session,
                            scope=body.scope, force=body.force,
                            actor=body.actor, origin=body.origin,
                        )
                    item = {
                        "dataSourceId": ds_id, "name": ds_name, "outcome": "done",
                        "jobId": resp.job_id,
                        "actions": list(resp.actions or []),
                        "deferred": bool(resp.deferred),
                    }
                except Exception as exc:
                    logger.warning(
                        "refresh batch %s: item %s failed: %s", batch_id, ds_id, exc,
                    )
                    item = {
                        "dataSourceId": ds_id, "name": ds_name, "outcome": "error",
                        "jobId": None, "actions": [], "deferred": False,
                    }
            await redis.hset(hash_key, f"ds:{ds_id}", _json.dumps(item))
            await redis.hincrby(hash_key, "done", 1)

        await asyncio.gather(*(_run_one(d, n) for d, n in ds_rows))
        await redis.hset(hash_key, "state", "done")
    finally:
        await redis.delete(lock_key)


async def _live_ds_rows(
    session: AsyncSession, *, provider_id: Optional[str] = None,
) -> List[Tuple[str, Optional[str]]]:
    """(id, label) of every live (non-tombstoned) data source — the same
    ``deleted_at IS NULL`` base filter ``assemble_fleet_freshness`` applies
    for the freshness cockpit read. The label rides along so batch results
    can name a source without a second query per item."""
    from backend.app.db.models import WorkspaceDataSourceORM

    q = select(
        WorkspaceDataSourceORM.id, WorkspaceDataSourceORM.label,
    ).where(WorkspaceDataSourceORM.deleted_at.is_(None))
    if provider_id is not None:
        q = q.where(WorkspaceDataSourceORM.provider_id == provider_id)
    rows = await session.execute(q.order_by(WorkspaceDataSourceORM.id))
    return [(r[0], r[1]) for r in rows.all()]


async def _start_guarded_batch(
    scope_id: str,
    ds_rows: List[Tuple[str, Optional[str]]],
    body: BatchRefreshRequestInternal,
    *,
    request: Request,
    svc,
    redis,
) -> BatchStatus:
    """Acquire the single-flight lock named for ``scope_id`` and schedule
    the shared runner over ``ds_rows``. Shared by the per-provider route
    (``scope_id`` = the provider id) and the fleet-wide route (``scope_id``
    = ``_FLEET_LOCK_SCOPE``) — the only difference between the two callers
    is how ``ds_rows`` was enumerated and which scope id is passed here."""
    lock_key = f"refreshbatch:lock:{scope_id}"
    got = await redis.set(lock_key, "1", nx=True, ex=_REFRESH_BATCH_LOCK_TTL_SECS)
    if not got:
        raise HTTPException(
            status_code=409,
            detail=f"A refresh batch is already running for {scope_id!r}",
        )

    from uuid import uuid4
    batch_id = uuid4().hex
    asyncio.create_task(
        _run_provider_batch(
            batch_id, scope_id, ds_rows, body,
            svc=svc, session_factory=request.app.state.session_factory, redis=redis,
        )
    )
    return BatchStatus(
        batch_id=batch_id, provider_id=scope_id,
        total=len(ds_rows), done=0, results=[], state="running",
    )


# ── POST /aggregation/providers/{provider_id}/refresh-batch ─────────

@app.post(
    "/aggregation/providers/{provider_id}/refresh-batch",
    response_model=BatchStatus,
    status_code=status.HTTP_202_ACCEPTED,
    summary="Guarded batch refresh across a provider's live data sources",
)
async def start_refresh_batch(
    provider_id: str,
    request: Request,
    body: BatchRefreshRequestInternal = Body(default=BatchRefreshRequestInternal()),
    svc=Depends(_get_svc),
    session: AsyncSession = Depends(_get_session),
):
    from backend.app.db.repositories.provider_repo import get_provider_orm
    from .redis_client import get_redis

    provider = await get_provider_orm(session, provider_id)
    if provider is None:
        raise HTTPException(status_code=404, detail=f"Provider {provider_id!r} not found")

    ds_rows = await _live_ds_rows(session, provider_id=provider_id)
    redis = get_redis()
    return await _start_guarded_batch(
        provider_id, ds_rows, body, request=request, svc=svc, redis=redis,
    )


# ── POST /aggregation/refresh-batch — fleet-wide twin (G2) ──────────

@app.post(
    "/aggregation/refresh-batch",
    response_model=BatchStatus,
    status_code=status.HTTP_202_ACCEPTED,
    summary="Guarded batch refresh across every live data source (fleet-wide)",
)
async def start_fleet_refresh_batch(
    request: Request,
    body: BatchRefreshRequestInternal = Body(default=BatchRefreshRequestInternal()),
    svc=Depends(_get_svc),
    session: AsyncSession = Depends(_get_session),
):
    """Fleet-wide twin of ``start_refresh_batch`` — same runner, same
    per-item isolation, but enumerated across EVERY provider's live data
    sources rather than one provider's. Guarded by the single GLOBAL lock
    ``refreshbatch:lock:__fleet__`` — a fleet batch does NOT also take
    every per-provider lock, so a fleet batch and a provider batch may
    legitimately run over an overlapping source at once (see the module
    comment above ``_run_provider_batch``)."""
    from .redis_client import get_redis

    ds_rows = await _live_ds_rows(session)
    redis = get_redis()
    return await _start_guarded_batch(
        _FLEET_LOCK_SCOPE, ds_rows, body, request=request, svc=svc, redis=redis,
    )


# ── GET /aggregation/refresh-batches/{batch_id} ──────────────────────

@app.get(
    "/aggregation/refresh-batches/{batch_id}",
    response_model=BatchStatus,
    summary="Guarded provider refresh batch progress",
)
async def get_refresh_batch(batch_id: str):
    from .redis_client import get_redis

    redis = get_redis()
    raw = await redis.hgetall(f"refreshbatch:{batch_id}")
    if not raw:
        raise HTTPException(status_code=404, detail=f"Refresh batch {batch_id!r} not found")

    results = [
        _json.loads(v) for k, v in raw.items() if k.startswith("ds:")
    ]
    return BatchStatus(
        batch_id=batch_id,
        provider_id=raw.get("provider_id", ""),
        total=int(raw.get("total", 0)),
        done=int(raw.get("done", 0)),
        results=results,
        state=raw.get("state", "running"),
    )


# ── CLI entry point ─────────────────────────────────────────────────

def _main() -> None:
    """Run the Control Plane as a standalone process."""
    import uvicorn

    port = int(os.getenv("AGGREGATION_API_PORT", "8091"))
    log_level = os.getenv("LOG_LEVEL", "info").lower()

    uvicorn.run(
        "backend.app.services.aggregation.controlplane:app",
        host="0.0.0.0",
        port=port,
        log_level=log_level,
        access_log=True,
    )


if __name__ == "__main__":
    _main()
