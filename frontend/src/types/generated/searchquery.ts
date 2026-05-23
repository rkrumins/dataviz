/**
 * AUTO-GENERATED FROM THE SEARCHQUERY JSON SCHEMA — DO NOT EDIT BY HAND.
 *
 * Source : backend/common/schema/searchquery.v1.json
 * Tool   : json-schema-to-typescript via scripts/gen-search-schema.mjs
 * Run    : `pnpm gen:search-schema` (from the frontend tree)
 *
 * Changes belong in the Pydantic model at
 *   backend/common/models/search.py
 * then re-run the backend export script:
 *   python -m backend.scripts.export_search_schema
 * and finally regenerate these types.
 */

/**
 * Edge types the active ontology flags as containment. Empty list means the graph is flat (no hierarchy) and ancestor-aware features (aggregation by='ancestorType', DescendantOf scope hoisting) won't produce useful results.
 */
export type Containmentedgetypes = string[]
/**
 * Client-supplied URNs that were filtered out as out-of-view. Mirrors the X-Search-Dropped-URNs header for client convenience.
 */
export type Droppedrooturns = string[]
/**
 * Entity-type allow-list applied by the view. None means no constraint from the view.
 */
export type Effectiveentitytypes = string[] | null
export type Effectivemaxdepth = number
/**
 * Root URNs the scope continuation actually anchored on. Empty list means no scope clamp was applied — search ran across the whole data source.
 */
export type Effectiverooturns = string[]
/**
 * Edge types the active ontology flags as is_lineage. Empty list means lineage-aware predicates (IsOrphan, HasIncoming, withinHops with edgeClass='lineage', etc.) will match zero nodes by design — configure at least one edge type as is_lineage in the data source's ontology.
 */
export type Lineageedgetypes = string[]
/**
 * Human-readable diagnostic notes — e.g. 'view has no rootUrns configured; search ran unclamped'.
 */
export type Notes = string[]
/**
 * Labels whose sampled nodes have no native keys (still on pre-W1 blob storage; need migration).
 */
export type Blobonlylabels = string[]
/**
 * Property keys found on at least one sampled edge.
 */
export type Keys = string[]
/**
 * How many edges of this type were sampled.
 */
export type Sampled = number
/**
 * Distinct values per edge property key. Powers the edge-predicate editor's value autocomplete in W2.
 */
export type Valuesamplesbykey = {
    [k: string]: unknown[]
} | null
/**
 * Discovery query duration in milliseconds.
 */
export type Elapsedms = number
/**
 * Native property keys found on at least one sampled node.
 */
export type Keys1 = string[]
/**
 * How many nodes were sampled for this label.
 */
export type Sampled1 = number
/**
 * Distinct values seen for each property key in the sample (capped at ~20 per key, ~64 keys per label). Powers the FE's property-value picker so users can choose from known values instead of typing blind. Absent when value-sample collection is disabled via the request flag.
 */
export type Valuesamplesbykey1 = {
    [k: string]: unknown[]
} | null
/**
 * True when the provider has no containment edge types configured — ancestor-based queries will return empty.
 */
export type Missingcontainment = boolean
/**
 * Hard cap on the candidate set the provider walks.
 */
export type CandidateCap = number
/**
 * Full candidate Cypher (ends with `WITH n`).
 */
export type Cypher = string
/**
 * Final root URNs after intersecting scope + hoisted (null = no scope).
 */
export type EffectiveRootUrns = string[] | null
/**
 * `cypher` plus `RETURN n` — what a hits query would actually run.
 */
export type HitsCypher = string
/**
 * URN sets hoisted out of top-level DescendantOf predicates.
 */
export type HoistedRootUrns = string[][]
/**
 * Human-readable diagnostics (e.g. 'predicate hoisted to candidate seed').
 */
export type Notes1 = string[]
/**
 * Effective scope after ViewScopeResolver: root URNs, max depth, entity-type allow-list, scope hash, dropped URNs.
 */
export type Resolvedscope = {
    [k: string]: unknown
} | null
export type $Schemaversion = '1'
/**
 * Parallel facets — each spec produces its own bucket list in the response. Omit for hits-only requests.
 */
