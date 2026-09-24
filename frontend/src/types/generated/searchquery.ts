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
 * Optional. Must be ⊆ view's visibleEntityTypes; out-of-set values cause the request to be rejected with 400.
 */
export type Entitytypes = string[] | null
export type Layerassignment = string | null
/**
 * Clamped to min(client, view.maxDepth) by the resolver.
 */
export type Maxdepth = number | null
/**
 * Optional narrowing hint. Each URN must be a descendant of (or equal to) one of the view's allowed roots; URNs that fail validation are dropped server-side. Capped at DEEP_SEARCH_SCOPE_ROOT_URNS_CAP entries (default 5000). The cap exists to bound the Cypher IN-list size + containment expansion fanout on multi-domain views with many top-level containers.
 */
export type Rooturns = string[] | null
/**
 * visible: filter to URNs in scope.visible_urns (fast in-view search). view: view's authorised roots + containment expansion (default for server-direct callers). data_source: entire data source — power-user override.
 */
export type Scopemode = 'visible' | 'view' | 'data_source'
/**
 * Required. The view the search is bound to (security context + telemetry). Scope behaviour depends on ``scope_mode``.
 */
export type Viewid = string
/**
 * URNs currently rendered in the canvas. Required when scope_mode='visible'. Ignored in other modes. Capped at DEEP_SEARCH_VISIBLE_URNS_CAP entries (default 20000).
 */
export type Visibleurns = string[] | null
export type Sessionid = string
export type Urns = string[]
/**
 * Matches below this container, at any depth.
 */
export type Count = number
export type Displayname = string
export type Entitytype = string
/**
 * ``complete``: exact. ``running``: the search is still scanning; counts so far. ``expired``: the session is gone — run the search again.
 */
export type Status = 'complete' | 'running' | 'expired'
/**
 * Read the view again, even when a recent catalog of it is at hand.
 */
export type Refresh = boolean
export type Sessionid1 = string | null
export type Waitms = number
/**
 * When the read began (UTC).
 */
export type Asof = string | null
export type Dataversion = string | null
/**
 * Entities in the view's scope read so far.
 */
export type Entities = number
export type Count1 = number
export type Type = string
export type Entitytypes1 = SearchCatalogEntityType[]
export type Notes1 = string[]
/**
 * Matches found so far — exact for the parts scanned.
 */
export type Matched = number
/**
 * Nodes in the parts already scanned.
 */
export type Scanned = number
/**
 * Nodes in every part the search scans.
 */
export type Total = number
/**
 * Entities carrying the key.
 */
export type Count2 = number
/**
 * Distinct values — a floor unless ``distinctExact``.
 */
export type Distinct = number
export type Distinctexact = boolean
export type Key = string
/**
 * Greatest numeric value, exact.
 */
export type Max = number | null
/**
 * Least numeric value, exact.
 */
export type Min = number | null
/**
 * Entities holding it in propertiesRaw, past the native-key budget.
 */
export type Residual = number
/**
 * Entities holding it.
 */
export type Count3 = number
/**
 * Integer, Float, String, Boolean or List.
 */
export type Kind = string
/**
 * The values most held, with their exact counts — while the key has at most 1,000 distinct values; past that it is high-cardinality and none are listed.
 */
export type Values = SearchCatalogValue[]
export type Properties = SearchCatalogProperty[]
export type Sessionid2 = string
/**
 * Read before the data last changed — see ``asOf``.
 */
export type Stale = boolean
export type Status1 = 'running' | 'complete'
/**
 * Entities carrying any tag — null when a unit held too many distinct tag sets to count them.
 */
export type Tagged = number | null
/**
 * Entities carrying the tag.
 */
export type Count4 = number
export type Tag = string
/**
 * Every tag, with the entities carrying it.
 */
export type Tags = SearchCatalogTag[]
export type Id = string
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
    | MatchAllPredicate
    | GroupPredicate
/**
 * Relevance multiplier when match='fulltext'.
 */
