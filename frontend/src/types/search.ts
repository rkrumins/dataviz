/**
 * Curated façade over the auto-generated SearchQuery types.
 *
 * The single source of truth for the Search API contract is the
 * Pydantic model at:
 *   backend/common/models/search.py
 *
 * It's exported as JSON Schema by `backend/scripts/export_search_schema.py`
 * and compiled to TypeScript by `frontend/scripts/gen-search-schema.mjs`
 * into `./generated/searchquery.ts`. **Do not hand-edit the types in
 * the generated file or this one without first changing Pydantic and
 * regenerating.**
 *
 * This file's job is twofold:
 *   1. Re-export the named interfaces from the generated file so the
 *      rest of the codebase keeps using stable names
 *      (`TextPredicate`, `SearchQuery`, `Predicate`, …).
 *   2. Define ergonomic literal-union aliases (`TextMatchMode`,
 *      `PropertyOp`, …) by **deriving them from the generated types**
 *      via TypeScript lookup types. Drift between the aliases and the
 *      source is impossible because they're sourced from it.
 *
 * Anything that isn't part of the generated SearchApiContract
 * (e.g. `NLSearchResponse`, which W9 removes; transitional shapes) is
 * kept here as a temporary hand-written type, clearly marked.
 */

import type { GraphNode } from '@/providers/GraphDataProvider'

import type {
    SearchQuery as GenSearchQuery,
    SearchScope as GenSearchScope,
    SearchOptions as GenSearchOptions,
    SearchResultPage as GenSearchResultPage,
    SearchHit as GenSearchHit,
    SearchHighlight as GenSearchHighlight,
    AncestorRef as GenAncestorRef,
    PathHit as GenPathHit,
    EdgeRef as GenEdgeRef,
    SearchAggregateBucket as GenSearchAggregateBucket,
    AggregationSpec as GenAggregationSpec,
    TextPredicate as GenTextPredicate,
    PropertyPredicate as GenPropertyPredicate,
    TagPredicate as GenTagPredicate,
    HasPropertyPredicate as GenHasPropertyPredicate,
    DescendantOfPredicate as GenDescendantOfPredicate,
    WithinHopsPredicate as GenWithinHopsPredicate,
    EntityTypePredicate as GenEntityTypePredicate,
    LayerPredicate as GenLayerPredicate,
    DegreePredicate as GenDegreePredicate,
    IsOrphanPredicate as GenIsOrphanPredicate,
    IsLeafPredicate as GenIsLeafPredicate,
    IsRootPredicate as GenIsRootPredicate,
    HasIncomingPredicate as GenHasIncomingPredicate,
    HasOutgoingPredicate as GenHasOutgoingPredicate,
    PathPredicate as GenPathPredicate,
    GroupPredicate as GenGroupPredicate,
    EdgePropertyPredicate as GenEdgePropertyPredicate,
    EdgeHasPropertyPredicate as GenEdgeHasPropertyPredicate,
    EdgeGroupPredicate as GenEdgeGroupPredicate,
    Predicate as GenPredicate,
    SearchExplainResult as GenSearchExplainResult,
    SearchDiscoverResult as GenSearchDiscoverResult,
    ScopeDiagnostics as GenScopeDiagnostics,
} from './generated/searchquery'


// ---------------------------------------------------------------------------
// Predicate interfaces — re-export under their canonical names
// ---------------------------------------------------------------------------

export type TextPredicate = GenTextPredicate
export type PropertyPredicate = GenPropertyPredicate
export type TagPredicate = GenTagPredicate
export type HasPropertyPredicate = GenHasPropertyPredicate
export type DescendantOfPredicate = GenDescendantOfPredicate
export type WithinHopsPredicate = GenWithinHopsPredicate
export type EntityTypePredicate = GenEntityTypePredicate
export type LayerPredicate = GenLayerPredicate
export type DegreePredicate = GenDegreePredicate
export type IsOrphanPredicate = GenIsOrphanPredicate
export type IsLeafPredicate = GenIsLeafPredicate
export type IsRootPredicate = GenIsRootPredicate
export type HasIncomingPredicate = GenHasIncomingPredicate
export type HasOutgoingPredicate = GenHasOutgoingPredicate
export type PathPredicate = GenPathPredicate
export type GroupPredicate = GenGroupPredicate
export type EdgePropertyPredicate = GenEdgePropertyPredicate
export type EdgeHasPropertyPredicate = GenEdgeHasPropertyPredicate
export type EdgeGroupPredicate = GenEdgeGroupPredicate
export type Predicate = GenPredicate

/** The three edge-predicate kinds in one union — convenience alias the
 *  builder uses when traversing edge-predicate sub-trees. */
export type EdgePredicateNode =
    | EdgePropertyPredicate
    | EdgeHasPropertyPredicate
    | EdgeGroupPredicate


// ---------------------------------------------------------------------------
// Ergonomic literal-union aliases — derived from the generated types
// via lookup. If the Pydantic model gains a new TextMatchMode value,
// `TextMatchMode` here updates automatically on the next codegen run.
// ---------------------------------------------------------------------------

