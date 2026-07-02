"""Standalone versioning projection worker.

Run: ``python -m backend.app.services.versioning``

Builds a FalkorDB client from ``FALKORDB_HOST/PORT`` (via
:func:`make_falkor_graph_factory`), bootstraps the graphver schema, and runs the
:class:`ProjectionWorker` (poll loop + Redis-stream consumer). Mirrors
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


async def _amain() -> None:
    await models.create_schema_and_partitions()
    # target_resolver self-heals the projection target (the data source's real graph the canvas reads)
    # on every projection, so the standalone worker matches the interactive project_now path.
    # edge_types_resolver keeps :AGGREGATED rollups maintained incrementally here too; no
    # on_rollups_stale (no in-process aggregation service in this runtime — the viz-service's
    # worker/interactive paths own the rebuild hand-off).
    from backend.app.services.projection_target import (
        nudge_stats_after_projection,
        resolve_aggregation_edge_types,
    )
    projector = FalkorProjector(make_falkor_graph_factory(), target_resolver=repair_projection_target,
                                edge_types_resolver=resolve_aggregation_edge_types,
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

    logger.info("versioning projection worker starting (poll=%ss)", config.PROJECTION_POLL_SECS)
    try:
        await worker.run()
    finally:
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