export type Boost = number
export type Casesensitive = boolean
export type Kind1 = 'text'
export type Match = 'exact' | 'prefix' | 'suffix' | 'substring' | 'fulltext' | 'regex'
/**
 * Required when ``target='property'``; ignored otherwise.
 */
export type Propertykey = string | null
export type Target = 'name' | 'qualifiedName' | 'description' | 'tags' | 'property' | 'any'
export type Value = string
export type Casesensitive1 = boolean
export type Includemissing = boolean
export type Key1 = string
export type Kind2 = 'property'
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
    | 'notContains'
    | 'containsAll'
    | 'withinLast'
    | 'isSet'
    | 'isNotSet'
    | 'isEmpty'
    | 'isNotEmpty'
export type Valuetype = 'auto' | 'string' | 'number' | 'boolean' | 'date'
export type Kind3 = 'tag'
export type Op1 = 'has' | 'hasAll' | 'hasAny' | 'notHas'
export type Values1 = string[]
export type Key2 = string
export type Keymatch = 'exact' | 'prefix' | 'contains'
export type Kind4 = 'hasProperty'
export type Negate = boolean
export type Kind5 = 'descendantOf'
export type Maxdepth1 = number | null
export type Urns1 = string[]
export type Direction = 'out' | 'in' | 'both'
/**
 * Default edge-class when ``edge_types`` is omitted. Mirrors DegreePredicate / PathPredicate.
 */
export type Edgeclass = 'lineage' | 'containment' | 'any'
/**
 * Optional predicate evaluated against every traversed edge. ANDs with ``edge_types`` / ``edge_class``. Compiles to ``ALL(rel IN relationships(p) WHERE …)``.
 */
export type Edgepredicate =
    (EdgePropertyPredicate | EdgeHasPropertyPredicate | EdgeGroupPredicate) | null
export type Casesensitive2 = boolean
export type Includemissing1 = boolean
export type Key3 = string
export type Kind6 = 'edgeProperty'
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
    | 'notContains'
    | 'containsAll'
    | 'withinLast'
    | 'isSet'
    | 'isNotSet'
    | 'isEmpty'
    | 'isNotEmpty'
export type Valuetype1 = 'auto' | 'string' | 'number' | 'boolean' | 'date'
export type Key4 = string
export type Kind7 = 'edgeHasProperty'
export type Negate1 = boolean
export type Children = (EdgePropertyPredicate | EdgeHasPropertyPredicate | EdgeGroupPredicate)[]
export type Kind8 = 'edgeGroup'
export type Op3 = 'and' | 'or' | 'not'
export type Edgetypes = string[] | null
export type Hops = number
export type Kind9 = 'withinHops'
export type Urns2 = string[]
export type Kind10 = 'entityType'
export type Op4 = 'in' | 'notIn'
export type Values2 = string[]
export type Kind11 = 'layer'
export type Layerassignment1 = string
export type Direction1 = 'in' | 'out' | 'both'
export type Edgeclass1 = 'lineage' | 'containment' | 'any'
/**
 * Optional explicit edge-type list. When provided, overrides the default set resolved from ``edge_class``.
 */
export type Edgetypes1 = string[] | null
export type Kind12 = 'degree'
export type Op5 = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'
export type Value1 = number
export type Edgeclass2 = 'lineage' | 'containment' | 'any'
export type Edgetypes2 = string[] | null
export type Kind13 = 'isOrphan'
export type Edgeclass3 = 'lineage' | 'containment' | 'any'
export type Edgetypes3 = string[] | null
export type Kind14 = 'isLeaf'
export type Edgeclass4 = 'lineage' | 'containment' | 'any'
export type Edgetypes4 = string[] | null
export type Kind15 = 'isRoot'
export type Edgeclass5 = 'lineage' | 'containment' | 'any'
export type Edgetypes5 = string[] | null
export type Kind16 = 'hasIncoming'
export type Edgeclass6 = 'lineage' | 'containment' | 'any'
export type Edgetypes6 = string[] | null
export type Kind17 = 'hasOutgoing'
/**
 * ``outgoing`` walks source → target along edge direction; ``incoming`` walks against direction; ``any`` is undirected.
 */
