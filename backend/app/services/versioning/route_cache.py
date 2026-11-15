"""The route to each versioned graph's reads, read from Postgres once per change in each process,
not once per read.

A read of a versioned graph's main is answered by the store and at the version its route says: the
graph behind the data source, its main branch, its pin and its watermark
(``ContextEngine.for_workspace``, ``versioned_sources.physical_key``). Read for every request, that
cost a web pod five checkouts of the route pool and about eight statements a read, so Postgres'
load grew with every reader: 200 readers of a graph of a million nodes ran CI's Postgres out of
connections (docs/versioning/09 §2).

A process keeps each graph's route as a :class:`RouteSnapshot`, read by one query on the route pool
(the graph, its projection state, its main branch), and trusts it while the graph's route token in
Redis (``gvroute:g:<graph id>``) is the one it read before that query. A lookup reads the token, one
round trip, and reads Postgres only when it has moved or the snapshot is
``GRAPHVER_ROUTE_CACHE_SECS`` old. A process reads one graph's route once at a time: lookups that
wait meanwhile take what it read, when it answers them.

Every committed change to what a route is made of moves its graph's token before the commit
returns. A graphver session notes each write to those columns of ``graphs`` and ``projection_state``
— through the unit of work, or as an ORM ``UPDATE``, ``INSERT`` or ``DELETE`` statement (the events
below) — and its commit announces them (:func:`announce`). So a lookup that starts after a write
has returned routes by it, in any process, as when each read routed from Postgres: "Always the
latest" stays exact. A write whose statement names no graph, in its ``WHERE`` or what it
returns, moves every graph's token (``gvroute:all``). A graph created, trashed, restored or deleted also moves ``gvroute:set``, the
token a data source with no live graph is remembered against.

What this cannot see is bounded by a snapshot's age: a write whose announcement failed (Redis out of
the writer's reach), a raw SQL statement, a change made outside the application. A lookup that
can't read Redis reads Postgres, as before, and is counted. An eviction, which drops its graph's
key, drops it only once readers have been told (``cache_manager.evict``).
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from dataclasses import dataclass, replace
from typing import Any, Dict, Iterable, Iterator, List, Optional, Set, Tuple

from sqlalchemy import event, select
from sqlalchemy import inspect as sa_inspect
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session
from sqlalchemy.sql import operators
from sqlalchemy.sql.elements import BinaryExpression, BindParameter, BooleanClauseList, Grouping

from . import config
from .models import BranchORM, GraphORM, ProjectionStateORM

logger = logging.getLogger(__name__)

#: What a route reads of a graph's row; and, of that, what says which graphs are live.
_GRAPH_ROUTE = frozenset({"data_source_id", "fork_parent_graph_id", "deleted_at",
                          "main_head_commit_seq"})
_GRAPH_SET = frozenset({"data_source_id", "deleted_at"})
#: What a route reads of a graph's projection state.
_STATE_ROUTE = frozenset({"projected_commit_seq", "served_commit_seq", "status", "read_mode",
                          "falkor_graph_name", "falkor_provider", "window_rows", "last_error",
                          "residency", "size_bytes"})

_ALL, _SET = "gvroute:all", "gvroute:set"
_TOKEN_EX = 7 * 24 * 3600      # a token not moved for a week goes; the next lookup sets another
_READ_WAIT_S = 0.5             # the longest a lookup waits on Redis before it reads Postgres
_ANNOUNCE_WAIT_S = 0.5         # the longest a commit waits on Redis to announce what it changed
_BACKOFF_S = 2.0               # after Redis failed them, lookups (announcements) skip it this long
_KEPT = 10_000                 # routes one process keeps, at most

_clock = time.monotonic


def _key(graph_id: str) -> str:
    return f"gvroute:g:{graph_id}"


@dataclass(frozen=True)
class RouteSnapshot:
    """A versioned graph's route as one query read it, and the tokens it was read against."""

    graph_id: str
    data_source_id: str
    fork_parent_graph_id: Optional[str]
    #: A fork's root parent, whose store it reads (up a fork of a fork); None for a graph not forked.
    root_id: Optional[str]
    deleted: bool
    main_branch_id: Optional[str]
    committed: int
    projected: int
    served_commit_seq: Optional[int]
    status: str
    #: The graph's own read mode; None: the platform's.
    read_mode: Optional[str]
    falkor_graph_name: Optional[str]
    falkor_provider: Optional[str]
    window_rows: Optional[int]
    last_error: Optional[str]
    residency: Optional[str]
    size_bytes: Optional[int]
    #: The graph's token and every graph's, read before its query; None: Redis couldn't say.
    tokens: Optional[Tuple[str, ...]] = None
    #: When its query started (``time.monotonic``).
    taken_at: float = 0.0

    def graph(self) -> Dict[str, Optional[str]]:
        """The graph as a read names it (what it uses of ``get_graph_by_data_source``)."""
        return {"graph_id": self.graph_id, "data_source_id": self.data_source_id,
                "fork_parent_graph_id": self.fork_parent_graph_id}

    async def state(self) -> Dict[str, Any]:
        """What ``projection_watermark`` says of a graph's route (a graph not forked): the version
        its key serves reads of main at (``served``, :func:`~.service.serving_seq`; None: Postgres
        serves them), by its read mode as it resolves now, and what residency's ``mark`` reads."""
        from . import build_policy
        from .service import serves_head, serving_seq

        mode = build_policy.read_mode_of(self.read_mode, await build_policy.resolve())
        return {
            "served": serving_seq(self.projected, self.committed, self.status,
                                  self.served_commit_seq, build_policy.max_lag_of(mode)),
            "fresh": serves_head(self.projected, self.committed, self.status),
            "committed": self.committed, "projected": self.projected, "status": self.status,
            "read_mode": mode, "falkor_graph_name": self.falkor_graph_name,
            "falkor_provider": self.falkor_provider, "window_rows": self.window_rows,
            "last_error": self.last_error, "residency": self.residency,
            "size_bytes": self.size_bytes,
        }


