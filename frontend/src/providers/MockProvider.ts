/**
 * MockProvider - Graph data provider using local demo data
 * 
 * This provider reads from the existing demo-data.ts and implements
 * the GraphDataProvider interface. Used for development and testing
 * before connecting to a real graph database.
 */

import { demoNodes, demoEdges } from '@/lib/demo-data'
import type { LineageNode, LineageEdge as CanvasEdge } from '@/store/canvas'
import type {
    GraphDataProvider,
    GraphNode,
    GraphEdge,
    EdgeType,
    EntityType,
    URN,
    NodeQuery,
    EdgeQuery,
    LineageResult,
    LayerAssignmentRequest,
    LayerAssignmentResult,
} from './GraphDataProvider'

// ============================================
// Type Mapping (Demo Data → Provider Types)
// ============================================

/**
 * Map demo data node types to EntityType
 */
function mapNodeTypeToEntityType(nodeType: string): EntityType {
    const mapping: Record<string, EntityType> = {
        domain: 'container',      // Domain is a container
        app: 'dataPlatform',      // App/System is a platform
        asset: 'dataset',         // Asset can be table, dashboard, etc.
        column: 'schemaField',    // Column is a schema field
        ghost: 'dataset',         // Ghost nodes treated as datasets
    }
    return mapping[nodeType] ?? 'dataset'
}

/**
 * Map demo data edge types to EdgeType
 */
function mapEdgeTypeToEdgeType(edgeType: string): EdgeType {
    const mapping: Record<string, EdgeType> = {
        contains: 'CONTAINS',
        transforms: 'TRANSFORMS',
        produces: 'PRODUCES',
        consumes: 'CONSUMES',
    }
    return mapping[edgeType] ?? 'RELATED_TO'
}

/**
 * Convert LineageNode to GraphNode
 */
function convertNode(node: LineageNode): GraphNode {
    const data = node.data as Record<string, unknown>
    const nodeType = (data.type as string) ?? node.type ?? 'asset'

    return {
        urn: (data.urn as string) || node.id,
        entityType: mapNodeTypeToEntityType(nodeType),
        displayName: (data.label as string) || node.id,
        qualifiedName: (data.technicalLabel as string) || undefined,
        description: (data.description as string) || undefined,
        properties: data,
        tags: (data.classifications as string[]) || [],
        childCount: (data.metadata as Record<string, unknown>)?.childCount as number || undefined,
        sourceSystem: (data.sourceSystem as string) || undefined,
    }
}

/**
 * Convert CanvasEdge to GraphEdge
 */
function convertEdge(edge: CanvasEdge): GraphEdge {
    const data = edge.data as Record<string, unknown> | undefined
    const edgeType = (data?.edgeType as string) || (data?.relationship as string) || 'produces'

    return {
        id: edge.id,
        sourceUrn: edge.source,  // Note: demo data uses IDs, not URNs
        targetUrn: edge.target,
        edgeType: mapEdgeTypeToEdgeType(edgeType),
        confidence: (data?.confidence as number) || undefined,
        properties: data,
    }
}

// ============================================
// MockProvider Implementation
// ============================================

export class MockProvider implements GraphDataProvider {
    readonly name = 'MockProvider'

    private nodes: Map<string, GraphNode>
    private edges: GraphEdge[]

    // Precomputed indices for fast lookups
    private childrenMap: Map<string, string[]>
    private parentMap: Map<string, string>
    private downstreamMap: Map<string, GraphEdge[]>
    private upstreamMap: Map<string, GraphEdge[]>

    constructor() {
        // Convert demo data
        this.nodes = new Map(
            demoNodes.map((n) => [n.id, convertNode(n)])
        )
        this.edges = demoEdges.map(convertEdge)

        // GENERATE MOCK DATA FOR PAGINATION TESTING
        // Find a table and add 50 columns to it
        const targetTable = this.nodes.get('urn:li:dataset:(urn:li:dataPlatform:hive,SampleHiveDb.LineageTable,PROD)')
            || Array.from(this.nodes.values()).find(n => n.entityType === 'dataset')

        if (targetTable) {
            console.log(`[MockProvider] Generating 50 columns for ${targetTable.displayName}`)
            targetTable.childCount = 50 // Force metadata count

            for (let i = 0; i < 50; i++) {
                const columnUrn = `${targetTable.urn}/col_${i}`
                const columnNode: GraphNode = {
                    urn: columnUrn,
                    entityType: 'schemaField',
                    displayName: `generated_col_${i}`,
                    description: `Auto-generated column ${i}`,
                    properties: {},
                    tags: [],
                    sourceSystem: targetTable.sourceSystem
                }

                this.nodes.set(columnUrn, columnNode)

                // Add edge (will be indexed below)
                this.edges.push({
                    id: `gen_edge_${i}`,
                    sourceUrn: targetTable.urn,
                    targetUrn: columnUrn,
                    edgeType: 'CONTAINS',
                    properties: {}
                })
            }
        }

        // Build indices
        this.childrenMap = new Map()
        this.parentMap = new Map()
        this.downstreamMap = new Map()
        this.upstreamMap = new Map()

        this.buildIndices()
    }