export type Direction2 = 'outgoing' | 'incoming' | 'any'
export type Edgeclass7 = 'lineage' | 'containment' | 'any'
/**
 * Optional predicate evaluated against every edge in the returned paths. ANDs with ``edge_types`` / ``edge_class``. Compiles to ``ALL(rel IN relationships(p) WHERE …)``.
 */
export type Edgepredicate1 =
    (EdgePropertyPredicate | EdgeHasPropertyPredicate | EdgeGroupPredicate) | null
/**
 * Optional explicit edge-type list; overrides ``edge_class``'s resolved set.
 */
export type Edgetypes7 = string[] | null
export type Kind18 = 'path'
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
export type Kind19 = 'all'
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
    | MatchAllPredicate
    | GroupPredicate
)[]
export type Kind20 = 'group'
export type Op6 = 'and' | 'or' | 'not'
export type Items = SearchRuleItem[]
export type Waitms1 = number
/**
 * Matches found so far — exact once complete.
 */
export type Count5 = number
export type Error = string | null
export type Sessionid3 = string | null
export type Status2 = 'running' | 'complete'
export type Dataversion1 = string | null
export type Elapsedms = number
/**
 * Labels with a sampled node still carrying the pre-W1 `n.properties` JSON blob; those values stay invisible to property predicates until the native-property migration runs.
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
export type Elapsedms1 = number
/**
 * Native property keys found on at least one sampled node, capped at the top N by frequency in the sample (see ``truncatedProperties``).
 */
export type Keys1 = string[]
/**
 * How many nodes were sampled for this label.
 */
export type Sampled1 = number
/**
 * True when the sample yielded more property keys than the configured per-label cap (DEEP_SEARCH_DISCOVER_KEY_CAP). FE shows a 'X of ~N properties — narrow the sample to see rare keys' hint.
 */
export type Truncatedproperties = boolean
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
 * Sampled nodes with no n.searchableText — run `python -m backend.scripts.migrate_native_properties --searchable-text`.
 */
export type Missingsearchabletext = number
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
export type Notes2 = string[]
/**
 * Effective scope after ViewScopeResolver: root URNs, max depth, entity-type allow-list, scope hash, dropped URNs.
 */
export type Resolvedscope = {
    [k: string]: unknown
} | null
export type Items1 = SearchRuleItem[]
export type Urns3 = string[]
export type Dataversion2 = string | null
export type Elapsedms2 = number
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
export type By =
    'ancestorType' | 'ancestorLevel' | 'ancestor' | 'parent' | 'tag' | 'entityType' | 'property'
/**
 * Bucket ceiling. The headroom above a facet-sized list is for by='ancestor', which needs one bucket per container the canvas can collapse.
 */
export type Maxbuckets = number
/**
 * Required when by='property'. The native node property whose values become the bucket keys (e.g. 'layer' → one bucket per layer value).
 */
export type Propertykey1 = string | null
/**
 * Tiny preview list shown next to each bucket — for the UI's hover-card and the AI-agent's at-a-glance context.
 */
export type Samplehitsperbucket = number
/**
 * Per-request override of the candidate-scan ceiling. ``None`` uses the deployment default from ``DEEP_SEARCH_CANDIDATE_CAP`` (default 10000). Requests can raise this up to ``DEEP_SEARCH_CANDIDATE_CAP_MAX`` (default 100000) when the user explicitly opts into a larger scan. The service validator rejects values above the deployment max. The uncapped engine (``DEEP_SEARCH_ENGINE=v2``) never caps hits or counts; it applies only to the facets that still pivot on a capped candidate set.
 */
export type Candidatecap = number | null
/**
 * Opaque pagination cursor. When set, hits start from the cursor's recorded offset within the candidate set. The response echoes a new cursor when more rows are available (``hits.length == pageSize`` AND the slice didn't exhaust the candidate set).
 */
export type Cursor = string | null
export type Highlights = boolean
export type Includeancestorpath = boolean
/**
 * Number of hits returned per page. Default 50 (sane for browsing); the panel sets it to the candidate cap (5000) when it wants the full match set in one round-trip so canvas highlighting can cover every match without paginating. Bounded at 5000 (matches CANDIDATE_CAP) — larger pages require cursor pagination.
 */
