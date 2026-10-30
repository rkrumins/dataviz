"""Graph residency (doc 17): which versioned graphs' keys FalkorDB holds.

With ``GRAPHVER_RESIDENCY_ENABLED`` on, an evicted graph stays evicted: no projection pass reseeds
it (``FalkorProjector.project_graph``'s gate), and its reads are served from Postgres. It comes
back only through a load, which is asked for here (:func:`request_load`) and admitted by the
capacity loop, in the order the loads were first asked for. What asks: a person's read of a
Standard or Always graph, and of a Coldline graph larger than the canvas-load threshold
(:func:`on_read`, which ContextEngine calls); FalkorDB-only work on a Coldline graph (deep search,
node degrees, native queries answer 503 ``graph_loading`` meanwhile, by :data:`READING`); an
administrator's "Load now" or Always; an operator's rebuild.

The capacity loop (:class:`CapacityLoop`: the projection lane, every policy interval, one leader
across workers) reads each cluster master's memory and every graph with a key of its own
(:func:`gather`), asks the planner what to do (``residency_plan.plan``) and does it: an eviction
through ``CacheManager.evict`` (its guarded UPDATE and drop) with its reason, after which the graph
stays evicted; a load by marking the graph ``rehydrating`` and nudging the projection lane, whose
full seed of the graph's key is the load; a load that does not fit by marking the graph
``waiting_capacity``, to be tried again on the next pass. A loaded key serves reads once its
summaries are built too; then the graph is ``idle``. It measures what keys hold as it goes. Forks
are outside residency: they have no key of their own to evict, load or count, and their reads
count for their root, whose key they read.

Reads: each process notes the graphs people read (:func:`on_read`) and writes when, once a minute,
to ``last_read_at`` (:func:`flush_reads`); a read FalkorDB serves takes the graph's read lease
for ``GRAPHVER_TRACE_LEASE_TTL_SECS``, so no pass evicts a graph mid-read.
"""
from __future__ import annotations

import asyncio
import logging
import time
from contextvars import ContextVar
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Collection, Dict, List, Mapping, Optional, Tuple

from sqlalchemy import func, literal, select, text, update

from . import config, db, residency_policy
from .messaging import get_broker_redis, nudge_projection
from .models import GraphORM, ProjectionStateORM, _now
from .residency_plan import Graph, Master, Plan, admit, need, plan
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


@dataclass(frozen=True)
class Reading:
    """A read of a graph whose key is not in FalkorDB: the graph whose key it needs (a fork's
    root), its state, and when to try FalkorDB-only work again (the capacity loop's interval)."""
    graph_id: str
    state: str                        # evicted | waiting_capacity | rehydrating
    retry_after: int


#: The request's read of a graph out of FalkorDB, set by :func:`on_read`; None when FalkorDB holds
#: it, or for a read that is not a person's.
READING: ContextVar[Optional[Reading]] = ContextVar("residency_reading", default=None)

_OUT = ("evicted", "waiting_capacity", "rehydrating")

#: Reads this process noted since it last wrote them: graph id -> the latest.
_READS: Dict[str, datetime] = {}
_FLUSH_SECS = 60
_flusher: Optional[asyncio.Task] = None


def _note_read(graph_id: str) -> None:
    _READS[graph_id] = datetime.now(timezone.utc)
    _ensure_flusher()


def _ensure_flusher() -> None:
    """Write this process's reads once a minute, from its first read on (in the running loop)."""
    global _flusher
    loop = asyncio.get_running_loop()
    if _flusher is None or _flusher.done() or _flusher.get_loop() is not loop:
        _flusher = loop.create_task(_flush_every_minute(), name="residency read flush")


async def _flush_every_minute() -> None:
    while True:
        await asyncio.sleep(_FLUSH_SECS)
        await flush_reads()


async def flush_reads() -> int:
    """Write the reads noted since the last flush to ``last_read_at``: one UPDATE, which never
    moves a graph's read back. Returns how many graphs it wrote; a flush that fails keeps the reads
    for the next."""
    if not _READS:
        return 0
    batch = dict(_READS)
    _READS.clear()
    try:
        async with db.graphver_session() as s:
            await s.execute(text(
                f'UPDATE "{config.graphver_schema()}".projection_state ps SET last_read_at = r.at '
                "FROM unnest(CAST(:ids AS text[]), CAST(:ats AS timestamptz[])) AS r(graph_id, at) "
                "WHERE ps.graph_id = r.graph_id "
                "AND (ps.last_read_at IS NULL OR ps.last_read_at < r.at)"),
                {"ids": list(batch), "ats": list(batch.values())})
    except Exception:  # noqa: BLE001 — the next flush writes them
        logger.warning("residency: reads not written; the next flush tries again", exc_info=True)
        for gid, at in batch.items():
            _READS[gid] = max(at, _READS.get(gid, at))
        return 0
    return len(batch)


async def _root(svc, graph: Mapping) -> Mapping:
    """The graph whose key serves ``graph``'s reads: itself, or a fork's root parent."""
    while graph.get("fork_parent_graph_id"):
        parent = await svc.get_graph(graph["fork_parent_graph_id"])
        if parent is None:
            break
        graph = parent
    return graph


