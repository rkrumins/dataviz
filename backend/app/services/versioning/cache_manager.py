"""Evictable / rebuildable FalkorDB cache (plan §5, §16.5 #9-10).

``main`` graphs in FalkorDB are a **rebuildable cache** of Postgres, not the
source of truth, so we can spend RAM lazily:

* **Evict** a cold ``main`` from FalkorDB (LRU by ``last_projected_at``), marking
  ``status=evicted`` and resetting ``projected_commit_seq=0``. Because projected
  now lags target, the projection worker's poll loop will **rebuild it from
  Postgres** on next pass — and a read of an evicted graph serves the bounded
  Postgres fallback meanwhile (see the read path, P2).
* **Single-flight rebuild**: a Redis ``SET NX`` lock ensures only one rebuild runs
  for a graph even across the standalone worker + in-process loop + a read-trigger
  (no thundering herd).
* **Read lease / refcount**: an active read pins its graph via a TTL'd Redis
  counter; eviction **skips a pinned graph** so it is never dropped mid-read.

This is the riskiest scale bet (FalkorDB as volatile cache), so the mechanics are
proven directly against Postgres + Redis here; the per-provider RAM-budget daemon
is a thin loop over :meth:`lru_candidates`.
"""
from __future__ import annotations

import logging
from typing import Awaitable, Callable, List, Optional

from sqlalchemy import select, func

from . import config, db
from .messaging import get_broker_redis
from .models import ProjectionStateORM

logger = logging.getLogger(__name__)


def _lock_key(graph_id: str) -> str:
    return f"versioning:rebuild:{graph_id}"


def _lease_key(graph_id: str) -> str:
    return f"versioning:lease:{graph_id}"


# Module-level lease helpers so a read path can pin a graph without holding a
# CacheManager (which needs a projector). Best-effort: a broker outage must never
# fail a read — it just means the lease isn't held for that request.
async def acquire_lease(graph_id: str) -> bool:
    try:
        r = get_broker_redis()
        await r.incr(_lease_key(graph_id))
        await r.expire(_lease_key(graph_id), config.LEASE_TTL)
        return True
    except Exception:   # pragma: no cover - infra
        return False


async def release_lease(graph_id: str) -> None:
    try:
        await get_broker_redis().decr(_lease_key(graph_id))
    except Exception:   # pragma: no cover - infra
        logger.debug("lease release failed for %s", graph_id, exc_info=True)


async def is_pinned(graph_id: str) -> bool:
    try:
        v = await get_broker_redis().get(_lease_key(graph_id))
        return v is not None and int(v) > 0
    except (TypeError, ValueError):
        return False


class CacheManager:
    def __init__(self, projector, session_factory=db.graphver_session):
        self._proj = projector
        self._session = session_factory

    # ---- read lease (pin) ------------------------------------------------- #
    async def acquire_lease(self, graph_id: str) -> None:
        await acquire_lease(graph_id)

    async def release_lease(self, graph_id: str) -> None:
        await release_lease(graph_id)

    async def is_pinned(self, graph_id: str) -> bool:
        return await is_pinned(graph_id)

    # ---- eviction --------------------------------------------------------- #
    async def evict(self, graph_id: str, *, drop_graph: Callable[..., Awaitable]) -> bool:
        """Evict a cold ``main`` from FalkorDB. Skips a pinned graph. Marks
        ``status=evicted`` + ``projected_commit_seq=0`` (so the worker rebuilds it)
        and drops the FalkorDB graph via ``drop_graph(name, provider_id)`` — routed to
        the graph's pinned provider instance. Returns whether it evicted."""
        if await self.is_pinned(graph_id):
            return False
        async with self._session() as s:
            ps = await s.get(ProjectionStateORM, graph_id)
            if ps is None or ps.status == "evicted":
                return False
            name = ps.falkor_graph_name
            provider_id = ps.falkor_provider
            ps.status = "evicted"
            ps.projected_commit_seq = 0
        if name:
            try:
                await drop_graph(name, provider_id)
            except Exception:   # pragma: no cover - infra
                logger.warning("dropping FalkorDB graph %s failed (will be overwritten on rebuild)", name)
        return True

    # ---- single-flight rebuild ------------------------------------------- #
    async def ensure_rebuilt(self, graph_id: str) -> bool:
        """If the graph is evicted, rebuild it from Postgres under a single-flight
        lock. Returns ``True`` iff THIS caller performed the rebuild (concurrent
        callers return ``False`` while the holder rebuilds)."""
        async with self._session() as s:
            ps = await s.get(ProjectionStateORM, graph_id)
            if ps is None or ps.status != "evicted":
                return False
        r = get_broker_redis()
        got = await r.set(_lock_key(graph_id), "1", nx=True, ex=config.REBUILD_LOCK_TTL)
        if not got:
            return False                         # another rebuild already in flight
        try:
            async with self._session() as s:
                ps = await s.get(ProjectionStateORM, graph_id)
                if ps is None or ps.status != "evicted":
                    return False
                ps.status = "rebuilding"
            await self._proj.project_graph(graph_id)   # projected==0 → full reseed; sets status idle
            return True
        finally:
            await r.delete(_lock_key(graph_id))

    # ---- per-provider RAM budget ----------------------------------------- #
    @staticmethod
    def _provider_col():
        # NULL provider ⇒ the "default" instance, so single-FalkorDB deployments
        # are simply one provider.
        return func.coalesce(ProjectionStateORM.falkor_provider, config.DEFAULT_FALKOR_PROVIDER)

    async def resident_providers(self) -> List[str]:
        """Distinct FalkorDB providers with at least one resident graph."""
        async with self._session() as s:
            rows = (await s.execute(
                select(func.distinct(self._provider_col()))
                .where(ProjectionStateORM.status == "idle")
            )).scalars().all()
        return list(rows)

    async def resident_count(self, provider: str) -> int:
        """Resident ``main`` caches on one FalkorDB provider — its evictable set."""
        async with self._session() as s:
            return int((await s.execute(
                select(func.count()).select_from(ProjectionStateORM)
                .where(ProjectionStateORM.status == "idle")
                .where(self._provider_col() == provider)
            )).scalar_one())

    # ---- LRU policy ------------------------------------------------------- #
    async def lru_candidates(self, provider: Optional[str] = None, limit: int = 10) -> List[str]:
        """Coldest resident graphs (oldest ``last_projected_at`` first) — the
        eviction order for a RAM-budget sweep. Scoped to ``provider`` when given."""
        async with self._session() as s:
            q = (select(ProjectionStateORM.graph_id)
                 .where(ProjectionStateORM.status == "idle")
                 .order_by(ProjectionStateORM.last_projected_at.asc().nulls_first())
                 .limit(limit))
            if provider is not None:
                q = q.where(self._provider_col() == provider)
            rows = (await s.execute(q)).scalars().all()
        return list(rows)