export type Pagesize = number
export type Results = 'aggregates' | 'hits' | 'both' | 'paths'
/**
 * Continue this search session (from a ``running`` response) rather than start a new one. It finishes on the data it started on even if the graph changes meanwhile, and says so (``stale``). Ignored when it doesn't belong to this query.
 */
export type Sessionid4 = string | null
/**
 * Provider returns partial rows + deadline_exceeded=true on expiry. Service does not cache deadline-exceeded responses. Default 30s (was 3s) so deep queries on large graphs complete; user can override per-request up to 120s.
 */
export type Softdeadlinems = number
export type Sort = 'relevance' | 'displayName' | 'qualifiedName' | 'depth' | 'matchCount'
export type Sortdir = 'asc' | 'desc'
/**
 * When set, hits are ordered by this native node property (e.g. 'rowCount') instead of by `sort`. Useful for 'biggest first' / 'newest first' UX.
 */
export type Sortproperty = string | null
/**
 * Progressive mode (uncapped engine). Answer after this long with what the scan has found so far — ``status: 'running'``, provisional hits in their final order, a ``progress`` block — and send the SAME request again with ``sessionId`` to continue it. Omitted, the request waits up to ``softDeadlineMs`` for the complete answer.
 */
export type Waitms2 = number | null
export type Predicate1 =
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
    | MatchAllPredicate
    | GroupPredicate
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
export type Displayname1 = string
export type Entitytype1 = string
export type Urn = string
export type Field = string
/**
 * ``[start, end]`` offsets within ``snippet`` (not within the original field) — the snippet's leading ellipsis is already counted.
 */
export type Ranges = number[][]
export type Score = number
export type Snippet = string
export type Highlights1 = SearchHighlight[]
export type Matchedpredicates = number[]
export type Childcount = number | null
export type Description = string | null
export type Displayname2 = string
export type Entitytype2 = string
export type Lastsyncedat = string | null
export type Layerassignment2 = string | null
export type Qualifiedname = string | null
export type Sourcesystem = string | null
export type Tags1 = string[]
export type Urn1 = string
export type Version = string | null
export type Score1 = number
export type Samplehits = SearchHit[]
/**
 * Populated when the request's AggregationSpec carried a sub_aggregation.
 */
export type Subbuckets = SearchAggregateBucket[] | null
/**
 * Per-entity-type breakdown of ``match_count`` — e.g. ``{'Column': 12, 'Table': 3}``. Populated by by='ancestor'; None for the kinds that don't compute one.
 */
export type Typecounts1 = {
    [k: string]: number
} | null
export type Cachehit = boolean
/**
 * Candidates that passed the predicate scan before the scope check and aggregation/limit. Useful for showing 'searching X nodes…' captions in the FE.
 */
export type Candidatecount = number
/**
 * Whether ``candidateCount`` is the exact number of matches or only those found so far.
 */
export type Countstatus = ('exact' | 'lowerBound') | null
export type Cursor1 = string | null
/**
 * The graph data the session read. Opaque.
 */
export type Dataversion3 = string | null
export type Deadlineexceeded = boolean
export type Elapsedms3 = number
/**
 * Ordered by server relevance; do not re-sort by `score`. Ranking runs over the whole candidate set before this page is sliced from it, so `score` is a per-hit annotation, not the key the list is in.
 */
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
export type Notes3 = string[]
/**
 * The search session this page came from. Send it back as ``options.sessionId`` to continue a running one.
 */
export type Sessionid5 = string | null
/**
 * The graph changed after this session started; run the search again for an answer on the current data.
 */
export type Stale1 = boolean
/**
 * ``running``: the scan is not finished — the hits are the best found so far, already in their final order, and ``totalCount`` is null. ``complete``: every match was counted and ranked.
 */
export type Status3 = ('running' | 'complete') | null
/**
 * Exact number of matches in scope, independent of the candidate cap; null when the count timed out (UI shows N+).
 */
