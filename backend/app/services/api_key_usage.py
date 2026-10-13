"""Counting what each API key does — without a database write per request.

Every request made with a key the platform recognised (``request.state
.api_key_id`` is set — refused ones included, an unknown token never) is
counted in this process's memory: requests, and of those how many changed
something, were refused as a key (401, 403 or 429) or failed otherwise. Every
``FLUSH_SECONDS`` the counts are swapped out and added to ``api_key_usage`` in
one batch, and once more when the process shuts down. So a key's owner can see
how much it is used, and an administrator which keys are busy or failing,
for a few writes a minute per process however busy the keys are.

Best-effort by design: counts that cannot be written are kept for the next
flush, up to the cap, and a process that dies loses at most its last half
minute. A streamed response is counted when its headers go out.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Callable, Optional

from backend.app.auth.api_key_surface import READ_METHODS
from backend.app.db import engine as db_engine
from backend.app.db.repositories import api_key_usage_repo

logger = logging.getLogger(__name__)

FLUSH_SECONDS = 30
#: Keys × days held between flushes. Past it, new keys go uncounted until the
#: next flush (existing ones keep counting) — memory stays bounded whatever
#: a burst of distinct keys does.
MAX_PENDING = 10_000

_REFUSED = frozenset({401, 403, 429})


class UsageRecorder:
    def __init__(self) -> None:
        self._pending: dict[tuple[str, str], list[int]] = {}

    def record(self, key_id: str, *, write: bool, refused: bool, error: bool) -> None:
        # The day is fixed now, not at flush: a request just before midnight
        # belongs to the day it was made.
        day = datetime.now(timezone.utc).date().isoformat()
        counts = self._pending.get((key_id, day))
        if counts is None:
            if len(self._pending) >= MAX_PENDING:
                return
            counts = self._pending[(key_id, day)] = [0, 0, 0, 0]
        counts[0] += 1
        counts[1] += int(write)
        counts[2] += int(refused)
        counts[3] += int(error)

    def _merge_back(self, pending: dict[tuple[str, str], list[int]]) -> None:
        for slot, counts in pending.items():
            held = self._pending.get(slot)
            if held is None:
                if len(self._pending) >= MAX_PENDING:
                    continue
                self._pending[slot] = counts
            else:
                for i, value in enumerate(counts):
                    held[i] += value

    async def flush(self, session_factory: Optional[Callable] = None) -> int:
        """Add everything counted so far to the table. Returns how many key
        and day rows were written."""
        if not self._pending:
            return 0
        pending, self._pending = self._pending, {}
        rows = [(key, day, *counts) for (key, day), counts in pending.items()]
        factory = session_factory or db_engine.get_jobs_session
        try:
            async with factory() as session:
                await api_key_usage_repo.add(session, rows)
                await session.commit()
        except Exception as exc:  # noqa: BLE001 — counts wait for the next flush
            logger.warning("Could not record API key usage (%d rows): %s", len(rows), exc)
            self._merge_back(pending)
            return 0
        return len(rows)

    def reset(self) -> None:
        self._pending.clear()


recorder = UsageRecorder()


def record_request(request, status_code: int) -> None:
    """Count one request made with a key — from the access log middleware,
    whatever became of it."""
    key_id = getattr(request.state, "api_key_id", None)
    if not key_id:
        return
    refused = status_code in _REFUSED
    error = status_code >= 400 and not refused
    context = getattr(request.state, "api_key", None)
    reads = getattr(context, "reads", None)
    if reads is None:
        reads = request.method.upper() in READ_METHODS
    recorder.record(key_id, write=status_code < 400 and not reads, refused=refused, error=error)


async def run_flusher(shutdown: asyncio.Event, *, interval: float = FLUSH_SECONDS) -> None:
    """Flush every ``interval`` seconds until ``shutdown`` is set. Runs in
    every API process — the counts live in each one."""
    while not shutdown.is_set():
        try:
            await asyncio.wait_for(shutdown.wait(), timeout=interval)
        except asyncio.TimeoutError:
            pass
        try:
            await recorder.flush()
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — never let the loop die
            logger.warning("API key usage flush failed: %s", exc, exc_info=True)


__all__ = ["FLUSH_SECONDS", "MAX_PENDING", "UsageRecorder", "record_request", "recorder", "run_flusher"]
