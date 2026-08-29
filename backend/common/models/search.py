"""
Advanced search contract — request, response, and predicate tree for the
``deep_search`` provider method and the ``POST /search/advanced`` endpoint.

This is the single shape every search consumer agrees on:
- the frontend's QuickSearchBar / AdvancedSearchPanel serialise into it,
- the AdvancedSearchService validates and normalises it,
- the provider's ``deep_search`` consumes it,
- AI agents drive iterative discovery against it (POST it directly).

Design notes
------------
* **Aggregation is first-class.** The default response shape is
  ``aggregates`` (roll-ups by ancestor), not ``hits``. This is the
  "orient before drill" UX — a user searching for ``tag=PII`` sees per-
  domain match counts before any leaf node. The provider's aggregation
  query is one extra MATCH + GROUP-BY on the bounded candidate set, so
  pure aggregation is the cheapest response mode.
* **Predicate tree, not flat filter list.** Composable AND/OR/NOT with
  per-leaf type discrimination on ``kind`` (Pydantic v2 discriminated
  union). The flat ``PropertyFilter`` shape on the old ``NodeQuery``
  couldn't express ``(name CONTAINS X OR tag=Y) AND prop=Z``; this can.
* **Recursive types** (``GroupPredicate.children``,
  ``AggregationSpec.sub_aggregation``, ``SearchAggregateBucket.sub_buckets``)
  are bounded — group nesting is capped by service-side validation, and
  ``sub_aggregation`` is intentionally one-level (deeper drill = re-issue
  the request scoped to the bucket, which is also exactly the AI-agent
  facet-discovery pattern).
* **Hard caps on tree shape** (depth ≤ 6, leaf count ≤ 64, OR-branch ≤ 24,
  text length ≤ 512) are enforced at the *service* layer, not in the
  model — the service produces meaningful path-into-tree error messages
  the model can't.
"""
from typing import Annotated, Any, Dict, List, Literal, Optional, Union

from pydantic import BaseModel, Field, model_validator

from .graph import GraphNode


# ---------------------------------------------------------------------------
# Base — matches the codebase's existing v1-style alias config (see
# graph.py). The Pydantic v2 deprecation warnings are tolerated for
# consistency; migrating the entire models tree to ConfigDict is out of
# scope for this change.
# ---------------------------------------------------------------------------

class _Base(BaseModel):
    class Config:
        populate_by_name = True


# ---------------------------------------------------------------------------
# Leaf predicates
# ---------------------------------------------------------------------------

TextMatchMode = Literal["exact", "prefix", "suffix", "substring", "fulltext", "regex"]
"""Match modes for text predicates.

* ``exact``       — equality, case-insensitive by default
* ``prefix``      — ``STARTS WITH``; can hit a B-tree index
* ``suffix``      — ``ENDS WITH``; full scan, no index help
* ``substring``   — ``CONTAINS``; falls back to label-scoped scan
* ``fulltext``    — relevance-ranked, requires the per-label fulltext index
* ``regex``       — opt-in; gated by ``ADVANCED_SEARCH_REGEX_ENABLED`` and
                    validated against catastrophic-backtrack patterns
"""

TextTarget = Literal[
    "name", "qualifiedName", "description", "tags", "property", "any"
]
"""Which field a text predicate scans.

``any`` triggers the cross-property ``n.searchableTextLower CONTAINS …``
path (the only mode that touches the denormalised blob); every other
target hits a specific real node field.
"""


class TextPredicate(_Base):
    """Free-form text match against a single field (or ``any``)."""
    kind: Literal["text"] = "text"
    value: str = Field(min_length=1, max_length=512)
    target: TextTarget = "any"
    property_key: Optional[str] = Field(
        None, alias="propertyKey", max_length=128,
        description="Required when ``target='property'``; ignored otherwise.",
    )
    match: TextMatchMode = "substring"
    case_sensitive: bool = Field(False, alias="caseSensitive")
    boost: float = Field(1.0, ge=0.0, le=10.0,
                         description="Relevance multiplier when match='fulltext'.")


PropertyOp = Literal[
    "eq", "neq", "gt", "gte", "lt", "lte",
    "in", "notIn", "contains", "startsWith", "endsWith", "between",
]

EdgeClass = Literal["lineage", "containment", "any"]
"""Edge-class selector shared by DegreePredicate, WithinHopsPredicate,
PathPredicate. Resolved to a concrete edge-type list at compile time
via the active ontology — never hardcoded relationship names."""


class PropertyPredicate(_Base):
    """Typed comparison against a single user-property.

    After the storage refactor, user properties are native FalkorDB
    fields, so these compile to ``WHERE n.<key> <op> $val`` — no Python
    post-filter. ``eq``/``neq`` case-fold (``toLower(toString(n.<key>))
    <op> toLower($val)``) when ``value`` is a string and
    ``case_sensitive`` is false; a non-string value (or
    ``case_sensitive=True``) keeps the raw, indexed column comparison.
    ``between`` expects ``value`` to be a two-element list ``[lo, hi]``.
    """
    kind: Literal["property"] = "property"
    key: str = Field(min_length=1, max_length=128)
    op: PropertyOp = "eq"
    value: Any = None
    case_sensitive: bool = Field(False, alias="caseSensitive")


