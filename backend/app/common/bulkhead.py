"""Bulkheads: at most N of one kind of slow work at once, per process.

A burst of slow reads — free-text searches over the activity log, CSV exports,
cold builds of long-window documents — could otherwise take every connection
in the READONLY pool. The readiness probe draws from the same pool, so a busy
pod would report itself unready and its traffic would pile onto the next one.
Each kind of slow work gets a fixed share instead. Work beyond its share waits
briefly for a slot, then is refused with a retry hint: a client told to retry
in a few seconds is a better answer than a pool that times everyone out.

Re-entrant within a task: work that already holds a slot of a bulkhead, and
asks for another of the same one — a summary whose closed days are folded
through the same cache — proceeds on the slot it has, so nested work can never
wait on itself.
"""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from contextvars import ContextVar
from typing import AsyncIterator, Optional


class Busy(Exception):
    """Every slot of a bulkhead stayed taken for as long as a caller waits."""

    def __init__(self, kind: str, retry_after_seconds: int) -> None:
        super().__init__(f"Too many {kind} at once; try again shortly.")
        self.kind = kind
        self.retry_after_seconds = retry_after_seconds


class Bulkhead:
    def __init__(
        self, kind: str, limit: int, *,
        wait_seconds: float, retry_after_seconds: int = 5,
    ) -> None:
        self.kind = kind
        self.limit = limit
        self.wait_seconds = wait_seconds
        self.retry_after_seconds = retry_after_seconds
        self._held: ContextVar[bool] = ContextVar(f"bulkhead:{kind}", default=False)
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._slots: Optional[asyncio.Semaphore] = None

    def _semaphore(self) -> asyncio.Semaphore:
        # One per event loop: a semaphore made on another loop (an earlier
        # test's, say) cannot be waited on from this one.
        loop = asyncio.get_running_loop()
        if self._slots is None or self._loop is not loop:
            self._loop, self._slots = loop, asyncio.Semaphore(self.limit)
        return self._slots

    @property
    def full(self) -> bool:
        """Whether every slot is taken right now."""
        return self._semaphore().locked()

    @asynccontextmanager
    async def slot(self) -> AsyncIterator[None]:
        """Hold one slot for the body; :class:`Busy` if none frees in time."""
        if self._held.get():
            yield
            return
        slots = self._semaphore()
        try:
            await asyncio.wait_for(slots.acquire(), timeout=self.wait_seconds)
        except asyncio.TimeoutError:
            raise Busy(self.kind, self.retry_after_seconds) from None
        token = self._held.set(True)
        try:
            yield
        finally:
            self._held.reset(token)
            slots.release()
