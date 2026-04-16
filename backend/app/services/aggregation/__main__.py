"""
Standalone aggregation worker — runs as its own process, fully decoupled
from the viz-service (web tier).

Usage:
    python -m backend.app.services.aggregation

Architecture:
    - OWN ProviderManager → own FalkorDB connection pools, own circuit
      breakers.  Provider failures here CANNOT affect the web tier.
    - OWN Postgres session factory (JOBS pool) → checkpoint commits
      never contend with API request sessions.
    - Consumes jobs via Postgres LISTEN/NOTIFY with 5s polling fallback.
    - Configurable concurrency via WORKER_CONCURRENCY env var.
    - Graceful shutdown on SIGTERM: stops accepting new jobs, waits for
      active jobs to checkpoint, then exits.

Environment variables:
    MANAGEMENT_DB_URL          Postgres connection string (required)
    FALKORDB_HOST              FalkorDB host (default: localhost)
    FALKORDB_PORT              FalkorDB port (default: 6379)
    FALKORDB_SOCKET_TIMEOUT    Socket timeout in seconds (default: 30 for worker)
    FALKORDB_GRAPH_POOL_SIZE   Graph connection pool size (default: 8)
    FALKORDB_REDIS_POOL_SIZE   Redis pool size (default: 8)
    WORKER_CONCURRENCY         Max parallel jobs (default: 4)
    AGGREGATION_JOB_TIMEOUT_SECS  Per-job timeout (default: 7200)
    WORKER_POLL_INTERVAL_SECS  Polling fallback interval (default: 5)
    WORKER_HEALTH_PORT         Health endpoint port (default: 8090)
    LOG_LEVEL                  Logging level (default: INFO)
"""
import asyncio
import logging
import os
import signal
import time
from contextlib import suppress

logger = logging.getLogger(__name__)

# Standalone worker uses longer socket timeout than the web tier.
# The web tier defaults to 10s; the worker defaults to 30s because
# batch MERGE operations legitimately take longer.
if "FALKORDB_SOCKET_TIMEOUT" not in os.environ:
    os.environ["FALKORDB_SOCKET_TIMEOUT"] = "30"

# Smaller connection pools — worker only does aggregation, not API traffic
if "FALKORDB_GRAPH_POOL_SIZE" not in os.environ:
    os.environ["FALKORDB_GRAPH_POOL_SIZE"] = "8"
if "FALKORDB_REDIS_POOL_SIZE" not in os.environ:
    os.environ["FALKORDB_REDIS_POOL_SIZE"] = "8"


class _JobConsumer:
    """Polls Postgres for pending aggregation jobs and executes them.

    Uses LISTEN/NOTIFY for instant wake-up with a polling fallback
    every ``poll_interval`` seconds (catches missed notifications,
    e.g. if the worker was restarting when NOTIFY fired).

    Concurrency is bounded by ``max_concurrency`` — at most N jobs
    run simultaneously via asyncio tasks.
    """

    def __init__(
        self,
        worker,
        session_factory,
        max_concurrency: int = 4,
        poll_interval: float = 5.0,
    ):
        self._worker = worker
        self._session_factory = session_factory
        self._max_concurrency = max_concurrency
        self._poll_interval = poll_interval
        self._active_tasks: dict[str, asyncio.Task] = {}
        self._shutdown_event = asyncio.Event()
        self._notify_event = asyncio.Event()

    async def start(self) -> None:
        """Main consumer loop.  Runs until shutdown is signalled."""
        logger.info(
            "Job consumer started (concurrency=%d, poll_interval=%.0fs)",
            self._max_concurrency, self._poll_interval,
        )

        # Start the LISTEN listener in the background
        listener_task = asyncio.create_task(self._listen_for_notifications())

        try:
            while not self._shutdown_event.is_set():
                await self._poll_and_claim()

                # Wait for either a NOTIFY or the poll interval
                with suppress(asyncio.TimeoutError):
                    await asyncio.wait_for(
                        self._notify_event.wait(),
                        timeout=self._poll_interval,
                    )
                self._notify_event.clear()
        finally:
            listener_task.cancel()
            with suppress(asyncio.CancelledError):
                await listener_task

    async def _listen_for_notifications(self) -> None:
        """Background task: LISTEN on 'aggregation_jobs' channel."""
        import asyncpg

        dsn = os.environ.get("MANAGEMENT_DB_URL", "")
        # Convert SQLAlchemy URL to asyncpg format
        dsn = dsn.replace("postgresql+asyncpg://", "postgresql://")

        while not self._shutdown_event.is_set():
            try:
                conn = await asyncpg.connect(dsn)
                try:
                    await conn.add_listener(
                        "aggregation_jobs",
                        lambda conn, pid, channel, payload: self._notify_event.set(),
                    )
                    logger.info("LISTEN on channel 'aggregation_jobs' established")

                    # Keep the connection alive until shutdown
                    while not self._shutdown_event.is_set():
                        await asyncio.sleep(1)
                finally:
                    await conn.close()
            except asyncio.CancelledError:
                return
            except Exception as e:
                logger.warning("LISTEN connection failed: %s (retrying in 5s)", e)
                await asyncio.sleep(5)

    async def _poll_and_claim(self) -> None:
        """Poll for pending jobs, claim up to max_concurrency slots."""
        # Clean up completed tasks
        done_ids = [jid for jid, t in self._active_tasks.items() if t.done()]
        for jid in done_ids:
            task = self._active_tasks.pop(jid)
            if exc := task.exception():
                logger.error("Job %s failed with unhandled error: %s", jid, exc)

        available_slots = self._max_concurrency - len(self._active_tasks)
        if available_slots <= 0:
            return

        from sqlalchemy import text

        async with self._session_factory() as session:
            # Claim pending jobs using FOR UPDATE SKIP LOCKED to prevent
            # duplicate processing across multiple worker replicas.
            result = await session.execute(
                text(
                    "SELECT id FROM aggregation_jobs "
                    "WHERE status = 'pending' "
                    "ORDER BY created_at "
                    "LIMIT :limit "
                    "FOR UPDATE SKIP LOCKED"
                ),
                {"limit": available_slots},
            )
            job_ids = [row[0] for row in result.fetchall()]

            if not job_ids:
                return

            logger.info("Claimed %d pending jobs: %s", len(job_ids), job_ids)
            await session.commit()

        # Launch each job as an asyncio task
        for job_id in job_ids:
            if job_id not in self._active_tasks:
                task = asyncio.create_task(
                    self._worker.run(job_id),
                    name=f"aggregation-{job_id}",
                )
                self._active_tasks[job_id] = task

    def request_shutdown(self) -> None:
        """Signal the consumer to stop accepting new jobs."""
        self._shutdown_event.set()
        self._notify_event.set()  # Wake the poll loop

    async def drain(self, timeout: float = 60.0) -> None:
        """Wait for active jobs to checkpoint and complete."""
        if not self._active_tasks:
            return

        logger.info(
            "Draining %d active jobs (timeout=%.0fs)...",
            len(self._active_tasks), timeout,
        )
        tasks = list(self._active_tasks.values())
        done, pending = await asyncio.wait(tasks, timeout=timeout)

        if pending:
            logger.warning(
                "%d jobs did not complete within %.0fs grace period. "
                "They will resume from their last checkpoint on restart.",
                len(pending), timeout,
            )
            for t in pending:
                t.cancel()
            await asyncio.gather(*pending, return_exceptions=True)