export type Totalcount = number | null
/**
 * True when the provider hit its candidate cap or soft deadline before exhausting the candidate set.
 */
export type Truncated = boolean
/**
 * Every entity type was read within the time budget.
 */
export type Complete = boolean
export type Elapsedms4 = number
export type Key5 = string
/**
 * A type had more distinct values than listed.
 */
export type Truncated1 = boolean
export type Count6 = number
export type Values3 = SearchValueSuggestion[]

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
    searchAncestorCountsRequest?: SearchAncestorCountsRequest | null
    searchAncestorCountsResult?: SearchAncestorCountsResult | null
    searchCatalogRequest?: SearchCatalogRequest | null
    searchCatalogResult?: SearchCatalogResult | null
    searchCountsRequest?: SearchCountsRequest | null
    searchCountsResult?: SearchCountsResult | null
    searchDiscoverResult?: SearchDiscoverResult | null
    searchExplainResult?: SearchExplainResult | null
    searchMembershipRequest?: SearchMembershipRequest | null
    searchMembershipResult?: SearchMembershipResult | null
    searchQuery?: SearchQuery | null
    searchResultPage?: SearchResultPage | null
    searchValuesResult?: SearchValuesResult | null
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
 * ``POST /search/ancestor-counts``: how many of a search's matches each
 * of these containers holds, below it at any depth — from the session the
 * search returned. The search's ``ancestor`` facet lists the fullest
 * containers; this answers for any container, e.g. the ones on screen.
 */
export interface SearchAncestorCountsRequest {
    scope: SearchScope
    sessionId: Sessionid
    urns: Urns
}
/**
 * Bounds the search.
 *
 * ``view_id`` is **required** — every search must be bound to a view
 * (for security + telemetry), but the *scope* of the search is now
 * controlled by ``scope_mode``:
 *
 *   * ``visible`` (default UI mode): only the URNs the user can
 *     actually see right now on the canvas (passed in
 *     ``visible_urns``). This is the "fast feedback" mode that
 *     matches the user's mental model of "search what's in front of
 *     me." Falls back to ``view`` mode when ``visible_urns`` is
 *     empty.
 *
 *   * ``view``: classic behaviour — the view's authorised roots,
 *     expanded via containment, then narrowed by client hints.
 *
 *   * ``data_source``: power-user override. Searches the entire data
 *     source (no view containment clamp). Results may include URNs
 *     that are not in this view; the FE surfaces a disclaimer.
 *
 * ``root_urns`` / ``entity_types`` / ``layer_assignment`` / ``max_depth``
 * are **narrowing hints** that always apply (regardless of mode).
 * The resolver intersects them with the view's authorised scope.
 */
export interface SearchScope {
    entityTypes?: Entitytypes
    layerAssignment?: Layerassignment
    maxDepth?: Maxdepth
    rootUrns?: Rooturns
    scopeMode?: Scopemode
    viewId: Viewid
    visibleUrns?: Visibleurns
}
export interface SearchAncestorCountsResult {
    counts?: Counts
    status: Status
}
/**
 * Every requested urn → its count (0: none).
 */
export interface Counts {
    [k: string]: SearchAncestorCount
}
export interface SearchAncestorCount {
    count: Count
    displayName?: Displayname
    entityType?: Entitytype
    typeCounts?: Typecounts
}
/**
 * The same matches by entity type.
 */
export interface Typecounts {
    [k: string]: number
}
/**
 * ``POST /search/catalog``: every property the view's entities carry —
 * on how many, stored as which kinds, with which values — read from every
 * entity in its scope, not a sample. A large view takes more than one
 * request: send it again with the returned ``sessionId`` until ``status``
 * is ``complete``.
 */
