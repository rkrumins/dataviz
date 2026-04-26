"""Insights service entrypoint.

Wires up three concurrent tasks:
    1. Scheduler  — every tick, enqueues due data sources to Redis.
    2. Worker     — XREADGROUP loop on three streams (stats / discovery /
       schema), routes via the dispatcher to the registered handler.
    3. Health HTTP — minimal liveness probe on STATS_HEALTH_PORT.

Gracefully drains in-flight jobs on SIGTERM (up to
``STATS_DRAIN_TIMEOUT_SECS``) so container restarts do not leave
partial upserts behind.

Usage:
    python -m backend.insights_service
"""
from __future__ import annotations

import asyncio
import logging
import os
import signal
import sys

from backend.app.common.health_server import run_health_server
from backend.app.services.aggregation.redis_client import close_redis, get_redis

from .config import StatsServiceConfig
from .redis_streams import (
    ensure_consumer_group,
    snapshot_stream_depths,
    stream_depths_to_dict,
)
from .scheduler import (
    get_discovery_scheduler_status,
    get_scheduler_status,
    run_discovery_scheduler,
    run_scheduler,
    run_trim_scheduler,
)
# Importing the worker module pulls in collector + discovery which
# self-register their handlers with the dispatcher. The dispatcher's
# registry must be populated before the XREADGROUP loop starts so the
# first incoming message has a handler waiting.
from . import collector as _collector  # noqa: F401  (registration side-effect)
from . import discovery as _discovery  # noqa: F401  (registration side-effect)
from . import purge as _purge  # noqa: F401  (registration side-effect)
from . import dispatcher
from .worker import StatsJobConsumer

logger = logging.getLogger(__name__)


_REQUIRED_TABLES = (
    "workspace_data_sources",
    "data_source_polling_configs",
    "data_source_stats",
)


async def _preflight() -> None:
    """Validate environment and infra before starting the event loop.

    Each failure exits with a single CRITICAL line naming the missing
    piece and a pointer to the fix. Fast, cheap, and avoids the 30-second
    debug round-trip of "it starts fine then crashes in the scheduler".
    """
    try:
        import asyncpg  # noqa: F401
    except ImportError:
        logger.critical(
            "asyncpg not installed. Run 'pip install -r backend/requirements.txt' "
            "in your venv, or launch via './dev.sh up' (Docker has it pre-installed)."
        )
        sys.exit(1)

    db_url = os.getenv("MANAGEMENT_DB_URL")
    if not db_url:
        logger.critical(
            "MANAGEMENT_DB_URL is not set. Export it (e.g. 'set -a; source .env.dev; set +a') "
            "or run './dev.sh up' which sets it in the container."
        )
        sys.exit(1)

    redis_url = os.getenv("REDIS_URL")
    if not redis_url:
        logger.critical(
            "REDIS_URL is not set. Export it (e.g. 'set -a; source .env.dev; set +a') "
            "or run './dev.sh up'."
        )
        sys.exit(1)

    # Import here so the asyncpg check above can surface its own clean
    # error — importing engine.py eagerly loads asyncpg.
    from sqlalchemy import text

    from backend.app.db.engine import PoolRole, get_session_factory

    async def _select_one() -> None:
        factory = get_session_factory(PoolRole.READONLY)
        async with factory() as session:
            await session.execute(text("SELECT 1"))

    try:
        await asyncio.wait_for(_select_one(), timeout=5.0)
    except asyncio.TimeoutError:
        logger.critical(
            "Cannot reach Postgres at MANAGEMENT_DB_URL (%s) within 5s. "
            "Run './dev.sh infra' (or './dev.sh up') and retry.",
            db_url,
        )
        sys.exit(1)
    except Exception as exc:
        logger.critical(
            "Cannot reach Postgres at MANAGEMENT_DB_URL (%s). "
            "Run './dev.sh infra' (or './dev.sh up') and retry. Underlying: %s",
            db_url, exc,
        )
        sys.exit(1)

    try:
        redis = get_redis()
        await asyncio.wait_for(redis.ping(), timeout=5.0)
    except asyncio.TimeoutError:
        logger.critical(
            "Cannot reach Redis at REDIS_URL=%s within 5s. Run './dev.sh infra' "
            "(or './dev.sh up') and retry.",
            redis_url,
        )
        sys.exit(1)
    except Exception as exc:
        logger.critical(
            "Cannot reach Redis at REDIS_URL=%s. Run './dev.sh infra' "
            "(or './dev.sh up') and retry. Underlying: %s",
            redis_url, exc,
        )
        sys.exit(1)

    # Schema check — the controlplane is supposed to have run Alembic
    # already (docker-compose depends_on: aggregation-controlplane:
    # service_healthy). If someone launches us directly against a fresh
    # DB, say so instead of crashing with a SQL 42P01 on the first tick.
    try:
        factory = get_session_factory(PoolRole.READONLY)
        async with factory() as session:
            for table in _REQUIRED_TABLES:
                result = await session.execute(
                    text("SELECT to_regclass(:name)"), {"name": table}
                )
                if result.scalar() is None:
                    logger.critical(
                        "Required table '%s' is missing. Run './dev.sh up' "
                        "(controlplane applies Alembic migrations) or "
                        "'alembic -c backend/alembic.ini upgrade head'.",
                        table,
                    )
                    sys.exit(1)
    except SystemExit:
        raise
    except Exception as exc:
        logger.critical("Schema preflight check failed: %s", exc)
        sys.exit(1)

    logger.info("Preflight OK: asyncpg present, Postgres reachable, Redis reachable, schema present.")