# ── Lookups ───────────────────────────────────────────────────────────────────────────────────────
_SNAPS: Dict[str, RouteSnapshot] = {}                    # graph id -> its route
_SOURCES: Dict[str, str] = {}                            # data source id -> its live graph's id
#: Data source id -> it has no live graph: (the tokens that was read against, when).
_NONE: Dict[str, Tuple[Optional[Tuple[str, ...]], float]] = {}
_LOCKS: Dict[str, asyncio.Lock] = {}
_DOWN_UNTIL = {"lookup": 0.0, "announce": 0.0}
_LOOP: Dict[str, Any] = {"loop": None, "redis": None}


def _here() -> None:
    """What this process keeps is its event loop's: on another (a test's next ``asyncio.run``) it
    starts again, and so does the Redis client, whose connections were the other loop's. The loop
    is held, so a new one can't be taken for it."""
    loop = asyncio.get_running_loop()
    if _LOOP["loop"] is not loop:
        _LOOP.update(loop=loop, redis=None)
        reset()


def reset() -> None:
    """Forget every route this process keeps (tests)."""
    _SNAPS.clear()
    _SOURCES.clear()
    _NONE.clear()
    _LOCKS.clear()
    _DOWN_UNTIL.update(lookup=0.0, announce=0.0)


def _redis():
    """A small client of its own: lookups queue for none of the others' connections."""
    if _LOOP["redis"] is None:
        from backend.common.adapters.redis_bus import build_bus_redis

        _LOOP["redis"] = build_bus_redis(decode_responses=True, max_connections=16,
                                         socket_connect_timeout=1, socket_timeout=1)
    return _LOOP["redis"]


#: This process's lookups by outcome, as ``graphver_route_cache_total`` counts them.
_COUNTS: Dict[str, int] = {}


def _count(outcome: str) -> None:
    from backend.app.jobs.metrics import increment

    _COUNTS[outcome] = _COUNTS.get(outcome, 0) + 1
    increment("graphver_route_cache_total", outcome=outcome)


def counts() -> Dict[str, int]:
    """This process's lookups by outcome: ``hit`` (the route kept), ``shared`` (another lookup's
    read), ``read`` (read from Postgres, its token moved or first asked), ``unchecked`` (read from
    Postgres, Redis couldn't say), ``off`` (read from Postgres, the cache off)."""
    return dict(_COUNTS)


