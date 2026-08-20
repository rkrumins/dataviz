"""Insights service entrypoint.

Wires up three concurrent tasks:
    1. Scheduler  — every tick, enqueues due data sources to Redis.
    2. Worker     — XREADGROUP loop on four streams (stats counts /
       stats deep / discovery / purge), routed via the dispatcher to the
       registered handler under per-lane concurrency budgets.
    3. Health HTTP — minimal liveness probe on the configured health port.

Gracefully drains in-flight jobs on SIGTERM (up to
``STATS_DRAIN_TIMEOUT_SECS``) so container restarts do not leave
partial upserts behind.

Redis degradation contract: Redis down → the whole stats pipeline
pauses (streams, dedup claims, and cooldown keys are Redis), the web
read path keeps serving Postgres rows with ``status=stale``, and the
admission GCRA fails open. All Redis state here is ADVISORY — lost
claims/cooldowns/queue entries heal within one scheduler tick + poll
interval of Redis returning; Postgres rows are the only authority.

Usage:
    python -m backend.insights_service [--health-port PORT]

Health-port resolution order (highest precedence first):
    1. --health-port CLI flag
    2. STATS_HEALTH_PORT environment variable
    3. Default 8092
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import os
import signal
import sys
from dataclasses import replace

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
    get_due_backlog,
    get_history_purge_status,
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


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    """Parse CLI flags. Kept tiny on purpose — env vars remain the
    primary configuration surface for the container deployment; CLI
    flags exist so a developer running on the host can avoid port
    conflicts with an in-Docker stats-service (or a stale orphan)
    without editing ``.env.dev``.
    """
    parser = argparse.ArgumentParser(
        prog="python -m backend.insights_service",
        description=(
            "Synodic insights service — scheduler + worker + health endpoint."
        ),
    )
    parser.add_argument(
        "--health-port",
        type=int,
        default=None,
        metavar="PORT",
        help=(
            "TCP port for the liveness health endpoint. "
            "Overrides STATS_HEALTH_PORT. Default: 8092."
        ),
    )
    return parser.parse_args(argv)


_REQUIRED_TABLES = (
    "workspace_data_sources",
    "data_source_polling_configs",
    "data_source_stats",
    "data_source_count_snapshots",
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

    from backend.app.db.engine import get_readonly_session

    async def _select_one() -> None:
        async with get_readonly_session() as session:
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
        async with get_readonly_session() as session:
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


async def main(args: argparse.Namespace) -> None:
    logging.basicConfig(
        level=getattr(logging, os.getenv("LOG_LEVEL", "INFO").upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    config = StatsServiceConfig.from_env()
    health_port_source = "env"
    if args.health_port is not None:
        config = replace(config, health_port=args.health_port)
        health_port_source = "cli"
    elif "STATS_HEALTH_PORT" not in os.environ:
        health_port_source = "default"

    logger.info(
        "=== Insights Service starting ===  kinds=%s concurrency=%d per_scope=%d "
        "tick=%.0fs default_interval=%ds min_interval=%ds health_port=%d (via %s)",
        dispatcher.registered_kinds(),
        config.worker_concurrency,
        config.max_per_graph,
        config.scheduler_tick_secs,
        config.default_interval_secs,
        config.min_interval_secs,
        config.health_port,
        health_port_source,
    )

    # Sanity-check registration before opening Redis loops — if a
    # handler module silently failed to import, surface the gap here
    # rather than DLQing every incoming message of that kind.
    for required_kind in ("stats_poll", "stats_deep"):
        if required_kind not in dispatcher.registered_kinds():
            logger.critical(
                "%s handler not registered; collector.py failed to import. Aborting.",
                required_kind,
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
                # Per-lane in-flight counts + SQL-derived staleness gauges.
                # Lane-accounting bugs and stale-forever rows are invisible
                # without these — the stream depths alone can look healthy.
                payload["lanes"] = consumer.lane_active_snapshot()
                payload.update(await get_due_backlog())
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
            "history_purge": get_history_purge_status(),
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

    # Cross-process cancel bridge — purges (and any other job kinds
    # hosted in this process) need to receive cancel signals from the
    # web tier. Subscribes to the Redis Pub/Sub control channel and
    # forwards into this process's local CancelRegistry, which the
    # purge handler's checkpoint callback observes.
    from backend.app.services.aggregation.cancel import CancelListener
    cancel_listener = CancelListener(get_redis())
    try:
        await cancel_listener.start()
    except Exception as exc:
        logger.warning(
            "Cancel listener failed to start: %s (cancels for purges hosted "
            "in this process will fall back to direct DB-write only)", exc,
        )

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

        # Drain in-flight cache-warm tasks — they hold READONLY-pool
        # sessions and must not outlive the engines disposed below.
        from . import cache_warmer
        await cache_warmer.shutdown()

        # Stop the cross-process cancel listener.
        try:
            await cancel_listener.stop()
        except Exception:
            pass

        # Stop the admission flush task; its cancellation handler runs
        # the final drain of buffered counters. The drain writes to
        # Postgres, so this must happen before close_db().
        try:
            from . import admission
            await admission.controller.stop()
        except Exception as exc:
            logger.warning("admission stop failed: %s", exc)

        health_server.close()
        await health_server.wait_closed()

        await close_redis()
        # Dispose the per-role engines LAST so every teardown step above
        # can still write, and no asyncpg connection survives into
        # event-loop close (the "Event loop is closed" GC noise).
        from backend.app.db.engine import close_db
        await close_db()
        logger.info("=== Insights Service shutdown complete ===")


if __name__ == "__main__":
    asyncio.run(main(_parse_args()))
