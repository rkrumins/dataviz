/**
 * useEntityVisual / useEdgeVisual — unified hooks for visual resolution.
 *
 * Single source of truth for entity and edge type visuals in the frontend.
 * Reads from the schema store (backed by React Query) so visuals always reflect
 * the server-side ontology definition.
 *
 * Usage in components:
 *   const visual = useEntityVisual('dataset')
 *   const edgeStyle = useEdgeVisual('FLOWS_TO')
 *
 * Usage in non-hook contexts (e.g. canvas renderers, utilities):
 *   const visual = getEntityVisual(schemaStore.getState(), 'dataset')
 *   const edgeStyle = getEdgeVisual(schemaStore.getState(), 'FLOWS_TO')
 */
import { useSchemaStore } from '@/store/schema'
import type { EntityVisualConfig, RelationshipVisualConfig } from '@/types/schema'

// -----------------------------------------------------------------------
// Fallback defaults (used when schema is not yet loaded or type is unknown)
// -----------------------------------------------------------------------

const ENTITY_VISUAL_FALLBACK: EntityVisualConfig = {
  icon: 'Box',
  color: '#6366f1',
  shape: 'rounded',
  size: 'md',
  borderStyle: 'solid',
  showInMinimap: true,
}

const EDGE_VISUAL_FALLBACK: RelationshipVisualConfig = {
  strokeColor: '#6366f1',
  strokeWidth: 2,
  strokeStyle: 'solid',
  animated: true,
  animationSpeed: 'normal',
  arrowType: 'arrow',
  curveType: 'bezier',
}
const EMPTY_STRING_ARRAY: string[] = []

// -----------------------------------------------------------------------
// Hook variants (for React components)
// -----------------------------------------------------------------------

/**
 * Returns visual configuration for an entity type.
 * Falls back to ENTITY_VISUAL_FALLBACK for unknown types.
 */
export function useEntityVisual(typeId: string): EntityVisualConfig {
  const getEntityVisual = useSchemaStore((s) => s.getEntityVisual)
  return getEntityVisual(typeId) ?? ENTITY_VISUAL_FALLBACK
}

/**
 * Returns visual configuration for a relationship (edge) type.
 * Falls back to EDGE_VISUAL_FALLBACK for unknown types.
 * Case-insensitive matching (FLOWS_TO === flows_to).
 */
export function useEdgeVisual(edgeTypeId: string): RelationshipVisualConfig {
  const schema = useSchemaStore((s) => s.schema)
  return getEdgeVisualFromSchema(schema, edgeTypeId)
}

// -----------------------------------------------------------------------
// Non-hook accessors (for utilities, canvas renderers, etc.)
// -----------------------------------------------------------------------

/**
 * Get entity visual without a React hook.
 * Call with useSchemaStore.getState() or pass a schema directly.
 */
export function getEntityVisual(
  schemaOrState: { schema: ReturnType<typeof useSchemaStore.getState>['schema'] } | null,
  typeId: string,
): EntityVisualConfig {
  if (!schemaOrState?.schema) return ENTITY_VISUAL_FALLBACK
  const entityType = schemaOrState.schema.entityTypes.find((et) => et.id === typeId)
  if (!entityType) return ENTITY_VISUAL_FALLBACK
  return entityType.visual
}

/**
 * Get edge visual without a React hook.
 */
export function getEdgeVisual(
  schemaOrState: { schema: ReturnType<typeof useSchemaStore.getState>['schema'] } | null,
  edgeTypeId: string,
): RelationshipVisualConfig {
  if (!schemaOrState?.schema) return EDGE_VISUAL_FALLBACK
  return getEdgeVisualFromSchema(schemaOrState.schema, edgeTypeId)
}

// -----------------------------------------------------------------------
// Shared implementation
// -----------------------------------------------------------------------

function getEdgeVisualFromSchema(
  schema: ReturnType<typeof useSchemaStore.getState>['schema'],
  edgeTypeId: string,
): RelationshipVisualConfig {
  if (!schema) return EDGE_VISUAL_FALLBACK

  const normalized = edgeTypeId.toUpperCase()
  const relType = schema.relationshipTypes.find(
    (rt) => rt.id.toUpperCase() === normalized
  )
  if (!relType) return EDGE_VISUAL_FALLBACK

  return relType.visual
}

// -----------------------------------------------------------------------
// Convenience: check classifications from resolved metadata
// -----------------------------------------------------------------------

/** Returns true if the edge type is classified as containment in the active schema. */
export function useIsContainmentEdge(edgeTypeId: string): boolean {
  const containmentTypes = useSchemaStore((s) => s.schema?.containmentEdgeTypes ?? EMPTY_STRING_ARRAY)
  return containmentTypes.some((t) => t.toUpperCase() === edgeTypeId.toUpperCase())
}

/** Returns true if the edge type is classified as lineage in the active schema. */
export function useIsLineageEdge(edgeTypeId: string): boolean {
  const schema = useSchemaStore((s) => s.schema)
  if (!schema) return false
  const normalized = edgeTypeId.toUpperCase()
  const relType = schema.relationshipTypes.find(
    (rt) => rt.id.toUpperCase() === normalized
  )
  return (relType as any)?.isLineage ?? true  // default true for unknown types (conservative)
}
