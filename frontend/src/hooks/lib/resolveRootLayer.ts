/**
 * resolveRootLayer - pure extraction of useLayerAssignment's root-level
 * layer priority chain (browse-mode placement rule).
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
