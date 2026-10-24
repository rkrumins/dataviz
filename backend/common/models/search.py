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
from typing import Annotated, Any, Dict, List, Literal, NamedTuple, Optional, Tuple, Union

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
    "notContains", "containsAll", "withinLast",
    "isSet", "isNotSet", "isEmpty", "isNotEmpty",
]
"""Every operator a property comparison takes. What each one means — its
value shape, the types it compares as, how a missing key and a list value
are treated — is ``backend/common/search_semantics.OPERATOR_TABLE``."""

ValueType = Literal["auto", "string", "number", "boolean", "date"]
"""How a comparison reads stored values (``search_semantics``). ``auto``
lets the value decide: text compares as text, numbers as numbers — the
behaviour every predicate written before types existed was built on."""

EdgeClass = Literal["lineage", "containment", "any"]
"""Edge-class selector shared by DegreePredicate, WithinHopsPredicate,
PathPredicate. Resolved to a concrete edge-type list at compile time
via the active ontology — never hardcoded relationship names."""


class PropertyPredicate(_Base):
    """Typed comparison against a single user-property.

    ``value_type`` says how stored values are read — under ``number`` a
    stored "15" is 15, under ``string`` a stored 15 is "15" — and the
    comparison holds for any stored kind, a list included (it matches when
    an element does). ``value`` is shaped by ``op``: one value, a list
    (``in`` / ``notIn`` / ``containsAll``), ``[lo, hi]`` (``between``), an
    ISO duration such as ``"P30D"`` (``withinLast``) or nothing (``isSet``,
    ``isEmpty`` and their negations). An integer beyond 2^53 is best sent
    as its digits in a string with ``value_type='number'``: it is compared
    exactly. Text comparisons are case-insensitive unless
    ``case_sensitive``. ``include_missing`` lets ``neq`` / ``notIn`` /
    ``notContains`` match entities without the key. The full contract is
    ``backend/common/search_semantics``.
    """
    kind: Literal["property"] = "property"
    key: str = Field(min_length=1, max_length=128)
    op: PropertyOp = "eq"
    value: Any = None
    value_type: ValueType = Field("auto", alias="valueType")
    case_sensitive: bool = Field(False, alias="caseSensitive")
    include_missing: bool = Field(False, alias="includeMissing")


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

    ``key_match`` searches by the NAME instead: ``prefix`` / ``contains``
    match any user property whose name starts with / contains ``key``,
    case-insensitively ("a property whose name contains 'owner'").
    """
    kind: Literal["hasProperty"] = "hasProperty"
    key: str = Field(min_length=1, max_length=128)
    negate: bool = False
    key_match: Literal["exact", "prefix", "contains"] = Field(
        "exact", alias="keyMatch")


class MatchAllPredicate(_Base):
    """Every entity in scope — "all in this view", "count everything".

    An ``and`` group with no children would mean the same, and the model
    refuses one on purpose: a client bug that dropped every condition must
    not quietly match the whole view. Asking for everything is spelled out.
    """
    kind: Literal["all"] = "all"


# ---------------------------------------------------------------------------
# Name references — an entity by its place in the containment tree
# ---------------------------------------------------------------------------

NODE_REF_ANY_DEPTH = "**"
"""A path segment standing for any number of containment levels, none
included."""

NODE_REF_MATCHES_MAX = 64
"""The most entities one reference may name; more is a 400 asking for a
narrower path."""


class NodeRef(_Base):
    """An entity named by its URN, or by its path of display names.

    A path starts at a top-level entity of the data source (one inside no
    other) and steps down one containment level per segment:
    ``["Country", "United Kingdom"]``. ``"**"`` stands for any number of
    levels, none included — ``["Country", "**", "London"]`` is a London
    anywhere under Country — and a leading ``"**"`` starts anywhere in the
    search's scope, so a name unique within the view (or the layer a
    search is scoped to) is enough. Names compare with the display name,
    exactly unless ``caseSensitive`` is false (only paths without ``"**"``
    may ignore case); ``entityType`` narrows the last step. A path that
    names several entities refers to all of them, at most 64.

    Unlike a URN, a path means the same thing in every environment, so a
    saved query or rule that uses one survives a library or view moving
    between them.
    """
    urn: Optional[str] = Field(None, min_length=1, max_length=2048)
    path: Optional[List[str]] = Field(None, min_length=1, max_length=12)
    entity_type: Optional[str] = Field(
        None, alias="entityType", min_length=1, max_length=128)
    case_sensitive: bool = Field(True, alias="caseSensitive")

    @model_validator(mode="after")
    def _one_form(self) -> "NodeRef":
        if (self.urn is None) == (self.path is None):
            raise ValueError("a reference is a urn or a path, not both")
        if self.urn is not None:
            if self.entity_type is not None or not self.case_sensitive:
                raise ValueError("entityType and caseSensitive apply to a path")
            return self
        segments = [segment.strip() for segment in self.path]
        if any(not s or len(s) > 256 for s in segments):
            raise ValueError("each path segment is 1–256 characters")
        if segments[-1] == NODE_REF_ANY_DEPTH:
            raise ValueError("a path ends with a name, not '**'")
        if any(a == b == NODE_REF_ANY_DEPTH for a, b in zip(segments, segments[1:])):
            raise ValueError("'**' twice in a row")
        if NODE_REF_ANY_DEPTH in segments and not self.case_sensitive:
            raise ValueError("a path with '**' compares names exactly")
        self.path = segments
        return self

    def label(self) -> str:
        """The reference as people read it: "Country / United Kingdom"."""
        if self.urn is not None:
            return self.urn
        text = " / ".join(self.path or [])
        return f"{text} ({self.entity_type})" if self.entity_type else text


class IsPredicate(_Base):
    """The entities themselves: matches an entity a reference names —
    ``Country / United Kingdom``, or a URN."""
    kind: Literal["is"] = "is"
    refs: List[NodeRef] = Field(min_length=1, max_length=64)


def _anchored(urns: List[str], refs: Optional[List[NodeRef]], what: str) -> None:
    if not urns and not refs:
        raise ValueError(f"{what} needs urns or refs")


class DescendantOfPredicate(_Base):
    """Clamp matches to the subtree(s) rooted at ``urns`` and ``refs``.

    Lives as a predicate (not on ``SearchScope``) so it can sit inside
    OR groups — e.g. ``(under Customers OR under Orders) AND tag=PII``.
    The single-subtree case is also expressible via ``scope.root_urns``,
    which the provider may push down as a tighter Cypher anchor.
    """
    kind: Literal["descendantOf"] = "descendantOf"
    urns: List[str] = Field(default_factory=list, max_length=64)
    refs: Optional[List[NodeRef]] = Field(None, min_length=1, max_length=64)
    max_depth: Optional[int] = Field(None, alias="maxDepth", ge=1, le=20)

    @model_validator(mode="after")
    def _has_anchors(self) -> "DescendantOfPredicate":
        _anchored(self.urns, self.refs, "descendantOf")
        return self


class EdgePropertyPredicate(_Base):
    """Typed comparison against a single edge property.

    Evaluated against each traversed relationship inside a
    ``PathPredicate`` or ``WithinHopsPredicate``, inside an
    ``ALL(rel IN relationships(p) …)`` block. The comparison itself is
    ``PropertyPredicate``'s — same operators, value shapes and types.
    """
    kind: Literal["edgeProperty"] = "edgeProperty"
    key: str = Field(min_length=1, max_length=128)
    op: PropertyOp = "eq"
    value: Any = None
    value_type: ValueType = Field("auto", alias="valueType")
    case_sensitive: bool = Field(False, alias="caseSensitive")
    include_missing: bool = Field(False, alias="includeMissing")


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
    urns: List[str] = Field(default_factory=list, max_length=64)
    refs: Optional[List[NodeRef]] = Field(None, min_length=1, max_length=64)
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

    @model_validator(mode="after")
    def _has_anchors(self) -> "WithinHopsPredicate":
        _anchored(self.urns, self.refs, "withinHops")
        return self


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


PATH_CONDITION_HOPS_MAX = 4
"""How far a path goes when one of its ends is a condition."""

PATH_CONDITIONS_HOPS_MAX = 3
"""How far a path goes when both its ends are conditions: its sources are
then every entity in the search's scope meeting one."""


