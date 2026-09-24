"""Runs one request's share of a search session and answers with its page.

``execute_session_search`` replaces the capped candidate scan for every
search that returns hits:

1. compile the predicate and the order (``keys``, ``relevance``);
2. find the session this exact search already has, or plan a new one
   (``plan``) — a later page is its own session, of the rows after the
   page before;
3. run the units still pending, two at a time, each under its own fleet
   slot, until this request's wait is spent (``waitMs`` for a progressive
   client, ``softDeadlineMs`` otherwise, cut to fit the request timeout); a
   unit started runs to its end or to the end of its budget, and one that
   runs out of time is split in half and retried;
4. answer with the first rows found so far — already in their final order,
   because every unit returns its best rows and the merge keeps the best of
   all — hydrated into hits exactly as the capped engine hydrated its page.

The counts are exact: the units partition the scope and each counts its
own matches. Nothing is capped. The facets a query asks for still pivot on
the capped engine's statements (``_run_aggregation``); they are computed
once per session, in the background of the request that started it.
"""
from __future__ import annotations

import asyncio
import contextlib
import dataclasses
import hashlib
import json
import logging
import math
import time
from typing import Any, Dict, List, Optional, Tuple

from backend.app.providers.falkordb_deep_search import (
    _RESERVED_NODE_KEYS,
    _build_compiler_for_provider,
    _candidate_prefixes,
    _hydrate_ancestors,
    _hydrate_hits,
    _resolve_candidate_cap,
    _run_aggregation,
    decode_cursor,
    encode_cursor,
)
from backend.app.providers.falkordb_search.keys import build_sort_spec
from backend.app.providers.falkordb_search.keys import SortKey, SortSpec
from backend.app.providers.falkordb_search.plan import (
    Context,
    Unit,
    after_statement,
    count_statement,
    make_plan,
    page_statements,
    raw_probe_statement,
    tally_statement,
    within_hops,
)
from backend.app.providers.falkordb_search.raw_properties import (
    answered,
    empty_params,
    evaluate_rows,
    graph_raw_labels,
)
from backend.app.providers.falkordb_search.relevance import score_expr
from backend.app.providers.falkordb_search.session import (
    COMPLETE,
    FAILED,
    RUNNING,
    Session,
    SessionStore,
    Tally,
    add_tally,
    store_for,
    wait_for_commit,
)
from backend.app.services.deep_search import (
    CompileError,
    SearchFailed,
    SearchRunContext,
    get_deep_search_settings,
)
from backend.common.adapters.circuit import ProviderBusy
from backend.common.models.search import (
    ScopeDiagnostics,
    SearchAggregateBucket,
    SearchProgress,
    SearchQuery,
    SearchResultPage,
)

logger = logging.getLogger(__name__)

#: Bumped when a session's meaning changes, so no session from an older
#: build answers a newer one's request. (3: a search asking for the
#: ``ancestor`` facet tallies it during the scan.)
ENGINE_VERSION = "3"

#: Slack past the last unit's budget before a request stops waiting for it
#: (the budget ends a unit first), and in the request's lease.
_GRACE_S = 3.0

#: The longest a request runs: inside the browser's 45 s and the 60 s timeout
#: of ``/graph/`` routes. A unit a request starts is never given up for the
#: request's sake — only by its own budget (``unit_budget``) — so the wait a
#: request may spend starting units is cut to leave room for the last one's.
_REQUEST_S = 40.0

#: The least time a page's hits get to learn where they sit (their ancestor
#: paths) — a progressive wait may have been spent on the scan by then.
_PATHS_FLOOR_S = 1.5

#: Facets computed in this process, by session, while they run.
_FACET_TASKS: Dict[str, "asyncio.Task[None]"] = {}


