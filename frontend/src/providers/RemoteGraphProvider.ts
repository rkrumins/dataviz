import { unwrapEnvelope } from '@/services/cacheEnvelope'
import { getCircuitBreaker, classifyEndpoint } from '@/services/circuitBreaker'
import { fetchWithTimeout } from '@/services/fetchWithTimeout'
import { TIMEOUTS } from '@/config/timeouts'
import { useProviderHealthStore } from '@/store/providerHealth'
import { useCacheStalenessStore } from '@/store/cacheStaleness'

import type {
    GraphDataProvider,
    GraphNode,
    GraphEdge,
    EntityType,
    URN,
    NodeQuery,
    EdgeQuery,
    LineageResult,
    ContainmentResult,
    TraceOptions,
    TraceV2Request,
    TraceV2Result,
    TraceClosureRequest,
    TraceClosureFrontierNode,
    LensClosureExtras,
    ExpandAggregatedRequest,
    ExpandAggregatedBatchRequest,
    LayerAssignmentRequest,
    LayerAssignmentResult,
    GraphSchemaStats,
    OntologyMetadata,
    GraphSchema,
    AggregatedEdgeRequest,
    AggregatedEdgeResult,
    CreateNodeRequest,
    CreateNodeResult,
    CreateEdgeRequest,
    EdgeMutationResult,
    TopLevelNodesQuery,
    TopLevelNodesResult,
} from './GraphDataProvider'
import type { TraceMeta } from '@/services/traceApi'
import type {
    SearchQuery,
    SearchResultPage,
    SearchExplainResult,
    SearchDiscoverResult,
} from '@/types/search'
import type { JsonSchemaDocument } from '@/types/jsonSchema'

// Wire shape from POST /trace/v2 — `upstreamUrns`/`downstreamUrns` arrive as
// JSON arrays (Pydantic serializes Set as list); we re-hydrate to Set on read.
interface RawTraceV2Result {
    nodes: GraphNode[]
    edges: GraphEdge[]
    containmentEdges: GraphEdge[]
    upstreamUrns: URN[]
    downstreamUrns: URN[]
    focus: { urn: URN; level: number; entityType: string }
    effectiveLevel: number
    isInherited: boolean
    inheritedFromUrn?: string | null
    truncated: boolean
    truncationReason?: string | null
    /** Optional sidecar metadata — only present when the v2 envelope emits it. */
    meta?: TraceMeta
}

// Wire shape from POST /trace/closure — RawTraceV2Result plus the three
// closure-only fields, pre-normalization.
interface RawTraceClosureResult extends RawTraceV2Result {
    frontierUp?: TraceClosureFrontierNode[]
    frontierDown?: TraceClosureFrontierNode[]
    seedTruncated?: boolean
}

function normalizeTraceV2(raw: RawTraceV2Result): TraceV2Result {
    return {
        ...raw,
        upstreamUrns: new Set(raw.upstreamUrns ?? []),
        downstreamUrns: new Set(raw.downstreamUrns ?? []),
        containmentEdges: raw.containmentEdges ?? [],
        meta: raw.meta,
    }
}

const API_BASE = '/api/v1'

export interface RemoteGraphProviderOptions {
    /** Workspace ID. When set, routes through /v1/{ws_id}/graph/... */
    workspaceId?: string
    /** Data source ID. When set, appended as ?dataSourceId= to workspace-scoped routes. */
    dataSourceId?: string
    /**
     * Draft branch ID. When set, appended as ?branchId= so every read serves the
     * draft (composed base+overlay) instead of live main. Omit for trunk/main.
     */
    branchId?: string
    /**
     * View-capability context. When set, appended as ?viewId= to every
     * workspace-scoped request so the backend can authorize callers who
     * can read this view but hold no workspace membership (shared /
     * enterprise views open read-only). Harmless for members — their
     * membership path short-circuits first.
     */
    viewId?: string
    /** @deprecated Legacy connection ID. Use workspaceId instead. */
    connectionId?: string
}

export class RemoteGraphProvider implements GraphDataProvider {
    readonly name = 'RemoteGraphProvider'

    private readonly workspaceId?: string
    private readonly dataSourceId?: string
    private readonly branchId?: string
    private readonly viewId?: string
    private readonly connectionId?: string

