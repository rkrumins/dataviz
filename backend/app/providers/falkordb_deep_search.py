"""
FalkorDB implementation of ``GraphDataProvider.deep_search``.

Compiles a :class:`SearchQuery` predicate tree into Cypher, runs it
under the scope clamp, and shapes the result into a
:class:`SearchResultPage` — aggregates and/or flat hits.

Lives in a separate module from :mod:`backend.app.providers.falkordb_provider`
to keep the provider file from growing further and to keep the
predicate visitor independently importable for unit tests.

v1 surface (intentionally bounded)
----------------------------------
**Compiled to Cypher natively** — all in a single WHERE fragment:
    TextPredicate    target=name|qualifiedName|description|tags|property
                     match=exact|prefix|substring
    PropertyPredicate eq|neq|gt|gte|lt|lte|in|notIn|contains|startsWith|endsWith|between
    TagPredicate     has|hasAll|hasAny|notHas  (JSON-substring on n.tags)
    HasPropertyPredicate  EXISTS(n.<key>)
    EntityTypePredicate   in|notIn on labels(n)[0]
    LayerPredicate        n.layerAssignment equality
    GroupPredicate        and|or|not, recursive

**Hoisted to scope** (top-level AND only):
    DescendantOfPredicate — intersection of root-URN sets, then a single
    variable-length CONTAINS check after the candidate WITH-clause.

**Aggregations**:
    by='ancestorType' (the headline UX shape — "matches per domain")
    by='entityType'   (hit's own type — cheap, no traversal)

**Deferred to a follow-up** (raise :class:`CompileError` with a clear msg):
    TextPredicate target='any' / match='fulltext' / match='regex'
        — need the n.searchableTextLower field + fulltext index that
        aren't created yet.
    WithinHopsPredicate
        — needs a separate MATCH that's awkward to compose with the
        scope-verification step; not blocking the headline UX.
    DescendantOf inside OR groups
        — FalkorDB doesn't support EXISTS { subquery } (see provider
        comment around l. 1681); compiling to pattern-existence in WHERE
        requires bound variables, which OR-positioning denies. Workable
        but defer until needed.
    Aggregation by='ancestorLevel' / 'parent' / 'tag', sub_aggregation.
    Cursor pagination on hits (page_size still applies).

These deferrals do not reduce the model's contract — the schema accepts
the full surface so the frontend and AI agents bind to a stable shape.
The compiler is the gate; lifting a deferral is a localised change here.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import time
from typing import Any, Dict, List, Optional, Tuple

from backend.common.models.search import (
    AggregationSpec,
    AncestorRef,
    SearchAggregateBucket,
    SearchHit,
    SearchQuery,
    SearchResultPage,
)

logger = logging.getLogger(__name__)


# Hard cap on the candidate set walked through the scope check. The
# planner stops streaming after this; `truncated=True` is returned.
# Tuned for "predicate-first, scope-verified" semantics: smaller is
# safer, larger gives more accurate aggregate counts on permissive
# predicates. 5k is the sweet spot per the plan's budget.
CANDIDATE_CAP = 5000


class CompileError(ValueError):
    """Raised when a predicate cannot be compiled in v1.

    Service layer translates this to HTTP 400 with the message intact —
    the message is user-facing and tells them which feature to use
    instead.
    """


# ---------------------------------------------------------------------------
# Predicate → Cypher compiler
# ---------------------------------------------------------------------------

def _safe_property_name(key: str) -> str:
    """Validate a property name as Cypher-safe (alphanumeric + underscore).

    Property names can't be parameterised in Cypher — they're inlined
    into the query text. We reject (rather than silently sanitise) any
    char outside ``[A-Za-z0-9_]`` so the user gets a clear error
    instead of a query that silently matches the wrong field
    (e.g. ``pii-class`` quietly becoming ``pii_class``).
    """
    if not key:
        raise CompileError("empty property name")
    if not isinstance(key, str):
        raise CompileError(f"property name must be a string: {key!r}")
    if key[0].isdigit():
        raise CompileError(
            f"property name cannot start with a digit: {key!r}"
        )
    if not all(c.isalnum() or c == "_" for c in key):
        raise CompileError(
            f"property name has disallowed chars "
            f"(alphanumeric + underscore only): {key!r}"
        )
    return key


def _sanitize_label(s: str) -> str:
    """Sanitize a label/edge-type name. Mirrors falkordb_provider._sanitize_label."""
    return "".join(c if c.isalnum() or c == "_" else "_" for c in str(s))


class _Compiler:
    """Walks the predicate tree, emitting a Cypher WHERE fragment.

    State is gathered on the instance:
      * ``params`` — generated parameter values (bound by Cypher ``$name``)
      * ``hoisted_root_urns`` — DescendantOf URN-sets pulled up to scope
      * ``hoisted_max_depths`` — DescendantOf per-predicate max_depths

    Reuse of the instance across multiple ``compile()`` calls is not
    supported — counters and hoisted state would leak between queries.
    """

    def __init__(self):
        self.params: Dict[str, Any] = {}
        self.hoisted_root_urns: List[List[str]] = []
        self.hoisted_max_depths: List[int] = []
        self._param_counter = 0

    def _next(self) -> str:
        n = self._param_counter
        self._param_counter += 1
        return f"p{n}"

    def compile(self, predicate) -> str:
        return self._visit(predicate, in_or=False, at_top_and=True)

    def _visit(self, p, *, in_or: bool, at_top_and: bool) -> str:
        kind = p.kind
        if kind == "group":
            return self._visit_group(p, in_or=in_or, at_top_and=at_top_and)
        # Leaves
        if kind == "text":
            return self._visit_text(p)
        if kind == "property":
            return self._visit_property(p)
        if kind == "tag":
            return self._visit_tag(p)
        if kind == "hasProperty":
            return self._visit_has_property(p)
        if kind == "entityType":
            return self._visit_entity_type(p)
        if kind == "layer":
            return self._visit_layer(p)
        if kind == "descendantOf":
            if in_or or not at_top_and:
                raise CompileError(
                    "DescendantOf is only allowed in the top-level AND group "
                    "in v1. Move it to scope.root_urns or split into "
                    "multiple queries."
                )
            self.hoisted_root_urns.append(list(p.urns))
            if p.max_depth is not None:
                self.hoisted_max_depths.append(p.max_depth)
            return "true"  # scope check enforces the constraint
        if kind == "withinHops":
            raise CompileError(
                "WithinHops is not yet supported. Will be added in a "
                "follow-up workstream."
            )
        raise CompileError(f"unknown predicate kind: {kind!r}")

    def _visit_group(self, g, *, in_or: bool, at_top_and: bool) -> str:
        if g.op == "not":
            if len(g.children) != 1:
                raise CompileError("NOT group must have exactly one child")
            inner = self._visit(g.children[0], in_or=in_or, at_top_and=False)
            return f"NOT ({inner})"
        sep = " AND " if g.op == "and" else " OR "
        child_in_or = in_or or g.op == "or"
        child_at_top_and = at_top_and and g.op == "and"
        parts = [
            self._visit(c, in_or=child_in_or, at_top_and=child_at_top_and)
            for c in g.children
        ]
        if not parts:
            return "true"
        return "(" + sep.join(parts) + ")"

    def _visit_text(self, t) -> str:
        if t.match == "fulltext":
            raise CompileError(
                "text match='fulltext' requires per-label fulltext indices "
                "that haven't been created yet (deferred). Use 'substring' "
                "or 'prefix'."
            )
        if t.match == "regex":
            raise CompileError(
                "text match='regex' is opt-in and not enabled in v1."
            )
        target = t.target
        if target == "name":
            col = "n.displayName"
        elif target == "qualifiedName":
            col = "n.qualifiedName"
        elif target == "description":
            col = "n.description"
        elif target == "tags":
            col = "n.tags"  # JSON-stringified array; CONTAINS is acceptable
        elif target == "property":
            if not t.property_key:
                raise CompileError(
                    "text target='property' requires propertyKey"
                )
            col = f"n.{_safe_property_name(t.property_key)}"
        elif target == "any":
            raise CompileError(
                "text target='any' requires the n.searchableTextLower field "
                "which is created by a follow-up workstream. Target a "
                "specific field for v1 (name, qualifiedName, description, "
                "property, tags)."
            )
        else:
            raise CompileError(f"unknown text target: {target!r}")

        pn = self._next()
        if t.case_sensitive:
            self.params[pn] = t.value
            col_expr = col
        else:
            self.params[pn] = t.value.lower()
            col_expr = f"toLower(toString({col}))"
        if t.match == "exact":
            return f"{col_expr} = ${pn}"
        if t.match == "prefix":
            return f"{col_expr} STARTS WITH ${pn}"
        return f"{col_expr} CONTAINS ${pn}"  # substring

    def _visit_property(self, p) -> str:
        col = f"n.{_safe_property_name(p.key)}"
        op = p.op
        if op in ("eq", "neq", "gt", "gte", "lt", "lte"):
            symbol = {"eq": "=", "neq": "<>", "gt": ">",
                      "gte": ">=", "lt": "<", "lte": "<="}[op]
            pn = self._next()
            self.params[pn] = p.value
            return f"{col} {symbol} ${pn}"
        if op in ("contains", "startsWith", "endsWith"):
            pn = self._next()
            v = "" if p.value is None else str(p.value)
            if p.case_sensitive:
                self.params[pn] = v
                col_expr = col
            else:
                self.params[pn] = v.lower()
                col_expr = f"toLower(toString({col}))"
            keyword = {"contains": "CONTAINS",
                       "startsWith": "STARTS WITH",
                       "endsWith": "ENDS WITH"}[op]
            return f"{col_expr} {keyword} ${pn}"
        if op in ("in", "notIn"):
            pn = self._next()
            self.params[pn] = list(p.value or [])
            return (f"NOT ({col} IN ${pn})" if op == "notIn"
                    else f"{col} IN ${pn}")
        if op == "between":
            if not isinstance(p.value, list) or len(p.value) != 2:
                raise CompileError(
                    "property op='between' requires value=[lo, hi]"
                )
            lo_p, hi_p = self._next(), self._next()
            self.params[lo_p] = p.value[0]
            self.params[hi_p] = p.value[1]
            return f"({col} >= ${lo_p} AND {col} <= ${hi_p})"
        raise CompileError(f"unknown property op: {op!r}")

    def _visit_tag(self, t) -> str:
        # tags is currently stored as JSON-stringified list. Each value
        # appears in that JSON as e.g. `"PII"`. CONTAINS on the
        # quoted form is a tight enough match for v1 — when tags get
        # promoted to a native array in a follow-up, this changes to
        # ``ANY(x IN n.tags WHERE x = ...)``.
        per_value = []
        for v in t.values:
            pn = self._next()
            self.params[pn] = json.dumps(v)
            per_value.append(f"n.tags CONTAINS ${pn}")
        if not per_value:
            return "true"
        if t.op == "has" or t.op == "hasAny":
            return "(" + " OR ".join(per_value) + ")"
        if t.op == "hasAll":
            return "(" + " AND ".join(per_value) + ")"
        if t.op == "notHas":
            return "NOT (" + " OR ".join(per_value) + ")"
        raise CompileError(f"unknown tag op: {t.op!r}")

    def _visit_has_property(self, h) -> str:
        expr = f"EXISTS(n.{_safe_property_name(h.key)})"
        return f"NOT ({expr})" if h.negate else expr

    def _visit_entity_type(self, e) -> str:
        pn = self._next()
        self.params[pn] = list(e.values)
        clause = f"labels(n)[0] IN ${pn}"
        return f"NOT ({clause})" if e.op == "notIn" else clause

    def _visit_layer(self, l) -> str:
        pn = self._next()
        self.params[pn] = l.layer_assignment
        return f"n.layerAssignment = ${pn}"


# ---------------------------------------------------------------------------
# Candidate / scope / aggregation Cypher builders
# ---------------------------------------------------------------------------

def _effective_root_urns(
    compiler: _Compiler,
    scope_root_urns: Optional[List[str]],
) -> Optional[List[str]]:
    """Combine scope.root_urns with any hoisted DescendantOf URN-sets.

    Multiple top-level DescendantOf groups under AND => intersect (each
    is a separate "must descend from" clause). Empty intersection means
    no rows can match — caller short-circuits.

    Returns None when no scope is in effect.
    """
    sets: List[set] = []
    if scope_root_urns:
        sets.append(set(scope_root_urns))
    for s in compiler.hoisted_root_urns:
        sets.append(set(s))
    if not sets:
        return None
    intersection = sets[0]
    for s in sets[1:]:
        intersection = intersection & s
    return sorted(intersection)


def _build_candidate_cypher(
    *,
    where_fragment: str,
    entity_types_param: bool,
    scope_continuation: str,
    candidate_cap: int,
) -> str:
    """The candidate-selection prefix.

    Ends with ``WITH n`` so the caller appends one of:
      * ``RETURN n``                       (hits)
      * ``RETURN count(n) AS c``           (count-only)
      * ``MATCH (anc)-[...]->(n) ...``     (aggregation pivot)
    """
    parts = ["MATCH (n)"]
    where_parts = []
    if entity_types_param:
        where_parts.append("labels(n)[0] IN $_scopeEntityTypes")
    if where_fragment and where_fragment != "true":
        where_parts.append(where_fragment)
    if where_parts:
        parts.append("WHERE " + " AND ".join(where_parts))
    parts.append(f"WITH n LIMIT {candidate_cap}")
    if scope_continuation:
        parts.append(scope_continuation)
    return " ".join(parts)


def _build_scope_continuation(
    provider,
    effective_root_urns: List[str],
    max_depth: int,
) -> Tuple[str, Dict[str, Any]]:
    """Verify each candidate descends from one of the in-scope roots.

    Inserted AFTER the candidate ``WITH n LIMIT $cap`` clause so the
    scope check works on the bounded candidate set, not the entire
    subtree (the planner's worst case).

    Returns ('', {}) when containment edge types aren't configured —
    the caller proceeds without scope verification and logs a warning.
    """
    try:
        ctypes = list(provider._get_containment_edge_types())
    except Exception:
        logger.warning(
            "deep_search: containment edge types not configured; "
            "scope.root_urns will be ignored",
        )
        return "", {}
    if not ctypes:
        return "", {}
    rel = "|".join(_sanitize_label(t) for t in ctypes)
    fragment = (
        f"MATCH (root)-[:{rel}*1..{int(max_depth)}]->(n) "
        f"WHERE root.urn IN $_rootUrns "
        f"WITH DISTINCT n"
    )
    return fragment, {"_rootUrns": list(effective_root_urns)}


# ---------------------------------------------------------------------------
# Cursor codec (v1: stub — no hits-pagination yet, but the codec is here
# so the cursor shape is fixed for follow-ups)
# ---------------------------------------------------------------------------

def query_hash(query: SearchQuery) -> str:
    """SHA1 (12 chars) of the canonicalized query JSON.

    Used to invalidate cursors that reference a different query.
    """
    j = query.model_dump_json(by_alias=True)
    return hashlib.sha1(j.encode("utf-8")).hexdigest()[:12]


def encode_cursor(state: Dict[str, Any]) -> str:
    return base64.urlsafe_b64encode(
        json.dumps(state, sort_keys=True).encode("utf-8")
    ).decode("ascii")


def decode_cursor(s: str) -> Dict[str, Any]:
    try:
        raw = base64.urlsafe_b64decode(s.encode("ascii")).decode("utf-8")
        return json.loads(raw)
    except Exception:
        raise CompileError("invalid cursor encoding")


# ---------------------------------------------------------------------------
# Main entry — wires everything together
# ---------------------------------------------------------------------------

async def execute_deep_search(
    provider,
    query: SearchQuery,
    *,
    deadline_ms: Optional[int] = None,
) -> SearchResultPage:
    """Execute a deep search against a connected FalkorDB provider.

    The provider is responsible for connection / read-write routing
    (``provider._ro_query``) and for the existing Redis-backed ancestor
    cache (``provider._get_ancestor_chain``). This function only sees
    the public-ish provider surface.
    """
    start = time.monotonic()
    timeout_s = (deadline_ms or query.options.soft_deadline_ms) / 1000.0

    # 1. Compile predicate → Cypher WHERE fragment + scope hoisting
    compiler = _Compiler()
    where_fragment = compiler.compile(query.predicate)
    base_params: Dict[str, Any] = dict(compiler.params)

    # 2. Effective scope (scope.root_urns ∩ hoisted DescendantOf urns)
    eff_root_urns = _effective_root_urns(compiler, query.scope.root_urns)
    if eff_root_urns is not None and not eff_root_urns:
        # Intersection is empty → no rows can match
        return _empty_result(query.options.results, start)

    # 3. Scope continuation Cypher (after the candidate WITH n)
    scope_continuation = ""
    if eff_root_urns:
        scope_continuation, scope_params = _build_scope_continuation(
            provider, eff_root_urns, query.scope.max_depth or 12,
        )
        base_params.update(scope_params)

    # 4. Build the candidate prefix
    use_entity_types = bool(query.scope.entity_types)
    if use_entity_types:
        base_params["_scopeEntityTypes"] = list(query.scope.entity_types)
    cand_cypher = _build_candidate_cypher(
        where_fragment=where_fragment,
        entity_types_param=use_entity_types,
        scope_continuation=scope_continuation,
        candidate_cap=CANDIDATE_CAP,
    )

    # 5. Execute according to requested result shape
    aggregates: Optional[List[List[SearchAggregateBucket]]] = None
    hits: Optional[List[SearchHit]] = None
    candidate_count = 0
    truncated = False
    deadline_exceeded = False

    shape = query.options.results
    aggs = query.options.aggregations or []

    try:
        # Aggregates-only: skip the materialised hit list entirely.
        # Run aggregation queries (one per spec) plus a single COUNT for
        # candidate_count. Hits stay None.
        if shape == "aggregates":
            aggregates = []
            for spec in aggs:
                buckets = await _run_aggregation(
                    provider, cand_cypher, base_params, spec,
                    query=query, timeout_s=timeout_s,
                )
                aggregates.append(buckets)
            candidate_count, truncated_count = await _run_count(
                provider, cand_cypher, base_params, timeout_s=timeout_s,
            )
            truncated = truncated_count
        else:
            # Hits requested (and maybe aggregates too). Materialise the
            # candidate set once; build hits from it, optionally aggregate.
            result = await provider._ro_query(
                cand_cypher + " RETURN n",
                params=base_params, timeout=timeout_s,
            )
            rows = result.result_set or []
            candidate_count = len(rows)
            truncated = candidate_count >= CANDIDATE_CAP
            hits = _build_hits_from_rows(provider, rows, query)
            if shape == "both" and aggs:
                aggregates = []
                for spec in aggs:
                    buckets = await _run_aggregation(
                        provider, cand_cypher, base_params, spec,
                        query=query, timeout_s=timeout_s,
                    )
                    aggregates.append(buckets)
    except asyncio.TimeoutError:
        deadline_exceeded = True
        truncated = True
        logger.info("deep_search: soft deadline exceeded after %sms",
                    int((time.monotonic() - start) * 1000))
    except Exception as exc:
        # FalkorDB-specific timeout / connection errors don't always
        # subclass asyncio.TimeoutError. Surface as deadline-exceeded
        # when the elapsed time is at/over the budget; otherwise re-raise
        # so the service layer can map to a proper HTTP status.
        elapsed_ms = int((time.monotonic() - start) * 1000)
        if elapsed_ms >= timeout_s * 1000 * 0.95:
            deadline_exceeded = True
            truncated = True
            logger.info(
                "deep_search: provider raised under soft deadline (%sms): %s",
                elapsed_ms, exc,
            )
        else:
            raise

    # 6. Optional ancestor hydration for hits
    if hits and query.options.include_ancestor_path:
        await _hydrate_ancestors(provider, hits)

    return SearchResultPage(
        aggregates=aggregates,
        hits=hits,
        cursor=None,  # hits-pagination cursor wired up in a follow-up
        truncated=truncated,
        candidate_count=candidate_count,
        deadline_exceeded=deadline_exceeded,
        elapsed_ms=int((time.monotonic() - start) * 1000),
        cache_hit=False,
    )


def _empty_result(shape, start) -> SearchResultPage:
    return SearchResultPage(
        aggregates=([] if shape in ("aggregates", "both") else None),
        hits=([] if shape in ("hits", "both") else None),
        cursor=None,
        truncated=False,
        candidate_count=0,
        deadline_exceeded=False,
        elapsed_ms=int((time.monotonic() - start) * 1000),
        cache_hit=False,
    )


async def _run_count(
    provider, cand_cypher: str, params: Dict[str, Any], *, timeout_s: float,
) -> Tuple[int, bool]:
    result = await provider._ro_query(
        cand_cypher + " RETURN count(n) AS c",
        params=params, timeout=timeout_s,
    )
    rs = result.result_set or []
    n = int(rs[0][0]) if rs and rs[0] else 0
    return n, (n >= CANDIDATE_CAP)


async def _run_aggregation(
    provider,
    cand_cypher: str,
    cand_params: Dict[str, Any],
    spec: AggregationSpec,
    *,
    query: SearchQuery,
    timeout_s: float,
) -> List[SearchAggregateBucket]:
    """Run one aggregation pivoted on the candidate set ``n``."""
    if spec.by == "ancestorType":
        return await _run_aggregation_ancestor_type(
            provider, cand_cypher, cand_params, spec,
            query=query, timeout_s=timeout_s,
        )
    if spec.by == "entityType":
        return await _run_aggregation_entity_type(
            provider, cand_cypher, cand_params, spec,
            timeout_s=timeout_s,
        )
    raise CompileError(
        f"aggregation by={spec.by!r} is not yet supported in v1. "
        "Use 'ancestorType' or 'entityType'."
    )


async def _run_aggregation_ancestor_type(
    provider, cand_cypher, cand_params, spec, *, query, timeout_s,
):
    if not spec.ancestor_entity_types:
        raise CompileError(
            "aggregation by='ancestorType' requires ancestorEntityTypes"
        )
    try:
        ctypes = list(provider._get_containment_edge_types())
    except Exception:
        ctypes = []
    if not ctypes:
        logger.warning(
            "deep_search: ancestorType aggregation requested but containment "
            "edge types are not configured; returning empty buckets",
        )
        return []
    rel = "|".join(_sanitize_label(t) for t in ctypes)
    max_depth = query.scope.max_depth or 12
    k = max(0, int(spec.sample_hits_per_bucket))

    agg_cypher = (
        cand_cypher + " "
        f"MATCH (anc)-[:{rel}*1..{int(max_depth)}]->(n) "
        f"WHERE labels(anc)[0] IN $_aggTypes "
        f"WITH anc, count(DISTINCT n) AS mc, "
        f"collect(DISTINCT n)[..{k}] AS samples "
        f"RETURN anc.urn AS urn, anc.displayName AS name, "
        f"labels(anc)[0] AS etype, mc, samples "
        f"ORDER BY mc DESC LIMIT {int(spec.max_buckets)}"
    )
    params = dict(cand_params)
    params["_aggTypes"] = list(spec.ancestor_entity_types)
    result = await provider._ro_query(
        agg_cypher, params=params, timeout=timeout_s,
    )
    return _rows_to_buckets(provider, result.result_set or [])


async def _run_aggregation_entity_type(
    provider, cand_cypher, cand_params, spec, *, timeout_s,
):
    k = max(0, int(spec.sample_hits_per_bucket))
    agg_cypher = (
        cand_cypher + " "
        f"WITH labels(n)[0] AS etype, n "
        f"WITH etype, count(DISTINCT n) AS mc, "
        f"collect(DISTINCT n)[..{k}] AS samples "
        f"RETURN '' AS urn, etype AS name, etype, mc, samples "
        f"ORDER BY mc DESC LIMIT {int(spec.max_buckets)}"
    )
    result = await provider._ro_query(
        agg_cypher, params=cand_params, timeout=timeout_s,
    )
    return _rows_to_buckets(provider, result.result_set or [])


def _rows_to_buckets(provider, rows) -> List[SearchAggregateBucket]:
    buckets: List[SearchAggregateBucket] = []
    for row in rows:
        urn, name, etype, mc, samples_raw = (
            row[0], row[1], row[2], row[3], row[4],
        )
        sample_hits = []
        for s in (samples_raw or []):
            node = provider._extract_node_from_result(s)
            if node:
                sample_hits.append(SearchHit(node=node))
        buckets.append(SearchAggregateBucket(
            ancestor_urn=urn or "",
            ancestor_display_name=name or "",
            ancestor_entity_type=etype or "",
            ancestor_depth_from_scope_root=0,  # v1: not computed
            match_count=int(mc),
            sample_hits=sample_hits,
        ))
    return buckets


def _build_hits_from_rows(provider, rows, query: SearchQuery) -> List[SearchHit]:
    """Convert candidate rows to SearchHits, applying sort + page_size in-memory.

    The candidate Cypher deliberately doesn't ORDER BY — sorting in
    Cypher forces a materialisation barrier that thwarts the candidate
    cap. We sort the already-bounded result here.
    """
    hits: List[SearchHit] = []
    for row in rows:
        node = provider._extract_node_from_result(row)
        if node:
            hits.append(SearchHit(node=node))

    sort_field = query.options.sort
    sort_dir = query.options.sort_dir
    if sort_field in ("displayName", "qualifiedName"):
        def key(h: SearchHit):
            v = (getattr(h.node, "display_name" if sort_field == "displayName"
                         else "qualified_name") or "")
            return v.lower()
        hits.sort(key=key, reverse=(sort_dir == "desc"))
    # 'relevance' and 'depth' deferred; default to displayName ordering.
    elif sort_field == "relevance":
        # No relevance signal in v1 (no fulltext). Fall back to displayName.
        hits.sort(
            key=lambda h: (h.node.display_name or "").lower(),
            reverse=(sort_dir == "desc"),
        )

    return hits[:query.options.page_size]


async def _hydrate_ancestors(provider, hits: List[SearchHit]) -> None:
    """Populate ``hit.ancestor_path`` for each hit using the provider's
    Redis-backed ancestor cache."""
    needed_urns: set = set()
    chains: Dict[str, List[str]] = {}
    for h in hits:
        try:
            chain = await provider._get_ancestor_chain(h.node.urn)
        except Exception:
            chain = []
        chains[h.node.urn] = chain
        needed_urns.update(chain)

    # Batch-fetch ancestor node summaries
    summaries: Dict[str, Tuple[str, str]] = {}  # urn -> (displayName, entityType)
    for anc_urn in needed_urns:
        try:
            anc = await provider.get_node(anc_urn)
            if anc:
                summaries[anc_urn] = (anc.display_name, anc.entity_type)
        except Exception:
            continue

    for h in hits:
        chain = chains.get(h.node.urn, [])
        # chain is parent → ... → root; reverse to root → parent
        refs = []
        for urn in reversed(chain):
            if urn in summaries:
                name, etype = summaries[urn]
                refs.append(AncestorRef(
                    urn=urn, display_name=name, entity_type=etype,
                ))
        h.ancestor_path = refs
