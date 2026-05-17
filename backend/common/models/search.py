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
from typing import Annotated, Any, List, Literal, Optional, Union

from pydantic import BaseModel, Field

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

TextMatchMode = Literal["exact", "prefix", "substring", "fulltext", "regex"]
"""Match modes for text predicates.

* ``exact``       — equality, case-insensitive by default
* ``prefix``      — ``STARTS WITH``; can hit a B-tree index
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


class PropertyPredicate(_Base):
    """Typed comparison against a single user-property.

    After the storage refactor, user properties are native FalkorDB
    fields, so these compile to indexed ``WHERE n.<key> <op> $val`` —
    no Python post-filter. ``between`` expects ``value`` to be a
    two-element list ``[lo, hi]``.
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
    "parent",         # group by direct parent (containment edge)
    "tag",            # group by tag value
    "entityType",     # group by the hit's own entity type
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
    max_buckets: int = Field(50, alias="maxBuckets", ge=1, le=500)
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

ResultShape = Literal["aggregates", "hits", "both"]


class SearchScope(_Base):
    """Bounds the search to a subtree of the view.

    ``root_urns`` is typically the visible top-level nodes of the canvas
    (when the FE issues the request). Empty means "search the whole
    view" — the service will intersect against the view's configured
    allowed-scope before passing through to the provider.
    """
    root_urns: Optional[List[str]] = Field(
        None, alias="rootUrns", max_length=64,
    )
    max_depth: Optional[int] = Field(12, alias="maxDepth", ge=1, le=20)
    entity_types: Optional[List[str]] = Field(
        None, alias="entityTypes", max_length=32,
    )
    layer_assignment: Optional[str] = Field(None, alias="layerAssignment")


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
    page_size: int = Field(50, alias="pageSize", ge=1, le=200)
    cursor: Optional[str] = None
    sort: SortKey = "relevance"
    sort_dir: Literal["asc", "desc"] = Field("desc", alias="sortDir")
    include_ancestor_path: bool = Field(False, alias="includeAncestorPath")
    highlights: bool = True
    soft_deadline_ms: int = Field(
        3000, alias="softDeadlineMs", ge=200, le=10000,
        description="Provider returns partial rows + deadline_exceeded=true "
                    "on expiry. Service does not cache deadline-exceeded "
                    "responses.",
    )


class SearchQuery(_Base):
    """The request body for POST /search/advanced."""
    predicate: Predicate
    scope: SearchScope = Field(default_factory=SearchScope)
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


class SearchAggregateBucket(_Base):
    """One ancestor (or facet) with N matches inside it."""
    ancestor_urn: str = Field(alias="ancestorUrn")
    ancestor_display_name: str = Field(alias="ancestorDisplayName")
    ancestor_entity_type: str = Field(alias="ancestorEntityType")
    ancestor_depth_from_scope_root: int = Field(alias="ancestorDepthFromScopeRoot")
    match_count: int = Field(alias="matchCount")
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


class SearchResultPage(_Base):
    """Provider + service response. One inner list in ``aggregates`` per
    requested AggregationSpec."""
    aggregates: Optional[List[List[SearchAggregateBucket]]] = None
    hits: Optional[List[SearchHit]] = None
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
    deadline_exceeded: bool = Field(False, alias="deadlineExceeded")
    elapsed_ms: int = Field(alias="elapsedMs")
    cache_hit: bool = Field(False, alias="cacheHit")
    query_explain: Optional[QueryExplain] = Field(None, alias="queryExplain")
