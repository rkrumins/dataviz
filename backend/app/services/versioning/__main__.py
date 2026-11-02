"""Standalone versioning worker: the lanes ``GRAPHVER_WORKER_LANES`` names (all by default).

Run: ``python -m backend.app.services.versioning``

Builds a provider-aware FalkorDB graph factory (registry-routed per
``projection_state.falkor_provider``, env ``FALKORDB_HOST/PORT`` as the default
instance), bootstraps the graphver schema, and runs the :class:`ProjectionWorker`'s
enabled lanes — projection (poll loop + Redis-stream consumer), transfer (import /
export / publish / inspect jobs), bootstrap (bootstraps, purges, the reaper). Job leases
are renewed by a heartbeat thread (``job_lease.LeaseKeeper``) that also exits the
process if its event loop wedges. Mirrors ``backend/app/services/aggregation/__main__.py``.
"""
from __future__ import annotations

import asyncio
import logging
import os
import signal

from . import config, db, models
from .job_lease import LeaseKeeper
from .messaging import close_broker_redis
from .projection import FalkorProjector, make_falkor_graph_factory
from .worker import build_worker
from backend.app.observability.event_loop_monitor import (
    EventLoopLagStats,
    run_event_loop_monitor,
)
from backend.app.providers.eviction_budget import make_registry_budget_resolver
from backend.app.services.projection_target import repair_projection_target

logger = logging.getLogger(__name__)

_AGG_SERVICE = None


def _get_agg_service():
    """Lazily build a dispatch-only AggregationService so the projector's
    on_rollups_stale hook can queue a scoped rebuild after a full seed wipes
    the :AGGREGATED rollups (R-H1). Uses the same Redis stream + Postgres the
    control-plane uses, so the job executes on the aggregation-worker. Returns
    None (hook logs + leaves the manual rebuild path) if unavailable."""
    global _AGG_SERVICE
    if _AGG_SERVICE is None:
        try:
            from backend.app.db.engine import get_jobs_session
            from backend.app.providers.manager import ProviderManager
            from backend.app.services.aggregation.service import AggregationService
            from backend.app.services.aggregation.dispatcher import RedisStreamDispatcher
            from backend.app.services.aggregation.redis_client import get_redis
            _AGG_SERVICE = AggregationService(
                dispatcher=RedisStreamDispatcher(get_redis()),
                registry=ProviderManager(),
                session_factory=get_jobs_session,
            )
        except Exception as exc:                           # pragma: no cover - infra
            logger.warning(
                "versioning-worker: aggregation service unavailable for rollup "
                "rebuild (%s); full-seed rollups need a manual rebuild", exc,
            )
            return None
    return _AGG_SERVICE


async def _serve_metrics():
    """The scrape endpoint (``METRICS_ENABLED``, ``METRICS_PORT``) for this process, which has no
    HTTP server of its own, as the aggregation worker serves its own: the projection lane's
    capacity loop counts here (residency, doc 17). Returns the running server, or None. Best
    effort: a worker that cannot bind its metrics port still runs its lanes."""
    from backend.app.api.v1.endpoints.metrics import metrics_enabled

    if not metrics_enabled():
        return None
    try:
        import uvicorn
        from fastapi import FastAPI

        from backend.app.api.v1.endpoints import metrics as metrics_endpoint

        port = int(os.getenv("METRICS_PORT", "9100"))
        app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
        app.include_router(metrics_endpoint.router)
        server = uvicorn.Server(uvicorn.Config(app, host="0.0.0.0", port=port,
                                               log_level="warning", access_log=False))

        async def serve():
            try:
                await server.serve()
            except SystemExit:            # uvicorn exits when it cannot bind: not the worker
                logger.warning("metrics: worker scrape endpoint not started: port %d unusable",
                               port)

        asyncio.create_task(serve(), name="versioning-metrics")
        logger.info("metrics: worker scrape endpoint on :%d/metrics", port)
        return server
    except Exception as exc:              # noqa: BLE001 — never fail the worker
        logger.warning("metrics: worker scrape endpoint not started: %s", exc)
        return None


def _import_export_service():
    """The API's own import/export service, with its view-scope, ontology and layout hooks, so a
    queued job runs here exactly as it would have in the API process that queued it."""
    from backend.app.api.v1.endpoints.versioning import get_import_export_service

    return get_import_export_service()