class TagPredicate(_Base):
    """Match against the (currently JSON-stringified) ``n.tags`` field.

    Tags remain stringified in this workstream — see the storage-refactor
    commit. Server-side this maps to ``n.tags CONTAINS $tag`` per value,
    composed by ``op``.
    """
    kind: Literal["tag"] = "tag"
    op: Literal["has", "hasAll", "hasAny", "notHas"] = "has"
    values: List[str] = Field(min_length=1, max_length=32)


class HasPropertyPredicate(_Base):
    """"Does this node have a property named X" — key presence only.

    Compiles to ``EXISTS(n.<key>)`` (or ``NOT EXISTS`` when ``negate``).
    Native-property storage makes this cheap; pre-refactor this required
    parsing the blob in Python for every node.
    """
    kind: Literal["hasProperty"] = "hasProperty"
    key: str = Field(min_length=1, max_length=128)
    negate: bool = False


class DescendantOfPredicate(_Base):
    """Clamp matches to the subtree(s) rooted at ``urns``.

    Lives as a predicate (not on ``SearchScope``) so it can sit inside
    OR groups — e.g. ``(under Customers OR under Orders) AND tag=PII``.
    The single-subtree case is also expressible via ``scope.root_urns``,
    which the provider may push down as a tighter Cypher anchor.
    """
    kind: Literal["descendantOf"] = "descendantOf"
    urns: List[str] = Field(min_length=1, max_length=64)
    max_depth: Optional[int] = Field(None, alias="maxDepth", ge=1, le=20)


class EdgePropertyPredicate(_Base):
    """Typed comparison against a single edge property.

    Evaluated against each traversed relationship inside a
    ``PathPredicate`` or ``WithinHopsPredicate``. Compiles to
    ``rel.<key> <op> $val`` inside an ``ALL(rel IN relationships(p) …)``
    block. ``between`` expects ``value`` to be a two-element list
    ``[lo, hi]``.
    """
    kind: Literal["edgeProperty"] = "edgeProperty"
    key: str = Field(min_length=1, max_length=128)
    op: PropertyOp = "eq"
    value: Any = None


class EdgeHasPropertyPredicate(_Base):
    """Key-presence predicate against an edge. Compiles to
    ``EXISTS(rel.<key>)`` (or ``NOT EXISTS`` when ``negate``)."""
    kind: Literal["edgeHasProperty"] = "edgeHasProperty"
    key: str = Field(min_length=1, max_length=128)
    negate: bool = False


class EdgeGroupPredicate(_Base):
    """Boolean composition of edge predicates.

    Same shape as ``GroupPredicate`` but scoped to a traversed edge.
    Service-layer validator enforces depth / leaf caps mirroring the
    node-predicate tree.
    """
    kind: Literal["edgeGroup"] = "edgeGroup"
    op: Literal["and", "or", "not"] = "and"
    children: List["EdgePredicateType"] = Field(min_length=1, max_length=32)


EdgePredicateType = Annotated[
    Union[
        EdgePropertyPredicate,
        EdgeHasPropertyPredicate,
        EdgeGroupPredicate,
    ],
    Field(discriminator="kind"),
]

EdgeGroupPredicate.model_rebuild()


class WithinHopsPredicate(_Base):
    """Match nodes within N relationship hops of any anchor URN.

    Powers lineage-aware questions ("any column 2 hops downstream of
    ``orders.id``"). ``edge_types`` restricts the traversal to specific
    relationship types; omitted means all. ``direction='out'`` walks
    out-edges only, ``'in'`` walks in-edges, ``'both'`` is undirected.
    """
    kind: Literal["withinHops"] = "withinHops"
    urns: List[str] = Field(min_length=1, max_length=64)
    hops: int = Field(ge=1, le=10)
    edge_types: Optional[List[str]] = Field(None, alias="edgeTypes")
    direction: Literal["out", "in", "both"] = "both"
    edge_class: EdgeClass = Field(
        "lineage", alias="edgeClass",
        description="Default edge-class when ``edge_types`` is omitted. "
                    "Mirrors DegreePredicate / PathPredicate.",
    )
    edge_predicate: Optional[EdgePredicateType] = Field(
        None, alias="edgePredicate",
        description="Optional predicate evaluated against every traversed "
                    "edge. ANDs with ``edge_types`` / ``edge_class``. "
                    "Compiles to ``ALL(rel IN relationships(p) WHERE …)``.",
    )


class EntityTypePredicate(_Base):
    """Restrict matches to (or away from) specific entity types.

    Equivalent expressivity to ``scope.entity_types``, but composable
    inside OR groups.
    """
    kind: Literal["entityType"] = "entityType"
    op: Literal["in", "notIn"] = "in"
    values: List[str] = Field(min_length=1, max_length=32)


class LayerPredicate(_Base):
    """Match the view's layer assignment (Source / Staging / Refinery / …)."""
    kind: Literal["layer"] = "layer"
    layer_assignment: str = Field(alias="layerAssignment", min_length=1)


# ---------------------------------------------------------------------------
# Graph-shape predicates (degree + sugar)
# ---------------------------------------------------------------------------

DegreeOp = Literal["eq", "neq", "gt", "gte", "lt", "lte"]
DegreeDirection = Literal["in", "out", "both"]
# EdgeClass declared at the top of the module so PropertyOp-adjacent
# predicates (WithinHopsPredicate's edge_class field) can reference it.


