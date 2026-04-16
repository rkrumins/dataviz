"""
Standalone aggregation worker (Data Plane) — runs as its own process,
fully decoupled from the viz-service (web tier) and Control Plane.

Usage:
    python -m backend.app.services.aggregation

Architecture:
    - OWN ProviderManager -> own FalkorDB connection pools, own circuit
      breakers.  Provider failures here CANNOT affect the web tier.
    - OWN Postgres session factory (JOBS pool) -> checkpoint commits
      never contend with API request sessions.
    - Consumes jobs via Redis Streams XREADGROUP with consumer groups.
      At-least-once delivery with automatic PEL-based crash recovery.
    - Per-graph concurrency limiting prevents write lock contention.
    - Configurable concurrency via WORKER_CONCURRENCY env var.
    - Graceful shutdown on SIGTERM: stops accepting new jobs, waits for
      active jobs to checkpoint, then exits.

Environment variables:
    MANAGEMENT_DB_URL          Postgres connection string (required)
    REDIS_URL                  Redis broker URL (default: redis://localhost:6380/0)
    FALKORDB_HOST              FalkorDB host (default: localhost)
    FALKORDB_PORT              FalkorDB port (default: 6379)
    FALKORDB_SOCKET_TIMEOUT    Socket timeout in seconds (default: 60 for worker)
    WORKER_CONCURRENCY         Max parallel jobs (default: 4)
    MAX_CONCURRENT_PER_GRAPH   Max parallel jobs per graph (default: 2)
    AGGREGATION_JOB_TIMEOUT_SECS  Per-job timeout (default: 7200)
    WORKER_HEALTH_PORT         Health endpoint port (default: 8090)
    LOG_LEVEL                  Logging level (default: INFO)
"""
import asyncio
import logging
import os
import platform
import signal
import time

logger = logging.getLogger(__name__)

# ── Worker-specific defaults (set BEFORE any provider imports) ──────
# The worker uses longer socket timeout than the web tier (10s) because
# batch MERGE operations legitimately take longer under load.
if "FALKORDB_SOCKET_TIMEOUT" not in os.environ:
    os.environ["FALKORDB_SOCKET_TIMEOUT"] = "60"

# Auto-scale FalkorDB pool sizes from WORKER_CONCURRENCY.
# Each concurrent job needs ~4 graph pool slots (count + fetch + 2 MERGE)
# and ~3 redis pool slots (HGET pipeline + SADD pipeline + SCARD pipeline).
_concurrency = int(os.getenv("WORKER_CONCURRENCY", "4"))
if "FALKORDB_GRAPH_POOL_SIZE" not in os.environ:
    os.environ["FALKORDB_GRAPH_POOL_SIZE"] = str(_concurrency * 4 + 8)
if "FALKORDB_REDIS_POOL_SIZE" not in os.environ:
    os.environ["FALKORDB_REDIS_POOL_SIZE"] = str(_concurrency * 3 + 8)


