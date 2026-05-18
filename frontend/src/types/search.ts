/**
 * TypeScript mirror of `backend/common/models/search.py`.
 *
 * The wire format is the Pydantic alias shape (camelCase) — these
 * types match what the backend accepts on POST /search/advanced and
 * what it returns. Keep in sync with the Python models; mismatch
 * surfaces as a 422 from FastAPI.
 *
 * See the backend module's docstring for the design rationale
 * (aggregation-first defaults, predicate tree, v1 capability surface).
 */

import type { GraphNode } from '@/providers/GraphDataProvider'

// ---------------------------------------------------------------------------
// Leaf predicates — each carries a literal `kind` discriminator
// ---------------------------------------------------------------------------

export type TextMatchMode = 'exact' | 'prefix' | 'substring' | 'fulltext' | 'regex'

export type TextTarget =
    | 'name'
    | 'qualifiedName'
    | 'description'
    | 'tags'
    | 'property'
    | 'any'

export interface TextPredicate {
    kind: 'text'
    value: string
    target?: TextTarget                  // default 'any'
    /** Required when target='property'. */
    propertyKey?: string
    match?: TextMatchMode                // default 'substring'
    caseSensitive?: boolean              // default false
    boost?: number                       // default 1.0; used only when match='fulltext'
}

export type PropertyOp =
    | 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'
    | 'in' | 'notIn' | 'contains' | 'startsWith' | 'endsWith' | 'between'

export interface PropertyPredicate {
    kind: 'property'
    key: string
    op?: PropertyOp                      // default 'eq'
    value?: unknown                      // primitive | array | [lo, hi] for 'between'
    caseSensitive?: boolean              // default false
}

export type TagOp = 'has' | 'hasAll' | 'hasAny' | 'notHas'

export interface TagPredicate {
    kind: 'tag'
    values: string[]
    op?: TagOp                           // default 'has'
}

export interface HasPropertyPredicate {
    kind: 'hasProperty'
    key: string
    negate?: boolean                     // default false
}

export interface DescendantOfPredicate {
    kind: 'descendantOf'
    urns: string[]
    maxDepth?: number
}

export interface WithinHopsPredicate {
    kind: 'withinHops'
    urns: string[]
    hops: number
    edgeTypes?: string[]
    direction?: 'out' | 'in' | 'both'    // default 'both'
}

export interface EntityTypePredicate {
    kind: 'entityType'
    values: string[]
    op?: 'in' | 'notIn'                  // default 'in'
}

export interface LayerPredicate {
    kind: 'layer'
    layerAssignment: string
}

// ---------------------------------------------------------------------------
// Recursive group + discriminated union
// ---------------------------------------------------------------------------

export interface GroupPredicate {
    kind: 'group'
    op?: 'and' | 'or' | 'not'            // default 'and'; 'not' must have exactly 1 child
    children: Predicate[]
}

export type Predicate =
    | TextPredicate
    | PropertyPredicate
    | TagPredicate
    | HasPropertyPredicate
    | DescendantOfPredicate
    | WithinHopsPredicate
    | EntityTypePredicate
    | LayerPredicate
    | GroupPredicate

// ---------------------------------------------------------------------------
// Aggregations
// ---------------------------------------------------------------------------

export type AggregationKind =
    | 'ancestorType'
    | 'ancestorLevel'
    | 'parent'
    | 'tag'
    | 'entityType'
    | 'property'

export interface AggregationSpec {
    by?: AggregationKind                 // default 'ancestorType'
    /** Required when by='ancestorType'. */
    ancestorEntityTypes?: string[]
    /** Required when by='ancestorLevel'. */
    ancestorLevel?: number
    /** Required when by='property' — the native node property to group by. */
    propertyKey?: string
    maxBuckets?: number                  // default 50
    sampleHitsPerBucket?: number         // default 3
    /** One-level nested drill. */
    subAggregation?: AggregationSpec
}

// ---------------------------------------------------------------------------
// Scope + options + request
// ---------------------------------------------------------------------------

export type ResultShape = 'aggregates' | 'hits' | 'both'

export interface SearchScope {
    rootUrns?: string[]
    maxDepth?: number                    // default 12
    entityTypes?: string[]
    layerAssignment?: string
}

export type SortKey =
    | 'relevance'
    | 'displayName'
    | 'qualifiedName'
    | 'depth'
    | 'matchCount'

export interface SearchOptions {
    results?: ResultShape                // default 'aggregates'
    aggregations?: AggregationSpec[]
    pageSize?: number                    // default 50
    cursor?: string
    sort?: SortKey                       // default 'relevance'
    /** When set, hits ordered by this native node property (e.g. 'rowCount'); overrides `sort`. */
    sortProperty?: string
    sortDir?: 'asc' | 'desc'             // default 'desc'
    includeAncestorPath?: boolean        // default false
    highlights?: boolean                 // default true
    softDeadlineMs?: number              // default 3000
}

export interface SearchQuery {
    predicate: Predicate
    scope?: SearchScope
    options?: SearchOptions
}

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

export interface SearchHighlight {
    field: string
    snippet: string
    score?: number
}

export interface AncestorRef {
    urn: string
    displayName: string
    entityType: string
}

export interface SearchHit {
    node: GraphNode
    score?: number
    matchedPredicates?: number[]
    highlights?: SearchHighlight[]
    ancestorPath?: AncestorRef[]
}

export interface SearchAggregateBucket {
    ancestorUrn: string
    ancestorDisplayName: string
    ancestorEntityType: string
    ancestorDepthFromScopeRoot: number
    matchCount: number
    sampleHits: SearchHit[]
    subBuckets?: SearchAggregateBucket[]
}

export interface QueryExplain {
    cypher: string
    estimatedRows?: number
    costScore: number
    notes: string[]
}

export interface SearchResultPage {
    /** One inner array per AggregationSpec in the request. */
    aggregates?: SearchAggregateBucket[][] | null
    hits?: SearchHit[] | null
    cursor?: string | null
    truncated: boolean
    candidateCount: number
    deadlineExceeded: boolean
    elapsedMs: number
    cacheHit: boolean
    queryExplain?: QueryExplain | null
}