async def on_read(svc, graph: Mapping, *, viewer, wm: Optional[Mapping] = None) -> None:
    """What a read of a versioned graph does for residency — ContextEngine's one call, made for
    every engine it builds over a versioned graph (``wm``: its watermark of a graph that is not a
    fork, which it already read). Only a person's read counts (``viewer``; a background job has
    none), with residency on, and it counts for the graph whose key serves it: a fork's root, for
    a fork. It is noted for ``last_read_at``. One FalkorDB serves takes the graph's read lease. For
    a graph whose key is not in FalkorDB: :data:`READING` says so for the rest of the request, and
    a Standard or Always graph's load is asked for, as is a Coldline graph's that is larger than the
    canvas-load threshold. Its read itself is served from Postgres."""
    if not config.RESIDENCY_ENABLED or viewer is None:
        return
    root = await _root(svc, graph)
    _note_read(root["graph_id"])
    if wm is None or root is not graph:
        wm = await svc.projection_watermark(root["graph_id"])
    if wm["status"] not in _OUT:
        READING.set(None)
        if wm["fresh"]:
            from .cache_manager import acquire_lease
            await acquire_lease(root["graph_id"], ttl=config.TRACE_LEASE_TTL_SECS)
        return
    policy = await residency_policy.resolve()
    READING.set(Reading(root["graph_id"], wm["status"], policy.capacity_interval_secs))
    if wm["status"] == "rehydrating":
        return
    if wm["residency"] == "coldline":
        entities = (await _entities([root["data_source_id"]])).get(root["data_source_id"])
        if entities is None:
            entities = (wm.get("size_bytes") or 0) // policy.bytes_per_entity
        if entities <= policy.coldline_canvas_load_above:
            return
    await request_load(root["graph_id"])


async def set_class(graph_id: str, residency: str) -> Optional[str]:
    """Set a graph's residency class; returns the class it had (None: no projection row)."""
    async with db.graphver_session() as s:
        ps = await s.get(ProjectionStateORM, graph_id)
        if ps is None:
            return None
        before, ps.residency = ps.residency, residency
        return before


async def non_resident(data_source_id: str) -> Optional[str]:
    """The graph of a data source (not a fork's) whose key is not in FalkorDB under residency,
    else None."""
    from .service import GraphVersioningService

    if not config.RESIDENCY_ENABLED:
        return None
    svc = GraphVersioningService()
    graph = await svc.get_graph_by_data_source(data_source_id)
    if graph is None:
        return None
    gid = graph["graph_id"]
    return gid if (await svc.projection_watermark(gid))["status"] in _OUT else None


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


async def admission(graph_id: str) -> Tuple[bool, Optional[str], Optional[int]]:
    """Whether a load of ``graph_id`` fits on its master now, as the planner's admission decides
    (its estimate times the headroom under the start mark, after what is held there):
    ``(fits, master, shortfall in bytes)``; a master that could not be read never fits, and its
    shortfall is None."""
    policy = await residency_policy.resolve()
    snap = await gather()
    graph = next((g for g in snap.graphs if g.graph_id == graph_id), None)
    if graph is None:
        return False, None, None
    decided = plan(policy, snap.masters, snap.graphs, datetime.now(timezone.utc))
    master = next(m for m in decided.masters if m.master.endpoint == graph.endpoint)
    fits, shortfall = admit(master.master, need(graph, policy), policy, master.reserved)
    return fits, graph.endpoint, shortfall


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
            await self._finish_loads(snap)
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

    async def _finish_loads(self, snap: Snapshot) -> None:
        """A load whose seed has published (its watermark holds the head) serves reads once its
        key has the summaries its readers need (``FalkorProjector.summaries_built``, which asks
        for the build meanwhile): then it is ``idle``, no longer evicted, and its idle time starts
        again from now. The key is measured on a later pass, as everything projected since its
        last measurement is."""
        for r in snap.rows.values():
            head = max(r["target_commit_seq"], r["main_head_commit_seq"])
            projected = r["projected_commit_seq"]
            if r["status"] != "rehydrating" or projected <= 0 or projected < head:
                continue
            try:
                ready = await self._proj.summaries_built(r["graph_id"], r["key"],
                                                         r["falkor_provider"], projected)
            except Exception:  # noqa: BLE001 — looked at again on the next pass
                logger.warning("residency: whether %s's load is ready is unknown", r["graph_id"],
                               exc_info=True)
                continue
            if not ready:
                continue
            async with db.graphver_session() as s:
                done = (await s.execute(
                    update(ProjectionStateORM)
                    .where(ProjectionStateORM.graph_id == r["graph_id"],
                           ProjectionStateORM.status == "rehydrating",
                           ProjectionStateORM.projected_commit_seq == projected)
                    .values(status="idle", evicted_reason=None, last_read_at=func.now(),
                            updated_at=_now())
                    .returning(ProjectionStateORM.graph_id)
                    .execution_options(synchronize_session=False))).first()
            if done:
                logger.info("residency: graph %s is loaded and serves reads again", r["graph_id"])

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