async def main() -> None:
    logging.basicConfig(
        level=getattr(logging, os.getenv("LOG_LEVEL", "INFO").upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    config = StatsServiceConfig.from_env()
    logger.info(
        "=== Insights Service starting ===  kinds=%s concurrency=%d per_scope=%d "
        "tick=%.0fs default_interval=%ds min_interval=%ds health_port=%d",
        dispatcher.registered_kinds(),
        config.worker_concurrency,
        config.max_per_graph,
        config.scheduler_tick_secs,
        config.default_interval_secs,
        config.min_interval_secs,
        config.health_port,
    )

    # Sanity-check registration before opening Redis loops — if a
    # handler module silently failed to import, surface the gap here
    # rather than DLQing every incoming message of that kind.
    if "stats_poll" not in dispatcher.registered_kinds():
        logger.critical(
            "stats_poll handler not registered; collector.py failed to import. Aborting."
        )
        sys.exit(1)

    await _preflight()

    # Idempotently create the shared consumer group on every stream.
    await ensure_consumer_group()

    shutdown = asyncio.Event()
    loop = asyncio.get_running_loop()

    def _handle_signal() -> None:
        logger.info("Shutdown signal received")
        shutdown.set()

    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, _handle_signal)

    consumer = StatsJobConsumer(config)

    # Module-level cache of the latest queue-depth snapshot. The
    # health server's status_payload_fn is synchronous, but the
    # snapshot needs an async Redis call — so we keep the latest
    # snapshot in a dict and refresh it on a 5s background tick.
    _health_snapshot: dict = {}

    async def _health_snapshot_task() -> None:
        # Lazy import: admission imports SQLAlchemy through the engine
        # module, which we want resolved after the preflight asyncpg
        # check has run.
        from . import admission

        while not shutdown.is_set():
            try:
                snapshot = await snapshot_stream_depths()
                payload = stream_depths_to_dict(snapshot)
                # Per-provider last-call duration. One number per
                # provider — see admission.record_latency. Real
                # percentile aggregation is deferred to PR B.
                payload["providers"] = {
                    provider_id: {"last_call_duration_ms": ms}
                    for provider_id, ms in admission.controller.last_durations_snapshot().items()
                }
                _health_snapshot.update(payload)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.warning("health_snapshot.error: %s", exc)
            try:
                await asyncio.wait_for(shutdown.wait(), timeout=5.0)
                return
            except asyncio.TimeoutError:
                continue

    health_server = await run_health_server(
        config.health_port,
        role="insights-service",
        status_payload_fn=lambda: {
            "activeJobs": consumer.active_count,
            "consumer": consumer.consumer_name,
            "kinds": dispatcher.registered_kinds(),
            "scheduler": get_scheduler_status(),
            "discovery_scheduler": get_discovery_scheduler_status(),
            **_health_snapshot,
        },
    )

    scheduler_task = asyncio.create_task(run_scheduler(config, shutdown), name="insights-scheduler")
    trim_task = asyncio.create_task(run_trim_scheduler(shutdown), name="insights-trim")
    discovery_task = asyncio.create_task(
        run_discovery_scheduler(shutdown), name="insights-discovery-scheduler",
    )
    health_task = asyncio.create_task(_health_snapshot_task(), name="insights-health-snapshot")
    worker_task = asyncio.create_task(consumer.run(), name="insights-worker")

    try:
        done, _pending = await asyncio.wait(
            {scheduler_task, trim_task, discovery_task, health_task, worker_task, asyncio.create_task(shutdown.wait())},
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

        trim_task.cancel()
        try:
            await trim_task
        except (asyncio.CancelledError, Exception):
            pass

        discovery_task.cancel()
        try:
            await discovery_task
        except (asyncio.CancelledError, Exception):
            pass

        health_task.cancel()
        try:
            await health_task
        except (asyncio.CancelledError, Exception):
            pass

        await consumer.drain(timeout=config.drain_timeout_secs)

        worker_task.cancel()
        try:
            await worker_task
        except (asyncio.CancelledError, Exception):
            pass

        # Final drain of buffered admission counters before the
        # process exits — the periodic flush task is cancelled below
        # and would otherwise drop the last window of outcomes.
        try:
            from . import admission
            await admission.controller.drain()
        except Exception as exc:
            logger.warning("admission final drain failed: %s", exc)

        health_server.close()
        await health_server.wait_closed()

        await close_redis()
        logger.info("=== Insights Service shutdown complete ===")


if __name__ == "__main__":
    asyncio.run(main())
