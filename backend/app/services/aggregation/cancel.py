"""Cooperative cancellation for aggregation/purge workers.

Replaces the previous "set status=cancelled in PG, then task.cancel()"
pattern, which fired in the middle of an in-flight Cypher MERGE and
orphaned the FalkorDB transaction. The new contract:

* Workers register an ``asyncio.Event`` per ``job_id`` on start.
* Workers check the event at safe boundaries — between MERGE sub-batches
  inside a single outer batch, and at outer-batch boundaries — and raise
  :class:`JobCancelled` cleanly when set.
* The aggregation/insights API tier calls
  :func:`request_cancel(job_id)` to set the event. Worker observes at the
  next safe checkpoint and exits the loop without orphaning any
  graph-side transaction.
* The dispatcher's hard ``task.cancel()`` remains as a final fallback
  after a grace period, but should never fire in practice for
  well-behaved workers.

Cross-process. The :class:`CancelRegistry` itself is per-process —
just an in-memory ``dict[str, asyncio.Event]``. To honour cancel
requests against jobs running in *other* processes (purge workers in
the insights_service process, aggregation workers under
``PostgresDispatcher`` / ``RedisStreamDispatcher`` running on
separate replicas), we bridge across processes via a Redis Pub/Sub
channel:

* :func:`publish_cancel(redis, job_id)` writes a cancel message to
  the shared channel. Called by the API tier on every cancel
  request, regardless of whether the worker is local.
* :class:`CancelListener` is a background coroutine each worker /
  web-tier process starts at lifespan boot. It subscribes to the
  channel and, on receipt, forwards to its **local**
  :class:`CancelRegistry`. The worker's hot-loop sees its event get
  set even though the request came from a different process.

The local registry remains the actual mechanism workers use; the
Pub/Sub bridge is just transport. ``Pub/Sub`` (not Streams) is
correct here: cancel is fire-and-forget, at-most-once is fine —
on the rare miss, the API tier's direct DB write to status='cancelled'
plus the dispatcher's hard ``task.cancel()`` fallback remain as a
secondary path.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)


# Single shared Pub/Sub channel for cross-process cancel. Lives next
# to the platform's other Redis namespaces but is its own thing —
# distinct from broker / state-store / dispatcher streams. Format of
# every message is a small JSON envelope so future control-plane
# operations (pause, resume, force-fail) can ride on the same channel
# with a discriminator field.
CANCEL_CONTROL_CHANNEL = "aggregation.control"


class JobCancelled(Exception):
    """Raised by worker hot loops when a cooperative cancel has been
    requested. The worker's outer ``run()`` catches this, marks the
    job ``cancelled``, and emits a terminal event.
    """

    def __init__(self, job_id: str, observed_at: str) -> None:
        super().__init__(f"Job {job_id} cancelled at {observed_at}")
        self.job_id = job_id
        self.observed_at = observed_at


# Register with the circuit breaker so providers wrapped in CircuitBreakerProxy
# pass JobCancelled through untouched instead of wrapping it as
# ProviderUnavailable and counting it as a downstream failure. Done here (not
# inside circuit.py) to avoid a circular import: circuit.py is imported by
# worker.py before this module, and reaching back from circuit.py into the
# aggregation package at its own load time would trip a partial-init cycle.
try:
    from backend.common.adapters.circuit import register_logical_exception

    register_logical_exception(JobCancelled)
except Exception:  # pragma: no cover - import-time best-effort
    logger.exception("Failed to register JobCancelled with circuit breaker")


class CancelRegistry:
    """Per-process map of ``job_id -> asyncio.Event``.

    Workers register on start, check the event at safe boundaries, and
    unregister on terminal. The API tier calls ``request_cancel`` to
    set the event.
    """

    def __init__(self) -> None:
        self._events: dict[str, asyncio.Event] = {}

    def register(self, job_id: str) -> asyncio.Event:
        """Register and return a fresh event for this job. Worker calls
        on start; the returned event is what the worker checks during
        its hot loop."""
        event = asyncio.Event()
        self._events[job_id] = event
        return event

    def unregister(self, job_id: str) -> None:
        """Remove the event on terminal (completed / failed / cancelled).
        Idempotent."""
        self._events.pop(job_id, None)

    def request_cancel(self, job_id: str) -> bool:
        """Set the cancel event for ``job_id``. Returns True if the job
        was registered (cooperative cancel pending), False if not
        (already terminal, or running on another replica that this
        registry doesn't know about — caller should fall back to a
        hard cancel path).
        """
        event = self._events.get(job_id)
        if event is None:
            return False
        event.set()
        logger.info("Cooperative cancel requested for job %s", job_id)
        return True

    def is_cancelled(self, job_id: str) -> bool:
        """Quick check; True if the job is registered AND cancellation
        was requested. Workers use this at MERGE sub-batch boundaries
        where raising an exception would be heavyweight."""
        event = self._events.get(job_id)
        return event is not None and event.is_set()

    def active_jobs(self) -> list[str]:
        """Return the list of currently-registered job_ids. Used by
        worker shutdown to drain in-flight work and by ops dashboards."""
        return list(self._events.keys())


# Process-wide singleton. Aggregation/purge workers and the FastAPI
# cancel endpoint all reach for the same instance.
_registry = CancelRegistry()


def get_registry() -> CancelRegistry:
    """Accessor for the process-wide ``CancelRegistry`` singleton."""
    return _registry


def request_cancel(job_id: str) -> bool:
    """Convenience wrapper around the singleton's ``request_cancel``."""
    return _registry.request_cancel(job_id)


# ── Cross-process cancel bridge (Redis Pub/Sub) ─────────────────────


