"""Connections: a search whose results are edges.

A Connections search (``kind: edges``) asks for every direct edge whose
source meets one condition (From) and whose target meets another (To). It
runs on the uncapped engine's sessions, units and leases (``engine``) and
answers with a page of edges.

One end is the ANCHOR. It is read exactly as a search for that end's
entities would read it — the same plan (``make_plan``: ID bands of each
label, walks down the view's roots, the canvas's URNs, what a lineage
relationship reaches), the same head, clamps, hops and stages — and each of
its matches expands its edges::

    {the anchor end's statement, up to n} WITH n
    MATCH (n)-[e:T1|T2]->(m) WHERE m.urn IS NOT NULL AND <edge filter>
        AND <the far end's scope labels and plain conditions>
    {the view's roots above m, then the far end's stages}

The other end, the FAR end, is tested on ``m``, once per edge: its plain
conditions in that WHERE, the rest projected after it (``tail_clauses``),
and whether ``m`` is in the search's scope as the scope's own units would
read it (``plan._in_scope``). Both ends read native values only, so either
end anchors the same answer; which one does is a matter of cost
(``_anchor_side``). When the anchor is the target, the arrow points the
other way, and every row still reads source → target as stored.

``either`` reads every unit twice: the edges stored From → To, then those
stored To → From — leaving out of the second pass any edge the first counts,
one whose source meets From and target meets To — so each edge counts once.

Each unit answers in one statement: per edge type, its exact count and its
first rows in order (an ``ORDER BY`` before a grouped ``collect`` keeps its
order in every group, as before an ungrouped one, S0 §6). Rows are sort
keys — the source's name, the target's, the type, the two urns, the edge's
ID — then the two ends' node IDs, so a page is read back by ID and checked
by urn (``_hydrate``): an edge that changed since is left out, as a deleted
entity is.
"""
from __future__ import annotations

import asyncio
import contextlib
import dataclasses
import json
import math
import time
from typing import Any, Dict, List, Optional, Tuple

from backend.app.providers.falkordb_deep_search import (
    _ancestor_refs,
    _build_compiler_for_provider,
    _conjuncts,
    _edge_properties,
    _has_relation,
    _required_types,
    _sanitize_label,
    _scope_urn_sets_with_depths,
    _searchable_labels,
    encode_cursor,
    tail_clauses,
)
from backend.app.providers.falkordb_search.engine import (
    _HYDRATE_FLOOR_S,
    _PATHS_FLOOR_S,
    _advance,
    _containment,
    _count_answer,
    _find,
    _read_cursor,
    query_identity,
    request_deadline,
    session_id,
    unit_budget,
)
from backend.app.providers.falkordb_search.keys import SortKey, SortSpec, name_text
from backend.app.providers.falkordb_search.plan import (
    Context,
    Plan,
    Unit,
    _ids_of,
    _label_stats,
    _labels_in_scope,
    _rel,
    describe_unit,
    expand_unit,
    make_plan,
    match_statement,
    within_hops,
)
from backend.app.providers.falkordb_search.relevance import display_name_expr
from backend.app.providers.falkordb_search.session import (
    COMPLETE,
    FAILED,
    Session,
    SessionStore,
    store_for,
)
from backend.app.services.deep_search import (
    SearchFailed,
    SearchRunContext,
    get_deep_search_settings,
)
from backend.app.services.native_query.parse_cost import grouped
from backend.common.models.search import (
    EDGES_PAGE_MAX,
    AncestorRef,
    EdgeEnd,
    EdgeHit,
    MatchAllPredicate,
    ScopeDiagnostics,
    SearchProgress,
    SearchQuery,
    SearchResultPage,
    anchor_groups,
)

#: The edges a session keeps in order, at the least: the canvas highlights
#: up to this many, so showing more of them never scans again.
SESSION_EDGES = 2_000

#: How rows merge across units and passes: their six keys, each ascending.
_MERGE = SortSpec(tuple(SortKey(f"_k{i}") for i in range(6)))