    private buildIndices(): void {
        for (const edge of this.edges) {
            const sourceId = edge.sourceUrn
            const targetId = edge.targetUrn

            // Note: Indices now store ALL relationships. 
            // The determination of "Containment" happens at QUERY time based on View Config.

            // Build raw adjacency for ALL edge types
            // Downstream: edges where this node is source
            const downstream = this.downstreamMap.get(sourceId) ?? []
            downstream.push(edge)
            this.downstreamMap.set(sourceId, downstream)

            // Upstream: edges where this node is target
            const upstream = this.upstreamMap.get(targetId) ?? []
            upstream.push(edge)
            this.upstreamMap.set(targetId, upstream)
        }

        // We can't precompute "child count" easily without knowing WHICH edges are containment.
        // So we will compute it dynamically or cache common patterns?
        // For MockProvider, let's just precompute a "default" containment (CONTAINS) 
        // but allow overrides.
        this.recomputeChildCounts(['CONTAINS'])
    }

    private recomputeChildCounts(containmentTypes: string[]) {
        // Reset counts
        for (const node of this.nodes.values()) {
            node.childCount = 0
        }

        for (const edge of this.edges) {
            if (containmentTypes.includes(edge.edgeType)) {
                const parent = this.nodes.get(edge.sourceUrn)
                if (parent) {
                    parent.childCount = (parent.childCount || 0) + 1
                }
            }
        }
    }

    // ==========================================
    // Node Operations
    // ==========================================

    async getNode(urn: URN): Promise<GraphNode | null> {
        // Try direct lookup by URN
        const direct = this.nodes.get(urn)
        if (direct) return direct

        // Search by URN property
        for (const node of this.nodes.values()) {
            if (node.urn === urn) return node
        }

        return null
    }

    async getNodes(query: NodeQuery): Promise<GraphNode[]> {
        let results = Array.from(this.nodes.values())

        if (query.urns?.length) {
            const urnSet = new Set(query.urns)
            results = results.filter((n) => urnSet.has(n.urn))
        }

        if (query.entityTypes?.length) {
            results = results.filter((n) => query.entityTypes!.includes(n.entityType))
        }

        if (query.tags?.length) {
            results = results.filter((n) =>
                n.tags?.some((t) => query.tags!.includes(t))
            )
        }

        if (query.searchQuery) {
            const q = query.searchQuery.toLowerCase()
            results = results.filter((n) =>
                n.displayName.toLowerCase().includes(q) ||
                n.qualifiedName?.toLowerCase().includes(q) ||
                n.description?.toLowerCase().includes(q)
            )
        }

        // Pagination
        const offset = query.offset ?? 0
        const limit = query.limit ?? 100
        return results.slice(offset, offset + limit)
    }

    async searchNodes(query: string, limit = 10): Promise<GraphNode[]> {
        return this.getNodes({ searchQuery: query, limit })
    }

    // ==========================================
    // Edge Operations
    // ==========================================

    async getEdges(query: EdgeQuery): Promise<GraphEdge[]> {
        let results = [...this.edges]

        if (query.edgeTypes?.length) {
            results = results.filter((e) => query.edgeTypes!.includes(e.edgeType))
        }

        if (query.sourceUrns?.length) {
            const sourceSet = new Set(query.sourceUrns)
            results = results.filter((e) => sourceSet.has(e.sourceUrn))
        }

        if (query.targetUrns?.length) {
            const targetSet = new Set(query.targetUrns)
            results = results.filter((e) => targetSet.has(e.targetUrn))
        }

        if (query.anyUrns?.length) {
            const urnSet = new Set(query.anyUrns)
            results = results.filter((e) =>
                urnSet.has(e.sourceUrn) || urnSet.has(e.targetUrn)
            )
        }

        if (query.minConfidence !== undefined) {
            results = results.filter((e) =>
                (e.confidence ?? 1) >= query.minConfidence!
            )
        }

        return results
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
        const edgeTypes = options?.edgeTypes ?? ['CONTAINS'] // Default to CONTAINS
        const offset = options?.offset ?? 0
        const limit = options?.limit ?? 100

        // Find all edges from this parent that match the containment types
        const edges = this.downstreamMap.get(parentUrn) ?? []
        const relevantEdges = edges.filter(e => edgeTypes.includes(e.edgeType))

        // Get child nodes
        let children = relevantEdges
            .map(e => this.nodes.get(e.targetUrn))
            .filter((n): n is GraphNode => n !== undefined)

        // Filter by entity type
        if (options?.entityTypes?.length) {
            children = children.filter((n) => options.entityTypes!.includes(n.entityType))
        }

        // Sort alphabetically by default
        children.sort((a, b) => a.displayName.localeCompare(b.displayName))

        // Apply pagination
        return children.slice(offset, offset + limit)
    }