    /** (workspace, data source, branch, view) identity — client caches keyed
     *  by URN fold this in so the same URN across two graphs (or two
     *  capability contexts) can't collide. */
    get scopeKey(): string {
        return `${this.workspaceId ?? ''}:${this.dataSourceId ?? ''}:${this.branchId ?? this.connectionId ?? ''}:${this.viewId ?? ''}`
    }

    /** In-flight request deduplication: identical concurrent requests share one Promise */
    private _inflight = new Map<string, Promise<unknown>>()

    /** Short-lived response cache for GET requests (prevents rapid re-fetches during re-renders) */
    private _responseCache = new Map<string, { data: unknown; ts: number; ttl: number }>()
    /** Fallback TTL for endpoints not matched in {@link responseCacheTtlMs}. */
    private static DEFAULT_RESPONSE_CACHE_TTL_MS = 2000

    constructor(options?: RemoteGraphProviderOptions) {
        this.workspaceId = options?.workspaceId
        this.dataSourceId = options?.dataSourceId
        this.branchId = options?.branchId
        this.viewId = options?.viewId
        this.connectionId = options?.connectionId
    }

    /**
     * Per-endpoint response cache TTL. Hot read paths (children, edges,
     * top-level) sit at 30s so a "expand all" or zoom-out doesn't re-fire
     * the same query against FalkorDB on every render — backend cache
     * (Phase 1) will extend the same window server-side. Metadata reads
     * (schema/ontology) sit at 60s because they change rarely. Anything
     * else falls through to the legacy 2s window via DEFAULT.
     *
     * Match is by the first url path segment after `/graph/` (or the
     * literal path when not workspace-scoped).
     */
    private static responseCacheTtlMs(path: string): number {
        // Strip query params and workspace/api prefix
        const pathOnly = path.split('?')[0]
        const seg = pathOnly.replace(/^\/api\/v\d+(\/[^/]+)?\/graph/, '')
        // Hot read paths — 30 s
        if (seg.includes('/children')) return 30_000
        // Edge scans get 45 s: the BACKEND budget for these is 40 s
        // (FALKORDB_EDGES_BETWEEN_TIMEOUT_SECS) — aborting at 30 s made
        // the client give up and retry while the server was still
        // scanning, doubling load on large graphs. Client timeout must
        // sit above the server's so the structured timeout surfaces.
        if (seg.startsWith('/edges/between') || seg.startsWith('/edges/query')) return 45_000
        if (seg.startsWith('/nodes/top-level')) return 30_000
        if (seg.startsWith('/nodes/query') || seg === '/search') return 30_000
        if (seg.match(/^\/nodes\/[^/]+\/(ancestors|descendants|parent)/)) return 30_000
        // Metadata/schema endpoints — 60 s (change rarely; cached server-side too)
        if (seg.startsWith('/metadata') || seg === '/introspection' || seg === '/stats') {
            return 60_000
        }
        // Default — preserve the legacy short window
        return RemoteGraphProvider.DEFAULT_RESPONSE_CACHE_TTL_MS
    }

    // ==========================================
    // URL builder — workspace path or legacy query param
    // ==========================================

    private buildUrl(path: string, extraParams?: Record<string, string>, apiVersion: 'v1' | 'v2' = 'v1'): string {
        // Workspace-scoped: /api/v{1,2}/{ws_id}/graph/...
        // v2 is used for trace endpoints (skeleton-first with meta) — legacy
        // v1 trace routes still exist but are deprecated. Non-trace calls
        // stay on v1.
        const base = this.workspaceId
            ? `/api/${apiVersion}/${this.workspaceId}/graph`
            : API_BASE

        const url = new URL(`${base}${path}`, window.location.origin)

        // Data source targeting within a workspace
        if (this.workspaceId && this.dataSourceId) {
            url.searchParams.set('dataSourceId', this.dataSourceId)
        }

        // Draft targeting: serve the draft branch (base+overlay) instead of live main.
        if (this.workspaceId && this.branchId) {
            url.searchParams.set('branchId', this.branchId)
        }

        // View-capability context: lets the backend authorize non-members
        // through their read access to this view. One line here puts it on
        // every graph/canvas/trace/search/metadata request — they all
        // funnel through buildUrl.
        if (this.workspaceId && this.viewId) {
            url.searchParams.set('viewId', this.viewId)
        }

        // Legacy fallback: append connectionId as query param
        if (!this.workspaceId && this.connectionId) {
            url.searchParams.set('connectionId', this.connectionId)
        }

        if (extraParams) {
            Object.entries(extraParams).forEach(([k, v]) => url.searchParams.set(k, v))
        }
        return url.pathname + url.search
    }