class DegreePredicate(_Base):
    """Match nodes by their edge degree.

    Powers structural questions like "find datasets with zero incoming
    lineage edges" (UC-1 orphan finder), "find tables with > 5 children",
    or "find views that produce >= 1 downstream artifact".

    The edge type set is resolved from the live ontology at compile time
    via the provider's ``_get_lineage_edge_types`` /
    ``_get_containment_edge_types`` helpers, so no hardcoded names ever
    leak into Cypher. ``edge_types`` lets a caller pin a specific subset
    (e.g. ``['PRODUCES']`` only); when omitted, the ``edge_class`` chooses
    the default set.
    """
    kind: Literal["degree"] = "degree"
    direction: DegreeDirection = "both"
    op: DegreeOp = "eq"
    value: int = Field(ge=0, le=1_000_000)
    edge_class: EdgeClass = Field("lineage", alias="edgeClass")
    edge_types: Optional[List[str]] = Field(
        None, alias="edgeTypes", min_length=1, max_length=32,
        description=(
            "Optional explicit edge-type list. When provided, overrides "
            "the default set resolved from ``edge_class``."
        ),
    )


class IsOrphanPredicate(_Base):
    """Sugar: nodes with zero edges of the given class. Normalises to
    ``DegreePredicate(direction='both', op='eq', value=0)``."""
    kind: Literal["isOrphan"] = "isOrphan"
    edge_class: EdgeClass = Field("lineage", alias="edgeClass")
    edge_types: Optional[List[str]] = Field(
        None, alias="edgeTypes", min_length=1, max_length=32,
    )


class IsLeafPredicate(_Base):
    """Sugar: nodes with zero outgoing edges of the given class
    ("dead ends"). Normalises to
    ``DegreePredicate(direction='out', op='eq', value=0)``."""
    kind: Literal["isLeaf"] = "isLeaf"
    edge_class: EdgeClass = Field("lineage", alias="edgeClass")
    edge_types: Optional[List[str]] = Field(
        None, alias="edgeTypes", min_length=1, max_length=32,
    )


class IsRootPredicate(_Base):
    """Sugar: nodes with zero incoming edges of the given class
    ("nobody produces this"). Normalises to
    ``DegreePredicate(direction='in', op='eq', value=0)``."""
    kind: Literal["isRoot"] = "isRoot"
    edge_class: EdgeClass = Field("lineage", alias="edgeClass")
    edge_types: Optional[List[str]] = Field(
        None, alias="edgeTypes", min_length=1, max_length=32,
    )


class HasIncomingPredicate(_Base):
    """Sugar: nodes with at least one incoming edge of the given class.
    Normalises to ``DegreePredicate(direction='in', op='gt', value=0)``."""
    kind: Literal["hasIncoming"] = "hasIncoming"
    edge_class: EdgeClass = Field("lineage", alias="edgeClass")
    edge_types: Optional[List[str]] = Field(
        None, alias="edgeTypes", min_length=1, max_length=32,
    )


class HasOutgoingPredicate(_Base):
    """Sugar: nodes with at least one outgoing edge of the given class.
    Normalises to ``DegreePredicate(direction='out', op='gt', value=0)``."""
    kind: Literal["hasOutgoing"] = "hasOutgoing"
    edge_class: EdgeClass = Field("lineage", alias="edgeClass")
    edge_types: Optional[List[str]] = Field(
        None, alias="edgeTypes", min_length=1, max_length=32,
    )


# ---------------------------------------------------------------------------
# Path predicate — UC3 (paths between specific nodes)
# ---------------------------------------------------------------------------

PathDirection = Literal["outgoing", "incoming", "any"]


class PathPredicate(_Base):
    """Find paths between source and target nodes.

    Top-level AND only — the compiler raises CompileError if it
    appears inside an OR or NOT group. When present, ``options.results``
    must be ``'paths'``; the response carries ordered node→edge→node
    sequences instead of (or in addition to) flat hits / aggregates.

    Powers UC3: "find all paths from dataset:orders to dataset:reporting
    going through ≤4 lineage hops".
    """
    kind: Literal["path"] = "path"
    source_urns: List[str] = Field(
        alias="sourceUrns", min_length=1, max_length=8,
        description="Starting nodes. The provider runs a variable-length "
                    "match outward (or inward) from each.",
    )
    target_urns: List[str] = Field(
        alias="targetUrns", min_length=1, max_length=8,
        description="Endpoint nodes. Paths terminate here.",
    )
    direction: PathDirection = Field(
        "outgoing",
        description="``outgoing`` walks source → target along edge "
                    "direction; ``incoming`` walks against direction; "
                    "``any`` is undirected.",
    )
    edge_class: EdgeClass = Field("lineage", alias="edgeClass")
    edge_types: Optional[List[str]] = Field(
        None, alias="edgeTypes", min_length=1, max_length=32,
        description="Optional explicit edge-type list; overrides "
                    "``edge_class``'s resolved set.",
    )
    max_hops: int = Field(
        4, alias="maxHops", ge=1, le=6,
        description="Maximum path length in edge hops.",
    )
    max_paths: int = Field(
        32, alias="maxPaths", ge=1, le=128,
        description="Hard cap on the number of paths returned.",
    )
    edge_predicate: Optional[EdgePredicateType] = Field(
        None, alias="edgePredicate",
        description="Optional predicate evaluated against every edge in the "
                    "returned paths. ANDs with ``edge_types`` / "
                    "``edge_class``. Compiles to "
                    "``ALL(rel IN relationships(p) WHERE …)``.",
    )