async def execute_session_search(
    provider, query: SearchQuery, *, context: SearchRunContext,
) -> SearchResultPage:
    settings = get_deep_search_settings()
    started = time.monotonic()
    options = query.options
    progressive = options.wait_ms is not None
    wait_s = (options.wait_ms if progressive else options.soft_deadline_ms) / 1000.0
    deadline = request_deadline(started, wait_s, unit_budget(settings))
    admit = context.admit

    async def run(cypher: str, params: Dict[str, Any], timeout_s: float):
        async with (admit() if admit else contextlib.nullcontext()):
            return await provider._ro_query(cypher, params=params, timeout=timeout_s)

    compiler, raw_labels = await _compiler_for(provider, run, context, settings)
    where = compiler.compile(query.predicate)
    if compiler.hoisted_path is not None:
        raise CompileError("path search is not run by the uncapped engine")
    hops, hop_params = within_hops(compiler)
    name_key = getattr(provider, "_name_property", None)
    relevance = None
    if options.sort == "relevance" and not options.sort_property:
        relevance = score_expr(query, name_key=name_key,
                               reserved_keys=frozenset(_RESERVED_NODE_KEYS))
    sort = build_sort_spec(query, name_key=name_key, relevance=relevance)
    containment = _containment(provider)
    ctx = Context(
        where=where, params={**compiler.params, **hop_params}, sort=sort,
        containment=containment, max_depth=int(query.scope.max_depth or 12),
        visible=(list(query.scope.visible_urns or [])
                 if query.scope.scope_mode == "visible" else None),
        within_hops=hops,
        tally=(options.results == "both" and bool(containment)
               and any(a.by == "ancestor" for a in options.aggregations or [])),
        raw_leaves=tuple(compiler.raw_leaves or ()), raw_labels=raw_labels,
    )
    page_size = options.page_size
    # The rows a session keeps: whole pages, at least ``session_rows``.
    k = page_size * max(1, math.ceil(settings.session_rows / page_size))
    query_id = query_identity(query, context.scope_hash, k)
    cursor = _read_cursor(options.cursor, query_id)
    store = store_for(provider)

    # A later page the session behind the previous one already holds.
    if cursor is not None and cursor.get("sid"):
        held = await store.load(cursor["sid"])
        if (held is not None and held.status == COMPLETE and held.query_id == query_id
                and int(cursor.get("pos", 0)) < len(held.rows)):
            return await _answer(provider, query, held, int(cursor["pos"]), context,
                                 started, deadline, total=cursor.get("t"), cache_hit=True,
                                 progressive=progressive, facets=None, wants_facets=False)

    after = cursor.get("after") if cursor is not None else None
    session, created = await _session_for(provider, query, compiler, store, run, query_id,
                                          k, after, context, deadline, settings)

    facets = None
    wants_facets = (after is None and options.results == "both"
                    and bool(options.aggregations))
    # The ``ancestor`` facet is tallied by the scan itself; the others come
    # from the capped engine's statements, computed beside it.
    capped_specs = [a for a in options.aggregations or [] if a.by != "ancestor"]
    if wants_facets and capped_specs:
        facets = await _facets(provider, query, capped_specs, session.sid, store, run,
                               settings)

    session = await _advance(session, created, store, _SearchWork(session, ctx, run),
                             deadline, settings)
    if session.status == FAILED:
        raise SearchFailed(f"search failed: {session.error}")
    if wants_facets and capped_specs and facets is None:
        facets = await _await_facets(store, session.sid, deadline)
    return await _answer(provider, query, session, 0, context, started, deadline,
                         total=cursor.get("t") if cursor else None, cache_hit=False,
                         progressive=progressive, facets=facets, wants_facets=wants_facets)


