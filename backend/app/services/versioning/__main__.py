"""Standalone versioning projection worker.

Run: ``python -m backend.app.services.versioning``

Builds a provider-aware FalkorDB graph factory (registry-routed per
``projection_state.falkor_provider``, env ``FALKORDB_HOST/PORT`` as the default
instance), bootstraps the graphver schema, and runs the :class:`ProjectionWorker`
(poll loop + Redis-stream consumer). Mirrors
``backend/app/services/aggregation/__main__.py``.
"""
from __future__ import annotations

import asyncio
import logging
import os
import signal

from . import config, db, models
from .messaging import close_broker_redis
from .projection import FalkorProjector, make_falkor_graph_factory
from .service import GraphVersioningService
from .worker import ProjectionWorker
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


async def _amain() -> None:
    await models.create_schema_and_partitions()
    # target_resolver self-heals the projection target (the data source's real graph the canvas reads)
    # on every projection, so the standalone worker matches the interactive project_now path.
    # edge_types_resolver keeps :AGGREGATED rollups maintained incrementally; on_rollups_stale
    # (R-H1) queues a scoped rebuild when a FULL seed wipes them — since INPROCESS=0 the poll-loop
    # backstop runs ONLY here, so without this hook worker-driven full seeds would leave the
    # aggregated/collapsed canvas edges empty until a manual rebuild.
    from backend.app.services.projection_target import (
        make_rollup_rebuild_hook,
        nudge_stats_after_projection,
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
                                on_projected=nudge_stats_after_projection)
    worker = ProjectionWorker(
        projector, consumer_name=os.getenv("HOSTNAME", "proj-1"),
        versioning=GraphVersioningService(),
        # Per-provider eviction budgets come from the provider registry (env
        # GRAPHVER_FALKOR_* as fallback); the loop no-ops until a provider's
        # falkorMaxResident is set.
        evict_budget=make_registry_budget_resolver(),
    )

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, worker.stop)

    # This process caches provider configs + graph clients (via the registry factory)
    # and has NO warmup loop, so an admin repointing a provider would otherwise leave
    # it projecting into the OLD instance until restart.
    from backend.app.providers.invalidation_bus import ProviderInvalidationListener

    invalidation_listener = ProviderInvalidationListener()
    try:
        await invalidation_listener.start()
    except Exception as exc:
        logger.warning("Provider invalidation listener failed to start: %s", exc)

    logger.info("versioning projection worker starting (poll=%ss)", config.PROJECTION_POLL_SECS)
    try:
        await worker.run()
    finally:
        try:
            await invalidation_listener.stop()
        except Exception:
            pass
        await close_broker_redis()
        await db.dispose_engine()
        logger.info("versioning projection worker stopped")


def main() -> None:
    logging.basicConfig(
        level=os.getenv("LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    asyncio.run(_amain())


if __name__ == "__main__":
    main()