export type Aggregations = AggregationSpec[] | null
/**
 * Required when by='ancestorType'.
 */
export type Ancestorentitytypes = string[] | null
/**
 * Required when by='ancestorLevel'.
 */
export type Ancestorlevel = number | null
export type By = 'ancestorType' | 'ancestorLevel' | 'parent' | 'tag' | 'entityType' | 'property'
export type Maxbuckets = number
/**
 * Required when by='property'. The native node property whose values become the bucket keys (e.g. 'layer' → one bucket per layer value).
 */
export type Propertykey = string | null
/**
 * Tiny preview list shown next to each bucket — for the UI's hover-card and the AI-agent's at-a-glance context.
 */
export type Samplehitsperbucket = number
export type Cursor = string | null
export type Highlights = boolean
export type Includeancestorpath = boolean
export type Pagesize = number
export type Results = 'aggregates' | 'hits' | 'both' | 'paths'
/**
 * Provider returns partial rows + deadline_exceeded=true on expiry. Service does not cache deadline-exceeded responses.
 */
export type Softdeadlinems = number
export type Sort = 'relevance' | 'displayName' | 'qualifiedName' | 'depth' | 'matchCount'
export type Sortdir = 'asc' | 'desc'
/**
 * When set, hits are ordered by this native node property (e.g. 'rowCount') instead of by `sort`. Useful for 'biggest first' / 'newest first' UX.
 */
export type Sortproperty = string | null
export type Predicate =
    | TextPredicate
    | PropertyPredicate
    | TagPredicate
    | HasPropertyPredicate
    | DescendantOfPredicate
    | WithinHopsPredicate
    | EntityTypePredicate
    | LayerPredicate
    | DegreePredicate
    | IsOrphanPredicate
    | IsLeafPredicate
    | IsRootPredicate
    | HasIncomingPredicate
    | HasOutgoingPredicate
    | PathPredicate
    | GroupPredicate
/**
 * Relevance multiplier when match='fulltext'.
 */
export type Boost = number
export type Casesensitive = boolean
export type Kind = 'text'
export type Match = 'exact' | 'prefix' | 'suffix' | 'substring' | 'fulltext' | 'regex'
/**
 * Required when ``target='property'``; ignored otherwise.
 */
export type Propertykey1 = string | null
export type Target = 'name' | 'qualifiedName' | 'description' | 'tags' | 'property' | 'any'
export type Value = string
export type Casesensitive1 = boolean
export type Key = string
export type Kind1 = 'property'
export type Op =
    | 'eq'
    | 'neq'
    | 'gt'
    | 'gte'
    | 'lt'
    | 'lte'
    | 'in'
    | 'notIn'
    | 'contains'
    | 'startsWith'
    | 'endsWith'
    | 'between'
export type Kind2 = 'tag'
export type Op1 = 'has' | 'hasAll' | 'hasAny' | 'notHas'
export type Values = string[]
export type Key1 = string
export type Kind3 = 'hasProperty'
export type Negate = boolean
export type Kind4 = 'descendantOf'
export type Maxdepth = number | null
export type Urns = string[]
export type Direction = 'out' | 'in' | 'both'
/**
 * Default edge-class when ``edge_types`` is omitted. Mirrors DegreePredicate / PathPredicate.
 */
export type Edgeclass = 'lineage' | 'containment' | 'any'
/**
 * Optional predicate evaluated against every traversed edge. ANDs with ``edge_types`` / ``edge_class``. Compiles to ``ALL(rel IN relationships(p) WHERE …)``.
 */
export type Edgepredicate =
    | (EdgePropertyPredicate | EdgeHasPropertyPredicate | EdgeGroupPredicate)
    | null
export type Key2 = string
export type Kind5 = 'edgeProperty'
export type Op2 =
    | 'eq'
    | 'neq'
    | 'gt'
    | 'gte'
    | 'lt'
    | 'lte'
    | 'in'
    | 'notIn'
    | 'contains'
    | 'startsWith'
    | 'endsWith'
    | 'between'