async def execute_count_session(
    provider, query: SearchQuery, *, context: SearchRunContext, advance: bool = True,
) -> Dict[str, Any]:
    """How many entities in scope match ``query.predicate`` — exactly, in
    as many requests as the scan takes. The count's own session: the same
    units a search reads, each only counted (no ordering, no rows), so a
    rule's total costs a fraction of a search. ``options.waitMs`` bounds
    this request; ``options.sessionId`` continues a count.

    ``advance=False`` only reads where the count has got to — no planning,
    no scanning — so a caller with many counts can decide which to move on."""
    if not advance:
        query_id = query_identity(query, context.scope_hash, 0)
        store = store_for(provider)
        session = (await _find(store, query.options.session_id, query_id, None)
                   or await store.load(session_id(query_id, context.data_version, None)))
        if session is None or session.status == FAILED:
            return {"count": 0, "status": "running", "sessionId": None, "progress": None,
                    "dataVersion": context.data_version, "notes": []}
        return _count_answer(session)
    settings = get_deep_search_settings()
    started = time.monotonic()
    options = query.options
    deadline = request_deadline(started, (options.wait_ms if options.wait_ms is not None
                                          else options.soft_deadline_ms) / 1000.0,
                                unit_budget(settings))
    admit = context.admit

    async def run(cypher: str, params: Dict[str, Any], timeout_s: float):
        async with (admit() if admit else contextlib.nullcontext()):
            return await provider._ro_query(cypher, params=params, timeout=timeout_s)

    compiler, raw_labels = await _compiler_for(provider, run, context, settings)
    where = compiler.compile(query.predicate)
    if compiler.hoisted_path is not None:
        raise CompileError("a path search has no count")
    hops, hop_params = within_hops(compiler)
    ctx = Context(
        where=where, params={**compiler.params, **hop_params},
        sort=SortSpec((SortKey("n.urn"),)), containment=_containment(provider),
        max_depth=int(query.scope.max_depth or 12),
        visible=(list(query.scope.visible_urns or [])
                 if query.scope.scope_mode == "visible" else None),
        within_hops=hops,
        raw_leaves=tuple(compiler.raw_leaves or ()), raw_labels=raw_labels,
    )
    query_id = query_identity(query, context.scope_hash, 0)
    store = store_for(provider)

    session, created = await _session_for(provider, query, compiler, store, run, query_id,
                                          0, None, context, deadline, settings)
    session = await _advance(session, created, store, _SearchWork(session, ctx, run),
                             deadline, settings)
    if session.status == FAILED:
        raise SearchFailed(f"count failed: {session.error}")
    return _count_answer(session)


async def _compiler_for(provider, run, context: SearchRunContext, settings):
    """The provider's compiler — answering property conditions for values
    kept in ``propertiesRaw`` too, when the graph keeps any — and the labels
    whose nodes do."""
    compiler = _build_compiler_for_provider(provider)
    timeout_s = max(1.0, settings.chunk_timeout_ms / 1000.0)
    raw_labels = await graph_raw_labels(provider, lambda c, p: run(c, p, timeout_s),
                                        context.data_version)
    if raw_labels:
        compiler.raw_leaves = []
    return compiler, raw_labels


def _count_answer(session: Session) -> Dict[str, Any]:
    return {
        "count": session.count,
        "status": "complete" if session.status == COMPLETE else "running",
        "sessionId": session.sid,
        "progress": {"scanned": session.scanned,
                     "total": max(session.total, session.scanned),
                     "matched": session.count},
        "dataVersion": session.data_version,
        "notes": list(session.notes),
    }


async def _session_for(provider, query, compiler, store, run, query_id: str, k: int,
                       after, context: SearchRunContext, deadline: float, settings
                       ) -> Tuple[Session, bool]:
    """The session this request continues — the one the client named, if it
    answers this query, else this data version's — or a newly planned one.
    Also whether it was just created."""
    session = await _find(store, query.options.session_id, query_id, after)
    if session is not None:
        return session, False
    sid = session_id(query_id, context.data_version, after)
    session = await store.load(sid)
    if session is not None and session.status != FAILED:
        return session, False
    plan = await make_plan(
        provider, query, compiler,
        run=lambda c, p: run(c, p, max(1.0, settings.chunk_timeout_ms / 1000.0)),
        width=settings.chunk_width, walk_max=settings.walk_max,
        timeout_s=max(0.5, deadline - time.monotonic()),
    )
    return Session.start(sid, query_id, context.data_version, after, k, plan,
                         scope_hash=context.scope_hash), True


