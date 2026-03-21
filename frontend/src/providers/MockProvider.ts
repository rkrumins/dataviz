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

    async getEdgesBetween(urns: URN[], edgeTypes?: string[], limit?: number): Promise<GraphEdge[]> {
        const urnSet = new Set(urns)
        let results = this.edges.filter((e) => urnSet.has(e.sourceUrn) && urnSet.has(e.targetUrn))
        if (edgeTypes?.length) {
            results = results.filter((e) => edgeTypes.includes(e.edgeType))
        }
        return results.slice(0, limit ?? 5000)
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
        const edgeTypes = options?.edgeTypes ?? ['CONTAINS'] // Default to CONTAINS
        const offset = options?.offset ?? 0
        const limit = options?.limit ?? 100
        const searchQuery = options?.searchQuery?.trim().toLowerCase()

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

        // Filter by search query
        if (searchQuery) {
            children = children.filter((n) =>
                n.displayName?.toLowerCase().includes(searchQuery) ||
                n.urn?.toLowerCase().includes(searchQuery)
            )
        }

        // Sort alphabetically by default
        children.sort((a, b) => a.displayName.localeCompare(b.displayName))

        // Apply pagination
        return children.slice(offset, offset + limit)
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
        }
    ): Promise<{
        children: GraphNode[]
        containmentEdges: GraphEdge[]
        lineageEdges: GraphEdge[]
        totalChildren: number
        hasMore: boolean
    }> {
        const children = await this.getChildren(parentUrn, options)
        const childUrns = new Set(children.map(c => c.urn))
        const allUrns = new Set([parentUrn, ...childUrns])

        const containmentEdges: GraphEdge[] = []
        const lineageEdges: GraphEdge[] = []

        for (const edge of this.edges.values()) {
            if (!allUrns.has(edge.sourceUrn) || !allUrns.has(edge.targetUrn)) continue
            const edgeType = edge.edgeType.toUpperCase()
            if (edgeType === 'CONTAINS' || edgeType === 'BELONGS_TO') {
                containmentEdges.push(edge)
            } else if (options?.includeLineageEdges !== false) {
                lineageEdges.push(edge)
            }
        }

        const limit = options?.limit ?? 100
        return {
            children,
            containmentEdges,
            lineageEdges,
            totalChildren: children.length + (options?.offset ?? 0),
            hasMore: children.length >= limit,
        }
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

    async getContainment(params: { parentUrn: URN; searchQuery?: string; limit?: number }): Promise<ContainmentResult> {
        const { parentUrn, searchQuery, limit = 50 } = params
        const parent = await this.getNode(parentUrn)
        let children = await this.getChildren(parentUrn, { limit })
        if (searchQuery?.trim()) {
            const q = searchQuery.toLowerCase()
            children = children.filter(
                (c) =>
                    c.displayName?.toLowerCase().includes(q) || c.urn?.toLowerCase().includes(q)
            )
        }
        return {
            parent,
            children: children.slice(0, limit),
            hasNestedChildren: children.some((c) => (c.childCount ?? 0) > 0),
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
        const includeColumnLineage = options?.includeColumnLineage ?? true
        const excludeContainmentEdges = options?.excludeContainmentEdges ?? true

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

        // Containment edge types to filter — derive from ontology
        const ontology = await this.getOntologyMetadata()
        const containmentTypes: EdgeType[] = ontology.containmentEdgeTypes as EdgeType[]

        // BFS traversal upstream
        let currentLevel = new Set(startUrns)
        for (let d = 0; d < depth; d++) {
            const nextLevel = new Set<string>()

            for (const currentUrn of currentLevel) {
                if (visited.has(currentUrn)) continue
                visited.add(currentUrn)

                const upstreamEdges = this.upstreamMap.get(currentUrn) ?? []
                for (const edge of upstreamEdges) {
                    // Skip containment edges if requested
                    if (excludeContainmentEdges && containmentTypes.includes(edge.edgeType)) {
                        continue
                    }

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
        options?: TraceOptions
    ): Promise<LineageResult> {
        const includeColumnLineage = options?.includeColumnLineage ?? true
        const excludeContainmentEdges = options?.excludeContainmentEdges ?? true

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

        // Containment edge types to filter — derive from ontology
        const ontology = await this.getOntologyMetadata()
        const containmentTypes: EdgeType[] = ontology.containmentEdgeTypes as EdgeType[]

        // BFS traversal downstream
        let currentLevel = new Set(startUrns)
        for (let d = 0; d < depth; d++) {
            const nextLevel = new Set<string>()

            for (const currentUrn of currentLevel) {
                if (visited.has(currentUrn)) continue
                visited.add(currentUrn)

                const downstreamEdges = this.downstreamMap.get(currentUrn) ?? []
                for (const edge of downstreamEdges) {
                    // Skip containment edges if requested
                    if (excludeContainmentEdges && containmentTypes.includes(edge.edgeType)) {
                        continue
                    }

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
        options?: TraceOptions
    ): Promise<LineageResult> {
        const [upstream, downstream] = await Promise.all([
            this.getUpstream(urn, upstreamDepth, options),
            this.getDownstream(urn, downstreamDepth, options),
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

    async getSchemaStats(): Promise<GraphSchemaStats> {
        return {
            totalNodes: this.nodes.size,
            totalEdges: this.edges.length,
            entityTypeStats: [],
            edgeTypeStats: [],
            tagStats: []
        }
    }

    async getOntologyMetadata(): Promise<OntologyMetadata> {
        // Default containment edge types
        const defaultContainmentTypes = ['CONTAINS', 'BELONGS_TO']

        // Determine lineage edge types by excluding containment and metadata types
        const containmentUpper = new Set(defaultContainmentTypes.map(t => t.toUpperCase()))
        const metadataTypes = new Set(['TAGGED_WITH'])
        const allEdgeTypes = new Set<string>()
        this.edges.forEach(edge => allEdgeTypes.add(edge.edgeType))

        const lineageEdgeTypes = Array.from(allEdgeTypes).filter(t =>
            !containmentUpper.has(t.toUpperCase()) && !metadataTypes.has(t.toUpperCase())
        )

        // Build edge type metadata with full classification
        type Direction = 'parent-to-child' | 'child-to-parent' | 'source-to-target' | 'bidirectional'
        type Category = 'structural' | 'flow' | 'metadata' | 'association'
        const edgeTypeMetadata: Record<string, { isContainment: boolean; isLineage: boolean; direction: Direction; category: Category; description?: string }> = {}

        const lineageUpper = new Set(lineageEdgeTypes.map(t => t.toUpperCase()))

        allEdgeTypes.forEach(edgeType => {
            const isContainment = containmentUpper.has(edgeType.toUpperCase())
            const isLineage = lineageUpper.has(edgeType.toUpperCase())

            let category: Category
            let direction: Direction

            if (isContainment) {
                category = 'structural'
                direction = edgeType === 'CONTAINS' ? 'parent-to-child' :
                    edgeType === 'BELONGS_TO' ? 'child-to-parent' : 'parent-to-child'
            } else if (isLineage) {
                category = 'flow'
                direction = 'source-to-target'
            } else if (metadataTypes.has(edgeType.toUpperCase())) {
                category = 'metadata'
                direction = 'bidirectional'
            } else {
                category = 'association'
                direction = 'bidirectional'
            }

            edgeTypeMetadata[edgeType] = {
                isContainment,
                isLineage,
                direction,
                category,
                description: `${category.charAt(0).toUpperCase() + category.slice(1)} relationship: ${edgeType}`
            }
        })

        // Build entity type hierarchy from edges
        const entityTypeHierarchy: Record<string, { canContain: string[]; canBeContainedBy: string[] }> = {}

        this.edges.forEach(edge => {
            if (!defaultContainmentTypes.includes(edge.edgeType)) return

            const sourceNode = this.nodes.get(edge.sourceUrn)
            const targetNode = this.nodes.get(edge.targetUrn)

            if (!sourceNode || !targetNode) return

            const sourceType = sourceNode.entityType
            const targetType = targetNode.entityType

            // Determine parent and child based on edge direction
            let parentType: string, childType: string
            if (edge.edgeType === 'CONTAINS') {
                parentType = sourceType
                childType = targetType
            } else if (edge.edgeType === 'BELONGS_TO') {
                parentType = targetType
                childType = sourceType
            } else {
                parentType = sourceType
                childType = targetType
            }

            if (!entityTypeHierarchy[parentType]) {
                entityTypeHierarchy[parentType] = { canContain: [], canBeContainedBy: [] }
            }
            if (!entityTypeHierarchy[childType]) {
                entityTypeHierarchy[childType] = { canContain: [], canBeContainedBy: [] }
            }

            if (!entityTypeHierarchy[parentType].canContain.includes(childType)) {
                entityTypeHierarchy[parentType].canContain.push(childType)
            }
            if (!entityTypeHierarchy[childType].canBeContainedBy.includes(parentType)) {
                entityTypeHierarchy[childType].canBeContainedBy.push(parentType)
            }
        })

        // Find root entity types
        const allHierarchyTypes = new Set(Object.keys(entityTypeHierarchy))
        const containedTypes = new Set<string>()
        for (const hierarchy of Object.values(entityTypeHierarchy)) {
            hierarchy.canContain.forEach(t => containedTypes.add(t))
        }
        const rootEntityTypes = Array.from(allHierarchyTypes).filter(t => !containedTypes.has(t))

        return {
            containmentEdgeTypes: defaultContainmentTypes,
            lineageEdgeTypes,
            edgeTypeMetadata,
            entityTypeHierarchy,
            rootEntityTypes
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

    // ==========================================
    // Schema Operations (Dynamic Schema Loading)
    // ==========================================

    async getFullSchema(_dataSourceId?: string): Promise<GraphSchema> {
        // Mock implementation: build schema from existing data
        const entityTypeCounts: Record<string, number> = {}
        for (const node of this.nodes.values()) {
            entityTypeCounts[node.entityType] = (entityTypeCounts[node.entityType] ?? 0) + 1
        }

        const entityTypes = Object.entries(entityTypeCounts).map(([id, count]) => ({
            id,
            name: id.charAt(0).toUpperCase() + id.slice(1),
            pluralName: id.charAt(0).toUpperCase() + id.slice(1) + 's',
            description: `Entity type: ${id}`,
            visual: {
                icon: 'Box',
                color: '#6366f1',
                shape: 'rounded',
                size: 'md',
                borderStyle: 'solid',
                showInMinimap: true
            },
            fields: [
                { id: 'name', name: 'Name', type: 'string', required: true, showInNode: true, showInPanel: true, showInTooltip: true, displayOrder: 1 }
            ],
            hierarchy: {
                level: 2,
                canContain: [],
                canBeContainedBy: [],
                defaultExpanded: false
            },
            behavior: {
                selectable: true,
                draggable: true,
                expandable: true,
                traceable: true,
                clickAction: 'select',
                doubleClickAction: 'expand'
            }
        }))

        const edgeTypes = new Set<string>()
        this.edges.forEach(e => edgeTypes.add(e.edgeType))

        const relationshipTypes = Array.from(edgeTypes).map(id => ({
            id: id.toLowerCase(),
            name: id.charAt(0).toUpperCase() + id.slice(1).toLowerCase(),
            description: `Relationship type: ${id}`,
            sourceTypes: ['*'],
            targetTypes: ['*'],
            visual: {
                strokeColor: '#6366f1',
                strokeWidth: 2,
                strokeStyle: 'solid',
                animated: true,
                animationSpeed: 'normal',
                arrowType: 'arrow',
                curveType: 'bezier'
            },
            bidirectional: false,
            showLabel: false,
            isContainment: id === 'CONTAINS' || id === 'BELONGS_TO'
        }))

        return {
            version: '1.0.0',
            entityTypes,
            relationshipTypes,
            rootEntityTypes: ['domain', 'container', 'dataPlatform'],
            containmentEdgeTypes: ['CONTAINS', 'BELONGS_TO']
        }
    }

    // ==========================================
    // Aggregated Edge Operations
    // ==========================================

    async getAggregatedEdges(request: AggregatedEdgeRequest): Promise<AggregatedEdgeResult> {
        // Mock implementation: group edges by source and target container
        const aggregatedMap: Map<string, { sourceUrn: string; targetUrn: string; edges: GraphEdge[] }> = new Map()

        const sourceSet = new Set(request.sourceUrns)

        // Derive containment types from ontology — no hardcoding
        const ontology = await this.getOntologyMetadata()
        const containmentSet = new Set(ontology.containmentEdgeTypes.map(t => t.toUpperCase()))

        for (const edge of this.edges) {
            // Skip containment edges — ontology-driven
            if (containmentSet.has(edge.edgeType.toUpperCase())) continue

            // Check if edge involves source URNs
            if (!sourceSet.has(edge.sourceUrn) && !sourceSet.has(edge.targetUrn)) continue

            // If target URNs specified, filter
            if (request.targetUrns?.length) {
                const targetSet = new Set(request.targetUrns)
                if (!targetSet.has(edge.sourceUrn) && !targetSet.has(edge.targetUrn)) continue
            }

            const key = `${edge.sourceUrn}->${edge.targetUrn}`
            if (!aggregatedMap.has(key)) {
                aggregatedMap.set(key, { sourceUrn: edge.sourceUrn, targetUrn: edge.targetUrn, edges: [] })
            }
            aggregatedMap.get(key)!.edges.push(edge)
        }

        const aggregatedEdges = Array.from(aggregatedMap.entries()).map(([key, data]) => ({
            id: `agg-${key}`,
            sourceUrn: data.sourceUrn,
            targetUrn: data.targetUrn,
            edgeCount: data.edges.length,
            edgeTypes: [...new Set(data.edges.map(e => e.edgeType))],
            confidence: data.edges.reduce((sum, e) => sum + (e.confidence ?? 1), 0) / data.edges.length,
            sourceEdgeIds: data.edges.map(e => e.id)
        }))

        return {
            aggregatedEdges,
            totalSourceEdges: this.edges.filter(e => sourceSet.has(e.sourceUrn) || sourceSet.has(e.targetUrn)).length
        }
    }

    // ==========================================
    // Node Creation
    // ==========================================

    async createNode(request: CreateNodeRequest): Promise<CreateNodeResult> {
        // Mock implementation: create node in memory
        const urn = `urn:mock:${request.entityType}:${Date.now()}`

        const newNode: GraphNode = {
            urn,
            entityType: request.entityType,
            displayName: request.displayName,
            qualifiedName: request.displayName,
            description: request.properties.description as string | undefined,
            properties: request.properties,
            tags: request.tags,
            childCount: 0,
            sourceSystem: 'manual'
        }

        this.nodes.set(urn, newNode)

        let containmentEdge: GraphEdge | null = null

        // Create containment edge if parent specified
        if (request.parentUrn) {
            const parentNode = this.nodes.get(request.parentUrn)
            if (!parentNode) {
                return {
                    node: null,
                    containmentEdge: null,
                    success: false,
                    error: `Parent node not found: ${request.parentUrn}`
                }
            }

            containmentEdge = {
                id: `contains-${request.parentUrn}-${urn}`,
                sourceUrn: request.parentUrn,
                targetUrn: urn,
                edgeType: 'CONTAINS',
                confidence: 1.0,
                properties: {}
            }

            this.edges.push(containmentEdge)

            // Update indices
            const downstream = this.downstreamMap.get(request.parentUrn) ?? []
            downstream.push(containmentEdge)
            this.downstreamMap.set(request.parentUrn, downstream)

            const upstream = this.upstreamMap.get(urn) ?? []
            upstream.push(containmentEdge)
            this.upstreamMap.set(urn, upstream)

            // Update parent's child count
            parentNode.childCount = (parentNode.childCount ?? 0) + 1
        }

        return {
            node: newNode,
            containmentEdge,
            success: true
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
