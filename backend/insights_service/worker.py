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

from backend.app.db.engine import get_readonly_session
from backend.app.services.aggregation.redis_client import get_redis
from backend.common.adapters.circuit import ProviderUnavailable

from . import dispatcher
from .admission import AdmissionDenied
from .collector import record_failure as stats_record_failure  # noqa: F401  (forces self-registration)
from .config import StatsServiceConfig
from .discovery import record_failure as discovery_record_failure  # noqa: F401
from .purge import record_failure as purge_record_failure  # noqa: F401
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
    ProbeJobEnvelope,
    PurgeJobEnvelope,
    StatsJobEnvelope,
    parse_envelope,
)

# Outer budget for a drift probe. Constant-time work plus admission wait and
# session churn; deliberately NOT size-adaptive (see _resolve_timeout_and_bucket).
_PROBE_TIMEOUT_SECS = float(os.getenv("STATS_PROBE_TIMEOUT_SECS", "20"))

logger = logging.getLogger(__name__)


# Map stream key (Redis stream name) → its StreamConfig, used at ACK /
# XAUTOCLAIM time to dispatch back to the right stream.
_STREAM_BY_NAME: dict[str, StreamConfig] = {s.stream: s for s in ALL_STREAMS}


class InsightsJobConsumer:
    """Multi-stream XREADGROUP loop.

    The class name preserves the public API as ``StatsJobConsumer`` is
    re-exported below so :mod:`__main__` keeps working without edits.
    """

    # Per-data-source metadata cache:
    #   data_source_id → (scope_key "provider:graph", node_count, fetched_at).
    # One outer-joined single-row query serves both the per-scope lock
    # key and the timeout-sizing node count. Bounded so a long-lived
    # worker doesn't accumulate stale rows for deleted data sources;
    # FIFO eviction keeps memory flat at high churn. node_count only
    # needs to be size-bucket-accurate (10k/100k/1M pivots), so entries
    # refresh after _DS_META_TTL_SECS. Mutated only from the worker
    # coroutine, no lock needed.
    _SCOPE_KEY_CACHE_MAX = 1024
    _DS_META_TTL_SECS = 900.0
    _scope_key_cache: dict[str, tuple[str | None, int | None, float]] = {}

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
        # lane → number of in-flight tasks; enforced by only including
        # streams with free lane slots in the XREADGROUP call.
        self._lane_active: dict[str, int] = {}

    # ── Public API ───────────────────────────────────────────────

    @property
    def active_count(self) -> int:
        return len(self._active_tasks)

    @property
    def consumer_name(self) -> str:
        return self._consumer_name

    def request_shutdown(self) -> None:
        self._shutdown.set()

    def _lane_budgets(self) -> dict[str, int]:
        return {
            "fast": self._config.worker_concurrency,
            "sweep": self._config.sweep_concurrency,
            "heavy": self._config.heavy_concurrency,
            "purge": self._config.purge_concurrency,
            "probe": self._config.probe_concurrency,
        }

    def _lane_free_slots(self) -> dict[str, int]:
        return {
            lane: budget - self._lane_active.get(lane, 0)
            for lane, budget in self._lane_budgets().items()
        }

    def lane_active_snapshot(self) -> dict[str, int]:
        """Read-only copy for the /health payload — lane-accounting bugs
        (a leaked slot silently halving throughput) are invisible
        without this."""
        return dict(self._lane_active)

    async def run(self) -> None:
        kinds = ", ".join(s.kind for s in ALL_STREAMS)
        logger.info(
            "Insights worker started (consumer=%s, lanes fast=%d heavy=%d purge=%d, "
            "per_scope=%d, kinds=[%s])",
            self._consumer_name,
            self._config.worker_concurrency,
            self._config.heavy_concurrency,
            self._config.purge_concurrency,
            self._config.max_per_graph,
            kinds,
        )

        # Recover orphaned messages from previous replicas that crashed.
        for cfg in ALL_STREAMS:
            await self._recover_pending(cfg)

        # Block window sized to fit inside the resolved socket_timeout — a
        # tightened REDIS_STREAMS_SOCKET_TIMEOUT must shorten the block, not
        # turn every quiet read into a spurious TimeoutError.
        from backend.common.adapters.redis_bus import stream_block_ms
        block_ms = stream_block_ms()

        while not self._shutdown.is_set():
            self._reap_done_tasks()

            free = self._lane_free_slots()
            eligible = [s for s in ALL_STREAMS if free.get(s.lane, 0) > 0]
            if not eligible:
                await asyncio.sleep(0.25)
                continue

            # COUNT is per-stream in XREADGROUP, so cap it at the most
            # constrained eligible lane's headroom. The fast lane spans
            # two streams, so one read may overshoot its budget by at
            # most COUNT tasks for a single iteration — bounded, and the
            # per-scope semaphore still serializes same-graph work.
            count = max(1, min(free[s.lane] for s in eligible))

            try:
                entries = await self._redis.xreadgroup(
                    SHARED_GROUP,
                    self._consumer_name,
                    {s.stream: ">" for s in eligible},
                    count=count,
                    block=block_ms,
                )
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                # Auth-class errors (rotated/wrong bus password) log an
                # actionable line and back off long; blips keep the 2s retry.
                from backend.common.adapters.redis_bus import bus_error_retry_delay
                await asyncio.sleep(
                    bus_error_retry_delay(exc, logger, what="XREADGROUP")
                )
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
        self._lane_active[stream_cfg.lane] = (
            self._lane_active.get(stream_cfg.lane, 0) + 1
        )

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
            # Handlers own their DB sessions (short sessions around the
            # DB phases, none held across provider IO) — see dispatcher.py.
            await asyncio.wait_for(handler(envelope), timeout=timeout)
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
        except (AdmissionDenied, ProviderUnavailable) as exc:
            # Soft-retry path. The provider is rate-throttled, circuit-open,
            # or otherwise temporarily unavailable; running this job now is
            # guaranteed to fail. Critically: do NOT increment the delivery
            # count for scheduler-backed kinds, because that's how a
            # 30-minute provider outage drains the entire backlog into
            # the DLQ.
            #
            # Two flavours:
            #
            # * Scheduler-backed kinds (stats / discovery) — ACK + release
            #   the claim. The matching scheduler re-enqueues on its
            #   next tick once the upstream has recovered.
            # * One-shot kinds (purge) — leave the message in PEL with
            #   the dedup claim held. There is no scheduler to re-enqueue,
            #   and ACKing here would silently drop the work: the DB row
            #   stays at ``pending`` forever and the next user request
            #   would 409 against the orphaned ``pending`` job.
            #   XAUTOCLAIM picks the message up after ``min_idle_time``
            #   (60s default), bumping delivery count — bounded retries
            #   that DLQ if admission keeps refusing.
            duration = asyncio.get_event_loop().time() - start_ts
            reason = getattr(exc, "reason", None) or "provider_unavailable"
            if isinstance(envelope, (StatsJobEnvelope, DiscoveryJobEnvelope)):
                logger.info(
                    "%s.soft_retry scope=%s duration_secs=%.2f reason=%s — "
                    "ACK + release claim; scheduler will re-enqueue",
                    envelope.kind, envelope.scope_key, duration, reason,
                )
                await self._ack(stream_cfg, msg_id)
                await release_claim(envelope.scope_key, stream=stream_cfg)
            else:
                logger.info(
                    "%s.soft_retry scope=%s duration_secs=%.2f reason=%s — "
                    "leaving in PEL for XAUTOCLAIM redelivery (no scheduler to re-enqueue), "
                    "releasing dedup claim",
                    envelope.kind, envelope.scope_key, duration, reason,
                )
                # No ACK — XAUTOCLAIM (60s idle) redelivers, eventually DLQs
                # if admission keeps refusing. DO release the claim though:
                # duplicate-purge protection lives at the DB layer
                # (claim_purge_job 409s on any pending/running row for the
                # same data source), and holding the claim here would
                # otherwise block legitimate user retries — they'd see
                # ``enqueue_purge_job_safe`` return None for up to the
                # claim's 20-minute TTL.
                await release_claim(envelope.scope_key, stream=stream_cfg)
            return
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

        # Best-effort per-kind error persistence — never fatal. The
        # record_failure helpers open their own short JOBS sessions.
        try:
            if isinstance(envelope, StatsJobEnvelope):
                await stats_record_failure(envelope.data_source_id, error)
            elif isinstance(envelope, DiscoveryJobEnvelope):
                await discovery_record_failure(
                    envelope.provider_id, envelope.asset_name, error
                )
            elif isinstance(envelope, PurgeJobEnvelope):
                await purge_record_failure(envelope.job_id, error)
        except Exception as exc:
            logger.warning(
                "Failed to persist last_error kind=%s scope=%s: %s",
                envelope.kind, envelope.scope_key, exc,
            )

        if delivery_count >= max_attempts:
            # Structured event so an alerting pipeline can match on
            # `dlq.write` and surface "X DLQ entries last hour" without
            # parsing free-text. Pair with the DLQ admin endpoints
            # under /admin/insights/dlq for triage.
            truncated_error = error[:200]
            logger.error(
                "dlq.write kind=%s scope=%s delivery_count=%d error=%s",
                envelope.kind, envelope.scope_key, delivery_count, truncated_error,
            )
            await send_to_dlq(
                msg_id, envelope.to_stream_fields(), reason=truncated_error,
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
                # Cap recovery by the stream's lane budget so a restart
                # can't flood the heavy lane past its concurrency.
                count=max(1, self._lane_budgets().get(stream_cfg.lane, 1)),
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

    async def _resolve_ds_meta(self, ds_id: str) -> tuple[str | None, int | None]:
        """Return ``(scope_key, node_count)`` for a data source, cached.

        The ``provider_id:graph_name`` identity rarely changes (set at
        registration, mutated only via explicit edit flows) and
        node_count only needs to be size-bucket-accurate, so one
        outer-joined single-row query serves both, refreshed after
        ``_DS_META_TTL_SECS``. Replaces the old full-table
        ``data_source_stats`` scan that ran on every job.
        """
        now = asyncio.get_event_loop().time()
        cached = self._scope_key_cache.get(ds_id)
        if cached is not None and (now - cached[2]) < self._DS_META_TTL_SECS:
            return cached[0], cached[1]

        from backend.app.db.models import DataSourceStatsORM, WorkspaceDataSourceORM
        from sqlalchemy import select

        try:
            async with get_readonly_session() as session:
                row = (
                    await session.execute(
                        select(
                            WorkspaceDataSourceORM.provider_id,
                            WorkspaceDataSourceORM.graph_name,
                            DataSourceStatsORM.node_count,
                        )
                        .outerjoin(
                            DataSourceStatsORM,
                            DataSourceStatsORM.data_source_id
                            == WorkspaceDataSourceORM.id,
                        )
                        .where(WorkspaceDataSourceORM.id == ds_id)
                    )
                ).first()
        except Exception as exc:
            logger.warning("Failed to resolve ds meta for ds=%s: %s", ds_id, exc)
            # Don't cache failures; a stale-but-known entry beats nothing.
            if cached is not None:
                return cached[0], cached[1]
            return None, None

        if not row:
            resolved: str | None = None
            node_count: int | None = None
        else:
            provider_id, graph_name = row[0], row[1]
            # None (no stats row yet — never scanned) is deliberately
            # distinct from 0 (scanned, genuinely empty): a never-
            # scanned source of unknown size must get the generous
            # timeout, or the first poll of a 100k+ graph times out on
            # the 30s small-graph budget and loops.
            node_count = int(row[2]) if row[2] is not None else None
            if provider_id and graph_name:
                resolved = f"{provider_id}:{graph_name}"
            else:
                resolved = provider_id or ds_id

        # Bound the cache. FIFO-eviction is fine for our access pattern
        # (recent data sources dominate); a true LRU is overkill for
        # ~hundreds of data sources.
        if len(self._scope_key_cache) >= self._SCOPE_KEY_CACHE_MAX:
            oldest = next(iter(self._scope_key_cache))
            self._scope_key_cache.pop(oldest, None)
        self._scope_key_cache[ds_id] = (resolved, node_count, now)
        return resolved, node_count

    async def _resolve_scope_lock_key(self, envelope: JobEnvelope) -> str | None:
        """Return the asyncio.Semaphore key for this envelope. For
        discovery, the envelope already carries ``provider_id:asset_name``,
        no DB hit needed."""
        if isinstance(envelope, DiscoveryJobEnvelope):
            return envelope.scope_key
        scope_key, _ = await self._resolve_ds_meta(envelope.data_source_id)  # type: ignore[attr-defined]
        return scope_key

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
            # Outer budget = the handler's inner live-call budget plus
            # headroom for preflight + session churn. Derived from the
            # same resilience constant so the two can't diverge.
            from backend.app.config import resilience
            return (
                float(resilience.DISCOVERY_LIVE_TIMEOUT_SECS) + 10.0,
                "n/a",
            )
        if isinstance(envelope, ProbeJobEnvelope):
            # MUST precede the stats branch: ProbeJobEnvelope subclasses
            # StatsJobEnvelope, so without this a probe inherits the
            # size-adaptive poll budget and is allowed to hang for ten minutes
            # holding a slot in a lane sized for millisecond work.
            #
            # A probe reads counters, so its cost is independent of graph size
            # — a fixed budget is the honest shape here, and anything slower
            # than this is a sick provider the next tick should retry against,
            # not a big graph deserving patience.
            return _PROBE_TIMEOUT_SECS, "probe"
        # stats / schema — node count comes from the cached ds-meta
        # lookup (the scope-key resolution already warmed it).
        _, node_count = await self._resolve_ds_meta(envelope.data_source_id)  # type: ignore[attr-defined]
        if node_count is None:
            # Never scanned — size unknown. Give the first poll the
            # large-graph budget so a genuinely big graph can complete.
            return self._config.poll_timeout_large_secs, "unknown"
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
            meta = self._message_meta.pop(mid, None)
            if meta is not None:
                lane = meta[0].lane
                self._lane_active[lane] = max(0, self._lane_active.get(lane, 0) - 1)
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