class PathPredicate(_Base):
    """Find paths between source and target nodes.

    Top-level AND only — the compiler raises CompileError if it
    appears inside an OR or NOT group. When present, ``options.results``
    must be ``'paths'``; the response carries ordered node→edge→node
    sequences instead of (or in addition to) flat hits / aggregates.

    Powers UC3: "find all paths from dataset:orders to dataset:reporting
    going through ≤4 lineage hops". Either end may be a condition instead
    (``sourceWhere``, ``targetWhere``) — "every route from a topic to a
    dataset through edges in stream mode". A route passes no entity twice.
    """
    kind: Literal["path"] = "path"
    source_urns: List[str] = Field(
        default_factory=list, alias="sourceUrns", max_length=8,
        description="Starting nodes. The provider runs a variable-length "
                    "match outward (or inward) from each.",
    )
    source_refs: Optional[List[NodeRef]] = Field(
        None, alias="sourceRefs", min_length=1, max_length=8,
        description="Starting nodes by name path (or URN).",
    )
    target_urns: List[str] = Field(
        default_factory=list, alias="targetUrns", max_length=8,
        description="Endpoint nodes. Paths terminate here.",
    )
    target_refs: Optional[List[NodeRef]] = Field(
        None, alias="targetRefs", min_length=1, max_length=8,
        description="Endpoint nodes by name path (or URN).",
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
    source_where: Optional["Predicate"] = Field(
        None, alias="sourceWhere",
        description="The starting nodes as a condition instead of named: "
                    "any entity meeting it — or, when the targets are a "
                    "condition too, any in the search's scope.",
    )
    target_where: Optional["Predicate"] = Field(
        None, alias="targetWhere",
        description="The endpoint nodes as a condition instead of named.",
    )

    @model_validator(mode="after")
    def _has_ends(self) -> "PathPredicate":
        for urns, refs, where, what in (
                (self.source_urns, self.source_refs, self.source_where, "a path's sources"),
                (self.target_urns, self.target_refs, self.target_where, "a path's targets")):
            if where is None:
                _anchored(urns, refs, what)
            elif urns or refs:
                raise ValueError(f"{what} are named or a condition, not both")
        conditions = (self.source_where is not None) + (self.target_where is not None)
        cap = {1: PATH_CONDITION_HOPS_MAX, 2: PATH_CONDITIONS_HOPS_MAX}.get(conditions)
        if cap and self.max_hops > cap:
            if "max_hops" in self.model_fields_set:
                raise ValueError(f"a path with {'both ends' if conditions == 2 else 'an end'} "
                                 f"a condition goes at most {cap} hops")
            self.max_hops = cap     # the default, where it may go
        return self


# ---------------------------------------------------------------------------
# Relationships — conditions on the entities related to each one
# ---------------------------------------------------------------------------

RelationAxis = Literal[
    "parent", "child", "ancestor", "descendant", "root",
    "upstream", "downstream", "neighbor",
]
CONTAINMENT_AXES = ("parent", "child", "ancestor", "descendant", "root")
LINEAGE_AXES = ("upstream", "downstream", "neighbor")

RELATION_DEPTH_MAX = 20
"""How far up or down the containment tree an ``ancestor``, ``descendant``
or ``root`` relationship looks when it names no depth."""

RELATION_ANCHORED_HOPS_MAX = 10
"""The lineage hops a relationship may follow at most — as far as
``withinHops``. A relationship whose far end is a condition rather than
named entities is held to ``DEEP_SEARCH_RELATION_MAX_HOPS`` (3) by the
service: it is tested from every candidate."""


class CountSpec(_Base):
    """How many related entities must meet a relationship's condition."""
    op: DegreeOp = "gte"
    value: int = Field(ge=0, le=1_000_000)


class RelatedPredicate(_Base):
    """Entities whose related entities meet a condition.

    ``axis`` says which relatives: up the containment tree (``parent``, any
    ``ancestor``, the top-level container ``root``), down it (``child``, any
    ``descendant``), or along lineage — ``upstream`` (what feeds it),
    ``downstream`` (what it feeds), ``neighbor`` (either way) — one step, or
    ``minHops`` to ``maxHops``. ``where`` is the condition a relative must
    meet: any predicate, relationships included, so conditions chain ("feeds
    a dashboard whose parent is Finance"); without one, any relative will
    do. A lineage relationship may also require every edge it walks to meet
    ``edge``, and walk only ``edgeTypes`` (by default every lineage type but
    the rollups).

    ``quantifier``: ``any`` relative meets the condition, ``none`` does, or
    ``all`` do — and there is at least one. ``count`` compares how many
    distinct relatives meet it instead. An entity is never its own relative,
    a cycle notwithstanding.
    """
    kind: Literal["related"] = "related"
    axis: RelationAxis
    where: Optional["Predicate"] = None
    quantifier: Literal["any", "none", "all"] = "any"
    count: Optional[CountSpec] = None
    min_hops: int = Field(1, alias="minHops", ge=1, le=RELATION_DEPTH_MAX)
    max_hops: Optional[int] = Field(None, alias="maxHops", ge=1, le=RELATION_DEPTH_MAX)
    edge_types: Optional[List[str]] = Field(
        None, alias="edgeTypes", min_length=1, max_length=32)
    edge: Optional[EdgePredicateType] = None

    @model_validator(mode="after")
    def _shape(self) -> "RelatedPredicate":
        axis, hi = self.axis, self.max_hops
        if axis in ("parent", "child") and (self.min_hops, hi) not in ((1, None), (1, 1)):
            raise ValueError(f"{axis} is one step")
        if axis == "root" and (self.min_hops != 1 or hi is not None):
            raise ValueError("root takes no hops: it is the top-level container")
        if axis in CONTAINMENT_AXES and (self.edge is not None or self.edge_types):
            raise ValueError("edge filters apply to lineage relationships")
        if hi is not None and hi < self.min_hops:
            raise ValueError("maxHops is less than minHops")
        if axis in LINEAGE_AXES and self.hop_range()[1] > RELATION_ANCHORED_HOPS_MAX:
            raise ValueError(
                f"a lineage relationship follows at most {RELATION_ANCHORED_HOPS_MAX} hops")
        if self.count is not None and self.quantifier != "any":
            raise ValueError("count takes the place of the quantifier")
        return self

    def hop_range(self) -> Tuple[int, int]:
        """The steps it follows, fewest and most."""
        if self.axis in ("parent", "child"):
            return 1, 1
        if self.axis == "root":
            return 1, RELATION_DEPTH_MAX
        if self.axis in LINEAGE_AXES:
            return self.min_hops, self.max_hops or self.min_hops
        return self.min_hops, self.max_hops or RELATION_DEPTH_MAX


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
        MatchAllPredicate,
        IsPredicate,
        RelatedPredicate,
        GroupPredicate,
    ],
    Field(discriminator="kind"),
]

