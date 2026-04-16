"""
Standalone aggregation worker entrypoint.

Usage (in-process, current):
    # Imported and started by app/main.py

Usage (standalone, future K8s):
    python -m app.services.aggregation
    # Connects to management DB + graph DB directly
    # Consumes jobs from message queue
    # No FastAPI, no HTTP server
"""
import asyncio
import logging
import os

logger = logging.getLogger(__name__)


async def main() -> None:
    """Standalone worker entrypoint for K8s deployment."""
    from backend.app.db.engine import get_jobs_session, init_db
    from backend.app.registry.provider_registry import ProviderRegistry
    from .worker import AggregationWorker
    from .scheduler import AggregationScheduler

    logging.basicConfig(
        level=getattr(logging, os.getenv("LOG_LEVEL", "INFO")),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    # Initialize DB (creates tables if needed)
    await init_db()

    # Bootstrap provider registry
    registry = ProviderRegistry()
    await registry.bootstrap()

    # Create worker on the JOBS pool (plan Gap 3). Even as a standalone
    # process the discipline stays the same — checkpoint storms never
    # contend with any request-path pool that might be introduced later.
    worker = AggregationWorker(get_jobs_session, registry)

    # In standalone mode, the worker would consume from a message queue:
    # consumer = MessageQueueConsumer(worker)
    # await consumer.start()

    # For now, just run recovery + scheduler
    from .service import AggregationService
    from .dispatcher import InProcessDispatcher

    dispatcher = InProcessDispatcher(worker)
    service = AggregationService(
        dispatcher=dispatcher,
        registry=registry,
        session_factory=get_jobs_session,
    )

    recovered = await service.recover_interrupted_jobs()
    logger.info("Recovered %d interrupted aggregation jobs", recovered)

    scheduler = AggregationScheduler(get_jobs_session, registry)
    logger.info("Standalone aggregation worker started")
    await scheduler.start()


if __name__ == "__main__":
    asyncio.run(main())
