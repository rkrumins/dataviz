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
import asyncio
import hashlib
import json
import logging
import time
from collections import Counter
from typing import Any, Dict, List, Optional, Set, Tuple

from backend.app.services.deep_search import CompileError, get_deep_search_settings
from backend.common.models.search import (
    AggregationSpec,
    AncestorRef,
    DegreePredicate,
    EdgeRef,
    PathHit,
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
#
# Tunables (CANDIDATE_CAP and the discovery caps below) now live in
# ``DeepSearchSettings`` (env-overridable). These module-level names
# are kept as a back-compat surface for tests / external callers that
# import them by name — they resolve to live settings via PEP 562
# ``__getattr__`` so env overrides take effect immediately.
_BACKCOMPAT_SETTINGS_KEYS = {
    "CANDIDATE_CAP": "candidate_cap",
    "_DISCOVER_VALUE_SAMPLES_PER_KEY": "discover_value_samples_per_key",
    "_DISCOVER_VALUE_KEYS_PER_LABEL": "discover_value_keys_per_label",
    "_DISCOVER_TAG_VALUES_CAP": "discover_tag_values_cap",
    "_DISCOVER_EDGE_SAMPLE_CAP": "discover_edge_sample_cap",
}


def __getattr__(name: str):
    field = _BACKCOMPAT_SETTINGS_KEYS.get(name)
    if field is not None:
        return getattr(get_deep_search_settings(), field)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


# ---------------------------------------------------------------------------
# Predicate → Cypher compiler
# ---------------------------------------------------------------------------

def _safe_property_name(key: str) -> str:
    """Escape a property name for safe interpolation into Cypher.

    Property names can't be parameterised in Cypher — they're inlined
    into the query text. We use Cypher's backtick-quoting syntax to
    safely interpolate ANY printable property name, including ones
    with spaces (``Asset Owner``), hyphens (``pii-class``), dots
    (``user.id``), or other punctuation that real-world data sources
    legitimately use as property keys. This replaces the previous
    ``alphanumeric + underscore only`` allowlist which rejected such
    names with HTTP 400.

    Cypher injection is prevented by the backtick wrapping plus
    doubling of any internal backticks (the standard escape per
    OpenCypher / Neo4j / FalkorDB grammar):

        ``Asset Owner``       → ```Asset Owner```
        ``pii-class``         → ```pii-class```
        ``x); DROP TABLE``    → ```x); DROP TABLE```   (safe — the
                                whole string is one identifier inside
                                backticks; the semicolon/parens are
                                not interpreted as Cypher syntax)
        ``has`backtick``      → ```has``backtick```    (internal
                                backtick doubled per the spec)

    Returns the BACKTICK-WRAPPED form including the surrounding
    backticks. Callers interpolate it directly:

        f"n.{_safe_property_name(key)}"   →   n.`Asset Owner`

    Trade-off: the rendered Cypher always uses backticks even for
    pure-alphanumeric names. That's slightly noisier in logs but
    semantically identical to bare identifiers and avoids a
    conditional branch on the hot compilation path.
    """
    if not key:
        raise CompileError("empty property name")
    if not isinstance(key, str):
        raise CompileError(f"property name must be a string: {key!r}")
    # Escape any internal backticks by doubling them — Cypher's
    # standard mechanism for embedding ``\``` inside a backticked
    # identifier (e.g. ``a`b`` becomes ```a``b```).
    escaped = key.replace("`", "``")
    return f"`{escaped}`"


def _sanitize_label(s: str) -> str:
    """Sanitize a label/edge-type name. Mirrors falkordb_provider._sanitize_label."""
    return "".join(c if c.isalnum() or c == "_" else "_" for c in str(s))


class _Compiler:
    """Walks the predicate tree, emitting a Cypher WHERE fragment.

    State is gathered on the instance:
      * ``params`` — generated parameter values (bound by Cypher ``$name``)
      * ``hoisted_root_urns`` — DescendantOf URN-sets pulled up to scope
      * ``hoisted_max_depths`` — DescendantOf per-predicate max_depths
      * ``hoisted_within_hops`` — WithinHops continuations (compiled
        post-candidate; one MATCH per occurrence)

    Reuse of the instance across multiple ``compile()`` calls is not
    supported — counters and hoisted state would leak between queries.

    Ontology-resolved edge type sets are injected via the constructor so
    the compiler never hardcodes lineage / containment edge names. The
    executor passes the provider's resolved sets through to keep this
    module dependency-free at module-load time.
    """

    def __init__(
        self,
        *,
        lineage_edge_types: Optional[Set[str]] = None,
        containment_edge_types: Optional[Set[str]] = None,
    ):
        self.params: Dict[str, Any] = {}
        self.hoisted_root_urns: List[List[str]] = []
        self.hoisted_max_depths: List[int] = []
        # Each entry: ({"urns": [...], "hops": int, "direction": str,
        #               "edgeTypes": [str] | None})
        self.hoisted_within_hops: List[Dict[str, Any]] = []
        # Hoisted path predicate (UC3). At most one per query — the
        # service rejects multiple PathPredicates at validation time
        # because the result shape couldn't merge two independent
        # path queries cleanly.
        self.hoisted_path: Optional[Dict[str, Any]] = None
        self._param_counter = 0
        # Ontology-resolved edge type sets. ``None`` means the caller
        # didn't inject them — predicates that depend on lineage /
        # containment classification will raise CompileError on visit.
        self._lineage_edge_types = lineage_edge_types
        self._containment_edge_types = containment_edge_types

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
            if in_or or not at_top_and:
                raise CompileError(
                    "WithinHops is only allowed in the top-level AND group. "
                    "Move it outside the OR / NOT group, or split the query."
                )
            return self._visit_within_hops(p)
        if kind == "degree":
            return self._visit_degree(p)
        if kind in ("isOrphan", "isLeaf", "isRoot",
                    "hasIncoming", "hasOutgoing"):
            # Sugar — normalise to a DegreePredicate then visit.
            return self._visit_degree(_normalize_sugar_to_degree(p))
        if kind == "path":
            if in_or or not at_top_and:
                raise CompileError(
                    "Path is only allowed in the top-level AND group. "
                    "Path search returns a different result shape (ordered "
                    "node→edge→node sequences) than predicate composition "
                    "can express. Run path search separately."
                )
            if self.hoisted_path is not None:
                raise CompileError(
                    "Only one Path predicate is allowed per query."
                )
            return self._visit_path(p)
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
                "fulltext search is not enabled in v1 — use "
                "match='substring', 'prefix', or 'exact'"
            )
        if t.match == "regex":
            raise CompileError(
                "text match='regex' is opt-in and not enabled in v1."
            )
        target = t.target

        # ``target='name'`` widens to OR across the canonical name-like
        # fields the storage layer commits to — displayName and
        # qualifiedName only. It deliberately does NOT include
        # n.searchableText: that field also absorbs description and
        # every string-valued user property, so folding it into 'name'
        # would make "name is exactly X" / "name ends with X" false —
        # either false-positiving on a property value or never matching
        # via the blob. ``target='any'`` is the broad, property-inclusive
        # target. Any single field can be null/empty on a given node
        # (legacy sync, partial ingestion) without blackholing the
        # search — the predicate matches if ANY of the listed columns
        # contains the value.
        #
        # ``description`` / ``tags`` / ``qualifiedName`` stay
        # single-field — those are explicit, pure user targets.
        if target == "name":
            cols = ["n.displayName", "n.qualifiedName"]
        elif target == "qualifiedName":
            cols = ["n.qualifiedName"]
        elif target == "description":
            cols = ["n.description"]
        elif target == "tags":
            # JSON-stringified array; CONTAINS is acceptable.
            cols = ["n.tags"]
        elif target == "property":
            if not t.property_key:
                raise CompileError(
                    "text target='property' requires propertyKey"
                )
            cols = [f"n.{_safe_property_name(t.property_key)}"]
        elif target == "any":
            # n.searchableText is denormalised at write-time (already
            # lowercased, includes description + string-valued user
            # properties). The toLower on read is defensive in case a
            # node was written by an older provider that didn't
            # lowercase. displayName/qualifiedName are ORed in directly
            # so a node whose searchableText hasn't been backfilled yet
            # is still found by its name.
            cols = ["n.searchableText", "n.displayName", "n.qualifiedName"]
        else:
            raise CompileError(f"unknown text target: {target!r}")

        pn = self._next()

        def wrap_col(c: str) -> str:
            # Mirror the pattern the provider's own simple search uses
            # (see ``falkordb_provider._build_native_storage_filters``):
            # ``toLower(toString(n.foo)) CONTAINS $v``. No COALESCE — a
            # missing property yields null, ``null CONTAINS 'x'`` is
            # null, and within a multi-field OR the other terms still
            # decide the result. Adding ``COALESCE(n.foo, '')`` here
            # has been observed to make some FalkorDB plans return 0
            # rows for predicates that should match; the simple-search
            # path doesn't use COALESCE and works against the same
            # data, so we align with that.
            if t.case_sensitive:
                return c
            return f"toLower(toString({c}))"

        if t.case_sensitive:
            self.params[pn] = t.value
        else:
            self.params[pn] = t.value.lower()

        if t.match == "exact":
            op = "="
        elif t.match == "prefix":
            op = "STARTS WITH"
        elif t.match == "suffix":
            op = "ENDS WITH"
        else:
            op = "CONTAINS"  # substring

        if len(cols) == 1:
            return f"{wrap_col(cols[0])} {op} ${pn}"
        # Multi-field OR — wrap in parens so it composes inside an AND.
        clauses = [f"{wrap_col(c)} {op} ${pn}" for c in cols]
        return "(" + " OR ".join(clauses) + ")"

    def _visit_property(self, p) -> str:
        col = f"n.{_safe_property_name(p.key)}"
        op = p.op
        if op in ("eq", "neq"):
            symbol = {"eq": "=", "neq": "<>"}[op]
            pn = self._next()
            # Case-fold ONLY when the value is a string (and not
            # case_sensitive) — a typed comparison (int/float/bool/None/
            # list) must keep its raw column reference and untouched
            # value so it stays index-eligible and keeps its original
            # type semantics (e.g. numeric equality, not a stringified
            # one).
            if isinstance(p.value, str) and not p.case_sensitive:
                col_expr = f"toLower(toString({col}))"
                self.params[pn] = p.value.lower()
            else:
                col_expr = col
                self.params[pn] = p.value
            return f"{col_expr} {symbol} ${pn}"
        if op in ("gt", "gte", "lt", "lte"):
            symbol = {"gt": ">", "gte": ">=", "lt": "<", "lte": "<="}[op]
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
        # Lowercase the comparison both ways so a user who picks
        # "Dataset" in the FE still matches nodes whose stored label
        # is "dataset" (or any other case) — see the matching
        # ``toLower(l)`` in ``_build_candidate_cypher``.
        self.params[pn] = [str(v).lower() for v in e.values]
        clause = f"toLower(labels(n)[0]) IN ${pn}"
        return f"NOT ({clause})" if e.op == "notIn" else clause

    def _visit_layer(self, l) -> str:
        pn = self._next()
        self.params[pn] = l.layer_assignment
        return f"n.layerAssignment = ${pn}"

    def _resolve_degree_edge_types(self, predicate) -> List[str]:
        """Resolve the edge-type list for a degree / withinHops predicate.

        Precedence: explicit ``edge_types`` on the predicate wins; else
        the constructor-injected lineage / containment set chosen by
        ``edge_class``. Missing-injection is a compile-time error so we
        never silently compile a degree check against zero edge types
        (which would match every node and look like a planner bug).
        """
        if predicate.edge_types:
            return list(predicate.edge_types)
        edge_class = predicate.edge_class
        if edge_class == "lineage":
            if self._lineage_edge_types is None:
                raise CompileError(
                    "degree / withinHops with edgeClass='lineage' requires "
                    "the provider's lineage edge types — ontology resolution "
                    "must complete before search."
                )
            return sorted(self._lineage_edge_types)
        if edge_class == "containment":
            if self._containment_edge_types is None:
                raise CompileError(
                    "degree / withinHops with edgeClass='containment' "
                    "requires the provider's containment edge types — "
                    "ontology resolution must complete before search."
                )
            return sorted(self._containment_edge_types)
        if edge_class == "any":
            if (self._lineage_edge_types is None
                    or self._containment_edge_types is None):
                raise CompileError(
                    "degree / withinHops with edgeClass='any' requires both "
                    "lineage and containment edge types — ontology "
                    "resolution must complete before search."
                )
            combined = set(self._lineage_edge_types) | set(
                self._containment_edge_types
            )
            return sorted(combined)
        raise CompileError(f"unknown edgeClass: {edge_class!r}")

    def _visit_degree(self, d) -> str:
        edge_types = self._resolve_degree_edge_types(d)
        # An empty edge-type set with op=='eq' value=0 trivially matches
        # every node (no edges of these types exist anywhere). Surface
        # this as "true" rather than a degenerate Cypher fragment, so
        # the caller can read the result honestly.
        if not edge_types:
            if d.op == "eq" and d.value == 0:
                return "true"
            if d.op in ("gt", "gte") and d.value >= 0:
                # No such edges exist → degree is always 0
                if d.op == "gte" and d.value == 0:
                    return "true"
                return "false"
            if d.op in ("lt", "lte"):
                return "true"
            if d.op == "neq" and d.value != 0:
                return "true"
            if d.op == "eq":
                return "false"
            return "false"

        rel = "|".join(_sanitize_label(t) for t in edge_types)
        direction = d.direction
        in_p = f"(n)<-[:{rel}]-()"
        out_p = f"(n)-[:{rel}]->()"

        if direction == "in":
            pattern: Optional[str] = in_p
        elif direction == "out":
            pattern = out_p
        elif direction == "both":
            # Both directions handled per-op below — there's no single
            # undirected pattern in FalkorDB that gives the union degree.
            pattern = None
        else:
            raise CompileError(f"unknown degree direction: {direction!r}")

        # ----- threshold-around-zero ops -----
        # FalkorDB rejects `size((pattern))` over relationship-type
        # alternation when the result is NOT-wrapped (its planner
        # cannot resolve the "filtered alias"). For thresholds that
        # are semantically "any vs. none", emit pattern-existence
        # directly — the same idiom the orphan branch always used.
        #
        # The matrix below covers every (op, value) combo that
        # collapses to existence / absence; only non-trivial counts
        # (>1, =5, etc.) fall through to the `size()` branch.
        threshold: Optional[str] = None   # 'existence' | 'absence' | None
        if d.value == 0:
            if d.op in ("eq", "lte"):
                threshold = "absence"
            elif d.op in ("neq", "gt"):
                threshold = "existence"
            elif d.op == "gte":
                return "true"        # >= 0 always
            elif d.op == "lt":
                return "false"       # < 0 never
        elif d.value == 1:
            if d.op == "lt":
                threshold = "absence"     # < 1 ⇔ == 0
            elif d.op == "gte":
                threshold = "existence"   # >= 1 ⇔ > 0

        if threshold == "absence":
            if direction == "both":
                return f"(NOT {in_p} AND NOT {out_p})"
            assert pattern is not None
            return f"NOT {pattern}"
        if threshold == "existence":
            if direction == "both":
                return f"({in_p} OR {out_p})"
            assert pattern is not None
            return pattern

        # ----- non-trivial counts → size((pattern)) <op> $value -----
        # NB: FalkorDB has been observed to reject size((pattern)) when
        # the surrounding context wraps it in NOT and the relationship
        # pattern uses alternation. The zero/one thresholds above cover
        # the common cases (IsOrphan/IsLeaf/IsRoot/HasIncoming/
        # HasOutgoing). Counts of >1 / =5 / etc. still emit size(); if
        # FalkorDB also rejects those, the next step is to switch to a
        # list-comprehension that filters on type(r) instead of using
        # relationship-type alternation in the pattern itself.
        symbol = {"eq": "=", "neq": "<>", "gt": ">",
                  "gte": ">=", "lt": "<", "lte": "<="}[d.op]
        pn = self._next()
        self.params[pn] = int(d.value)
        if direction == "both":
            return f"(size({in_p}) + size({out_p})) {symbol} ${pn}"
        assert pattern is not None
        return f"size({pattern}) {symbol} ${pn}"

    def _visit_path(self, p) -> str:
        """Hoist a PathPredicate. Compiles to ``true`` in the WHERE
        fragment (so the standard candidate scan effectively becomes
        "any node") and stashes the path-query parameters so the
        executor can emit a path MATCH instead of the usual
        candidate cypher.

        Resolving edge types here mirrors WithinHops — an empty
        resolved set means "no edges of that class exist" and the
        query trivially returns no paths.
        """
        # Use the same edge-type resolver. PathPredicate has
        # ``edge_types`` (explicit override) and ``edge_class`` (default
        # set selector), matching the DegreePredicate / WithinHops
        # shape.
        edge_types = self._resolve_degree_edge_types(p)
        edge_where = self._emit_edge_predicate_fragment(
            getattr(p, "edge_predicate", None)
        )
        self.hoisted_path = {
            "source_urns": list(p.source_urns),
            "target_urns": list(p.target_urns),
            "direction": p.direction,
            "edge_types": list(edge_types),
            "max_hops": int(p.max_hops),
            "max_paths": int(p.max_paths),
            # Optional per-edge filter (e.g. ``rel.confidence > 0.9``).
            # Empty string when no edge_predicate was supplied; injected
            # into the ALL(rel IN relationships(p) WHERE …) block.
            "edge_where": edge_where,
        }
        return "true"

    def _visit_within_hops(self, w) -> str:
        """Hoist a WithinHops predicate to a post-candidate MATCH.

        Compiles to "true" in the WHERE fragment (so it composes with
        AND'd siblings) and stashes its parameters for the executor to
        emit a separate ``MATCH (anchor)-[:EDGES*1..hops]-(n)`` after
        the candidate set is bound.
        """
        edge_types = self._resolve_degree_edge_types(w)
        edge_where = self._emit_edge_predicate_fragment(
            getattr(w, "edge_predicate", None)
        )
        if not edge_types:
            # Empty edge-type set ⇒ no node can be within N hops of
            # anything; short-circuit the whole query.
            self.hoisted_within_hops.append({
                "urns": list(w.urns),
                "hops": int(w.hops),
                "direction": w.direction,
                "edge_types": [],
                "edge_where": edge_where,
            })
            return "true"
        self.hoisted_within_hops.append({
            "urns": list(w.urns),
            "hops": int(w.hops),
            "direction": w.direction,
            "edge_types": list(edge_types),
            "edge_where": edge_where,
        })
        return "true"

    # ---- Edge-predicate compilation (inside PathPredicate / WithinHops) ----

    def _emit_edge_predicate_fragment(self, ep) -> str:
        """Compile an EdgePredicate tree to a Cypher fragment that
        evaluates against the bound variable ``rel``. Returns an empty
        string when no predicate was supplied.

        Used inside ``ALL(rel IN relationships(p) WHERE …)`` blocks of
        path and variable-length-hop queries.
        """
        if ep is None:
            return ""
        return self._visit_edge(ep)

    def _visit_edge(self, ep) -> str:
        kind = ep.kind
        if kind == "edgeProperty":
            return self._visit_edge_property(ep)
        if kind == "edgeHasProperty":
            return self._visit_edge_has_property(ep)
        if kind == "edgeGroup":
            return self._visit_edge_group(ep)
        raise CompileError(f"unknown edge predicate kind: {kind!r}")

    def _visit_edge_property(self, ep) -> str:
        col = f"rel.{_safe_property_name(ep.key)}"
        op = ep.op
        if op in ("eq", "neq", "gt", "gte", "lt", "lte"):
            symbol = {"eq": "=", "neq": "<>", "gt": ">",
                      "gte": ">=", "lt": "<", "lte": "<="}[op]
            pn = self._next()
            self.params[pn] = ep.value
            return f"{col} {symbol} ${pn}"
        if op in ("contains", "startsWith", "endsWith"):
            pn = self._next()
            v = "" if ep.value is None else str(ep.value)
            self.params[pn] = v
            keyword = {"contains": "CONTAINS",
                       "startsWith": "STARTS WITH",
                       "endsWith": "ENDS WITH"}[op]
            return f"{col} {keyword} ${pn}"
        if op in ("in", "notIn"):
            pn = self._next()
            self.params[pn] = list(ep.value or [])
            return (f"NOT ({col} IN ${pn})" if op == "notIn"
                    else f"{col} IN ${pn}")
        if op == "between":
            if not isinstance(ep.value, list) or len(ep.value) != 2:
                raise CompileError(
                    "edgeProperty op='between' requires value=[lo, hi]"
                )
            lo_p, hi_p = self._next(), self._next()
            self.params[lo_p] = ep.value[0]
            self.params[hi_p] = ep.value[1]
            return f"({col} >= ${lo_p} AND {col} <= ${hi_p})"
        raise CompileError(f"unknown edge property op: {op!r}")

    def _visit_edge_has_property(self, ep) -> str:
        expr = f"EXISTS(rel.{_safe_property_name(ep.key)})"
        return f"NOT ({expr})" if ep.negate else expr

    def _visit_edge_group(self, ep) -> str:
        if ep.op == "not":
            if len(ep.children) != 1:
                raise CompileError(
                    "EdgeGroup op='not' must have exactly one child"
                )
            return f"NOT ({self._visit_edge(ep.children[0])})"
        if not ep.children:
            return "true"
        sep = " AND " if ep.op == "and" else " OR "
        return "(" + sep.join(self._visit_edge(c) for c in ep.children) + ")"