def _down(kind: str, exc: BaseException) -> None:
    if _clock() >= _DOWN_UNTIL[kind]:
        logger.warning("route cache: Redis failed a %s (%s); %s for %.0f s", kind, exc,
                       "lookups read Postgres" if kind == "lookup" else "routes elsewhere stay "
                       "as read until their tokens move or they age out", _BACKOFF_S)
    _DOWN_UNTIL[kind] = _clock() + _BACKOFF_S


async def _tokens(*keys: str) -> Optional[Tuple[str, ...]]:
    """The tokens of ``keys`` now, setting one where there is none; None when Redis can't say (it
    failed now, or within the last two seconds), or with the cache off."""
    if config.ROUTE_CACHE_SECS <= 0 or _clock() < _DOWN_UNTIL["lookup"]:
        return None
    try:
        r = _redis()
        found = await asyncio.wait_for(r.mget(keys), _READ_WAIT_S)
        missing = [k for k, v in zip(keys, found) if v is None]
        if missing:
            pipe = r.pipeline(transaction=False)
            for k in missing:
                pipe.set(k, os.urandom(8).hex(), nx=True, ex=_TOKEN_EX)
            pipe.mget(missing)
            filled = dict(zip(missing, (await asyncio.wait_for(pipe.execute(), _READ_WAIT_S))[-1]))
            found = [filled.get(k) if v is None else v for k, v in zip(keys, found)]
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 — Postgres answers instead
        _down("lookup", exc)
        return None
    return None if None in found else tuple(found)


def _good(taken_at: float, tokens: Optional[Tuple[str, ...]], now: Optional[Tuple[str, ...]],
          arrived: float) -> bool:
    """Whether what was read at ``taken_at`` against ``tokens`` answers a lookup that began at
    ``arrived`` and read ``now``: it was read since, or against the tokens there are now, and is not
    past its age."""
    return taken_at >= arrived or (now is not None and tokens == now
                                   and arrived - taken_at < config.ROUTE_CACHE_SECS)


def _lock(key: str) -> asyncio.Lock:
    lock = _LOCKS.get(key)
    if lock is None:
        if len(_LOCKS) >= _KEPT:
            _LOCKS.clear()
        lock = _LOCKS[key] = asyncio.Lock()
    return lock


def _keep(snap: RouteSnapshot) -> RouteSnapshot:
    if len(_SNAPS) >= _KEPT and snap.graph_id not in _SNAPS:
        _SNAPS.clear()
        _SOURCES.clear()
    _SNAPS[snap.graph_id] = snap
    return snap


async def route_of_graph(graph_id: str) -> Optional[RouteSnapshot]:
    """``graph_id``'s route as of now: the one kept while its token stands, else read again. None
    for a graph that isn't there."""
    _here()
    arrived = _clock()
    now = await _tokens(_key(graph_id), _ALL)
    snap = _SNAPS.get(graph_id)
    if snap is not None and _good(snap.taken_at, snap.tokens, now, arrived):
        _count("hit")
        return snap
    async with _lock(graph_id):
        snap = _SNAPS.get(graph_id)
        if snap is not None and _good(snap.taken_at, snap.tokens, now, arrived):
            _count("shared")
            return snap
        taken = _clock()
        snap = await _read(graph_id)
        _count(_outcome(now))
        if snap is None:
            _SNAPS.pop(graph_id, None)
            return None
        return _keep(replace(snap, tokens=now, taken_at=taken))


async def route_of_source(data_source_id: str) -> Optional[RouteSnapshot]:
    """The live versioned graph behind ``data_source_id``, and its route, as of now; None when it has
    none (it isn't versioned, or its graph is in the trash)."""
    _here()
    for _ in range(2):          # a graph found trashed or gone: who serves the source, read again
        graph_id = _SOURCES.get(data_source_id) or await _graph_of_source(data_source_id)
        if graph_id is None:
            return None
        snap = await route_of_graph(graph_id)
        if snap is not None and not snap.deleted and snap.data_source_id == data_source_id:
            return snap
        _SOURCES.pop(data_source_id, None)
    return None