@dataclasses.dataclass(frozen=True)
class EdgeContext:
    """What every unit's statement shares: the anchor end's context — an
    entity search's own (``plan.Context``) — and what each edge its matches
    have is tested by."""
    anchor: Context
    anchor_side: str                  # "source" | "target"
    rel: str                          # the edge types, as an alternation
    edge_where: str                   # the edge filter on ``e`` ("" none)
    far_head: str                     # the far end's plain tests on ``m``
    far_stages: Tuple[str, ...]       # the view's roots above ``m``, then its stages
    near: str = "true"                # either: the far end's condition on ``n``
    far: str = "true"                 # either: the anchor end's condition on ``m``
    name_key: Optional[str] = None
    # The anchor end's containers by URN, each with its depth: the view's
    # roots and its own "inside" — what a unit's clamps hold by ID.
    anchor_sets: Tuple[Tuple[Tuple[str, ...], int], ...] = ()
    types: Tuple[str, ...] = ()


# ---------------------------------------------------------------------------
# The requests
# ---------------------------------------------------------------------------

async def execute_edge_search(provider, query: SearchQuery, *,
                              context: SearchRunContext) -> SearchResultPage:
    """One request's share of a Connections search, answered with its page
    of edges: ``engine.execute_session_search``, for edges."""
    settings = get_deep_search_settings()
    started = time.monotonic()
    options = query.options
    progressive = options.wait_ms is not None
    wait_s = (options.wait_ms if progressive else options.soft_deadline_ms) / 1000.0
    deadline = request_deadline(started, wait_s, unit_budget(settings))
    run = _runner(provider, context)
    page_size = min(options.page_size, EDGES_PAGE_MAX)
    k = page_size * max(1, math.ceil(max(settings.session_rows, SESSION_EDGES) / page_size))
    query_id = query_identity(query, context.scope_hash, k)
    cursor = _read_cursor(options.cursor, query_id)
    store = store_for(provider)

    # A later page the session behind the previous one already holds.
    if cursor is not None and cursor.get("sid"):
        held = await store.load(cursor["sid"])
        if (held is not None and held.status == COMPLETE and held.query_id == query_id
                and int(cursor.get("pos", 0)) < len(held.rows)):
            return await _answer(provider, held, int(cursor["pos"]), page_size, context,
                                 started, deadline, total=cursor.get("t"),
                                 types=cursor.get("tc"), cache_hit=True,
                                 progressive=progressive)

    after = cursor.get("after") if cursor is not None else None
    session, created, state = await _session_for(provider, query, store, run, query_id, k,
                                                 after, context, deadline, settings)
    work = _EdgeWork(session, edge_context(provider, query, state), run, state)
    session = await _advance(session, created, store, work, deadline, settings)
    if session.status == FAILED:
        raise SearchFailed(f"search failed: {session.error}")
    # A later page counts nothing: its totals are the first page's.
    types = cursor.get("tc") if after is not None else (await _state(store, session.sid)).get("types")
    return await _answer(provider, session, 0, page_size, context, started, deadline,
                         total=cursor.get("t") if cursor else None, types=types,
                         cache_hit=False, progressive=progressive)


async def execute_edge_count(provider, query: SearchQuery, *,
                             context: SearchRunContext) -> Dict[str, Any]:
    """How many edges a Connections search matches, exactly — its own count
    session: the units a search reads, each only counted."""
    settings = get_deep_search_settings()
    options = query.options
    deadline = request_deadline(time.monotonic(), (options.wait_ms if options.wait_ms is not None
                                                   else options.soft_deadline_ms) / 1000.0,
                                unit_budget(settings))
    run = _runner(provider, context)
    store = store_for(provider)
    query_id = query_identity(query, context.scope_hash, 0)
    session, created, state = await _session_for(provider, query, store, run, query_id, 0,
                                                 None, context, deadline, settings)
    work = _EdgeWork(session, edge_context(provider, query, state), run, state)
    session = await _advance(session, created, store, work, deadline, settings)
    if session.status == FAILED:
        raise SearchFailed(f"count failed: {session.error}")
    return _count_answer(session)


def _runner(provider, context: SearchRunContext):
    """``run(cypher, params, timeout_s)``: one statement, under the
    request's admission."""
    admit = context.admit

    async def run(cypher: str, params: Dict[str, Any], timeout_s: float):
        async with (admit() if admit else contextlib.nullcontext()):
            return await provider._ro_query(cypher, params=params, timeout=timeout_s)

    return run