def _normalize_sugar_to_degree(p) -> DegreePredicate:
    """Convert a sugar predicate (IsOrphan / IsLeaf / IsRoot /
    HasIncoming / HasOutgoing) to the canonical ``DegreePredicate``.

    Centralised so the compiler has a single visitor for graph-shape
    queries; future emitters (path search, explain hints) reuse this.
    """
    kind = p.kind
    common = {
        "edge_class": p.edge_class,
        "edge_types": list(p.edge_types) if p.edge_types else None,
    }
    if kind == "isOrphan":
        return DegreePredicate(direction="both", op="eq", value=0, **common)
    if kind == "isLeaf":
        return DegreePredicate(direction="out", op="eq", value=0, **common)
    if kind == "isRoot":
        return DegreePredicate(direction="in", op="eq", value=0, **common)
    if kind == "hasIncoming":
        return DegreePredicate(direction="in", op="gt", value=0, **common)
    if kind == "hasOutgoing":
        return DegreePredicate(direction="out", op="gt", value=0, **common)
    raise CompileError(f"unknown sugar predicate: {kind!r}")


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
    candidate_cap: int,
    scope_continuation: str = "",
    within_hops_continuation: str = "",
    scope_pre_filter: str = "",
) -> str:
    """The candidate-selection prefix.

    Ends with ``WITH n`` so the caller appends one of:
      * ``RETURN n``                       (hits)
      * ``RETURN count(n) AS c``           (count-only)
      * ``MATCH (anc)-[...]->(n) ...``     (aggregation pivot)

    ``within_hops_continuation`` is appended after the scope continuation
    (so candidates are first scope-clamped, then narrowed to those
    within N hops of the anchor URN-set). Both continuations end with
    ``WITH DISTINCT n`` so multiple stack cleanly.

    ``scope_pre_filter`` replaces the ``MATCH (n)`` prefix with a
    root-anchored MATCH chain, so the predicate WHERE and the
    ``LIMIT candidate_cap`` apply to nodes ALREADY clamped to the scope
    subtree. This is the correctness-critical shape whenever a
    containment scope exists: the post-filter shape (``scope_continuation``,
    appended AFTER the cap) caps the graph-wide candidate set first and
    then intersects with scope, which silently drops in-scope matches
    when the predicate is broad. When ``scope_pre_filter`` is set,
    ``scope_continuation`` must be empty (the pre-filter already enforces
    the clamp); the two are mutually exclusive.
    """
    if scope_pre_filter:
        parts: List[str] = [scope_pre_filter]
    else:
        parts = ["MATCH (n)"]
    where_parts = []
    if entity_types_param:
        # Multi-label safe: a node with labels ['Asset', 'object']
        # would be dropped by ``labels(n)[0] IN $list`` if the planner
        # surfaces 'Asset' first AND 'Asset' isn't in the list — even
        # though 'object' IS in the list. ``ANY(... WHERE l IN ...)``
        # checks every label and matches if any is in scope. Same cost
        # for single-labeled nodes (the common case) and strictly more
        # correct for multi-labeled nodes.
        #
        # Case-insensitive: the ontology stores entity-type IDs with
        # the casing the config author chose (``dataset`` /
        # ``DataPlatform`` / etc.), but ingestion can write labels with
        # any case if the source system varies. ``toLower`` on both
        # sides guarantees the filter never silently drops nodes due to
        # case-drift between the ontology and the data.
        where_parts.append(
            "ANY(l IN labels(n) WHERE toLower(l) IN $_scopeEntityTypes)",
        )
    if where_fragment and where_fragment != "true":
        where_parts.append(where_fragment)
    if where_parts:
        parts.append("WHERE " + " AND ".join(where_parts))
    parts.append(f"WITH n LIMIT {candidate_cap}")
    if scope_continuation:
        parts.append(scope_continuation)
    if within_hops_continuation:
        parts.append(within_hops_continuation)
    return " ".join(parts)