# ---------------------------------------------------------------------------
# Recursive group + discriminated union
# ---------------------------------------------------------------------------

class GroupPredicate(_Base):
    """Boolean composition of child predicates.

    ``op='not'`` must have exactly one child — the service-layer validator
    enforces that (the model accepts ≥1 to keep the schema simple). The
    same validator enforces ``max_depth ≤ 6`` and ``leaf_count ≤ 64``.
    """
    kind: Literal["group"] = "group"
    op: Literal["and", "or", "not"] = "and"
    # Model-level ceiling is generous — the service validator applies the
    # tighter, op-aware caps (OR ≤ 24 children, overall ≤ 64 leaves) and
    # produces a meaningful path-into-tree error.
    children: List["Predicate"] = Field(min_length=1, max_length=128)


Predicate = Annotated[
    Union[
        TextPredicate,
        PropertyPredicate,
        TagPredicate,
        HasPropertyPredicate,
        DescendantOfPredicate,
        WithinHopsPredicate,
        EntityTypePredicate,
        LayerPredicate,
        DegreePredicate,
        IsOrphanPredicate,
        IsLeafPredicate,
        IsRootPredicate,
        HasIncomingPredicate,
        HasOutgoingPredicate,
        PathPredicate,
        GroupPredicate,
    ],
    Field(discriminator="kind"),
]

GroupPredicate.model_rebuild()


# ---------------------------------------------------------------------------
# Aggregations — first-class roll-up by ancestor
# ---------------------------------------------------------------------------

AggregationKind = Literal[
    "ancestorType",   # group by the closest ancestor whose type ∈ ancestor_entity_types
    "ancestorLevel",  # group by the ancestor at a given hierarchy depth from scope root
    "ancestor",       # credit EVERY containment ancestor of every match, uncapped
    "parent",         # group by direct parent (containment edge)
    "tag",            # group by tag value
    "entityType",     # group by the hit's own entity type
    "property",       # group by the value of a single arbitrary node property
]


class AggregationSpec(_Base):
    """Roll matches up to ancestors (or facets) for orient-before-drill UX.

    Pure-aggregate responses skip the result-row ordering + ancestor-
    hydration steps and are accordingly the cheapest mode the provider
    can run. One level of ``sub_aggregation`` is permitted; deeper
    drilling is meant to be done by re-issuing a scoped request — that
    iteration is also the AI-agent facet-discovery pattern.
    """
    by: AggregationKind = "ancestorType"
    ancestor_entity_types: Optional[List[str]] = Field(
        None, alias="ancestorEntityTypes", max_length=16,
        description="Required when by='ancestorType'.",
    )
    ancestor_level: Optional[int] = Field(
        None, alias="ancestorLevel", ge=0, le=20,
        description="Required when by='ancestorLevel'.",
    )
    property_key: Optional[str] = Field(
        None, alias="propertyKey", min_length=1, max_length=128,
        description="Required when by='property'. The native node "
                    "property whose values become the bucket keys "
                    "(e.g. 'layer' → one bucket per layer value).",
    )
    max_buckets: int = Field(
        50, alias="maxBuckets", ge=1, le=20000,
        description="Bucket ceiling. The headroom above a facet-sized "
                    "list is for by='ancestor', which needs one bucket "
                    "per container the canvas can collapse.",
    )
    sample_hits_per_bucket: int = Field(
        3, alias="sampleHitsPerBucket", ge=0, le=20,
        description="Tiny preview list shown next to each bucket — for the UI's "
                    "hover-card and the AI-agent's at-a-glance context.",
    )
    sub_aggregation: Optional["AggregationSpec"] = Field(
        None, alias="subAggregation",
        description="One-level nested drill. Deeper levels require a "
                    "follow-up scoped search (see module docstring).",
    )


AggregationSpec.model_rebuild()


# ---------------------------------------------------------------------------
# Scope + options + the full request
# ---------------------------------------------------------------------------

ResultShape = Literal["aggregates", "hits", "both", "paths"]


ScopeMode = Literal["visible", "view", "data_source"]


