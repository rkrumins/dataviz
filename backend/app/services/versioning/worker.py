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
from typing import Callable, Optional, Set, TYPE_CHECKING

from . import config
from .messaging import (
    CONSUMER_GROUP,
    PROJECTION_STREAM,
    ensure_consumer_group,
    get_broker_redis,
)
from .cache_manager import CacheManager
from .projection import FalkorProjector

if TYPE_CHECKING:
    from .service import GraphVersioningService

logger = logging.getLogger(__name__)


class ProjectionWorker:
    def __init__(
        self,
        projector: FalkorProjector,
        *,
        poll_secs: Optional[int] = None,
        consumer_name: str = "proj-1",
        versioning: Optional["GraphVersioningService"] = None,
        sweep_secs: Optional[int] = None,
        evict_budget: Optional[Callable[[str], int]] = None,
        evict_secs: Optional[int] = None,
    ):
        self._proj = projector
        self._poll = poll_secs or config.PROJECTION_POLL_SECS
        self._consumer = consumer_name
        self._inflight: Set[str] = set()
        self._lock = asyncio.Lock()
        self._stop = asyncio.Event()
        self._versioning = versioning            # enables the idle-draft sweep loop
        self._sweep_secs = sweep_secs or config.DRAFT_SWEEP_SECS
        self._evict_budget = evict_budget        # provider_id -> max resident graphs; enables eviction
        self._evict_secs = evict_secs or config.EVICT_SECS
        self._cache = CacheManager(projector) if evict_budget is not None else None

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

    async def sweep_once(self):
        """One pass of the idle-draft janitor (plan §17 #8); no-op without a service."""
        if self._versioning is None:
            return []
        return await self._versioning.sweep_idle_drafts()

    async def evict_once(self):
        """One pass of the per-provider RAM-budget cache janitor (plan §16.5 #9-10):
        within each FalkorDB provider, evict the coldest resident graphs above that
        provider's budget. Pinned/in-flight graphs are skipped (evicting deeper to
        compensate); no-op without a budget resolver."""
        if self._cache is None:
            return []
        evicted = []
        for provider in await self._cache.resident_providers():
            budget = self._evict_budget(provider)
            if budget <= 0:
                continue                          # 0 ⇒ unlimited for this provider
            resident = await self._cache.resident_count(provider)
            need = resident - budget
            if need <= 0:
                continue
            done = 0
            for gid in await self._cache.lru_candidates(provider, limit=resident):
                if done >= need:
                    break
                if await self._cache.evict(gid, drop_graph=self._proj.drop_graph):
                    evicted.append(gid)
                    done += 1
        return evicted

    async def run(self) -> None:
        await ensure_consumer_group()
        await self._reclaim_pending()
        loops = [self._poll_loop(), self._stream_loop()]
        if self._versioning is not None:
            loops.append(self._sweep_loop())
        if self._cache is not None:
            loops.append(self._evict_loop())
        await asyncio.gather(*loops)

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

    async def _sweep_loop(self) -> None:
        while not self._stop.is_set():
            try:
                swept = await self.sweep_once()
                if swept:
                    logger.info("auto-abandoned %d idle draft(s)", len(swept))
            except Exception:
                logger.exception("draft sweep loop error")
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=self._sweep_secs)
            except asyncio.TimeoutError:
                pass

    async def _evict_loop(self) -> None:
        while not self._stop.is_set():
            try:
                evicted = await self.evict_once()
                if evicted:
                    logger.info("evicted %d cold graph(s) from the FalkorDB cache", len(evicted))
            except Exception:
                logger.exception("eviction loop error")
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=self._evict_secs)
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
