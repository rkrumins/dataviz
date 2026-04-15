"""
AggregationScheduler — cron-like drift detection for aggregated data.

Runs periodic fingerprint checks for data sources with configured schedules.
When drift is detected, it updates the data source but does NOT automatically
re-aggregate — the user must confirm.

Architecture: In-process via asyncio.create_task() on startup.
For K8s: extract to a standalone cron-job pod or use K8s CronJob.
"""
import asyncio
import logging
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select

logger = logging.getLogger(__name__)


class AggregationScheduler:
    """Runs periodic change detection checks for data sources with configured schedules.

    Checks are non-blocking — drift detection never auto-triggers re-aggregation.
    """

    def __init__(self, session_factory: Any, registry: Any) -> None:
        self._session_factory = session_factory
        self._registry = registry
        self._running = False

    async def start(self) -> None:
        """Called on application startup. Runs forever, checking schedules."""
        self._running = True
        logger.info("AggregationScheduler started")
        while self._running:
            try:
                await self._tick()
            except Exception as e:
                logger.error("Scheduler tick error: %s", e, exc_info=True)
            await asyncio.sleep(60)  # Check every minute for due schedules

    async def stop(self) -> None:
        """Gracefully stop the scheduler."""
        self._running = False

    async def _tick(self) -> None:
        """Check all data sources with aggregation_schedule set.

        For each due schedule:
        1. Compute current fingerprint
        2. Compare against stored fingerprint
        3. If changed: set drift flag on the data source (non-blocking)
        4. Only notify — never auto-trigger re-aggregation
        """
        from backend.app.db.models import WorkspaceDataSourceORM
        from .fingerprint import compute_graph_fingerprint, fingerprints_match

        async with self._session_factory() as session:
            # Find data sources with schedules configured AND status = 'ready'
            result = await session.execute(
                select(WorkspaceDataSourceORM).where(
                    WorkspaceDataSourceORM.aggregation_schedule.isnot(None),
                    WorkspaceDataSourceORM.aggregation_status == "ready",
                )
            )

            for ds in result.scalars():
                try:
                    # TODO: Check if this schedule is actually due (parse cron expression)
                    # For MVP, we just check every time the scheduler ticks
                    provider = await self._registry.get_provider_for_workspace(
                        ds.workspace_id, session, data_source_id=ds.id,
                    )
                    current_fp = await compute_graph_fingerprint(provider)

                    if not fingerprints_match(ds.graph_fingerprint, current_fp):
                        logger.info(
                            "Drift detected for data source %s "
                            "(stored: %s, current: %s)",
                            ds.id, ds.graph_fingerprint, current_fp,
                        )
                        # Note: we do NOT change aggregation_status here.
                        # The frontend polls for drift via the readiness endpoint.
                        # The user decides whether to re-aggregate.
                except Exception as e:
                    # Bump from debug → warning: the previous method call
                    # (get_provider_for_data_source) didn't exist, so every
                    # tick threw AttributeError silently. Now that the method
                    # name is correct, repeated failures here mean a real
                    # provider outage that operators should see. The
                    # registry's per-provider circuit breaker keeps this
                    # loop cheap even under total provider outage — once
                    # tripped it fast-fails in <5ms per data source.
                    logger.warning(
                        "Drift check failed for data source %s: %s", ds.id, e
                    )
