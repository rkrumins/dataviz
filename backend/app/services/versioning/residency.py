"""Graph residency (doc 17): which versioned graphs' keys FalkorDB holds.

With ``GRAPHVER_RESIDENCY_ENABLED`` on, an evicted graph stays evicted: no projection pass reseeds
it (``FalkorProjector.project_graph``'s gate), and its reads are served from Postgres. It comes
back only through a load, which is asked for here (:func:`request_load`) and admitted by the
capacity loop, in the order the loads were first asked for.

The capacity loop (:class:`CapacityLoop`: the projection lane, every policy interval, one leader
across workers) reads each cluster master's memory and every graph with a key of its own
(:func:`gather`), asks the planner what to do (``residency_plan.plan``) and does it: an eviction
through ``CacheManager.evict`` (its guarded UPDATE and drop) with its reason, after which the graph
stays evicted; a load by marking the graph ``rehydrating`` and nudging the projection lane, whose
full seed of the graph's key is the load; a load that does not fit by marking the graph
``waiting_capacity``, to be tried again on the next pass. It measures what keys hold as it goes.
Forks are outside residency: they have no key of their own to evict, load or count.
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Collection, Dict, List, Optional, Tuple

from sqlalchemy import func, literal, select, update

from . import config, db, residency_policy
from .messaging import get_broker_redis, nudge_projection
from .models import GraphORM, ProjectionStateORM, _now
from .residency_plan import Graph, Master, Plan, plan
from .service import bootstrap_unfinished

logger = logging.getLogger(__name__)

#: The graphs whose load has been asked for: a sorted set on the broker, scored by when each was
#: first asked for.
LOAD_REQUESTS = "versioning:residency:loads"
#: One capacity loop across every worker: the advisory lock its passes hold.
_LEADER = "gvresidency"
_READ_TIMEOUT_S = 5.0
#: Keys measured per pass (``GRAPH.MEMORY USAGE``): what was never measured first.
_MEASURE_PER_PASS = 16


async def request_load(graph_id: str) -> None:
    """Ask for ``graph_id`` to be loaded into FalkorDB again. Asking again keeps its place.
    Best effort: a broker outage loses the request, and the next read asks again."""
    try:
        await get_broker_redis().zadd(LOAD_REQUESTS, {graph_id: time.time()}, nx=True)
    except Exception:  # noqa: BLE001 — a read must never fail over it
        logger.warning("could not ask for graph %s to be loaded", graph_id, exc_info=True)


@dataclass
class Snapshot:
    """What a pass read: the masters, the graphs as the planner sees them, each graph's row
    (``key``, ``provider``, ``data_source_id``, ...), each provider's FalkorDB client, and the
    graphs the load queue held."""
    masters: List[Master] = field(default_factory=list)
    graphs: List[Graph] = field(default_factory=list)
    rows: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    clients: Dict[str, Tuple[Any, Optional[str]]] = field(default_factory=dict)
    queued: List[str] = field(default_factory=list)


def _ts(value) -> Optional[datetime]:
    """A timestamp column as an aware datetime (``last_projected_at`` is ISO-8601 text)."""
    if value is None or isinstance(value, datetime):
        return value
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


async def _provider_client(provider: str, key: str) -> Tuple[Any, Optional[str]]:
    """The FalkorDB client (and its topology mode) a provider's keys are reached through, as the
    projector reaches them (``falkor_graph_registry``)."""
    from backend.app.providers.falkor_graph_registry import resolve_provider_conn_config
    from backend.app.providers.falkordb_connection import env_conn_config, graph_clients

    cfg = (env_conn_config() if provider == config.DEFAULT_FALKOR_PROVIDER
           else await resolve_provider_conn_config(provider))
    return (await graph_clients().resolve_graph(cfg, key)).client, cfg.mode


async def _entities(data_source_ids: Collection[str]) -> Dict[str, int]:
    """Nodes plus edges each data source holds, rollups included, as its statistics last counted
    them — what a graph never measured is estimated from."""
    if not data_source_ids:
        return {}
    from backend.app.db.engine import get_readonly_session
    from backend.app.db.models import DataSourceStatsORM as Stats

    try:
        async with get_readonly_session() as s:
            rows = (await s.execute(
                select(Stats.data_source_id, Stats.node_count + Stats.edge_count)
                .where(Stats.data_source_id.in_(list(data_source_ids))))).all()
    except Exception:  # noqa: BLE001 — an estimate the pass can do without
        logger.warning("residency: data source statistics unreadable", exc_info=True)
        return {}
    return {ds: int(n or 0) for ds, n in rows}


async def gather(*, graph_ids: Optional[Collection[str]] = None) -> Snapshot:
    """Read what a pass decides from: every live graph that is not a fork and has a key of its
    own (only ``graph_ids``, when given), when each load was asked for, which graphs a read
    lease holds, and each master's memory, its hold and what the aggregation write governor
    holds on it. Waiting graphs whose request the broker lost go to the end of the queue, and so
    does an Always graph that is not resident."""
    from backend.app.providers.shard_capacity import hold_reason, owner_endpoint, read_shard_memory
    from backend.app.services.aggregation.capacity import reserved_on
    from .cache_manager import is_pinned

    ps, head = ProjectionStateORM, GraphORM.main_head_commit_seq
    query = (
        select(ps.graph_id, ps.falkor_graph_name, ps.falkor_provider, ps.owns_falkor_graph,
               ps.status, ps.residency, ps.last_read_at, ps.last_projected_at, ps.size_bytes,
               ps.size_measured_at, ps.projected_commit_seq, ps.target_commit_seq, head,
               GraphORM.data_source_id,
               (head > 1).label("past_genesis"),
               (~select(1).where(*bootstrap_unfinished(ps.graph_id)).correlate(ps).exists())
               .label("enable_finished"))
        .join(GraphORM, GraphORM.id == ps.graph_id)
        .where(GraphORM.deleted_at.is_(None), GraphORM.fork_parent_graph_id.is_(None),
               ps.falkor_graph_name.isnot(None),
               ps.falkor_graph_name != literal("gv_").concat(ps.graph_id)))
    if graph_ids is not None:
        query = query.where(ps.graph_id.in_(list(graph_ids)))
    async with db.graphver_session() as s:
        found = (await s.execute(query)).all()

    snap = Snapshot()
    try:
        asked = dict(await get_broker_redis().zrange(LOAD_REQUESTS, 0, -1, withscores=True))
    except Exception:  # noqa: BLE001 — the pass goes on with the waiting graphs it knows
        logger.warning("residency: load requests unreadable", exc_info=True)
        asked = {}
    snap.queued = list(asked)
    now = time.time()
    for r in found:
        if r.graph_id not in asked and (r.status == "waiting_capacity" or
                                        (r.status == "evicted" and r.residency == "always")):
            asked[r.graph_id] = now
    estimate = await _entities({r.data_source_id for r in found if r.size_bytes is None})
    by_provider: Dict[str, List[Any]] = {}
    for r in found:
        by_provider.setdefault(r.falkor_provider or config.DEFAULT_FALKOR_PROVIDER, []).append(r)
    endpoint_of: Dict[str, str] = {}
    read: set = set()
    for provider, rows in by_provider.items():
        try:
            client, mode = await _provider_client(provider, rows[0].falkor_graph_name)
        except Exception:  # noqa: BLE001 — its graphs count as on a master that cannot be read
            logger.warning("residency: FalkorDB provider %s unreachable", provider, exc_info=True)
            for r in rows:
                endpoint_of[r.graph_id] = f"{provider}:unreachable"
            continue
        snap.clients[provider] = (client, mode)
        for r in rows:
            endpoint_of[r.graph_id] = await owner_endpoint(
                client, mode=mode, graph_key=r.falkor_graph_name, timeout=_READ_TIMEOUT_S)
        for r in rows:
            endpoint = endpoint_of[r.graph_id]
            if endpoint in read or endpoint == "unknown":
                continue
            read.add(endpoint)
            reading = await read_shard_memory(client, mode=mode, graph_key=r.falkor_graph_name,
                                              timeout=_READ_TIMEOUT_S, include_config=False,
                                              refresh=False)
            hold = hold_reason(reading, expected_replicas=None, watch_replicas=False)
            try:
                reserved = (await reserved_on(reading.endpoint))[0]
            except Exception:  # noqa: BLE001 — loads wait until it can be read again
                logger.warning("residency: reservations on %s unreadable", endpoint, exc_info=True)
                reserved, hold = 0, ("unmeasured", "")
            snap.masters.append(Master(
                endpoint=endpoint,
                used=reading.used if reading.source == "measured" else None,
                maxmemory=int(reading.maxmemory or 0), hold=hold[0] if hold else None,
                reserved=reserved))

    for r in found:
        candidate = r.owns_falkor_graph and r.status == "idle" and r.residency != "always"
        target = max(r.target_commit_seq, r.main_head_commit_seq)
        snap.rows[r.graph_id] = dict(r._mapping, key=r.falkor_graph_name,
                                     provider=r.falkor_provider or config.DEFAULT_FALKOR_PROVIDER,
                                     endpoint=endpoint_of[r.graph_id])
        snap.graphs.append(Graph(
            graph_id=r.graph_id, endpoint=endpoint_of[r.graph_id], residency=r.residency,
            status=r.status, owned=bool(r.owns_falkor_graph),
            evictable=bool(r.past_genesis and r.enable_finished),
            leased=candidate and await is_pinned(r.graph_id),
            last_read=_ts(r.last_read_at) or _ts(r.last_projected_at),
            size_bytes=r.size_bytes, entities=estimate.get(r.data_source_id),
            seeding=(r.status == "rehydrating" and r.projected_commit_seq < target)
            or (r.status in ("rebuilding", "reseeding") and r.projected_commit_seq == 0),
            requested_at=asked.get(r.graph_id)))
    return snap


async def preview(policy, *, graph_ids: Optional[Collection[str]] = None) -> Tuple[Plan, Snapshot]:
    """What the next pass would do under ``policy``, acting on nothing."""
    snap = await gather(graph_ids=graph_ids)
    return plan(policy, snap.masters, snap.graphs, datetime.now(timezone.utc)), snap


class CapacityLoop:
    """The projection lane's capacity loop (doc 17): one pass is :meth:`run_once`."""

    def __init__(self, projector):
        self._proj = projector
        # Loads this process started: graph id -> (its master, the master's use then), for the
        # used-memory delta that sizes the key where GRAPH.MEMORY USAGE cannot.
        self._started: Dict[str, Tuple[str, Optional[int]]] = {}

    async def run_once(self, *, graph_ids: Optional[Collection[str]] = None) -> Optional[Plan]:
        """One pass, under the leader lock: gather, plan, act, measure. Returns the plan, or None
        when another worker's pass holds the lock."""
        lock_scope = db.graphver_lock_session()
        lock_s = await lock_scope.__aenter__()
        lock_arg = func.hashtext(_LEADER)
        acquired = False
        try:
            acquired = bool(await lock_s.scalar(select(func.pg_try_advisory_lock(lock_arg))))
            if not acquired:
                return None
            policy = await residency_policy.resolve()
            snap = await gather(graph_ids=graph_ids)
            decided = plan(policy, snap.masters, snap.graphs, datetime.now(timezone.utc))
            await self._measure(snap, first={e.graph_id for e in decided.evictions})
            await self._act(decided, snap)
            await _clear_spent(snap, full=graph_ids is None)
            return decided
        finally:
            try:
                if acquired:
                    await lock_s.execute(select(func.pg_advisory_unlock(lock_arg)))
            finally:
                await lock_scope.__aexit__(None, None, None)

    async def _act(self, decided: Plan, snap: Snapshot) -> None:
        from .cache_manager import CacheManager

        evictor = CacheManager(self._proj)
        for e in decided.evictions:
            if await evictor.evict(e.graph_id, drop_graph=self._proj.drop_graph, reason=e.reason):
                logger.info("residency: evicted graph %s from %s (%s, %d bytes)",
                            e.graph_id, e.endpoint, e.reason, e.bytes)
        used = {m.endpoint: m.used for m in snap.masters}
        for load in decided.loads:
            if await _start_load(load.graph_id):
                self._started[load.graph_id] = (load.endpoint, used.get(load.endpoint))
                logger.info("residency: loading graph %s onto %s (about %d bytes)",
                            load.graph_id, load.endpoint, load.bytes)
        for wait in decided.waits:
            async with db.graphver_session() as s:
                entered = (await s.execute(
                    update(ProjectionStateORM)
                    .where(ProjectionStateORM.graph_id == wait.graph_id,
                           ProjectionStateORM.status == "evicted")
                    .values(status="waiting_capacity", updated_at=_now())
                    .returning(ProjectionStateORM.graph_id)
                    .execution_options(synchronize_session=False))).first()
            if entered and wait.reason == "capacity":
                logger.warning("residency: graph %s waits for room on %s: its load needs %d bytes "
                               "more than the master has under its start mark",
                               wait.graph_id, wait.endpoint, wait.shortfall or 0)

    async def _measure(self, snap: Snapshot, *, first: Collection[str]) -> None:
        """Measure what resident keys hold — those about to be evicted (``first``) and the
        never-measured first, then those projected since their last measurement — with
        ``GRAPH.MEMORY USAGE``, else, for a load this process started, by what its master's use
        grew across it. A key evicted before it was measured is then loaded by its measure."""
        from backend.app.providers.shard_capacity import read_graph_memory

        used = {m.endpoint: m.used for m in snap.masters}
        due = [r for r in snap.rows.values()
               if r["status"] == "idle" and r["owns_falkor_graph"] and r["provider"] in snap.clients
               and (r["size_measured_at"] is None
                    or (_ts(r["last_projected_at"]) or r["size_measured_at"])
                    > r["size_measured_at"])]
        due.sort(key=lambda r: (r["graph_id"] not in first, r["size_measured_at"] is not None,
                                r["size_measured_at"] or datetime.min.replace(tzinfo=timezone.utc)))
        for r in due[:_MEASURE_PER_PASS]:
            client, mode = snap.clients[r["provider"]]
            size = await read_graph_memory(client, mode=mode, graph_key=r["key"],
                                           timeout=_READ_TIMEOUT_S)
            endpoint, before = self._started.pop(r["graph_id"], (None, None))
            if size is None and before is not None and used.get(endpoint) is not None:
                size = max(0, used[endpoint] - before)
            if size is None:
                continue
            async with db.graphver_session() as s:
                await s.execute(update(ProjectionStateORM)
                                .where(ProjectionStateORM.graph_id == r["graph_id"])
                                .values(size_bytes=size, size_measured_at=func.now())
                                .execution_options(synchronize_session=False))