class _JobConsumer:
    """Consumes aggregation jobs from a Redis Stream via XREADGROUP.

    Uses Redis Streams consumer groups for:
    - Automatic distribution across worker replicas
    - At-least-once delivery via XACK
    - Crash recovery via Pending Entry List (PEL) + XAUTOCLAIM
    - Natural backpressure (BLOCK until messages available)

    Per-graph concurrency is enforced via asyncio.Semaphore keyed by
    (provider_id, graph_name). This prevents FalkorDB write lock
    contention when multiple jobs target the same graph.
    """

    def __init__(
        self,
        worker,
        session_factory,
        redis_client,
        max_concurrency: int = 4,
        max_per_graph: int = 2,
    ):
        self._worker = worker
        self._session_factory = session_factory
        self._redis = redis_client
        self._max_concurrency = max_concurrency
        self._max_per_graph = max_per_graph
        self._active_tasks: dict[str, asyncio.Task] = {}
        self._message_ids: dict[str, str] = {}  # job_id -> stream message_id
        self._shutdown_event = asyncio.Event()
        self._consumer_name = f"worker-{platform.node()}-{os.getpid()}"

        # Per-graph concurrency limiters
        self._graph_semaphores: dict[str, asyncio.Semaphore] = {}

    async def start(self) -> None:
        """Main consumer loop. Runs until shutdown is signalled."""
        from .redis_client import JOBS_STREAM, CONSUMER_GROUP, ensure_consumer_group

        await ensure_consumer_group()

        logger.info(
            "Job consumer started (consumer=%s, concurrency=%d, per_graph=%d)",
            self._consumer_name, self._max_concurrency, self._max_per_graph,
        )

        # Recover unACKed messages from previous crashes (PEL recovery)
        await self._recover_pending()

        while not self._shutdown_event.is_set():
            # Clean up completed tasks
            self._reap_done_tasks()

            available_slots = self._max_concurrency - len(self._active_tasks)
            if available_slots <= 0:
                # All slots busy — wait briefly for a task to complete
                await asyncio.sleep(0.5)
                continue

            try:
                # XREADGROUP: block up to 5s waiting for new messages
                entries = await self._redis.xreadgroup(
                    CONSUMER_GROUP,
                    self._consumer_name,
                    {JOBS_STREAM: ">"},
                    count=available_slots,
                    block=5000,
                )
            except asyncio.CancelledError:
                return
            except Exception as e:
                logger.error("XREADGROUP failed: %s (retrying in 2s)", e)
                await asyncio.sleep(2)
                continue

            if not entries:
                continue

            # entries = [(stream_name, [(msg_id, {field: value}), ...])]
            for _stream_name, messages in entries:
                for msg_id, fields in messages:
                    job_id = fields.get("job_id")
                    if not job_id:
                        logger.warning("Stream message %s has no job_id — ACKing", msg_id)
                        await self._ack(msg_id)
                        continue

                    if job_id in self._active_tasks:
                        logger.debug("Job %s already active — skipping duplicate", job_id)
                        await self._ack(msg_id)
                        continue

                    self._message_ids[job_id] = msg_id
                    task = asyncio.create_task(
                        self._run_with_limits(job_id),
                        name=f"aggregation-{job_id}",
                    )
                    self._active_tasks[job_id] = task

    async def _recover_pending(self) -> None:
        """Recover unACKed messages from the Pending Entry List (PEL).

        On startup, claim any messages that were delivered to consumers
        that crashed (idle > 60s). This replaces the old Postgres-based
        recover_interrupted_jobs() scan for the dispatch side of recovery.
        """
        from .redis_client import (
            JOBS_STREAM, CONSUMER_GROUP, DLQ_STREAM, MAX_DELIVERY_ATTEMPTS,
        )

        try:
            # XAUTOCLAIM: claim messages idle > 60s from any consumer in the group
            result = await self._redis.xautoclaim(
                JOBS_STREAM,
                CONSUMER_GROUP,
                self._consumer_name,
                min_idle_time=60000,  # 60 seconds
                start_id="0-0",
                count=self._max_concurrency,
            )

            if not result or len(result) < 2:
                return

            # result = (next_start_id, [(msg_id, fields), ...], [deleted_ids])
            claimed_messages = result[1] if len(result) > 1 else []

            for msg_id, fields in claimed_messages:
                job_id = fields.get("job_id")
                if not job_id:
                    await self._ack(msg_id)
                    continue

                # Check delivery count via XPENDING for this message
                try:
                    pending_info = await self._redis.xpending_range(
                        JOBS_STREAM, CONSUMER_GROUP,
                        min=msg_id, max=msg_id, count=1,
                    )
                    delivery_count = pending_info[0]["times_delivered"] if pending_info else 1
                except Exception:
                    delivery_count = 1

                if delivery_count > MAX_DELIVERY_ATTEMPTS:
                    # Move to dead letter queue
                    logger.warning(
                        "Job %s exceeded %d delivery attempts — moving to DLQ",
                        job_id, MAX_DELIVERY_ATTEMPTS,
                    )
                    await self._redis.xadd(
                        DLQ_STREAM,
                        {
                            "job_id": job_id,
                            "original_msg_id": msg_id,
                            "delivery_count": str(delivery_count),
                            "reason": "max_delivery_attempts_exceeded",
                        },
                    )
                    await self._ack(msg_id)
                    # Mark job as permanently failed
                    await self._mark_job_failed(
                        job_id,
                        f"Permanently failed: exceeded {MAX_DELIVERY_ATTEMPTS} delivery attempts",
                    )
                    continue

                logger.info(
                    "PEL recovery: claimed job %s (delivery_count=%d, msg_id=%s)",
                    job_id, delivery_count, msg_id,
                )
                self._message_ids[job_id] = msg_id
                task = asyncio.create_task(
                    self._run_with_limits(job_id),
                    name=f"aggregation-{job_id}",
                )
                self._active_tasks[job_id] = task

        except Exception as e:
            logger.warning("PEL recovery failed: %s (will retry on next cycle)", e)

    async def _run_with_limits(self, job_id: str) -> None:
        """Run a job with per-graph concurrency limiting.

        Looks up the graph key from the job record, then acquires the
        per-graph semaphore before executing. Jobs targeting different
        graphs run in full parallelism.
        """
        graph_key = await self._get_graph_key(job_id)

        if graph_key:
            sem = self._graph_semaphores.setdefault(
                graph_key, asyncio.Semaphore(self._max_per_graph),
            )
            async with sem:
                await self._execute_job(job_id)
        else:
            # No graph key found — run without per-graph limit
            await self._execute_job(job_id)

    async def _execute_job(self, job_id: str) -> None:
        """Execute a job and ACK/NACK based on outcome."""
        msg_id = self._message_ids.get(job_id)
        try:
            await self._worker.run(job_id)
            # Success — ACK the message
            if msg_id:
                await self._ack(msg_id)
            logger.info("Job %s completed and ACKed", job_id)
        except Exception as e:
            logger.error("Job %s failed with unhandled error: %s", job_id, e)
            # Don't ACK — the message stays in PEL for redelivery.
            # The worker.run() already marks the job as 'failed' in the DB
            # and preserves last_cursor for resume. The PEL recovery will
            # pick it up on next startup or via XAUTOCLAIM.
            if msg_id:
                await self._ack(msg_id)
                # We ACK even on failure because the job-level retry logic
                # (resume from checkpoint) is handled by the Control Plane,
                # not by redelivering the stream message. The job record in
                # Postgres IS the retry state.

    async def _get_graph_key(self, job_id: str) -> str | None:
        """Look up the actual graph key (provider_id:graph_name) for a job.

        Multiple data sources can point to the same FalkorDB graph.
        The per-graph semaphore must use the real graph identity, not
        data_source_id, otherwise three data sources on the same graph
        bypass the concurrency limit entirely.
        """
        from sqlalchemy import text as sa_text

        try:
            async with self._session_factory() as session:
                result = await session.execute(
                    sa_text(
                        "SELECT provider_id, graph_name, data_source_id "
                        "FROM aggregation.aggregation_jobs "
                        "WHERE id = :job_id"
                    ),
                    {"job_id": job_id},
                )
                row = result.first()
                if not row:
                    return None
                provider_id, graph_name, ds_id = row[0], row[1], row[2]
                # Use the real graph identity if available (denormalized columns)
                if provider_id and graph_name:
                    return f"{provider_id}:{graph_name}"
                # Fallback to data_source_id (pre-migration jobs)
                return ds_id
        except Exception as e:
            logger.warning("Failed to look up graph key for job %s: %s", job_id, e)
            return None

    async def _ack(self, msg_id: str) -> None:
        """ACK a message in the consumer group."""
        from .redis_client import JOBS_STREAM, CONSUMER_GROUP

        try:
            await self._redis.xack(JOBS_STREAM, CONSUMER_GROUP, msg_id)
        except Exception as e:
            logger.warning("XACK failed for msg %s: %s", msg_id, e)

    async def _mark_job_failed(self, job_id: str, error_message: str) -> None:
        """Mark a job as permanently failed in the database."""
        from datetime import datetime, timezone
        from sqlalchemy import text as sa_text

        try:
            async with self._session_factory() as session:
                await session.execute(
                    sa_text(
                        "UPDATE aggregation.aggregation_jobs "
                        "SET status = 'failed', "
                        "    error_message = :error, "
                        "    updated_at = :now "
                        "WHERE id = :job_id AND status IN ('pending', 'running')"
                    ),
                    {
                        "job_id": job_id,
                        "error": error_message[:2000],
                        "now": datetime.now(timezone.utc).isoformat(),
                    },
                )
                await session.commit()
        except Exception as e:
            logger.error("Failed to mark job %s as failed: %s", job_id, e)

    def _reap_done_tasks(self) -> None:
        """Clean up completed tasks and their message ID mappings."""
        done_ids = [jid for jid, t in self._active_tasks.items() if t.done()]
        for jid in done_ids:
            task = self._active_tasks.pop(jid)
            self._message_ids.pop(jid, None)
            if not task.cancelled():
                exc = task.exception()
                if exc:
                    logger.error("Job %s task exception: %s", jid, exc)

    def request_shutdown(self) -> None:
        """Signal the consumer to stop accepting new jobs."""
        self._shutdown_event.set()

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
            "consumer": consumer._consumer_name,
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
    from backend.app.db.engine import get_jobs_session
    from backend.app.providers.manager import ProviderManager
    from .worker import AggregationWorker
    from .db_init import init_aggregation_db
    from .redis_client import get_redis, close_redis

    logging.basicConfig(
        level=getattr(logging, os.getenv("LOG_LEVEL", "INFO")),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    concurrency = int(os.getenv("WORKER_CONCURRENCY", "4"))
    max_per_graph = int(os.getenv("MAX_CONCURRENT_PER_GRAPH", "2"))

    logger.info("=== Aggregation Worker (standalone) starting ===")
    logger.info(
        "Config: FALKORDB_SOCKET_TIMEOUT=%s, GRAPH_POOL=%s, REDIS_POOL=%s, "
        "CONCURRENCY=%d, MAX_PER_GRAPH=%d, REDIS_URL=%s",
        os.getenv("FALKORDB_SOCKET_TIMEOUT"),
        os.getenv("FALKORDB_GRAPH_POOL_SIZE"),
        os.getenv("FALKORDB_REDIS_POOL_SIZE"),
        concurrency, max_per_graph,
        os.getenv("REDIS_URL", "redis://localhost:6380/0"),
    )

    # Initialize aggregation DB (schema + tables, no Alembic needed)
    await init_aggregation_db()

    # OWN ProviderManager — completely separate from viz-service.
    # Own connection pools, own circuit breakers, own timeouts.
    # Provider failures here CANNOT affect the web tier.
    registry = ProviderManager()

    # Initialize Redis client
    redis_client = get_redis()

    # Create event publisher for status events
    from .events import AggregationEventPublisher
    event_publisher = AggregationEventPublisher(redis_client)

    # Create worker on the JOBS pool with event publisher
    worker = AggregationWorker(get_jobs_session, registry, event_publisher=event_publisher)

    # Create the job consumer (Redis Streams based)
    consumer = _JobConsumer(
        worker=worker,
        session_factory=get_jobs_session,
        redis_client=redis_client,
        max_concurrency=concurrency,
        max_per_graph=max_per_graph,
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
        await close_redis()
        logger.info("=== Aggregation Worker shutdown complete ===")


if __name__ == "__main__":
    asyncio.run(main())