GroupPredicate.model_rebuild()
RelatedPredicate.model_rebuild()
PathPredicate.model_rebuild()


class AnchorGroup(NamedTuple):
    """Entities a lineage walk can start from: those ``refs`` name, taken
    ``lo`` to ``hi`` containment levels below them — ``0..0`` the entities
    themselves, ``1..20`` everything inside them, ``0..20`` both."""
    refs: Tuple[NodeRef, ...]
    lo: int
    hi: int


def anchor_groups(where: Optional["Predicate"]) -> Optional[List[AnchorGroup]]:
    """The named entities ``where`` amounts to, when it amounts to named
    entities and nothing else: ``is``; inside one (``related(ancestor,
    is)``, any relative, no count); an OR of those. None for any other
    condition.

    A lineage relationship whose condition is one of these is walked from
    the entities, as far as ``withinHops``, instead of tested from every
    candidate — the service's hop limit and the compiler both read it here,
    so they can't disagree."""
    if where is None:
        return None
    if where.kind == "is":
        return [AnchorGroup(tuple(where.refs), 0, 0)]
    if (where.kind == "related" and where.axis == "ancestor" and where.quantifier == "any"
            and where.count is None and where.where is not None and where.where.kind == "is"):
        lo, hi = where.hop_range()
        return [AnchorGroup(tuple(where.where.refs), lo, hi)]
    if where.kind == "group" and (where.op == "or" or len(where.children) == 1) \
            and where.op != "not":
        groups: List[AnchorGroup] = []
        for child in where.children:
            sub = anchor_groups(child)
            if sub is None:
                return None
            groups.extend(sub)
        return groups
    return None


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