class _SearchWork:
    """What a search (or a count) takes from each unit: its exact count, its
    first rows and — when the search tallies ancestors — their counts, which
    the session commits beside it (so a unit is tallied exactly when it is
    counted)."""

    def __init__(self, session: Session, ctx: Context, run) -> None:
        self.session, self.ctx, self.run = session, ctx, run
        self.tally: Dict[str, Tally] = {}

    async def begin(self, store: SessionStore) -> None:
        """Called once the lease is held; a search keeps nothing to load."""

    async def unit(self, unit: Unit, timeout_s: float):
        return await _run_unit(unit, self.session, self.ctx, self.run, timeout_s)

    def fold(self, unit: Unit, result) -> None:
        count, rows, tallied = result
        self.session.count += count
        if rows:
            self.session.rows = self.ctx.sort.merge(self.session.rows, rows,
                                                    limit=self.session.k)
        for urn, name, label, et, k in tallied:
            if urn:
                add_tally(self.tally, urn, [k, name or "", label or "", {et or "": k}])

    def commit(self) -> Dict[str, Any]:
        """What the store saves with the session, in the same transaction."""
        return {"tallies": self.tally or None}


def unit_budget(settings, passes: int = 1) -> float:
    """How long one unit may run: ``passes`` statements' timeout (a unit that
    reads in several passes gets more), within what a request can hold."""
    return min(passes * settings.chunk_timeout_ms / 1000.0, _REQUEST_S - 2 * _GRACE_S)


def request_deadline(started: float, wait_s: float, unit_s: float) -> float:
    """When a request stops starting units: after the wait it asked for, cut
    so that the last unit it starts still ends inside ``_REQUEST_S``."""
    return started + max(0.0, min(wait_s, _REQUEST_S - unit_s - 2 * _GRACE_S))


async def _advance(session: Session, created: bool, store: SessionStore, work,
                   deadline: float, settings, ttl_s: Optional[int] = None,
                   unit_s: Optional[float] = None) -> Session:
    """This request's share of the scan: under the session's lease, run
    what is pending until ``deadline`` — each unit by ``work``, within
    ``unit_s`` (``unit_budget``) — and commit it; or, when another request
    holds the lease, answer with its next commit."""
    ttl_s = ttl_s or settings.session_ttl_seconds
    unit_s = unit_s or unit_budget(settings)
    if session.status != RUNNING:
        if created:
            # Nothing to run (an empty scope): keep the answer all the same.
            await store.save(session, None, ttl_s)
        return session
    budget_s = max(0.0, deadline - time.monotonic())
    # Held until the last unit this request starts has spent its budget, and
    # the commit after it.
    lease_ms = int((budget_s + unit_s + 2 * _GRACE_S) * 1000)
    token = await store.lease(session.sid, lease_ms)
    if token is None:
        return await wait_for_commit(store, session.sid, session, deadline) or session
    # The lease is ours: carry on from the latest commit, not from what was
    # read before taking it — another request may have committed and let go
    # in between, and running its units again would count them twice.
    latest = await store.load(session.sid)
    if latest is not None:
        session.adopt(latest)
    await work.begin(store)
    try:
        await _hop(session, work, deadline, settings, unit_s)
    finally:
        if session.status == FAILED:
            await store.delete(session.sid)
        else:
            await store.save(session, token, ttl_s, **work.commit())
        await store.release(session.sid, token)
    return session


# ---------------------------------------------------------------------------
# Identity
# ---------------------------------------------------------------------------