async def _run_health_server(consumer: _JobConsumer, port: int) -> None:
    """Minimal health endpoint for K8s probes.

    Pure asyncio — no extra dependency (aiohttp, uvicorn, etc.).
    Responds to any HTTP request with a JSON health payload.
    """
    import json as _json

    start_time = time.monotonic()

    async def _handle_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        try:
            # Read the request (we only care that it arrived)
            await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=5)
        except Exception:
            pass

        body = _json.dumps({
            "status": "healthy",
            "activeJobs": len(consumer._active_tasks),
            "uptime": int(time.monotonic() - start_time),
            "role": "aggregation-worker",
        })
        response = (
            f"HTTP/1.1 200 OK\r\n"
            f"Content-Type: application/json\r\n"
            f"Content-Length: {len(body)}\r\n"
            f"Connection: close\r\n"
            f"\r\n{body}"
        )
        writer.write(response.encode())
        await writer.drain()
        writer.close()

    server = await asyncio.start_server(_handle_client, "0.0.0.0", port)  # noqa: F841
    logger.info("Health endpoint listening on port %d", port)


async def main() -> None:
    """Standalone worker entrypoint."""
    from backend.app.db.engine import get_jobs_session, init_db
    from backend.app.providers.manager import ProviderManager
    from .worker import AggregationWorker
    from .service import AggregationService
    from .dispatcher import InProcessDispatcher

    logging.basicConfig(
        level=getattr(logging, os.getenv("LOG_LEVEL", "INFO")),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    logger.info("=== Aggregation Worker (standalone) starting ===")
    logger.info(
        "Config: FALKORDB_SOCKET_TIMEOUT=%s, GRAPH_POOL=%s, REDIS_POOL=%s, CONCURRENCY=%s",
        os.getenv("FALKORDB_SOCKET_TIMEOUT"),
        os.getenv("FALKORDB_GRAPH_POOL_SIZE"),
        os.getenv("FALKORDB_REDIS_POOL_SIZE"),
        os.getenv("WORKER_CONCURRENCY", "4"),
    )

    # Initialize DB (creates tables if needed)
    await init_db()

    # OWN ProviderManager — completely separate from viz-service.
    # Own connection pools, own circuit breakers, own timeouts.
    # Provider failures here CANNOT affect the web tier.
    registry = ProviderManager()

    # Create worker on the JOBS pool
    worker = AggregationWorker(get_jobs_session, registry)

    # Recover any interrupted jobs from a previous crash
    dispatcher = InProcessDispatcher(worker)
    service = AggregationService(
        dispatcher=dispatcher,
        registry=registry,
        session_factory=get_jobs_session,
    )
    recovered = await service.recover_interrupted_jobs()
    if recovered:
        logger.info("Recovered %d interrupted aggregation jobs", recovered)

    # Create the job consumer
    concurrency = int(os.getenv("WORKER_CONCURRENCY", "4"))
    poll_interval = float(os.getenv("WORKER_POLL_INTERVAL_SECS", "5"))
    consumer = _JobConsumer(
        worker=worker,
        session_factory=get_jobs_session,
        max_concurrency=concurrency,
        poll_interval=poll_interval,
    )

    # Start health endpoint
    health_port = int(os.getenv("WORKER_HEALTH_PORT", "8090"))
    try:
        await _run_health_server(consumer, health_port)
    except Exception as e:
        logger.warning("Health endpoint failed to start: %s (continuing without it)", e)

    # Register signal handlers for graceful shutdown
    loop = asyncio.get_running_loop()

    def _signal_handler():
        logger.info("Received shutdown signal — stopping consumer...")
        consumer.request_shutdown()

    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, _signal_handler)

    # Run the consumer loop
    try:
        await consumer.start()
    finally:
        logger.info("Consumer stopped — draining active jobs...")
        await consumer.drain(timeout=60.0)
        await registry.evict_all()
        logger.info("=== Aggregation Worker shutdown complete ===")


if __name__ == "__main__":
    asyncio.run(main())
