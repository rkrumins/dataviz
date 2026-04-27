"""``JobEventConsumer`` — SSE-side stream tail + backfill.

Thin wrapper over ``JobBroker.stream(...)`` that adds:

* **Sequence-gap detection.** If the broker drops events (MAXLEN
  truncation, network blip), the consumer detects a gap by comparing
  the just-yielded ``sequence`` against the previous one and emits a
  synthetic ``resync`` event so the SSE client knows to refetch via
  REST.
* **Terminal-event closure.** When a ``terminal`` event lands, the
  consumer yields it then exits the iterator. SSE handlers wrap
  this so the connection closes cleanly without the client having
  to detect EOF heuristically.

Lives in the API tier, not in workers. The seam is intentionally
narrow: the consumer doesn't know whether it's serving an HTTP SSE
client, a websocket bridge, or a test harness — it just yields
events.
"""
from __future__ import annotations

import logging
from typing import AsyncIterator, Optional

from .broker import BackfillNotSupported, BrokerScope, JobBroker, JobScope, TenantScope
from .schemas import JobEvent

logger = logging.getLogger(__name__)


class JobEventConsumer:
    """Async iterator factory over ``JobBroker.stream``."""

    def __init__(self, broker: JobBroker) -> None:
        self._broker = broker

    async def stream(
        self,
        scope: BrokerScope,
        from_sequence: Optional[int] = None,
    ) -> AsyncIterator[JobEvent]:
        """Yield events for ``scope``. Detects sequence gaps and
        emits synthetic ``resync`` so SSE clients can recover via
        REST without tearing down the connection.

        On ``BackfillNotSupported`` (broker can't replay): emits a
        ``resync`` immediately and continues with live tail. The
        SSE client refetches via REST and keeps streaming."""
        last_seq: dict[str, int] = {}
        # Per-job sequence tracking when the scope is per-tenant —
        # different jobs in the same tenant stream are independent.

        # Brokers expose ``stream`` as an async generator (consistent
        # across RedisStreamsJobBroker and InMemoryJobBroker), so we
        # call it without ``await`` and iterate directly. The
        # ``BackfillNotSupported`` raise can fire either at the first
        # ``async for`` step or during iteration depending on impl;
        # handle by catching around the loop entry.
        event_iter = self._broker.stream(scope, from_sequence)

        try:
            first = await event_iter.__anext__()
        except StopAsyncIteration:
            return
        except BackfillNotSupported as exc:
            logger.info(
                "JobEventConsumer: backfill not supported (%s); "
                "emitting resync and switching to live tail",
                exc,
            )
            yield self._synthetic_resync(scope)
            # Re-open the stream without backfill request and
            # restart iteration from there.
            event_iter = self._broker.stream(scope, None)
            try:
                first = await event_iter.__anext__()
            except StopAsyncIteration:
                return

        # Process the first event then continue the loop. Pulling
        # the first event manually lets us catch the broker's
        # backfill-not-supported error cleanly above.
        async def _all() -> AsyncIterator[JobEvent]:
            yield first
            async for ev in event_iter:
                yield ev

        async for event in _all():
            prev = last_seq.get(event.job_id)
            if prev is not None and event.sequence > prev + 1:
                # Gap! Some events were dropped between us and the
                # broker. Emit a resync so the client refetches.
                logger.warning(
                    "JobEventConsumer: sequence gap on job %s "
                    "(prev=%d, current=%d); emitting resync",
                    event.job_id, prev, event.sequence,
                )
                yield self._synthetic_resync_for_job(event)
            last_seq[event.job_id] = event.sequence

            yield event

            if event.type == "terminal":
                # Stream is done. Yielding it lets the SSE handler
                # send the final frame; returning closes the
                # iterator cleanly.
                return

    @staticmethod
    def _synthetic_resync(scope: BrokerScope) -> JobEvent:
        """Resync without per-job context (initial backfill failure
        on a tenant scope)."""
        # We don't know which job_id this resync is "for" — it's
        # advice to the whole subscriber. Use a sentinel.
        from .schemas import JobScope as JobScopeEnvelope
        if isinstance(scope, TenantScope):
            scope_envelope = JobScopeEnvelope(workspace_id=scope.workspace_id)
            job_id = "<resync>"
        elif isinstance(scope, JobScope):
            # Tenant unknown; use a placeholder. Frontend treats the
            # resync as "refetch everything you're watching".
            scope_envelope = JobScopeEnvelope(workspace_id="<unknown>")
            job_id = scope.job_id
        else:
            raise TypeError(f"Unknown BrokerScope: {scope!r}")
        return JobEvent(
            v=1,
            type="resync",
            job_id=job_id,
            kind="aggregation",  # arbitrary; clients ignore on resync
            scope=scope_envelope,
            sequence=0,
            payload={"reason": "backfill_not_supported"},
        )

    @staticmethod
    def _synthetic_resync_for_job(event: JobEvent) -> JobEvent:
        """Resync derived from a real event whose sequence revealed
        a gap. Carries the real ``job_id`` and ``scope`` so the
        SSE client can refetch the right resource."""
        return JobEvent(
            v=1,
            type="resync",
            job_id=event.job_id,
            kind=event.kind,
            scope=event.scope,
            sequence=event.sequence,  # marker, not idempotent
            payload={"reason": "sequence_gap"},
        )