    // ==========================================
    // Internal Fetch Helper
    // ==========================================

    private async fetch<T>(path: string, options?: RequestInit & { extraParams?: Record<string, string>, timeoutMs?: number, apiVersion?: 'v1' | 'v2' }): Promise<T> {
        const { extraParams, timeoutMs, apiVersion, ...fetchOptions } = options ?? {}
        const method = (fetchOptions.method ?? 'GET').toUpperCase()
        const url = this.buildUrl(path, extraParams, apiVersion)
        const cacheKey = `${method}:${url}:${fetchOptions.body ?? ''}`

        // Check short-lived response cache for GET requests
        if (method === 'GET') {
            const cached = this._responseCache.get(cacheKey)
            if (cached && Date.now() - cached.ts < cached.ttl) {
                return cached.data as T
            }
        }

        // Deduplicate identical in-flight requests — skipped when the
        // caller supplies an AbortSignal. Sharing one promise would let
        // aborting a superseded call reject the identical superseding
        // call too (e.g. search-as-you-type re-firing the same text).
        if (!fetchOptions.signal) {
            const existing = this._inflight.get(cacheKey)
            if (existing) return existing as Promise<T>
        }

        const promise = this._doFetch<T>(url, fetchOptions, method, cacheKey, timeoutMs)
        if (!fetchOptions.signal) {
            this._inflight.set(cacheKey, promise)
        }
        return promise
    }

    private async _doFetch<T>(url: string, fetchOptions: RequestInit, method: string, cacheKey: string, timeoutMs?: number): Promise<T> {
        // Per-endpoint-class circuit breaker: a trace 504 opens only the
        // 'trace' breaker, never the browse (children/aggregated/canvas)
        // ones — the fix for "one dead endpoint blocked ALL graph reads".
        const circuitBreaker = getCircuitBreaker(
            this.workspaceId, this.dataSourceId, classifyEndpoint(url),
        )
        if (!circuitBreaker.canRequest()) {
            if (!fetchOptions.signal) this._inflight.delete(cacheKey)
            throw new Error('Provider unavailable (circuit open)')
        }

        try {
            // Use the global default timeout (5s). The graph endpoints
            // are all cache-only post-insights-refactor — they read from
            // Postgres and respond in <100ms; an empty/computing cache
            // surfaces as `meta.status="computing"` in the body, never
            // as a timeout. The legacy 12s window was sized for live
            // provider calls that no longer happen here.
            const response = await fetchWithTimeout(url, {
                ...fetchOptions,
                ...(timeoutMs !== undefined ? { timeoutMs } : {}),
                headers: {
                    'Content-Type': 'application/json',
                    ...fetchOptions?.headers,
                },
            })

            if (!response.ok) {
                const errorText = await response.text()
                const error = new Error(`API Error ${response.status}: ${errorText || response.statusText}`)
                // 5xx errors indicate provider/backend failure — feed circuit breaker
                if (response.status >= 500) {
                    // Honor Retry-After header from backend (sent on 503 ProviderUnavailable)
                    const retryAfter = response.headers.get('Retry-After')
                    const retryAfterMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : undefined
                    circuitBreaker.recordFailure(
                        retryAfterMs && !isNaN(retryAfterMs) ? retryAfterMs : undefined,
                    )
                }
                throw error
            }

            // Header-borne resilience signals from the backend GraphCache.
            // - ``X-Provider-Health``: 'healthy' | 'unreachable' — pushed
            //   into providerHealth store so the UI banner reacts faster
            //   than the 30s /health/providers poll cycle.
            // - ``X-Cache-Status: stale-fallback`` — backend served from
            //   the last-known-good snapshot; signal so the user sees a
            //   "data may be stale" hint near affected widgets.
            const providerHealth = response.headers.get('X-Provider-Health')
            if (providerHealth) {
                useProviderHealthStore.getState().markFromHeader(
                    this.workspaceId, this.dataSourceId, providerHealth,
                )
            }
            const cacheStatus = response.headers.get('X-Cache-Status')
            if (cacheStatus === 'stale-fallback') {
                useCacheStalenessStore.getState().markStale(
                    this.workspaceId, this.dataSourceId, url,
                )
            } else if (providerHealth === 'healthy') {
                // Fresh response from a healthy provider — clear any
                // stale flag for this scope so the banner disappears on
                // recovery without waiting for the TTL.
                useCacheStalenessStore.getState().clear(
                    this.workspaceId, this.dataSourceId,
                )
            }

            const data = await response.json() as T

            // Cache GET responses; TTL is per-endpoint (hot read paths 30s,
            // metadata 60s, default 2s) so a "expand all" doesn't re-fire
            // the same children query on every render.
            if (method === 'GET') {
                const ttl = RemoteGraphProvider.responseCacheTtlMs(url)
                this._responseCache.set(cacheKey, { data, ts: Date.now(), ttl })
            }

            circuitBreaker.recordSuccess()
            return data
        } catch (err) {
            // A caller-initiated abort (e.g. search-as-you-type superseding
            // its own previous request) surfaces here as the same generic
            // "timed out" TypeError a real client-side timeout would raise
            // — fetchWithTimeout's runOnce links both onto one internal
            // AbortController and can't tell them apart. It is not a
            // backend health signal, so it must not feed the breaker.
            if (fetchOptions.signal?.aborted) {
                throw err
            }
            if (err instanceof TypeError) {
                circuitBreaker.recordFailure()
                if (err.message.includes('timed out')) {
                    throw new Error(`Request timed out: ${method} ${url}`)
                }
            }
            throw err
        } finally {
            if (!fetchOptions.signal) this._inflight.delete(cacheKey)
        }
    }

