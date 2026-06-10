/**
 * MIGRATION SHIM — the ontology preflight rules now live in the graph-authoring
 * feature as `ontologyGuard`. The legacy create/edge-create components still
 * import from here; both are replaced (and this shim deleted) by the
 * graph-authoring rebuild.
 */
export {
  NON_DRAWABLE_EDGE_TYPES,
  allowedChildTypeIds,
  isDrawableLineageType,
  deriveConnectableEdges,
} from '@/features/graph-authoring/model/ontologyGuard'
export type { AllowedEdgeOption, EdgeDirection } from '@/features/graph-authoring/model/ontologyGuard'
