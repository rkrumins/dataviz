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

Metrics (``jobs.metrics``), from the projection lane: each master's used and maximum memory
(``versioning_residency_master_used_bytes`` / ``_max_bytes``), the graphs per class and state
(``versioning_residency_graphs``), evictions by reason (``versioning_residency_evictions_total``),
loads started and completed (``versioning_residency_loads_total``), loads that began to wait, by
why (``versioning_residency_load_waits_total``), and how long the oldest load in flight has been
under way (``versioning_residency_oldest_rehydrating_seconds``: a load has no timeout).
"""
from __future__ import annotations

import asyncio
import logging
import time
from contextvars import ContextVar
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from typing import Any, Collection, Dict, List, Mapping, Optional, Tuple

from sqlalchemy import func, literal, select, text, update

from . import config, db, keymigrate, residency_policy
from .messaging import get_broker_redis, nudge_projection
from .models import GraphORM, ProjectionStateORM, _now
from backend.app.jobs import metrics

from .residency_plan import Graph, Master, MasterPlan, Plan, admit, need, plan, roomiest
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
#: Graphs whose idle clock a pass starts, at most (:func:`_start_idle_clocks`).
_CLOCKS_PER_PASS = 1000


def _clock() -> datetime:
    """The time a pass, the preview and admission plan at (patched in tests)."""
    return datetime.now(timezone.utc)


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
_STATES = ("resident", *_OUT)

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
    if graph is None or graph.get("fork_parent_graph_id"):
        return None
    gid = graph["graph_id"]
    return gid if (await svc.projection_watermark(gid))["status"] in _OUT else None


@dataclass
class Snapshot:
    """What a pass read: the masters, the graphs as the planner sees them, each graph's row
    (``key``, ``provider``, ``data_source_id``, ...), each provider's FalkorDB client, the graphs
    the load queue held, and the cluster slots each master owns (None: every slot)."""
    masters: List[Master] = field(default_factory=list)
    graphs: List[Graph] = field(default_factory=list)
    rows: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    clients: Dict[str, Tuple[Any, Optional[str]]] = field(default_factory=dict)
    queued: List[str] = field(default_factory=list)
    slots: Dict[str, Optional[List[Tuple[int, int]]]] = field(default_factory=dict)
    #: Graphs the pass puts in the queue itself (an Always graph out of FalkorDB, a waiting graph
    #: whose request the broker lost), with the score they get once, and keep.
    requeue: Dict[str, float] = field(default_factory=dict)


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


async def _dedicated(data_source_ids: Collection[str]) -> Optional[set]:
    """The data sources whose rollups live in a dedicated graph, which is named from the graph's
    key (``<key>_proj``): their keys never change. None when that cannot be read."""
    if not data_source_ids:
        return set()
    from backend.app.db.engine import get_readonly_session
    from backend.app.db.models import WorkspaceDataSourceORM as DS

    try:
        async with get_readonly_session() as s:
            return set((await s.execute(
                select(DS.id).where(DS.id.in_(list(data_source_ids)),
                                    DS.projection_mode == "dedicated"))).scalars().all())
    except Exception:  # noqa: BLE001 — every key then stays where it is
        logger.warning("residency: data sources' projection modes unreadable", exc_info=True)
        return None


def _probe_key(slots: Optional[List[Tuple[int, int]]]) -> str:
    """A key that hashes to one of ``slots`` — what a master's memory is read through, as the
    reading finds its node by a key's slot."""
    from backend.app.services.graph_store.topology import key_slot

    for i in range(1 << 16):
        key = f"gvresidency{{{i}}}"
        if slots is None or any(lo <= key_slot(key) <= hi for lo, hi in slots):
            return key
    return "gvresidency"


def _master_of(slots: Dict[str, Optional[List[Tuple[int, int]]]], key: str) -> str:
    """The master that owns ``key``'s slot; "unknown" when the map has none."""
    from backend.app.services.graph_store.topology import key_slot

    slot = None
    for endpoint, ranges in slots.items():
        if ranges is None:
            return endpoint
        slot = key_slot(key) if slot is None else slot
        if any(lo <= slot <= hi for lo, hi in ranges):
            return endpoint
    return "unknown"