async def _amain() -> None:
    # The metrics backend first, in every process that emits, and a way to read it.
    try:
        from backend.app.jobs.metrics_prometheus import install as _install_metrics

        _install_metrics()
    except Exception as exc:              # noqa: BLE001 — never fail startup
        logger.warning("metrics backend not installed: %s", exc)
    metrics_server = await _serve_metrics()
    lanes = config.worker_lanes()
    if not os.getenv("GRAPHVER_POOL_SIZE"):
        # Before the first session: the engine is built from this on first use.
        config.POOL_SIZE = config.lane_pool_size(lanes)
    await models.create_schema_and_partitions()
    # target_resolver self-heals the projection target (the data source's real graph the canvas reads)
    # on every projection, so the standalone worker matches the interactive project_now path.
    # edge_types_resolver keeps :AGGREGATED rollups maintained incrementally; on_rollups_stale
    # (R-H1) queues a scoped rebuild when a FULL seed wipes them — since INPROCESS=0 the poll-loop
    # backstop runs ONLY here, so without this hook worker-driven full seeds would leave the
    # aggregated/collapsed canvas edges empty until a manual rebuild.
    from backend.app.services.projection_target import (
        make_rollup_rebuild_hook,
        after_projection,
        resolve_aggregation_edge_types,
    )
    # Provider-aware routing: each graph projects into its pinned provider instance
    # (registry host/port/creds), matching the per-provider read path and aggregation
    # worker. Falls back to the env-instance factory if the registry is unavailable.
    try:
        from backend.app.providers.falkor_graph_registry import make_registry_graph_factory
        graph_factory = make_registry_graph_factory()
    except Exception:                                  # pragma: no cover - infra
        logger.exception("registry graph factory unavailable — using env FalkorDB instance")
        graph_factory = make_falkor_graph_factory()
    projector = FalkorProjector(graph_factory, target_resolver=repair_projection_target,
                                edge_types_resolver=resolve_aggregation_edge_types,
                                on_rollups_stale=make_rollup_rebuild_hook(_get_agg_service),
                                on_projected=after_projection)
    worker = build_worker(
        projector, graph_factory, lanes=lanes, import_export=_import_export_service,
        consumer=os.getenv("HOSTNAME"),
        # Per-provider eviction budgets come from the provider registry (env
        # GRAPHVER_FALKOR_* as fallback); the loop no-ops until a provider's
        # falkorMaxResident is set.
        evict_budget=make_registry_budget_resolver(),
    )

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, worker.stop)

    # The loop monitor's ticks are what the lease keeper's wedge guard watches: a loop that stops
    # ticking for GRAPHVER_JOB_WEDGE_SECS takes the process down, so its jobs are taken over.
    monitor_stop = asyncio.Event()
    monitor = asyncio.create_task(
        run_event_loop_monitor(stats=EventLoopLagStats(), shutdown=monitor_stop),
        name="event-loop-monitor")
    keeper = LeaseKeeper(exit_on_wedge=True).start()

    # This process caches provider configs + graph clients (via the registry factory)
    # and has NO warmup loop, so an admin repointing a provider would otherwise leave
    # it projecting into the OLD instance until restart.
    from backend.app.providers.invalidation_bus import ProviderInvalidationListener

    invalidation_listener = ProviderInvalidationListener()
    try:
        await invalidation_listener.start()
    except Exception as exc:
        logger.warning("Provider invalidation listener failed to start: %s", exc)

    logger.info("versioning worker starting (lanes=%s, pool=%s)", ",".join(sorted(lanes)),
                config.POOL_SIZE)
    try:
        await worker.run()
    finally:
        if metrics_server is not None:
            metrics_server.should_exit = True
        keeper.stop()
        monitor_stop.set()
        await asyncio.gather(monitor, return_exceptions=True)
        try:
            await invalidation_listener.stop()
        except Exception:
            pass
        await close_broker_redis()
        await db.dispose_engine()
        logger.info("versioning worker stopped")


def main() -> None:
    logging.basicConfig(
        level=os.getenv("LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    asyncio.run(_amain())


if __name__ == "__main__":
    main()
