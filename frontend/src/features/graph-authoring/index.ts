/**
 * graph-authoring — the cohesive, ontology-enforced CRUD authoring layer for the
 * Context View canvas. Users author RAW nodes and edges (validated client-side
 * against the resolved ontology, with the backend mutation_validator as the
 * final gate); AGGREGATED edges stay derived-after-publish and are surfaced as
 * read-only status, never authored here.
 *
 * NOTE: this feature drives the Context View canvas only. The React-Flow
 * GraphCanvas / HierarchyCanvas keep the legacy useCanvasInteractions +
 * CanvasContextMenu; unifying them is deliberately out of scope.
 */

// Controller + gesture
export { useGraphAuthoring, type GraphAuthoringController, type UseGraphAuthoringOptions, type ConnectContext } from './hooks/useGraphAuthoring'
export { useConnectGesture, nodeIdAt } from './hooks/useConnectGesture'

// Model (ontology rules + staging + mode)
export * from './model/ontologyGuard'
export * from './model/authoringMode'
export { stageEntityCreate, stageNodeUpdate, stageNodeDelete, type StageEntityCreateInput } from './model/stageNode'
export { stageEdgeCreate, stageEdgeDelete, stageEdgeReverse, stageEdgeRetype, stageEdgePropertyEdit } from './model/stageEdge'