async def _read_masters(provider: str, client, mode) -> Tuple[List[Master], Dict[str, Any]]:
    """Every master of ``provider``'s topology — not only those holding a versioned graph's key:
    the one with the most room often holds none — with its memory, its hold and what the
    aggregation write governor holds on it, and the slots each owns."""
    from backend.app.providers.shard_capacity import hold_reason, master_slots, read_shard_memory
    from backend.app.services.aggregation.capacity import reserved_on

    slots = await master_slots(client, mode=mode, timeout=_READ_TIMEOUT_S) or {}
    masters = []
    for endpoint, ranges in slots.items():
        reading = await read_shard_memory(client, mode=mode, graph_key=_probe_key(ranges),
                                          timeout=_READ_TIMEOUT_S, include_config=False,
                                          refresh=False)
        hold = hold_reason(reading, expected_replicas=None, watch_replicas=False)
        try:
            reserved = (await reserved_on(reading.endpoint))[0]
        except Exception:  # noqa: BLE001 — loads wait until it can be read again
            logger.warning("residency: reservations on %s unreadable", endpoint, exc_info=True)
            reserved, hold = 0, ("unmeasured", "")
        masters.append(Master(
            endpoint=endpoint, used=reading.used if reading.source == "measured" else None,
            maxmemory=int(reading.maxmemory or 0), hold=hold[0] if hold else None,
            reserved=reserved, providers=(provider,)))
    return masters, slots


