"""In-memory ``JobBroker`` for tests and the contract reference.

Two roles:

1. Default for unit tests — no Redis required. ``JobEmitter`` /
   ``JobEventConsumer`` tests run against this; the same end-to-end
   tests then run against ``RedisStreamsJobBroker`` to prove the
   abstraction holds.

2. Contract reference. The semantics implemented here ARE the
   contract: at-least-once publish (well, exactly-once in-memory),
   monotonic-per-job ordering, backfill from ``from_sequence``,
   live-tail via async iteration. Any future broker implementation
   is checked against the same test suite.

Limitations (intentional):

* Single-process only. No fan-out to other replicas. Tests should
  not need this; production never uses it.
* Bounded: ``MAX_PER_STREAM`` caps per-stream history at 1000
  entries (large enough for tests; small enough to surface
  truncation issues if a test produces too aggressively).
"""
from __future__ import annotations

import asyncio
from collections import defaultdict
from typing import AsyncIterator, Optional

from ..broker import BackfillNotSupported, BrokerScope, JobScope, TenantScope
from ..schemas import JobEvent


_MAX_PER_STREAM = 1000


class InMemoryJobBroker:
    """In-process ``JobBroker``. Implements the same contract as the
    Redis broker; useful for tests and as the canonical reference."""

    def __init__(self) -> None:
        # Per-job and per-tenant ordered logs. Each entry is a tuple
        # of (sequence, JobEvent) — sequence drives ordering, not
        # Redis stream ID.
        self._per_job: dict[str, list[tuple[int, JobEvent]]] = defaultdict(list)
        self._per_tenant: dict[str, list[tuple[int, JobEvent]]] = defaultdict(list)
        # Async condition var per stream so blocked subscribers wake
        # on new appends without polling.
        self._per_job_cv: dict[str, asyncio.Condition] = defaultdict(asyncio.Condition)
        self._per_tenant_cv: dict[str, asyncio.Condition] = defaultdict(asyncio.Condition)
        # Closed-stream marker: a final sentinel so subscribers can
        # exit cleanly after the terminal event lands.
        self._closed_jobs: set[str] = set()
        self._closed_tenants: set[str] = set()

    # ── Producer side ─────────────────────────────────────────────

    async def publish(self, event: JobEvent) -> None:
        await self._append(self._per_job[event.job_id], event)
        await self._wake(self._per_job_cv[event.job_id])

        ws_id = event.scope.workspace_id
        await self._append(self._per_tenant[ws_id], event)
        await self._wake(self._per_tenant_cv[ws_id])

    async def _append(
        self, log: list[tuple[int, JobEvent]], event: JobEvent,
    ) -> None:
        log.append((event.sequence, event))
        if len(log) > _MAX_PER_STREAM:
            del log[: len(log) - _MAX_PER_STREAM]

    async def _wake(self, cv: asyncio.Condition) -> None:
        async with cv:
            cv.notify_all()

    # ── Consumer side ─────────────────────────────────────────────

    async def stream(
        self,
        scope: BrokerScope,
        from_sequence: Optional[int] = None,
    ) -> AsyncIterator[JobEvent]:
        # Async generator — caller iterates with ``async for``;
        # never ``await``. Matches RedisStreamsJobBroker shape.
        if isinstance(scope, JobScope):
            async for ev in self._stream_per_job(scope.job_id, from_sequence):
                yield ev
            return
        if isinstance(scope, TenantScope):
            async for ev in self._stream_per_tenant(scope.workspace_id, from_sequence):
                yield ev
            return
        raise TypeError(f"Unknown BrokerScope: {scope!r}")

    async def _stream_per_job(
        self, job_id: str, from_sequence: Optional[int],
    ) -> AsyncIterator[JobEvent]:
        async for ev in self._stream_inner(
            log=self._per_job[job_id],
            cv=self._per_job_cv[job_id],
            closed_set=self._closed_jobs,
            close_key=job_id,
            from_sequence=from_sequence,
        ):
            yield ev

    async def _stream_per_tenant(
        self, workspace_id: str, from_sequence: Optional[int],
    ) -> AsyncIterator[JobEvent]:
        async for ev in self._stream_inner(
            log=self._per_tenant[workspace_id],
            cv=self._per_tenant_cv[workspace_id],
            closed_set=self._closed_tenants,
            close_key=workspace_id,
            from_sequence=from_sequence,
        ):
            yield ev

    async def _stream_inner(
        self,
        log: list[tuple[int, JobEvent]],
        cv: asyncio.Condition,
        closed_set: set[str],
        close_key: str,
        from_sequence: Optional[int],
    ) -> AsyncIterator[JobEvent]:
        # Backfill from sequence (if requested).
        if from_sequence is not None:
            # If the requested sequence is older than the oldest
            # retained entry (truncated), we cannot replay it. Match
            # the Redis broker's contract by raising — callers fall
            # back to REST + live tail.
            if log and log[0][0] > from_sequence:
                raise BackfillNotSupported(
                    f"In-memory broker has truncated entries before "
                    f"sequence={from_sequence}; oldest retained={log[0][0]}"
                )
            for seq, ev in log:
                if seq >= from_sequence:
                    yield ev
        # Live tail: track our cursor by length so re-yielding what
        # we already emitted during backfill doesn't happen.
        cursor = len(log)
        while True:
            if close_key in closed_set and cursor >= len(log):
                return
            if cursor < len(log):
                _, ev = log[cursor]
                cursor += 1
                yield ev
                continue
            async with cv:
                # Re-check inside the lock to avoid the lost-wakeup
                # race; if more entries arrived since the last check,
                # loop back without waiting.
                if cursor < len(log) or close_key in closed_set:
                    continue
                await cv.wait()

    # ── Cleanup ───────────────────────────────────────────────────

    async def close(self, scope: BrokerScope) -> None:
        if isinstance(scope, JobScope):
            self._closed_jobs.add(scope.job_id)
            await self._wake(self._per_job_cv[scope.job_id])
        elif isinstance(scope, TenantScope):
            self._closed_tenants.add(scope.workspace_id)
            await self._wake(self._per_tenant_cv[scope.workspace_id])
        else:
            raise TypeError(f"Unknown BrokerScope: {scope!r}")