export interface SearchCatalogRequest {
    refresh?: Refresh
    scope: SearchScope
    sessionId?: Sessionid1
    waitMs?: Waitms
}
export interface SearchCatalogResult {
    asOf?: Asof
    dataVersion?: Dataversion
    entities?: Entities
    entityTypes?: Entitytypes1
    notes?: Notes1
    progress?: SearchProgress | null
    properties?: Properties
    sessionId: Sessionid2
    stale?: Stale
    status: Status1
    tagged?: Tagged
    tags?: Tags
}
export interface SearchCatalogEntityType {
    count: Count1
    type: Type
}
/**
 * How far a running search has got. Node counts are the scan's
 * estimate of what each part of the graph holds, so ``scanned / total``
 * is a fraction to draw, not a count to report.
 */
export interface SearchProgress {
    matched: Matched
    scanned: Scanned
    total: Total
}
export interface SearchCatalogProperty {
    byEntityType?: Byentitytype
    count: Count2
    distinct: Distinct
    distinctExact: Distinctexact
    key: Key
    kinds?: Kinds
    max?: Max
    min?: Min
    residual?: Residual
    values?: Values
}
export interface Byentitytype {
    [k: string]: number
}
/**
 * Entities per kind the value is stored as. Two kinds compare as two.
 */
export interface Kinds {
    [k: string]: number
}
export interface SearchCatalogValue {
    count: Count3
    kind: Kind
    value: unknown
}
export interface SearchCatalogTag {
    count: Count4
    tag: Tag
}
/**
 * ``POST /search/counts``: how many entities in the view match each
 * rule — exactly, however many. A count over a large view takes more than
 * one request: send the same request again with the returned ``sessions``
 * until every count is complete.
 */
export interface SearchCountsRequest {
    items: Items
    scope: SearchScope
    sessions?: Sessions
    waitMs?: Waitms1
}
/**
 * One rule (or saved query) to evaluate: an id the caller chose, and
 * its predicate.
 */
export interface SearchRuleItem {
    id: Id
    predicate: Predicate
}
/**
 * Free-form text match against a single field (or ``any``).
 */
export interface TextPredicate {
    boost?: Boost
    caseSensitive?: Casesensitive
    kind?: Kind1
    match?: Match
    propertyKey?: Propertykey
    target?: Target
    value: Value
}
/**
 * Typed comparison against a single user-property.
 *
 * ``value_type`` says how stored values are read — under ``number`` a
 * stored "15" is 15, under ``string`` a stored 15 is "15" — and the
 * comparison holds for any stored kind, a list included (it matches when
 * an element does). ``value`` is shaped by ``op``: one value, a list
 * (``in`` / ``notIn`` / ``containsAll``), ``[lo, hi]`` (``between``), an
 * ISO duration such as ``"P30D"`` (``withinLast``) or nothing (``isSet``,
 * ``isEmpty`` and their negations). An integer beyond 2^53 is best sent
 * as its digits in a string with ``value_type='number'``: it is compared
 * exactly. Text comparisons are case-insensitive unless
 * ``case_sensitive``. ``include_missing`` lets ``neq`` / ``notIn`` /
 * ``notContains`` match entities without the key. The full contract is
 * ``backend/common/search_semantics``.
 */
export interface PropertyPredicate {
    caseSensitive?: Casesensitive1
    includeMissing?: Includemissing
    key: Key1
    kind?: Kind2
    op?: Op
    value?: unknown
    valueType?: Valuetype
}
/**
 * Match against the (currently JSON-stringified) ``n.tags`` field.
 *
 * Tags remain stringified in this workstream — see the storage-refactor
 * commit. Server-side this maps to ``n.tags CONTAINS $tag`` per value,
 * composed by ``op``.
 */
export interface TagPredicate {
    kind?: Kind3
    op?: Op1
    values: Values1
}
/**
 * "Does this node have a property named X" — key presence only.
 *
 * Compiles to ``EXISTS(n.<key>)`` (or ``NOT EXISTS`` when ``negate``).
 * Native-property storage makes this cheap; pre-refactor this required
 * parsing the blob in Python for every node.
 *
 * ``key_match`` searches by the NAME instead: ``prefix`` / ``contains``
 * match any user property whose name starts with / contains ``key``,
 * case-insensitively ("a property whose name contains 'owner'").
 */
