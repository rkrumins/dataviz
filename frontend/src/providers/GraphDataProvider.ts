/**
 * GraphDataProvider - Abstract interface for graph data sources
 * 
 * This interface abstracts the underlying graph database, enabling
 * easy integration with FalkorDB, Neo4j, DataHub GraphQL, or any
 * other graph data source.
 */

import { LogicalNodeConfig, LayerAssignmentRuleConfig, RuleCondition, ScopeFilterConfig } from '../types/schema'

// ============================================
// URN Types (DataHub Compatible)
// ============================================

/**
 * Unique Resource Name following DataHub convention
 * Examples:
 * - urn:li:dataset:(urn:li:dataPlatform:snowflake,finance.revenue,PROD)
 * - urn:li:schemaField:(urn:li:dataset:...,amount)
 * - urn:li:dataJob:(urn:li:dataFlow:...,transform_revenue)
 */
export type URN = string

/**
 * Entity types aligned with DataHub and common metadata catalogs
 */
export type EntityType =
    | 'dataPlatform'   // Snowflake, Databricks, etc.
    | 'container'      // Database, Schema, Folder
    | 'dataset'        // Table, View, File
    | 'schemaField'    // Column
    | 'dataJob'        // Pipeline, Job
    | 'dataFlow'       // DAG, Workflow
    | 'dashboard'      // BI Dashboard
    | 'chart'          // Individual chart/visualization
    | 'glossaryTerm'   // Business term
    | 'tag'            // Classification tag

/**
 * Edge types for relationships between entities
 */
export type EdgeType =
    | 'CONTAINS'       // Parent-child containment (table contains columns)
    | 'BELONGS_TO'     // Inverse of CONTAINS
    | 'TRANSFORMS'     // Data lineage (ETL, SQL transform)
    | 'PRODUCES'       // Job produces dataset
    | 'CONSUMES'       // Job consumes dataset
    | 'TAGGED_WITH'    // Entity tagged with term/classification
    | 'RELATED_TO'     // Generic relationship

// ============================================
// Graph Node & Edge
// ============================================

/**
 * Normalized node representation from any graph source
 */
export interface GraphNode {
    /** Unique identifier (URN format preferred) */
    urn: URN

    /** Entity type for rendering and behavior */
    entityType: EntityType

    /** Human-readable name */
    displayName: string

    /** Technical name/path */
    qualifiedName?: string

    /** Optional description */
    description?: string

    /** Arbitrary properties from source system */
    properties: Record<string, unknown>

    /** Tags for classification and layer assignment */
    tags?: string[]

    /** Resolved layer assignment (if applicable) */
    layerAssignment?: string

    /** Count of contained children (when collapsed) */
    childCount?: number

    /** Source system identifier */
    sourceSystem?: string

    /** Last sync timestamp */
    lastSyncedAt?: string
}

/**
 * Relationship between two graph nodes
 */
export interface GraphEdge {
    /** Unique edge identifier */
    id: string

    /** Source node URN */
    sourceUrn: URN

    /** Target node URN */
    targetUrn: URN

    /** Relationship type */
    edgeType: EdgeType

    /** Confidence score for derived relationships (0.0 - 1.0) */
    confidence?: number

    /** Additional edge properties */
    properties?: Record<string, unknown>
}

// ============================================
// Query Types
// ============================================

export interface NodeQuery {
    /** Filter by URNs */
    urns?: URN[]

    /** Filter by entity types */
    entityTypes?: EntityType[]

    /** Filter by tags */
    tags?: string[]

    /** Filter by layer assignment */
    layerId?: string

    /** Full-text search query */
    searchQuery?: string

    /** Pagination offset */
    offset?: number

    /** Pagination limit */
    limit?: number
}

export interface EdgeQuery {
    /** Filter by source URNs */
    sourceUrns?: URN[]

    /** Filter by target URNs */
    targetUrns?: URN[]

    /** Include edges where URNs appear as source OR target */
    anyUrns?: URN[]

    /** Filter by edge types */
    edgeTypes?: EdgeType[]

    /** Minimum confidence score */
    minConfidence?: number

    /** Pagination offset */
    offset?: number

    /** Pagination limit */
    limit?: number
}

export interface LineageResult {
    /** Nodes in the lineage path */
    nodes: GraphNode[]

    /** Edges connecting the nodes */
    edges: GraphEdge[]

    /** URNs of upstream nodes (relative to starting point) */
    upstreamUrns: Set<URN>

    /** URNs of downstream nodes (relative to starting point) */
    downstreamUrns: Set<URN>

    /** Total count (may exceed returned nodes due to pagination) */
    totalCount: number

    /** Whether more results are available */
    hasMore: boolean
}

export interface ContainmentResult {
    /** Parent node (null if querying root) */
    parent: GraphNode | null

    /** Direct children */
    children: GraphNode[]

    /** Whether children have their own children */
    hasNestedChildren: boolean
}

// ============================================
// Provider Interface
// ============================================

/**
 * Abstract interface for graph data providers
 * 
 * Implementations:
 * - MockProvider: Uses local demo data
 * - FalkorDBProvider: Cypher queries to FalkorDB/Neo4j
 * - DataHubProvider: GraphQL queries to DataHub
 */
