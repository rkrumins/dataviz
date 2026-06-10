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
import type { AllowedEdgeOption, EdgeDirection } from '@/providers/GraphDataProvider'
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
 * Narrow a set of edge options to the drawable raw lineage types: those in the
 * view's lineage edge types, minus the synthetic/non-drawable ones. Disallowed
 * options are KEPT (the picker shows them disabled with a reason).
 */
export function selectDrawableLineageEdges(
  options: AllowedEdgeOption[],
  lineageEdgeTypes: string[],
): AllowedEdgeOption[] {
  const lineage = new Set(lineageEdgeTypes)
  return options.filter(
    (o) => lineage.has(o.edgeType) && !NON_DRAWABLE_EDGE_TYPES.has(o.edgeType),
  )
}

/**
 * The raw lineage edge types a user may draw FROM (or TO) a node of
 * `sourceType`, each annotated with whether the ontology allows it and why not.
 * Drawable lineage only (AGGREGATED and non-lineage types are dropped); a
 * disallowed type is kept with `allowed:false` + a `reason` so the picker can
 * show it disabled. An empty source/target list means "unrestricted".
 */
export function deriveAllowedEdges(
  sourceType: string | null,
  relationshipTypes: RelationshipTypeSchema[],
  lineageEdgeTypes: string[],
  direction: EdgeDirection = 'outgoing',
): AllowedEdgeOption[] {
  const options: AllowedEdgeOption[] = relationshipTypes.map((rt) => {
    const constrained = direction === 'incoming' ? rt.targetTypes : rt.sourceTypes
    const allowed = !sourceType || constrained.length === 0 || constrained.includes(sourceType)
    const role = direction === 'incoming' ? 'target' : 'source'
    return {
      edgeType: rt.id,
      label: rt.name ?? rt.id,
      description: rt.description,
      allowed,
      reason: allowed
        ? undefined
        : `'${sourceType}' is not a valid ${role} for '${rt.id}'. Allowed: ${[...constrained].sort().join(', ') || '(none)'}`,
    }
  })
  return selectDrawableLineageEdges(options, lineageEdgeTypes)
}
