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
import { generateColorFromType, generateIconFallback, generateEdgeColorFromType } from '@/lib/type-visuals'

// -----------------------------------------------------------------------
// Fallback generators (per-type deterministic visuals for unknown types)
// -----------------------------------------------------------------------

function entityVisualFallback(typeId: string): EntityVisualConfig {
  return {
    icon: generateIconFallback(typeId),
    color: generateColorFromType(typeId),
    shape: 'rounded',
    size: 'md',
    borderStyle: 'solid',
    showInMinimap: true,
  }
}

function edgeVisualFallback(edgeTypeId: string): RelationshipVisualConfig {
  return {
    strokeColor: generateEdgeColorFromType(edgeTypeId),
    strokeWidth: 2,
    strokeStyle: 'solid',
    animated: true,
    animationSpeed: 'normal',
    arrowType: 'arrow',
    curveType: 'bezier',
  }
}

// -----------------------------------------------------------------------
// Hook variants (for React components)
// -----------------------------------------------------------------------

/**
 * Returns visual configuration for an entity type.
 * Falls back to a deterministic palette-based visual for unknown types.
 */
export function useEntityVisual(typeId: string): EntityVisualConfig {
  const getEntityVisual = useSchemaStore((s) => s.getEntityVisual)
  return getEntityVisual(typeId) ?? entityVisualFallback(typeId)
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
  if (!schemaOrState?.schema) return entityVisualFallback(typeId)
  const entityType = schemaOrState.schema.entityTypes.find((et) => et.id === typeId)
  if (!entityType) return entityVisualFallback(typeId)
  return entityType.visual
}

/**
 * Get edge visual without a React hook.
 */
export function getEdgeVisual(
  schemaOrState: { schema: ReturnType<typeof useSchemaStore.getState>['schema'] } | null,
  edgeTypeId: string,
): RelationshipVisualConfig {
  if (!schemaOrState?.schema) return edgeVisualFallback(edgeTypeId)
  return getEdgeVisualFromSchema(schemaOrState.schema, edgeTypeId)
}

// -----------------------------------------------------------------------
// Shared implementation
// -----------------------------------------------------------------------

function getEdgeVisualFromSchema(
  schema: ReturnType<typeof useSchemaStore.getState>['schema'],
  edgeTypeId: string,
): RelationshipVisualConfig {
  if (!schema) return edgeVisualFallback(edgeTypeId)

  const normalized = edgeTypeId.toUpperCase()
  const relType = schema.relationshipTypes.find(
    (rt) => rt.id.toUpperCase() === normalized
  )
  if (!relType) return edgeVisualFallback(edgeTypeId)

  return relType.visual
}

// -----------------------------------------------------------------------
// Convenience hooks
// -----------------------------------------------------------------------

/**
 * Returns a color set derived from the entity type's visual config.
 * Useful for components that need bg/text/accent inline styles.
 */
export function useEntityColorSet(typeId: string): { hex: string; bg: string; text: string; accent: string } {
  const visual = useEntityVisual(typeId)
  return {
    hex: visual.color,
    bg: `${visual.color}1a`,    // 10% opacity
    text: visual.color,
    accent: visual.color,
  }
}