async def publish_cancel(redis_client: Any, job_id: str) -> None:
    """Broadcast a cancel request for ``job_id`` to every process
    subscribed to the control channel.

    Idempotent: publishing twice for the same job_id is harmless —
    each subscriber's local :class:`CancelRegistry` either has the
    job (sets the event, idempotent) or doesn't (no-op). Failures
    are non-fatal — the API tier's direct DB write to
    ``status='cancelled'`` + the dispatcher's hard ``task.cancel()``
    are the secondary path. Logged at warning so a Redis blip
    doesn't silently strand cancels.
    """
    payload = json.dumps({"action": "cancel", "job_id": job_id})
    try:
        await redis_client.publish(CANCEL_CONTROL_CHANNEL, payload)
        logger.info(
            "Cross-process cancel published for job %s on channel %s",
            job_id, CANCEL_CONTROL_CHANNEL,
        )
    except Exception as exc:
        logger.warning(
            "Failed to publish cross-process cancel for job %s "
            "(local registry + DB write are the fallback): %s",
            job_id, exc,
        )


class CancelListener:
    """Subscribes to the cancel control channel and forwards messages
    to the local :class:`CancelRegistry`.

    One instance per worker process. Started at lifespan boot,
    stopped on shutdown. Auto-reconnects on transient Redis errors —
    the listener that loses its connection during a Redis flap must
    not silently stop honouring cancels.

    Subscribers don't need to filter by job_id — each process sets
    its local event only for jobs IT has registered. Jobs registered
    in other processes are ignored cleanly (registry returns False).
    """

    def __init__(
        self,
        redis_client: Optional[Any] = None,
        *,
        redis_factory: Optional[Any] = None,
    ) -> None:
        """Subscribe to cancel events.

        Pass ``redis_client`` for backwards compat (eager construction).
        Or pass ``redis_factory`` (a sync callable returning a redis
        client) for P2.7 — lazy construction with reconnect-on-failure.
        With the factory, a Redis-down-at-startup scenario doesn't
        permanently disable the cancel bridge: the run loop calls the
        factory each cycle and recovers automatically when Redis comes
        back.
        """
        self._redis = redis_client
        self._redis_factory = redis_factory
        self._task: Optional[asyncio.Task] = None
        self._shutdown = asyncio.Event()
        self._pubsub: Any = None

    async def start(self) -> None:
        """Spawn the background subscriber task. Idempotent — calling
        start twice is a no-op."""
        if self._task is not None and not self._task.done():
            return
        self._shutdown.clear()
        self._task = asyncio.create_task(
            self._run_loop(), name="aggregation-cancel-listener",
        )
        logger.info(
            "Cancel listener started on channel %s", CANCEL_CONTROL_CHANNEL,
        )

    async def stop(self) -> None:
        """Stop the subscriber. Best-effort cleanup; safe to call
        multiple times."""
        self._shutdown.set()
        if self._pubsub is not None:
            try:
                await self._pubsub.unsubscribe(CANCEL_CONTROL_CHANNEL)
                await self._pubsub.close()
            except Exception as exc:
                logger.debug("Cancel listener pubsub close failed: %s", exc)
            self._pubsub = None
        if self._task is not None and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None
        logger.info("Cancel listener stopped")

    async def _run_loop(self) -> None:
        """Subscribe + dispatch loop. Reconnects on transient errors
        so a Redis flap doesn't permanently strand the cancel path.

        P2.7 — when the listener was constructed with ``redis_factory``
        instead of an eager client, this loop calls the factory each
        cycle so a Redis-down-at-startup scenario recovers automatically.
        """
        backoff = 1.0
        while not self._shutdown.is_set():
            try:
                # P2.7 — late-bound Redis client. The factory may raise
                # (Redis still down at startup); we treat that the same
                # as any other transient connection error and retry.
                if self._redis is None:
                    if self._redis_factory is None:
                        raise RuntimeError(
                            "CancelListener has neither redis_client nor "
                            "redis_factory; refusing to run."
                        )
                    self._redis = self._redis_factory()

                self._pubsub = self._redis.pubsub(ignore_subscribe_messages=True)
                await self._pubsub.subscribe(CANCEL_CONTROL_CHANNEL)
                # Reset backoff after a successful subscribe.
                backoff = 1.0
                async for message in self._pubsub.listen():
                    if self._shutdown.is_set():
                        return
                    if message is None:
                        continue
                    self._handle_message(message)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.warning(
                    "Cancel listener loop error (will retry in %.1fs): %s",
                    backoff, exc,
                )
                # P2.7 — drop the cached client on error so the next
                # iteration calls the factory again (in case the existing
                # client is in a bad state, e.g. closed connection pool).
                if self._redis_factory is not None:
                    self._redis = None
                self._pubsub = None
                try:
                    await asyncio.wait_for(self._shutdown.wait(), timeout=backoff)
                    return
                except asyncio.TimeoutError:
                    pass
                backoff = min(backoff * 2, 30.0)

    @staticmethod
    def _handle_message(message: Any) -> None:
        """Parse one Pub/Sub message and dispatch to the local registry."""
        data = message.get("data") if isinstance(message, dict) else None
        if data is None:
            return
        if isinstance(data, (bytes, bytearray)):
            try:
                data = data.decode("utf-8")
            except UnicodeDecodeError:
                return
        if not isinstance(data, str):
            return
        try:
            envelope = json.loads(data)
        except json.JSONDecodeError:
            logger.warning("Cancel listener: malformed payload (skipping)")
            return
        action = envelope.get("action")
        job_id = envelope.get("job_id")
        if action != "cancel" or not isinstance(job_id, str):
            return
        # Forward to local registry. Returns False if this process
        # doesn't host the job — that's expected and not an error.
        was_local = _registry.request_cancel(job_id)
        if was_local:
            logger.info(
                "Cancel listener: local cancel for job %s honoured", job_id,
            )
