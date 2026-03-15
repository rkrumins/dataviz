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
    LayerAssignmentRequest,
    LayerAssignmentResult,
    GraphSchemaStats,
    OntologyMetadata,
    GraphSchema,
    AggregatedEdgeRequest,
    AggregatedEdgeResult,
    CreateNodeRequest,
    CreateNodeResult,
} from './GraphDataProvider'

const API_BASE = '/api/v1'

export interface RemoteGraphProviderOptions {
    /** Workspace ID. When set, routes through /v1/{ws_id}/graph/... */
    workspaceId?: string
    /** Data source ID. When set, appended as ?dataSourceId= to workspace-scoped routes. */
    dataSourceId?: string
    /** @deprecated Legacy connection ID. Use workspaceId instead. */
    connectionId?: string
}

export class RemoteGraphProvider implements GraphDataProvider {
    readonly name = 'RemoteGraphProvider'

    private readonly workspaceId?: string
    private readonly dataSourceId?: string
    private readonly connectionId?: string

    /** In-flight request deduplication: identical concurrent requests share one Promise */
    private _inflight = new Map<string, Promise<unknown>>()

    /** Short-lived response cache for GET requests (prevents rapid re-fetches during re-renders) */
    private _responseCache = new Map<string, { data: unknown; ts: number }>()
    private static RESPONSE_CACHE_TTL = 2000 // 2 seconds

    constructor(options?: RemoteGraphProviderOptions) {
        this.workspaceId = options?.workspaceId
        this.dataSourceId = options?.dataSourceId
        this.connectionId = options?.connectionId
    }

    // ==========================================
    // URL builder — workspace path or legacy query param
    // ==========================================

    private buildUrl(path: string, extraParams?: Record<string, string>): string {
        // Workspace-scoped: /api/v1/{ws_id}/graph/...
        const base = this.workspaceId
            ? `/api/v1/${this.workspaceId}/graph`
            : API_BASE

        const url = new URL(`${base}${path}`, window.location.origin)

        // Data source targeting within a workspace
        if (this.workspaceId && this.dataSourceId) {
            url.searchParams.set('dataSourceId', this.dataSourceId)
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

    private async fetch<T>(path: string, options?: RequestInit & { extraParams?: Record<string, string> }): Promise<T> {
        const { extraParams, ...fetchOptions } = options ?? {}
        const method = (fetchOptions.method ?? 'GET').toUpperCase()
        const url = this.buildUrl(path, extraParams)
        const cacheKey = `${method}:${url}:${fetchOptions.body ?? ''}`

        // Check short-lived response cache for GET requests
        if (method === 'GET') {
            const cached = this._responseCache.get(cacheKey)
            if (cached && Date.now() - cached.ts < RemoteGraphProvider.RESPONSE_CACHE_TTL) {
                return cached.data as T
            }
        }

        // Deduplicate identical in-flight requests
        const existing = this._inflight.get(cacheKey)
        if (existing) return existing as Promise<T>

        const promise = this._doFetch<T>(url, fetchOptions, method, cacheKey)
        this._inflight.set(cacheKey, promise)
        return promise
    }

    private async _doFetch<T>(url: string, fetchOptions: RequestInit, method: string, cacheKey: string): Promise<T> {
        try {
            const response = await fetch(url, {
                ...fetchOptions,
                headers: {
                    'Content-Type': 'application/json',
                    ...fetchOptions?.headers,
                },
            })

            if (!response.ok) {
                const errorText = await response.text()
                throw new Error(`API Error ${response.status}: ${errorText || response.statusText}`)
            }

            const data = await response.json() as T

            // Cache GET responses briefly to handle rapid re-renders
            if (method === 'GET') {
                this._responseCache.set(cacheKey, { data, ts: Date.now() })
            }

            return data
        } finally {
            this._inflight.delete(cacheKey)
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

    async searchNodes(query: string, limit = 10): Promise<GraphNode[]> {
        return await this.fetch<GraphNode[]>('/search', {
            method: 'POST',
            body: JSON.stringify({ query, limit }),
        })
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
        }
    ): Promise<GraphNode[]> {
        const params = new URLSearchParams()
        if (options?.offset) params.append('offset', String(options.offset))
        if (options?.limit) params.append('limit', String(options.limit))
        if (options?.searchQuery) params.append('searchQuery', options.searchQuery)

        if (options?.edgeTypes?.length) {
            options.edgeTypes.forEach(t => params.append('edgeTypes', t))
        }

        // Note: Backend might ignore edgeTypes/entityTypes in the simple /children endpoint
        // If strict filtering is needed, we might need to filter client-side or add params support
        // For now, assuming standard parent->child traversal

        return await this.fetch<GraphNode[]>(`/nodes/${encodeURIComponent(parentUrn)}/children?${params.toString()}`)
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

    async getStats(): Promise<{
        nodeCount: number
        edgeCount: number
        entityTypeCounts: Record<EntityType, number>
    }> {
        return await this.fetch<any>('/stats')
    }

    async getSchemaStats(): Promise<GraphSchemaStats> {
        return await this.fetch<GraphSchemaStats>('/introspection')
    }

    async getOntologyMetadata(): Promise<OntologyMetadata> {
        return await this.fetch<OntologyMetadata>('/metadata/ontology')
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
        return await this.fetch<GraphSchema>('/metadata/schema', {
            extraParams: dataSourceId ? { dataSourceId } : undefined,
        })
    }

    // ==========================================
    // Aggregated Edge Operations
    // ==========================================

    async getAggregatedEdges(request: AggregatedEdgeRequest): Promise<AggregatedEdgeResult> {
        return await this.fetch<AggregatedEdgeResult>('/edges/aggregated', {
            method: 'POST',
            body: JSON.stringify(request)
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
}