export type TextMatchMode = NonNullable<GenTextPredicate['match']>
export type TextTarget = NonNullable<GenTextPredicate['target']>
export type PropertyOp = NonNullable<GenPropertyPredicate['op']>
export type TagOp = NonNullable<GenTagPredicate['op']>
export type PathDirection = NonNullable<GenPathPredicate['direction']>
export type EdgeClass = NonNullable<GenPathPredicate['edgeClass']>
export type DegreeOp = NonNullable<GenDegreePredicate['op']>
export type DegreeDirection = NonNullable<GenDegreePredicate['direction']>
export type AggregationKind = NonNullable<GenAggregationSpec['by']>
export type ResultShape = NonNullable<GenSearchOptions['results']>
export type SortKey = NonNullable<GenSearchOptions['sort']>


// ---------------------------------------------------------------------------
// Containers — request / scope / options
// ---------------------------------------------------------------------------

export type AggregationSpec = GenAggregationSpec
export type SearchScope = GenSearchScope
export type SearchOptions = GenSearchOptions
export type SearchQuery = GenSearchQuery


// ---------------------------------------------------------------------------
// Response shapes — tightened versions of the generated types.
//
// Pydantic's ``Field(default_factory=list)`` produces optional fields
// in JSON Schema (the FE may omit them on input). But on the *response*
// side, the server always emits these fields — they're populated
// invariants. We lift the affected keys to required here so FE
// callsites can read them without ``?.`` everywhere.
// ---------------------------------------------------------------------------

/** Like Required<T> but only for the listed keys; other keys keep their optionality. */
type RequireKeys<T, K extends keyof T> = Omit<T, K> & { [P in K]-?: T[P] }

export type SearchHighlight = GenSearchHighlight
export type AncestorRef = GenAncestorRef
export type EdgeRef = GenEdgeRef
export type PathHit = GenPathHit

export type SearchAggregateBucket = RequireKeys<
    GenSearchAggregateBucket,
    'ancestorUrn' | 'ancestorDisplayName' | 'ancestorEntityType' |
    'ancestorDepthFromScopeRoot' | 'matchCount' | 'sampleHits'
>

/**
 * The generated `SearchHit.node` shape is the JSON-Schema-derived
 * `GraphNode`, which is structurally subset of the existing
 * `@/providers/GraphDataProvider`'s `GraphNode`. The FE has used the
 * provider's type historically (it carries extra adjacency fields the
 * canvas reads). We patch `node` here to keep the provider's shape so
 * downstream components compile unchanged.
 */
export type SearchHit = Omit<GenSearchHit, 'node'> & { node: GraphNode }

export type SearchResultPage = RequireKeys<
    Omit<GenSearchResultPage, 'hits' | 'aggregates' | 'scopeDiagnostics'> & {
        hits?: SearchHit[] | null
        aggregates?: SearchAggregateBucket[][] | null
        scopeDiagnostics?: ScopeDiagnostics | null
    },
    'truncated' | 'candidateCount' | 'deadlineExceeded' | 'elapsedMs' | 'cacheHit'
>

export type SearchExplainResult = GenSearchExplainResult

/** One entry in the discover response's `labels` map — tightened so
 *  `sampled` and `keys` are non-optional (server always populates). */
export type SearchDiscoverLabelInfo = RequireKeys<
    NonNullable<NonNullable<GenSearchDiscoverResult['labels']>[string]>,
    'sampled' | 'keys'
>

/** Tighten labels + per-label info: the server always populates them, even if empty. */
export type SearchDiscoverResult = RequireKeys<
    Omit<GenSearchDiscoverResult, 'labels'> & {
        labels: Record<string, SearchDiscoverLabelInfo>
    },
    'labels' | 'blobOnlyLabels' | 'missingContainment' | 'elapsedMs'
>


// ---------------------------------------------------------------------------
// One entry in the discover response's `labels` map — historical name
// in the codebase. The generated equivalent is `SearchDiscoverLabelInfo`;
// kept as `SearchDiscoverLabel` here so existing callsites compile.
// ---------------------------------------------------------------------------

export type SearchDiscoverLabel = SearchDiscoverLabelInfo


// ---------------------------------------------------------------------------
// Backwards-compat type — not part of the generated contract.
//
// `QueryExplain` was a legacy field on SearchResultPage.queryExplain.
// Nothing on the current backend populates it; the explain endpoint
// returns `SearchExplainResult` instead. Kept as a stub so existing
// imports compile; remove with W9 cleanup.
// ---------------------------------------------------------------------------

export interface QueryExplain {
    cypher: string
    estimatedRows?: number
    costScore: number
    notes: string[]
}


export type ScopeDiagnostics = RequireKeys<
    GenScopeDiagnostics,
    'effectiveRootUrns' | 'effectiveMaxDepth' | 'droppedRootUrns' |
    'lineageEdgeTypes' | 'containmentEdgeTypes' | 'notes'
>


// ---------------------------------------------------------------------------
// NL Ask response — W9 removes this surface. Kept here only so the
// remaining importers in `AskTab.tsx` and `RemoteGraphProvider.ts`
// compile until they're deleted in W9.
// ---------------------------------------------------------------------------

/** @deprecated NL Ask tab is dropped in v1 (W9). */
export interface NLSearchResponse {
    interpretedQuery: SearchQuery
    interpretationNotes: string
    modelUsed: string
    conversationId: string
    results: SearchResultPage
}