export interface HasPropertyPredicate {
    key: Key2
    keyMatch?: Keymatch
    kind?: Kind4
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
    kind?: Kind5
    maxDepth?: Maxdepth1
    urns: Urns1
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
    kind?: Kind9
    urns: Urns2
}
/**
 * Typed comparison against a single edge property.
 *
 * Evaluated against each traversed relationship inside a
 * ``PathPredicate`` or ``WithinHopsPredicate``, inside an
 * ``ALL(rel IN relationships(p) …)`` block. The comparison itself is
 * ``PropertyPredicate``'s — same operators, value shapes and types.
 */
export interface EdgePropertyPredicate {
    caseSensitive?: Casesensitive2
    includeMissing?: Includemissing1
    key: Key3
    kind?: Kind6
    op?: Op2
    value?: unknown
    valueType?: Valuetype1
}
/**
 * Key-presence predicate against an edge. Compiles to
 * ``EXISTS(rel.<key>)`` (or ``NOT EXISTS`` when ``negate``).
 */
export interface EdgeHasPropertyPredicate {
    key: Key4
    kind?: Kind7
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
    kind?: Kind8
    op?: Op3
}
/**
 * Restrict matches to (or away from) specific entity types.
 *
 * Equivalent expressivity to ``scope.entity_types``, but composable
 * inside OR groups.
 */
export interface EntityTypePredicate {
    kind?: Kind10
    op?: Op4
    values: Values2
}
/**
 * Match the view's layer assignment (Source / Staging / Refinery / …).
 */
export interface LayerPredicate {
    kind?: Kind11
    layerAssignment: Layerassignment1
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
    kind?: Kind12
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
    kind?: Kind13
}
/**
 * Sugar: nodes with zero outgoing edges of the given class
 * ("dead ends"). Normalises to
 * ``DegreePredicate(direction='out', op='eq', value=0)``.
 */
export interface IsLeafPredicate {
    edgeClass?: Edgeclass3
    edgeTypes?: Edgetypes3
    kind?: Kind14
}
/**
 * Sugar: nodes with zero incoming edges of the given class
 * ("nobody produces this"). Normalises to
 * ``DegreePredicate(direction='in', op='eq', value=0)``.
 */
export interface IsRootPredicate {
    edgeClass?: Edgeclass4
    edgeTypes?: Edgetypes4
    kind?: Kind15
}
/**
 * Sugar: nodes with at least one incoming edge of the given class.
 * Normalises to ``DegreePredicate(direction='in', op='gt', value=0)``.
 */
export interface HasIncomingPredicate {
    edgeClass?: Edgeclass5
    edgeTypes?: Edgetypes5
    kind?: Kind16
}
/**
 * Sugar: nodes with at least one outgoing edge of the given class.
 * Normalises to ``DegreePredicate(direction='out', op='gt', value=0)``.
 */
export interface HasOutgoingPredicate {
    edgeClass?: Edgeclass6
    edgeTypes?: Edgetypes6
    kind?: Kind17
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
    kind?: Kind18
    maxHops?: Maxhops
    maxPaths?: Maxpaths
    sourceUrns: Sourceurns
    targetUrns: Targeturns
}
/**
 * Every entity in scope — "all in this view", "count everything".
 *
 * An ``and`` group with no children would mean the same, and the model
 * refuses one on purpose: a client bug that dropped every condition must
 * not quietly match the whole view. Asking for everything is spelled out.
 */
export interface MatchAllPredicate {
    kind?: Kind19
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
    kind?: Kind20
    op?: Op6
}
/**
 * Rule id → the session a previous answer returned.
 */