def _resolve_entity_types_scope(
    provider,
    requested: Optional[List[str]],
) -> Tuple[Optional[List[str]], Optional[str]]:
    """Reconcile the view's ``scope.entity_types`` against the live data
    source's resolved ontology — the data source is the authority on
    what types actually exist; the view's stored list is a hint that
    can drift (auto-created views inherit a default ontology snapshot
    that may not match the bound data source).

    The contract is: SILENTLY substitute the live ontology whenever
    the view's requested list is disjoint from reality. The view's
    *intent* ("apply a type filter") is honored; the *specific types*
    are corrected to those that actually exist. No noisy diagnostic
    for what is normal operation — users only see a note when they
    explicitly picked a mix of valid + invalid types (likely a real
    config error worth surfacing).

    Returns ``(effective_types, note)`` where:
      * ``effective_types`` — list bound to ``$_scopeEntityTypes`` (or
        ``None`` to skip the filter entirely — only possible when the
        provider has no live ontology to fall back on)
      * ``note`` — diagnostic only when partial overlap suggests a
        user-driven mistake or when the request was empty and we
        defaulted to all known types; ``None`` for the
        silently-corrected and clean-overlap cases.

    **Default-to-live (W1.1b):** when ``requested`` is empty AND the
    provider knows the live ontology, the candidate scan is bounded
    by that set rather than running unfiltered. This keeps a
    million-node graph performant even for views that don't restrict
    entity types — the candidate scan never walks ``MATCH (n)``
    without a label predicate.
    """
    requested_types = [t for t in (requested or []) if t]
    live_levels = getattr(provider, "_entity_type_levels", None) or {}
    live_types = sorted(live_levels.keys())

    if not requested_types:
        # Request didn't restrict types. Default to the live ontology
        # so the candidate scan is bounded by all known labels rather
        # than running ``MATCH (n)`` unfiltered. If the provider has
        # no ontology either, return None — the executor will surface
        # a "no scope clamp; full scan with candidate-cap-only safety"
        # diagnostic.
        if live_types:
            return live_types, (
                "scope.entity_types was empty; defaulted to the live "
                "ontology so the candidate scan stays bounded."
            )
        return None, None

    if not live_types:
        # Provider hasn't introspected its ontology yet. Trust the
        # request as the only signal we have.
        return list(requested_types), None

    live_set = set(live_types)
    requested_set = set(requested_types)
    overlap = requested_set & live_set

    if not overlap:
        # Zero overlap → view config is a stale snapshot of a different
        # (or default) ontology. Silently substitute the live ontology
        # as the filter so the search remains type-scoped per the
        # view's intent. No diagnostic — this is normal operation.
        return live_types, None

    if overlap == requested_set:
        # Requested list is a clean subset of live — no override needed.
        return sorted(requested_set), None

    # Partial overlap — some valid, some stale. Narrow to the overlap
    # but DO emit a quiet note because this could mean the user picked
    # a type that genuinely no longer exists (worth telling them about).
    dropped = sorted(requested_set - live_set)
    note = (
        f"{len(dropped)} requested type(s) "
        f"({dropped[:6]}{'…' if len(dropped) > 6 else ''}) "
        f"are not present in this data source's ontology and were "
        f"omitted. Active filter: {sorted(overlap)}."
    )
    return sorted(overlap), note


