/**
 * Placement rules — pure extraction of how `useLayerAssignment` decides which
 * layer a root-level node belongs to. Two halves, both used by the hook and by
 * the trace view model, so the overlay places a node exactly where the canvas
 * behind it would:
 *
 *  • `buildLayerRules` — the view's layers compiled into the rule list the
 *    rule engine matches against (`resolveLayerAssignment`).
 *  • `resolveRootLayer` — the priority chain that picks the winner.
 *
 * Chain: instance drag (live user drag this session) → explicit
 * (referenceLayout.assignments, authoritative in both scopes) → curated
 * scope (closed: an unlisted root drops out, EXCEPT a branch-created node
 * placed by its own durable, view-valid stamped `layerAssignment`) → open
 * scope (backend effective assignment → stamped `layerAssignment` → rule
 * match → containment-inherited layer → showUnassigned fallback layer).
 * The `'__UNASSIGNED__'` sentinel always resolves to undefined, regardless
 * of which branch produced it.
 */
import type { EntityType, LayerAssignmentRule } from '@/providers/GraphDataProvider'
import type { ViewLayerConfig } from '@/types/schema'

/**
 * Compile a view's layers into layer-assignment rules, in the layer order the
 * canvas renders them (pass layers sorted by `order`, as the hook's
 * `sortedLayers` are).
 *
 * Two sources, in this order: a layer's authored `rules`, then an
 * auto-generated per-entity-type rule for each of its `entityTypes` — the
 * primary ontology-driven mechanism, priced at `layer.order * 10 + idx` so a
 * later layer's type rule outranks an earlier one's. `resolveLayerAssignment`
 * sorts by priority (highest first), so authored rules with a higher priority
 * win over generated ones.
 */
export function buildLayerRules(sortedLayers: ViewLayerConfig[]): LayerAssignmentRule[] {
  const generatedRules: LayerAssignmentRule[] = []

  sortedLayers.forEach(layer => {
    // 1. Explicit rules from config
    if (layer.rules) {
      layer.rules.forEach(rule => {
        generatedRules.push({
          id: rule.id,
          layerId: layer.id,
          entityTypes: (rule.entityTypes ?? []) as EntityType[],
          tags: rule.tags,
          urnPattern: rule.urnPattern,
          propertyMatch: rule.propertyMatch,
          priority: rule.priority
        })
      })
    }

    // 2. Auto-generate entity-type rules from layer.entityTypes.
    // When a layer declares entityTypes: ['glossary', 'term'], nodes of those
    // types are automatically routed here — this is the primary ontology-driven
    // assignment mechanism. Explicit entity assignments and rules above take
    // precedence (higher priority values win in resolveLayerAssignment).
    if (layer.entityTypes && layer.entityTypes.length > 0) {
      layer.entityTypes.forEach((entityType, idx) => {
        generatedRules.push({
          id: `${layer.id}-type-${entityType}`,
          layerId: layer.id,
          entityTypes: [entityType],
          priority: layer.order * 10 + idx,
        })
      })
    }
  })

  return generatedRules
}

export interface RootLayerInputs {
  nodeId: string
  nodeUrn: string
  nodeLayerProp: string | undefined      // validated stamped layerAssignment (undefined if not a view layer)
  instanceAssignment: string | undefined
  explicitAssignment: string | undefined // referenceLayout.assignments[nodeId]?.layerId
  viewIsCurated: boolean
  branchCreated: boolean                 // urn ∈ branch-created delta
  backendAssignment: string | undefined  // effectiveAssignments.get(nodeId)?.layerId
  ruleAssignment: string | undefined
  inheritedLayerId: string | undefined
  unassignedFallbackLayerId: string | undefined  // open scope showUnassigned layer
}

export function resolveRootLayer(i: RootLayerInputs): string | undefined {
  let layer: string | undefined
  if (i.instanceAssignment) layer = i.instanceAssignment
  else if (i.explicitAssignment !== undefined) layer = i.explicitAssignment
  else if (i.viewIsCurated) layer = i.branchCreated ? i.nodeLayerProp : undefined
  else layer = i.backendAssignment ?? i.nodeLayerProp ?? i.ruleAssignment ?? i.inheritedLayerId ?? i.unassignedFallbackLayerId
  return layer === '__UNASSIGNED__' ? undefined : layer
}