    async getParent(childUrn: URN): Promise<GraphNode | null> {
        const parentId = this.parentMap.get(childUrn)
        if (!parentId) return null
        return this.nodes.get(parentId) ?? null
    }

    async getAncestors(urn: URN): Promise<GraphNode[]> {
        const ancestors: GraphNode[] = []
        let currentUrn = urn

        while (true) {
            const parentId = this.parentMap.get(currentUrn)
            if (!parentId) break

            const parent = this.nodes.get(parentId)
            if (parent) {
                ancestors.push(parent)
                currentUrn = parentId
            } else {
                break
            }
        }

        return ancestors
    }

    async getDescendants(urn: URN, depth = 10): Promise<GraphNode[]> {
        const descendants: GraphNode[] = []
        const visited = new Set<string>()

        const traverse = (currentUrn: string, currentDepth: number) => {
            if (currentDepth > depth || visited.has(currentUrn)) return
            visited.add(currentUrn)

            const childIds = this.childrenMap.get(currentUrn) ?? []
            for (const childId of childIds) {
                const child = this.nodes.get(childId)
                if (child) {
                    descendants.push(child)
                    traverse(childId, currentDepth + 1)
                }
            }
        }

        traverse(urn, 0)
        return descendants
    }

    // ==========================================
    // Lineage Traversal
    // ==========================================

    async getUpstream(
        urn: URN,
        depth: number,
        includeColumnLineage = true
    ): Promise<LineageResult> {
        const nodes: GraphNode[] = []
        const edges: GraphEdge[] = []
        const upstreamUrns = new Set<URN>()
        const visited = new Set<string>()

        // Start with the focus node
        const startNode = await this.getNode(urn)
        if (startNode) {
            nodes.push(startNode)
        }

        // Include children if requested
        const startUrns = [urn]
        if (includeColumnLineage) {
            const descendants = await this.getDescendants(urn, 1)
            startUrns.push(...descendants.map((d) => d.urn))
        }

        // BFS traversal upstream
        let currentLevel = new Set(startUrns)
        for (let d = 0; d < depth; d++) {
            const nextLevel = new Set<string>()

            for (const currentUrn of currentLevel) {
                if (visited.has(currentUrn)) continue
                visited.add(currentUrn)

                const upstreamEdges = this.upstreamMap.get(currentUrn) ?? []
                for (const edge of upstreamEdges) {
                    edges.push(edge)

                    const sourceNode = this.nodes.get(edge.sourceUrn)
                    if (sourceNode && !visited.has(edge.sourceUrn)) {
                        nodes.push(sourceNode)
                        upstreamUrns.add(edge.sourceUrn)
                        nextLevel.add(edge.sourceUrn)
                    }
                }
            }

            if (nextLevel.size === 0) break
            currentLevel = nextLevel
        }

        return {
            nodes,
            edges,
            upstreamUrns,
            downstreamUrns: new Set(),
            totalCount: nodes.length,
            hasMore: false,
        }
    }