async def _session_for(provider, query: SearchQuery, store: SessionStore, run, query_id: str,
                       k: int, after, context: SearchRunContext, deadline: float, settings
                       ) -> Tuple[Session, bool, Dict[str, Any]]:
    """The session this request continues, or a newly planned one; whether
    it was just created; and what it keeps beside its units (``_plan``)."""
    session = await _find(store, query.options.session_id, query_id, after)
    sid = session_id(query_id, context.data_version, after)
    if session is None:
        session = await store.load(sid)
        if session is not None and session.status == FAILED:
            session = None
    if session is not None:
        return session, False, await _state(store, session.sid)
    plan, state = await _plan(provider, query, run, settings, deadline)
    return (Session.start(sid, query_id, context.data_version, after, k, plan,
                          scope_hash=context.scope_hash), True, state)


async def _state(store: SessionStore, sid: str) -> Dict[str, Any]:
    """What a session keeps beside its units: which end anchors, what the far
    end's scope check reads, the matches per edge type so far."""
    raw = await store.load_accumulator(sid)
    return json.loads(raw) if raw else {}


# ---------------------------------------------------------------------------
# The plan
# ---------------------------------------------------------------------------

def _compiler(provider):
    """The provider's compiler, for a Connections search: native values only
    — both ends alike, so either may anchor — and no relationship traced
    from its far end (an end follows a few hops itself, ``_validate_edges``)."""
    compiler = _build_compiler_for_provider(provider)
    compiler.trace_beyond = None
    return compiler


async def _plan(provider, query: SearchQuery, run, settings, deadline: float
                ) -> Tuple[Plan, Dict[str, Any]]:
    """The units a Connections search reads — its anchor end's, as a search
    of that end would read them, each over every edge ID — and what the far
    end's scope check needs, kept with the session (``_EdgeWork.commit``)."""
    edges = query.predicate
    plan_run = lambda c, p: run(c, p, max(1.0, settings.chunk_timeout_ms / 1000.0))  # noqa: E731
    labels = await _searchable_labels(provider, timeout_s=max(0.5, deadline - time.monotonic()))
    containment = _containment(provider)
    stats = await _label_stats(plan_run, labels)
    side = _anchor_side(provider, query, labels, stats)
    state: Dict[str, Any] = {"anchor": side, "types": {},
                             **await _far_scope(plan_run, provider, query, labels, containment)}
    compiler = _compiler(provider)
    types = compiler.connection_edge_types(edges)
    if not types:
        return Plan([], notes=["No edges of these types are in this data source."]), state
    near = (edges.source_where if side == "source" else edges.target_where) or MatchAllPredicate()
    compiler.compile(near, scope_depth=query.scope.max_depth)
    anchor_query = query.model_copy(update={"predicate": near})
    counts, total = await _edge_stats(plan_run)
    width = _width(settings.chunk_width, counts, types, stats, near)
    # An end naming entities is read from them (``plan.named_plan``).
    plan = await make_plan(provider, anchor_query, compiler, run=plan_run, width=width,
                           walk_max=settings.walk_max,
                           timeout_s=max(0.5, deadline - time.monotonic()))
    units = [dataclasses.replace(u, espan=max(2, total)) for u in plan.units]
    if edges.direction == "either":
        units += [dataclasses.replace(u, reverse=True) for u in units]
    return Plan(units, plan.clamps, plan.notes, plan.clamp_depths), state


def _anchor_side(provider, query: SearchQuery, labels, stats) -> str:
    """Which end is read as entities — the other is tested once per edge.
    Either way the answer is the same; what differs is the cost, so the end
    likely to keep the fewest entities, cheapest: one naming entities (read
    by ID, or down from them); else one with a plain condition beyond its
    types, which a node's own WHERE filters (a relationship beside it runs
    only on what that keeps); else one of types alone; else one testing
    relationships or layers alone — the costliest test there is, better
    asked of the edges a cheaper end reaches than of every entity. Within a
    rank, the end of fewer entities by its types; then the source. An end
    left out, or only free text, reads the whole scope: the other anchors
    when it can."""
    edges = query.predicate
    pool = (labels if query.scope.root_urns or query.scope.scope_mode == "visible"
            else _labels_in_scope(provider, labels, query.scope.entity_types))

    def rank(where) -> Tuple[int, int]:
        if where is None or _free_text(where):
            return 4, 0
        members = _conjuncts(where)
        if any(_names_entities(m) for m in members):
            return 0, 0
        plain = [m for m in members if not _has_relation(m) and m.kind != "all"]
        if any(m.kind != "entityType" for m in plain):
            kind = 1
        elif any(_has_relation(m) for m in members):
            kind = 3
        else:
            kind = 2 if plain else 4
        required = _required_types(where)
        return kind, sum(stats.get(lbl, (0, 0))[0] for lbl in pool
                         if required is None or lbl.lower() in required)

    return "target" if rank(edges.target_where) < rank(edges.source_where) else "source"