def query_identity(query: SearchQuery, scope_hash: str, k: int) -> str:
    """What a session answers: the predicate, the resolved scope, the order,
    the facets and the rows it keeps — never the wait or the cursor. The
    rows kept are whole pages of at least ``session_rows``, so most page
    sizes share one session."""
    scope = query.scope
    payload = {
        "engine": ENGINE_VERSION,
        "predicate": query.predicate.model_dump(mode="json", by_alias=True),
        "scope": {
            "hash": scope_hash, "mode": scope.scope_mode,
            "roots": sorted(scope.root_urns or []),
            "visible": sorted(scope.visible_urns or []),
            "types": sorted(scope.entity_types or []),
            "depth": scope.max_depth,
        },
        "sort": [query.options.sort, query.options.sort_property, query.options.sort_dir],
        "facets": [a.model_dump(mode="json", by_alias=True)
                   for a in (query.options.aggregations or [])],
        "cap": query.options.candidate_cap,
        "k": k,
    }
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha1(canonical.encode("utf-8")).hexdigest()


def session_id(query_id: str, data_version: str, after: Optional[List[Any]]) -> str:
    raw = json.dumps([query_id, data_version, after], separators=(",", ":"), default=str)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:32]


def _read_cursor(raw: Optional[str], query_id: str) -> Optional[Dict[str, Any]]:
    if not raw:
        return None
    state = decode_cursor(raw)
    if state.get("v") != 2 or state.get("q") != query_id:
        raise CompileError("cursor was issued for a different query — restart "
                           "from the first page")
    if not isinstance(state.get("after"), list):
        raise CompileError("cursor is malformed")
    return state


async def _find(store: SessionStore, sid: Optional[str], query_id: str,
                after: Optional[List[Any]]) -> Optional[Session]:
    """The session a client asked to continue — only if it answers this
    very query (a sessionId is a hint, never an authority)."""
    if not sid:
        return None
    session = await store.load(sid)
    if session is None or session.query_id != query_id or session.after != after:
        return None
    return None if session.status == FAILED else session


def _containment(provider) -> Tuple[str, ...]:
    try:
        return tuple(sorted(provider._get_containment_edge_types()))
    except Exception:
        return ()


# ---------------------------------------------------------------------------
# The scan
# ---------------------------------------------------------------------------

async def _hop(session: Session, work, deadline: float, settings, unit_s: float) -> None:
    """Run pending units until ``deadline``, ``chunk_concurrency`` at a time,
    each by ``work``, folding each into the session as it lands.

    A unit started runs until it is done or has spent its budget
    (``unit_s``) — never given up because the request's wait is over: put
    back whole, it would be started again by the next request, and the next,
    and a unit slower than a client's wait would never finish. Over budget it
    is split, as a unit the graph timed out is."""
    timeout_s = settings.chunk_timeout_ms / 1000.0
    in_flight: Dict["asyncio.Task[Any]", Unit] = {}
    busy = False
    first_wave = True
    last_start = 0.0
    try:
        while session.status == RUNNING:
            # Past the deadline nothing new starts — except the request's
            # first wave, so a client polling with no wait still moves the
            # scan on. Only that first wave: a unit started later would run
            # past the lease, which covers one unit's budget past the deadline.
            while (session.pending and not busy
                   and len(in_flight) < settings.chunk_concurrency
                   and (first_wave or time.monotonic() < deadline)):
                unit = session.pending.pop(0)
                task = asyncio.ensure_future(
                    asyncio.wait_for(work.unit(unit, timeout_s), unit_s))
                in_flight[task] = unit
                last_start = time.monotonic()
            first_wave = False
            if not in_flight:
                break
            wait = max(0.0, max(deadline, last_start + unit_s) + _GRACE_S - time.monotonic())
            done, _ = await asyncio.wait(in_flight, timeout=wait,
                                         return_when=asyncio.FIRST_COMPLETED)
            if not done:
                break
            for task in done:
                unit = in_flight.pop(task)
                try:
                    result = task.result()
                except ProviderBusy:
                    # The fleet is full: give the unit back and stop starting
                    # new ones. The next request carries on.
                    session.pending.insert(0, unit)
                    busy = True
                    continue
                except Exception as exc:        # noqa: BLE001 — classified below
                    if _is_pressure(exc):
                        halves = unit.split()
                        if halves:
                            session.pending[0:0] = halves
                            continue
                    logger.warning("search session %s: unit failed: %r", session.sid, exc)
                    session.status = FAILED
                    session.error = _describe(exc)
                    break
                session.scanned += unit.size
                work.fold(unit, result)
        if session.status == RUNNING and not session.pending and not in_flight:
            session.status = COMPLETE
        if busy and session.scanned == 0 and session.status == RUNNING:
            raise ProviderBusy(provider_name="search", reason="graph reads are saturated",
                               retry_after_seconds=1)
    finally:
        for task, unit in in_flight.items():
            task.cancel()
            session.pending.insert(0, unit)