export type Key3 = string
export type Kind6 = 'edgeHasProperty'
export type Negate1 = boolean
export type Children = (EdgePropertyPredicate | EdgeHasPropertyPredicate | EdgeGroupPredicate)[]
export type Kind7 = 'edgeGroup'
export type Op3 = 'and' | 'or' | 'not'
export type Edgetypes = string[] | null
export type Hops = number
export type Kind8 = 'withinHops'
export type Urns1 = string[]
export type Kind9 = 'entityType'
export type Op4 = 'in' | 'notIn'
export type Values1 = string[]
export type Kind10 = 'layer'
export type Layerassignment = string
export type Direction1 = 'in' | 'out' | 'both'
export type Edgeclass1 = 'lineage' | 'containment' | 'any'
/**
 * Optional explicit edge-type list. When provided, overrides the default set resolved from ``edge_class``.
 */
export type Edgetypes1 = string[] | null
export type Kind11 = 'degree'
export type Op5 = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'
export type Value1 = number
export type Edgeclass2 = 'lineage' | 'containment' | 'any'
export type Edgetypes2 = string[] | null
export type Kind12 = 'isOrphan'
export type Edgeclass3 = 'lineage' | 'containment' | 'any'
export type Edgetypes3 = string[] | null
export type Kind13 = 'isLeaf'
export type Edgeclass4 = 'lineage' | 'containment' | 'any'
export type Edgetypes4 = string[] | null
export type Kind14 = 'isRoot'
export type Edgeclass5 = 'lineage' | 'containment' | 'any'
export type Edgetypes5 = string[] | null
export type Kind15 = 'hasIncoming'
export type Edgeclass6 = 'lineage' | 'containment' | 'any'
export type Edgetypes6 = string[] | null
export type Kind16 = 'hasOutgoing'
/**
 * ``outgoing`` walks source → target along edge direction; ``incoming`` walks against direction; ``any`` is undirected.
 */
export type Direction2 = 'outgoing' | 'incoming' | 'any'
export type Edgeclass7 = 'lineage' | 'containment' | 'any'
/**
 * Optional predicate evaluated against every edge in the returned paths. ANDs with ``edge_types`` / ``edge_class``. Compiles to ``ALL(rel IN relationships(p) WHERE …)``.
 */
export type Edgepredicate1 =
    | (EdgePropertyPredicate | EdgeHasPropertyPredicate | EdgeGroupPredicate)
    | null
/**
 * Optional explicit edge-type list; overrides ``edge_class``'s resolved set.
 */
export type Edgetypes7 = string[] | null
export type Kind17 = 'path'
/**
 * Maximum path length in edge hops.
 */
export type Maxhops = number
/**
 * Hard cap on the number of paths returned.
 */
export type Maxpaths = number
/**
 * Starting nodes. The provider runs a variable-length match outward (or inward) from each.
 */
export type Sourceurns = string[]
/**
 * Endpoint nodes. Paths terminate here.
 */
export type Targeturns = string[]
export type Children1 = (
    | TextPredicate
    | PropertyPredicate
    | TagPredicate
    | HasPropertyPredicate
    | DescendantOfPredicate
    | WithinHopsPredicate
    | EntityTypePredicate
    | LayerPredicate
    | DegreePredicate
    | IsOrphanPredicate
    | IsLeafPredicate
    | IsRootPredicate
    | HasIncomingPredicate
    | HasOutgoingPredicate
    | PathPredicate
    | GroupPredicate
)[]
export type Kind18 = 'group'
export type Op6 = 'and' | 'or' | 'not'
/**
 * Optional. Must be ⊆ view's visibleEntityTypes; out-of-set values cause the request to be rejected with 400.
 */
export type Entitytypes = string[] | null
export type Layerassignment1 = string | null
/**
 * Clamped to min(client, view.maxDepth) by the resolver.
 */
export type Maxdepth1 = number | null
/**
 * Optional narrowing hint. Each URN must be a descendant of (or equal to) one of the view's allowed roots; URNs that fail validation are dropped server-side.
 */
export type Rooturns = string[] | null
/**
 * Required. The view this search is scoped to. Searches CANNOT cross the view's boundary into the rest of the graph.
 */
export type Viewid = string
export type Aggregates = SearchAggregateBucket[][] | null
export type Ancestordepthfromscoperoot = number
export type Ancestordisplayname = string
export type Ancestorentitytype = string
export type Ancestorurn = string
export type Matchcount = number
/**
 * Root → parent (excluding the hit itself). Populated when options.include_ancestor_path is true.
 */