async def _graph_of_source(data_source_id: str) -> Optional[str]:
    """The id of the live graph behind ``data_source_id``, kept until it is trashed or gone (a data
    source has one graph until it is purged: ``uq_graphs_data_source``); None, remembered against
    the set's token, for a source with none."""
    arrived = _clock()
    now = await _tokens(_SET, _ALL)
    none = _NONE.get(data_source_id)
    if none is not None and _good(none[1], none[0], now, arrived):
        _count("hit")
        return None
    async with _lock("ds:" + data_source_id):
        graph_id = _SOURCES.get(data_source_id)
        if graph_id is not None:                    # found while this lookup waited
            return graph_id
        none = _NONE.get(data_source_id)
        if none is not None and _good(none[1], none[0], now, arrived):
            _count("shared")
            return None
        taken = _clock()
        graph_id = await _read_graph_id(data_source_id)
        _count(_outcome(now))
        if graph_id is None:
            if len(_NONE) >= _KEPT:
                _NONE.clear()
            _NONE[data_source_id] = (now, taken)
            return None
        _NONE.pop(data_source_id, None)
        if len(_SOURCES) >= _KEPT:
            _SOURCES.clear()
        _SOURCES[data_source_id] = graph_id
        return graph_id


def _outcome(now: Optional[Tuple[str, ...]]) -> str:
    if now is not None:
        return "read"
    return "off" if config.ROUTE_CACHE_SECS <= 0 else "unchecked"


async def _read_graph_id(data_source_id: str) -> Optional[str]:
    """The id of the live graph behind ``data_source_id``, from Postgres, on the route pool."""
    from .db import graphver_route_session

    async with graphver_route_session() as s:
        return await s.scalar(select(GraphORM.id).where(GraphORM.data_source_id == data_source_id,
                                                        GraphORM.deleted_at.is_(None)))


async def _read(graph_id: str) -> Optional[RouteSnapshot]:
    """``graph_id``'s route, from Postgres, on the route pool: one query, and one more per graph up
    a fork's parents."""
    from .db import graphver_route_session

    main = (select(BranchORM.id)
            .where(BranchORM.graph_id == GraphORM.id, BranchORM.kind == "main")
            .correlate(GraphORM).scalar_subquery())
    ps = ProjectionStateORM
    async with graphver_route_session() as s:
        row = (await s.execute(
            select(GraphORM.id, GraphORM.data_source_id, GraphORM.fork_parent_graph_id,
                   GraphORM.deleted_at.is_not(None), GraphORM.main_head_commit_seq, main,
                   ps.graph_id.is_not(None), ps.projected_commit_seq, ps.served_commit_seq,
                   ps.status, ps.read_mode, ps.falkor_graph_name, ps.falkor_provider,
                   ps.window_rows, ps.last_error, ps.residency, ps.size_bytes)
            .outerjoin(ps, ps.graph_id == GraphORM.id)
            .where(GraphORM.id == graph_id))).first()
        if row is None:
            return None
        root, parent = None, row[2]
        while parent:                    # a fork reads its root parent's store, up a fork of a fork
            root, parent = parent, await s.scalar(
                select(GraphORM.fork_parent_graph_id).where(GraphORM.id == parent))
    (gid, ds, fork_parent, deleted, committed, main_id, has_state, projected, served, status,
     mode, name, provider, window_rows, last_error, residency, size) = row
    if not has_state:                    # as projection_watermark reads a graph with no state row
        projected, served, status, residency = 0, None, "idle", "standard"
    return RouteSnapshot(
        graph_id=gid, data_source_id=ds, fork_parent_graph_id=fork_parent, root_id=root,
        deleted=bool(deleted), main_branch_id=main_id, committed=committed or 0,
        projected=projected or 0, served_commit_seq=served, status=status, read_mode=mode,
        falkor_graph_name=name, falkor_provider=provider, window_rows=window_rows,
        last_error=last_error, residency=residency, size_bytes=size)