def _resolve_candidate_cap(query: SearchQuery, settings) -> int:
    """Pick the effective candidate-scan ceiling for one request.

    Precedence:
      1. ``query.options.candidate_cap`` (per-request override) if set
      2. ``settings.candidate_cap`` (deployment default; env var
         ``DEEP_SEARCH_CANDIDATE_CAP``, default 10000)

    Always clamped to ``[100, settings.candidate_cap_max]`` so a
    malformed override can't accidentally request 10M candidates.
    The service-layer validator rejects above-max requests up-front
    with a clear error, but we still clamp here defensively.
    """
    requested = getattr(query.options, "candidate_cap", None)
    base = requested if requested else settings.candidate_cap
    return max(100, min(int(base), settings.candidate_cap_max))


def _build_compiler_for_provider(provider) -> _Compiler:
    """Construct a `_Compiler` with the provider's ontology-resolved
    edge type sets. Missing-injection is tolerated (the compiler will
    raise on visit only if a predicate actually depends on them).
    """
    lineage: Optional[Set[str]] = None
    containment: Optional[Set[str]] = None
    try:
        lineage = set(provider._get_lineage_edge_types())
    except Exception:
        lineage = None
    try:
        containment = set(provider._get_containment_edge_types())
    except Exception:
        containment = None
    return _Compiler(
        lineage_edge_types=lineage,
        containment_edge_types=containment,
    )


def _maybe_add_visible_urns_clause(
    where_fragment: str,
    scope_mode: str,
    visible_urns: List[str],
    base_params: Dict[str, Any],
) -> Tuple[str, bool]:
    """When ``scope_mode='visible'`` and ``visible_urns`` is non-empty,
    AND ``n.urn IN $_visibleUrns`` into the candidate where-fragment and
    bind the param. Returns ``(updated_fragment, did_inject)``.

    The visible filter is the cheapest possible scope clamp (single
    indexed lookup per row) and replaces both the containment scope
    continuation and the entity-type label scan for the user-facing
    "fast feedback" mode.
    """
    if scope_mode != "visible" or not visible_urns:
        return where_fragment, False
    base_params["_visibleUrns"] = list(visible_urns)
    clause = "n.urn IN $_visibleUrns"
    if where_fragment and where_fragment != "true":
        return f"({clause}) AND ({where_fragment})", True
    return clause, True


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
    # ``*0..D`` (not ``*1..D``) so the root URNs themselves count as
    # in-scope matches. With ``*1..D`` a node that IS a root (e.g. a
    # top-level container the user sees on the canvas like "Sales")
    # is dropped because there's no 1+ hop path from itself to
    # itself — the candidate scan finds it, the scope continuation
    # silently discards it, and the user sees no result. This made
    # "View" mode strictly more restrictive than "Visible" mode for
    # the very roots that define the view.
    fragment = (
        f"MATCH (root)-[:{rel}*0..{int(max_depth)}]->(n) "
        f"WHERE root.urn IN $_rootUrns "
        f"WITH DISTINCT n"
    )
    return fragment, {"_rootUrns": list(effective_root_urns)}


def _build_scope_continuation_chain(
    provider,
    urn_sets: List[List[str]],
    max_depth: int,
) -> Tuple[str, Dict[str, Any]]:
    """Emit one MATCH continuation per non-empty URN set, AND'd via
    chained ``WITH DISTINCT n``.

    Replaces the URN-set intersection semantics of
    ``_effective_root_urns`` + ``_build_scope_continuation`` for the
    nested-anchor case: ``scope.root_urns=[LayerA]`` AND
    ``descendantOf=[ObjectInsideLayerA]`` previously produced ∅; now
    each set becomes its own MATCH and Cypher's natural AND narrows
    correctly to the most-specific subtree.

    Each MATCH uses an indexed param name (``_scopeRootUrnsK``) and an
    indexed root variable (``rootK``) so the multiple MATCH clauses
    don't collide. Empty input sets are skipped (defensive — the
    compiler never emits empty hoists in practice).

    Returns ``('', {})`` when the provider has no configured
    containment edge types (the caller continues without scope
    verification and logs a warning, mirroring
    ``_build_scope_continuation``).
    """
    if not urn_sets:
        return "", {}
    try:
        ctypes = list(provider._get_containment_edge_types())
    except Exception:
        logger.warning(
            "deep_search: containment edge types not configured; "
            "scope.root_urns and hoisted descendantOf will be ignored",
        )
        return "", {}
    if not ctypes:
        return "", {}
    rel = "|".join(_sanitize_label(t) for t in ctypes)
    fragments: List[str] = []
    params: Dict[str, Any] = {}
    depth = int(max_depth)
    for i, urns in enumerate(urn_sets):
        if not urns:
            continue
        param_name = f"_scopeRootUrns{i}"
        root_var = f"root{i}"
        params[param_name] = list(urns)
        fragments.append(
            f"MATCH ({root_var})-[:{rel}*0..{depth}]->(n) "
            f"WHERE {root_var}.urn IN ${param_name} "
            f"WITH DISTINCT n"
        )
    return " ".join(fragments), params


def _collect_scope_urn_sets(query, compiler) -> List[List[str]]:
    """Collect the URN sets that should each become a scope-clamp
    continuation, in display order.

    ``view`` mode contributes ``scope.root_urns`` (the view's
    authorised top-level containers) plus every hoisted DescendantOf
    set. ``visible`` and ``data_source`` modes contribute only the
    hoisted sets — view-root enforcement is suppressed in those modes
    (visible uses the URN-equality clause in the WHERE; data_source is
    by definition the whole graph).

    Empty sets are dropped — an empty hoisted set would be a compiler
    bug, and ``scope.root_urns`` of ``None`` is the no-clamp case.
    """
    sets: List[List[str]] = []
    if query.scope.scope_mode == "view" and query.scope.root_urns:
        sets.append(list(query.scope.root_urns))
    for s in compiler.hoisted_root_urns:
        if s:
            sets.append(list(s))
    return sets


def _build_scope_pre_filter(
    provider,
    effective_root_urns: List[str],
    max_depth: int,
) -> Tuple[str, Dict[str, Any]]:
    """Anchor-form scope MATCH for small root sets (W1.1b).

    When ``len(effective_root_urns)`` is small enough that the
    indexed root-URN lookup beats a label scan over the entire graph,
    we replace the candidate-scan prefix entirely:

        post-filter:  MATCH (n) WHERE ...predicate... WITH n LIMIT 5000
                      MATCH (root)-[:ctypes*]->(n) WHERE root.urn IN $...

        pre-filter:   MATCH (root)-[:ctypes*0..D]->(n)
                      WHERE root.urn IN $_rootUrns
                      WITH DISTINCT n
                      WHERE ...predicate...
                      WITH n LIMIT 5000

    On a 100M-node graph with a 5-root subtree of 1000 nodes, the
    pre-filter shape touches 1000 candidates instead of 100M. Caller
    decides which shape to use based on
    ``settings.scope_pre_filter_threshold``.

    Returns ('', {}) when containment edge types aren't configured —
    caller falls back to the post-filter shape.

    ``*0..D`` (not ``*1..D``) so that a root URN can itself be the hit.
    """
    try:
        ctypes = list(provider._get_containment_edge_types())
    except Exception:
        return "", {}
    if not ctypes:
        return "", {}
    rel = "|".join(_sanitize_label(t) for t in ctypes)
    fragment = (
        f"MATCH (root)-[:{rel}*0..{int(max_depth)}]->(n) "
        f"WHERE root.urn IN $_rootUrns "
        f"WITH DISTINCT n"
    )
    return fragment, {"_rootUrns": list(effective_root_urns)}


def _build_within_hops_continuation(
    hoisted: List[Dict[str, Any]],
    next_param_id: int,
) -> Tuple[str, Dict[str, Any], int]:
    """Compile each hoisted WithinHopsPredicate to a MATCH continuation.

    Each WithinHops becomes one MATCH that anchors the variable-length
    pattern at the predicate's URN set and binds back to ``n``. Multiple
    occurrences AND together (each anchor must reach n within its hop
    budget). An empty edge-type set short-circuits — no node can be
    within N hops of anything, so the executor will surface zero rows.

    Scope intersection is intentionally NOT enforced on anchors here:
    anchors can legitimately sit outside the view's scope (an upstream
    source three subtrees away), and the candidate ``n`` is already
    scope-clamped by the existing ``_build_scope_continuation``.

    Returns (cypher_fragment, params, next_param_id).
    """
    if not hoisted:
        return "", {}, next_param_id

    parts: List[str] = []
    params: Dict[str, Any] = {}
    pid = next_param_id

    for idx, entry in enumerate(hoisted):
        edge_types = entry["edge_types"]
        if not edge_types:
            # No edges of this class exist → no node reaches anything.
            # Force a no-match by binding n to nothing.
            return (
                "WITH n WHERE false WITH n",
                params, pid,
            )
        rel = "|".join(_sanitize_label(t) for t in edge_types)
        hops = int(entry["hops"])
        direction = entry["direction"]
        urns_param = f"_whUrns{pid}"
        pid += 1
        params[urns_param] = list(entry["urns"])
        edge_where = entry.get("edge_where") or ""
        # Bind the variable-length path so we can apply per-edge filters.
        # Each occurrence gets its own path alias to avoid clashes when
        # multiple WithinHops predicates AND together.
        path_alias = f"_whP{idx}"
        if direction == "out":
            arrow = f"-[:{rel}*1..{hops}]->"
        elif direction == "in":
            arrow = f"<-[:{rel}*1..{hops}]-"
        else:  # both — undirected; planner walks either side
            arrow = f"-[:{rel}*1..{hops}]-"
        pat = f"MATCH {path_alias} = (anchor){arrow}(n)"
        where_extra = (
            f" AND ALL(rel IN relationships({path_alias}) WHERE {edge_where})"
            if edge_where else ""
        )
        parts.append(
            f"{pat} WHERE anchor.urn IN ${urns_param}{where_extra} "
            "WITH DISTINCT n"
        )

    return " ".join(parts), params, pid


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
# Explain — compile-only path. Returns the exact Cypher + params that
# `execute_deep_search` would run, without touching FalkorDB. Powers the
# `/search/explain` endpoint and the dev panel's "Show Cypher" button.
# ---------------------------------------------------------------------------