def _names_entities(m) -> bool:
    """A condition that is named entities, what is inside them, or above
    them — read from them, never by a scan (``plan.named_plan``, the clamps
    of ``make_plan``)."""
    if m.kind in ("is", "descendantOf") or anchor_groups(m) is not None:
        return True
    return (m.kind == "related" and m.axis in ("parent", "ancestor", "root")
            and m.quantifier == "any" and m.count is None
            and m.where is not None and m.where.kind == "is")


def _free_text(where) -> bool:
    if where.kind == "group":
        return bool(where.children) and all(_free_text(c) for c in where.children)
    return where.kind == "text"


async def _far_scope(run, provider, query: SearchQuery, labels, containment) -> Dict[str, Any]:
    """What the far end's scope check reads — ``plan._in_scope``'s scope,
    without the anchor end's own containers: the labels an entity in scope
    may carry, and the view's roots by ID."""
    scope = query.scope
    if scope.scope_mode == "visible" and scope.visible_urns:
        return {"far_labels": sorted(labels), "far_roots": None}
    if scope.scope_mode == "view" and scope.root_urns and containment:
        return {"far_labels": sorted(labels),
                "far_roots": await _ids_of(run, labels, scope.root_urns)}
    return {"far_labels": _labels_in_scope(provider, labels, scope.entity_types),
            "far_roots": None}


async def _edge_stats(run) -> Tuple[Dict[str, int], int]:
    """Each edge type's count, and every edge's — what the first edge-ID
    band is cut by (the last band is open-ended, so a low guess loses
    nothing)."""
    res = await run("CALL db.meta.stats() YIELD relTypes, relCount RETURN relTypes, relCount", {})
    row = (res.result_set or [[None, 0]])[0]
    counts = {str(t): int(n) for t, n in row[0].items()} if isinstance(row[0], dict) else {}
    return counts, int(row[1] or 0)


def _width(width: int, counts: Dict[str, int], types, stats, near) -> int:
    """Nodes a unit holds: about ``width`` edges' worth — the edge types'
    count spread over the anchor end's entities (its types', else all)."""
    required = _required_types(near)
    nodes = sum(c for lbl, (c, _) in stats.items() if required is None or lbl.lower() in required)
    degree = sum(counts.get(t, 0) for t in types) / max(1, nodes)
    return max(1_000, int(width / max(1.0, degree)))


# ---------------------------------------------------------------------------
# The statements
# ---------------------------------------------------------------------------

def edge_context(provider, query: SearchQuery, state: Dict[str, Any]) -> EdgeContext:
    """The Connections search compiled for the end ``state`` anchors: the
    anchor end as an entity search, then — by the same compiler, so no two
    comprehensions share a name (S0 §15) — the far end, the edge filter and,
    either way, each end's condition on the other's variable."""
    edges = query.predicate
    side = state.get("anchor", "source")
    near, far = ((edges.source_where, edges.target_where) if side == "source"
                 else (edges.target_where, edges.source_where))
    depth = int(query.scope.max_depth or 12)
    containment = _containment(provider)
    compiler = _compiler(provider)
    where = compiler.compile(near or MatchAllPredicate(), scope_depth=query.scope.max_depth)
    types = compiler.connection_edge_types(edges)
    far_head, far_stages = compiler.compile_far_end(far, "m", depth)
    saved, compiler._edge_var = compiler._edge_var, "e"
    try:
        edge_where = compiler._emit_edge_predicate_fragment(edges.edge_predicate)
    finally:
        compiler._edge_var = saved
    near_on_far = far_on_near = "true"
    if edges.direction == "either":
        far_on_near = compiler.condition(far, "n", depth)
        near_on_far = compiler.condition(near, "m", depth)
    checks, scope_stages, scope_params = _far_scope_checks(compiler, query, state, depth,
                                                           containment)
    # Last: the hops' parameters are numbered on from the compiler's.
    hops, hop_params, hop_parts = within_hops(compiler)
    anchor = Context(
        where=where, params={**compiler.params, **hop_params, **scope_params}, sort=_MERGE,
        containment=containment, max_depth=depth,
        visible=(list(query.scope.visible_urns or [])
                 if query.scope.scope_mode == "visible" else None),
        within_hops=hops, hop_parts=hop_parts, tail=tuple(compiler.tail),
    )
    head = [c for c in [*checks, far_head] if c != "true"]
    sets, depths = _scope_urn_sets_with_depths(
        query.model_copy(update={"predicate": near or MatchAllPredicate()}), compiler)
    return EdgeContext(
        anchor=anchor, anchor_side=side, rel="|".join(_sanitize_label(t) for t in types),
        edge_where=edge_where, far_head=" AND ".join(grouped(c) for c in head) or "true",
        far_stages=tuple(scope_stages + far_stages), near=far_on_near, far=near_on_far,
        name_key=getattr(provider, "_name_property", None),
        anchor_sets=tuple((tuple(s), int(d)) for s, d in zip(sets, depths)),
        types=tuple(types),
    )