# ── Announcements ─────────────────────────────────────────────────────────────────────────────────
async def announce(graph_ids: Iterable[str] = (), *, graph_set: bool = False,
                   every: bool = False) -> bool:
    """Tell every process that the routes of ``graph_ids`` (``every``: of all graphs) changed, and
    with ``graph_set`` that which graphs are live did: their tokens move, so each lookup reads them
    again. This process forgets its own at once. True once Redis has the new tokens; False when it
    can't take them (counted and logged): a route elsewhere then stays as it was read until it ages
    out."""
    _here()
    graphs = {str(g) for g in graph_ids}
    keys = ([_key(g) for g in sorted(graphs)] + ([_SET] if graph_set else [])
            + ([_ALL] if every else []))
    if not keys:
        return True
    for g in graphs:
        _SNAPS.pop(g, None)
    if graph_set or every:
        _NONE.clear()
    if every:
        _SNAPS.clear()
    from backend.app.jobs.metrics import increment

    if every:
        increment("graphver_route_announced_all_total")
    if _clock() < _DOWN_UNTIL["announce"]:
        increment("graphver_route_announce_failed_total")
        return False
    token = os.urandom(8).hex()
    try:
        pipe = _redis().pipeline(transaction=False)
        for k in keys:
            pipe.set(k, token, ex=_TOKEN_EX)
        await asyncio.wait_for(pipe.execute(), _ANNOUNCE_WAIT_S)
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 — a commit never fails over it
        _down("announce", exc)
        increment("graphver_route_announce_failed_total")
        return False
    return True


# ── Noting route changes in a graphver session ────────────────────────────────────────────────────
_PENDING, _DONE = "graphver.route.pending", "graphver.route.done"


def _note(sync: Session, graph_ids: Optional[Iterable[Any]], *, graph_set: bool) -> None:
    """Note in ``sync``'s transaction that the routes of ``graph_ids`` (None: of graphs a statement
    doesn't name) changed, and with ``graph_set`` that which graphs are live did."""
    seen = sync.info.setdefault(_PENDING, {"graphs": set(), "set": False, "all": False})
    if graph_ids is None:
        seen["all"] = True
    else:
        seen["graphs"].update(str(g) for g in graph_ids if g is not None)
    seen["set"] = seen["set"] or graph_set


def _changed(obj: Any, columns: frozenset) -> Set[str]:
    attrs = sa_inspect(obj).attrs
    return {c for c in columns if attrs[c].history.has_changes()}


def _flushed(sync: Session, _context: Any) -> None:
    """The unit of work's writes, while their history is still there (``after_flush``)."""
    for obj in (*sync.new, *sync.deleted):
        if isinstance(obj, GraphORM):
            _note(sync, [obj.id], graph_set=True)
        elif isinstance(obj, ProjectionStateORM):
            _note(sync, [obj.graph_id], graph_set=False)
    for obj in sync.dirty:
        if isinstance(obj, GraphORM):
            changed = _changed(obj, _GRAPH_ROUTE)
            if changed:
                _note(sync, [obj.id], graph_set=bool(changed & _GRAPH_SET))
        elif isinstance(obj, ProjectionStateORM) and _changed(obj, _STATE_ROUTE):
            _note(sync, [obj.graph_id], graph_set=False)


def _rows(params: Any) -> List[Dict[str, Any]]:
    if isinstance(params, dict):
        return [params] if params else []
    if isinstance(params, (list, tuple)):
        return [p for p in params if isinstance(p, dict)]
    return []


def _is(expr: Any, col: Any) -> bool:
    return getattr(expr, "table", None) is col.table and getattr(expr, "key", None) == col.key


def _terms(clause: Any) -> Iterator[Any]:
    """The terms ANDed into a WHERE clause."""
    if isinstance(clause, Grouping):
        yield from _terms(clause.element)
    elif isinstance(clause, BooleanClauseList) and clause.operator is operators.and_:
        for c in clause.clauses:
            yield from _terms(c)
    else:
        yield clause


def _bound(expr: Any, rows: List[Dict[str, Any]]) -> Optional[Set[str]]:
    """The values a bound parameter stands for — its own, or each row's, by its key; None for
    anything else."""
    if isinstance(expr, Grouping):
        expr = expr.element
    if not isinstance(expr, BindParameter):
        return None
    if expr.callable is not None:
        values: List[Any] = [expr.effective_value]
    elif expr.value is None and rows and all(expr.key in r for r in rows):
        values = [r[expr.key] for r in rows]
    else:
        values = [expr.value]
    out: Set[str] = set()
    for v in values:
        if v is None:
            return None
        if isinstance(v, (list, tuple, set, frozenset)):
            out.update(str(x) for x in v)
        else:
            out.add(str(v))
    return out


