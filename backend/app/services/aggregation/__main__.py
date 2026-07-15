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
    AGGREGATION_STALL_TIMEOUT_SECS  Kill a job with NO forward progress
                               for this long (default: 900). Replaces the
                               old fixed per-job timeout — a progressing
                               job is never killed by a timer.
    AGGREGATION_JOB_MAX_WALL_SECS   Absolute wall-clock safety net
                               (default: 86400)
    FALKORDB_ENDPOINT_WRITE_SLOTS   Cross-pod concurrent aggregation write
                               budget per FalkorDB endpoint (default: 2)
    WORKER_HEALTH_PORT         Health endpoint port (default: 8090)
    LOG_LEVEL                  Logging level (default: INFO)
"""
import asyncio
import contextlib
import logging
import os
import platform
import signal
import uuid

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
# The provider cache client now sizes its pool from the central CACHE role
# (REDIS_CACHE_MAX_CONNECTIONS), not FALKORDB_REDIS_POOL_SIZE — mirror the
# same auto-scale-by-concurrency value there, or a worker under load would
# silently fall back to the role's fixed default pool size.
if "REDIS_CACHE_MAX_CONNECTIONS" not in os.environ:
    os.environ["REDIS_CACHE_MAX_CONNECTIONS"] = str(_concurrency * 3 + 8)


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
        fleet=None,
    ):
        self._worker = worker
        self._session_factory = session_factory
        self._redis = redis_client
        self._max_concurrency = max_concurrency
        self._max_per_graph = max_per_graph
        self._fleet = fleet
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

            # Fleet registry heartbeat (TTL'd) — the XREADGROUP BLOCK below
            # bounds this loop to ~5s ticks, well inside the 30s TTL.
            if self._fleet is not None:
                await self._fleet.heartbeat()

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
                # Auth-class errors (rotated/wrong bus password) log an
                # actionable line and back off long; blips keep the 2s retry.
                from backend.common.adapters.redis_bus import bus_error_retry_delay
                await asyncio.sleep(
                    bus_error_retry_delay(e, logger, what="XREADGROUP")
                )
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

                    # Memory-aware claim policy: defer work this pod cannot
                    # safely hold (drain / RSS high-water / large-job cap) by
                    # re-enqueueing it for an idle sibling.
                    if self._fleet is not None:
                        meta = await self._get_job_meta(job_id)
                        reason = self._fleet.claim_decision(
                            total_edges=(meta or {}).get("total_edges"),
                        )
                        if reason is not None:
                            asyncio.create_task(
                                self._requeue(job_id, msg_id, reason),
                                name=f"agg-requeue-{job_id}",
                            )
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
        meta = await self._get_job_meta(job_id)
        graph_key = (meta or {}).get("graph_key")
        if self._fleet is not None:
            from .fleet import WorkerFleetMember
            self._fleet.register_job(
                job_id,
                graph_name=(meta or {}).get("graph_name"),
                large=WorkerFleetMember.is_large((meta or {}).get("total_edges")),
            )
        try:
            await self._run_with_graph_limit(job_id, graph_key)
        finally:
            if self._fleet is not None:
                self._fleet.unregister_job(job_id)

    async def _run_with_graph_limit(self, job_id: str, graph_key) -> None:
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
        """Execute a job under a per-job SINGLE-ACTIVE execution lock.

        This is the guarantee that one job_id is run by exactly one executor
        at a time, no matter how it was (re)delivered — XAUTOCLAIM reclaim,
        duplicate XADD, a restarted worker, or extra replicas. Losers ACK +
        skip. If the holder dies, the lock TTL expires and the reconciler
        re-dispatches it to resume from the last checkpoint.
        """
        msg_id = self._message_ids.get(job_id)

        # Durable cancel: a job cancelled before this (re)delivery never runs.
        if await self._is_cancelled(job_id):
            logger.info("Job %s is cancelled — marking cancelled, skipping", job_id)
            await self._mark_job_cancelled(job_id)
            if msg_id:
                await self._ack(msg_id)
            return

        token = await self._acquire_exec_lock(job_id)
        if token is None:
            logger.info(
                "Job %s already has a live executor (exec lock held) — "
                "ACK + skip duplicate delivery", job_id,
            )
            if msg_id:
                await self._ack(msg_id)
            return

        # We own the lock. A reclaim of an ALREADY-finished job must not re-run.
        status = await self._get_job_status(job_id)
        if status in ("completed", "cancelled"):
            logger.info("Job %s already %s — release lock + skip", job_id, status)
            await self._release_exec_lock(job_id, token)
            if msg_id:
                await self._ack(msg_id)
            return

        # ACK the stream message now: liveness is tracked by the lock heartbeat
        # from here on, so the PEL doesn't linger and repeated reclaims of a
        # healthy job can't push it to the DLQ. Crash recovery is the
        # reconciler's lock-aware re-dispatch, not stream redelivery.
        if msg_id:
            await self._ack(msg_id)

        # Run the job as a cancellable task so the heartbeat can ABORT it if we
        # ever lose the lock (a long Redis blip could let the TTL expire while
        # we're still running — without aborting, a second worker would acquire
        # the lock and double-execute). Losing the lock => stop running.
        run_task = asyncio.create_task(
            self._worker.run(job_id), name=f"agg-run-{job_id}",
        )
        heartbeat = asyncio.create_task(
            self._renew_exec_lock(job_id, token, run_task),
            name=f"agg-lock-{job_id}",
        )
        try:
            await run_task
            logger.info("Job %s completed", job_id)
        except asyncio.CancelledError:
            logger.warning(
                "Job %s aborted — lost the exec lock; the reconciler will "
                "resume it under a fresh single-active holder", job_id,
            )
        except Exception as e:
            # worker.run() already persisted status + last_cursor for resume.
            logger.error("Job %s failed with unhandled error: %s", job_id, e)
        finally:
            heartbeat.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await heartbeat
            await self._release_exec_lock(job_id, token)

    # ── Single-active execution lock helpers ────────────────────────

    async def _acquire_exec_lock(self, job_id: str) -> str | None:
        """SET agg:exec:{job_id} <token> NX PX ttl. Returns the token on
        success, or None when another live executor already holds it."""
        from .redis_client import exec_lock_key, EXEC_LOCK_TTL_MS

        token = f"{self._consumer_name}-{uuid.uuid4().hex}"
        try:
            ok = await self._redis.set(
                exec_lock_key(job_id), token, nx=True, px=EXEC_LOCK_TTL_MS,
            )
        except Exception as e:
            logger.warning("exec-lock acquire failed for %s: %s", job_id, e)
            return None
        return token if ok else None

    async def _renew_exec_lock(
        self, job_id: str, token: str, run_task: asyncio.Task,
    ) -> None:
        """Heartbeat: re-extend the lock TTL every ~TTL/3 while we still own
        it. If we LOSE the lock — another holder took over (renew returns 0),
        or Redis was unreachable long enough that the TTL surely expired —
        ABORT ``run_task`` so we never run without the lock (single-active)."""
        from .redis_client import exec_lock_key, EXEC_LOCK_TTL_MS

        ttl_s = EXEC_LOCK_TTL_MS / 1000.0
        interval = max(1.0, ttl_s / 3.0)
        key = exec_lock_key(job_id)
        renew_lua = (
            "if redis.call('get', KEYS[1]) == ARGV[1] then "
            "return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end"
        )
        import time as _time
        last_ok = _time.monotonic()
        try:
            while True:
                await asyncio.sleep(interval)
                try:
                    res = await self._redis.eval(
                        renew_lua, 1, key, token, EXEC_LOCK_TTL_MS,
                    )
                except asyncio.CancelledError:
                    return
                except Exception as e:
                    # Transient Redis error: keep trying, but if we can't
                    # confirm ownership for longer than the TTL the lock has
                    # surely expired and someone else may hold it → abort.
                    if (_time.monotonic() - last_ok) >= ttl_s:
                        logger.error(
                            "exec-lock for %s un-renewable for >%.0fs (%s) — "
                            "aborting run to preserve single-active", job_id, ttl_s, e,
                        )
                        run_task.cancel()
                        return
                    continue
                if not res:
                    logger.warning(
                        "exec-lock for %s lost (taken over / expired) — "
                        "aborting run", job_id,
                    )
                    run_task.cancel()
                    return
                last_ok = _time.monotonic()
        except asyncio.CancelledError:
            return

    async def _release_exec_lock(self, job_id: str, token: str) -> None:
        """Compare-and-DEL: release only if we still own the lock."""
        from .redis_client import exec_lock_key

        del_lua = (
            "if redis.call('get', KEYS[1]) == ARGV[1] then "
            "return redis.call('del', KEYS[1]) else return 0 end"
        )
        try:
            await self._redis.eval(del_lua, 1, exec_lock_key(job_id), token)
        except Exception as e:
            logger.warning("exec-lock release error for %s: %s", job_id, e)

    async def _is_cancelled(self, job_id: str) -> bool:
        from .redis_client import cancel_flag_key

        try:
            return bool(await self._redis.get(cancel_flag_key(job_id)))
        except Exception:
            return False

    async def _get_job_status(self, job_id: str) -> str | None:
        from sqlalchemy import text as sa_text

        try:
            async with self._session_factory() as session:
                res = await session.execute(
                    sa_text(
                        "SELECT status FROM aggregation.aggregation_jobs "
                        "WHERE id = :j"
                    ),
                    {"j": job_id},
                )
                row = res.first()
                return row[0] if row else None
        except Exception:
            return None

    async def _mark_job_cancelled(self, job_id: str) -> None:
        from datetime import datetime, timezone
        from sqlalchemy import text as sa_text

        now = datetime.now(timezone.utc).isoformat()
        try:
            async with self._session_factory() as session:
                await session.execute(
                    sa_text(
                        "UPDATE aggregation.aggregation_jobs "
                        "SET status='cancelled', completed_at=:n, updated_at=:n "
                        "WHERE id=:j AND status NOT IN ('completed','cancelled')"
                    ),
                    {"n": now, "j": job_id},
                )
                await session.commit()
        except Exception as e:
            logger.warning("Failed to mark job %s cancelled: %s", job_id, e)

    async def _requeue(self, job_id: str, msg_id: str | None, reason: str) -> None:
        """Give a job this pod cannot take back to the stream after a short
        jittered delay (so an idle sibling wins the race), then ACK the
        original delivery. Exec locks + cancel flags make duplicate
        delivery safe; while we sleep the message stays in our PEL, so a
        crash here is recovered by XAUTOCLAIM."""
        import random as _random
        from .redis_client import JOBS_STREAM

        logger.info("Deferring job %s: %s — re-enqueueing", job_id, reason)
        await asyncio.sleep(1.0 + _random.uniform(0, 2.0))
        try:
            await self._redis.xadd(JOBS_STREAM, {"job_id": job_id}, maxlen=50000)
        except Exception as exc:
            logger.warning(
                "Re-enqueue of deferred job %s failed (%s) — leaving the "
                "original delivery unACKed for PEL recovery", job_id, exc,
            )
            return
        if msg_id:
            await self._ack(msg_id)

    async def _get_job_meta(self, job_id: str) -> dict | None:
        """Job metadata for claim/limit decisions: graph key + total_edges."""
        from sqlalchemy import text as sa_text

        try:
            async with self._session_factory() as session:
                result = await session.execute(
                    sa_text(
                        "SELECT provider_id, graph_name, data_source_id, total_edges "
                        "FROM aggregation.aggregation_jobs WHERE id = :job_id"
                    ),
                    {"job_id": job_id},
                )
                row = result.first()
                if not row:
                    return None
                provider_id, graph_name, ds_id, total_edges = row
                graph_key = (
                    f"{provider_id}:{graph_name}"
                    if provider_id and graph_name else ds_id
                )
                return {
                    "graph_key": graph_key,
                    "graph_name": graph_name,
                    "total_edges": total_edges,
                }
        except Exception as e:
            logger.warning("Failed to look up job meta for %s: %s", job_id, e)
            return None

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
    """Wrap the shared health-server helper with this worker's status payload."""
    from backend.app.common.health_server import run_health_server

    def _payload() -> dict:
        return {
            "activeJobs": len(consumer._active_tasks),
            "consumer": consumer._consumer_name,
        }

    await run_health_server(port, role="aggregation-worker", status_payload_fn=_payload)


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

    # ...which also means this process needs its OWN warmup loop. It is what
    # drives record_probe_success on a provider's false→true transition, which
    # force-closes the breakers and EVICTS the cached provider so its pool is
    # rebuilt against the new pod. Without it the worker self-healed only via the
    # 30s breaker cooldown while holding a pool of dead sockets pointing at the
    # pre-rotation FalkorDB — every job paid a failed round-trip first.
    warmup_shutdown = asyncio.Event()
    warmup_tasks: list = []
    try:
        from backend.app.providers.warmup import start_provider_warmup
        warmup_tasks = await start_provider_warmup(
            registry, shutdown_event=warmup_shutdown,
        )
        logger.info("Provider warmup supervisor started (worker tier)")
    except Exception as exc:
        logger.warning(
            "Provider warmup loop failed to start: %s — this worker will still "
            "self-heal via the breaker cooldown, just without proactive pool "
            "eviction on recovery", exc,
        )

    # Initialize Redis client
    redis_client = get_redis()

    # Create event publisher for status events
    from .events import AggregationEventPublisher
    event_publisher = AggregationEventPublisher(redis_client)

    # Fleet registry member: heartbeats this worker's load/memory to the
    # bus Redis and drives the memory-aware claim policy.
    from .fleet import WorkerFleetMember
    worker_id = f"worker-{platform.node()}-{os.getpid()}"
    fleet = WorkerFleetMember(redis_client, worker_id, concurrency)

    # Create worker on the JOBS pool with event publisher
    worker = AggregationWorker(
        get_jobs_session, registry, event_publisher=event_publisher,
        worker_id=worker_id,
    )

    # Create the job consumer (Redis Streams based)
    consumer = _JobConsumer(
        worker=worker,
        session_factory=get_jobs_session,
        redis_client=redis_client,
        max_concurrency=concurrency,
        max_per_graph=max_per_graph,
        fleet=fleet,
    )

    # Start health endpoint
    health_port = int(os.getenv("WORKER_HEALTH_PORT", "8090"))
    try:
        await _run_health_server(consumer, health_port)
    except Exception as e:
        logger.warning("Health endpoint failed to start: %s (continuing without it)", e)

    # Cross-process provider invalidation — this worker owns its OWN
    # ProviderManager + registry caches, so an admin repointing a provider in the
    # web tier would otherwise leave it reading/writing the OLD instance (with the
    # OLD credentials) until restart. The warmup loop can't rescue it: after a
    # repoint the old host usually still answers, so there is no false→true
    # transition to trigger the recovery eviction.
    from backend.app.providers.invalidation_bus import ProviderInvalidationListener
    invalidation_listener = ProviderInvalidationListener(
        redis_client, provider_manager=registry,
    )
    try:
        await invalidation_listener.start()
    except Exception as e:
        logger.warning("Provider invalidation listener failed to start: %s", e)

    # Cross-process cancel bridge — subscribes to the Redis Pub/Sub
    # control channel and forwards into this process's local
    # CancelRegistry. Without this, cancel requests issued by the web
    # tier never reach jobs running in this worker process.
    from .cancel import CancelListener
    cancel_listener = CancelListener(redis_client)
    try:
        await cancel_listener.start()
    except Exception as e:
        logger.warning(
            "Cancel listener failed to start: %s (cancels for jobs hosted "
            "in this worker will fall back to dispatcher.task.cancel())", e,
        )

    # Register signal handlers for graceful shutdown
    loop = asyncio.get_running_loop()

    def _signal_handler():
        logger.info("Received shutdown signal — draining (no new claims)...")
        fleet.drain = True
        consumer.request_shutdown()

    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, _signal_handler)

    # Run the consumer loop
    try:
        await consumer.start()
    finally:
        logger.info("Consumer stopped — draining active jobs...")
        await consumer.drain(timeout=60.0)
        try:
            await cancel_listener.stop()
        except Exception:
            pass
        try:
            await invalidation_listener.stop()
        except Exception:
            pass
        warmup_shutdown.set()
        for _t in warmup_tasks:
            if not _t.done():
                _t.cancel()
        if warmup_tasks:
            await asyncio.gather(*warmup_tasks, return_exceptions=True)
        await registry.evict_all()
        await fleet.deregister()
        await close_redis()
        logger.info("=== Aggregation Worker shutdown complete ===")


if __name__ == "__main__":
    asyncio.run(main())