class SearchScope(_Base):
    """Bounds the search.

    ``view_id`` is **required** — every search must be bound to a view
    (for security + telemetry), but the *scope* of the search is now
    controlled by ``scope_mode``:

      * ``visible`` (default UI mode): only the URNs the user can
        actually see right now on the canvas (passed in
        ``visible_urns``). This is the "fast feedback" mode that
        matches the user's mental model of "search what's in front of
        me." Falls back to ``view`` mode when ``visible_urns`` is
        empty.

      * ``view``: classic behaviour — the view's authorised roots,
        expanded via containment, then narrowed by client hints.

      * ``data_source``: power-user override. Searches the entire data
        source (no view containment clamp). Results may include URNs
        that are not in this view; the FE surfaces a disclaimer.

    ``root_urns`` / ``entity_types`` / ``layer_assignment`` / ``max_depth``
    are **narrowing hints** that always apply (regardless of mode).
    The resolver intersects them with the view's authorised scope.
    """
    view_id: str = Field(
        alias="viewId", min_length=1,
        description=(
            "Required. The view the search is bound to (security context "
            "+ telemetry). Scope behaviour depends on ``scope_mode``."
        ),
    )
    scope_mode: ScopeMode = Field(
        "view", alias="scopeMode",
        description=(
            "visible: filter to URNs in scope.visible_urns (fast in-view "
            "search). view: view's authorised roots + containment "
            "expansion (default for server-direct callers). data_source: "
            "entire data source — power-user override."
        ),
    )
    visible_urns: Optional[List[str]] = Field(
        None, alias="visibleUrns", max_length=20000,
        description=(
            "URNs currently rendered in the canvas. Required when "
            "scope_mode='visible'. Ignored in other modes. Capped at "
            "DEEP_SEARCH_VISIBLE_URNS_CAP entries (default 20000)."
        ),
    )
    root_urns: Optional[List[str]] = Field(
        None, alias="rootUrns",
        description=(
            "Optional narrowing hint. Each URN must be a descendant of "
            "(or equal to) one of the view's allowed roots; URNs that "
            "fail validation are dropped server-side. Capped at "
            "DEEP_SEARCH_SCOPE_ROOT_URNS_CAP entries (default 256). The "
            "cap exists to bound the Cypher IN-list size + containment "
            "expansion fanout on multi-domain views with many top-level "
            "containers."
        ),
    )
    max_depth: Optional[int] = Field(
        12, alias="maxDepth", ge=1, le=20,
        description="Clamped to min(client, view.maxDepth) by the resolver.",
    )
    entity_types: Optional[List[str]] = Field(
        None, alias="entityTypes", max_length=32,
        description=(
            "Optional. Must be ⊆ view's visibleEntityTypes; out-of-set "
            "values cause the request to be rejected with 400."
        ),
    )
    layer_assignment: Optional[str] = Field(None, alias="layerAssignment")

    @model_validator(mode="after")
    def _enforce_root_urns_cap(self) -> "SearchScope":
        """Enforce ``DeepSearchSettings.scope_root_urns_cap`` at the
        model layer so the cap is env-tunable (the static
        ``Field(max_length=...)`` constraint can't read settings at
        class-definition time).

        Lazy-import the settings to avoid the circular dependency
        between ``common.models`` and ``app.services``.
        """
        if self.root_urns is None or not self.root_urns:
            return self
        from backend.app.services.deep_search.settings import (
            get_deep_search_settings,
        )
        cap = get_deep_search_settings().scope_root_urns_cap
        if len(self.root_urns) > cap:
            raise ValueError(
                f"scope.rootUrns has {len(self.root_urns)} entries, "
                f"exceeding the cap of {cap}. Either narrow the view "
                f"to fewer top-level containers, raise "
                f"DEEP_SEARCH_SCOPE_ROOT_URNS_CAP, or use "
                f"scope_mode='data_source' to bypass the per-root "
                f"containment expansion."
            )
        return self


SortKey = Literal[
    "relevance",     # fulltext score; falls back to displayName otherwise
    "displayName",
    "qualifiedName",
    "depth",         # ancestor depth from scope root
    "matchCount",    # for aggregate buckets
]


class SearchOptions(_Base):
    """Per-request shape / pagination / deadline controls.

    Defaults are tuned for the UI's Map-mode-first experience:
    ``results='aggregates'`` returns just buckets, ``page_size=50`` is
    used only when hits are requested, and a 3-second soft deadline
    keeps the UI responsive (partial results returned on timeout).
    """
    results: ResultShape = "aggregates"
    aggregations: Optional[List[AggregationSpec]] = Field(
        None,
        description="Parallel facets — each spec produces its own bucket "
                    "list in the response. Omit for hits-only requests.",
    )
    page_size: int = Field(
        50, alias="pageSize", ge=1, le=5000,
        description=(
            "Number of hits returned per page. Default 50 (sane for "
            "browsing); the panel sets it to the candidate cap (5000) "
            "when it wants the full match set in one round-trip so "
            "canvas highlighting can cover every match without "
            "paginating. Bounded at 5000 (matches CANDIDATE_CAP) — "
            "larger pages require cursor pagination."
        ),
    )
    cursor: Optional[str] = Field(
        None,
        description=(
            "Opaque pagination cursor. When set, hits start from the "
            "cursor's recorded offset within the candidate set. The "
            "response echoes a new cursor when more rows are available "
            "(``hits.length == pageSize`` AND the slice didn't exhaust "
            "the candidate set)."
        ),
    )
    sort: SortKey = "relevance"
    sort_property: Optional[str] = Field(
        None, alias="sortProperty", min_length=1, max_length=128,
        description="When set, hits are ordered by this native node "
                    "property (e.g. 'rowCount') instead of by `sort`. "
                    "Useful for 'biggest first' / 'newest first' UX.",
    )
    sort_dir: Literal["asc", "desc"] = Field("desc", alias="sortDir")
    include_ancestor_path: bool = Field(False, alias="includeAncestorPath")
    highlights: bool = True
    soft_deadline_ms: int = Field(
        30000, alias="softDeadlineMs", ge=200, le=120000,
        description="Provider returns partial rows + deadline_exceeded=true "
                    "on expiry. Service does not cache deadline-exceeded "
                    "responses. Default 30s (was 3s) so deep queries on "
                    "large graphs complete; user can override per-request "
                    "up to 120s.",
    )
    candidate_cap: Optional[int] = Field(
        None, alias="candidateCap", ge=100, le=100000,
        description=(
            "Per-request override of the candidate-scan ceiling. ``None`` "
            "uses the deployment default from ``DEEP_SEARCH_CANDIDATE_CAP`` "
            "(default 10000). Requests can raise this up to "
            "``DEEP_SEARCH_CANDIDATE_CAP_MAX`` (default 100000) when the "
            "user explicitly opts into a larger scan. The service "
            "validator rejects values above the deployment max."
        ),
    )