async def gather(*, graph_ids: Optional[Collection[str]] = None,
                 providers: Optional[Collection[str]] = None) -> Snapshot:
    """Read what a pass decides from: every live graph that is not a fork and has a key of its
    own (only ``graph_ids``, when given; only those on ``providers``, when given), when each load
    was asked for, which graphs a read lease holds, whether each graph's key may change, and every
    master of each of their providers (and of ``providers``): its memory, its hold, what the
    aggregation write governor holds on it and its slots. Waiting graphs whose request the broker
    lost go to the end of the queue, and so does an Always graph that is not resident."""
    from .cache_manager import is_pinned

    ps, head = ProjectionStateORM, GraphORM.main_head_commit_seq
    provider_of = func.coalesce(func.nullif(ps.falkor_provider, ""), config.DEFAULT_FALKOR_PROVIDER)
    query = (
        select(ps.graph_id, ps.falkor_graph_name, ps.falkor_provider, ps.owns_falkor_graph,
               ps.status, ps.residency, ps.last_read_at, ps.last_projected_at, ps.size_bytes,
               ps.size_measured_at, ps.rehydrating_since, ps.retired_keys,
               ps.projected_commit_seq, ps.target_commit_seq, head,
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
    if providers is not None:
        query = query.where(provider_of.in_(list(providers)))
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
            asked[r.graph_id] = snap.requeue[r.graph_id] = now
    estimate = await _entities({r.data_source_id for r in found if r.size_bytes is None})
    dedicated = await _dedicated({r.data_source_id for r in found})
    by_provider: Dict[str, List[Any]] = {p: [] for p in providers or ()}
    for r in found:
        by_provider.setdefault(r.falkor_provider or config.DEFAULT_FALKOR_PROVIDER, []).append(r)
    endpoint_of: Dict[str, str] = {}
    seen: Dict[str, int] = {}                 # a master two providers reach is read once
    for provider, rows in by_provider.items():
        try:
            client, mode = await _provider_client(
                provider, rows[0].falkor_graph_name if rows else "gvresidency")
        except Exception:  # noqa: BLE001 — its graphs count as on a master that cannot be read
            logger.warning("residency: FalkorDB provider %s unreachable", provider, exc_info=True)
            for r in rows:
                endpoint_of[r.graph_id] = f"{provider}:unreachable"
            continue
        snap.clients[provider] = (client, mode)
        masters, slots = await _read_masters(provider, client, mode)
        for m in masters:
            if m.endpoint in seen:
                i = seen[m.endpoint]
                snap.masters[i] = replace(snap.masters[i],
                                          providers=(*snap.masters[i].providers, provider))
            else:
                seen[m.endpoint] = len(snap.masters)
                snap.masters.append(m)
        snap.slots.update(slots)
        for r in rows:
            endpoint_of[r.graph_id] = (_master_of(slots, r.falkor_graph_name) if slots
                                       else f"{provider}:unreachable")

    for r in found:
        candidate = r.owns_falkor_graph and r.status == "idle" and r.residency != "always"
        target = max(r.target_commit_seq, r.main_head_commit_seq)
        placed = dedicated is not None and r.data_source_id not in dedicated
        snap.rows[r.graph_id] = dict(r._mapping, key=r.falkor_graph_name,
                                     provider=r.falkor_provider or config.DEFAULT_FALKOR_PROVIDER,
                                     endpoint=endpoint_of[r.graph_id], placed=placed)
        snap.graphs.append(Graph(
            graph_id=r.graph_id, endpoint=endpoint_of[r.graph_id], residency=r.residency,
            status=r.status, owned=bool(r.owns_falkor_graph),
            evictable=bool(r.past_genesis and r.enable_finished),
            leased=candidate and await is_pinned(r.graph_id),
            last_read=_ts(r.last_read_at),       # none on record: its clock starts this pass
            size_bytes=r.size_bytes, entities=estimate.get(r.data_source_id),
            seeding=(r.status == "rehydrating" and r.projected_commit_seq < target)
            or (r.status in ("rebuilding", "reseeding") and r.projected_commit_seq == 0),
            requested_at=asked.get(r.graph_id),
            provider=r.falkor_provider or config.DEFAULT_FALKOR_PROVIDER, placed=placed))
    return snap


def _pool(decided: Plan, graph: Graph) -> List[MasterPlan]:
    """The masters a load of ``graph`` may go to: its provider's, or its own when its key stays."""
    return [p for p in decided.masters
            if (graph.provider in p.master.providers if graph.placed
                else p.master.endpoint == graph.endpoint)]


async def admission(graph_id: str) -> Tuple[bool, Optional[str], Optional[int]]:
    """Whether a load of ``graph_id`` fits now on the master it would go to (the roomiest of its
    provider's, or its own when its key stays), as the planner's admission decides (its estimate
    times the headroom under the start mark, after what is held there): ``(fits, master,
    shortfall in bytes)``; a master that could not be read never fits, and its shortfall is
    None."""
    policy = await residency_policy.resolve()
    snap = await gather()
    graph = next((g for g in snap.graphs if g.graph_id == graph_id), None)
    if graph is None:
        return False, None, None
    decided = plan(policy, snap.masters, snap.graphs, _clock())
    target = roomiest(_pool(decided, graph), policy)
    if target is None:
        return False, graph.endpoint, None
    fits, shortfall = admit(target.master, need(graph, policy), policy, target.reserved)
    return fits, target.master.endpoint, shortfall


async def place_key(graph_id: str, provider: str,
                    taken: Collection[str]) -> Optional[Tuple[str, str]]:
    """A new platform key for ``graph_id`` on ``provider``, placed (doc 17): on the master with
    the most room after what is held there, the first of the graph's keys not ``taken`` that hashes
    to it. ``(key, master)``; None when no master of the provider could be read, or no key lands
    there within the search's bound."""
    policy = await residency_policy.resolve()
    snap = await gather(providers=[provider])
    decided = plan(policy, snap.masters, snap.graphs, _clock())
    target = roomiest([p for p in decided.masters if provider in p.master.providers], policy)
    if target is None:
        return None
    key = keymigrate.placed_key(graph_id, snap.slots.get(target.master.endpoint), taken)
    return (key, target.master.endpoint) if key else None


async def preview(policy, *, graph_ids: Optional[Collection[str]] = None,
                  now: Optional[datetime] = None) -> Tuple[Plan, Snapshot]:
    """What the next pass would do under ``policy`` at ``now`` (default: the clock), acting on
    nothing."""
    snap = await gather(graph_ids=graph_ids)
    return plan(policy, snap.masters, snap.graphs, now or _clock()), snap


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
            await _start_idle_clocks(graph_ids)
            snap = await gather(graph_ids=graph_ids)
            await _requeue(snap)
            decided = plan(policy, snap.masters, snap.graphs, _clock())
            await self._measure(snap, first={e.graph_id for e in decided.evictions})
            await self._act(decided, snap)
            await self._finish_loads(snap)
            await _clear_spent(snap, full=graph_ids is None)
            _report(snap)
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
                metrics.increment("versioning_residency_evictions_total", reason=e.reason)
                logger.info("residency: evicted graph %s from %s (%s, %d bytes)",
                            e.graph_id, e.endpoint, e.reason, e.bytes)
        used = {m.endpoint: m.used for m in snap.masters}
        for load in decided.loads:
            chosen = await _load_key(load, snap)
            if chosen is None:
                continue
            if await _start_load(load.graph_id, key=chosen[0], shard_map=chosen[1]):
                self._started[load.graph_id] = (load.endpoint, used.get(load.endpoint))
                metrics.increment("versioning_residency_loads_total", outcome="started")
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
            if entered:
                metrics.increment("versioning_residency_load_waits_total", reason=wait.reason)
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
                            rehydrating_since=None, updated_at=_now())
                    .returning(ProjectionStateORM.graph_id)
                    .execution_options(synchronize_session=False))).first()
            if done:
                metrics.increment("versioning_residency_loads_total", outcome="completed")
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


