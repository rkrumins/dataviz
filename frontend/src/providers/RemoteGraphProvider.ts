import type {
    GraphDataProvider,
    GraphNode,
    GraphEdge,
    EntityType,
    URN,
    NodeQuery,
    EdgeQuery,
    LineageResult,
    LayerAssignmentRequest,
    LayerAssignmentResult,
} from './GraphDataProvider'

// Base API URL - typically configured via environment variables
const API_BASE = '/api/v1'

export class RemoteGraphProvider implements GraphDataProvider {
    readonly name = 'RemoteGraphProvider'

    // ==========================================
    // Internal Fetch Helper
    // ==========================================

    private async fetch<T>(endpoint: string, options?: RequestInit): Promise<T> {
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

    // ==========================================
    // Lineage Traversal
    // ==========================================

    async getUpstream(
        urn: URN,
        depth: number,
        _includeColumnLineage = true
    ): Promise<LineageResult> {
        return this.fetch<LineageResult>('/trace', {
            method: 'POST',
            body: JSON.stringify({
                urn,
                direction: 'upstream',
                depth,
                // includeColumnLineage
                // Backend 'trace' endpoint signature:
                // urn, direction, depth, granularity, aggregate_edges
                // Does NOT explicit have includeColumnLineage, but logic says "Always fetch column lineage"
                // So we can ignore passing it if backend defaults to it.
            })
        })
    }

    async getDownstream(
        urn: URN,
        depth: number,
        _includeColumnLineage = true
    ): Promise<LineageResult> {
        return this.fetch<LineageResult>('/trace', {
            method: 'POST',
            body: JSON.stringify({
                urn,
                direction: 'downstream',
                depth,
            })
        })
    }

    async getFullLineage(
        urn: URN,
        upstreamDepth: number,
        downstreamDepth: number,
        _includeColumnLineage = true
    ): Promise<LineageResult> {
        // Backend expects single depth param usually, or we need to update backend to support split depth
        // Checking backend: `upstream_depth = depth if ... else 0`. It takes `depth` as single int.
        // We should update backend to support separate depths or take the max?
        // For now using MAX depth.
        const maxDepth = Math.max(upstreamDepth, downstreamDepth)

        return this.fetch<LineageResult>('/trace', {
            method: 'POST',
            body: JSON.stringify({
                urn,
                direction: 'both',
                depth: maxDepth,
                // We might want to pass granular up/down depths if we update backend
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

    // ==========================================
    // Assignment Operations
    // ==========================================

    async computeLayerAssignments(request: LayerAssignmentRequest): Promise<LayerAssignmentResult> {
        return await this.fetch<LayerAssignmentResult>('/assignments/compute', {
            method: 'POST',
            body: JSON.stringify(request)
        })
    }
}