export type Ancestorpath = AncestorRef[] | null
export type Displayname = string
export type Entitytype = string
export type Urn = string
export type Field = string
export type Score = number
export type Snippet = string
export type Highlights1 = SearchHighlight[]
export type Matchedpredicates = number[]
export type Childcount = number | null
export type Description = string | null
export type Displayname1 = string
export type Entitytype1 = string
export type Lastsyncedat = string | null
export type Layerassignment2 = string | null
export type Qualifiedname = string | null
export type Sourcesystem = string | null
export type Tags = string[]
export type Urn1 = string
export type Score1 = number
export type Samplehits = SearchHit[]
/**
 * Populated when the request's AggregationSpec carried a sub_aggregation.
 */
export type Subbuckets = SearchAggregateBucket[] | null
export type Cachehit = boolean
/**
 * Candidates that passed the predicate scan before the scope check and aggregation/limit. Useful for showing 'searching X nodes…' captions in the FE.
 */
export type Candidatecount = number
export type Cursor1 = string | null
export type Deadlineexceeded = boolean
export type Elapsedms1 = number
export type Hits = SearchHit[] | null
/**
 * Populated when the request's predicate contains a PathPredicate and options.results='paths'. Ordered node→edge→node sequences from source to target.
 */
export type Paths = PathHit[] | null
export type Edgetype = string
export type Sourceurn = string
export type Targeturn = string
export type Edges1 = EdgeRef[]
export type Hopcount = number
/**
 * Ordered list — first is source endpoint, last is target endpoint.
 */
export type Nodes = AncestorRef[]
export type Costscore = number
export type Cypher1 = string
export type Estimatedrows = number | null
/**
 * Diagnostic hints — e.g. 'no index on properties.foo'.
 */
export type Notes2 = string[]
/**
 * True when the provider hit its candidate cap or soft deadline before exhausting the candidate set.
 */
export type Truncated = boolean

/**
 * Bundle root that wraps every API-surface shape in one model.
 *
 * Exists purely as a code-generation seed: ``model_json_schema()`` on
 * this class produces a single JSON Schema document whose ``$defs``
 * contain every type the FE / AI agents need. The frontend's
 * ``gen:search-schema`` script feeds this schema into
 * ``json-schema-to-typescript`` to produce the canonical TS types.
 *
 * Not used at runtime — no endpoint sends or receives this shape.
 * Fields are kept ``Optional`` so a default constructor produces a
 * valid (empty) instance for tooling that needs one.
 */
export interface SearchApiContract {
    scopeDiagnostics?: ScopeDiagnostics | null
    searchDiscoverResult?: SearchDiscoverResult | null
    searchExplainResult?: SearchExplainResult | null
    searchQuery?: SearchQuery | null
    searchResultPage?: SearchResultPage | null
}
/**
 * Resolved-scope information returned on every search response.
 *
 * Surfaces the values the server actually applied — both the
 * ``ViewScopeResolver``'s output and the ontology-resolved edge type
 * sets. Lets the FE explain zero-result responses ("your view scope
 * resolved to no roots", "your ontology has no lineage edges")
 * without the user having to read the compiled Cypher.
 *
 * None of the fields here change query semantics; this is pure
 * instrumentation. The cost is one extra dict per response.
 */
export interface ScopeDiagnostics {
    containmentEdgeTypes?: Containmentedgetypes
    droppedRootUrns?: Droppedrooturns
    effectiveEntityTypes?: Effectiveentitytypes
    effectiveMaxDepth: Effectivemaxdepth
    effectiveRootUrns?: Effectiverooturns
    lineageEdgeTypes?: Lineageedgetypes
    notes?: Notes
}
/**
 * Response shape for ``GET /search/discover``.
 *
 * Tells the FE/AI-agent what's actually queryable in the current view:
 * which entity-type labels exist, which native property keys + value
 * samples are present on them, what tag values exist across the
 * sample, and what edge types + properties traversal can filter on.
 * Used to populate every autocomplete picker in the visual builder.
 */