    // ==========================================
    // Node Operations
    // ==========================================

    async getNode(urn: URN): Promise<GraphNode | null> {
        try {
            return await this.fetch<GraphNode>(`/nodes/${encodeURIComponent(urn)}`)
        } catch (error) {
            if (error instanceof Error && error.message.includes('404')) {
                return null
            }
            throw error
        }
    }

    async getNodes(query: NodeQuery): Promise<GraphNode[]> {
        // Use POST for complex queries
        return await this.fetch<GraphNode[]>('/nodes/query', {
            method: 'POST',
            body: JSON.stringify({ query }),
        })
    }

    async getNodeDegrees(urns: string[], edgeTypes?: string[]): Promise<Record<string, { in: number; out: number }>> {
        // Total lineage degree per URN over the FULL graph. A URN absent
        // from the response is UNKNOWN (its provider bucket failed) —
        // callers must never treat absence as zero.
        return await this.fetch<Record<string, { in: number; out: number }>>('/nodes/degree', {
            method: 'POST',
            body: JSON.stringify({ urns, edgeTypes }),
        })
    }

    async searchNodes(query: string, limit = 10): Promise<GraphNode[]> {
        return await this.fetch<GraphNode[]>('/search', {
            method: 'POST',
            body: JSON.stringify({ query, limit }),
        })
    }

    /**
     * Advanced server-side search (POST /search/advanced).
     *
     * Sends a structured `SearchQuery` predicate tree and receives an
     * aggregate-and/or-hit `SearchResultPage`. See `frontend/src/types/search.ts`
     * for the full contract and `backend/common/models/search.py` for the
     * authoritative shape.
     *
     * No client-side caching: search results depend on the full predicate
     * body which the GET-cache layer can't key on, and the backend will
     * grow its own Redis cache in workstream 3.
     */
    async searchAdvanced(query: SearchQuery, opts?: { signal?: AbortSignal }): Promise<SearchResultPage> {
        return await this.fetch<SearchResultPage>('/search/advanced', {
            method: 'POST',
            body: JSON.stringify(query),
            signal: opts?.signal,
            timeoutMs: TIMEOUTS.SEARCH_ADVANCED_MS,
        })
    }

    /**
     * Fetch the SearchQuery JSON Schema served by the backend.
     *
     * The body IS the canonical contract used by Ajv validation in the
     * JSON editor and by the schema-version assertion in `useSearchSchema`.
     * The schema's `properties.$schemaVersion` carries the wire-format
     * version (`Literal["1"]` today). The FE asserts that against the
     * version of `@synodic/search-schema` (or, in this worktree, the
     * `SCHEMA_VERSION` constant in `frontend/src/types/searchSchemaVersion.ts`)
     * to fail loud on protocol mismatches.
     *
     * Cached aggressively by the browser (Cache-Control: max-age=300 +
     * ETag) and once per app boot in React Query.
     */
    async searchSchema(): Promise<JsonSchemaDocument> {
        return await this.fetch<JsonSchemaDocument>('/search/schema')
    }

