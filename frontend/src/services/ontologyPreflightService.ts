/**
 * ontologyPreflightService — the ontology rules the authoring UI applies *before*
 * a change is saved (the backend re-validates authoritatively on save).
 *
 * These derive purely from the resolved ontology already in the schema store
 * (entity hierarchy, relationship source/target types). We deliberately do NOT
 * call the backend `allowed-children`/`allowed-edges` endpoints: those resolve
 * the *persisted* node, so they 404 on a staged-but-unsaved parent/source —
 * which is exactly the grandparent→parent→child hierarchy case. Deriving
 * client-side is authoritative (same resolved ontology), instant, and works
 * for staged nodes.
 */
import type { AllowedEdgeOption } from '@/providers/GraphDataProvider'
import type { EntityTypeSchema, RelationshipTypeSchema } from '@/types/schema'

export type { AllowedEdgeOption, EdgeDirection } from '@/providers/GraphDataProvider'

/**
 * Edge types a user must NEVER draw by hand. `AGGREGATED` is synthetic — it is
 * materialized by the background rollup job after a draft is published, never
 * authored. (It is flagged `is_lineage`, so it leaks into `lineageEdgeTypes`
 * and has to be excluded explicitly.)
 */
export const NON_DRAWABLE_EDGE_TYPES = new Set<string>(['AGGREGATED'])

/**
 * The entity type ids that may be created directly under a parent of
 * `parentType` (or at the root when `parentType` is null), per the ontology's
 * containment rules. An empty `canContain` means "unrestricted" (allow all).
 */
export function allowedChildTypeIds(
  parentType: string | null,
  entityTypes: EntityTypeSchema[],
  rootEntityTypes: string[],
  hierarchyMap: Record<string, { canContain?: string[] }>,
): Set<string> {
  if (!parentType) {
    // Root level: the ontology's declared roots, or — until the ontology
    // loads — types nothing can contain (canBeContainedBy === []).
    if (rootEntityTypes.length > 0) return new Set(rootEntityTypes)
    return new Set(entityTypes.filter((et) => et.hierarchy.canBeContainedBy.length === 0).map((et) => et.id))
  }
  const fromSchema = entityTypes.find((et) => et.id === parentType)?.hierarchy.canContain ?? []
  const fromOntology = hierarchyMap[parentType]?.canContain ?? []
  const canContain = [...new Set([...fromSchema, ...fromOntology])]
  // Empty canContain = unrestricted: every type is a valid child.
  if (canContain.length === 0) return new Set(entityTypes.map((et) => et.id))
  return new Set(canContain)
}

/**
 * Whether a relationship type is a RAW lineage edge a user may draw by hand.
 * Mirrors GraphCanvas.getValidEdgeTypes' classification rather than relying on
 * the schema store's `lineageEdgeTypes` list (which is frequently empty when the
 * backend omits it — the cause of the "No lineage edge types defined" bug):
 * exclude the synthetic AGGREGATED type and any containment type, then treat the
 * rest as lineage (`rt.isLineage ?? !isContainment`). Containment is the explicit
 * `rt.isContainment` flag, or membership in `containmentEdgeTypes` as a fallback.
 */
export function isDrawableLineageType(
  rt: RelationshipTypeSchema,
  containmentEdgeTypes: string[],
): boolean {
  if (NON_DRAWABLE_EDGE_TYPES.has(rt.id)) return false
  const containmentSet = new Set(containmentEdgeTypes.map((t) => t.toUpperCase()))
  const isContainment = rt.isContainment ?? containmentSet.has(rt.id.toUpperCase())
  if (isContainment) return false
  return rt.isLineage ?? true
}

/** True when `type` satisfies an endpoint constraint (empty / '*' = wildcard). */
function endpointOk(type: string | null, allowedTypes: string[] | undefined): boolean {
  return !type || !allowedTypes?.length || allowedTypes.includes('*') || allowedTypes.includes(type)
}

/** Whether a relationship type is a containment edge (explicit flag, or membership fallback). */
export function isContainmentRelType(
  rt: RelationshipTypeSchema,
  containmentEdgeTypes: string[],
): boolean {
  if (rt.isContainment != null) return rt.isContainment
  const set = new Set(containmentEdgeTypes.map((t) => t.toUpperCase()))
  return set.has(rt.id.toUpperCase())
}

/**
 * The containment relationship types that may nest a `childType` under a
 * `parentType`. A containment edge is ALWAYS stored parent→child (source=parent,
 * target=child), so a type is only valid when the pair satisfies its endpoint
 * constraints in that FORWARD orientation — i.e. the parent type is an allowed
 * source and the child type an allowed target. (A predicate authored child→parent,
 * such as a restrictively-typed `partOf`, would be stored against its own
 * constraints, so it is correctly excluded; model it as parent→child in the
 * ontology to use it for nesting.) Empty / '*' endpoint lists mean unrestricted.
 * A type failing forward is returned `allowed:false` with a reason. The server
 * re-validates authoritatively on save.
 */
export function deriveContainmentEdges(
  parentType: string | null,
  childType: string | null,
  relationshipTypes: RelationshipTypeSchema[],
  containmentEdgeTypes: string[],
): AllowedEdgeOption[] {
  return relationshipTypes
    .filter((rt) => isContainmentRelType(rt, containmentEdgeTypes))
    .map((rt) => {
      const srcOk = endpointOk(parentType, rt.sourceTypes)   // parent must be an allowed source
      const tgtOk = endpointOk(childType, rt.targetTypes)    // child must be an allowed target
      const allowed = srcOk && tgtOk
      let reason: string | undefined
      if (!srcOk) reason = `'${parentType ?? '(root)'}' can't be the parent for '${rt.id}'`
      else if (!tgtOk) reason = `'${childType ?? '?'}' can't be nested under '${parentType ?? '(root)'}' via '${rt.id}'`
      return { edgeType: rt.id, label: rt.name ?? rt.id, description: rt.description, allowed, reason }
    })
}

/**
 * The raw lineage edge types that may connect `sourceType` → `targetType`,
 * checking BOTH endpoints against the ontology (the connect flow knows both
 * ends). Drawable lineage only; a type that fails either end is kept with
 * `allowed:false` + a `reason` naming the offending end. Empty / '*' source or
 * target lists mean "unrestricted".
 */
export function deriveConnectableEdges(
  sourceType: string | null,
  targetType: string | null,
  relationshipTypes: RelationshipTypeSchema[],
  containmentEdgeTypes: string[],
): AllowedEdgeOption[] {
  return relationshipTypes
    .filter((rt) => isDrawableLineageType(rt, containmentEdgeTypes))
    .map((rt) => {
      const srcOk = endpointOk(sourceType, rt.sourceTypes)
      const tgtOk = endpointOk(targetType, rt.targetTypes)
      const allowed = srcOk && tgtOk
      let reason: string | undefined
      if (!srcOk) reason = `'${sourceType}' is not a valid source for '${rt.id}'. Allowed: ${[...(rt.sourceTypes ?? [])].sort().join(', ') || '(any)'}`
      else if (!tgtOk) reason = `'${targetType}' is not a valid target for '${rt.id}'. Allowed: ${[...(rt.targetTypes ?? [])].sort().join(', ') || '(any)'}`
      return { edgeType: rt.id, label: rt.name ?? rt.id, description: rt.description, allowed, reason }
    })
}