export interface SearchDiscoverResult {
    blobOnlyLabels?: Blobonlylabels
    edges?: Edges
    elapsedMs?: Elapsedms
    labels?: Labels
    missingContainment?: Missingcontainment
    tagValues?: Tagvalues
}
/**
 * Per-edge-type discovery payload. Mirrors `labels` but for relationships — surfaces the edge types present in the sample plus the property keys + value samples each one carries. Powers the W2 edge-predicate editor and the edge-aware path-query value pickers.
 */
export interface Edges {
    [k: string]: SearchDiscoverEdgeInfo
}
/**
 * Per-edge-type discovery payload from ``GET /search/discover``.
 */
export interface SearchDiscoverEdgeInfo {
    keys?: Keys
    sampled: Sampled
    valueSamplesByKey?: Valuesamplesbykey
}
export interface Labels {
    [k: string]: SearchDiscoverLabelInfo
}
/**
 * Per-label discovery payload from ``GET /search/discover``.
 */
export interface SearchDiscoverLabelInfo {
    keys?: Keys1
    sampled: Sampled1
    valueSamplesByKey?: Valuesamplesbykey1
}
/**
 * Map of tag name → occurrence count across the sample. Tags live as JSON-stringified arrays on `n.tags` in v1 (graph-relationship normalisation is deferred); the discovery handler parses them in Python and aggregates counts. Trimmed to the top N by count.
 */
export interface Tagvalues {
    [k: string]: number
}
/**
 * Response shape for ``POST /search/explain``.
 *
 * Mirrors what ``backend.app.providers.falkordb_deep_search.explain_deep_search``
 * returns, plus the ``resolvedScope`` block added by the service layer.
 * Used by the FE's "Show Cypher" surface and by AI agents that want to
 * inspect what would run before committing.
 */
export interface SearchExplainResult {
    candidate_cap: CandidateCap
    cypher: Cypher
    effective_root_urns?: EffectiveRootUrns
    hits_cypher: HitsCypher
    hoisted_root_urns?: HoistedRootUrns
    notes?: Notes1
    params?: Params
    resolvedScope?: Resolvedscope
}
/**
 * Bound parameters, keyed by the parameter name used in ``cypher``.
 */
export interface Params {
    [k: string]: unknown
}
/**
 * The request body for POST /search/advanced.
 *
 * ``scope`` is required — every search must be bound to a view via
 * ``scope.view_id``. There is no global / cross-view default.
 *
 * ``schema_version`` carries the wire-format version. Clients omit it
 * on outgoing requests (the default fills it in); the server echoes it
 * on every response so clients can fail loud on a mismatch.
 */
export interface SearchQuery {
    $schemaVersion?: $Schemaversion
    options?: SearchOptions
    predicate: Predicate
    scope: SearchScope
}
/**
 * Per-request shape / pagination / deadline controls.
 *
 * Defaults are tuned for the UI's Map-mode-first experience:
 * ``results='aggregates'`` returns just buckets, ``page_size=50`` is
 * used only when hits are requested, and a 3-second soft deadline
 * keeps the UI responsive (partial results returned on timeout).
 */
export interface SearchOptions {
    aggregations?: Aggregations
    cursor?: Cursor
    highlights?: Highlights
    includeAncestorPath?: Includeancestorpath
    pageSize?: Pagesize
    results?: Results
    softDeadlineMs?: Softdeadlinems
    sort?: Sort
    sortDir?: Sortdir
    sortProperty?: Sortproperty
}
/**
 * Roll matches up to ancestors (or facets) for orient-before-drill UX.
 *
 * Pure-aggregate responses skip the result-row ordering + ancestor-
 * hydration steps and are accordingly the cheapest mode the provider
 * can run. One level of ``sub_aggregation`` is permitted; deeper
 * drilling is meant to be done by re-issuing a scoped request — that
 * iteration is also the AI-agent facet-discovery pattern.
 */
export interface AggregationSpec {
    ancestorEntityTypes?: Ancestorentitytypes
    ancestorLevel?: Ancestorlevel
    by?: By
    maxBuckets?: Maxbuckets
    propertyKey?: Propertykey
    sampleHitsPerBucket?: Samplehitsperbucket
    /**
     * One-level nested drill. Deeper levels require a follow-up scoped search (see module docstring).
     */
    subAggregation?: AggregationSpec | null
}
/**
 * Free-form text match against a single field (or ``any``).
 */