    /**
     * Compile a SearchQuery without executing it.
     *
     * Returns the Cypher + params that `searchAdvanced` would run,
     * plus diagnostic notes. Powers the dev panel's "Show Cypher"
     * button and is the first stop when a query silently returns 0
     * results.
     */
    async searchExplain(query: SearchQuery): Promise<SearchExplainResult> {
        return await this.fetch<SearchExplainResult>('/search/explain', {
            method: 'POST',
            body: JSON.stringify(query),
        })
    }

    /**
     * Discover what native node properties exist in the active graph.
     *
     * Per-label sample (cap = sample_per_label) of distinct native
     * property keys, plus a `blobOnlyLabels` list flagging labels
     * whose nodes are still on pre-W1 blob storage. Answers "what
     * can I actually query?" — the most common cause of property
     * predicates returning 0 results.
     */
    async discoverSearchableProperties(
        samplePerLabel = 200,
    ): Promise<SearchDiscoverResult> {
        return await this.fetch<SearchDiscoverResult>(
            '/search/discover',
            { extraParams: { samplePerLabel: String(samplePerLabel) } },
        )
    }

    // ==========================================
    // Edge Operations
    // ==========================================

    async getEdges(query: EdgeQuery): Promise<GraphEdge[]> {
        // Use POST for complex queries (especially multiple URNs)
        return await this.fetch<GraphEdge[]>('/edges/query', {
            method: 'POST',
            body: JSON.stringify({ query }),
        })
    }

    async getEdgesBetween(urns: URN[], edgeTypes?: string[], limit?: number): Promise<GraphEdge[]> {
        if (urns.length === 0) return []
        return await this.fetch<GraphEdge[]>('/edges/between', {
            method: 'POST',
            body: JSON.stringify({ urns, edgeTypes, limit }),
            timeoutMs: TIMEOUTS.EDGES_BETWEEN_MS,
        })
    }

    // ==========================================
    // Containment Hierarchy
    // ==========================================

    async getChildren(
        parentUrn: URN,
        options?: {
            entityTypes?: EntityType[]
            edgeTypes?: string[]
            searchQuery?: string
            offset?: number
            limit?: number
            sortProperty?: string | null
            cursor?: string | null
            sortDirection?: 'asc' | 'desc'
        }
    ): Promise<GraphNode[]> {
        const params = new URLSearchParams()
        if (options?.offset) params.append('offset', String(options.offset))
        if (options?.limit) params.append('limit', String(options.limit))
        if (options?.searchQuery) params.append('searchQuery', options.searchQuery)
        if (options?.sortProperty !== undefined) params.append('sortProperty', options.sortProperty ?? '')
        if (options?.cursor) params.append('cursor', options.cursor)
        if (options?.sortDirection && options.sortDirection !== 'asc') params.append('sortDirection', options.sortDirection)

        if (options?.edgeTypes?.length) {
            options.edgeTypes.forEach(t => params.append('edgeTypes', t))
        }

        return await this.fetch<GraphNode[]>(`/nodes/${encodeURIComponent(parentUrn)}/children?${params.toString()}`, {
            timeoutMs: TIMEOUTS.GET_CHILDREN_MS,
        })
    }

    async getChildrenWithEdges(
        parentUrn: URN,
        options?: {
            edgeTypes?: string[]
            lineageEdgeTypes?: string[]
            searchQuery?: string
            offset?: number
            limit?: number
            includeLineageEdges?: boolean
            sortProperty?: string | null
            cursor?: string | null
            sortDirection?: 'asc' | 'desc'
        }
    ): Promise<{
        children: GraphNode[]
        containmentEdges: GraphEdge[]
        lineageEdges: GraphEdge[]
        totalChildren: number
        hasMore: boolean
        nextCursor?: string | null
    }> {
        const params = new URLSearchParams()
        if (options?.offset) params.append('offset', String(options.offset))
        if (options?.limit) params.append('limit', String(options.limit))
        if (options?.searchQuery) params.append('searchQuery', options.searchQuery)
        if (options?.includeLineageEdges === false) params.append('includeLineageEdges', 'false')
        if (options?.sortProperty !== undefined) params.append('sortProperty', options.sortProperty ?? '')
        if (options?.cursor) params.append('cursor', options.cursor)
        if (options?.sortDirection && options.sortDirection !== 'asc') params.append('sortDirection', options.sortDirection)

        if (options?.edgeTypes?.length) {
            options.edgeTypes.forEach(t => params.append('edgeTypes', t))
        }
        if (options?.lineageEdgeTypes?.length) {
            options.lineageEdgeTypes.forEach(t => params.append('lineageEdgeTypes', t))
        }

        return await this.fetch(`/nodes/${encodeURIComponent(parentUrn)}/children-with-edges?${params.toString()}`, {
            timeoutMs: TIMEOUTS.GET_CHILDREN_MS,
        })
    }

