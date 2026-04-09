/**
 * Graph Data Providers
 * 
 * This module exports the graph data provider abstraction layer,
 * enabling easy integration with FalkorDB, Neo4j, DataHub, or custom backends.
 */

// Core types and interfaces
export type {
    URN,
    EntityType,
    EdgeType,
    GraphNode,
    GraphEdge,
    NodeQuery,
    EdgeQuery,
    LineageResult,
    ContainmentResult,
    GraphDataProvider,
    GraphProviderContextValue,
    LayerAssignmentRule,
} from './GraphDataProvider'

export { resolveLayerAssignment } from './GraphDataProvider'

// React integration
export {
    GraphProvider,
    useGraphProvider,
    useGraphProviderContext,
    useNode,
    useChildren,
    useLineage,
    useNodeSearch,
} from './GraphProviderContext'
