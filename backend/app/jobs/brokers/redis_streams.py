"""Redis Streams ``JobBroker`` — production default.

Implements :class:`backend.app.jobs.broker.JobBroker` using:

* **Per-job event log:** ``XADD job:events:{id} MAXLEN ~200``.
  Backfill via ``XRANGE``; live tail via ``XREAD BLOCK``.
* **Per-tenant fan-out:** ``XADD job:tenant:{ws} MAXLEN ~1000``.
  Same shape; subscribers on either stream see the same envelopes
  filtered/scoped to them.
* **Pub/Sub channel** ``aggregation.events`` is also written by the
  ``JobEmitter`` at the terminal event for cross-service state sync
  (``event_listener.py`` continues to consume there). That's outside
  this broker — handled in the emitter directly so swapping brokers
  doesn't lose the legacy sync path.

Reliability:

* All Redis operations are pipelined where possible (publish is a
  single round-trip even though it writes to two streams).
* Errors (ConnectionError, TimeoutError, OSError) propagate to the
  caller. The ``JobEmitter`` wraps publish in try/except to honour
  the Redis-down resilience contract; the broker itself stays a
  thin transport layer with no swallowing.
* Backfill via ``XRANGE`` is bounded by ``count`` to avoid loading
  the whole stream into memory on a long-running consumer connect.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, AsyncIterator, Optional

from ..broker import BackfillNotSupported, BrokerScope, JobScope, TenantScope
from ..redis_keys import (
    PER_JOB_STREAM_MAXLEN,
    PER_TENANT_STREAM_MAXLEN,
    per_job_events_stream,
    per_tenant_events_stream,
)
from ..schemas import JobEvent

logger = logging.getLogger(__name__)


# Stream payloads carry the envelope as a single ``data`` JSON field
# so we don't have to negotiate Redis stream-field schemas with future
# brokers. Keeps the wire format identical across implementations.
_FIELD_DATA = "data"

# How many entries to fetch per backfill round-trip. The cap is
# ``MAXLEN ~200`` per stream, so a single XRANGE typically covers
# the whole history. Bounded so a future MAXLEN bump doesn't load
# tens of thousands of entries in one call.
_BACKFILL_PAGE = 500

# How long XREAD BLOCKs. Short enough to honour cancellation
# promptly; long enough that a quiet stream doesn't burn CPU.
_XREAD_BLOCK_MS = 5_000


class RedisStreamsJobBroker:
    """Redis Streams implementation of :class:`JobBroker`.

    Constructed with an injected ``redis_client`` so tests can pass a
    fake; production wires the existing
    :func:`backend.app.services.aggregation.redis_client.get_redis`.
    """

    def __init__(self, redis_client: Any) -> None:
        self._redis = redis_client

    # ── Producer side ─────────────────────────────────────────────

    async def publish(self, event: JobEvent) -> None:
        payload = json.dumps(event.to_wire(), separators=(",", ":"))
        per_job = per_job_events_stream(event.job_id)
        per_tenant = per_tenant_events_stream(event.scope.workspace_id)

        # Pipeline both XADDs into one round-trip. Per-job is the
        # primary; per-tenant fan-out (Phase 3 readiness) is
        # cheaper to write here than to retrofit later.
        pipe = self._redis.pipeline(transaction=False)
        pipe.execute_command(
            "XADD", per_job,
            "MAXLEN", "~", str(PER_JOB_STREAM_MAXLEN),
            "*", _FIELD_DATA, payload,
        )
        pipe.execute_command(
            "XADD", per_tenant,
            "MAXLEN", "~", str(PER_TENANT_STREAM_MAXLEN),
            "*", _FIELD_DATA, payload,
        )
        await pipe.execute()

    # ── Consumer side ─────────────────────────────────────────────

    async def stream(
        self,
        scope: BrokerScope,
        from_sequence: Optional[int] = None,
    ) -> AsyncIterator[JobEvent]:
        # Async generator — caller iterates with ``async for``;
        # never ``await``. Matches InMemoryJobBroker shape.
        if isinstance(scope, JobScope):
            stream_key = per_job_events_stream(scope.job_id)
        elif isinstance(scope, TenantScope):
            stream_key = per_tenant_events_stream(scope.workspace_id)
        else:
            raise TypeError(f"Unknown BrokerScope: {scope!r}")

        async for ev in self._stream_iter(stream_key, from_sequence):
            yield ev

    async def _stream_iter(
        self,
        stream_key: str,
        from_sequence: Optional[int],
    ) -> AsyncIterator[JobEvent]:
        # Track the last Redis stream ID we've delivered. Starts
        # before the first entry, advanced as we yield each event.
        last_id: bytes | str = "0"

        # ── Backfill ──
        if from_sequence is not None:
            # Read everything; filter by envelope sequence. Redis
            # stream IDs are time-based, not sequence-based, so we
            # can't translate ``from_sequence`` to a stream-ID
            # predicate cheaply. Fetching the (bounded) history and
            # filtering envelope-side is cheap given MAXLEN ~200.
            entries = await self._redis.xrange(
                stream_key, min="-", max="+", count=_BACKFILL_PAGE,
            )
            replayed_any = False
            for entry_id, fields in entries:
                event = self._parse_entry(fields)
                if event is None:
                    continue
                if event.sequence < from_sequence:
                    continue
                replayed_any = True
                last_id = entry_id
                yield event

            # If the caller asked to backfill from a sequence that's
            # older than anything in the stream (truncated), match
            # the in-memory broker's contract by raising. Callers
            # fall back to REST + live-tail.
            if not replayed_any and entries:
                # Stream has entries but all of them are newer than
                # ``from_sequence`` is plausible — the requested
                # sequence is in the past, and MAXLEN truncated it.
                oldest_event = self._parse_entry(entries[0][1])
                if oldest_event is not None and oldest_event.sequence > from_sequence:
                    raise BackfillNotSupported(
                        f"Redis stream {stream_key} truncated past "
                        f"sequence={from_sequence}; oldest retained="
                        f"{oldest_event.sequence}"
                    )

        # ── Live tail ──
        while True:
            try:
                # XREAD with BLOCK; ``last_id`` is the cursor.
                # Returns entries strictly newer than ``last_id``.
                resp = await self._redis.xread(
                    {stream_key: last_id},
                    block=_XREAD_BLOCK_MS,
                    count=_BACKFILL_PAGE,
                )
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                # Transient Redis errors: log and retry. The consumer
                # is mid-iteration; failing here would tear down the
                # SSE connection unnecessarily.
                logger.warning(
                    "RedisStreamsJobBroker: XREAD error on %s (will retry): %s",
                    stream_key, exc,
                )
                await asyncio.sleep(1.0)
                continue

            if not resp:
                # Block timed out, no new entries. Loop back.
                continue

            for _stream_name, entries in resp:
                for entry_id, fields in entries:
                    last_id = entry_id
                    event = self._parse_entry(fields)
                    if event is None:
                        continue
                    yield event

    @staticmethod
    def _parse_entry(fields: dict[bytes | str, bytes | str]) -> Optional[JobEvent]:
        # Redis returns keys/values as bytes by default. Normalise.
        for k, v in fields.items():
            key = k.decode() if isinstance(k, (bytes, bytearray)) else k
            if key == _FIELD_DATA:
                value = v.decode() if isinstance(v, (bytes, bytearray)) else v
                try:
                    return JobEvent.from_wire(json.loads(value))
                except Exception as exc:
                    logger.warning(
                        "RedisStreamsJobBroker: malformed envelope (skipping): %s",
                        exc,
                    )
                    return None
        return None

    # ── Cleanup ───────────────────────────────────────────────────

    async def close(self, scope: BrokerScope) -> None:
        # Streams have natural retention via TTL on entries (no
        # explicit per-stream TTL — MAXLEN handles bounded growth).
        # We don't proactively DEL the stream here so SSE consumers
        # that connect just after a terminal can still backfill the
        # final events. Phase 2/3 may add an explicit
        # PEXPIRE/finalizer if cardinality becomes a concern.
        return None