    async getParent(childUrn: URN): Promise<GraphNode | null> {
        return await this.fetch<GraphNode | null>(`/nodes/${encodeURIComponent(childUrn)}/parent`)
    }

    async getAncestors(urn: URN): Promise<GraphNode[]> {
        return await this.fetch<GraphNode[]>(`/nodes/${encodeURIComponent(urn)}/ancestors`)
    }

    async getDescendants(urn: URN, depth = 10): Promise<GraphNode[]> {
        return await this.fetch<GraphNode[]>(`/nodes/${encodeURIComponent(urn)}/descendants?depth=${depth}`)
    }

    async getTopLevelNodes(query: TopLevelNodesQuery): Promise<TopLevelNodesResult> {
        const params = new URLSearchParams()
        // Don't swallow an explicit limit of 0 — backend clamps to [1,1000].
        if (query.limit !== undefined) params.append('limit', String(query.limit))
        if (query.searchQuery) params.append('searchQuery', query.searchQuery)
        if (query.cursor) params.append('cursor', query.cursor)
        if (query.includeChildCount === false) params.append('includeChildCount', 'false')
        if (query.sortDirection && query.sortDirection !== 'asc') params.append('sortDirection', query.sortDirection)
        if (query.entityTypes?.length) {
            query.entityTypes.forEach(t => params.append('entityTypes', t))
        }
        // Backend returns camelCase via response_model_by_alias=True, so the
        // wire shape already matches TopLevelNodesResult one-to-one.
        return await this.fetch<TopLevelNodesResult>(
            `/nodes/top-level?${params.toString()}`,
            { timeoutMs: TIMEOUTS.TOP_LEVEL_MS },
        )
    }

    async getContainment(params: { parentUrn: URN; searchQuery?: string; limit?: number }): Promise<ContainmentResult> {
        const { parentUrn, searchQuery, limit = 50 } = params
        const [parent, children] = await Promise.all([
            this.getNode(parentUrn),
            this.getChildren(parentUrn, { limit }),
        ])
        const filtered = searchQuery?.trim()
            ? children.filter(
                (c) =>
                    c.displayName?.toLowerCase().includes(searchQuery.toLowerCase()) ||
                    c.urn?.toLowerCase().includes(searchQuery.toLowerCase())
            )
            : children
        return {
            parent,
            children: filtered.slice(0, limit),
            hasNestedChildren: filtered.some((c) => (c.childCount ?? 0) > 0),
        }
    }

    // ==========================================
    // Lineage Traversal
    // ==========================================

    async getUpstream(
        urn: URN,
        depth: number,
        options?: TraceOptions
    ): Promise<LineageResult> {
        return this.fetch<LineageResult>('/trace', {
            method: 'POST',
            body: JSON.stringify({
                urn,
                direction: 'upstream',
                upstreamDepth: depth,
                downstreamDepth: 0,
                granularity: options?.granularity ?? 'table',
                aggregateEdges: options?.aggregateEdges ?? true,
                excludeContainmentEdges: options?.excludeContainmentEdges ?? true,
                includeInheritedLineage: options?.includeInheritedLineage ?? true,
            })
        })
    }

    async getDownstream(
        urn: URN,
        depth: number,
        options?: TraceOptions
    ): Promise<LineageResult> {
        return this.fetch<LineageResult>('/trace', {
            method: 'POST',
            body: JSON.stringify({
                urn,
                direction: 'downstream',
                upstreamDepth: 0,
                downstreamDepth: depth,
                granularity: options?.granularity ?? 'table',
                aggregateEdges: options?.aggregateEdges ?? true,
                excludeContainmentEdges: options?.excludeContainmentEdges ?? true,
                includeInheritedLineage: options?.includeInheritedLineage ?? true,
            })
        })
    }