def _far_scope_checks(compiler, query: SearchQuery, state: Dict[str, Any], depth: int,
                      containment) -> Tuple[List[str], List[str], Dict[str, Any]]:
    """The far end's scope, as ``plan._in_scope`` tests an entity: a label in
    scope (any case, as ``_labels_in_scope`` matches them; none named, none
    tested) and, when the scope is the canvas, on it — plain tests for the
    edge MATCH's WHERE — and below the view's roots (by ID, or by URN for a
    statement that reads no graph first), a stage."""
    checks: List[str] = []
    params: Dict[str, Any] = {}
    if state.get("far_labels") is not None:
        k = compiler._name()
        checks.append(f"ANY(_xl{k} IN labels(m) WHERE toLower(_xl{k}) IN $_farLabels)")
        params["_farLabels"] = sorted({str(lbl).lower() for lbl in state["far_labels"]})
    scope = query.scope
    if scope.scope_mode == "visible" and scope.visible_urns:
        checks.append("m.urn IN $_farUrns")
        params["_farUrns"] = list(scope.visible_urns)
    stages: List[str] = []
    for key, read in (("far_roots", "ID({})"), ("far_root_urns", "{}.urn")):
        if state.get(key) is not None:
            k = compiler._name()
            stages.append(f"ANY(_xs{k} IN [(m)<-[:{_rel(containment)}*0..{depth}]-(_xq{k}) "
                          f"| {read.format(f'_xq{k}')}] WHERE _xs{k} IN $_farRoots)")
            params["_farRoots"] = list(state[key])
    return checks, stages, params


def _ends(unit: Unit, ectx: EdgeContext) -> Tuple[bool, str, str]:
    """Whether this unit's edges are stored n → m, and which variable is
    each one's source and target."""
    out = (ectx.anchor_side == "source") != unit.reverse
    return (True, "n", "m") if out else (False, "m", "n")


def edge_match(unit: Unit, ectx: EdgeContext, clamps: List[List[int]]
               ) -> Tuple[str, Dict[str, Any], str, str]:
    """The statement up to its matching edges ``e`` — each once, from ``n``
    (the anchor end) to ``m`` — and the variables of each one's source and
    target."""
    head, params = match_statement(unit, ectx.anchor, clamps)
    cypher, src, tgt = _edge_part(head, params, unit, ectx)
    return cypher, params, src, tgt


def _edge_part(head: str, params: Dict[str, Any], unit: Unit, ectx: EdgeContext
               ) -> Tuple[str, str, str]:
    """``head`` — the anchor end's statement, up to ``n`` — and the rest:
    each of its edges in the unit's band and pass, and the far end. Binds
    the band's parameters into ``params``."""
    out, src, tgt = _ends(unit, ectx)
    carry = "n, e, m"
    parts = [head]
    if unit.reverse:
        # Asked once per anchor entity, not once per edge.
        parts.append(f"WITH n, coalesce({ectx.near}, false) AS _xa")
        carry += ", _xa"
    else:
        parts.append("WITH n")
    conds = ["m.urn IS NOT NULL"]
    if unit.elo is not None:
        conds.append("ID(e) >= $_elo")
        params["_elo"] = unit.elo
    if unit.ehi is not None:
        conds.append("ID(e) < $_ehi")
        params["_ehi"] = unit.ehi
    if ectx.edge_where:
        conds.append(grouped(ectx.edge_where))
    if ectx.far_head != "true":
        conds.append(ectx.far_head)
    arrow = f"(n)-[e:{ectx.rel}]->(m)" if out else f"(n)<-[e:{ectx.rel}]-(m)"
    parts.append(f"MATCH {arrow} WHERE " + " AND ".join(conds))
    stages = list(ectx.far_stages)
    if unit.reverse:
        # Counted by the first pass: its source meets From, its target To.
        stages.append(f"NOT (coalesce({ectx.far}, false) AND _xa)")
    if stages:
        parts.append(tail_clauses(stages, carry=carry, alias="_xf"))
    return " ".join(parts), src, tgt