def explain_deep_search(provider, query: SearchQuery) -> Dict[str, Any]:
    """Return the compiled Cypher + bound parameters without executing.

    Mirrors `execute_deep_search`'s pipeline up to the point of
    sending the candidate query to FalkorDB. Returns:

        {
          "cypher": str,        # full candidate cypher (ends WITH n)
          "hits_cypher": str,   # candidate cypher + " RETURN n"
          "params": dict,       # bound parameters that would be sent
          "candidate_cap": int, # the hard cap on candidate rows
          "hoisted_root_urns": list[list[str]],  # scope hoisted from
                                                 # top-level DescendantOf
          "effective_root_urns": list[str] | None,
          "notes": list[str],   # human-readable diagnostic hints
        }

    Aggregation queries get the same prefix; their per-spec
    continuation isn't materialised here (would be ~one extra line
    per AggregationSpec — left to caller's understanding).
    """
    _s = get_deep_search_settings()
    effective_candidate_cap = _resolve_candidate_cap(query, _s)
    notes: List[str] = []
    compiler = _build_compiler_for_provider(provider)
    where_fragment = compiler.compile(query.predicate)
    base_params: Dict[str, Any] = dict(compiler.params)

    # Collect the URN sets to apply as scope continuations. Each set
    # becomes its own MATCH clause in the chain — Cypher AND's them
    # naturally so nested anchors (scope.root_urns ∋ a hoisted
    # descendantOf URN) compose without the URN-set intersection that
    # used to collapse to ∅. ``_effective_root_urns`` is still computed
    # for the diagnostic field but no longer drives Cypher emission.
    eff_root_urns = _effective_root_urns(compiler, query.scope.root_urns)
    scope_urn_sets = _collect_scope_urn_sets(query, compiler)
    eff_union: Optional[List[str]] = None
    if scope_urn_sets:
        union: set = set()
        for s in scope_urn_sets:
            union.update(s)
        eff_union = sorted(union)

    # Scope mode resolution.
    #
    # ``visible``      → narrow the candidate scan to the URN set the FE
    #                    just rendered. ``MATCH (n) WHERE n.urn IN $vis``
    #                    is index-backed by the URN unique constraint and
    #                    is the fastest possible scope. Hoisted
    #                    descendantOf URNs still chain after.
    # ``data_source``  → no view-root clamp; hoisted descendantOf URNs
    #                    still apply (the user's explicit anchor).
    # ``view`` (else)  → today's behaviour: containment expansion from
    #                    the view's authorised roots PLUS any hoisted
    #                    descendantOf anchors, chained via WITH DISTINCT n.
    scope_mode = query.scope.scope_mode
    visible_urns = list(query.scope.visible_urns or [])
    where_fragment, visible_clause_added = _maybe_add_visible_urns_clause(
        where_fragment, scope_mode, visible_urns, base_params,
    )

    scope_chain = ""
    if scope_mode == "data_source":
        if query.scope.root_urns:
            notes.append(
                "scope_mode='data_source' — searching the entire data "
                "source; the view's authorised root URNs are not "
                "enforced. Results may include nodes that are not in "
                "this view."
            )
    elif scope_mode == "visible" and not visible_clause_added:
        notes.append(
            "scope_mode='visible' but scope.visible_urns is empty — "
            "no candidate filter applied. Falling back to "
            "view-scope semantics."
        )

    if scope_urn_sets:
        scope_chain, scope_params = _build_scope_continuation_chain(
            provider, scope_urn_sets, query.scope.max_depth or 12,
        )
        base_params.update(scope_params)
        if not scope_chain:
            notes.append(
                "scope.root_urns / descendantOf were supplied but the "
                "provider has no containment edge types configured — "
                "the scope check was dropped. All matching predicates "
                "pass without ancestry verification."
            )

    effective_types, et_note = _resolve_entity_types_scope(
        provider, list(query.scope.entity_types or []),
    )
    use_entity_types = effective_types is not None
    if use_entity_types:
        # Lowercased to pair with the case-insensitive ``toLower(l)``
        # check in the candidate WHERE — see ``_build_candidate_cypher``.
        base_params["_scopeEntityTypes"] = [t.lower() for t in effective_types]
    if et_note:
        notes.append(et_note)

    wh_continuation, wh_params, _ = _build_within_hops_continuation(
        compiler.hoisted_within_hops, compiler._param_counter,
    )
    base_params.update(wh_params)
    if compiler.hoisted_within_hops and not wh_continuation:
        notes.append(
            "withinHops predicates were hoisted but produced no Cypher — "
            "check that edgeClass / edgeTypes resolve to a non-empty set."
        )

    # Scope-first shape: anchor the candidate scan on the scope subtree so
    # the candidate cap applies to IN-SCOPE nodes. Feeding the chain as
    # ``scope_continuation`` (post-filter) would cap the graph-wide set first
    # and silently drop in-scope matches for broad predicates.
    cand_cypher = _build_candidate_cypher(
        where_fragment=where_fragment,
        entity_types_param=use_entity_types,
        scope_pre_filter=scope_chain,
        candidate_cap=effective_candidate_cap,
        within_hops_continuation=wh_continuation,
    )

    if query.options.results == "aggregates" and not query.options.aggregations:
        notes.append(
            "results='aggregates' but no aggregations supplied — the "
            "response will be empty buckets. Add at least one "
            "AggregationSpec to options.aggregations."
        )

    return {
        "cypher": cand_cypher,
        "hits_cypher": cand_cypher + " RETURN n",
        "params": base_params,
        "candidate_cap": effective_candidate_cap,
        "hoisted_root_urns": [list(s) for s in compiler.hoisted_root_urns],
        # Flattened union of every URN set that became a scope MATCH —
        # diagnostic-only ("the URNs being enforced"). The legacy
        # ``_effective_root_urns`` (intersection of literals) is
        # preserved for tests that exercise the helper directly, but
        # no longer drives Cypher emission. ``eff_union`` reflects the
        # chain semantics: union of all sets, sorted.
        "effective_root_urns": eff_union if eff_union is not None else eff_root_urns,
        "effective_root_urn_sets": [list(s) for s in scope_urn_sets],
        "notes": notes,
    }


# ---------------------------------------------------------------------------
# Discover — sample native property keys per entity-type label. Powers the
# `/search/discover` endpoint and the dev panel's "Discover properties"
# button. Answers the question "what can I actually query?" — the most
# common cause of property predicates returning 0 results is the user
# guessing a property name that doesn't exist on natively-stored nodes
# (or doesn't exist at all in the data).
# ---------------------------------------------------------------------------

# Reserved keys are the provider-owned top-level fields. The discover
# scan strips them from the per-label key list so the response only
# contains user-supplied property names. Kept in sync with
# `falkordb_provider._RESERVED_NODE_KEYS`.
_DISCOVER_RESERVED_KEYS = frozenset({
    "urn", "entityType", "displayName", "qualifiedName", "description",
    "tags", "layerAssignment", "childCount", "sourceSystem", "lastSyncedAt",
    "level", "levelDigest",
    "properties",      # legacy blob
    "propertiesRaw",   # native escape hatch
})


# Discovery caps (per-key value samples, value keys per label, tag-value
# cap, edge-sample cap) live in ``DeepSearchSettings``. The PEP 562
# ``__getattr__`` above exposes the old constant names for back-compat
# with test imports; internal call sites read settings directly.