SCHEMA_VERSION = "1"
"""Current SearchQuery wire-format version.

Bumped on breaking changes only. Server accepts the current version and
(eventually) one previous; older requests are rejected with a clear
error pointing at the migration notes. The npm-published
``@synodic/search-schema`` package carries the same version string.
"""


class SearchQuery(_Base):
    """The request body for POST /search/advanced.

    ``scope`` is required — every search must be bound to a view via
    ``scope.view_id``. There is no global / cross-view default.

    ``schema_version`` carries the wire-format version. Clients omit it
    on outgoing requests (the default fills it in); the server echoes it
    on every response so clients can fail loud on a mismatch.
    """
    schema_version: Literal["1"] = Field(
        default=SCHEMA_VERSION, alias="$schemaVersion",
    )
    predicate: Predicate
    scope: SearchScope
    options: SearchOptions = Field(default_factory=SearchOptions)


# ---------------------------------------------------------------------------
# Response shapes
# ---------------------------------------------------------------------------

class SearchHighlight(_Base):
    """Where in a hit's text the match landed, for ``<mark>`` rendering."""
    field: str
    snippet: str
    score: float = 0.0


class AncestorRef(_Base):
    """Compact ancestor identifier — enough for the FE to render a
    breadcrumb without re-fetching the node."""
    urn: str
    display_name: str = Field(alias="displayName")
    entity_type: str = Field(alias="entityType")


class SearchHit(_Base):
    """One matched node, optionally with provenance.

    ``matched_predicates`` is the list of leaf-predicate indices (0-indexed
    DFS over the request's predicate tree) that this node satisfied —
    enables the FE to show "matched on: name, logicalType" badges.
    """
    node: GraphNode
    score: float = 0.0
    matched_predicates: List[int] = Field(
        default_factory=list, alias="matchedPredicates",
    )
    highlights: List[SearchHighlight] = Field(default_factory=list)
    ancestor_path: Optional[List[AncestorRef]] = Field(
        None, alias="ancestorPath",
        description="Root → parent (excluding the hit itself). Populated "
                    "when options.include_ancestor_path is true.",
    )


class EdgeRef(_Base):
    """One edge in a returned path. Carries enough for the FE to render
    a directed arrow between two nodes plus expose edge properties on
    hover. We don't return a full GraphEdge to keep the path response
    compact — the provider knows about the relationship type and
    endpoints, which is what callers actually render."""
    source_urn: str = Field(alias="sourceUrn")
    target_urn: str = Field(alias="targetUrn")
    edge_type: str = Field(alias="edgeType")
    properties: Dict[str, Any] = Field(default_factory=dict)


class PathHit(_Base):
    """One returned path: an ordered alternating sequence of nodes and
    edges, with the hop count for sorting / display.

    Constraint: ``len(nodes) == len(edges) + 1`` always. The first
    node is one of the ``source_urns`` and the last is one of the
    ``target_urns`` (after direction normalisation).
    """
    nodes: List[AncestorRef] = Field(
        description="Ordered list — first is source endpoint, last is "
                    "target endpoint.",
    )
    edges: List[EdgeRef]
    hop_count: int = Field(alias="hopCount")


class SearchAggregateBucket(_Base):
    """One ancestor (or facet) with N matches inside it."""
    ancestor_urn: str = Field(alias="ancestorUrn")
    ancestor_display_name: str = Field(alias="ancestorDisplayName")
    ancestor_entity_type: str = Field(alias="ancestorEntityType")
    ancestor_depth_from_scope_root: int = Field(alias="ancestorDepthFromScopeRoot")
    match_count: int = Field(alias="matchCount")
    type_counts: Optional[Dict[str, int]] = Field(
        None, alias="typeCounts",
        description="Per-entity-type breakdown of ``match_count`` — e.g. "
                    "``{'Column': 12, 'Table': 3}``. Populated by "
                    "by='ancestor'; None for the kinds that don't "
                    "compute one.",
    )
    sample_hits: List[SearchHit] = Field(
        default_factory=list, alias="sampleHits",
    )
    sub_buckets: Optional[List["SearchAggregateBucket"]] = Field(
        None, alias="subBuckets",
        description="Populated when the request's AggregationSpec carried "
                    "a sub_aggregation.",
    )


SearchAggregateBucket.model_rebuild()