def explain_edges(provider, query: SearchQuery) -> Dict[str, Any]:
    """A Connections search as one statement to read, copy or edit and run:
    the whole scope at once, where the engine reads its anchor end unit by
    unit — the same tests, the scope by URN. It touches no database, so the
    end that anchors is chosen by the conditions alone (``_anchor_side``)."""
    edges = query.predicate
    scope = query.scope
    containment = _containment(provider)
    rooted = scope.scope_mode == "view" and bool(scope.root_urns) and bool(containment)
    visible = scope.scope_mode == "visible" and bool(scope.visible_urns)
    types = ([t.lower() for t in scope.entity_types or []]
             if not (rooted or visible) else [])
    side = _anchor_side(provider, query, [], {})
    ectx = edge_context(provider, query, {
        "anchor": side, "far_labels": types or None,
        "far_root_urns": list(scope.root_urns) if rooted else None})
    anchor = ectx.anchor
    params = dict(anchor.params)
    conds = ["n.urn IS NOT NULL"]
    if anchor.where not in ("", "true"):
        conds.append(grouped(anchor.where))
    if visible:
        conds.append("n.urn IN $_visible")
        params["_visible"] = list(scope.visible_urns)
    if types:
        conds.append("ANY(_l IN labels(n) WHERE toLower(_l) IN $_types)")
        params["_types"] = types
    parts = ["MATCH (n) WHERE " + " AND ".join(conds)]
    for i, (urns, depth) in enumerate(ectx.anchor_sets):
        parts.append(f"WITH n MATCH (n)<-[:{_rel(containment)}*0..{depth}]-(_r{i}) "
                     f"WHERE _r{i}.urn IN $_roots{i} WITH DISTINCT n")
        params[f"_roots{i}"] = list(urns)
    if anchor.within_hops:
        parts.append(anchor.within_hops)
    if anchor.tail:
        parts.append(tail_clauses(list(anchor.tail)))
    head = " ".join(parts)
    passes = [False, True] if edges.direction == "either" else [False]
    statements = []
    for reverse in passes:
        cypher, src, tgt = _edge_part(head, params, Unit("ids", reverse=reverse), ectx)
        statements.append(f"{cypher} RETURN {src}.urn AS source, type(e) AS edgeType, "
                          f"{tgt}.urn AS target, ID(e) AS edgeId")
    end = "From (the source)" if side == "source" else "To (the target)"
    notes = [
        f"Reads {end} as entities and tests the other end on each of their edges. The "
        "engine reads that end in units (bands of node IDs, walks down the view's roots, "
        "the canvas's entities), each counting and ranking its own edges.",
        (f"Edge types: {', '.join(ectx.types)}." if ectx.types
         else "No edges of these types are in this data source."),
        "Rollups (AGGREGATED) are never returned: they summarise other edges.",
    ]
    if edges.direction == "either":
        notes.append("Either way: the second part reads the edges stored the other way "
                     "round, leaving out those the first part returns.")
    # No edge type to read: nothing to run, the note says why.
    cypher = " UNION ALL ".join(statements) if ectx.types else ""
    return {"cypher": cypher, "hits_cypher": cypher, "params": params, "notes": notes,
            "anchor": side, "edge_types": list(ectx.types)}


def edge_sort(src: str, tgt: str, name_key: Optional[str]) -> SortSpec:
    """The order: the source's name, the target's, the edge type (each
    without case), the source's urn, the target's, the edge's ID."""
    return SortSpec((SortKey(name_text(name_key, src)), SortKey(name_text(name_key, tgt)),
                     SortKey("toUpper(type(e))"), SortKey(f"{src}.urn"),
                     SortKey(f"{tgt}.urn"), SortKey("ID(e)")))