export interface GraphDataProvider {
    /** Provider name for debugging */
    readonly name: string

    // ==========================================
    // Node Operations
    // ==========================================

    /**
     * Get a single node by URN
     */
    getNode(urn: URN): Promise<GraphNode | null>

    /**
     * Query multiple nodes
     */
    getNodes(query: NodeQuery): Promise<GraphNode[]>

    /**
     * Search nodes by text query
     */
    searchNodes(query: string, limit?: number): Promise<GraphNode[]>

    // ==========================================
    // Edge Operations
    // ==========================================

    /**
     * Query edges matching criteria
     */
    getEdges(query: EdgeQuery): Promise<GraphEdge[]>

    // ==========================================
    // Containment Hierarchy (CONTAINS relationships)
    // ==========================================

    /**
     * Get direct children of a node
     * @param parentUrn - Parent node URN
     * @param options - Pagination and filtering options
     */
    getChildren(
        parentUrn: URN,
        options?: {
            entityTypes?: EntityType[]
            edgeTypes?: string[] // Custom edge types for containment
            offset?: number
            limit?: number
        }
    ): Promise<GraphNode[]>

    /**
     * Get parent of a node (inverse of CONTAINS)
     */
    getParent(childUrn: URN): Promise<GraphNode | null>

    /**
     * Get all ancestors up to root
     */
    getAncestors(urn: URN): Promise<GraphNode[]>

    /**
     * Get all descendants recursively
     * @param depth - Maximum depth (default: 10)
     */
    getDescendants(urn: URN, depth?: number): Promise<GraphNode[]>

    // ==========================================
    // Lineage Traversal
    // ==========================================

    /**
     * Get upstream lineage (data sources flowing INTO this entity)
     * @param urn - Starting entity URN
     * @param depth - How many hops upstream
     * @param includeColumnLineage - Include column-level lineage
     */
    getUpstream(
        urn: URN,
        depth: number,
        includeColumnLineage?: boolean
    ): Promise<LineageResult>

    /**
     * Get downstream lineage (entities this data flows TO)
     * @param urn - Starting entity URN
     * @param depth - How many hops downstream
     * @param includeColumnLineage - Include column-level lineage
     */
    getDownstream(
        urn: URN,
        depth: number,
        includeColumnLineage?: boolean
    ): Promise<LineageResult>

    /**
     * Get both upstream and downstream lineage
     */
    getFullLineage(
        urn: URN,
        upstreamDepth: number,
        downstreamDepth: number,
        includeColumnLineage?: boolean
    ): Promise<LineageResult>

    // ==========================================
    // Layer/Classification Queries
    // ==========================================

    /**
     * Get nodes assigned to a specific layer
     * Layer assignment can be by tag, entity type, or explicit mapping
     */
    getNodesByLayer(layerId: string): Promise<GraphNode[]>

    /**
     * Get nodes with a specific tag
     */
    getNodesByTag(tag: string): Promise<GraphNode[]>

    // ==========================================
    // Metadata Operations
    // ==========================================

    /**
     * Get available entity types in the graph
     */
    getEntityTypes(): Promise<EntityType[]>

    /**
     * Get all unique tags in the graph
     */
    getTags(): Promise<string[]>

    /**
     * Get graph statistics
     */
    getStats(): Promise<{
        nodeCount: number
        edgeCount: number
        entityTypeCounts: Record<EntityType, number>
    }>

    // ==========================================
    // Assignment Operations
    // ==========================================

    /**
     * Compute layer assignments for the graph (server-side)
     */
    computeLayerAssignments(request: LayerAssignmentRequest): Promise<LayerAssignmentResult>
}

// ============================================
// Provider Context Value
// ============================================

export interface GraphProviderContextValue {
    provider: GraphDataProvider
    isLoading: boolean
    error: Error | null
}

// ============================================
// Layer Configuration
// ============================================

export interface LayerAssignmentRule {
    /** Rule identifier */
    id: string

    /** Layer this rule assigns to */
    layerId: string

    /** Match by entity types */
    entityTypes?: EntityType[]

    /** Match by tags (any match) */
    tags?: string[]

    /** Match by URN pattern (glob or regex) */
    urnPattern?: string

    /** Match by property value */
    propertyMatch?: {
        field: string
        operator?: 'equals' | 'contains' | 'startsWith' | 'exists'
        value?: unknown
    }

    /** Match by compound conditions (Phase 3) */
    conditions?: RuleCondition[]

    /** Priority for conflict resolution (higher wins) */
    priority: number
}

/**
 * Resolve layer assignment for a node based on rules
 */
/**
 * Check if a node matches a specific rule's criteria
 */
/**
 * Helper to evaluate a single condition against a node
 */