async def _clear_spent(snap: Snapshot, *, full: bool) -> None:
    """Take the requests that are spent off the load queue: for a graph that is resident (or
    loading), and, after a pass over every graph (``full``), for one that is gone."""
    spent = [g for g in snap.queued
             if (g in snap.rows and snap.rows[g]["status"] not in ("evicted", "waiting_capacity"))
             or (full and g not in snap.rows)]
    if not spent:
        return
    try:
        await get_broker_redis().zrem(LOAD_REQUESTS, *spent)
    except Exception:  # noqa: BLE001 — taken off on a later pass
        logger.debug("residency: spent load requests not taken off the queue", exc_info=True)


async def _start_load(graph_id: str) -> bool:
    """Start an admitted load: the graph becomes ``rehydrating`` at watermark 0 (a status CAS, so
    one load per graph; the projection lock then makes its pass single-flight), leaves the queue,
    and the projection lane is nudged to seed its key."""
    async with db.graphver_session() as s:
        row = (await s.execute(
            update(ProjectionStateORM)
            .where(ProjectionStateORM.graph_id == graph_id,
                   ProjectionStateORM.status.in_(("evicted", "waiting_capacity")))
            .values(status="rehydrating", projected_commit_seq=0, last_error=None,
                    failed_attempts=0, next_retry_at=None, updated_at=_now(),
                    epoch=ProjectionStateORM.epoch + 1)
            .returning(ProjectionStateORM.graph_id)
            .execution_options(synchronize_session=False))).first()
    if row is None:
        return False
    try:
        await get_broker_redis().zrem(LOAD_REQUESTS, graph_id)
    except Exception:  # noqa: BLE001 — a spent request leaves on a later pass
        logger.debug("residency: load request for %s not removed", graph_id, exc_info=True)
    await nudge_projection(graph_id)
    return True