export interface TextPredicate {
    boost?: Boost
    caseSensitive?: Casesensitive
    kind?: Kind
    match?: Match
    propertyKey?: Propertykey1
    target?: Target
    value: Value
}
/**
 * Typed comparison against a single user-property.
 *
 * After the storage refactor, user properties are native FalkorDB
 * fields, so these compile to indexed ``WHERE n.<key> <op> $val`` —
 * no Python post-filter. ``between`` expects ``value`` to be a
 * two-element list ``[lo, hi]``.
 */
export interface PropertyPredicate {
    caseSensitive?: Casesensitive1
    key: Key
    kind?: Kind1
    op?: Op
    value?: unknown
}
/**
 * Match against the (currently JSON-stringified) ``n.tags`` field.
 *
 * Tags remain stringified in this workstream — see the storage-refactor
 * commit. Server-side this maps to ``n.tags CONTAINS $tag`` per value,
 * composed by ``op``.
 */
export interface TagPredicate {
    kind?: Kind2
    op?: Op1
    values: Values
}
/**
 * "Does this node have a property named X" — key presence only.
 *
 * Compiles to ``EXISTS(n.<key>)`` (or ``NOT EXISTS`` when ``negate``).
 * Native-property storage makes this cheap; pre-refactor this required
 * parsing the blob in Python for every node.
 */
export interface HasPropertyPredicate {
    key: Key1
    kind?: Kind3
    negate?: Negate
}
/**
 * Clamp matches to the subtree(s) rooted at ``urns``.
 *
 * Lives as a predicate (not on ``SearchScope``) so it can sit inside
 * OR groups — e.g. ``(under Customers OR under Orders) AND tag=PII``.
 * The single-subtree case is also expressible via ``scope.root_urns``,
 * which the provider may push down as a tighter Cypher anchor.
 */
export interface DescendantOfPredicate {
    kind?: Kind4
    maxDepth?: Maxdepth
    urns: Urns
}
/**
 * Match nodes within N relationship hops of any anchor URN.
 *
 * Powers lineage-aware questions ("any column 2 hops downstream of
 * ``orders.id``"). ``edge_types`` restricts the traversal to specific
 * relationship types; omitted means all. ``direction='out'`` walks
 * out-edges only, ``'in'`` walks in-edges, ``'both'`` is undirected.
 */
export interface WithinHopsPredicate {
    direction?: Direction
    edgeClass?: Edgeclass
    edgePredicate?: Edgepredicate
    edgeTypes?: Edgetypes
    hops: Hops
    kind?: Kind8
    urns: Urns1
}
/**
 * Typed comparison against a single edge property.
 *
 * Evaluated against each traversed relationship inside a
 * ``PathPredicate`` or ``WithinHopsPredicate``. Compiles to
 * ``rel.<key> <op> $val`` inside an ``ALL(rel IN relationships(p) …)``
 * block. ``between`` expects ``value`` to be a two-element list
 * ``[lo, hi]``.
 */
export interface EdgePropertyPredicate {
    key: Key2
    kind?: Kind5
    op?: Op2
    value?: unknown
}
/**
 * Key-presence predicate against an edge. Compiles to
 * ``EXISTS(rel.<key>)`` (or ``NOT EXISTS`` when ``negate``).
 */
export interface EdgeHasPropertyPredicate {
    key: Key3
    kind?: Kind6
    negate?: Negate1
}
/**
 * Boolean composition of edge predicates.
 *
 * Same shape as ``GroupPredicate`` but scoped to a traversed edge.
 * Service-layer validator enforces depth / leaf caps mirroring the
 * node-predicate tree.
 */
export interface EdgeGroupPredicate {
    children: Children
    kind?: Kind7
    op?: Op3
}
/**
 * Restrict matches to (or away from) specific entity types.
 *
 * Equivalent expressivity to ``scope.entity_types``, but composable
 * inside OR groups.
 */
export interface EntityTypePredicate {
    kind?: Kind9
    op?: Op4
    values: Values1
}
/**
 * Match the view's layer assignment (Source / Staging / Refinery / …).
 */
