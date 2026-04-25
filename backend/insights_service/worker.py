"""Redis-Streams-backed multi-kind insights worker.

One process consumes three streams via a shared consumer group:

* ``insights.jobs.stats``     → kind ``stats_poll``     → ``collector.collect``
* ``insights.jobs.discovery`` → kind ``discovery``      → ``discovery.collect``
* ``insights.jobs.schema``    → kind ``schema_refresh`` → registered handler

Dispatch is driven by the envelope's ``kind`` field; handlers are
self-registered via ``dispatcher.register_handler``. Concurrency
controls layer cleanly on top:

* Global ``worker_concurrency`` cap on ``_active_tasks``.
* Per-scope ``asyncio.Semaphore`` keyed off the envelope's
  ``scope_key`` (``data_source_id`` for stats/schema, or
  ``provider_id:asset_name`` for discovery) so two messages targeting
  the same upstream resource never run in parallel.
* Per-provider admission control — token bucket + circuit breaker — is
  applied inside each handler via ``admission.gate(provider_id)``;
  worker only handles message-level orchestration.

Failures route to ``insights.dlq`` after ``STATS_MAX_DELIVERY_ATTEMPTS``;
operators can XADD redrive entries by reading ``original_stream`` and
``kind`` off the DLQ payload.
"""
from __future__ import annotations

import asyncio
import logging
import os
import platform

import redis.asyncio as aioredis

from backend.app.db.engine import PoolRole, get_session_factory
from backend.app.services.aggregation.redis_client import get_redis

from . import dispatcher
from .collector import record_failure as stats_record_failure  # noqa: F401  (forces self-registration)
from .config import StatsServiceConfig
from .discovery import record_failure as discovery_record_failure  # noqa: F401
from .redis_streams import (
    ALL_STREAMS,
    SHARED_GROUP,
    StreamConfig,
    release_claim,
    send_to_dlq,
)
from .schemas import (
    DiscoveryJobEnvelope,
    JobEnvelope,
    SchemaJobEnvelope,
    StatsJobEnvelope,
    parse_envelope,
)
from .scheduler import get_known_node_counts

logger = logging.getLogger(__name__)


# Map stream key (Redis stream name) → its StreamConfig, used at ACK /
# XAUTOCLAIM time to dispatch back to the right stream.
_STREAM_BY_NAME: dict[str, StreamConfig] = {s.stream: s for s in ALL_STREAMS}


