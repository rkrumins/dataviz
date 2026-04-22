"""Stats service entrypoint.

Wires up three concurrent tasks:
    1. Scheduler  — every tick, enqueues due data sources to Redis.
    2. Worker     — XREADGROUP loop, polls providers, upserts stats.
    3. Health HTTP — minimal liveness probe on STATS_HEALTH_PORT.

Gracefully drains in-flight polls on SIGTERM (up to
``STATS_DRAIN_TIMEOUT_SECS``) so container restarts do not leave
partial upserts behind.

Usage:
    python -m backend.stats_service
"""
from __future__ import annotations

import asyncio
import logging
import os
import signal

from backend.app.common.health_server import run_health_server
from backend.app.services.aggregation.redis_client import close_redis

from .config import StatsServiceConfig
from .redis_streams import ensure_consumer_group
from .scheduler import run_scheduler
from .worker import StatsJobConsumer

logger = logging.getLogger(__name__)


async def main() -> None:
    logging.basicConfig(
        level=getattr(logging, os.getenv("LOG_LEVEL", "INFO").upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    config = StatsServiceConfig.from_env()
    logger.info(
        "=== Stats Service starting ===  concurrency=%d per_graph=%d "
        "tick=%.0fs default_interval=%ds min_interval=%ds health_port=%d",
        config.worker_concurrency,
        config.max_per_graph,
        config.scheduler_tick_secs,
        config.default_interval_secs,
        config.min_interval_secs,
        config.health_port,
    )

    await ensure_consumer_group()

    shutdown = asyncio.Event()
    loop = asyncio.get_running_loop()

    def _handle_signal() -> None:
        logger.info("Shutdown signal received")
        shutdown.set()

    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, _handle_signal)

    consumer = StatsJobConsumer(config)

    health_server = await run_health_server(
        config.health_port,
        role="stats-service",
        status_payload_fn=lambda: {
            "activeJobs": consumer.active_count,
            "consumer": consumer.consumer_name,
        },
    )

    scheduler_task = asyncio.create_task(run_scheduler(config, shutdown), name="stats-scheduler")
    worker_task = asyncio.create_task(consumer.run(), name="stats-worker")

    try:
        done, _pending = await asyncio.wait(
            {scheduler_task, worker_task, asyncio.create_task(shutdown.wait())},
            return_when=asyncio.FIRST_COMPLETED,
        )
        for t in done:
            if t.exception() and not isinstance(t.exception(), asyncio.CancelledError):
                logger.error("Task %s exited with exception: %s", t.get_name(), t.exception())
    finally:
        shutdown.set()
        consumer.request_shutdown()

        scheduler_task.cancel()
        try:
            await scheduler_task
        except (asyncio.CancelledError, Exception):
            pass

        await consumer.drain(timeout=config.drain_timeout_secs)

        worker_task.cancel()
        try:
            await worker_task
        except (asyncio.CancelledError, Exception):
            pass

        health_server.close()
        await health_server.wait_closed()

        await close_redis()
        logger.info("=== Stats Service shutdown complete ===")


if __name__ == "__main__":
    asyncio.run(main())
