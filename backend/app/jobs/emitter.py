"""``JobEmitter`` — producer-side seam.

The only surface workers should reach for to publish progress / state
events. Workers must NEVER call ``redis.xadd`` / ``redis.hset`` /
``redis.publish`` directly — there's a lint rule for this. The reason
matters: if every worker hardcodes the Redis client, swapping to
Kafka or GCP Pub/Sub later means refactoring every emit site. With
``JobEmitter``, swapping is one factory wire-up in
``backend/app/jobs/__init__.py``.

What ``JobEmitter`` does on every ``publish``:

1. Validates + assigns the next ``sequence`` for the job (monotonic
   per ``job_id``; persisted by the worker into
   ``aggregation_jobs.last_sequence`` at outer-batch boundaries).
2. Writes the live snapshot to the ``LiveStateStore`` (HSET-style).
3. Appends the event to the ``JobBroker`` (per-job + per-tenant
   streams).
4. Increments emit-counter metrics (success / error).
5. On Redis-down errors: swallows, increments the error counter,
   continues. The worker's main loop must not abort on transport
   failure — that's the Redis-down resilience contract.

What ``JobEmitter`` does NOT do:

* Pre-validate the payload shape per (kind, type). Phase 2 work; a
  per-kind JSON-Schema check could be added as a producer-side
  guard, but for now the pydantic envelope is the contract.
* Persist anything to PostgreSQL. The worker's outer-batch commit
  path handles that. The audit subset (``job_event_log`` table) is
  written separately by the worker on terminal events.
"""
from __future__ import annotations

import logging
from typing import Mapping, Optional

from .broker import JobBroker
from .metrics import increment as metrics_increment
from .redis_keys import PROGRESS_TTL_SECS
from .schemas import JobEvent, JobEventType, JobKind, JobScope, JobStatus
from .state_store import LiveStateStore

logger = logging.getLogger(__name__)


# Same set the redis_client module uses for its safe wrappers; we
# repeat here to avoid the import to insights_service from the
# platform package (the platform should be insights-service-agnostic).
_REDIS_BENIGN_ERRORS: tuple[type[BaseException], ...] = (
    ConnectionError, TimeoutError, OSError,
)


class JobEmitter:
    """The single seam every producer calls.

    Constructed with injected ``broker`` + ``state_store`` so the
    backend is selected at startup (factory in
    ``backend/app/jobs/__init__.py``) and the emitter itself stays
    transport-agnostic.
    """

    def __init__(
        self,
        broker: JobBroker,
        state_store: LiveStateStore,
        *,
        progress_ttl_secs: int = PROGRESS_TTL_SECS,
    ) -> None:
        self._broker = broker
        self._state_store = state_store
        self._progress_ttl_secs = progress_ttl_secs
        # Per-job sequence counter held in this emitter instance. The
        # worker is responsible for seeding via ``initial_sequence``
        # on the first publish for a job_id (resume-safe), and for
        # persisting ``job.last_sequence`` to PG at outer-batch
        # boundaries so a future restart can re-seed.
        self._sequences: dict[str, int] = {}

    def seed_sequence(self, job_id: str, last_sequence: int) -> None:
        """Set the starting sequence for a job. Called on worker
        start with the value loaded from ``aggregation_jobs.last_sequence``
        so resume-after-crash continues numbering past whatever the
        previous worker emitted."""
        self._sequences[job_id] = last_sequence

    def current_sequence(self, job_id: str) -> int:
        """Read the current sequence (the next emit will be this+1).
        Used at outer-batch checkpoint to persist the high-water-mark."""
        return self._sequences.get(job_id, 0)

    async def publish(
        self,
        *,
        job_id: str,
        kind: JobKind,
        scope: JobScope,
        type: JobEventType,
        payload: Optional[Mapping[str, object]] = None,
        live_state: Optional[Mapping[str, str | int | float]] = None,
    ) -> Optional[JobEvent]:
        """Publish one event.

        Returns the published ``JobEvent`` on success, or ``None`` if
        the publish failed transiently and the caller should treat it
        as fire-and-forget. Callers MUST tolerate the ``None`` return
        — the worker's primary work (FalkorDB Cypher, PG checkpoint)
        is independent of telemetry.

        ``live_state`` is the HSET payload. Typically a superset of
        the event's payload (e.g. cumulative counters that the SSE
        consumer overlays on the API response). Skipped when the
        event is purely a state-transition (``state``, ``terminal``).
        """
        seq = self._sequences.get(job_id, 0) + 1
        self._sequences[job_id] = seq

        event = JobEvent(
            v=1,
            type=type,
            job_id=job_id,
            kind=kind,
            scope=scope,
            sequence=seq,
            payload=dict(payload or {}),
        )

        # Live state first (cheap; lossy on outage). The HSET write
        # is what the API tier overlays on its DB response between
        # outer-batch commits, so prioritising it minimises the
        # window where the UI sees stale values.
        if live_state:
            try:
                await self._state_store.set(
                    job_id, live_state, ttl_secs=self._progress_ttl_secs,
                )
            except _REDIS_BENIGN_ERRORS as exc:
                metrics_increment(
                    "job_events_emit_errors_total",
                    kind=kind, type=type, stage="state_store",
                )
                logger.warning(
                    "JobEmitter: state_store.set failed (continuing): %s", exc,
                )
            except Exception as exc:
                metrics_increment(
                    "job_events_emit_errors_total",
                    kind=kind, type=type, stage="state_store_unexpected",
                )
                logger.error(
                    "JobEmitter: state_store.set unexpected failure: %s",
                    exc, exc_info=True,
                )

        # Event log second. Same swallow pattern; emit-error counter
        # increments on transient failures so observability sees the
        # blip.
        try:
            await self._broker.publish(event)
        except _REDIS_BENIGN_ERRORS as exc:
            metrics_increment(
                "job_events_emit_errors_total",
                kind=kind, type=type, stage="broker_publish",
            )
            logger.warning(
                "JobEmitter: broker.publish failed (continuing): %s", exc,
            )
            return None
        except Exception as exc:
            metrics_increment(
                "job_events_emit_errors_total",
                kind=kind, type=type, stage="broker_publish_unexpected",
            )
            logger.error(
                "JobEmitter: broker.publish unexpected failure: %s",
                exc, exc_info=True,
            )
            return None

        metrics_increment(
            "job_events_emitted_total", kind=kind, type=type,
        )
        return event

    async def terminal(
        self,
        *,
        job_id: str,
        kind: JobKind,
        scope: JobScope,
        status: JobStatus,
        payload: Optional[Mapping[str, object]] = None,
    ) -> Optional[JobEvent]:
        """Convenience wrapper for the terminal event. Drops the
        live snapshot afterward so the cache key frees immediately
        rather than waiting for TTL expiry."""
        event = await self.publish(
            job_id=job_id,
            kind=kind,
            scope=scope,
            type="terminal",
            payload={"status": status, **(payload or {})},
        )
        try:
            await self._state_store.delete(job_id)
        except _REDIS_BENIGN_ERRORS:
            # Don't care — TTL will reap it.
            pass
        except Exception as exc:
            logger.warning(
                "JobEmitter: state_store.delete (terminal) failed: %s", exc,
            )
        # Forget the in-memory sequence counter. A future job with the
        # same ID (shouldn't happen — IDs are UUIDs) would otherwise
        # inherit our sequence.
        self._sequences.pop(job_id, None)
        return event
