"""Redis-Streams-backed stats poller worker.

Mirrors ``backend.app.services.aggregation.__main__._JobConsumer`` —
same XREADGROUP/XAUTOCLAIM pattern, same per-graph semaphore for
contention control, same SIGTERM drain semantics. Differences:

* Jobs come from ``stats.jobs``, group ``stats-workers``.
* The envelope carries the full job payload (ds_id + workspace_id)
  instead of just a DB-row pointer, so there is no separate "load
  the job row" step.
* No per-job checkpoint table — successful polls upsert into
  ``data_source_stats`` and flip ``data_source_polling_configs.last_status``;
  failed polls (after max delivery attempts) go to ``stats.dlq`` and
  write ``last_error``.
"""
from __future__ import annotations

import asyncio
import logging
import os
import platform

import redis.asyncio as aioredis
from sqlalchemy import select

from backend.app.db.engine import PoolRole, get_session_factory
from backend.app.db.models import WorkspaceDataSourceORM
from backend.app.services.aggregation.redis_client import get_redis

from .config import StatsServiceConfig
from .collector import collect, record_failure
from .redis_streams import (
    CONSUMER_GROUP,
    JOBS_STREAM,
    release_claim,
    send_to_dlq,
)
from .schemas import StatsJobEnvelope
from .scheduler import get_known_node_counts

logger = logging.getLogger(__name__)