export interface LayerPredicate {
    kind?: Kind10
    layerAssignment: Layerassignment
}
/**
 * Match nodes by their edge degree.
 *
 * Powers structural questions like "find datasets with zero incoming
 * lineage edges" (UC-1 orphan finder), "find tables with > 5 children",
 * or "find views that produce >= 1 downstream artifact".
 *
 * The edge type set is resolved from the live ontology at compile time
 * via the provider's ``_get_lineage_edge_types`` /
 * ``_get_containment_edge_types`` helpers, so no hardcoded names ever
 * leak into Cypher. ``edge_types`` lets a caller pin a specific subset
 * (e.g. ``['PRODUCES']`` only); when omitted, the ``edge_class`` chooses
 * the default set.
 */
export interface DegreePredicate {
    direction?: Direction1
    edgeClass?: Edgeclass1
    edgeTypes?: Edgetypes1
    kind?: Kind11
    op?: Op5
    value: Value1
}
/**
 * Sugar: nodes with zero edges of the given class. Normalises to
 * ``DegreePredicate(direction='both', op='eq', value=0)``.
 */
export interface IsOrphanPredicate {
    edgeClass?: Edgeclass2
    edgeTypes?: Edgetypes2
    kind?: Kind12
}
/**
 * Sugar: nodes with zero outgoing edges of the given class
 * ("dead ends"). Normalises to
 * ``DegreePredicate(direction='out', op='eq', value=0)``.
 */
export interface IsLeafPredicate {
    edgeClass?: Edgeclass3
    edgeTypes?: Edgetypes3
    kind?: Kind13
}
/**
 * Sugar: nodes with zero incoming edges of the given class
 * ("nobody produces this"). Normalises to
 * ``DegreePredicate(direction='in', op='eq', value=0)``.
 */
export interface IsRootPredicate {
    edgeClass?: Edgeclass4
    edgeTypes?: Edgetypes4
    kind?: Kind14
}
/**
 * Sugar: nodes with at least one incoming edge of the given class.
 * Normalises to ``DegreePredicate(direction='in', op='gt', value=0)``.
 */
export interface HasIncomingPredicate {
    edgeClass?: Edgeclass5
    edgeTypes?: Edgetypes5
    kind?: Kind15
}
/**
 * Sugar: nodes with at least one outgoing edge of the given class.
 * Normalises to ``DegreePredicate(direction='out', op='gt', value=0)``.
 */
export interface HasOutgoingPredicate {
    edgeClass?: Edgeclass6
    edgeTypes?: Edgetypes6
    kind?: Kind16
}
/**
 * Find paths between source and target nodes.
 *
 * Top-level AND only — the compiler raises CompileError if it
 * appears inside an OR or NOT group. When present, ``options.results``
 * must be ``'paths'``; the response carries ordered node→edge→node
 * sequences instead of (or in addition to) flat hits / aggregates.
 *
 * Powers UC3: "find all paths from dataset:orders to dataset:reporting
 * going through ≤4 lineage hops".
 */
export interface PathPredicate {
    direction?: Direction2
    edgeClass?: Edgeclass7
    edgePredicate?: Edgepredicate1
    edgeTypes?: Edgetypes7
    kind?: Kind17
    maxHops?: Maxhops
    maxPaths?: Maxpaths
    sourceUrns: Sourceurns
    targetUrns: Targeturns
}
/**
 * Boolean composition of child predicates.
 *
 * ``op='not'`` must have exactly one child — the service-layer validator
 * enforces that (the model accepts ≥1 to keep the schema simple). The
 * same validator enforces ``max_depth ≤ 6`` and ``leaf_count ≤ 64``.
 */
export interface GroupPredicate {
    children: Children1
    kind?: Kind18
    op?: Op6
}
/**
 * Bounds the search to a subtree of a specific *view*.
 *
 * ``view_id`` is **required** — every search must be bound to a view.
 * The backend's ``ViewScopeResolver`` reads the view's config and
 * produces an ``EffectiveViewScope`` (root URNs + entity-type allow-list
 * + layer allow-list + max depth) that the compiler enforces.
 *
 * ``root_urns`` / ``entity_types`` / ``layer_assignment`` / ``max_depth``
 * are **narrowing hints** from the client (e.g. a drill into one bucket
 * in the canvas). The resolver intersects them with the view's allowed
 * scope — never widens.
 */