function evaluateCondition(node: GraphNode, field: string, operator: string, targetValue: any): boolean {
    // Resolve value from node properties OR top-level fields
    let actualValue = node.properties[field]
    if (actualValue === undefined) {
        // Fallback to top-level fields
        if (field === 'name') actualValue = node.displayName
        else if (field === 'type') actualValue = node.entityType
        else if (field === 'urn') actualValue = node.urn
    }

    switch (operator) {
        case 'exists':
            return actualValue !== undefined && actualValue !== null
        case 'contains':
            if (typeof actualValue === 'string' && typeof targetValue === 'string') {
                return actualValue.toLowerCase().includes(targetValue.toLowerCase())
            } else if (Array.isArray(actualValue)) {
                return actualValue.includes(targetValue)
            }
            return false
        case 'startsWith':
            if (typeof actualValue === 'string' && typeof targetValue === 'string') {
                return actualValue.toLowerCase().startsWith(targetValue.toLowerCase())
            }
            return false
        case 'endsWith':
            if (typeof actualValue === 'string' && typeof targetValue === 'string') {
                return actualValue.toLowerCase().endsWith(targetValue.toLowerCase())
            }
            return false
        case 'notEquals':
            return actualValue !== targetValue
        case 'equals':
        default:
            return actualValue === targetValue
    }
}

export function matchesRule(
    node: GraphNode,
    rule: LayerAssignmentRule | LayerAssignmentRuleConfig
): boolean {
    // 1. Check entity type match
    if (rule.entityTypes && rule.entityTypes.length > 0) {
        if (!rule.entityTypes.includes(node.entityType)) {
            return false
        }
    }

    // 2. Check tag match
    if (rule.tags && rule.tags.length > 0) {
        if (!node.tags || !node.tags.some(t => rule.tags!.includes(t))) {
            return false
        }
    }

    // 3. Check URN pattern match
    if (rule.urnPattern) {
        const regex = new RegExp(rule.urnPattern.replace(/\*/g, '.*'))
        if (!regex.test(node.urn)) {
            return false
        }
    }

    // 4. Check Compound Conditions (Phase 3)
    if (rule.conditions && rule.conditions.length > 0) {
        // All conditions must match (AND)
        for (const condition of rule.conditions) {
            if (!evaluateCondition(node, condition.field, condition.operator, condition.value)) {
                return false
            }
        }
        return true
    }

    // 5. Fallback Check Single Property Match (Legacy)
    if (rule.propertyMatch) {
        const { field, operator = 'equals', value } = rule.propertyMatch
        if (!evaluateCondition(node, field, operator, value)) {
            return false
        }
    }

    return true
}

/**
 * Resolve layer assignment for a node based on rules
 */
export function resolveLayerAssignment(
    node: GraphNode,
    rules: LayerAssignmentRule[]
): string | undefined {
    // Sort by priority (highest first)
    const sortedRules = [...rules].sort((a, b) => b.priority - a.priority)

    for (const rule of sortedRules) {
        if (matchesRule(node, rule)) {
            return rule.layerId
        }
    }

    return undefined
}

/**
 * Recursively find the best logical node assignment for a physical node
 * 
 * Strategy:
 * 1. Depth-First Search: Check children first (specificity).
 * 2. Check rules on the current logical node.
 * 3. Priority: Rules with higher priority win within the same node context?
 *    Actually, users might define rules on "Payment Platform".
 */
export function resolveLogicalAssignment(
    node: GraphNode,
    logicalNodes: LogicalNodeConfig[]
): string | undefined {
    for (const logicalNode of logicalNodes) {
        // 1. Check children first (Depth-First)
        if (logicalNode.children && logicalNode.children.length > 0) {
            const childMatch = resolveLogicalAssignment(node, logicalNode.children)
            if (childMatch) return childMatch
        }

        // 2. Check rules on this node
        if (logicalNode.rules && logicalNode.rules.length > 0) {
            // Check if any rule matches
            // We take the highest priority match if multiple exist? 
            // Or just any match? Assuming logical nodes are distinct enough.
            // Let's sort rules by priority just in case.
            const sortedRules = [...logicalNode.rules].sort((a, b) => b.priority - a.priority)

            for (const rule of sortedRules) {
                if (matchesRule(node, rule)) {
                    return logicalNode.id
                }
            }
        }
    }
    return undefined
}

export interface EntityAssignment {
    entityId: string;
    layerId: string;
    logicalNodeId?: string; // If assigned to a specific logical node within the layer
    ruleId?: string;        // Which rule caused this assignment
    isInherited: boolean;   // True if assigned via parent
    inheritedFromId?: string; // ID of the parent entity providing the assignment
    confidence: number;     // 1.0 for manual/explicit, <1.0 for inference
}

export interface LayerAssignmentResult {
    assignments: Map<string, EntityAssignment>;
    parentMap: Map<string, string>;
    edges: GraphEdge[];
    unassignedEntityIds: string[];
    stats: {
        totalNodes: number;
        assignedNodes: number;
        computeTimeMs: number;
    };
}

export interface LayerAssignmentRequest {
    scopeFilter?: ScopeFilterConfig;
    layers: {
        layerId: string;
        sequence: number;
        entityTypes: string[];
        rules: LayerAssignmentRuleConfig[];
        logicalNodes?: LogicalNodeConfig[];
    }[];
    includeEdges: boolean;
}
