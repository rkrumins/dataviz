"""``JobBroker`` Protocol — the swappable event-broadcast seam.

This is the architectural commitment to make: the messaging /
streams / event-transport layer must be portable across Redis
Streams, Kafka, GCP Pub/Sub, NATS JetStream, or any future broker.
``JobEmitter`` and ``JobEventConsumer`` depend on this interface
only — never on a concrete Redis client. Direct calls to
``redis.xadd / redis.publish / redis.xread`` are forbidden in
worker / consumer / API code (lint-enforced).

**Not the same as** :mod:`backend.app.services.aggregation.dispatcher`.
The two abstractions both use Redis Streams under the hood and
look superficially similar, but they solve different problems:

* ``AggregationDispatcher`` is a **work-distribution** seam:
  ``dispatch(job_id) -> None``. One job goes to **exactly one**
  worker via Redis consumer-group semantics (``XREADGROUP`` +
  ``XACK`` + ``XAUTOCLAIM`` crash recovery). Has DLQ + redrive
  lifecycle. The existing implementation has been in production
  for the work-routing use case.

* ``JobBroker`` is an **event-broadcast** seam: ``publish(event)``
  + ``stream(scope)``. One event is observed by **every** subscribed
  SSE client via consumer-group-less ``XREAD`` from the tail or
  ``XRANGE`` from offset. No ack, no redelivery, no DLQ —
  consumers are eventually-consistent observers, not workers.

Could they be unified? In principle yes (both wrap Redis Streams),
but the consumer-group + ack + redrive surface a unified interface
would need is invasive, and the dispatcher already works for its
use case. Defer unification unless a concrete use case demands it.

The interface is deliberately small. Three operations cover every
known broker's relevant primitives:

1. ``publish(event)`` — append-only emit with at-least-once
   semantics. Producers must tolerate duplicate delivery; consumers
   dedup via ``(job_id, sequence)``.

2. ``stream(scope, from_sequence)`` — subscribe with optional
   replay. ``from_sequence=None`` = live tail only;
   ``from_sequence=N`` = backfill from sequence N then live tail.
   Implementations that can't replay (e.g. Pub/Sub without
   snapshot) MUST raise :class:`BackfillNotSupported` when
   ``from_sequence`` is set; callers fall back to REST + live-tail.

3. ``close(scope)`` — terminal cleanup. Broker decides retention
   semantics (Redis: keep stream for TTL window; Kafka: nothing,
   topic retention covers it).

What's *not* in this interface (and why):

* No "ack" — at-least-once with consumer-side dedup is the contract.
  Consumer-group semantics for work distribution belong to a
  different abstraction (``JobDispatcher``) tracked separately.
* No "produce sync vs async" knob — implementations decide.
  ``publish`` is async to accommodate any backend.
* No "delete event" — events are immutable. To revoke published
  state, emit a new event (``resync`` or ``terminal``).
"""
from __future__ import annotations

from typing import AsyncIterator, Optional, Protocol, Union

from .schemas import BackfillNotSupported, JobEvent  # re-exported below


# Re-export so callers can import everything broker-related from here.
__all__ = [
    "JobBroker",
    "BrokerScope",
    "JobScope",
    "TenantScope",
    "BackfillNotSupported",
]


class JobScope:
    """Subscribe to all events for one specific ``job_id``.

    Implementations route to the per-job stream / topic / partition
    keyed on ``job_id``.
    """

    __slots__ = ("job_id",)

    def __init__(self, job_id: str) -> None:
        self.job_id = job_id

    def __repr__(self) -> str:
        return f"JobScope(job_id={self.job_id!r})"


class TenantScope:
    """Subscribe to all events across all jobs in one workspace.

    Phase 3 use. One ``EventSource`` per workspace multiplexes all
    visible jobs through a single connection. Implementations route
    to the per-tenant fan-out stream.
    """

    __slots__ = ("workspace_id",)

    def __init__(self, workspace_id: str) -> None:
        self.workspace_id = workspace_id

    def __repr__(self) -> str:
        return f"TenantScope(workspace_id={self.workspace_id!r})"


BrokerScope = Union[JobScope, TenantScope]
"""Discriminated input for ``JobBroker.stream``. New scopes (e.g.
per-kind) extend this union — interface change managed via the
envelope's ``v`` field."""


class JobBroker(Protocol):
    """The portable transport seam.

    Implementations:
    * :class:`backend.app.jobs.brokers.redis_streams.RedisStreamsJobBroker`
      (default; Redis Streams + Pub/Sub)
    * :class:`backend.app.jobs.brokers.in_memory.InMemoryJobBroker`
      (tests; proves the abstraction holds)
    * Future: ``KafkaJobBroker``, ``GCPPubSubJobBroker``,
      ``NATSJetStreamJobBroker`` — all single-file additions.
    """

    async def publish(self, event: JobEvent) -> None:
        """Append one event to the appropriate stream(s).

        Implementation responsibilities:
        * Append to the per-job stream keyed on ``event.job_id``.
        * Append to the per-tenant stream keyed on
          ``event.scope.workspace_id`` (Phase 3 readiness; safe to
          do unconditionally now since the cost is one extra XADD).
        * Apply MAXLEN / retention per the broker's semantics.
        * Tolerate transient backend errors gracefully — ``publish``
          should not raise on a single XADD blip; callers track
          emit-error counts via the metrics layer.

        Idempotency at this layer: re-emitting the same event
        (same ``job_id``, ``sequence``) is allowed. Consumers
        dedup. Brokers do not need to be content-addressable.
        """
        ...

    async def stream(
        self,
        scope: BrokerScope,
        from_sequence: Optional[int] = None,
    ) -> AsyncIterator[JobEvent]:
        """Subscribe to events for ``scope``.

        ``from_sequence=None`` — live tail only; the iterator yields
        events as they're published from "now" onward.
        ``from_sequence=N`` — backfill from sequence N, then live
        tail. Implementations that can't replay raise
        :class:`BackfillNotSupported`; callers fall back to REST.

        The iterator runs until cancelled or until the stream is
        closed. Implementations should yield a ``terminal`` event
        and let the consumer decide when to break.
        """
        ...

    async def close(self, scope: BrokerScope) -> None:
        """Cleanup for a terminal-state scope. Broker decides
        retention; this is a hint that no further events will be
        published. Idempotent.
        """
        ...