export interface SearchScope {
    entityTypes?: Entitytypes
    layerAssignment?: Layerassignment1
    maxDepth?: Maxdepth1
    rootUrns?: Rooturns
    viewId: Viewid
}
/**
 * Provider + service response. One inner list in ``aggregates`` per
 * requested AggregationSpec.
 */
export interface SearchResultPage {
    aggregates?: Aggregates
    cacheHit?: Cachehit
    candidateCount?: Candidatecount
    cursor?: Cursor1
    deadlineExceeded?: Deadlineexceeded
    elapsedMs: Elapsedms1
    hits?: Hits
    paths?: Paths
    queryExplain?: QueryExplain | null
    /**
     * Resolved-scope + ontology diagnostics. Surfaced on every response so the FE can interpret 0-result cases without round-tripping to /search/explain.
     */
    scopeDiagnostics?: ScopeDiagnostics | null
    truncated?: Truncated
}
/**
 * One ancestor (or facet) with N matches inside it.
 */
export interface SearchAggregateBucket {
    ancestorDepthFromScopeRoot: Ancestordepthfromscoperoot
    ancestorDisplayName: Ancestordisplayname
    ancestorEntityType: Ancestorentitytype
    ancestorUrn: Ancestorurn
    matchCount: Matchcount
    sampleHits?: Samplehits
    subBuckets?: Subbuckets
}
/**
 * One matched node, optionally with provenance.
 *
 * ``matched_predicates`` is the list of leaf-predicate indices (0-indexed
 * DFS over the request's predicate tree) that this node satisfied —
 * enables the FE to show "matched on: name, logicalType" badges.
 */
export interface SearchHit {
    ancestorPath?: Ancestorpath
    highlights?: Highlights1
    matchedPredicates?: Matchedpredicates
    node: GraphNode
    score?: Score1
}
/**
 * Compact ancestor identifier — enough for the FE to render a
 * breadcrumb without re-fetching the node.
 */
export interface AncestorRef {
    displayName: Displayname
    entityType: Entitytype
    urn: Urn
}
/**
 * Where in a hit's text the match landed, for ``<mark>`` rendering.
 */
export interface SearchHighlight {
    field: Field
    score?: Score
    snippet: Snippet
}
export interface GraphNode {
    childCount?: Childcount
    description?: Description
    displayName: Displayname1
    entityType: Entitytype1
    lastSyncedAt?: Lastsyncedat
    layerAssignment?: Layerassignment2
    properties?: Properties
    qualifiedName?: Qualifiedname
    sourceSystem?: Sourcesystem
    tags?: Tags
    urn: Urn1
}
export interface Properties {
    [k: string]: unknown
}
/**
 * One returned path: an ordered alternating sequence of nodes and
 * edges, with the hop count for sorting / display.
 *
 * Constraint: ``len(nodes) == len(edges) + 1`` always. The first
 * node is one of the ``source_urns`` and the last is one of the
 * ``target_urns`` (after direction normalisation).
 */
export interface PathHit {
    edges: Edges1
    hopCount: Hopcount
    nodes: Nodes
}
/**
 * One edge in a returned path. Carries enough for the FE to render
 * a directed arrow between two nodes plus expose edge properties on
 * hover. We don't return a full GraphEdge to keep the path response
 * compact — the provider knows about the relationship type and
 * endpoints, which is what callers actually render.
 */
export interface EdgeRef {
    edgeType: Edgetype
    properties?: Properties1
    sourceUrn: Sourceurn
    targetUrn: Targeturn
}
export interface Properties1 {
    [k: string]: unknown
}
/**
 * Compiled-query metadata. Returned by POST /search/explain (dry-run)
 * and optionally inlined on the main search response when the caller
 * asked for it. Useful for support + the FE's 'show generated query'
 * toggle in the Advanced panel.
 */
export interface QueryExplain {
    costScore?: Costscore
    cypher: Cypher1
    estimatedRows?: Estimatedrows
    notes?: Notes2
}