    async getFullLineage(
        urn: URN,
        upstreamDepth: number,
        downstreamDepth: number,
        options?: TraceOptions
    ): Promise<LineageResult> {
        return this.fetch<LineageResult>('/trace', {
            method: 'POST',
            body: JSON.stringify({
                urn,
                direction: 'both',
                upstreamDepth,
                downstreamDepth,
                granularity: options?.granularity ?? 'table',
                aggregateEdges: options?.aggregateEdges ?? true,
                excludeContainmentEdges: options?.excludeContainmentEdges ?? true,
                includeInheritedLineage: options?.includeInheritedLineage ?? true,
                // Ontology-driven: pass lineage edge type filter to backend
                ...(options?.lineageEdgeTypes?.length ? { lineageEdgeTypes: options.lineageEdgeTypes } : {}),
            })
        })
    }

    /**
     * Trace v2 — POST /trace/v2. Server-side level filter via n.level index;
     * per-hop set-based BFS in Cypher. See plan: trace refactor.
     *
     * Hard caps (max_nodes/timeout_ms) live on the server; truncation surfaces
     * as `truncated: true` in the response. Always HTTP 200 unless input is
     * malformed — clients render partial results without retrying.
     */
    async traceAtLevel(request: TraceV2Request): Promise<TraceV2Result> {
        // v1 router exposes both /trace/v2 (skeleton-first) and /trace/expand[-batch].
        // The standalone v2 router exists in the codebase but is not mounted
        // in main.py today (its include_router line is gated by a never-set
        // feature flag), so we stay on v1 paths.
        const raw = await this.fetch<RawTraceV2Result>('/trace/v2', {
            method: 'POST',
            body: JSON.stringify(request),
            timeoutMs: TIMEOUTS.TRACE_MS,
        })
        return normalizeTraceV2(raw)
    }

    /**
     * Focus-scoped lineage closure — POST /trace/closure.
     *
     * Regime-independent: the server walks RAW lineage from the focus (seeding
     * from a container's lineage-bearing leaves when the focus has none), so it
     * reaches attribute→attribute even where boundary-mode aggregation never
     * materialised leaf rollups. Same never-504 contract as /trace/v2 —
     * truncation surfaces as `truncated: true`, never an error.
     */
    async traceClosure(
        request: TraceClosureRequest,
        opts?: { signal?: AbortSignal },
    ): Promise<TraceV2Result & LensClosureExtras> {
        const raw = await this.fetch<RawTraceClosureResult>('/trace/closure', {
            method: 'POST',
            body: JSON.stringify(request),
            timeoutMs: TIMEOUTS.TRACE_MS,
            ...(opts?.signal ? { signal: opts.signal } : {}),
        })
        return {
            ...normalizeTraceV2(raw),
            frontierUp: raw.frontierUp ?? [],
            frontierDown: raw.frontierDown ?? [],
            seedTruncated: raw.seedTruncated ?? false,
            seedCursor: (raw as { seedCursor?: string | null }).seedCursor ?? null,
            grain: (raw as { grain?: 'fine' | 'coarse' | null }).grain ?? null,
        }
    }

    async expandAggregated(request: ExpandAggregatedRequest): Promise<TraceV2Result> {
        const raw = await this.fetch<RawTraceV2Result>('/trace/expand', {
            method: 'POST',
            body: JSON.stringify(request),
            timeoutMs: TIMEOUTS.TRACE_MS,
        })
        return normalizeTraceV2(raw)
    }

    async expandAggregatedBatch(request: ExpandAggregatedBatchRequest): Promise<TraceV2Result> {
        const raw = await this.fetch<RawTraceV2Result>('/trace/expand-batch', {
            method: 'POST',
            body: JSON.stringify(request),
            timeoutMs: TIMEOUTS.TRACE_MS,
        })
        return normalizeTraceV2(raw)
    }

    // ==========================================
    // Layer/Classification Queries
    // ==========================================

    async getNodesByLayer(layerId: string): Promise<GraphNode[]> {
        return await this.fetch<GraphNode[]>(`/nodes/by-layer/${encodeURIComponent(layerId)}`)
    }