async def unit_context(unit: Unit, ctx: Context, run, timeout_s: float) -> Context:
    """``ctx`` for one unit: the values its nodes keep raw answered first
    (``raw_properties``) — none to read in a label whose nodes keep nothing
    raw."""
    if not ctx.raw_leaves:
        return ctx
    lists = empty_params(ctx.raw_leaves)
    if unit.label is None or unit.label in ctx.raw_labels:
        cypher, params = raw_probe_statement(unit, ctx)
        res = await run(cypher, params, timeout_s)
        lists = evaluate_rows(res.result_set or [], ctx.raw_leaves)
    return dataclasses.replace(ctx, where=answered(ctx.where, ctx.raw_leaves, lists),
                               params={**ctx.params, **lists})


async def _run_unit(unit: Unit, session: Session, ctx: Context, run, timeout_s: float
                    ) -> Tuple[int, List[List[Any]], List[List[Any]]]:
    """One unit's exact count, ordered first rows and — when the search
    tallies ancestors — its ``[urn, name, label, entity type, matches]``
    rows (a later page's session counts nothing — the total is page 1's;
    a count session keeps no rows)."""
    ctx = await unit_context(unit, ctx, run, timeout_s)
    if session.k == 0:
        cypher, params = count_statement(unit, ctx, session.clamps)
        res = await run(cypher, params, timeout_s)
        rs = res.result_set or []
        return (int(rs[0][0]) if rs else 0), [], []
    if session.after is not None:
        cypher, params = after_statement(unit, ctx, session.clamps, session.k, session.after)
        res = await run(cypher, params, timeout_s)
        return 0, [list(r) for r in (res.result_set or [])], []
    count, rows, tallied = 0, [], []
    statements = page_statements(unit, ctx, session.clamps, session.k)
    if ctx.tally:
        statements.append((*tally_statement(unit, ctx, session.clamps), "tally"))
    results = await asyncio.gather(*(run(c, p, timeout_s) for c, p, _ in statements))
    for (_, _, yields), res in zip(statements, results):
        rs = res.result_set or []
        if yields == "both":
            if rs:
                count, rows = int(rs[0][0]), [list(r) for r in (rs[0][1] or [])]
        elif yields == "count":
            count = int(rs[0][0]) if rs else 0
        elif yields == "tally":
            tallied = [list(r) for r in rs]
        else:
            rows = [list(r) for r in rs]
    return count, rows, tallied


def _is_pressure(exc: BaseException) -> bool:
    """A unit that ran out of time or memory: worth retrying smaller."""
    from backend.app.providers.falkordb_provider import (
        _is_query_memory_error,
        _is_query_timeout_error,
    )
    return (isinstance(exc, (asyncio.TimeoutError, TimeoutError))
            or _is_query_timeout_error(exc) or _is_query_memory_error(exc))


def _describe(exc: BaseException) -> str:
    text = str(exc) or type(exc).__name__
    return text[:300]


# ---------------------------------------------------------------------------
# Facets
# ---------------------------------------------------------------------------

async def _facets(provider, query: SearchQuery, specs, sid: str, store: SessionStore, run,
                  settings) -> Optional[List[List[Dict[str, Any]]]]:
    """The session's ``specs`` facets when computed; otherwise start
    computing them (once per session, in this process) and answer None
    meanwhile."""
    held = await store.load_facets(sid)
    if held is not None:
        return held
    budget_s = query.options.soft_deadline_ms / 1000.0
    if sid not in _FACET_TASKS and await store.claim_facets(sid, int(budget_s) + 30):
        task = asyncio.ensure_future(
            _compute_facets(provider, query, specs, sid, store, run, budget_s, settings))
        _FACET_TASKS[sid] = task
        task.add_done_callback(lambda _t: _FACET_TASKS.pop(sid, None))
    return None