class InsightsJobConsumer:
    """Multi-stream XREADGROUP loop.

    The class name preserves the public API as ``StatsJobConsumer`` is
    re-exported below so :mod:`__main__` keeps working without edits.
    """

    # Per-data-source graph-key cache (data_source_id → "provider:graph").
    # Bounded so a long-lived worker doesn't accumulate stale rows for
    # deleted data sources; the LRU eviction path keeps memory flat at
    # high churn. Mutated only from the worker coroutine, no lock needed.
    _SCOPE_KEY_CACHE_MAX = 1024
    _scope_key_cache: dict[str, str | None] = {}

    def __init__(self, config: StatsServiceConfig) -> None:
        self._config = config
        self._redis: aioredis.Redis = get_redis()
        self._shutdown = asyncio.Event()
        self._consumer_name = f"insights-{platform.node()}-{os.getpid()}"
        self._active_tasks: dict[str, asyncio.Task] = {}
        # msg_id → (stream_config, scope_key, envelope) for ACK / DLQ routing.
        self._message_meta: dict[str, tuple[StreamConfig, str, JobEnvelope]] = {}
        # scope_key → Semaphore for per-scope contention control.
        self._scope_semaphores: dict[str, asyncio.Semaphore] = {}

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
        kinds = ", ".join(s.kind for s in ALL_STREAMS)
        logger.info(
            "Insights worker started (consumer=%s, concurrency=%d, per_scope=%d, kinds=[%s])",
            self._consumer_name,
            self._config.worker_concurrency,
            self._config.max_per_graph,
            kinds,
        )

        # Recover orphaned messages from previous replicas that crashed.
        for cfg in ALL_STREAMS:
            await self._recover_pending(cfg)

        # Pre-build the multi-stream descriptor; XREADGROUP can take all
        # three streams in one call so we don't have to round-robin.
        streams_dict = {s.stream: ">" for s in ALL_STREAMS}

        while not self._shutdown.is_set():
            self._reap_done_tasks()

            slots = self._config.worker_concurrency - len(self._active_tasks)
            if slots <= 0:
                await asyncio.sleep(0.25)
                continue

            try:
                entries = await self._redis.xreadgroup(
                    SHARED_GROUP,
                    self._consumer_name,
                    streams_dict,
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

            for stream_name, messages in entries:
                stream_cfg = _STREAM_BY_NAME.get(_decode(stream_name))
                if stream_cfg is None:
                    logger.warning("Received entries from unknown stream %r — skipping", stream_name)
                    continue
                for msg_id, fields in messages:
                    self._spawn(stream_cfg, msg_id, fields)

    async def drain(self, timeout: float) -> None:
        if not self._active_tasks:
            return
        logger.info(
            "Draining %d active jobs (timeout=%.0fs)...",
            len(self._active_tasks), timeout,
        )
        tasks = list(self._active_tasks.values())
        done, pending = await asyncio.wait(tasks, timeout=timeout)
        if pending:
            logger.warning("%d jobs did not finish in time; cancelling", len(pending))
            for t in pending:
                t.cancel()
            await asyncio.gather(*pending, return_exceptions=True)

    # ── Internal: dispatch + execution ───────────────────────────

    def _spawn(
        self,
        stream_cfg: StreamConfig,
        msg_id_raw,
        fields_raw: dict,
    ) -> None:
        msg_id = _decode(msg_id_raw)
        fields = {_decode(k): _decode(v) for k, v in fields_raw.items()}

        try:
            envelope = parse_envelope(fields)
        except Exception as exc:
            logger.error(
                "Malformed envelope on stream=%s msg=%s: %s — ACKing and dropping",
                stream_cfg.stream, msg_id, exc,
            )
            asyncio.create_task(self._ack(stream_cfg, msg_id))
            return

        if msg_id in self._active_tasks:
            return

        scope_key = envelope.scope_key
        self._message_meta[msg_id] = (stream_cfg, scope_key, envelope)
        task = asyncio.create_task(
            self._execute(stream_cfg, msg_id, envelope),
            name=f"{envelope.kind}-{scope_key}",
        )
        self._active_tasks[msg_id] = task

    async def _execute(
        self,
        stream_cfg: StreamConfig,
        msg_id: str,
        envelope: JobEnvelope,
    ) -> None:
        sem_key = await self._resolve_scope_lock_key(envelope)
        sem: asyncio.Semaphore | None = None
        if sem_key:
            sem = self._scope_semaphores.setdefault(
                sem_key, asyncio.Semaphore(self._config.max_per_graph)
            )

        try:
            if sem is not None:
                async with sem:
                    await self._run_handler(stream_cfg, msg_id, envelope)
            else:
                await self._run_handler(stream_cfg, msg_id, envelope)
        except Exception:
            # _run_handler already routed to retry / DLQ.
            pass

    async def _run_handler(
        self,
        stream_cfg: StreamConfig,
        msg_id: str,
        envelope: JobEnvelope,
    ) -> None:
        timeout, size_bucket = await self._resolve_timeout_and_bucket(envelope)
        factory = get_session_factory(PoolRole.JOBS)

        logger.info(
            "%s.start scope=%s timeout_secs=%.0f size_bucket=%s",
            envelope.kind, envelope.scope_key, timeout, size_bucket,
        )
        start_ts = asyncio.get_event_loop().time()

        try:
            handler = dispatcher.get_handler(envelope.kind)
        except ValueError as exc:
            await self._handle_failure(stream_cfg, msg_id, envelope, str(exc))
            return

        try:
            async with factory() as session:
                await asyncio.wait_for(handler(session, envelope), timeout=timeout)
                await session.commit()
        except asyncio.TimeoutError:
            duration = asyncio.get_event_loop().time() - start_ts
            logger.warning(
                "%s.timeout scope=%s duration_secs=%.2f timeout_secs=%.0f size_bucket=%s",
                envelope.kind, envelope.scope_key, duration, timeout, size_bucket,
            )
            await self._handle_failure(stream_cfg, msg_id, envelope, f"job timed out after {timeout:.0f}s")
            return
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            duration = asyncio.get_event_loop().time() - start_ts
            logger.error(
                "%s.failure scope=%s duration_secs=%.2f size_bucket=%s error=%s",
                envelope.kind, envelope.scope_key, duration, size_bucket,
                exc, exc_info=True,
            )
            await self._handle_failure(stream_cfg, msg_id, envelope, str(exc))
            return

        await self._ack(stream_cfg, msg_id)
        await release_claim(envelope.scope_key, stream=stream_cfg)
        duration = asyncio.get_event_loop().time() - start_ts
        logger.info(
            "%s.completion scope=%s duration_secs=%.2f size_bucket=%s",
            envelope.kind, envelope.scope_key, duration, size_bucket,
        )

    async def _handle_failure(
        self,
        stream_cfg: StreamConfig,
        msg_id: str,
        envelope: JobEnvelope,
        error: str,
    ) -> None:
        """Persist the per-scope error, then decide retry vs DLQ based
        on XPENDING delivery count."""
        delivery_count = await self._delivery_count(stream_cfg, msg_id)
        max_attempts = self._config.max_delivery_attempts

        # Best-effort per-kind error persistence — never fatal.
        try:
            factory = get_session_factory(PoolRole.JOBS)
            async with factory() as session:
                if isinstance(envelope, (StatsJobEnvelope, SchemaJobEnvelope)):
                    await stats_record_failure(session, envelope.data_source_id, error)
                elif isinstance(envelope, DiscoveryJobEnvelope):
                    await discovery_record_failure(
                        session, envelope.provider_id, envelope.asset_name, error
                    )
                await session.commit()
        except Exception as exc:
            logger.warning(
                "Failed to persist last_error kind=%s scope=%s: %s",
                envelope.kind, envelope.scope_key, exc,
            )

        if delivery_count >= max_attempts:
            logger.error(
                "Job kind=%s scope=%s exceeded %d delivery attempts — DLQ",
                envelope.kind, envelope.scope_key, max_attempts,
            )
            await send_to_dlq(
                msg_id, envelope.to_stream_fields(), reason=error[:200],
                stream=stream_cfg,
            )
            await self._ack(stream_cfg, msg_id)
            await release_claim(envelope.scope_key, stream=stream_cfg)
            return

        # Do NOT XACK — message stays in PEL for XAUTOCLAIM redelivery.
        # Drop the dedup claim so a fresh enqueue isn't blocked; the
        # XAUTOCLAIM path re-delivers the existing stream message anyway.
        await release_claim(envelope.scope_key, stream=stream_cfg)

    # ── PEL recovery ─────────────────────────────────────────────

    async def _recover_pending(self, stream_cfg: StreamConfig) -> None:
        try:
            result = await self._redis.xautoclaim(
                stream_cfg.stream,
                stream_cfg.group,
                self._consumer_name,
                min_idle_time=60_000,
                start_id="0-0",
                count=self._config.worker_concurrency,
            )
        except Exception as exc:
            logger.warning(
                "XAUTOCLAIM failed for stream %s (continuing): %s",
                stream_cfg.stream, exc,
            )
            return

        if not result or len(result) < 2:
            return

        claimed = result[1] if len(result) > 1 else []
        for msg_id_raw, fields_raw in claimed:
            msg_id = _decode(msg_id_raw)
            fields = {_decode(k): _decode(v) for k, v in fields_raw.items()}
            try:
                envelope = parse_envelope(fields)
            except Exception as exc:
                logger.error(
                    "Orphaned msg %s on %s has malformed envelope: %s — ACKing",
                    msg_id, stream_cfg.stream, exc,
                )
                await self._ack(stream_cfg, msg_id)
                continue

            delivery_count = await self._delivery_count(stream_cfg, msg_id)
            if delivery_count >= self._config.max_delivery_attempts:
                logger.warning(
                    "Recovered msg %s (kind=%s scope=%s) already at %d attempts — DLQ",
                    msg_id, envelope.kind, envelope.scope_key, delivery_count,
                )
                await send_to_dlq(
                    msg_id, fields, reason="max_delivery_attempts_exceeded",
                    stream=stream_cfg,
                )
                await self._ack(stream_cfg, msg_id)
                await release_claim(envelope.scope_key, stream=stream_cfg)
                continue

            logger.info(
                "XAUTOCLAIM recovered msg %s on %s (kind=%s scope=%s, delivery_count=%d)",
                msg_id, stream_cfg.stream, envelope.kind, envelope.scope_key,
                delivery_count,
            )
            self._spawn(stream_cfg, msg_id, fields_raw)

    # ── Helpers ──────────────────────────────────────────────────

    async def _delivery_count(self, stream_cfg: StreamConfig, msg_id: str) -> int:
        try:
            pending = await self._redis.xpending_range(
                stream_cfg.stream, stream_cfg.group,
                min=msg_id, max=msg_id, count=1,
            )
        except Exception:
            return 1
        if not pending:
            return 1
        return int(pending[0].get("times_delivered", 1))

    async def _resolve_scope_lock_key(self, envelope: JobEnvelope) -> str | None:
        """Return the asyncio.Semaphore key for this envelope.

        For stats/schema jobs the ``provider_id:graph_name`` identity
        rarely changes — the data source's provider and graph are set
        at registration and only mutate via explicit edit flows. So
        results are cached per-process to avoid a DB round-trip on
        every dispatch. For discovery, the envelope already carries
        ``provider_id:asset_name``, no DB hit needed.
        """
        if isinstance(envelope, DiscoveryJobEnvelope):
            return envelope.scope_key

        ds_id = envelope.data_source_id  # type: ignore[attr-defined]

        cached = self._scope_key_cache.get(ds_id)
        # ``None`` is a valid cached value ("we looked this up and found
        # nothing"). Use ``in`` rather than truthiness to distinguish
        # cache-miss from cache-hit-with-None.
        if ds_id in self._scope_key_cache:
            return cached

        from backend.app.db.models import WorkspaceDataSourceORM
        from sqlalchemy import select

        try:
            factory = get_session_factory(PoolRole.READONLY)
            async with factory() as session:
                row = (
                    await session.execute(
                        select(
                            WorkspaceDataSourceORM.provider_id,
                            WorkspaceDataSourceORM.graph_name,
                        ).where(WorkspaceDataSourceORM.id == ds_id)
                    )
                ).first()
                if not row:
                    resolved: str | None = None
                else:
                    provider_id, graph_name = row[0], row[1]
                    if provider_id and graph_name:
                        resolved = f"{provider_id}:{graph_name}"
                    else:
                        resolved = provider_id or ds_id
        except Exception as exc:
            logger.warning("Failed to resolve scope key for ds=%s: %s", ds_id, exc)
            return None

        # Bound the cache. FIFO-eviction is fine for our access pattern
        # (recent data sources dominate); a true LRU is overkill for
        # ~hundreds of data sources.
        if len(self._scope_key_cache) >= self._SCOPE_KEY_CACHE_MAX:
            oldest = next(iter(self._scope_key_cache))
            self._scope_key_cache.pop(oldest, None)
        self._scope_key_cache[ds_id] = resolved
        return resolved

    async def _resolve_timeout_and_bucket(
        self, envelope: JobEnvelope,
    ) -> tuple[float, str]:
        """Pick a per-job timeout and a size-bucket log tag together.

        Stats/schema scale with cached node count and use the existing
        ``StatsServiceConfig.resolve_poll_timeout`` pivot (default vs
        large-graph). Discovery uses a fixed live-call timeout — the
        provider may host many graphs but we never enumerate the
        keyspace beyond a list-graphs call here.
        """
        if isinstance(envelope, DiscoveryJobEnvelope):
            return (
                float(os.getenv("DISCOVERY_LIVE_TIMEOUT_SECS", "10")),
                "n/a",
            )
        # stats / schema
        node_counts = await get_known_node_counts()
        node_count = node_counts.get(envelope.data_source_id, 0)  # type: ignore[attr-defined]
        timeout = self._config.resolve_poll_timeout(node_count)
        if node_count < 10_000:
            bucket = "small"
        elif node_count < 100_000:
            bucket = "medium"
        elif node_count < 1_000_000:
            bucket = "large"
        else:
            bucket = "xlarge"
        return timeout, bucket

    async def _ack(self, stream_cfg: StreamConfig, msg_id: str) -> None:
        try:
            await self._redis.xack(stream_cfg.stream, stream_cfg.group, msg_id)
        except Exception as exc:
            logger.warning("XACK failed for %s on %s: %s", msg_id, stream_cfg.stream, exc)

    def _reap_done_tasks(self) -> None:
        done = [mid for mid, t in self._active_tasks.items() if t.done()]
        for mid in done:
            task = self._active_tasks.pop(mid)
            self._message_meta.pop(mid, None)
            if not task.cancelled():
                exc = task.exception()
                if exc:
                    logger.error("Task for msg %s finished with exception: %s", mid, exc)


def _decode(value) -> str:
    """redis-py hands us bytes by default. Callers expect str."""
    if isinstance(value, bytes):
        return value.decode("utf-8")
    return value


# Backwards-compat alias — ``__main__.py`` still imports StatsJobConsumer.
StatsJobConsumer = InsightsJobConsumer
