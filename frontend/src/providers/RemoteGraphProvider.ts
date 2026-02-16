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

// Base API URL - typically configured via environment variables
const API_BASE = '/api/v1'

export class RemoteGraphProvider implements GraphDataProvider {
    readonly name = 'RemoteGraphProvider'

    // ==========================================
    // Internal Fetch Helper
    // ==========================================

    private inflightRequests = new Map<string, Promise<any>>()

    private async fetch<T>(endpoint: string, options?: RequestInit): Promise<T> {
        // Create a unique key for deduplication
        // Include method and body to differentiate requests
        const method = options?.method || 'GET'
        const body = options?.body ? String(options.body) : ''
        const key = `${method}:${endpoint}:${body}`

        // Return existing promise if request is already in flight
        const existingPromise = this.inflightRequests.get(key)
        if (existingPromise) {
            return existingPromise
        }

        const fetchPromise = (async () => {
            try {
                const url = `${API_BASE}${endpoint}`
                const response = await fetch(url, {
                    ...options,
                    headers: {
                        'Content-Type': 'application/json',
                        ...options?.headers,
                    },
                })

                if (!response.ok) {
                    const errorText = await response.text()
                    throw new Error(`API Error ${response.status}: ${errorText || response.statusText}`)
                }

                return response.json()
            } finally {
                // Remove from map when done (success or failure)
                this.inflightRequests.delete(key)
            }
        })()

        this.inflightRequests.set(key, fetchPromise)
        return fetchPromise
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
            offset?: number
            limit?: number
        }
    ): Promise<GraphNode[]> {
        const params = new URLSearchParams()
        if (options?.offset) params.append('offset', String(options.offset))
        if (options?.limit) params.append('limit', String(options.limit))

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

    async getFullSchema(): Promise<GraphSchema> {
        return await this.fetch<GraphSchema>('/metadata/schema')
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