async def _compute_facets(provider, query: SearchQuery, specs, sid: str, store: SessionStore,
                          run, budget_s: float, settings) -> None:
    """Each of ``specs``, by the capped engine's statement for it."""
    started = time.monotonic()
    compiler = _build_compiler_for_provider(provider)
    where = compiler.compile(query.predicate)
    params: Dict[str, Any] = dict(compiler.params)
    capped, uncapped = _candidate_prefixes(
        provider, query, compiler, where, params,
        _resolve_candidate_cap(query, settings),
    )

    class _Admitted:
        """The provider, with each facet statement admitted like a unit."""
        def __getattr__(self, name):
            return getattr(provider, name)

        async def _ro_query(self, cypher, params=None, *, timeout=None, op=None):
            return await run(cypher, params or {}, timeout or budget_s)

    facets: Any
    try:
        facets = []
        for spec in specs:
            remaining = max(0.5, budget_s - (time.monotonic() - started))
            buckets = await _run_aggregation(
                _Admitted(), capped, params, spec, query=query, timeout_s=remaining,
                uncapped_cypher=uncapped,
            )
            facets.append([b.model_dump(mode="json", by_alias=True) for b in buckets])
    except asyncio.CancelledError:
        raise
    except Exception as exc:                      # noqa: BLE001 — facets never cost the hits
        logger.warning("search session %s: facets failed: %r", sid, exc)
        facets = {"error": _describe(exc)}
    try:
        await store.save_facets(sid, facets, settings.session_ttl_seconds)
    except Exception as exc:                      # noqa: BLE001
        logger.warning("search session %s: facets not stored: %r", sid, exc)


async def _await_facets(store: SessionStore, sid: str, deadline: float):
    """This process's facet task, for as long as the request may wait; or
    the store, in case another process computed them."""
    task = _FACET_TASKS.get(sid)
    if task is not None:
        with contextlib.suppress(asyncio.TimeoutError, asyncio.CancelledError):
            await asyncio.wait_for(asyncio.shield(task),
                                   timeout=max(0.0, deadline - time.monotonic()))
    return await store.load_facets(sid)


async def _facet_models(query: SearchQuery, session: Session, store: SessionStore, facets
                        ) -> Tuple[Optional[List[List[SearchAggregateBucket]]], List[str]]:
    """Every requested facet, in request order — or None until they are all
    ready: the ``ancestor`` facet once the scan has tallied every unit, the
    others once the capped statements have answered. A capped facet that
    failed is empty, and a note says why."""
    specs = list(query.options.aggregations or [])
    capped = [a for a in specs if a.by != "ancestor"]
    notes: List[str] = []
    if capped and facets is None:
        return None, notes
    if isinstance(facets, dict):
        # Why is in the server's log (``_compute_facets``), not on the page.
        notes.append("facets could not be computed")
        facets = [[] for _ in capped]
    if len(capped) < len(specs) and session.status != COMPLETE:
        return None, notes
    computed = iter(facets or [])
    models: List[List[SearchAggregateBucket]] = []
    for spec in specs:
        if spec.by == "ancestor":
            models.append([_ancestor_bucket(urn, entry)
                           for urn, entry in await store.top_tallies(session.sid,
                                                                     spec.max_buckets)])
        else:
            models.append([SearchAggregateBucket.model_validate(b) for b in next(computed)])
    return models, notes


def _ancestor_bucket(urn: str, entry: Tally) -> SearchAggregateBucket:
    total, name, label, types = entry
    return SearchAggregateBucket(
        ancestor_urn=urn, ancestor_display_name=name or "", ancestor_entity_type=label or "",
        ancestor_depth_from_scope_root=0, match_count=int(total),
        type_counts={str(et): int(k) for et, k in types.items()},
    )