class QueryExplain(_Base):
    """Compiled-query metadata. Returned by POST /search/explain (dry-run)
    and optionally inlined on the main search response when the caller
    asked for it. Useful for support + the FE's 'show generated query'
    toggle in the Advanced panel."""
    cypher: str
    estimated_rows: Optional[int] = Field(None, alias="estimatedRows")
    cost_score: float = Field(0.0, alias="costScore", ge=0.0, le=1.0)
    notes: List[str] = Field(
        default_factory=list,
        description="Diagnostic hints — e.g. 'no index on properties.foo'.",
    )


class ScopeDiagnostics(_Base):
    """Resolved-scope information returned on every search response.

    Surfaces the values the server actually applied — both the
    ``ViewScopeResolver``'s output and the ontology-resolved edge type
    sets. Lets the FE explain zero-result responses ("your view scope
    resolved to no roots", "your ontology has no lineage edges")
    without the user having to read the compiled Cypher.

    None of the fields here change query semantics; this is pure
    instrumentation. The cost is one extra dict per response.
    """
    effective_root_urns: List[str] = Field(
        default_factory=list, alias="effectiveRootUrns",
        description="Root URNs the scope continuation actually anchored "
                    "on. Empty list means no scope clamp was applied — "
                    "search ran across the whole data source.",
    )
    effective_max_depth: int = Field(alias="effectiveMaxDepth")
    effective_entity_types: Optional[List[str]] = Field(
        None, alias="effectiveEntityTypes",
        description="Entity-type allow-list applied by the view. None "
                    "means no constraint from the view.",
    )
    dropped_root_urns: List[str] = Field(
        default_factory=list, alias="droppedRootUrns",
        description="Client-supplied URNs that were filtered out as "
                    "out-of-view. Mirrors the X-Search-Dropped-URNs "
                    "header for client convenience.",
    )
    lineage_edge_types: List[str] = Field(
        default_factory=list, alias="lineageEdgeTypes",
        description="Edge types the active ontology flags as is_lineage. "
                    "Empty list means lineage-aware predicates "
                    "(IsOrphan, HasIncoming, withinHops with edgeClass="
                    "'lineage', etc.) will match zero nodes by design — "
                    "configure at least one edge type as is_lineage in "
                    "the data source's ontology.",
    )
    containment_edge_types: List[str] = Field(
        default_factory=list, alias="containmentEdgeTypes",
        description="Edge types the active ontology flags as containment. "
                    "Empty list means the graph is flat (no hierarchy) "
                    "and ancestor-aware features (aggregation by="
                    "'ancestorType', DescendantOf scope hoisting) won't "
                    "produce useful results.",
    )
    notes: List[str] = Field(
        default_factory=list,
        description="Human-readable diagnostic notes — e.g. 'view has "
                    "no rootUrns configured; search ran unclamped'.",
    )


class SearchResultPage(_Base):
    """Provider + service response. One inner list in ``aggregates`` per
    requested AggregationSpec."""
    aggregates: Optional[List[List[SearchAggregateBucket]]] = None
    hits: Optional[List[SearchHit]] = None
    paths: Optional[List[PathHit]] = Field(
        None,
        description="Populated when the request's predicate contains a "
                    "PathPredicate and options.results='paths'. Ordered "
                    "node→edge→node sequences from source to target.",
    )
    cursor: Optional[str] = None
    truncated: bool = Field(
        False,
        description="True when the provider hit its candidate cap or "
                    "soft deadline before exhausting the candidate set.",
    )
    candidate_count: int = Field(
        0, alias="candidateCount",
        description="Candidates that passed the predicate scan before the "
                    "scope check and aggregation/limit. Useful for showing "
                    "'searching X nodes…' captions in the FE.",
    )
    total_count: Optional[int] = Field(
        None, alias="totalCount",
        description="Exact number of matches in scope, independent of the "
                    "candidate cap; null when the count timed out (UI "
                    "shows N+).",
    )
    deadline_exceeded: bool = Field(False, alias="deadlineExceeded")
    elapsed_ms: int = Field(alias="elapsedMs")
    cache_hit: bool = Field(False, alias="cacheHit")
    query_explain: Optional[QueryExplain] = Field(None, alias="queryExplain")
    scope_diagnostics: Optional[ScopeDiagnostics] = Field(
        None, alias="scopeDiagnostics",
        description="Resolved-scope + ontology diagnostics. Surfaced on "
                    "every response so the FE can interpret 0-result "
                    "cases without round-tripping to /search/explain.",
    )


# ---------------------------------------------------------------------------
# API contract bundle — single root for FE codegen
# ---------------------------------------------------------------------------

class SearchExplainResult(_Base):
    """Response shape for ``POST /search/explain``.

    Mirrors what ``backend.app.providers.falkordb_deep_search.explain_deep_search``
    returns, plus the ``resolvedScope`` block added by the service layer.
    Used by the FE's "Show Cypher" surface and by AI agents that want to
    inspect what would run before committing.
    """
    cypher: str = Field(description="Full candidate Cypher (ends with `WITH n`).")
    hits_cypher: str = Field(alias="hits_cypher", description="`cypher` plus `RETURN n` — what a hits query would actually run.")
    params: Dict[str, Any] = Field(default_factory=dict, description="Bound parameters, keyed by the parameter name used in ``cypher``.")
    candidate_cap: int = Field(alias="candidate_cap", description="Hard cap on the candidate set the provider walks.")
    hoisted_root_urns: List[List[str]] = Field(default_factory=list, alias="hoisted_root_urns", description="URN sets hoisted out of top-level DescendantOf predicates.")
    effective_root_urns: Optional[List[str]] = Field(None, alias="effective_root_urns", description="Final root URNs after intersecting scope + hoisted (null = no scope).")
    notes: List[str] = Field(default_factory=list, description="Human-readable diagnostics (e.g. 'predicate hoisted to candidate seed').")
    resolved_scope: Optional[Dict[str, Any]] = Field(None, alias="resolvedScope", description="Effective scope after ViewScopeResolver: root URNs, max depth, entity-type allow-list, scope hash, dropped URNs.")


