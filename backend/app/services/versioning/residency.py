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
from collections import OrderedDict
from contextlib import asynccontextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Collection, Dict, List, Mapping, NamedTuple, Optional, Tuple

from sqlalchemy import func, literal, select, text, update

from . import config, db, keymigrate, residency_policy
from .messaging import get_broker_redis, nudge_projection
from .models import GraphORM, ProjectionStateORM, _now
from backend.app.jobs import metrics

from .residency_plan import (Graph, Load, Master, MasterPlan, Plan, admit, need, plan, rank,
                             roomiest)
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
#: Passes a load waits for its summaries before it asks for their build again.
_REASK_PASSES = 10


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
    moves a graph's read back, and passes over a row another process's flush holds (its read is as
    recent: nothing that matters is lost, and two flushes never wait on each other, nor deadlock).
    Returns how many graphs it took; a flush that fails keeps the reads for the next."""
    if not _READS:
        return 0
    batch = dict(_READS)
    _READS.clear()
    try:
        async with db.graphver_session() as s:
            table = f'"{config.graphver_schema()}".projection_state'
            await s.execute(text(
                f"UPDATE {table} ps SET last_read_at = r.at "
                "FROM unnest(CAST(:ids AS text[]), CAST(:ats AS timestamptz[])) AS r(graph_id, at) "
                "WHERE ps.graph_id = r.graph_id "
                f"AND ps.graph_id IN (SELECT graph_id FROM {table} "
                "WHERE graph_id = ANY(CAST(:ids AS text[])) "
                "ORDER BY graph_id FOR UPDATE SKIP LOCKED) "
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


#: Graphs whose read lease this process refreshed: graph id -> when (``time.monotonic``).
_HELD: Dict[str, float] = {}
#: How often a graph's lease is refreshed at most, per process: well inside its 120 seconds.
_HOLD_EVERY_S = 30.0
#: The longest a read waits on the broker.
_BROKER_WAIT_S = 0.1


async def _hold(graph_id: str) -> None:
    """Hold ``graph_id``'s read lease for ``GRAPHVER_TRACE_LEASE_TTL_SECS`` — refreshed at most
    every 30 seconds per process, in one round trip, never waiting on the broker more than about
    100 ms (a lease not taken is tried again on the next read)."""
    from . import cache_manager

    now = time.monotonic()
    if now - _HELD.get(graph_id, float("-inf")) < _HOLD_EVERY_S:
        return
    try:
        held = await asyncio.wait_for(
            cache_manager.acquire_lease(graph_id, ttl=config.TRACE_LEASE_TTL_SECS),
            _BROKER_WAIT_S)
    except (asyncio.TimeoutError, Exception):  # noqa: BLE001 — a read never fails over it
        return
    if held:
        if len(_HELD) > 10_000:
            _HELD.clear()
        _HELD[graph_id] = now


async def hold(svc, graph: Mapping) -> Optional[Mapping]:
    """A person's read of a versioned graph that FalkorDB may serve, before it reads the graph's
    watermark: it holds the read lease of the graph whose key serves it (a fork's root), so an
    eviction that has not committed yet backs off, and one that has is seen by the read; and it is
    noted for ``last_read_at``. Returns that graph; None with residency off."""
    if not config.RESIDENCY_ENABLED:
        return None
    root = await _root(svc, graph)
    await _hold(root["graph_id"])
    _note_read(root["graph_id"])
    return root


async def on_read(svc, graph: Mapping, *, viewer) -> Optional[Mapping]:
    """What a read of a versioned graph does for residency — ContextEngine's one call, made for
    every engine it builds over a versioned graph before it reads the graph's store: for a fork,
    with its root, once its read plan says it reads through the root's store. Only a person's read
    counts (``viewer``; a background job has none), with residency on, and it counts for the graph
    whose key serves it. It holds that graph first (:func:`hold`). For a graph whose key is not in
    FalkorDB: :data:`READING` says so for the rest of the request, and a Standard or Always graph's
    load is asked for, as is a Coldline graph's that is larger than the canvas-load threshold. Its
    read itself is served from Postgres. Returns the graph's state as it read it after the hold
    (``residency_state``), None when it read none."""
    if not config.RESIDENCY_ENABLED or viewer is None:
        return None
    root = await hold(svc, graph)
    wm = await svc.residency_state(root["graph_id"])
    if wm is None or wm["status"] not in _OUT:
        READING.set(None)
        return wm
    policy = await residency_policy.resolve()
    READING.set(Reading(root["graph_id"], wm["status"], policy.capacity_interval_secs))
    if wm["status"] == "rehydrating":
        return wm
    if wm["residency"] == "coldline":
        entities = _COUNTS.get((root["graph_id"], wm["committed"]))
        if entities is None and wm.get("size_bytes"):
            entities = wm["size_bytes"] // policy.bytes_per_entity
        if entities is None:
            try:
                entities = await _entity_count(root["graph_id"], root["data_source_id"],
                                               wm["committed"])
            except _Unread:
                entities = None
        if entities is None or entities <= policy.coldline_canvas_load_above:
            return wm
    try:
        await asyncio.wait_for(request_load(root["graph_id"]), _BROKER_WAIT_S)
    except asyncio.TimeoutError:      # the next read asks again
        pass
    return wm


async def set_class(graph_id: str, residency: str) -> Optional[str]:
    """Set a graph's residency class; returns the class it had (None: no projection row)."""
    async with db.graphver_session() as s:
        ps = await s.get(ProjectionStateORM, graph_id)
        if ps is None:
            return None
        before, ps.residency = ps.residency, residency
        return before


async def non_resident(data_source_id: str) -> Optional[str]:
    """The graph whose key serves a data source's reads — its graph's, or a fork's root's, unless
    the fork reads past the ceiling — when that key is not in FalkorDB under residency, else
    None."""
    from .service import GraphVersioningService

    if not config.RESIDENCY_ENABLED:
        return None
    svc = GraphVersioningService()
    graph = await svc.get_graph_by_data_source(data_source_id)
    if graph is None:
        return None
    if graph.get("fork_parent_graph_id") and await svc.fork_reads_from(graph["graph_id"]) == \
            "postgres":
        return None           # past the ceiling, its own rows: nothing of its root's is read
    root = await _root(svc, graph)
    state = await svc.residency_state(root["graph_id"])
    return root["graph_id"] if state is not None and state["status"] in _OUT else None


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
    #: False when graphs' sizes could not be read: the pass then plans no pressure eviction.
    sized: bool = True


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
    them: the estimate's fallback when graphver's own counts are missing. Raises when they
    cannot be read."""
    if not data_source_ids:
        return {}
    from backend.app.db.engine import get_readonly_session
    from backend.app.db.models import DataSourceStatsORM as Stats

    async with get_readonly_session() as s:
        rows = (await s.execute(
            select(Stats.data_source_id, Stats.node_count + Stats.edge_count)
            .where(Stats.data_source_id.in_(list(data_source_ids))))).all()
    return {ds: int(n or 0) for ds, n in rows}


#: Each graph's entities at a main head, as counted: (graph id, head) -> nodes plus edges.
_COUNTS: "OrderedDict[Tuple[str, int], int]" = OrderedDict()
_COUNTS_KEPT = 4096


class _Unread(Exception):
    """A graph's entities could be read from neither graphver nor the data source's statistics."""


async def _entity_count(graph_id: str, data_source_id: str, head: int) -> Optional[int]:
    """``graph_id``'s nodes and edges at main head ``head``, as graphver counts them
    (``schema_counts``; rollups are not in history), else as its data source's statistics last
    counted them; None when neither has a count. Kept per head in this process. Raises
    :class:`_Unread` when neither could be read."""
    from .service import GraphVersioningService

    key = (graph_id, head)
    if key in _COUNTS:
        _COUNTS.move_to_end(key)
        return _COUNTS[key]
    count, failed = None, False
    try:
        svc = GraphVersioningService()
        counts = await svc.schema_counts(graph_id=graph_id,
                                         branch_id=await svc.main_branch_id(graph_id))
        if counts is not None:
            count = sum(counts["nodes"].values()) + sum(counts["edges"].values())
    except Exception:  # noqa: BLE001 — the statistics, then
        logger.warning("residency: graphver's counts of %s unreadable", graph_id, exc_info=True)
        failed = True
    if count is None:
        try:
            count = (await _entities([data_source_id])).get(data_source_id)
        except Exception as exc:  # noqa: BLE001
            logger.warning("residency: data source statistics unreadable", exc_info=True)
            if failed:
                raise _Unread(graph_id) from exc
    if count is not None:
        _COUNTS[key] = count
        while len(_COUNTS) > _COUNTS_KEPT:
            _COUNTS.popitem(last=False)
    return count


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


async def _held(rows) -> set:
    """Of these eviction candidates, the graphs no eviction may take now, in two reads of the
    management database for them all: a key another data source or catalog entry reads (the
    evictor would refuse it, and the plan would count it freed), and a graph whose data source a
    rollup job is pending or running for (it would write the dropped key back). All of them when
    that cannot be read."""
    if not rows:
        return set()
    from backend.app.db.engine import get_readonly_session
    from backend.app.services.aggregation.models import AggregationJobORM
    from backend.app.services.managed_sources import keys_read_elsewhere

    try:
        async with get_readonly_session() as s:
            shared = await keys_read_elsewhere(s, [(r.falkor_provider, r.falkor_graph_name,
                                                    r.data_source_id) for r in rows])
            busy = set((await s.execute(select(AggregationJobORM.data_source_id).where(
                AggregationJobORM.data_source_id.in_({r.data_source_id for r in rows}),
                AggregationJobORM.status.in_(("pending", "running"))))).scalars().all())
    except Exception:  # noqa: BLE001 — fail closed: nothing is evicted this pass
        logger.warning("residency: who else reads the keys is unknown; nothing is evicted",
                       exc_info=True)
        return {r.graph_id for r in rows}
    return {r.graph_id for r in rows
            if ((r.falkor_provider or config.DEFAULT_FALKOR_PROVIDER), r.falkor_graph_name)
            in shared or r.data_source_id in busy}


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
    ps, head = ProjectionStateORM, GraphORM.main_head_commit_seq
    provider_of = func.coalesce(func.nullif(ps.falkor_provider, ""), config.DEFAULT_FALKOR_PROVIDER)
    query = (
        select(ps.graph_id, ps.falkor_graph_name, ps.falkor_provider, ps.owns_falkor_graph,
               ps.status, ps.residency, ps.last_read_at, ps.last_projected_at, ps.size_bytes,
               ps.size_measured_at, ps.rehydrating_since, ps.retired_keys, ps.epoch,
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
    estimate: Dict[str, Optional[int]] = {}
    for r in found:              # only a load asked for, or one in flight, needs an estimate
        target = max(r.target_commit_seq, r.main_head_commit_seq)
        if r.size_bytes is None and (r.graph_id in asked or _seeding(r, target)):
            try:
                estimate[r.graph_id] = await _entity_count(r.graph_id, r.data_source_id,
                                                           r.main_head_commit_seq)
            except _Unread:
                snap.sized = False
    dedicated = await _dedicated({r.data_source_id for r in found})
    held = await _held([r for r in found
                        if r.owns_falkor_graph and r.status == "idle" and r.residency != "always"])
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
            evictable=bool(r.past_genesis and r.enable_finished) and r.graph_id not in held,
            leased=candidate and await _leased(r.graph_id),
            last_read=_ts(r.last_read_at),       # none on record: its clock starts this pass
            size_bytes=r.size_bytes, entities=estimate.get(r.graph_id),
            seeding=_seeding(r, target),
            requested_at=asked.get(r.graph_id),
            provider=r.falkor_provider or config.DEFAULT_FALKOR_PROVIDER, placed=placed))
    return snap


async def _leased(graph_id: str) -> bool:
    """Whether a read lease holds ``graph_id``: True when the broker cannot say, so an outage
    there evicts nothing and fails no pass."""
    from .cache_manager import is_pinned

    try:
        return await is_pinned(graph_id)
    except Exception:  # noqa: BLE001 — fail closed
        logger.debug("residency: the read lease of %s could not be read", graph_id, exc_info=True)
        return True


def _seeding(r, target: int) -> bool:
    """Whether a load or a full projection is writing the graph into its key."""
    return ((r.status == "rehydrating" and r.projected_commit_seq < target)
            or (r.status in ("rebuilding", "reseeding") and r.projected_commit_seq == 0))


def _pool(decided: Plan, graph: Graph) -> List[MasterPlan]:
    """The masters a load of ``graph`` may go to: its provider's, or its own when its key stays."""
    return [p for p in decided.masters
            if (graph.provider in p.master.providers if graph.placed
                else p.master.endpoint == graph.endpoint)]


class Admitted(NamedTuple):
    """Whether a full write of a graph fits now, on ``master``; when it does not, ``why``:
    ``capacity`` (``shortfall`` bytes short under the start mark), ``unsized`` (its size is
    unknown), ``unmeasured`` (the master could not be read), ``busy`` (a load or full projection
    is under way there: one at a time) or the master's hold (``fork``, ``loading``, ...)."""
    fits: bool
    master: Optional[str]
    shortfall: Optional[int] = None
    why: Optional[str] = None


def _free(p: MasterPlan) -> bool:
    """Free to take a load, as the planner's loads take one: read, holding none, taking none, and
    not kept for a waiting load whose room the pass makes there (``claimed``)."""
    return p.master.used is not None and not p.master.hold and not p.seeding and not p.claimed


def _admitted(target: Optional[MasterPlan], graph: Graph, policy, endpoint: Optional[str], *,
              room_only: bool = False) -> Admitted:
    if need(graph, policy) is None:
        return Admitted(False, endpoint, None, "unsized")
    if target is None or target.master.used is None:
        return Admitted(False, endpoint, None, "unmeasured")
    if not room_only and target.master.hold:
        return Admitted(False, endpoint, None, target.master.hold)
    if not room_only and (target.seeding or target.claimed):
        return Admitted(False, endpoint, None, "busy")
    fits, shortfall = admit(target.master, need(graph, policy), policy, target.reserved)
    return Admitted(fits, endpoint, shortfall, None if fits else "capacity")


async def _sized(graph: Graph, row: Optional[Mapping], policy) -> Graph:
    """``graph`` with its entities counted when its size is unknown, for the estimate."""
    if graph.bytes(policy) is not None or row is None:
        return graph
    try:
        return replace(graph, entities=await _entity_count(
            graph.graph_id, row["data_source_id"], row["main_head_commit_seq"]))
    except _Unread:
        return graph


async def admission(graph_id: str) -> Admitted:
    """Whether a load of ``graph_id`` would fit by room alone on the master it would go to — the
    roomiest of its provider's, or its own when its key stays — as the planner's admission counts
    room (its estimate times the headroom under the start mark, after what is held there). A
    master that holds or takes a load now does not refuse it: setting a class writes nothing, and
    the load it asks for waits its turn."""
    policy = await residency_policy.resolve()
    snap = await gather()
    graph = next((g for g in snap.graphs if g.graph_id == graph_id), None)
    if graph is None:
        return Admitted(False, None, None, "unmeasured")
    graph = await _sized(graph, snap.rows.get(graph_id), policy)
    decided = plan(policy, snap.masters, snap.graphs, _clock(), sized=snap.sized)
    target = roomiest(_pool(decided, graph), policy)
    return _admitted(target, graph, policy, target.master.endpoint if target else graph.endpoint,
                     room_only=True)


async def admission_on(graph_id: str, provider: str, key: str) -> Admitted:
    """Whether a full copy of ``graph_id`` fits now on the master ``key`` hashes to on
    ``provider`` — a move's or an Adopt's new key, seeded while the old one still stands — as
    admission decides for a load: never on a master that could not be read, holds, or takes a
    load already, nor for a graph whose size is unknown."""
    return (await _admission_on(graph_id, provider, key))[0]


async def _admission_on(graph_id: str, provider: str,
                        key: str) -> Tuple[Admitted, Optional[int]]:
    """:func:`admission_on`'s answer, and the room the copy asks for (None: unknown). No
    ``provider`` is the default one."""
    provider = provider or config.DEFAULT_FALKOR_PROVIDER
    policy = await residency_policy.resolve()
    own = await gather(graph_ids=[graph_id])
    graph = next((g for g in own.graphs if g.graph_id == graph_id), None)
    if graph is None:
        return Admitted(False, None, None, "unmeasured"), None
    graph = await _sized(graph, own.rows.get(graph_id), policy)
    snap = await gather(providers=[provider])
    endpoint = _master_of(snap.slots, key) if snap.slots else None
    decided = plan(policy, snap.masters, snap.graphs, _clock(), sized=snap.sized)
    target = next((p for p in decided.masters if p.master.endpoint == endpoint), None)
    return _admitted(target, graph, policy, endpoint), need(graph, policy)


async def admit_copy(graph_id: str, provider: str, key: str, holder: str
                     ) -> Tuple[Admitted, Optional[Any]]:
    """A full copy written outside the projector (a package seed) admitted as a load is, on the
    master ``key`` hashes to, and — when it fits — the room it asks for reserved there for
    ``holder`` in the aggregation write governor's ledger, which every pass counts: renewed while
    the holder runs, gone with a dead one, until it is released
    (``AggregationAdmission.release``). Both under the capacity lock, so nothing else is admitted
    between the check and the reservation."""
    from backend.app.services.aggregation.admission import AggregationAdmission
    from backend.app.services.aggregation.redis_client import get_redis

    async with admitting():
        admitted, needed = await _admission_on(graph_id, provider, key)
        if not admitted.fits:
            return admitted, None
        return admitted, await AggregationAdmission(get_redis()).reserve(
            admitted.master, holder, needed or 0)


@asynccontextmanager
async def admitting(wait_s: float = 15.0) -> AsyncIterator[None]:
    """A full write's admission and its commit as one step: under the capacity pass's leader lock,
    so neither a load a pass starts nor another route's write is admitted between the two (the
    commit's ``projection_state`` row then reserves its room for the next). A pass holding the
    lock longer than ``wait_s`` is ``LockBusy``."""
    from .errors import LockBusy

    lock_scope = db.graphver_lock_session()
    lock_s = await lock_scope.__aenter__()
    lock_arg = func.hashtext(_LEADER)
    acquired = False
    try:
        deadline, take = time.monotonic() + wait_s, select(func.pg_try_advisory_lock(lock_arg))
        while not (acquired := bool(await lock_s.scalar(take))):
            if time.monotonic() >= deadline:
                raise LockBusy("a capacity pass is under way; try again shortly")
            await asyncio.sleep(0.2)
        yield
    finally:
        try:
            if acquired:
                await lock_s.execute(select(func.pg_advisory_unlock(lock_arg)))
        finally:
            await lock_scope.__aexit__(None, None, None)


async def place_key(graph_id: str, provider: str,
                    taken: Collection[str]) -> Optional[Tuple[str, str]]:
    """A new platform key for ``graph_id`` on ``provider``, placed (doc 17): on the master with
    the most room after what is held there, among those free to take a load, the first of the
    graph's keys not ``taken`` that hashes to it — or, when none lands there within the search's
    bound (a master that owns few slots), on the next. ``(key, master)``; None when no master of
    the provider is free, or no key lands on any."""
    policy = await residency_policy.resolve()
    snap = await gather(providers=[provider])
    decided = plan(policy, snap.masters, snap.graphs, _clock(), sized=snap.sized)
    for target in _by_room([p for p in decided.masters
                            if provider in p.master.providers and _free(p)], policy):
        key = keymigrate.placed_key(graph_id, snap.slots.get(target.master.endpoint), taken)
        if key:
            return key, target.master.endpoint
    return None


def _by_room(plans: Collection[MasterPlan], policy) -> List[MasterPlan]:
    """``plans``, the highest ranked first (as :func:`roomiest` picks the first)."""
    return sorted(plans, key=lambda p: rank(p, policy), reverse=True)


async def preview(policy, *, graph_ids: Optional[Collection[str]] = None,
                  now: Optional[datetime] = None) -> Tuple[Plan, Snapshot]:
    """What the next pass would do under ``policy`` at ``now`` (default: the clock), acting on
    nothing."""
    snap = await gather(graph_ids=graph_ids)
    return plan(policy, snap.masters, snap.graphs, now or _clock(), sized=snap.sized), snap


class CapacityLoop:
    """The projection lane's capacity loop (doc 17): one pass is :meth:`run_once`."""

    def __init__(self, projector):
        self._proj = projector
        # Loads this process started: graph id -> (its master, the master's use then), for the
        # used-memory delta that sizes the key where GRAPH.MEMORY USAGE cannot.
        self._started: Dict[str, Tuple[str, Optional[int]]] = {}
        # Loads waiting for their summaries: graph id -> (its epoch, passes waited).
        self._waited: Dict[str, Tuple[int, int]] = {}
        # Loads whose ontology could not be read: graph id -> (its epoch, passes in a row).
        self._unread: Dict[str, Tuple[int, int]] = {}

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
            decided = plan(policy, snap.masters, snap.graphs, _clock(), sized=snap.sized)
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
        evicted_on = set()
        for m in decided.masters:
            freed, spare = 0, list(m.spare)
            for e in m.evictions:
                if await self._evict(evictor, e):
                    freed += e.bytes or 0
                    evicted_on.add(e.endpoint)
            # An eviction the evictor refused freed nothing: carry on down the master's
            # candidates until the stop mark is actually reached.
            while spare and freed < m.to_free:
                e = spare.pop(0)
                if await self._evict(evictor, e):
                    freed += e.bytes or 0
                    evicted_on.add(e.endpoint)
        used = {m.endpoint: m.used for m in snap.masters}
        loading_on = {x.endpoint for x in decided.loads}
        for load in decided.loads:
            chosen = await _load_key(load, snap)
            if chosen is None:
                load, chosen = await _elsewhere(load, decided, snap, loading_on)
            if chosen is None:
                logger.warning("residency: graph %s's load waits: no key of it can be chosen now",
                               load.graph_id)
                continue
            loading_on.add(load.endpoint)
            row = snap.rows.get(load.graph_id, {})
            if chosen[0] == row.get("key") and not await self._drop_stale(row):
                continue
            if await _start_load(load.graph_id, key=chosen[0], shard_map=chosen[1]):
                if load.endpoint not in evicted_on:     # a delta across evictions means nothing
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

    async def _drop_stale(self, row) -> bool:
        """A load back onto the key the graph had starts from nothing: whatever is there now (a
        rollup job may have written it after the eviction, summaries stamp and all) is dropped
        first. False when it could not be: the load waits for the next pass."""
        from backend.app.providers.falkordb_provider import _is_missing_graph_error

        try:
            await self._proj.drop_graph(row["key"], row["falkor_provider"])
        except Exception as exc:  # noqa: BLE001
            if not _is_missing_graph_error(exc):
                logger.warning("residency: graph %s's old key %s could not be dropped before "
                               "its load", row["graph_id"], row["key"], exc_info=True)
                return False
        return True

    async def _evict(self, evictor, e) -> bool:
        if not await evictor.evict(e.graph_id, drop_graph=self._proj.drop_graph, reason=e.reason):
            return False
        metrics.increment("versioning_residency_evictions_total", reason=e.reason)
        logger.info("residency: evicted graph %s from %s (%s, %s bytes)",
                    e.graph_id, e.endpoint, e.reason, e.bytes)
        return True

    async def _finish_loads(self, snap: Snapshot) -> None:
        """A load whose seed has published (its watermark holds the head) serves reads once its
        key has the summaries its readers need (``FalkorProjector.summaries_built``, which asks
        for the build meanwhile): then it is ``idle``, no longer evicted, and its idle time starts
        again from now. The key is measured on a later pass, as everything projected since its
        last measurement is. Each load asks for the build under its own key (its epoch), and asks
        again under a new one every ``_REASK_PASSES`` passes it goes without. One whose ontology
        cannot be read for more than ``_REASK_PASSES`` passes in a row goes back to evicted
        (:meth:`_stall`): its key is not held forever."""
        for r in snap.rows.values():
            head = max(r["target_commit_seq"], r["main_head_commit_seq"])
            projected = r["projected_commit_seq"]
            if r["status"] != "rehydrating" or projected <= 0 or projected < head:
                continue
            epoch, waited = self._waited.get(r["graph_id"], (r["epoch"], -1))
            if epoch != r["epoch"]:
                epoch, waited = r["epoch"], -1
            self._waited[r["graph_id"]] = (epoch, waited + 1)
            try:
                ready = await self._proj.summaries_built(
                    r["graph_id"], r["key"], r["falkor_provider"], projected,
                    ask=f"load{epoch}.{(waited + 1) // _REASK_PASSES}")
            except Exception:  # noqa: BLE001 — looked at again on the next pass
                logger.warning("residency: whether %s's load is ready is unknown", r["graph_id"],
                               exc_info=True)
                continue
            if ready is None:                        # its ontology could not be read
                seen, passes = self._unread.get(r["graph_id"], (epoch, 0))
                passes = passes + 1 if seen == epoch else 1
                self._unread[r["graph_id"]] = (epoch, passes)
                if passes > _REASK_PASSES:
                    await self._stall(r, passes)
                continue
            self._unread.pop(r["graph_id"], None)
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
            self._waited.pop(r["graph_id"], None)
            if done:
                metrics.increment("versioning_residency_loads_total", outcome="completed")
                logger.info("residency: graph %s is loaded and serves reads again", r["graph_id"])

    async def _stall(self, r, passes: int) -> None:
        """A load whose seed has published but whose ontology could not be read for ``passes``
        passes in a row: nothing can tell whether its key needs summaries, so it is not served,
        and it would hold its master's memory for good — it is not idle, so nothing evicts it. It
        goes back to evicted (``load_stalled``) with its key dropped (or left to the retire pass),
        and the next read asks for its load again."""
        from .cache_manager import CacheManager

        gid = r["graph_id"]
        async with db.graphver_session() as s:
            row = (await s.execute(
                update(ProjectionStateORM)
                .where(ProjectionStateORM.graph_id == gid,
                       ProjectionStateORM.status == "rehydrating",
                       ProjectionStateORM.epoch == r["epoch"])
                .values(status="evicted", evicted_reason="load_stalled", projected_commit_seq=0,
                        rehydrating_since=None, epoch=ProjectionStateORM.epoch + 1,
                        updated_at=_now())
                .returning(ProjectionStateORM.falkor_graph_name, ProjectionStateORM.falkor_provider)
                .execution_options(synchronize_session=False))).first()
        self._unread.pop(gid, None)
        self._waited.pop(gid, None)
        if row is None:
            return
        name, provider = row
        metrics.increment("versioning_residency_evictions_total", reason="load_stalled")
        logger.warning("residency: graph %s's load stalled: its ontology could not be read for %d "
                       "passes, so whether its key needs summaries is unknown; it is evicted again "
                       "(load_stalled), and its next read asks for it", gid, passes)
        if name:
            try:
                await self._proj.drop_graph(name, provider)
            except Exception:  # noqa: BLE001 — the retire pass drops it
                logger.warning("residency: graph %s's key %s could not be dropped; the retire pass "
                               "will", gid, name, exc_info=True)
                await CacheManager(self._proj)._retire_later(gid, name, provider)

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
                # 0 is under the reading's resolution (GRAPH.MEMORY USAGE answers in whole MiB):
                # no size, so the graph keeps its estimate, and is not read again until it changes.
                await s.execute(update(ProjectionStateORM)
                                .where(ProjectionStateORM.graph_id == r["graph_id"])
                                .values(size_bytes=size or None, size_measured_at=func.now())
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


async def _elsewhere(load: Load, decided: Plan, snap: Snapshot, loading_on: Collection[str]
                     ) -> Tuple[Load, Optional[Tuple[str, Optional[dict]]]]:
    """A load whose master no key of the graph hashes to (one that owns few slots, after a
    reshard onto it) goes, in the same pass, to the next master of its provider with the most
    room that is free to take it, takes no other load this pass, and has room for it: the load
    there, with its key; else the load as it was, and None."""
    row = snap.rows.get(load.graph_id) or {}
    if not row.get("placed"):
        return load, None
    policy = await residency_policy.resolve()
    needed = -(-load.bytes * policy.load_margin_pct // 100)
    for p in _by_room([p for p in decided.masters
                       if row["provider"] in p.master.providers and _free(p)
                       and p.master.endpoint not in loading_on], policy):
        if not admit(p.master, needed, policy, p.reserved)[0]:
            continue
        moved = replace(load, endpoint=p.master.endpoint)
        chosen = await _load_key(moved, snap)
        if chosen is not None:
            return moved, chosen
    return load, None


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
        logger.info("residency: no key of graph %s hashes to %s", load.graph_id, load.endpoint)
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