async def read_ancestor_counts(provider, session_id: str, urns: List[str], *,
                               scope_hash: str) -> Dict[str, Any]:
    """How many matches each of ``urns`` holds, from a search session's
    tally — any container's exact count, however many there are, not only
    the fullest ones the facet lists. ``expired`` when the session is gone
    or was planned for another scope; ``running`` counts are so far."""
    store = store_for(provider)
    session = await store.load(session_id)
    if session is None or session.scope_hash != scope_hash:
        return {"status": "expired", "counts": {}}
    held = await store.read_tallies(session_id, urns)
    none: Tally = [0, "", "", {}]
    return {
        "status": "complete" if session.status == COMPLETE else "running",
        "counts": {urn: {"count": int(total), "typeCounts": dict(types),
                         "displayName": name or "", "entityType": label or ""}
                   for urn in urns
                   for total, name, label, types in [held.get(urn, none)]},
    }


# ---------------------------------------------------------------------------
# The answer
# ---------------------------------------------------------------------------

async def _answer(provider, query: SearchQuery, session: Session, pos: int,
                  context: SearchRunContext, started: float, deadline: float, *,
                  total: Optional[int], cache_hit: bool, progressive: bool,
                  facets, wants_facets: bool) -> SearchResultPage:
    options = query.options
    rows = session.rows[pos:pos + options.page_size]
    remaining = max(0.5, deadline - time.monotonic())
    hits = await _hydrate_hits(provider, query, [r[-1] for r in rows], timeout_s=remaining)
    path_notes: List[str] = []
    if hits and options.include_ancestor_path:
        # Where each hit sits finishes the page, whatever the wait spent on
        # the scan. Running late leaves the paths out — the hits and the
        # count are no less complete for it.
        try:
            await asyncio.wait_for(
                _hydrate_ancestors(provider, hits),
                timeout=max(_PATHS_FLOOR_S, deadline - time.monotonic()))
        except asyncio.TimeoutError:
            for hit in hits:
                hit.ancestor_path = []
            path_notes.append("Where each match sits could not be read in time; "
                              "run the search again to see them grouped.")

    complete = session.status == COMPLETE
    first_page = session.after is None
    if first_page and complete:
        total = session.count
    facet_models, facet_notes = (await _facet_models(query, session, store_for(provider), facets)
                                 if wants_facets else (None, []))
    if wants_facets and facet_models is None:
        complete = False       # the page is not done until its facets are

    cursor = None
    end = pos + len(rows)
    if complete and rows:
        more = end < len(session.rows) or len(session.rows) >= session.k
        if first_page and total is not None:
            more = more and end < total
        if more:
            cursor = encode_cursor({
                "v": 2, "q": session.query_id,
                "sid": session.sid if end < len(session.rows) else None,
                "pos": end, "after": rows[-1], "t": total,
            })

    running = not complete
    notes = list(session.notes) + facet_notes + path_notes
    page = SearchResultPage(
        hits=hits,
        aggregates=facet_models if wants_facets else None,
        cursor=cursor,
        truncated=running and not progressive,
        candidate_count=session.count if first_page else (total or len(session.rows)),
        total_count=total if not running else None,
        deadline_exceeded=running and not progressive,
        elapsed_ms=int((time.monotonic() - started) * 1000),
        cache_hit=cache_hit,
        session_id=session.sid,
        status="running" if running else "complete",
        count_status=("exact" if total is not None and not running else "lowerBound"),
        progress=SearchProgress(scanned=session.scanned, total=max(session.total, session.scanned),
                                matched=session.count),
        data_version=session.data_version,
        stale=bool(context.data_version) and session.data_version != context.data_version,
    )
    if notes:
        # Carried to the service, which builds the response's diagnostics
        # and folds these in (``AdvancedSearchService.search``).
        page.scope_diagnostics = ScopeDiagnostics(effective_max_depth=0, notes=notes)
    return page