def _report(snap: Snapshot) -> None:
    """What a pass read, as gauges: each master's memory, the graphs per class and state, and the
    age of the oldest load in flight (0 when there is none)."""
    for m in snap.masters:
        if m.used is not None:
            metrics.gauge_set("versioning_residency_master_used_bytes", m.used, master=m.endpoint)
        metrics.gauge_set("versioning_residency_master_max_bytes", m.maxmemory, master=m.endpoint)
    counts: Dict[Tuple[str, str], int] = {}
    for g in snap.graphs:
        state = g.status if g.status in _OUT else "resident"
        counts[(g.residency, state)] = counts.get((g.residency, state), 0) + 1
    for cls in residency_policy.CLASSES:
        for state in _STATES:
            metrics.gauge_set("versioning_residency_graphs", counts.get((cls, state), 0),
                              residency=cls, state=state)
    now = datetime.now(timezone.utc)
    since = [r["rehydrating_since"] for r in snap.rows.values()
             if r["status"] == "rehydrating" and r.get("rehydrating_since") is not None]
    metrics.gauge_set("versioning_residency_oldest_rehydrating_seconds",
                      max(((now - s).total_seconds() for s in since), default=0))


async def _start_idle_clocks(graph_ids: Optional[Collection[str]] = None) -> None:
    """A graph with no read on record — every graph, the day residency is turned on, and each new
    graph — starts its idle clock now: until then it is never idle. Bounded per pass."""
    ps = ProjectionStateORM
    todo = select(ps.graph_id).where(ps.last_read_at.is_(None)).limit(_CLOCKS_PER_PASS)
    if graph_ids is not None:
        todo = todo.where(ps.graph_id.in_(list(graph_ids)))
    try:
        async with db.graphver_session() as s:
            await s.execute(update(ps).where(ps.graph_id.in_(todo.scalar_subquery()))
                            .values(last_read_at=func.now())
                            .execution_options(synchronize_session=False))
    except Exception:  # noqa: BLE001 — still never idle; the next pass tries again
        logger.warning("residency: idle clocks not started", exc_info=True)


async def _requeue(snap: Snapshot) -> None:
    """Put the graphs the pass queued itself into the queue once (``ZADD NX``), so they keep the
    place they got rather than going behind every request again each pass."""
    if not snap.requeue:
        return
    try:
        await get_broker_redis().zadd(LOAD_REQUESTS, snap.requeue, nx=True)
    except Exception:  # noqa: BLE001 — queued again on the next pass
        logger.warning("residency: graphs not queued for their load", exc_info=True)


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