# Client-input cap on ``SearchScope.entity_types``. Raised from 32 to
# 512 (a view's own resolved ontology allow-list can legitimately
# exceed 32 labels — see ``_stamp_resolved_scope``, which falls back
# to an unfiltered ``None`` rather than ever raising over this cap).
SEARCH_SCOPE_ENTITY_TYPES_MAX = 512


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
            "DEEP_SEARCH_SCOPE_ROOT_URNS_CAP entries (default 5000). The "
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
        None, alias="entityTypes", max_length=SEARCH_SCOPE_ENTITY_TYPES_MAX,
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
        60000, alias="softDeadlineMs", ge=200, le=120000,
        description="Provider returns partial rows + deadline_exceeded=true "
                    "on expiry. Service does not cache deadline-exceeded "
                    "responses. Default 60s (was 30s, and 3s before that) "
                    "so deep queries on very large graphs complete; user "
                    "can override per-request up to 120s.",
    )
    candidate_cap: Optional[int] = Field(
        None, alias="candidateCap", ge=100, le=100000,
        description=(
            "Per-request override of the candidate-scan ceiling. ``None`` "
            "uses the deployment default from ``DEEP_SEARCH_CANDIDATE_CAP`` "
            "(default 10000). Requests can raise this up to "
            "``DEEP_SEARCH_CANDIDATE_CAP_MAX`` (default 100000) when the "
            "user explicitly opts into a larger scan. The service "
            "validator rejects values above the deployment max. The "
            "uncapped engine (``DEEP_SEARCH_ENGINE=v2``) never caps hits or "
            "counts; it applies only to the facets that still pivot on a "
            "capped candidate set."
        ),
    )
    wait_ms: Optional[int] = Field(
        None, alias="waitMs", ge=0, le=120000,
        description=(
            "Progressive mode (uncapped engine). Answer after this long "
            "with what the scan has found so far — ``status: 'running'``, "
            "provisional hits in their final order, a ``progress`` "
            "block — and send the SAME request again with ``sessionId`` "
            "to continue it. Omitted, the request waits up to "
            "``softDeadlineMs`` for the complete answer."
        ),
    )
    session_id: Optional[str] = Field(
        None, alias="sessionId", max_length=64,
        description=(
            "Continue this search session (from a ``running`` response) "
            "rather than start a new one. It finishes on the data it "
            "started on even if the graph changes meanwhile, and says so "
            "(``stale``). Ignored when it doesn't belong to this query."
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
    ranges: List[List[int]] = Field(
        default_factory=list,
        description="``[start, end]`` offsets within ``snippet`` (not "
                    "within the original field) — the snippet's leading "
                    "ellipsis is already counted.",
    )


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
    resolved_refs: List["ResolvedRef"] = Field(
        default_factory=list, alias="resolvedRefs",
        description="What each name reference in the predicate named — "
                    "how many entities, and the first few — so a "
                    "reference that names none, or several, can be seen.",
    )


class ResolvedRef(_Base):
    """One name reference in a predicate, and what it named."""
    at: str = Field(description="Where it sits: ``$.children[0].refs[1]``.")
    ref: str = Field(description='As people read it: "Country / United Kingdom".')
    count: int = Field(description="How many entities it names.")
    ambiguous: bool = Field(description="It names more than one.")
    samples: List[AncestorRef] = Field(
        default_factory=list, description="The first few it names (up to 5).")


ScopeDiagnostics.model_rebuild()


class SearchProgress(_Base):
    """How far a running search has got. Node counts are the scan's
    estimate of what each part of the graph holds, so ``scanned / total``
    is a fraction to draw, not a count to report."""
    scanned: int = Field(description="Nodes in the parts already scanned.")
    total: int = Field(description="Nodes in every part the search scans.")
    matched: int = Field(description="Matches found so far — exact for the "
                                     "parts scanned.")


class SearchResultPage(_Base):
    """Provider + service response. One inner list in ``aggregates`` per
    requested AggregationSpec."""
    aggregates: Optional[List[List[SearchAggregateBucket]]] = None
    hits: Optional[List[SearchHit]] = Field(
        None,
        description="Ordered by server relevance; do not re-sort by "
                    "`score`. Ranking runs over the whole candidate set "
                    "before this page is sliced from it, so `score` is a "
                    "per-hit annotation, not the key the list is in.",
    )
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
    # --- Uncapped engine (``DEEP_SEARCH_ENGINE=v2``); null otherwise ---
    session_id: Optional[str] = Field(
        None, alias="sessionId",
        description="The search session this page came from. Send it back "
                    "as ``options.sessionId`` to continue a running one.",
    )
    status: Optional[Literal["running", "complete"]] = Field(
        None,
        description="``running``: the scan is not finished — the hits are "
                    "the best found so far, already in their final order, "
                    "and ``totalCount`` is null. ``complete``: every match "
                    "was counted and ranked.",
    )
    count_status: Optional[Literal["exact", "lowerBound"]] = Field(
        None, alias="countStatus",
        description="Whether ``candidateCount`` is the exact number of "
                    "matches or only those found so far.",
    )
    progress: Optional[SearchProgress] = None
    data_version: Optional[str] = Field(
        None, alias="dataVersion",
        description="The graph data the session read. Opaque.",
    )
    stale: bool = Field(
        False,
        description="The graph changed after this session started; run "
                    "the search again for an answer on the current data.",
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
    inlined_cypher: Optional[str] = Field(None, alias="inlinedCypher", description="`hits_cypher` with every parameter written as its value — a statement that runs on its own, to copy or edit. Null when a value has no Cypher literal.")


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
    stored_as: Optional[Dict[str, Literal["native", "json"]]] = Field(
        None,
        alias="storedAs",
        description=(
            "Where the edge keeps each key: ``native`` — the platform's own "
            "fields, every operator applies — or ``json``, a user's property "
            "kept in the edge's JSON, which a condition can test with is set, "
            "is, is not and is one of."
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
    blob_only_labels: List[str] = Field(default_factory=list, alias="blobOnlyLabels", description="Labels with a sampled node still carrying the pre-W1 `n.properties` JSON blob; those values stay invisible to property predicates until the native-property migration runs.")
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
    missing_searchable_text: int = Field(
        0,
        alias="missingSearchableText",
        description=(
            "Sampled nodes with no n.searchableText — run "
            "`python -m backend.scripts.migrate_native_properties "
            "--searchable-text`."
        ),
    )
    elapsed_ms: int = Field(0, alias="elapsedMs", description="Discovery query duration in milliseconds.")


class SearchValueSuggestion(_Base):
    """One distinct value of a property and how many times it is stored.
    ``value`` keeps its stored kind — a 19-digit id is that integer."""
    value: Any = None
    count: int = 0


class SearchValuesResult(_Base):
    """Response shape for ``GET /search/values``: a property's most common
    values across the view's entity types — the value picker's list.

    Suggestions, not statistics: the scan is time-bounded, so ``complete``
    says whether every type was read and ``truncated`` whether a type had
    more distinct values than listed (a count may then be an undercount).
    """
    key: str
    values: List[SearchValueSuggestion] = Field(default_factory=list)
    complete: bool = Field(
        True, description="Every entity type was read within the time budget.")
    truncated: bool = Field(
        False, description="A type had more distinct values than listed.")
    elapsed_ms: int = Field(0, alias="elapsedMs")


# ---------------------------------------------------------------------------
# Rules: which on-screen entities match, and how many match in all
# ---------------------------------------------------------------------------

SEARCH_RULE_ITEMS_MAX = 32
SEARCH_MEMBERSHIP_URNS_MAX = 1000


class SearchRuleItem(_Base):
    """One rule (or saved query) to evaluate: an id the caller chose, and
    its predicate."""
    id: str = Field(min_length=1, max_length=128)
    predicate: Predicate


SEARCH_RESOLVE_REFS_MAX = 32
"""Name references one ``POST /search/resolve`` resolves."""

SEARCH_RESOLVE_MATCHES_SHOWN = 10
"""The entities a resolution lists for each reference."""


class SearchResolveRequest(_Base):
    """``POST /search/resolve``: which entities each name reference names
    in the view's scope — what the reference picker checks as it is
    typed, and how it learns the shortest path that names one entity."""
    scope: SearchScope
    refs: List[NodeRef] = Field(min_length=1, max_length=SEARCH_RESOLVE_REFS_MAX)


class ResolvedEntity(_Base):
    """One entity a reference names, with the containers it sits in."""
    urn: str
    display_name: str = Field(alias="displayName")
    entity_type: str = Field(alias="entityType")
    ancestor_path: List[AncestorRef] = Field(
        default_factory=list, alias="ancestorPath",
        description="Top-level container first, parent last.")


class SearchRefResolution(_Base):
    count: int = Field(description="How many entities the reference names.")
    matches: List[ResolvedEntity] = Field(
        default_factory=list, description="The first few, up to 10.")
    error: Optional[str] = Field(
        None, description="Why the reference can't be used — it names too many.")


class SearchResolveResult(_Base):
    results: List[SearchRefResolution] = Field(
        description="One per requested reference, in the same order.")
    data_version: Optional[str] = Field(None, alias="dataVersion")
    elapsed_ms: int = Field(0, alias="elapsedMs")


class SearchMembershipRequest(_Base):
    """``POST /search/membership``: which of these entities — the ones on
    screen — match which rules. Answers only for entities inside the view's
    scope; one outside it never matches, whatever it holds."""
    scope: SearchScope
    items: List[SearchRuleItem] = Field(min_length=1, max_length=SEARCH_RULE_ITEMS_MAX)
    urns: List[str] = Field(max_length=SEARCH_MEMBERSHIP_URNS_MAX)


class SearchMembershipResult(_Base):
    matches: Dict[str, List[str]] = Field(
        default_factory=dict,
        description="Rule id → the requested urns it matches (in scope).",
    )
    errors: Dict[str, str] = Field(
        default_factory=dict,
        description="Rule id → why it could not be evaluated. Such a rule "
                    "matches nothing here.",
    )
    data_version: Optional[str] = Field(None, alias="dataVersion")
    elapsed_ms: int = Field(0, alias="elapsedMs")


class SearchCountsRequest(_Base):
    """``POST /search/counts``: how many entities in the view match each
    rule — exactly, however many. A count over a large view takes more than
    one request: send the same request again with the returned ``sessions``
    until every count is complete."""
    scope: SearchScope
    items: List[SearchRuleItem] = Field(min_length=1, max_length=SEARCH_RULE_ITEMS_MAX)
    wait_ms: int = Field(1000, alias="waitMs", ge=0, le=60000)
    sessions: Dict[str, str] = Field(
        default_factory=dict,
        description="Rule id → the session a previous answer returned.",
    )


class SearchRuleCount(_Base):
    count: int = Field(description="Matches found so far — exact once complete.")
    status: Literal["running", "complete"]
    session_id: Optional[str] = Field(None, alias="sessionId")
    progress: Optional[SearchProgress] = None
    error: Optional[str] = None


class SearchCountsResult(_Base):
    counts: Dict[str, SearchRuleCount] = Field(default_factory=dict)
    data_version: Optional[str] = Field(None, alias="dataVersion")
    elapsed_ms: int = Field(0, alias="elapsedMs")


# ---------------------------------------------------------------------------
# Containers: how many matches each one holds
# ---------------------------------------------------------------------------

SEARCH_ANCESTOR_URNS_MAX = 2000


class SearchAncestorCountsRequest(_Base):
    """``POST /search/ancestor-counts``: how many of a search's matches each
    of these containers holds, below it at any depth — from the session the
    search returned. The search's ``ancestor`` facet lists the fullest
    containers; this answers for any container, e.g. the ones on screen."""
    scope: SearchScope
    session_id: str = Field(alias="sessionId", min_length=1, max_length=64)
    urns: List[str] = Field(max_length=SEARCH_ANCESTOR_URNS_MAX)


class SearchAncestorCount(_Base):
    count: int = Field(description="Matches below this container, at any depth.")
    type_counts: Dict[str, int] = Field(
        default_factory=dict, alias="typeCounts",
        description="The same matches by entity type.")
    display_name: str = Field("", alias="displayName")
    entity_type: str = Field("", alias="entityType")


class SearchAncestorCountsResult(_Base):
    counts: Dict[str, SearchAncestorCount] = Field(
        default_factory=dict, description="Every requested urn → its count (0: none).")
    status: Literal["complete", "running", "expired"] = Field(
        description="``complete``: exact. ``running``: the search is still "
                    "scanning; counts so far. ``expired``: the session is "
                    "gone — run the search again.")


# ---------------------------------------------------------------------------
# The view's properties, exactly
# ---------------------------------------------------------------------------

class SearchCatalogRequest(_Base):
    """``POST /search/catalog``: every property the view's entities carry —
    on how many, stored as which kinds, with which values — read from every
    entity in its scope, not a sample. A large view takes more than one
    request: send it again with the returned ``sessionId`` until ``status``
    is ``complete``."""
    scope: SearchScope
    wait_ms: int = Field(800, alias="waitMs", ge=0, le=60000)
    session_id: Optional[str] = Field(None, alias="sessionId", max_length=64)
    refresh: bool = Field(
        False, description="Read the view again, even when a recent catalog of it is at hand.")


class SearchCatalogValue(_Base):
    value: Any = Field(description="As stored — a list's elements count one by one.")
    kind: str = Field(description="Integer, Float, String, Boolean or List.")
    count: int = Field(description="Entities holding it.")


class SearchCatalogProperty(_Base):
    key: str
    count: int = Field(description="Entities carrying the key.")
    by_entity_type: Dict[str, int] = Field(default_factory=dict, alias="byEntityType")
    kinds: Dict[str, int] = Field(
        default_factory=dict,
        description="Entities per kind the value is stored as. Two kinds compare as two.")
    min: Optional[Union[int, float]] = Field(None, description="Least numeric value, exact.")
    max: Optional[Union[int, float]] = Field(None, description="Greatest numeric value, exact.")
    distinct: int = Field(description="Distinct values — a floor unless ``distinctExact``.")
    distinct_exact: bool = Field(alias="distinctExact")
    values: List[SearchCatalogValue] = Field(
        default_factory=list,
        description="The values most held, with their exact counts — while the key has at "
                    "most 1,000 distinct values; past that it is high-cardinality and none "
                    "are listed.")
    residual: int = Field(
        0, description="Entities holding it in propertiesRaw, past the native-key budget.")


class SearchCatalogEntityType(_Base):
    type: str
    count: int


class SearchCatalogTag(_Base):
    tag: str
    count: int = Field(description="Entities carrying the tag.")


class SearchCatalogResult(_Base):
    session_id: str = Field(alias="sessionId")
    status: Literal["running", "complete"]
    progress: Optional[SearchProgress] = None
    data_version: Optional[str] = Field(None, alias="dataVersion")
    stale: bool = Field(
        False, description="Read before the data last changed — see ``asOf``.")
    as_of: Optional[str] = Field(None, alias="asOf", description="When the read began (UTC).")
    entities: int = Field(0, description="Entities in the view's scope read so far.")
    entity_types: List[SearchCatalogEntityType] = Field(default_factory=list, alias="entityTypes")
    properties: List[SearchCatalogProperty] = Field(default_factory=list)
    tags: List[SearchCatalogTag] = Field(
        default_factory=list, description="Every tag, with the entities carrying it.")
    tagged: Optional[int] = Field(
        None, description="Entities carrying any tag — null when a unit held too many "
                          "distinct tag sets to count them.")
    notes: List[str] = Field(default_factory=list)


#: The columns every export row starts with, before the chosen properties.
SEARCH_EXPORT_BASE_COLUMNS = ("urn", "displayName", "entityType", "qualifiedName")
SEARCH_EXPORT_COLUMNS_MAX = 200


def export_columns(columns: List[str]) -> List[str]:
    """Every column of an export: the base ones, then the properties asked
    for, each once."""
    return list(dict.fromkeys([*SEARCH_EXPORT_BASE_COLUMNS, *(c for c in columns if c)]))


class SearchExportRequest(_Base):
    """``POST /search/exports``: every entity in the view that matches
    ``predicate``, written to a file — exactly, however many. A large export
    takes more than one request: send the same request again with the
    returned ``sessionId`` until ``status`` is ``complete``, then download
    it from ``GET /search/exports/{sessionId}/download``."""
    scope: SearchScope
    predicate: Predicate
    format: Literal["csv", "ndjson"] = "csv"
    columns: List[str] = Field(
        default_factory=list, max_length=SEARCH_EXPORT_COLUMNS_MAX,
        description="Properties to add to each row, after its urn, name, type and "
                    "qualified name — ``description`` and ``tags`` included.")
    wait_ms: int = Field(2000, alias="waitMs", ge=0, le=60000)
    session_id: Optional[str] = Field(None, alias="sessionId", max_length=64)


class SearchExportResult(_Base):
    session_id: str = Field(alias="sessionId")
    status: Literal["running", "complete"]
    rows: int = Field(0, description="Rows written so far — every match, once "
                                     "complete.")
    progress: Optional[SearchProgress] = None
    format: Literal["csv", "ndjson"] = "csv"
    columns: List[str] = Field(default_factory=list, description="Every column, in order.")
    data_version: Optional[str] = Field(None, alias="dataVersion")
    filename: Optional[str] = Field(None, description="What the download is saved as.")
    download_token: Optional[str] = Field(
        None, alias="downloadToken",
        description="Once complete: ``GET /search/exports/{sessionId}/download?token=…`` "
                    "for an hour, for whoever ran the export.")


class NativeQueryRequest(_Base):
    """A person's own read-only query, in the data source's language
    (``POST /graph/search/native``)."""
    query: str = Field(
        min_length=1, max_length=20_000,
        description="Cypher. One statement; reads only. Values are written in — no parameters.")
    limit: Optional[int] = Field(
        None, ge=1, description="The most rows to show. Held to the server's maximum "
                                "(``NATIVE_QUERY_MAX_ROWS``); its default when omitted.")
    timeout_ms: Optional[int] = Field(
        None, alias="timeoutMs", ge=100,
        description="How long it may run. Held to the server's maximum "
                    "(``NATIVE_QUERY_MAX_TIMEOUT_MS``); its default when omitted.")


class NativeQueryResponse(_Base):
    """What a native query answered. Each cell is a plain string, number,
    true/false or null, or an object with a ``kind`` — node, edge, path, map,
    list, temporal, point, bytes, number, string, truncated."""
    engine: Literal["falkordb", "neo4j"]
    columns: List[str]
    rows: List[List[Any]]
    row_count: int = Field(alias="rowCount")
    truncated: bool = Field(description="More rows matched than are shown.")
    truncated_reason: Optional[Literal["rows", "size"]] = Field(
        None, alias="truncatedReason",
        description="``rows``: past the row limit. ``size``: past the size an answer may be.")
    limit_applied: int = Field(alias="limitApplied", description="The row limit it ran under.")
    timeout_ms: int = Field(alias="timeoutMs", description="The time limit it ran under.")
    executed_query: str = Field(alias="executedQuery",
                                description="What ran: the query with its row limit written in.")
    query_hash: str = Field(alias="queryHash")
    elapsed_ms: int = Field(alias="elapsedMs")
    notes: List[str] = Field(default_factory=list)
    request_id: Optional[str] = Field(None, alias="requestId")


class NativeQueryErrorDetail(_Base):
    """The ``detail`` of every refusal and failure of a native query."""
    code: str
    message: str
    request_id: Optional[str] = Field(None, alias="requestId")
    position: Optional[int] = Field(
        None, description="Where in the query the problem is, in characters, when known.")
    permission: Optional[str] = None
    retry_after_seconds: Optional[int] = Field(None, alias="retryAfterSeconds")


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
    search_values_result: Optional[SearchValuesResult] = Field(None, alias="searchValuesResult")
    search_membership_request: Optional[SearchMembershipRequest] = Field(
        None, alias="searchMembershipRequest")
    search_membership_result: Optional[SearchMembershipResult] = Field(
        None, alias="searchMembershipResult")
    search_counts_request: Optional[SearchCountsRequest] = Field(None, alias="searchCountsRequest")
    search_counts_result: Optional[SearchCountsResult] = Field(None, alias="searchCountsResult")
    search_ancestor_counts_request: Optional[SearchAncestorCountsRequest] = Field(
        None, alias="searchAncestorCountsRequest")
    search_ancestor_counts_result: Optional[SearchAncestorCountsResult] = Field(
        None, alias="searchAncestorCountsResult")
    search_catalog_request: Optional[SearchCatalogRequest] = Field(
        None, alias="searchCatalogRequest")
    search_catalog_result: Optional[SearchCatalogResult] = Field(
        None, alias="searchCatalogResult")
    search_export_request: Optional[SearchExportRequest] = Field(
        None, alias="searchExportRequest")
    search_export_result: Optional[SearchExportResult] = Field(
        None, alias="searchExportResult")
    search_resolve_request: Optional[SearchResolveRequest] = Field(
        None, alias="searchResolveRequest")
    search_resolve_result: Optional[SearchResolveResult] = Field(
        None, alias="searchResolveResult")
    # ``ScopeDiagnostics`` is referenced from ``SearchResultPage`` and so
    # already lives in the schema's $defs. Explicitly mentioning it here
    # surfaces it as a top-level codegen target too, so the FE can
    # import it directly without going through SearchResultPage.
    scope_diagnostics: Optional[ScopeDiagnostics] = Field(None, alias="scopeDiagnostics")
    native_query_request: Optional[NativeQueryRequest] = Field(None, alias="nativeQueryRequest")
    native_query_response: Optional[NativeQueryResponse] = Field(None, alias="nativeQueryResponse")
    native_query_error: Optional[NativeQueryErrorDetail] = Field(None, alias="nativeQueryError")