def unit_statement(unit: Unit, ectx: EdgeContext, clamps: List[List[int]], k: int
                   ) -> Tuple[str, Dict[str, Any]]:
    """Per edge type: this unit's exact count and its first ``k`` rows."""
    match, params, src, tgt = edge_match(unit, ectx, clamps)
    sort = edge_sort(src, tgt, ectx.name_key)
    params["_k"] = int(k)
    return (f"{match} WITH n, e, m, {sort.projection()} ORDER BY {sort.order_by()} "
            f"WITH type(e) AS _t, count(*) AS _c, "
            f"collect([{', '.join(sort.aliases)}, ID({src}), ID({tgt})]) AS _rows "
            "RETURN _t, _c, _rows[..$_k]", params)


def count_statement(unit: Unit, ectx: EdgeContext, clamps: List[List[int]]
                    ) -> Tuple[str, Dict[str, Any]]:
    """Per edge type, this unit's exact count — and nothing else."""
    match, params, _, _ = edge_match(unit, ectx, clamps)
    return f"{match} RETURN type(e), count(*)", params


def after_statement(unit: Unit, ectx: EdgeContext, clamps: List[List[int]], k: int,
                    after) -> Tuple[str, Dict[str, Any]]:
    """This unit's first ``k`` rows strictly after ``after`` — a later page."""
    match, params, src, tgt = edge_match(unit, ectx, clamps)
    sort = edge_sort(src, tgt, ectx.name_key)
    cond, after_params = sort.after(after)
    params.update(after_params)
    params["_k"] = int(k)
    aliases = ", ".join(sort.aliases)
    # Filter first, then order: a WITH's WHERE comes after its ORDER BY.
    return (f"{match} WITH n, e, m, {sort.projection()} WHERE {cond} "
            f"WITH {aliases}, ID({src}) AS _si, ID({tgt}) AS _ti "
            f"ORDER BY {sort.order_by()} LIMIT $_k RETURN {aliases}, _si, _ti", params)


class _EdgeWork:
    """What a Connections search (or its count) takes from each unit: per
    edge type, its count, and its first rows — the counts committed beside
    the session, with which end anchors (``_state``), so a unit is counted
    exactly once."""

    #: A part that can't be read is left out and said so (``engine._leave_out``).
    skips = True

    def __init__(self, session: Session, ectx: EdgeContext, run, state: Dict[str, Any]) -> None:
        self.session, self.ectx, self.run = session, ectx, run
        self.state = dict(state)

    async def expand(self, unit: Unit, timeout_s: float) -> Optional[List[Unit]]:
        return await expand_unit(unit, self.ectx.anchor, self.run, timeout_s)

    async def describe(self, unit: Unit) -> Optional[str]:
        what = await describe_unit(unit, self.run)
        return f"the connections of {what}" if what else None

    async def begin(self, store: SessionStore) -> None:
        # Read with the lease held: the counts of the latest commit.
        held = await _state(store, self.session.sid)
        if held:
            self.state = held

    async def unit(self, unit: Unit, timeout_s: float):
        anchor = dataclasses.replace(self.ectx.anchor,
                                     clamp_depths=tuple(self.session.clamp_depths))
        ectx = dataclasses.replace(self.ectx, anchor=anchor)
        clamps = self.session.clamps
        if self.session.k == 0:
            cypher, params = count_statement(unit, ectx, clamps)
            res = await self.run(cypher, params, timeout_s)
            return [(str(t), int(c)) for t, c in res.result_set or []], []
        if self.session.after is not None:
            cypher, params = after_statement(unit, ectx, clamps, self.session.k,
                                             self.session.after)
            res = await self.run(cypher, params, timeout_s)
            return [], [list(r) for r in res.result_set or []]
        cypher, params = unit_statement(unit, ectx, clamps, self.session.k)
        res = await self.run(cypher, params, timeout_s)
        rs = res.result_set or []
        return ([(str(t), int(c)) for t, c, _ in rs],
                [list(r) for _, _, rows in rs for r in rows or []])

    def fold(self, unit: Unit, result) -> None:
        typed, rows = result
        types = self.state.setdefault("types", {})
        for edge_type, count in typed:
            types[edge_type] = types.get(edge_type, 0) + count
            self.session.count += count
        if rows:
            self.session.rows = _MERGE.merge(self.session.rows, rows, limit=self.session.k)

    def commit(self) -> Dict[str, Any]:
        return {"accumulator": json.dumps(self.state, separators=(",", ":"))}


# ---------------------------------------------------------------------------
# The answer
# ---------------------------------------------------------------------------