    async getDownstream(
        urn: URN,
        depth: number,
        includeColumnLineage = true
    ): Promise<LineageResult> {
        const nodes: GraphNode[] = []
        const edges: GraphEdge[] = []
        const downstreamUrns = new Set<URN>()
        const visited = new Set<string>()

        // Start with the focus node
        const startNode = await this.getNode(urn)
        if (startNode) {
            nodes.push(startNode)
        }

        // Include children if requested
        const startUrns = [urn]
        if (includeColumnLineage) {
            const descendants = await this.getDescendants(urn, 1)
            startUrns.push(...descendants.map((d) => d.urn))
        }

        // BFS traversal downstream
        let currentLevel = new Set(startUrns)
        for (let d = 0; d < depth; d++) {
            const nextLevel = new Set<string>()

            for (const currentUrn of currentLevel) {
                if (visited.has(currentUrn)) continue
                visited.add(currentUrn)

                const downstreamEdges = this.downstreamMap.get(currentUrn) ?? []
                for (const edge of downstreamEdges) {
                    edges.push(edge)

                    const targetNode = this.nodes.get(edge.targetUrn)
                    if (targetNode && !visited.has(edge.targetUrn)) {
                        nodes.push(targetNode)
                        downstreamUrns.add(edge.targetUrn)
                        nextLevel.add(edge.targetUrn)
                    }
                }
            }

            if (nextLevel.size === 0) break
            currentLevel = nextLevel
        }

        return {
            nodes,
            edges,
            upstreamUrns: new Set(),
            downstreamUrns,
            totalCount: nodes.length,
            hasMore: false,
        }
    }

    async getFullLineage(
        urn: URN,
        upstreamDepth: number,
        downstreamDepth: number,
        includeColumnLineage = true
    ): Promise<LineageResult> {
        const [upstream, downstream] = await Promise.all([
            this.getUpstream(urn, upstreamDepth, includeColumnLineage),
            this.getDownstream(urn, downstreamDepth, includeColumnLineage),
        ])

        // Merge results
        const nodeMap = new Map<string, GraphNode>()
        const edgeMap = new Map<string, GraphEdge>()

        for (const node of [...upstream.nodes, ...downstream.nodes]) {
            nodeMap.set(node.urn, node)
        }

        for (const edge of [...upstream.edges, ...downstream.edges]) {
            edgeMap.set(edge.id, edge)
        }

        return {
            nodes: Array.from(nodeMap.values()),
            edges: Array.from(edgeMap.values()),
            upstreamUrns: upstream.upstreamUrns,
            downstreamUrns: downstream.downstreamUrns,
            totalCount: nodeMap.size,
            hasMore: false,
        }
    }

    // ==========================================
    // Layer/Classification Queries
    // ==========================================

    async getNodesByLayer(layerId: string): Promise<GraphNode[]> {
        // In mock provider, layer assignment would be based on entity type
        // or tags. This is a placeholder - real implementation would use
        // layer assignment rules.
        return Array.from(this.nodes.values()).filter((n) =>
            n.layerAssignment === layerId ||
            n.tags?.includes(`layer:${layerId}`)
        )
    }

    async getNodesByTag(tag: string): Promise<GraphNode[]> {
        return Array.from(this.nodes.values()).filter((n) =>
            n.tags?.includes(tag)
        )
    }

    // ==========================================
    // Metadata Operations
    // ==========================================

    async getEntityTypes(): Promise<EntityType[]> {
        const types = new Set<EntityType>()
        for (const node of this.nodes.values()) {
            types.add(node.entityType)
        }
        return Array.from(types)
    }

    async getTags(): Promise<string[]> {
        const tags = new Set<string>()
        for (const node of this.nodes.values()) {
            node.tags?.forEach((t) => tags.add(t))
        }
        return Array.from(tags)
    }

    async getStats(): Promise<{
        nodeCount: number
        edgeCount: number
        entityTypeCounts: Record<EntityType, number>
    }> {
        const entityTypeCounts: Partial<Record<EntityType, number>> = {}

        for (const node of this.nodes.values()) {
            entityTypeCounts[node.entityType] = (entityTypeCounts[node.entityType] ?? 0) + 1
        }

        return {
            nodeCount: this.nodes.size,
            edgeCount: this.edges.length,
            entityTypeCounts: entityTypeCounts as Record<EntityType, number>,
        }
    }

    // ==========================================
    // Assignment Operations
    // ==========================================

    async computeLayerAssignments(request: LayerAssignmentRequest): Promise<LayerAssignmentResult> {
        // Mock implementation: return empty or basic assignments
        console.warn('[MockProvider] computeLayerAssignments is a stub. Use RemoteGraphProvider for real computation.')

        return {
            assignments: new Map(),
            parentMap: new Map(),
            edges: [],
            unassignedEntityIds: [],
            stats: {
                totalNodes: this.nodes.size,
                assignedNodes: 0,
                computeTimeMs: 0
            }
        }
    }
}

// ============================================
// Singleton Instance
// ============================================

let mockProviderInstance: MockProvider | null = null

export function getMockProvider(): MockProvider {
    if (!mockProviderInstance) {
        mockProviderInstance = new MockProvider()
    }
    return mockProviderInstance
}
