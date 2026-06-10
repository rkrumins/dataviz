/**
 * ontologyGuard — the single source of ontology rules the authoring UI applies
 * *before* a change is saved (the backend `mutation_validator` re-validates
 * authoritatively on save).
 *
 * These derive purely from the resolved ontology already in the schema store
 * (entity hierarchy, relationship source/target types). We deliberately do NOT
 * call the backend `allowed-children`/`allowed-edges` endpoints: those resolve
 * the *persisted* node, so they 404 on a staged-but-unsaved parent/source —
 * which is exactly the grandparent→parent→child hierarchy case. Deriving
 * client-side is authoritative (same resolved ontology), instant, and works
 * for staged nodes.
 *
 * Every picker, composer, context menu and connect flow goes through this
 * module — no component re-derives ontology rules ad hoc.
 */
import type { AllowedEdgeOption } from '@/providers/GraphDataProvider'
import type { EntityTypeSchema, RelationshipTypeSchema } from '@/types/schema'
import type { LineageEdge } from '@/store/canvas'

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
  const canContainIds = [...new Set([...fromSchema, ...fromOntology])]
  // Empty canContain = unrestricted: every type is a valid child.
  if (canContainIds.length === 0) return new Set(entityTypes.map((et) => et.id))
  return new Set(canContainIds)
}

/** Whether `childType` may be created under `parentType` (null = root). */
export function canContain(
  parentType: string | null,
  childType: string,
  entityTypes: EntityTypeSchema[],
  rootEntityTypes: string[],
  hierarchyMap: Record<string, { canContain?: string[] }>,
): boolean {
  return allowedChildTypeIds(parentType, entityTypes, rootEntityTypes, hierarchyMap).has(childType)
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

/**
 * The entity types a connect drag from a node of `sourceType` may legally land
 * on — i.e. types with at least one allowed drawable lineage edge. Drives the
 * live highlight/dim treatment while dragging. An unrestricted target list
 * expands to every known entity type.
 */
export function connectableTargetTypes(
  sourceType: string | null,
  entityTypeIds: string[],
  relationshipTypes: RelationshipTypeSchema[],
  containmentEdgeTypes: string[],
): Set<string> {
  const out = new Set<string>()
  for (const rt of relationshipTypes) {
    if (!isDrawableLineageType(rt, containmentEdgeTypes)) continue
    if (!endpointOk(sourceType, rt.sourceTypes)) continue
    if (!rt.targetTypes?.length || rt.targetTypes.includes('*')) {
      entityTypeIds.forEach((id) => out.add(id))
    } else {
      rt.targetTypes.forEach((id) => out.add(id))
    }
  }
  return out
}

/**
 * The edge types an existing edge may be retyped to — `deriveConnectableEdges`
 * for its endpoint pair, with the edge's current type marked so the picker can
 * pre-select it.
 */
export function retypeOptions(
  currentEdgeType: string | undefined,
  sourceType: string | null,
  targetType: string | null,
  relationshipTypes: RelationshipTypeSchema[],
  containmentEdgeTypes: string[],
): Array<AllowedEdgeOption & { isCurrent: boolean }> {
  return deriveConnectableEdges(sourceType, targetType, relationshipTypes, containmentEdgeTypes)
    .map((o) => ({ ...o, isCurrent: o.edgeType === currentEdgeType }))
}

export interface EntityDraftValidation {
  ok: boolean
  /** Keyed by 'entityType' | 'displayName' | field id. */
  errors: Record<string, string>
}

/** Field ids the display name satisfies (the form has a single name input). */
const NAME_FIELD_IDS = new Set(['name', 'displayname', 'label'])

const isEmptyValue = (v: unknown): boolean =>
  v == null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0)

/**
 * Required-field validation for an entity draft (create or composer node):
 * a known entity type, a non-empty name, and every `required` ontology field
 * populated. Pure — panels call this on each change to gate their Stage button.
 */
export function validateEntityDraft(
  entityType: string | null,
  displayName: string,
  properties: Record<string, unknown>,
  entityTypes: EntityTypeSchema[],
): EntityDraftValidation {
  const errors: Record<string, string> = {}
  const def = entityType ? entityTypes.find((et) => et.id === entityType) : undefined
  if (!entityType) errors.entityType = 'Select an entity type'
  else if (!def) errors.entityType = `Unknown entity type '${entityType}'`
  if (!displayName.trim()) errors.displayName = 'Name is required'
  for (const f of def?.fields ?? []) {
    if (!f.required) continue
    if (NAME_FIELD_IDS.has(f.id.toLowerCase())) continue // satisfied by displayName
    if (isEmptyValue(properties[f.id])) errors[f.id] = `'${f.name}' is required`
  }
  return { ok: Object.keys(errors).length === 0, errors }
}

export interface EdgeAuthorability {
  ok: boolean
  reason?: string
}

/**
 * Whether an edge on the canvas may be authored (edited / retyped / reversed /
 * deleted) by the user. Aggregated edges are derived — the rollup job rebuilds
 * them from raw edges after publish; containment edges are owned by the
 * hierarchy (created/removed with their child node), never edited directly.
 */
export function isEdgeAuthorable(
  edge: Pick<LineageEdge, 'type' | 'data'>,
  containmentEdgeTypes: string[],
): EdgeAuthorability {
  if (edge.data?.isAggregated) {
    return { ok: false, reason: 'Aggregated (derived) edges are read-only — edit the underlying raw edges instead.' }
  }
  const containmentSet = new Set(containmentEdgeTypes.map((t) => t.toUpperCase()))
  const edgeType = edge.data?.edgeType
  if (edge.type === 'containment' || (edgeType && containmentSet.has(edgeType.toUpperCase()))) {
    return { ok: false, reason: 'Containment edges follow the hierarchy — move or delete the child entity instead.' }
  }
  return { ok: true }
}