class StatsJobConsumer:
    """XREADGROUP-driven stats poll executor.

    One instance per process. Concurrency is enforced in two layers:
    * Global: ``worker_concurrency`` cap on ``_active_tasks``. XREADGROUP
      requests ``count = worker_concurrency - len(_active_tasks)``.
    * Per-graph: ``asyncio.Semaphore`` keyed by ``provider_id:graph_name``
      so multiple data sources sharing a graph don't scan it in parallel.
    """

    def __init__(self, config: StatsServiceConfig) -> None:
        self._config = config
        self._redis: aioredis.Redis = get_redis()
        self._shutdown = asyncio.Event()
        self._consumer_name = f"stats-{platform.node()}-{os.getpid()}"
        self._active_tasks: dict[str, asyncio.Task] = {}
        self._message_meta: dict[str, tuple[str, StatsJobEnvelope]] = {}
        self._graph_semaphores: dict[str, asyncio.Semaphore] = {}

    # ── Public API ───────────────────────────────────────────────

    @property
    def active_count(self) -> int:
        return len(self._active_tasks)

    @property
    def consumer_name(self) -> str:
        return self._consumer_name

    def request_shutdown(self) -> None:
        self._shutdown.set()

    async def run(self) -> None:
        logger.info(
            "Stats worker started (consumer=%s, concurrency=%d, per_graph=%d)",
            self._consumer_name,
            self._config.worker_concurrency,
            self._config.max_per_graph,
        )

        # Recover orphaned messages from previous replicas that crashed.
        await self._recover_pending()

        while not self._shutdown.is_set():
            self._reap_done_tasks()

            slots = self._config.worker_concurrency - len(self._active_tasks)
            if slots <= 0:
                await asyncio.sleep(0.25)
                continue

            try:
                entries = await self._redis.xreadgroup(
                    CONSUMER_GROUP,
                    self._consumer_name,
                    {JOBS_STREAM: ">"},
                    count=slots,
                    block=5000,
                )
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.warning("XREADGROUP failed: %s (retry in 2s)", exc)
                await asyncio.sleep(2)
                continue

            if not entries:
                continue

            for _stream, messages in entries:
                for msg_id, fields in messages:
                    self._spawn(msg_id, fields)

    async def drain(self, timeout: float) -> None:
        if not self._active_tasks:
            return
        logger.info("Draining %d active polls (timeout=%.0fs)...", len(self._active_tasks), timeout)
        tasks = list(self._active_tasks.values())
        done, pending = await asyncio.wait(tasks, timeout=timeout)
        if pending:
            logger.warning("%d polls did not finish in time; cancelling", len(pending))
            for t in pending:
                t.cancel()
            await asyncio.gather(*pending, return_exceptions=True)

    # ── Internal: dispatch + execution ───────────────────────────

    def _spawn(self, msg_id: str, fields: dict[str, str]) -> None:
        try:
            envelope = StatsJobEnvelope.from_stream_fields(fields)
        except Exception as exc:
            logger.error("Malformed envelope in msg %s: %s — ACKing and dropping", msg_id, exc)
            asyncio.create_task(self._ack(msg_id))
            return

        if msg_id in self._active_tasks:
            # Shouldn't happen under normal flow; XREADGROUP with '>' never
            # redelivers to the same consumer without XAUTOCLAIM.
            return

        self._message_meta[msg_id] = (envelope.data_source_id, envelope)
        task = asyncio.create_task(
            self._execute(msg_id, envelope),
            name=f"stats-{envelope.data_source_id}",
        )
        self._active_tasks[msg_id] = task

    async def _execute(self, msg_id: str, envelope: StatsJobEnvelope) -> None:
        graph_key = await self._resolve_graph_key(envelope.data_source_id)
        sem: asyncio.Semaphore | None = None
        if graph_key:
            sem = self._graph_semaphores.setdefault(
                graph_key, asyncio.Semaphore(self._config.max_per_graph)
            )

        try:
            if sem is not None:
                async with sem:
                    await self._run_poll(msg_id, envelope)
            else:
                await self._run_poll(msg_id, envelope)
        except Exception:
            # _run_poll already handled DLQ / error bookkeeping.
            pass

    async def _run_poll(self, msg_id: str, envelope: StatsJobEnvelope) -> None:
        ds_id = envelope.data_source_id
        node_counts = await get_known_node_counts()
        node_count = node_counts.get(ds_id, 0)
        timeout = self._config.resolve_poll_timeout(node_count)
        factory = get_session_factory(PoolRole.JOBS)

        # Bucket the node count so a histogram dashboard can chart by
        # size class (small <10k, med 10k-100k, large 100k-1M, xlarge 1M+).
        if node_count < 10_000:
            size_bucket = "small"
        elif node_count < 100_000:
            size_bucket = "medium"
        elif node_count < 1_000_000:
            size_bucket = "large"
        else:
            size_bucket = "xlarge"

        logger.info(
            "stats_poll.start ds_id=%s workspace=%s timeout_secs=%.0f node_count=%d size_bucket=%s",
            ds_id, envelope.workspace_id, timeout, node_count, size_bucket,
        )
        start_ts = asyncio.get_event_loop().time()
        try:
            async with factory() as session:
                await asyncio.wait_for(collect(session, envelope), timeout=timeout)
                await session.commit()
        except asyncio.TimeoutError:
            duration = asyncio.get_event_loop().time() - start_ts
            logger.warning(
                "stats_poll.timeout ds_id=%s duration_secs=%.2f timeout_secs=%.0f size_bucket=%s",
                ds_id, duration, timeout, size_bucket,
            )
            await self._handle_failure(msg_id, envelope, f"poll timed out after {timeout:.0f}s")
            return
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            duration = asyncio.get_event_loop().time() - start_ts
            logger.error(
                "stats_poll.failure ds_id=%s duration_secs=%.2f size_bucket=%s error=%s",
                ds_id, duration, size_bucket, exc, exc_info=True,
            )
            await self._handle_failure(msg_id, envelope, str(exc))
            return

        await self._ack(msg_id)
        await release_claim(ds_id)
        duration = asyncio.get_event_loop().time() - start_ts
        logger.info(
            "stats_poll.completion ds_id=%s duration_secs=%.2f size_bucket=%s",
            ds_id, duration, size_bucket,
        )

    async def _handle_failure(
        self, msg_id: str, envelope: StatsJobEnvelope, error: str
    ) -> None:
        """Decide retry vs DLQ based on XPENDING delivery count."""
        delivery_count = await self._delivery_count(msg_id)
        max_attempts = self._config.max_delivery_attempts

        # Always record the error on the polling config so operators can see.
        try:
            factory = get_session_factory(PoolRole.JOBS)
            async with factory() as session:
                await record_failure(session, envelope.data_source_id, error)
                await session.commit()
        except Exception as exc:
            logger.warning("Failed to persist last_error for ds=%s: %s", envelope.data_source_id, exc)

        if delivery_count >= max_attempts:
            logger.error(
                "Poll ds=%s exceeded %d delivery attempts — DLQ",
                envelope.data_source_id, max_attempts,
            )
            await send_to_dlq(msg_id, envelope.to_stream_fields(), reason=error[:200])
            await self._ack(msg_id)
            await release_claim(envelope.data_source_id)
            return

        # Do NOT XACK — message stays in PEL for XAUTOCLAIM redelivery.
        # Drop the dedup claim so the scheduler doesn't block the retry;
        # the XAUTOCLAIM path will re-deliver the existing stream message.
        await release_claim(envelope.data_source_id)

    # ── PEL recovery ─────────────────────────────────────────────

    async def _recover_pending(self) -> None:
        try:
            result = await self._redis.xautoclaim(
                JOBS_STREAM,
                CONSUMER_GROUP,
                self._consumer_name,
                min_idle_time=60_000,
                start_id="0-0",
                count=self._config.worker_concurrency,
            )
        except Exception as exc:
            logger.warning("XAUTOCLAIM failed (continuing): %s", exc)
            return

        if not result or len(result) < 2:
            return

        claimed = result[1] if len(result) > 1 else []
        for msg_id, fields in claimed:
            try:
                envelope = StatsJobEnvelope.from_stream_fields(fields)
            except Exception as exc:
                logger.error("Orphaned msg %s has malformed envelope: %s — ACKing", msg_id, exc)
                await self._ack(msg_id)
                continue

            delivery_count = await self._delivery_count(msg_id)
            if delivery_count >= self._config.max_delivery_attempts:
                logger.warning(
                    "Recovered msg %s (ds=%s) already at %d attempts — DLQ",
                    msg_id, envelope.data_source_id, delivery_count,
                )
                await send_to_dlq(msg_id, fields, reason="max_delivery_attempts_exceeded")
                await self._ack(msg_id)
                await release_claim(envelope.data_source_id)
                continue

            logger.info(
                "XAUTOCLAIM recovered msg %s (ds=%s, delivery_count=%d)",
                msg_id, envelope.data_source_id, delivery_count,
            )
            # Rehydrate as if XREADGROUP just delivered it.
            self._spawn(msg_id, fields)

    # ── Helpers ──────────────────────────────────────────────────

    async def _delivery_count(self, msg_id: str) -> int:
        try:
            pending = await self._redis.xpending_range(
                JOBS_STREAM, CONSUMER_GROUP, min=msg_id, max=msg_id, count=1
            )
        except Exception:
            return 1
        if not pending:
            return 1
        return int(pending[0].get("times_delivered", 1))

    async def _resolve_graph_key(self, ds_id: str) -> str | None:
        """Build ``provider_id:graph_name`` key for per-graph semaphore."""
        try:
            factory = get_session_factory(PoolRole.READONLY)
            async with factory() as session:
                row = (
                    await session.execute(
                        select(WorkspaceDataSourceORM.provider_id, WorkspaceDataSourceORM.graph_name)
                        .where(WorkspaceDataSourceORM.id == ds_id)
                    )
                ).first()
                if not row:
                    return None
                provider_id, graph_name = row[0], row[1]
                if provider_id and graph_name:
                    return f"{provider_id}:{graph_name}"
                return provider_id or ds_id
        except Exception as exc:
            logger.warning("Failed to resolve graph key for ds=%s: %s", ds_id, exc)
            return None

    async def _ack(self, msg_id: str) -> None:
        try:
            await self._redis.xack(JOBS_STREAM, CONSUMER_GROUP, msg_id)
        except Exception as exc:
            logger.warning("XACK failed for %s: %s", msg_id, exc)

    def _reap_done_tasks(self) -> None:
        done = [mid for mid, t in self._active_tasks.items() if t.done()]
        for mid in done:
            task = self._active_tasks.pop(mid)
            self._message_meta.pop(mid, None)
            if not task.cancelled():
                exc = task.exception()
                if exc:
                    logger.error("Task for msg %s finished with exception: %s", mid, exc)