async def _load_key(load, snap: Snapshot) -> Optional[Tuple[str, Optional[dict]]]:
    """The key an admitted load seeds, with its ``shard_map``: a fresh platform key placed on the
    master the plan chose (``keymigrate.placed_key``: the first of the graph's keys that exists
    nowhere on the provider, is none of its retired keys, and hashes there); or the graph's own,
    when its key must stay (a dedicated rollup graph is named from it). None when no key can be
    chosen now — the provider's keys cannot be listed, or none lands there — and the load waits
    for the next pass."""
    from backend.app.providers import falkor_graph_registry
    from backend.app.services.graph_store.topology import key_slot

    row = snap.rows[load.graph_id]
    if not row["placed"]:
        return row["key"], None
    provider = row["provider"]
    try:
        keys = await falkor_graph_registry.list_graph_keys(provider)
    except Exception:  # noqa: BLE001 — cannot verify a key is free: never assume it
        keys = None
    if keys is None:
        logger.warning("residency: the keys on provider %s cannot be listed; graph %s's load "
                       "waits for the next pass", provider, load.graph_id)
        return None
    retired = {e["name"] for e in row.get("retired_keys") or []
               if (e.get("provider") or config.DEFAULT_FALKOR_PROVIDER) == provider}
    key = keymigrate.placed_key(load.graph_id, snap.slots.get(load.endpoint), keys | retired)
    if key is None:
        logger.warning("residency: no key of graph %s hashes to %s; its load waits", load.graph_id,
                       load.endpoint)
        return None
    return key, {"tag": key[key.index("{") + 1:-1], "slot": key_slot(key), "master": load.endpoint,
                 "chosenAt": datetime.now(timezone.utc).isoformat(), "chosenBy": "residency"}


async def _start_load(graph_id: str, *, key: Optional[str] = None,
                      shard_map: Optional[dict] = None) -> bool:
    """Start an admitted load: the graph becomes ``rehydrating`` at watermark 0 (a status CAS
    under the row's lock, so one load per graph; the projection lock then makes its pass
    single-flight), pinned to ``key`` (None: its own), leaves the queue, and the projection lane
    is nudged to seed its key. A key it leaves goes to ``retired_keys``, for the retire pass to
    drop should its eviction not have."""
    from sqlalchemy.exc import IntegrityError

    try:
        async with db.graphver_session() as s:
            ps = (await s.execute(
                select(ProjectionStateORM).where(ProjectionStateORM.graph_id == graph_id)
                .with_for_update().execution_options(populate_existing=True)
            )).scalar_one_or_none()
            if ps is None or ps.status not in ("evicted", "waiting_capacity"):
                return False
            if key is not None and key != ps.falkor_graph_name:
                head = await s.scalar(select(GraphORM.main_head_commit_seq)
                                      .where(GraphORM.id == graph_id))
                ps.retired_keys = [*(ps.retired_keys or []), {
                    "name": ps.falkor_graph_name, "provider": ps.falkor_provider,
                    "retireAfter": datetime.now(timezone.utc).isoformat(), "afterSeq": head,
                    "movedBy": "residency"}]
                ps.falkor_graph_name, ps.shard_map = key, shard_map
            ps.status, ps.projected_commit_seq, ps.last_error = "rehydrating", 0, None
            ps.failed_attempts, ps.next_retry_at, ps.updated_at = 0, None, _now()
            ps.rehydrating_since = func.now()
            ps.epoch = ProjectionStateORM.epoch + 1
    except IntegrityError:          # uq_ps_key: another graph claimed the key meanwhile
        logger.warning("residency: key %s of graph %s was claimed meanwhile; its load waits",
                       key, graph_id)
        return False
    try:
        await get_broker_redis().zrem(LOAD_REQUESTS, graph_id)
    except Exception:  # noqa: BLE001 — a spent request leaves on a later pass
        logger.debug("residency: load request for %s not removed", graph_id, exc_info=True)
    await nudge_projection(graph_id)
    return True
