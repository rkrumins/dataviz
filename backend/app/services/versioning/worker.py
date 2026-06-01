"""Versioning projection worker — advances each graph's FalkorDB projection.

Two cooperating mechanisms (matching the locked "inline nudge + reconciling
worker" decision):

* **Reconciling poll loop** (durable backstop, sufficient for correctness): every
  ``PROJECTION_POLL_SECS`` project every graph whose ``projected < target``.
* **Redis-stream consumer** (latency): consume ``{graph_id}`` wake-ups, project,
  ``XACK``; PEL recovery on boot via ``XAUTOCLAIM``.

``ProjectionStateORM`` is the durable queue, so a lost wake-up is still caught by
the poll loop. Per-``graph_id`` serialization keeps the two mechanisms from
projecting the same graph concurrently. Mirrors the aggregation worker runtime.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Optional, Set

from . import config
from .messaging import (
    CONSUMER_GROUP,
    PROJECTION_STREAM,
    ensure_consumer_group,
    get_broker_redis,
)
from .projection import FalkorProjector

logger = logging.getLogger(__name__)


class ProjectionWorker:
    def __init__(
        self,
        projector: FalkorProjector,
        *,
        poll_secs: Optional[int] = None,
        consumer_name: str = "proj-1",
    ):
        self._proj = projector
        self._poll = poll_secs or config.PROJECTION_POLL_SECS
        self._consumer = consumer_name
        self._inflight: Set[str] = set()
        self._lock = asyncio.Lock()
        self._stop = asyncio.Event()

    def stop(self) -> None:
        self._stop.set()

    async def _project_one(self, graph_id: str):
        async with self._lock:
            if graph_id in self._inflight:
                return None                      # already being projected — skip
            self._inflight.add(graph_id)
        try:
            return await self._proj.project_graph(graph_id)
        finally:
            async with self._lock:
                self._inflight.discard(graph_id)

    async def reconcile_once(self):
        """One pass of the durable backstop: project every lagging graph."""
        return await self._proj.project_pending()

    async def run(self) -> None:
        await ensure_consumer_group()
        await self._reclaim_pending()
        await asyncio.gather(self._poll_loop(), self._stream_loop())

    async def _poll_loop(self) -> None:
        while not self._stop.is_set():
            try:
                await self.reconcile_once()
            except Exception:
                logger.exception("projection poll loop error")
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=self._poll)
            except asyncio.TimeoutError:
                pass

    async def _stream_loop(self) -> None:
        client = get_broker_redis()
        while not self._stop.is_set():
            try:
                resp = await client.xreadgroup(
                    CONSUMER_GROUP, self._consumer, {PROJECTION_STREAM: ">"},
                    count=16, block=1000,
                )
            except Exception:
                logger.exception("projection stream read error")
                await asyncio.sleep(1)
                continue
            for _stream, msgs in resp or []:
                for msg_id, fields in msgs:
                    gid = (fields or {}).get("graph_id")
                    try:
                        if gid:
                            await self._project_one(gid)
                    except Exception:
                        logger.exception("projection for %s failed", gid)
                    finally:
                        await client.xack(PROJECTION_STREAM, CONSUMER_GROUP, msg_id)

    async def _reclaim_pending(self) -> None:
        """Re-claim messages a crashed consumer left un-ACKed (PEL recovery)."""
        try:
            client = get_broker_redis()
            _cursor, msgs, _ = await client.xautoclaim(
                PROJECTION_STREAM, CONSUMER_GROUP, self._consumer,
                min_idle_time=60000, count=64,
            )
            for msg_id, fields in msgs or []:
                gid = (fields or {}).get("graph_id")
                if gid:
                    await self._project_one(gid)
                await client.xack(PROJECTION_STREAM, CONSUMER_GROUP, msg_id)
        except Exception:   # pragma: no cover - infra / older redis without XAUTOCLAIM
            logger.debug("projection PEL recovery skipped", exc_info=True)
