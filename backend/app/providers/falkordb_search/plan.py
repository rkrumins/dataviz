"""Which parts of the graph a search reads, and the Cypher for each part.

A plan is a list of UNITS. Each unit is one statement's worth of the scope
— small enough to finish in well under a second, report progress, share
the engine's threads and be retried — and the units partition the scope,
so their counts add up to the exact total. Measurements behind each shape
are in docs/search-engine/S0_FINDINGS.md.

``range``   One label, one band of node IDs: ``MATCH (n:L) WHERE ID(n) >=
            $lo AND ID(n) < $hi`` is a seek (§2 A2). A label is cut into
            bands holding about ``chunk_width`` of its nodes, from its first
            ID; the first band starts at 0 and the last is open-ended, so
            the bands cover the label whatever the estimate got wrong.
``visible`` One label, the URNs on the canvas: a per-label index lookup.
``walk``    Roots and everything under them: the roots are sought by ID
            (never ``root.urn IN`` on an unlabelled node — a scan of every
            node, §7) and walked down the containment edges.

A node carrying two labels in scope is read under the first only
(``NOT n:Earlier``), so it is counted once.

How a view's roots bound the search (§7):

* a subtree that a bounded walk finds small is walked, in one unit;
* a large subtree under a few roots is read in ``range`` units, each
  clamped by an upward check — ``WITH n MATCH (n)<-[:C*0..D]-(_r) WHERE
  ID(_r) IN $roots`` — which runs only on nodes the predicate kept. The
  check compares every ancestor with every root, so it is only used for
  small root sets;
* a large subtree under many roots is walked in buckets of roots. Roots
  inside other roots are dropped first, and containment is a tree (a node
  has one parent — what ``_get_ancestor_chain`` relies on), so the
  buckets' subtrees are disjoint.
"""
from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field, replace
from typing import Any, Awaitable, Callable, Dict, FrozenSet, List, Optional, Sequence, Tuple

from backend.app.providers.falkordb_deep_search import (
    _build_within_hops_continuation,
    _scope_urn_sets_with_depths,
    _sanitize_label,
    _searchable_labels,
)
from backend.app.providers.falkordb_search.keys import SortSpec
from backend.app.providers.falkordb_search.raw_properties import RawLeaf, probe_condition

#: Root sets up to this size clamp range units with an ``IN`` list. The
#: check costs (ancestor rows) × (roots): 50 roots cost 2× an unclamped
#: chunk, 5,000 cost 30× (§7), so a larger set is walked in buckets.
CLAMP_MAX_ROOTS = 64
#: Roots per walk bucket.
WALK_BUCKET_ROOTS = 32

Run = Callable[[str, Dict[str, Any]], Awaitable[Any]]