    async getNodesByTag(tag: string): Promise<GraphNode[]> {
        return await this.fetch<GraphNode[]>(`/nodes/by-tag/${encodeURIComponent(tag)}`)
    }

    // ==========================================
    // Metadata Operations
    // ==========================================

    async getEntityTypes(): Promise<EntityType[]> {
        return await this.fetch<EntityType[]>('/metadata/entity-types')
    }

    async getTags(): Promise<string[]> {
        return await this.fetch<string[]>('/metadata/tags')
    }

    /**
     * The four cache-only endpoints below (`/stats`, `/introspection`,
     * `/metadata/ontology`, `/metadata/schema`) return the canonical
     * `{data, meta}` envelope. We unwrap to the raw payload here so
     * callers stay envelope-unaware. Consumers that need cache
     * freshness for UI banners should hit a separate helper that
     * preserves the envelope.
     *
     * `unwrapEnvelope` returns `null` when `meta.status === 'error'`,
     * which we let propagate so the circuit breaker / retry logic
     * upstream can react. For `computing` / `partial` states the
     * payload is genuinely null/synthetic; downstream code already
     * handles that path (e.g. SchemaScope error UI).
     */
    async getStats(): Promise<{
        nodeCount: number
        edgeCount: number
        entityTypeCounts: Record<EntityType, number>
    }> {
        const raw = await this.fetch<unknown>('/stats')
        const data = unwrapEnvelope<{
            nodeCount: number
            edgeCount: number
            entityTypeCounts: Record<EntityType, number>
        }>(raw)
        if (!data) {
            throw new Error('Stats unavailable: cache miss or backend error')
        }
        return data
    }

    async getSchemaStats(): Promise<GraphSchemaStats> {
        const raw = await this.fetch<unknown>('/introspection')
        const data = unwrapEnvelope<GraphSchemaStats>(raw)
        if (!data) {
            throw new Error('Schema stats unavailable: cache miss or backend error')
        }
        return data
    }

    async getOntologyMetadata(): Promise<OntologyMetadata> {
        const raw = await this.fetch<unknown>('/metadata/ontology')
        const data = unwrapEnvelope<OntologyMetadata>(raw)
        if (!data) {
            throw new Error('Ontology metadata unavailable: cache miss or backend error')
        }
        return data
    }

    // ==========================================
    // Assignment Operations
    // ==========================================

    async computeLayerAssignments(request: LayerAssignmentRequest): Promise<LayerAssignmentResult> {
        return await this.fetch<LayerAssignmentResult>('/assignments/compute', {
            method: 'POST',
            body: JSON.stringify(request)
        })
    }

    // ==========================================
    // Schema Operations (Dynamic Schema Loading)
    // ==========================================

    async getFullSchema(dataSourceId?: string): Promise<GraphSchema> {
        const raw = await this.fetch<unknown>('/metadata/schema', {
            extraParams: dataSourceId ? { dataSourceId } : undefined,
        })
        const data = unwrapEnvelope<GraphSchema>(raw)
        if (!data) {
            throw new Error('Graph schema unavailable: cache miss or backend error')
        }
        return data
    }

    // ==========================================
    // Aggregated Edge Operations
    // ==========================================

    async getAggregatedEdges(request: AggregatedEdgeRequest): Promise<AggregatedEdgeResult> {
        // Aligns with backend HTTP_TIMEOUT_AGGREGATION_SECS for the
        // aggregated-edges route — value sourced from the central
        // src/config/timeouts.ts so FE and BE stay in lockstep.
        return await this.fetch<AggregatedEdgeResult>('/edges/aggregated', {
            method: 'POST',
            body: JSON.stringify(request),
            timeoutMs: TIMEOUTS.AGGREGATED_EDGES_MS,
        })
    }

    // ==========================================
    // Node Creation
    // ==========================================

    async createNode(request: CreateNodeRequest): Promise<CreateNodeResult> {
        return await this.fetch<CreateNodeResult>('/nodes/create', {
            method: 'POST',
            body: JSON.stringify(request)
        })
    }

    async createEdge(request: CreateEdgeRequest): Promise<EdgeMutationResult> {
        return await this.fetch<EdgeMutationResult>('/edges', {
            method: 'POST',
            body: JSON.stringify(request),
        })
    }
}