async def _answer(provider, session: Session, pos: int, page_size: int,
                  context: SearchRunContext, started: float, deadline: float, *,
                  total: Optional[int], types: Optional[Dict[str, int]], cache_hit: bool,
                  progressive: bool) -> SearchResultPage:
    rows = session.rows[pos:pos + page_size]
    edges, notes = await _hydrate(provider, rows, deadline)
    complete = session.status == COMPLETE
    first_page = session.after is None
    if first_page and complete:
        total = session.count
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
                "pos": end, "after": rows[-1], "t": total, "tc": types,
            })
    running = not complete
    page = SearchResultPage(
        edges=edges,
        edge_type_counts={str(t): int(c) for t, c in (types or {}).items()},
        cursor=cursor,
        truncated=running and not progressive,
        candidate_count=session.count if first_page else (total or len(session.rows)),
        total_count=total if not running else None,
        deadline_exceeded=running and not progressive,
        elapsed_ms=int((time.monotonic() - started) * 1000),
        cache_hit=cache_hit,
        session_id=session.sid,
        status="running" if running else "complete",
        count_status=("exact" if total is not None and not running and not session.left_out
                      else "lowerBound"),
        progress=SearchProgress(scanned=session.scanned,
                                total=max(session.total, session.scanned),
                                matched=session.count),
        data_version=session.data_version,
        stale=bool(context.data_version) and session.data_version != context.data_version,
    )
    notes = list(session.notes) + notes
    if notes:
        # Carried to the service, which folds them into the diagnostics.
        page.scope_diagnostics = ScopeDiagnostics(effective_max_depth=0, notes=notes)
    return page


async def _hydrate(provider, rows: List[List[Any]], deadline: float
                   ) -> Tuple[List[EdgeHit], List[str]]:
    """The page's edges, in its order: each read back by its ends' IDs —
    checked by their urns — and its own, between them; then where each end
    sits. A row whose edge is gone, or whose IDs now name other entities,
    is left out."""
    if not rows:
        return [], []
    name_key = getattr(provider, "_name_property", None)
    a, b = display_name_expr(name_key, "a"), display_name_expr(name_key, "b")
    res = await provider._ro_query(
        "UNWIND $_rows AS _r "
        "WITH _r[0] AS _si, _r[1] AS _ti, _r[2] AS _ei, _r[3] AS _su, _r[4] AS _tu "
        "MATCH (a) WHERE ID(a) = _si WITH a, _ti, _ei, _su, _tu WHERE a.urn = _su "
        "MATCH (b) WHERE ID(b) = _ti WITH a, b, _ei, _tu WHERE b.urn = _tu "
        "MATCH (a)-[e]->(b) WHERE ID(e) = _ei "
        f"RETURN _ei, a.urn, {a}, labels(a)[0], b.urn, {b}, labels(b)[0], type(e), properties(e)",
        params={"_rows": [[r[6], r[7], r[5], r[3], r[4]] for r in rows]},
        timeout=max(_HYDRATE_FLOOR_S, deadline - time.monotonic()),
    )
    found = {int(r[0]): r for r in res.result_set or []}
    notes: List[str] = []
    urns = list(dict.fromkeys(u for r in found.values() for u in (r[1], r[4])))
    try:
        paths = await asyncio.wait_for(_ancestor_refs(provider, urns),
                                       timeout=max(_PATHS_FLOOR_S, deadline - time.monotonic()))
    except asyncio.TimeoutError:
        paths = {}
        notes.append("Where each end sits could not be read in time; run the search again "
                     "to see them in their containers.")
    hits: List[EdgeHit] = []
    for row in rows:
        hit = found.get(int(row[5]))
        if hit is None:
            continue
        eid, su, sn, sl, tu, tn, tl, edge_type, native = hit
        props = dict(native or {})
        hits.append(EdgeHit(
            key=str(eid), id=str(props.get("id") or f"{su}|{edge_type}|{tu}"),
            edge_type=str(edge_type), properties=_edge_properties(props),
            source=_end(su, sn, sl, paths), target=_end(tu, tn, tl, paths),
        ))
    return hits, notes


def _end(urn: str, name: Optional[str], label: Optional[str],
         paths: Dict[str, List[AncestorRef]]) -> EdgeEnd:
    path = paths.get(urn, [])
    return EdgeEnd(urn=urn, display_name=name or "", entity_type=label or "",
                   parent=path[-1] if path else None, ancestor_path=path)