export interface Sessions {
    [k: string]: string
}
export interface SearchCountsResult {
    counts?: Counts1
    dataVersion?: Dataversion1
    elapsedMs?: Elapsedms
}
export interface Counts1 {
    [k: string]: SearchRuleCount
}
export interface SearchRuleCount {
    count: Count5
    error?: Error
    progress?: SearchProgress | null
    sessionId?: Sessionid3
    status: Status2
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
    elapsedMs?: Elapsedms1
    labels?: Labels
    missingContainment?: Missingcontainment
    missingSearchableText?: Missingsearchabletext
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
    truncatedProperties?: Truncatedproperties
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
    notes?: Notes2
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
 * ``POST /search/membership``: which of these entities — the ones on
 * screen — match which rules. Answers only for entities inside the view's
 * scope; one outside it never matches, whatever it holds.
 */
export interface SearchMembershipRequest {
    items: Items1
    scope: SearchScope
    urns: Urns3
}
export interface SearchMembershipResult {
    dataVersion?: Dataversion2
    elapsedMs?: Elapsedms2
    errors?: Errors
    matches?: Matches
}
/**
 * Rule id → why it could not be evaluated. Such a rule matches nothing here.
 */
export interface Errors {
    [k: string]: string
}
/**
 * Rule id → the requested urns it matches (in scope).
 */
export interface Matches {
    [k: string]: string[]
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
    predicate: Predicate1
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
    candidateCap?: Candidatecap
    cursor?: Cursor
    highlights?: Highlights
    includeAncestorPath?: Includeancestorpath
    pageSize?: Pagesize
    results?: Results
    sessionId?: Sessionid4
    softDeadlineMs?: Softdeadlinems
    sort?: Sort
    sortDir?: Sortdir
    sortProperty?: Sortproperty
    waitMs?: Waitms2
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
    propertyKey?: Propertykey1
    sampleHitsPerBucket?: Samplehitsperbucket
    /**
     * One-level nested drill. Deeper levels require a follow-up scoped search (see module docstring).
     */
    subAggregation?: AggregationSpec | null
}
/**
 * Provider + service response. One inner list in ``aggregates`` per
 * requested AggregationSpec.
 */
export interface SearchResultPage {
    aggregates?: Aggregates
    cacheHit?: Cachehit
    candidateCount?: Candidatecount
    countStatus?: Countstatus
    cursor?: Cursor1
    dataVersion?: Dataversion3
    deadlineExceeded?: Deadlineexceeded
    elapsedMs: Elapsedms3
    hits?: Hits
    paths?: Paths
    progress?: SearchProgress | null
    queryExplain?: QueryExplain | null
    /**
     * Resolved-scope + ontology diagnostics. Surfaced on every response so the FE can interpret 0-result cases without round-tripping to /search/explain.
     */
    scopeDiagnostics?: ScopeDiagnostics | null
    sessionId?: Sessionid5
    stale?: Stale1
    status?: Status3
    totalCount?: Totalcount
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
    typeCounts?: Typecounts1
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
    displayName: Displayname1
    entityType: Entitytype1
    urn: Urn
}
/**
 * Where in a hit's text the match landed, for ``<mark>`` rendering.
 */
export interface SearchHighlight {
    field: Field
    ranges?: Ranges
    score?: Score
    snippet: Snippet
}
export interface GraphNode {
    childCount?: Childcount
    description?: Description
    displayName: Displayname2
    entityType: Entitytype2
    lastSyncedAt?: Lastsyncedat
    layerAssignment?: Layerassignment2
    properties?: Properties1
    qualifiedName?: Qualifiedname
    sourceSystem?: Sourcesystem
    tags?: Tags1
    urn: Urn1
    version?: Version
}
export interface Properties1 {
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
    properties?: Properties2
    sourceUrn: Sourceurn
    targetUrn: Targeturn
}
export interface Properties2 {
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
    notes?: Notes3
}
/**
 * Response shape for ``GET /search/values``: a property's most common
 * values across the view's entity types — the value picker's list.
 *
 * Suggestions, not statistics: the scan is time-bounded, so ``complete``
 * says whether every type was read and ``truncated`` whether a type had
 * more distinct values than listed (a count may then be an undercount).
 */
export interface SearchValuesResult {
    complete?: Complete
    elapsedMs?: Elapsedms4
    key: Key5
    truncated?: Truncated1
    values?: Values3
}
/**
 * One distinct value of a property and how many times it is stored.
 * ``value`` keeps its stored kind — a 19-digit id is that integer.
 */
export interface SearchValueSuggestion {
    count?: Count6
    value?: unknown
}