async def discover_native_property_keys(
    provider,
    *,
    sample_per_label: int = 200,
    max_labels: int = 100,
    timeout_s: float = 5.0,
    include_value_samples: bool = True,
    include_tag_values: bool = True,
    include_edges: bool = True,
) -> Dict[str, Any]:
    """Sample nodes per label and surface what's actually queryable.

    Returns the schema-discovery payload that drives the FE's
    property/value/tag/edge pickers:

        {
          "labels": {
            "dataset": {
              "keys": ["logicalType","rowCount",...],
              "sampled": 200,
              "valueSamplesByKey": {
                "logicalType": ["STRING","BIGINT","DOUBLE"],
                "layerAssignment": ["silver","gold"],
                ...
              }
            },
            ...
          },
          "blobOnlyLabels": ["domain", ...],
          "missingContainment": bool,
          "tagValues": {"PII": 482, "GDPR": 39, "deprecated": 12, ...},
          "edges": {
            "TRANSFORMS":  {"keys": ["confidence","discoveredBy"], "sampled": 1240,
                            "valueSamplesByKey": {"discoveredBy": ["manual","auto"]}},
            ...
          },
          "elapsedMs": int,
        }

    ``valueSamplesByKey``, ``tagValues``, and ``edges`` are added for the
    UI's autocomplete pickers. They can be skipped via the
    ``include_*`` flags when only the legacy key list is needed.
    """
    _s = get_deep_search_settings()
    t0 = time.monotonic()
    out_labels: Dict[str, Dict[str, Any]] = {}
    blob_only: List[str] = []
    # Top-level tag-value accumulator across every label. Tags in v1
    # remain JSON-stringified arrays on ``n.tags`` (see W1 deferral);
    # we parse them in Python here rather than relying on FalkorDB's
    # JSON-string handling at query time.
    tag_value_counts: Dict[str, int] = {}

    # Step 1: list labels (FalkorDB supports CALL db.labels())
    try:
        lbl_result = await provider._ro_query(
            "CALL db.labels() YIELD label RETURN label",
            params={}, timeout=timeout_s,
        )
        labels = [row[0] for row in (lbl_result.result_set or [])
                  if row and row[0]]
    except Exception as exc:
        logger.warning("discover: CALL db.labels() failed: %s", exc)
        labels = []
    labels = labels[:max_labels]

    # Step 2: per label, sample nodes + extract native keys + values
    for label in labels:
        safe = _sanitize_label(label)
        try:
            # Fetch the sampled nodes themselves so we can mine both
            # property keys AND distinct values per key in one pass.
            # The extra payload is bounded by ``sample_per_label`` and
            # FalkorDB streams it; for a 200-node sample with ~10
            # properties each this is ~50 KB on the wire.
            res = await provider._ro_query(
                f"MATCH (n:`{safe}`) WITH n LIMIT $lim RETURN n",
                params={"lim": int(sample_per_label)},
                timeout=timeout_s,
            )
            rows = res.result_set or []
            sampled_count = len(rows)
        except Exception as exc:
            logger.warning(
                "discover: label=%s sample failed: %s", label, exc,
            )
            continue

        # Track each key's frequency across the sample so we can keep
        # the most common keys when a label exceeds the per-label cap.
        # Pathological schemas (1000+ properties on one label) would
        # otherwise blow up the response payload.
        key_counts: Counter = Counter()
        value_samples: Dict[str, list] = {}
        # Track seen values per key as a set when hashable; lists when
        # not. We never let a per-key sample grow past the cap.
        seen_values_per_key: Dict[str, set] = {}

        for row in rows:
            node = row[0] if row else None
            props = getattr(node, "properties", None) or {}
            for k, v in props.items():
                if k in _DISCOVER_RESERVED_KEYS and k != "tags":
                    # Reserved keys are stripped from the user-facing
                    # key list — except ``tags`` which we still mine
                    # for distinct values via the top-level tagValues
                    # block.
                    if k == "tags" and include_tag_values:
                        _accumulate_tag_values(v, tag_value_counts)
                    continue
                key_counts[k] += 1
                if not include_value_samples:
                    continue
                if v is None:
                    continue
                if len(value_samples) >= _s.discover_value_keys_per_label \
                   and k not in value_samples:
                    # Already at the per-label value-key cap.
                    continue
                try:
                    sample = seen_values_per_key.setdefault(k, set())
                    if len(sample) >= _s.discover_value_samples_per_key:
                        continue
                    sample.add(v)
                    value_samples.setdefault(k, []).append(v)
                except TypeError:
                    # Non-hashable (list / dict) — skip rather than
                    # silently de-duplicating wrongly.
                    continue

        # Frequency-based cap: keep the top N keys by occurrence.
        # ``truncatedProperties`` tells the FE there were rarer keys
        # the sample didn't surface — encourages a tighter sample
        # (filter by a known key) to drill into them.
        total_keys = len(key_counts)
        top_keys = {
            k for k, _ in key_counts.most_common(
                _s.discover_value_keys_per_label,
            )
        }
        truncated_properties = total_keys > len(top_keys)

        out_labels[label] = {
            "keys": sorted(top_keys),
            "sampled": sampled_count,
            "truncatedProperties": truncated_properties,
        }
        if include_value_samples and value_samples:
            # Stable ordering + filter to top keys only (value_samples
            # may have entries for keys not in top_keys when the
            # 64-key cap was hit before frequency was known).
            out_labels[label]["valueSamplesByKey"] = {
                k: sorted(value_samples[k], key=lambda x: (str(type(x)), str(x)))
                for k in sorted(value_samples.keys() & top_keys)
            }
        if sampled_count > 0 and not top_keys:
            blob_only.append(label)

    missing_containment = False
    try:
        provider._get_containment_edge_types()
    except Exception:
        missing_containment = True

    edges_payload: Dict[str, Dict[str, Any]] = {}
    if include_edges:
        edges_payload = await _discover_edge_metadata(provider, timeout_s=timeout_s)

    tag_values_payload: Dict[str, int] = {}
    if include_tag_values:
        # Cap the surfaced list at the top N; trim by descending count
        # so the UI shows the most-used tags first.
        ordered = sorted(
            tag_value_counts.items(), key=lambda kv: (-kv[1], kv[0]),
        )[:_s.discover_tag_values_cap]
        tag_values_payload = dict(ordered)

    return {
        "labels": out_labels,
        "blobOnlyLabels": sorted(blob_only),
        "missingContainment": missing_containment,
        "tagValues": tag_values_payload,
        "edges": edges_payload,
        "elapsedMs": int((time.monotonic() - t0) * 1000),
    }


def _accumulate_tag_values(raw: Any, into: Dict[str, int]) -> None:
    """Parse a JSON-stringified ``n.tags`` field and accumulate counts.

    Tolerates: a plain string (single tag), a JSON array of strings, or
    an actual Python list (in case storage already normalised). Anything
    else is silently skipped.
    """
    if raw is None:
        return
    if isinstance(raw, list):
        for item in raw:
            if isinstance(item, str) and item:
                into[item] = into.get(item, 0) + 1
        return
    if isinstance(raw, str):
        stripped = raw.strip()
        if not stripped:
            return
        if stripped.startswith("["):
            try:
                parsed = json.loads(stripped)
            except json.JSONDecodeError:
                return
            if isinstance(parsed, list):
                for item in parsed:
                    if isinstance(item, str) and item:
                        into[item] = into.get(item, 0) + 1
            return
        # Single tag stored as plain string.
        into[stripped] = into.get(stripped, 0) + 1


async def _discover_edge_metadata(
    provider, *, timeout_s: float = 5.0,
) -> Dict[str, Dict[str, Any]]:
    """Sample edges, return per-edge-type property keys + value samples.

    Returns ``{edgeType: {keys, sampled, valueSamplesByKey}}`` for every
    edge type seen in the sample. Used by the FE's edge-predicate
    editor (W2) and by the property-value picker when the user
    composes a path query against a specific edge type.
    """
    _s = get_deep_search_settings()
    try:
        res = await provider._ro_query(
            "MATCH ()-[r]->() WITH r LIMIT $lim RETURN type(r) AS edgeType, r",
            params={"lim": _s.discover_edge_sample_cap},
            timeout=timeout_s,
        )
    except Exception as exc:
        logger.warning("discover: edge sampling failed: %s", exc)
        return {}

    rows = res.result_set or []
    per_type: Dict[str, Dict[str, Any]] = {}
    for row in rows:
        if not row or len(row) < 2:
            continue
        edge_type = row[0]
        rel = row[1]
        if not edge_type:
            continue
        entry = per_type.setdefault(edge_type, {
            "keys_set": set(),
            "sampled": 0,
            "value_samples": {},
            "seen_per_key": {},
        })
        entry["sampled"] += 1
        props = getattr(rel, "properties", None) or {}
        for k, v in props.items():
            entry["keys_set"].add(k)
            if v is None:
                continue
            try:
                seen = entry["seen_per_key"].setdefault(k, set())
                if len(seen) >= _s.discover_value_samples_per_key:
                    continue
                seen.add(v)
                entry["value_samples"].setdefault(k, []).append(v)
            except TypeError:
                continue

    # Render to the public shape.
    out: Dict[str, Dict[str, Any]] = {}
    for edge_type, entry in per_type.items():
        keys = sorted(entry["keys_set"])
        out[edge_type] = {
            "keys": keys,
            "sampled": entry["sampled"],
        }
        if entry["value_samples"]:
            out[edge_type]["valueSamplesByKey"] = {
                k: sorted(entry["value_samples"][k], key=lambda x: (str(type(x)), str(x)))
                for k in sorted(entry["value_samples"].keys())
            }
    return out


# ---------------------------------------------------------------------------
# Main entry — wires everything together
# ---------------------------------------------------------------------------

def _build_path_cypher(
    *,
    direction: str,
    max_hops: int,
    edge_where: str = "",
) -> str:
    """Cypher for a PathPredicate query.

    Direction-aware. Filters edge types via ``WHERE type(rel) IN $...``
    rather than relationship-pattern alternation, so FalkorDB doesn't
    hit the "Unable to resolve filtered alias" error.

    When ``edge_where`` is non-empty, an additional per-edge predicate
    (compiled from ``PathPredicate.edge_predicate``) is AND-joined into
    the ``ALL(rel IN relationships(p) WHERE …)`` block so paths whose
    edges fail the filter are excluded server-side.
    """
    if direction == "incoming":
        pattern = f"(s)<-[*1..{max_hops}]-(t)"
    elif direction == "any":
        pattern = f"(s)-[*1..{max_hops}]-(t)"
    else:
        # default outgoing
        pattern = f"(s)-[*1..{max_hops}]->(t)"

    edge_filter = "type(rel) IN $_pathEdgeTypes"
    if edge_where:
        edge_filter = f"{edge_filter} AND ({edge_where})"

    # Each path: list of {urn, displayName, entityType} for nodes;
    # list of {sourceUrn, targetUrn, edgeType, properties} for edges.
    return (
        f"MATCH p = {pattern} "
        "WHERE s.urn IN $_pathSrc AND t.urn IN $_pathTgt "
        f"AND ALL(rel IN relationships(p) WHERE {edge_filter}) "
        "WITH p, nodes(p) AS ns, relationships(p) AS rs "
        "LIMIT $_pathMaxPaths "
        "RETURN [n IN ns | { "
        "  urn: n.urn, "
        "  displayName: n.displayName, "
        "  entityType: labels(n)[0] "
        "}] AS nodes, "
        "[rel IN rs | { "
        "  sourceUrn: startNode(rel).urn, "
        "  targetUrn: endNode(rel).urn, "
        "  edgeType: type(rel), "
        "  properties: properties(rel) "
        "}] AS edges, "
        "length(p) AS hopCount"
    )