class SearchDiscoverLabelInfo(_Base):
    """Per-label discovery payload from ``GET /search/discover``."""
    sampled: int = Field(description="How many nodes were sampled for this label.")
    keys: List[str] = Field(default_factory=list, description="Native property keys found on at least one sampled node, capped at the top N by frequency in the sample (see ``truncatedProperties``).")
    value_samples_by_key: Optional[Dict[str, List[Any]]] = Field(
        None,
        alias="valueSamplesByKey",
        description=(
            "Distinct values seen for each property key in the sample "
            "(capped at ~20 per key, ~64 keys per label). Powers the "
            "FE's property-value picker so users can choose from known "
            "values instead of typing blind. Absent when value-sample "
            "collection is disabled via the request flag."
        ),
    )
    truncated_properties: bool = Field(
        False,
        alias="truncatedProperties",
        description=(
            "True when the sample yielded more property keys than the "
            "configured per-label cap (DEEP_SEARCH_DISCOVER_KEY_CAP). "
            "FE shows a 'X of ~N properties — narrow the sample to see "
            "rare keys' hint."
        ),
    )


class SearchDiscoverEdgeInfo(_Base):
    """Per-edge-type discovery payload from ``GET /search/discover``."""
    sampled: int = Field(description="How many edges of this type were sampled.")
    keys: List[str] = Field(default_factory=list, description="Property keys found on at least one sampled edge.")
    value_samples_by_key: Optional[Dict[str, List[Any]]] = Field(
        None,
        alias="valueSamplesByKey",
        description=(
            "Distinct values per edge property key. Powers the edge-"
            "predicate editor's value autocomplete in W2."
        ),
    )


class SearchDiscoverResult(_Base):
    """Response shape for ``GET /search/discover``.

    Tells the FE/AI-agent what's actually queryable in the current view:
    which entity-type labels exist, which native property keys + value
    samples are present on them, what tag values exist across the
    sample, and what edge types + properties traversal can filter on.
    Used to populate every autocomplete picker in the visual builder.
    """
    labels: Dict[str, SearchDiscoverLabelInfo] = Field(default_factory=dict)
    blob_only_labels: List[str] = Field(default_factory=list, alias="blobOnlyLabels", description="Labels whose sampled nodes have no native keys (still on pre-W1 blob storage; need migration).")
    missing_containment: bool = Field(False, alias="missingContainment", description="True when the provider has no containment edge types configured — ancestor-based queries will return empty.")
    tag_values: Dict[str, int] = Field(
        default_factory=dict,
        alias="tagValues",
        description=(
            "Map of tag name → occurrence count across the sample. "
            "Tags live as JSON-stringified arrays on `n.tags` in v1 "
            "(graph-relationship normalisation is deferred); the "
            "discovery handler parses them in Python and aggregates "
            "counts. Trimmed to the top N by count."
        ),
    )
    edges: Dict[str, SearchDiscoverEdgeInfo] = Field(
        default_factory=dict,
        description=(
            "Per-edge-type discovery payload. Mirrors `labels` but for "
            "relationships — surfaces the edge types present in the "
            "sample plus the property keys + value samples each one "
            "carries. Powers the W2 edge-predicate editor and the "
            "edge-aware path-query value pickers."
        ),
    )
    elapsed_ms: int = Field(0, alias="elapsedMs", description="Discovery query duration in milliseconds.")


class SearchApiContract(_Base):
    """Bundle root that wraps every API-surface shape in one model.

    Exists purely as a code-generation seed: ``model_json_schema()`` on
    this class produces a single JSON Schema document whose ``$defs``
    contain every type the FE / AI agents need. The frontend's
    ``gen:search-schema`` script feeds this schema into
    ``json-schema-to-typescript`` to produce the canonical TS types.

    Not used at runtime — no endpoint sends or receives this shape.
    Fields are kept ``Optional`` so a default constructor produces a
    valid (empty) instance for tooling that needs one.
    """
    search_query: Optional[SearchQuery] = Field(None, alias="searchQuery")
    search_result_page: Optional[SearchResultPage] = Field(None, alias="searchResultPage")
    search_explain_result: Optional[SearchExplainResult] = Field(None, alias="searchExplainResult")
    search_discover_result: Optional[SearchDiscoverResult] = Field(None, alias="searchDiscoverResult")
    # ``ScopeDiagnostics`` is referenced from ``SearchResultPage`` and so
    # already lives in the schema's $defs. Explicitly mentioning it here
    # surfaces it as a top-level codegen target too, so the FE can
    # import it directly without going through SearchResultPage.
    scope_diagnostics: Optional[ScopeDiagnostics] = Field(None, alias="scopeDiagnostics")