def _named(stmt: Any, id_col: Any, rows: List[Dict[str, Any]]) -> Optional[Set[str]]:
    """The graphs a statement writes: named by its id column, ANDed into its WHERE as ``= :id`` or
    ``IN (:ids)``, set by an ``INSERT``, or in each row of a bulk statement; None when it names
    none."""
    where = getattr(stmt, "whereclause", None)
    if where is not None:
        for term in _terms(where):
            if (isinstance(term, BinaryExpression) and _is(term.left, id_col)
                    and term.operator in (operators.eq, operators.in_op)):
                found = _bound(term.right, rows)
                if found is not None:
                    return found
        return None
    if getattr(stmt, "_multi_values", None):
        return None
    for k, v in (getattr(stmt, "_values", None) or {}).items():
        if _is(k, id_col) or k == id_col.key:
            return _bound(v, rows)
    if rows and all(id_col.key in r for r in rows):
        return {str(r[id_col.key]) for r in rows}
    return None


def _set_columns(stmt: Any, rows: List[Dict[str, Any]], id_col: Any) -> Optional[Set[str]]:
    """The columns an ``UPDATE`` sets, by name; None when it doesn't say."""
    pairs = [*(getattr(stmt, "_values", None) or {}).items(),
             *(getattr(stmt, "_ordered_values", None) or ())]
    if pairs:
        return {getattr(k, "key", None) or str(k) for k, _v in pairs}
    if rows:                     # a bulk UPDATE by primary key: its rows name what they set
        return {k for r in rows for k in r} - {id_col.key}
    return None


def _executed(state: Any) -> Any:
    """An ORM ``UPDATE``, ``INSERT`` or ``DELETE`` statement of a graph's row or projection state
    (``do_orm_execute``): a route change unless it sets none of a route's columns."""
    if not (state.is_update or state.is_delete or state.is_insert):
        return None
    stmt = state.statement
    table = getattr(getattr(stmt, "table", None), "name", None)
    if table == "graphs":
        id_col, route = GraphORM.__table__.c.id, _GRAPH_ROUTE
    elif table == "projection_state":
        id_col, route = ProjectionStateORM.__table__.c.graph_id, _STATE_ROUTE
    else:
        return None
    rows = _rows(state.parameters)
    graph_set = table == "graphs"
    if state.is_update:
        columns = _set_columns(stmt, rows, id_col)
        if columns is not None and not columns & route:
            return None
        graph_set = graph_set and (columns is None or bool(columns & _GRAPH_SET))
    graphs = _named(stmt, id_col, rows)
    if graphs is None and any(_is(c, id_col) for c in getattr(stmt, "_returning", ())):
        # It returns the graphs it wrote: those, as it runs it.
        result = state.invoke_statement()
        at = list(result.keys()).index(id_col.key)
        frozen = result.freeze()
        _note(state.session, {row[at] for row in frozen.data}, graph_set=graph_set)
        return frozen()
    if graphs is None:
        logger.info("route cache: a write to %s that names no graph moves every graph's route: %s",
                    table, " ".join(str(stmt).split())[:300])
    _note(state.session, graphs, graph_set=graph_set)
    return None


def _committed(sync: Session) -> None:
    seen = sync.info.pop(_PENDING, None)
    if seen:
        done = sync.info.setdefault(_DONE, {"graphs": set(), "set": False, "all": False})
        done["graphs"] |= seen["graphs"]
        done["set"] = done["set"] or seen["set"]
        done["all"] = done["all"] or seen["all"]


def _rolled_back(sync: Session) -> None:
    sync.info.pop(_PENDING, None)


async def _announce_done(sync: Session) -> None:
    done = sync.info.pop(_DONE, None)
    if done:
        await announce(done["graphs"], graph_set=done["set"], every=done["all"])


class _NotingSession(Session):
    """The session behind each graphver session: notes the route changes its transactions make."""


class GraphverSession(AsyncSession):
    """A graphver session that announces the route changes it committed as each commit returns,
    and, as it closes, any it committed another way (a ``begin()`` block)."""

    sync_session_class = _NotingSession

    async def commit(self) -> None:
        await super().commit()
        await _announce_done(self.sync_session)

    async def close(self) -> None:
        try:
            await _announce_done(self.sync_session)
        finally:
            await super().close()


event.listen(_NotingSession, "after_flush", _flushed)
event.listen(_NotingSession, "do_orm_execute", _executed)
event.listen(_NotingSession, "after_commit", _committed)
event.listen(_NotingSession, "after_rollback", _rolled_back)