async def _run_path_query(
    provider, hoisted: Dict[str, Any], *, timeout_s: float,
) -> Tuple[List[PathHit], bool]:
    """Execute the hoisted PathPredicate. Returns (paths, truncated)."""
    edge_types = hoisted.get("edge_types") or []
    if not edge_types:
        # No lineage / containment edge types resolved → no paths can
        # match. Return empty cleanly rather than emit a Cypher with
        # an empty IN clause.
        return [], False

    cypher = _build_path_cypher(
        direction=hoisted["direction"],
        max_hops=hoisted["max_hops"],
        edge_where=hoisted.get("edge_where") or "",
    )
    params = {
        "_pathSrc": hoisted["source_urns"],
        "_pathTgt": hoisted["target_urns"],
        "_pathEdgeTypes": edge_types,
        "_pathMaxPaths": hoisted["max_paths"],
    }
    result = await provider._ro_query(cypher, params=params, timeout=timeout_s)
    rows = result.result_set or []

    paths: List[PathHit] = []
    for row in rows:
        # Row shape: [nodes_list, edges_list, hop_count]
        node_dicts = row[0] or []
        edge_dicts = row[1] or []
        hop_count = int(row[2]) if row[2] is not None else 0
        node_refs = [
            AncestorRef(
                urn=str(n.get("urn", "")),
                display_name=str(n.get("displayName", "")),
                entity_type=str(n.get("entityType", "")),
            )
            for n in node_dicts if isinstance(n, dict)
        ]
        edge_refs = [
            EdgeRef(
                source_urn=str(e.get("sourceUrn", "")),
                target_urn=str(e.get("targetUrn", "")),
                edge_type=str(e.get("edgeType", "")),
                properties=e.get("properties") or {},
            )
            for e in edge_dicts if isinstance(e, dict)
        ]
        paths.append(PathHit(
            nodes=node_refs,
            edges=edge_refs,
            hop_count=hop_count,
        ))

    truncated = len(paths) >= hoisted["max_paths"]
    return paths, truncated


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
    _s = get_deep_search_settings()
    effective_candidate_cap = _resolve_candidate_cap(query, _s)
    start = time.monotonic()
    timeout_s = (deadline_ms or query.options.soft_deadline_ms) / 1000.0

    # 1. Compile predicate → Cypher WHERE fragment + scope/withinHops hoisting
    compiler = _build_compiler_for_provider(provider)
    where_fragment = compiler.compile(query.predicate)
    base_params: Dict[str, Any] = dict(compiler.params)

    # 1a. Path-mode short-circuit. When a PathPredicate is present, the
    # standard candidate scan is bypassed entirely — we run a single
    # path-matching query and return the result as `paths`. Other
    # predicates on the path-mode query are unsupported in v1
    # (the path-predicate compiler raises CompileError if non-AND-top).
    if compiler.hoisted_path is not None:
        try:
            paths, truncated = await _run_path_query(
                provider, compiler.hoisted_path, timeout_s=timeout_s,
            )
            return SearchResultPage(
                paths=paths,
                truncated=truncated,
                candidate_count=len(paths),
                deadline_exceeded=False,
                elapsed_ms=int((time.monotonic() - start) * 1000),
                cache_hit=False,
            )
        except asyncio.TimeoutError:
            return SearchResultPage(
                paths=[],
                truncated=True,
                candidate_count=0,
                deadline_exceeded=True,
                elapsed_ms=int((time.monotonic() - start) * 1000),
                cache_hit=False,
            )

    # 2. Effective scope — collect the URN sets each becoming its own
    #    scope-clamp MATCH (see explain_deep_search for the rationale).
    scope_urn_sets = _collect_scope_urn_sets(query, compiler)

    # 3. Scope mode resolution (mirrors explain_deep_search).
    scope_mode = query.scope.scope_mode
    visible_urns_list = list(query.scope.visible_urns or [])
    where_fragment, _visible_clause_added = _maybe_add_visible_urns_clause(
        where_fragment, scope_mode, visible_urns_list, base_params,
    )
    scope_chain = ""
    if scope_urn_sets:
        scope_chain, scope_params = _build_scope_continuation_chain(
            provider, scope_urn_sets, query.scope.max_depth or 12,
        )
        base_params.update(scope_params)

    # 4. WithinHops continuation (each anchor → reachable-within-N-hops set)
    wh_continuation, wh_params, _ = _build_within_hops_continuation(
        compiler.hoisted_within_hops, compiler._param_counter,
    )
    base_params.update(wh_params)

    # 5. Build the candidate prefix
    effective_types, et_note = _resolve_entity_types_scope(
        provider, list(query.scope.entity_types or []),
    )
    use_entity_types = effective_types is not None
    if use_entity_types:
        # Lowercased to pair with the case-insensitive ``toLower(l)``
        # check in the candidate WHERE — see ``_build_candidate_cypher``.
        base_params["_scopeEntityTypes"] = [t.lower() for t in effective_types]
    if et_note:
        # execute_deep_search has no diagnostic-notes channel
        # (explain_deep_search does — see the parallel branch). Log at
        # WARNING so operators can spot stale view-scope configs in
        # production and so /search/explain can be re-issued to surface
        # the same note to the UI.
        logger.warning("deep_search: %s", et_note)
    # Scope-first shape: anchor the candidate scan on the scope subtree so the
    # candidate cap applies to IN-SCOPE nodes (see explain_deep_search + the
    # _build_candidate_cypher docstring). Post-filter would drop in-scope
    # matches for broad predicates by capping the graph-wide set first.
    cand_cypher = _build_candidate_cypher(
        where_fragment=where_fragment,
        entity_types_param=use_entity_types,
        scope_pre_filter=scope_chain,
        candidate_cap=effective_candidate_cap,
        within_hops_continuation=wh_continuation,
    )

    # 5. Execute according to requested result shape
    aggregates: Optional[List[List[SearchAggregateBucket]]] = None
    hits: Optional[List[SearchHit]] = None
    candidate_count = 0
    truncated = False
    deadline_exceeded = False
    # Hits-pagination accounting — only populated by the hits branch
    # below. Defaulted here so the SearchResultPage cursor expression
    # stays safe on aggregates-only / timeout paths.
    hits_offset_after = 0
    hits_total_sorted = 0

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
                provider, cand_cypher, base_params,
                timeout_s=timeout_s,
                candidate_cap=effective_candidate_cap,
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
            truncated = candidate_count >= effective_candidate_cap
            hits, hits_offset_after, hits_total_sorted = _build_hits_from_rows(
                provider, rows, query,
            )
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

    # Emit a next-cursor whenever the page didn't exhaust the sorted
    # candidate set. The cursor embeds ``query_hash(query)`` so a future
    # iteration can reject cursors issued against a different query
    # (not enforced this turn — codec carries the hash for the follow-up).
    next_cursor: Optional[str] = None
    if hits_offset_after < hits_total_sorted:
        next_cursor = encode_cursor(
            {"offset": hits_offset_after, "q": query_hash(query)}
        )

    return SearchResultPage(
        aggregates=aggregates,
        hits=hits,
        cursor=next_cursor,
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
    provider, cand_cypher: str, params: Dict[str, Any], *,
    timeout_s: float, candidate_cap: Optional[int] = None,
) -> Tuple[int, bool]:
    result = await provider._ro_query(
        cand_cypher + " RETURN count(n) AS c",
        params=params, timeout=timeout_s,
    )
    rs = result.result_set or []
    n = int(rs[0][0]) if rs and rs[0] else 0
    cap = candidate_cap if candidate_cap is not None \
        else get_deep_search_settings().candidate_cap
    return n, (n >= cap)


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
    if spec.by == "property":
        return await _run_aggregation_property(
            provider, cand_cypher, cand_params, spec,
            timeout_s=timeout_s,
        )
    if spec.by == "layer":
        return await _run_aggregation_layer(
            provider, cand_cypher, cand_params, spec,
            timeout_s=timeout_s,
        )
    if spec.by == "parent":
        return await _run_aggregation_parent(
            provider, cand_cypher, cand_params, spec,
            query=query, timeout_s=timeout_s,
        )
    if spec.by == "ancestorLevel":
        return await _run_aggregation_ancestor_level(
            provider, cand_cypher, cand_params, spec,
            query=query, timeout_s=timeout_s,
        )
    raise CompileError(
        f"aggregation by={spec.by!r} is not yet supported in v1. "
        "Use 'ancestorType', 'entityType', 'property', 'layer', "
        "'parent', or 'ancestorLevel'. ('tag' deferred until tags are a "
        "native array field.)"
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


async def _run_aggregation_property(
    provider, cand_cypher, cand_params, spec, *, timeout_s,
):
    """Group the candidate set by the value of a single native property.

    Powers questions like "show me the distribution of `n.layer` values"
    or "count nodes by `n.dataType`" — turns any indexed property into
    a histogram with one Cypher round-trip. Nodes that don't have the
    property at all are filtered out before the GROUP BY (otherwise
    they'd collapse into a single "null" bucket that's rarely useful;
    callers who want that case can combine with a `hasProperty:negate`
    predicate).
    """
    if not spec.property_key:
        raise CompileError(
            "aggregation by='property' requires propertyKey"
        )
    key = _safe_property_name(spec.property_key)
    k = max(0, int(spec.sample_hits_per_bucket))
    agg_cypher = (
        cand_cypher + " "
        f"WHERE EXISTS(n.{key}) "
        f"WITH n.{key} AS pkey, n "
        f"WITH pkey, count(DISTINCT n) AS mc, "
        f"collect(DISTINCT n)[..{k}] AS samples "
        f"RETURN '' AS urn, toString(pkey) AS name, "
        f"'{key}' AS etype, mc, samples "
        f"ORDER BY mc DESC LIMIT {int(spec.max_buckets)}"
    )
    result = await provider._ro_query(
        agg_cypher, params=cand_params, timeout=timeout_s,
    )
    return _rows_to_buckets(provider, result.result_set or [])


async def _run_aggregation_layer(
    provider, cand_cypher, cand_params, spec, *, timeout_s,
):
    """Group the candidate set by ``n.layerAssignment``.

    Reserved top-level field — never lived in the property blob — so
    every node has it set (or null for unassigned). Nodes without an
    assignment are excluded, mirroring the property-aggregation
    behaviour. Powers the Map UX's "matches by layer" pivot.
    """
    k = max(0, int(spec.sample_hits_per_bucket))
    agg_cypher = (
        cand_cypher + " "
        "WHERE n.layerAssignment IS NOT NULL "
        "WITH n.layerAssignment AS layer, n "
        "WITH layer, count(DISTINCT n) AS mc, "
        f"collect(DISTINCT n)[..{k}] AS samples "
        "RETURN '' AS urn, toString(layer) AS name, "
        "'layer' AS etype, mc, samples "
        f"ORDER BY mc DESC LIMIT {int(spec.max_buckets)}"
    )
    result = await provider._ro_query(
        agg_cypher, params=cand_params, timeout=timeout_s,
    )
    return _rows_to_buckets(provider, result.result_set or [])


async def _run_aggregation_parent(
    provider, cand_cypher, cand_params, spec, *, query, timeout_s,
):
    """Group the candidate set by direct containment parent (one hop).

    Useful for the second drill in the Map UX ("inside this domain,
    which containers hold the most matches?"). Empty containment-edge-
    type set short-circuits to no buckets (consistent with
    ancestorType).
    """
    try:
        ctypes = list(provider._get_containment_edge_types())
    except Exception:
        ctypes = []
    if not ctypes:
        logger.warning(
            "deep_search: parent aggregation requested but containment "
            "edge types are not configured; returning empty buckets",
        )
        return []
    rel = "|".join(_sanitize_label(t) for t in ctypes)
    k = max(0, int(spec.sample_hits_per_bucket))

    agg_cypher = (
        cand_cypher + " "
        f"MATCH (parent)-[:{rel}]->(n) "
        "WITH parent, count(DISTINCT n) AS mc, "
        f"collect(DISTINCT n)[..{k}] AS samples "
        "RETURN parent.urn AS urn, parent.displayName AS name, "
        "labels(parent)[0] AS etype, mc, samples "
        f"ORDER BY mc DESC LIMIT {int(spec.max_buckets)}"
    )
    result = await provider._ro_query(
        agg_cypher, params=cand_params, timeout=timeout_s,
    )
    return _rows_to_buckets(provider, result.result_set or [])


async def _run_aggregation_ancestor_level(
    provider, cand_cypher, cand_params, spec, *, query, timeout_s,
):
    """Group by the ancestor at hierarchy depth ``ancestorLevel`` from
    the candidate (0 = the candidate itself, 1 = direct parent, …).

    Lets a caller ask "what does the level-2 ancestor of each match
    look like?" without specifying ancestor entity types — useful when
    the hierarchy is heterogeneous (e.g. one branch is
    domain→container→table, another is platform→cluster→schema).

    Empty containment-edge-type set short-circuits.
    """
    if spec.ancestor_level is None:
        raise CompileError(
            "aggregation by='ancestorLevel' requires ancestorLevel"
        )
    level = int(spec.ancestor_level)
    if level < 0 or level > 20:
        raise CompileError(
            "aggregation by='ancestorLevel' requires 0 ≤ ancestorLevel ≤ 20"
        )
    try:
        ctypes = list(provider._get_containment_edge_types())
    except Exception:
        ctypes = []
    if not ctypes and level > 0:
        logger.warning(
            "deep_search: ancestorLevel aggregation requested but "
            "containment edge types are not configured; returning empty",
        )
        return []
    k = max(0, int(spec.sample_hits_per_bucket))

    if level == 0:
        # Trivial pivot: the candidate is its own "ancestor at level 0".
        agg_cypher = (
            cand_cypher + " "
            "WITH n AS anc, n "
            "WITH anc, count(DISTINCT n) AS mc, "
            f"collect(DISTINCT n)[..{k}] AS samples "
            "RETURN anc.urn AS urn, anc.displayName AS name, "
            "labels(anc)[0] AS etype, mc, samples "
            f"ORDER BY mc DESC LIMIT {int(spec.max_buckets)}"
        )
    else:
        rel = "|".join(_sanitize_label(t) for t in ctypes)
        # Fixed-length variable-length pattern pins the depth exactly.
        # FalkorDB supports the syntax [:REL*N..N].
        agg_cypher = (
            cand_cypher + " "
            f"MATCH (anc)-[:{rel}*{level}..{level}]->(n) "
            "WITH anc, count(DISTINCT n) AS mc, "
            f"collect(DISTINCT n)[..{k}] AS samples "
            "RETURN anc.urn AS urn, anc.displayName AS name, "
            "labels(anc)[0] AS etype, mc, samples "
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


def _build_hits_from_rows(
    provider, rows, query: SearchQuery,
) -> Tuple[List[SearchHit], int, int]:
    """Convert candidate rows to SearchHits, applying sort + cursor-paged
    slicing in-memory.

    Returns ``(hits, offset_after, total_sorted)`` where:
      * ``hits`` — the page's SearchHits (sliced ``[offset : offset+page_size]``)
      * ``offset_after`` — the next-cursor offset (offset + len(hits))
      * ``total_sorted`` — the size of the full sorted candidate set,
        so the caller can decide whether there are more pages to emit
        a next-cursor.

    The candidate Cypher deliberately doesn't ORDER BY — sorting in
    Cypher forces a materialisation barrier that thwarts the candidate
    cap. We sort the already-bounded result here.

    Sort precedence:
      1. `options.sort_property` (an arbitrary native node property
         like 'rowCount' or 'createdAt') wins if set — powers
         "biggest first" / "newest first" UX.
      2. `options.sort` ('displayName' / 'qualifiedName' / 'relevance'
         falls back to displayName until fulltext lands).
      'depth' is deferred — currently silently coerces to displayName.
    """
    hits: List[SearchHit] = []
    for row in rows:
        node = provider._extract_node_from_result(row)
        if node:
            hits.append(SearchHit(node=node))

    sort_dir = query.options.sort_dir
    reverse = (sort_dir == "desc")

    if query.options.sort_property:
        # Reach into node.properties; missing → sort as if value were ""
        # so absent rows clump consistently at one end.
        prop = query.options.sort_property

        def prop_key(h: SearchHit):
            v = (h.node.properties or {}).get(prop)
            # Sort numerics naturally; coerce everything else through str
            if isinstance(v, (int, float, bool)):
                return (0, v)
            return (1, str(v).lower() if v is not None else "")

        hits.sort(key=prop_key, reverse=reverse)
    else:
        sort_field = query.options.sort
        if sort_field in ("displayName", "qualifiedName"):
            def key(h: SearchHit):
                v = (getattr(h.node, "display_name" if sort_field == "displayName"
                             else "qualified_name") or "")
                return v.lower()
            hits.sort(key=key, reverse=reverse)
        elif sort_field == "relevance":
            # No relevance signal in v1 (no fulltext). Fall back to displayName.
            hits.sort(
                key=lambda h: (h.node.display_name or "").lower(),
                reverse=reverse,
            )

    total_sorted = len(hits)
    offset = 0
    if query.options.cursor:
        state = decode_cursor(query.options.cursor)
        offset = max(0, int(state.get("offset", 0)))
    page = hits[offset : offset + query.options.page_size]
    return page, offset + len(page), total_sorted


async def _hydrate_ancestors(provider, hits: List[SearchHit]) -> None:
    """Populate ``hit.ancestor_path`` for each hit using the provider's
    Redis-backed ancestor cache.

    W1.1c — batched hydration. Two changes vs. the original per-hit
    pattern:

      * The N ``_get_ancestor_chain(urn)`` calls run concurrently via
        ``asyncio.gather`` so the worst case is ``max(latency)``
        instead of ``sum(latency)``. The cache layer is per-URN so
        true Redis pipelining would need a provider extension; for
        v1 the cheap concurrency dominates the cost.
      * The N ``get_node(anc_urn)`` summary lookups collapse to ONE
        ``get_nodes_batch(unique_ancestor_urns)`` Cypher round-trip.
        On a 10K-hit / 1K-unique-ancestor result this drops 1000
        DB calls to 1.
    """
    if not hits:
        return

    async def _safe_chain(h: SearchHit) -> Tuple[str, List[str]]:
        try:
            chain = await provider._get_ancestor_chain(h.node.urn)
        except Exception:
            chain = []
        return h.node.urn, chain

    # 1. Parallel-fetch every hit's ancestor chain.
    chain_results = await asyncio.gather(
        *(_safe_chain(h) for h in hits), return_exceptions=False,
    )
    chains: Dict[str, List[str]] = dict(chain_results)
    needed_urns: set = set()
    for urns in chains.values():
        needed_urns.update(urns)

    # 2. Single batched node fetch for every unique ancestor URN —
    # collapses what was N round-trips into one.
    summaries: Dict[str, Tuple[str, str]] = {}
    if needed_urns:
        try:
            nodes = await provider.get_nodes_batch(list(needed_urns))
            for anc in nodes:
                if anc and anc.urn:
                    summaries[anc.urn] = (anc.display_name, anc.entity_type)
        except Exception:
            # If batch fetch fails, leave ancestor_path empty rather
            # than fall back to N single-fetches — the page still
            # returns hits, just without the ancestor decoration.
            logger.warning(
                "deep_search: batched ancestor hydration failed; "
                "ancestor_path will be empty on this page",
            )

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