@dataclass
class Unit:
    kind: str                          # "range" | "visible" | "walk"
    label: Optional[str] = None
    lo: Optional[int] = None           # None = from the first ID
    hi: Optional[int] = None           # None = open-ended
    roots: Optional[List[int]] = None  # walk: the root IDs walked
    exclude: Tuple[str, ...] = ()      # in-scope labels read before this one
    size: int = 1                      # estimated nodes, for progress
    span: int = 0                      # open-ended range: IDs it likely covers
    depth: Optional[int] = None        # walk: how far below its roots (None: the scope's)

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        d["exclude"] = list(self.exclude)
        return d

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "Unit":
        return cls(**{**d, "exclude": tuple(d.get("exclude") or ())})

    def split(self) -> Optional[List["Unit"]]:
        """Two halves of this unit, or None when it can't be cut further.
        A chunk that runs out of time is retried as its halves."""
        if self.kind == "range":
            lo = self.lo or 0
            # An open-ended range is cut where its nodes likely end; its
            # upper half stays open-ended, so nothing past the guess is lost.
            hi = self.hi if self.hi is not None else lo + self.span
            if hi - lo < 2:
                return None
            mid = lo + (hi - lo) // 2
            half = max(1, self.size // 2)
            return [Unit("range", self.label, self.lo, mid, None, self.exclude, half),
                    Unit("range", self.label, mid, self.hi, None, self.exclude, half,
                         0 if self.hi is not None else hi - mid)]
        if self.kind == "walk" and self.roots and len(self.roots) > 1:
            mid = len(self.roots) // 2
            half = max(1, self.size // 2)
            return [Unit("walk", roots=self.roots[:mid], size=half, depth=self.depth),
                    Unit("walk", roots=self.roots[mid:], size=half, depth=self.depth)]
        return None


@dataclass
class Plan:
    units: List[Unit]
    # Root-ID sets every match must descend from, checked per unit.
    clamps: List[List[int]] = field(default_factory=list)
    notes: List[str] = field(default_factory=list)
    # How far below its roots each clamp reaches (none given: the scope's).
    clamp_depths: List[int] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {"units": [u.to_dict() for u in self.units],
                "clamps": self.clamps, "notes": self.notes,
                "clamp_depths": self.clamp_depths}

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "Plan":
        return cls([Unit.from_dict(u) for u in d.get("units") or []],
                   [list(c) for c in d.get("clamps") or []],
                   list(d.get("notes") or []),
                   [int(x) for x in d.get("clamp_depths") or []])


@dataclass(frozen=True)
class Context:
    """What every unit's statement shares: the compiled predicate, the scope
    it runs in and the order it ranks by."""
    where: str
    params: Dict[str, Any]
    sort: SortSpec
    containment: Tuple[str, ...]
    max_depth: int
    visible: Optional[List[str]] = None
    within_hops: str = ""
    # A first page's units also tally their matches' containment ancestors
    # (the search asked for the ``ancestor`` facet: the canvas's badges).
    tally: bool = False
    # The predicate's property conditions, when the graph keeps values
    # raw: each unit of a label in ``raw_labels`` (and every walk or
    # visible unit) answers them first (``raw_probe_statement``).
    raw_leaves: Tuple[RawLeaf, ...] = ()
    raw_labels: FrozenSet[str] = frozenset()
    # The session's ``clamp_depths``: how far below its roots each clamp
    # reaches — a descendantOf's own maxDepth (none given: ``max_depth``).
    clamp_depths: Tuple[int, ...] = ()


# ---------------------------------------------------------------------------
# Planning
# ---------------------------------------------------------------------------

async def make_plan(provider, query, compiler, *, run: Run, width: int,
                    walk_max: int, timeout_s: float) -> Plan:
    """The units ``query`` reads. ``run(cypher, params)`` executes one
    statement under the caller's admission and budget."""
    labels = await _searchable_labels(provider, timeout_s=timeout_s)
    stats = await _label_stats(run, labels)
    containment = _containment(provider)
    notes: List[str] = []

    root_sets, depths = _scope_urn_sets_with_depths(query, compiler)
    if query.scope.scope_mode == "visible" and query.scope.visible_urns:
        clamps = await _resolve_clamps(run, labels, root_sets, containment, notes)
        if clamps is None:
            return Plan([], notes=notes)
        in_scope = sorted(lbl for lbl in labels if stats.get(lbl, (0, 0))[0] > 0)
        units = [Unit("visible", label, exclude=tuple(in_scope[:i]),
                      size=max(1, len(query.scope.visible_urns) // max(1, len(in_scope))))
                 for i, label in enumerate(in_scope)]
        return Plan(units, clamps, notes, depths if clamps else [])

    if root_sets and containment:
        clamps = await _resolve_clamps(run, labels, root_sets, containment, notes)
        if clamps is None:
            return Plan([], notes=notes)
        return await _rooted_plan(run, clamps, depths, stats, labels, containment,
                                  width=width, walk_max=walk_max, notes=notes)
    if root_sets:
        notes.append("containment edge types are not configured, so the view's "
                     "roots could not bound the search — it read every entity type")

    in_scope = _labels_in_scope(provider, labels, query.scope.entity_types)
    return Plan(_range_units(in_scope, stats, width), notes=notes)


def _containment(provider) -> Tuple[str, ...]:
    try:
        return tuple(sorted(provider._get_containment_edge_types()))
    except Exception:
        return ()


def _labels_in_scope(provider, labels: Sequence[str],
                     entity_types: Optional[Sequence[str]]) -> List[str]:
    """The labels a search without roots reads: the view's entity types —
    or, when it names none, the live ontology's — matched to the graph's
    labels case-insensitively (``_resolve_entity_types_scope``)."""
    wanted = [t for t in (entity_types or []) if t]
    if not wanted:
        wanted = list((getattr(provider, "_entity_type_levels", None) or {}).keys())
    if not wanted:
        return sorted(labels)
    lowered = {t.lower() for t in wanted}
    matched = sorted(lbl for lbl in labels if lbl.lower() in lowered)
    # A stale view config naming none of the live types still searches the
    # data source's own types, as the capped engine did.
    return matched or sorted(
        lbl for lbl in labels
        if lbl.lower() in {t.lower() for t in
                           (getattr(provider, "_entity_type_levels", None) or {})}
    ) or sorted(labels)


async def _label_stats(run: Run, labels: Sequence[str]) -> Dict[str, Tuple[int, int]]:
    """``label -> (count, first node ID)``. ``db.meta.stats()`` answers the
    counts in a millisecond; a label scan's first row is its lowest ID."""
    counts: Dict[str, int] = {}
    res = await run("CALL db.meta.stats() YIELD labels RETURN labels", {})
    row = (res.result_set or [[]])[0]
    if row and isinstance(row[0], dict):
        counts = {str(k): int(v) for k, v in row[0].items()}
    firsts: Dict[str, int] = {}
    if labels:
        union = " UNION ALL ".join(
            f"MATCH (n:`{_sanitize_label(lbl)}`) WITH n LIMIT 1 "
            f"RETURN '{_quote(lbl)}' AS label, ID(n) AS first"
            for lbl in labels
        )
        res = await run(union, {})
        firsts = {str(r[0]): int(r[1]) for r in (res.result_set or []) if r and r[1] is not None}
    return {lbl: (counts.get(lbl, 0), firsts.get(lbl, 0)) for lbl in labels}


def _quote(label: str) -> str:
    return label.replace("\\", "\\\\").replace("'", "\\'")


def _range_units(labels: Sequence[str], stats: Dict[str, Tuple[int, int]],
                 width: int) -> List[Unit]:
    """Each label in bands of about ``width`` of its nodes."""
    total = sum(c for c, _ in stats.values())
    units: List[Unit] = []
    for i, label in enumerate(labels):
        count, first = stats.get(label, (0, 0))
        exclude = tuple(labels[:i])
        if count == 0:
            # A label the schema remembers but no node carries (labels are
            # never forgotten) — there is nothing to read under it.
            continue
        if count <= width:
            units.append(Unit("range", label, exclude=exclude, size=max(1, count),
                              span=max(total, count)))
            continue
        pieces = math.ceil(count / width)
        # Assume the label's IDs spread evenly from its first to the top of
        # the graph's; the open-ended last band covers whatever lies past.
        span = max(count, total - first)
        step = max(1, math.ceil(span / pieces))
        for k in range(pieces):
            lo = None if k == 0 else first + k * step
            hi = None if k == pieces - 1 else first + (k + 1) * step
            units.append(Unit("range", label, lo, hi, exclude=exclude,
                              size=max(1, count // pieces),
                              span=0 if hi is not None else max(step, total - (lo or 0))))
    return units


async def _resolve_clamps(run: Run, labels: Sequence[str], root_sets: List[List[str]],
                          containment: Tuple[str, ...], notes: List[str]
                          ) -> Optional[List[List[int]]]:
    """Each URN set's node IDs, found per label through the urn index.
    None when a set names nothing that exists — nothing can descend from it.
    """
    if not root_sets or not containment:
        return []
    clamps: List[List[int]] = []
    for urns in root_sets:
        ids = await _ids_of(run, labels, urns)
        if not ids:
            notes.append("the search's roots are not in the graph, so nothing is inside them")
            return None
        clamps.append(ids)
    return clamps


async def _ids_of(run: Run, labels: Sequence[str], urns: Sequence[str]) -> List[int]:
    if not labels or not urns:
        return []
    union = " UNION ALL ".join(
        f"MATCH (r:`{_sanitize_label(lbl)}`) WHERE r.urn IN $_urns RETURN ID(r) AS id"
        for lbl in labels
    )
    res = await run(union, {"_urns": list(urns)})
    return sorted({int(r[0]) for r in (res.result_set or []) if r and r[0] is not None})


async def _rooted_plan(run: Run, clamps: List[List[int]], depths: List[int], stats,
                       labels, containment, *, width: int, walk_max: int,
                       notes: List[str]) -> Plan:
    """``depths``: how far below its roots each of ``clamps`` reaches."""
    rel = _rel(containment)
    total = sum(c for c, _ in stats.values())
    limit = min(walk_max, max(width, total // 8))
    probes: List[int] = []
    for ids, depth in zip(clamps, depths):
        probes.append(await _walk_size(run, ids, rel, depth, limit) if limit else limit + 1)
    anchor = min(range(len(clamps)), key=lambda i: (probes[i], len(clamps[i])))
    others = [c for i, c in enumerate(clamps) if i != anchor]
    other_depths = [d for i, d in enumerate(depths) if i != anchor]
    if probes[anchor] <= limit:
        # Small enough to walk in one statement; the other sets clamp it.
        return Plan([Unit("walk", roots=clamps[anchor], size=max(1, probes[anchor]),
                          depth=depths[anchor])], others, notes, other_depths)
    if len(clamps[anchor]) <= CLAMP_MAX_ROOTS:
        return Plan(_range_units(sorted(labels), stats, width), clamps, notes, list(depths))
    roots = await _outermost(run, clamps[anchor], rel, depths[anchor])
    buckets = [roots[i:i + WALK_BUCKET_ROOTS] for i in range(0, len(roots), WALK_BUCKET_ROOTS)]
    per = max(1, total // max(1, len(buckets)))
    return Plan([Unit("walk", roots=b, size=per, depth=depths[anchor]) for b in buckets],
                others, notes, other_depths)


def _rel(containment: Sequence[str]) -> str:
    return "|".join(_sanitize_label(t) for t in containment)


async def _walk_size(run: Run, ids: List[int], rel: str, max_depth: int, limit: int) -> int:
    """How many nodes the roots contain, counting no further than
    ``limit + 1`` — a bounded walk stops early (57 ms to learn a 1M
    subtree has more than 50k nodes)."""
    res = await run(
        "UNWIND $_ids AS _wi MATCH (_w) WHERE ID(_w) = _wi "
        f"MATCH (_w)-[:{rel}*0..{int(max_depth)}]->(n) "
        "WITH DISTINCT n LIMIT $_lim RETURN count(n)",
        {"_ids": ids, "_lim": limit + 1},
    )
    rs = res.result_set or []
    return int(rs[0][0]) if rs and rs[0] else 0


async def _outermost(run: Run, ids: List[int], rel: str, max_depth: int) -> List[int]:
    """The roots that are not inside another root — the rest add nothing
    but a second count of the same nodes."""
    res = await run(
        "UNWIND $_ids AS _wi MATCH (_w) WHERE ID(_w) = _wi "
        f"OPTIONAL MATCH (_w)<-[:{rel}*1..{int(max_depth)}]-(_a) "
        "RETURN ID(_w), collect(ID(_a))",
        {"_ids": ids},
    )
    roots = set(ids)
    return sorted(int(r[0]) for r in (res.result_set or [])
                  if not any(a in roots for a in (r[1] or []) if a is not None))


# ---------------------------------------------------------------------------
# Statements
# ---------------------------------------------------------------------------

def match_statement(unit: Unit, ctx: Context, clamps: List[List[int]]
                    ) -> Tuple[str, Dict[str, Any]]:
    """The statement up to ``n``: every match of this unit, once each, with
    the predicate's parameters bound."""
    params: Dict[str, Any] = dict(ctx.params)
    rel = _rel(ctx.containment)
    where = [] if ctx.where in ("", "true") else [f"({ctx.where})"]
    if unit.kind == "walk":
        params["_walk"] = list(unit.roots or [])
        head = ("UNWIND $_walk AS _wi MATCH (_w) WHERE ID(_w) = _wi "
                f"MATCH (_w)-[:{rel}*0..{int(unit.depth or ctx.max_depth)}]->(n) "
                "WITH DISTINCT n "
                "WHERE " + " AND ".join(["n.urn IS NOT NULL"] + where))
    else:
        conds: List[str] = []
        if unit.kind == "visible":
            conds.append("n.urn IN $_visible")
            params["_visible"] = list(ctx.visible or [])
        else:
            if unit.lo is not None:
                conds.append("ID(n) >= $_lo")
                params["_lo"] = unit.lo
            if unit.hi is not None:
                conds.append("ID(n) < $_hi")
                params["_hi"] = unit.hi
        if unit.exclude:
            conds.append("NOT (" + " OR ".join(
                f"n:`{_sanitize_label(lbl)}`" for lbl in unit.exclude) + ")")
        conds.append("n.urn IS NOT NULL")
        head = (f"MATCH (n:`{_sanitize_label(unit.label or '')}`) WHERE "
                + " AND ".join(conds + where))
    parts = [head]
    for i, ids in enumerate(clamps):
        depth = ctx.clamp_depths[i] if i < len(ctx.clamp_depths) else ctx.max_depth
        parts.append(f"WITH n MATCH (n)<-[:{rel}*0..{int(depth)}]-(_r{i}) "
                     f"WHERE ID(_r{i}) IN $_roots{i} WITH DISTINCT n")
        params[f"_roots{i}"] = list(ids)
    if ctx.within_hops:
        parts.append(ctx.within_hops)
    return " ".join(parts), params


def page_statements(unit: Unit, ctx: Context, clamps: List[List[int]], k: int
                    ) -> List[Tuple[str, Dict[str, Any], str]]:
    """``(cypher, params, yields)`` giving this unit's exact count and its
    first ``k`` rows; ``yields`` is ``both``, ``count`` or ``rows``.

    A range or visible unit does both in one statement: ``ORDER BY`` on a
    ``WITH``, then ``count(*)`` and the ordered ``collect`` — never slower
    than two statements, and the collect holds at most one chunk (§6). A
    walk's subtree can be far larger than a chunk, so it counts and ranks
    in two statements, each in bounded memory.
    """
    head, params = match_statement(unit, ctx, clamps)
    sort = ctx.sort
    params.update(sort.params)
    params["_k"] = int(k)
    ranked = f"{head} WITH n, {sort.projection()} ORDER BY {sort.order_by()}"
    aliases = ", ".join(sort.aliases)
    if unit.kind == "walk":
        return [
            (f"{head} RETURN count(n)", dict(params), "count"),
            (f"{ranked} LIMIT $_k RETURN {aliases}", dict(params), "rows"),
        ]
    return [(f"{ranked} WITH count(*) AS _c, collect([{aliases}]) AS _rows "
             "RETURN _c, _rows[..$_k]", params, "both")]


def count_statement(unit: Unit, ctx: Context, clamps: List[List[int]]
                    ) -> Tuple[str, Dict[str, Any]]:
    """This unit's exact count, and nothing else — a rule's total."""
    head, params = match_statement(unit, ctx, clamps)
    return f"{head} RETURN count(n)", params


def raw_probe_statement(unit: Unit, ctx: Context) -> Tuple[str, Dict[str, Any]]:
    """The ids and raw JSON of this unit's nodes that may keep one of the
    predicate's keys raw — the unit's nodes alone: the predicate, the scope's
    clamps and hops belong to the statements that use the answer."""
    head, params = match_statement(
        unit, replace(ctx, where="", params={}, within_hops=""), [])
    cond, cond_params = probe_condition(ctx.raw_leaves)
    params.update(cond_params)
    return f"{head} WITH n WHERE {cond} RETURN ID(n), n.propertiesRaw", params


def tally_statement(unit: Unit, ctx: Context, clamps: List[List[int]]
                    ) -> Tuple[str, Dict[str, Any]]:
    """Every containment ancestor of this unit's matches, with how many of
    them it holds per entity type — the canvas's "N matches inside" badges,
    one unit at a time instead of one statement over every match.
    ``count(DISTINCT n)``: a match reached down two paths counts once; the
    units partition the scope, so the sums across units are exact."""
    head, params = match_statement(unit, ctx, clamps)
    rel = _rel(ctx.containment)
    return (f"{head} WITH n MATCH (_c)-[:{rel}*1..{int(ctx.max_depth)}]->(n) "
            "WITH _c, labels(n)[0] AS _et, count(DISTINCT n) AS _k "
            "RETURN _c.urn, _c.displayName, labels(_c)[0], _et, _k", params)


def after_statement(unit: Unit, ctx: Context, clamps: List[List[int]], k: int,
                    after: Sequence[Any]) -> Tuple[str, Dict[str, Any]]:
    """This unit's first ``k`` rows strictly after ``after`` — a later page."""
    head, params = match_statement(unit, ctx, clamps)
    sort = ctx.sort
    cond, after_params = sort.after(after)
    params.update(sort.params)
    params.update(after_params)
    params["_k"] = int(k)
    aliases = ", ".join(sort.aliases)
    # A WITH's WHERE comes after its ORDER BY and LIMIT, so it would filter
    # the page instead of what the page is taken from: filter first, then
    # order in a second WITH.
    return (f"{head} WITH n, {sort.projection()} WHERE {cond} "
            f"WITH {aliases} ORDER BY {sort.order_by()} LIMIT $_k RETURN {aliases}",
            params)


def within_hops(compiler) -> Tuple[str, Dict[str, Any]]:
    """The predicate's ``withinHops`` anchors as continuations — the capped
    engine's own (``_build_within_hops_continuation``)."""
    fragment, params, _ = _build_within_hops_continuation(
        compiler.hoisted_within_hops, compiler._param_counter,
    )
    return fragment, params
