/**
 * resolveCreationScope — where a new entity goes when it is asked for from a LAYER (its "+", its
 * menu, its empty space, the N key on something in it), or by type from the command palette.
 *
 *   The layer                                   | Default                         | One click away
 *   --------------------------------------------|---------------------------------|------------------------------
 *   Mapped to a node (`anchorUrn`, on the       | inside that node, as the type   | the layer's other parents;
 *   canvas, not another column's)               | last used there, else the first | a new top-level entity
 *                                               | its type can hold               |
 *   Several top-level nodes, the selection in   | inside the selection, as Add    | the top level; other parents
 *   it can hold children                        | Child does                      |
 *   Several top-level nodes, otherwise          | the top level, as the layer's   | inside one of the layer's
 *                                               | own type (as it always was)     | top-level nodes
 *   Its types need a parent (an "Apps" layer)   | that type; the selection when   | —
 *                                               | it can hold it, else the only   |
 *                                               | candidate, else ask             |
 *
 * Pure: everything it reads is a lookup the canvas already holds (`node`, `layerOf`, the layer's own
 * rows), plus `parentsFor`, which is only called for a layer whose type needs a parent.
 */
import { builderAllowedChildTypeIds } from '@/services/ontologyPreflightService'
import type { EntityTypeSchema, RelationshipTypeSchema } from '@/types/schema'

/** An entity a new one could go inside. */
export interface ScopeNode {
  urn: string
  typeId: string
}

export interface ScopeLayer {
  id: string
  entityTypes?: readonly string[]
  anchorUrn?: string
}

export interface ScopeContext {
  /** A type asked for by name (the command palette's "Create <Type>"): it decides, not the layer. */
  typeId?: string | null
  /** The one selected entity, when exactly one is. */
  selectionId?: string | null
  /** Why the layer's anchor can't be used (see anchorIssueByLayer). */
  anchorIssue?: 'missing' | 'duplicate'
  /** A canvas entity by id or urn. */
  node: (idOrUrn: string) => ScopeNode | undefined
  /** The layer an entity is drawn in. */
  layerOf: (id: string) => string | undefined
  /** The layer's own top-level entities, in the order it draws them. */
  layerRoots: readonly ScopeNode[]
  /** The types that may be created directly under `parentType` (null: the top level), most likely first. */
  childTypes: (parentType: string | null) => readonly string[]
  /** The entities on the canvas that can hold `typeId`. Asked only for a type that needs a parent. */
  parentsFor: (typeId: string) => readonly ScopeNode[]
  /** The type last added inside each parent (keyed by urn; '' is the top level). */
  lastTypeIn?: Readonly<Record<string, string>>
}

export type ScopeKind = 'anchored' | 'selection' | 'top-level' | 'needs-parent'

export interface CreationScope {
  kind: ScopeKind
  /** Where the first entity goes: an entity's urn, or null for the top level. */
  parentUrn: string | null
  /** The type to start with (offered only where the parent allows it), or null to infer one. */
  preferredTypeId: string | null
  /** The type needs a parent and none is obvious: ask where it goes before anything is added. */
  askParent: boolean
  /** One click away: the parents to offer first, the default first when it is one. */
  choices: ScopeNode[]
  /** The top-level type offered as "New top-level <type>", when one is the obvious one. */
  topLevelTypeId: string | null
}

/** How many parents a scope offers by name; the picker searches the rest. */
export const SCOPE_CHOICE_LIMIT = 50

const same = (a: string, b: string) => a === b || a.toLowerCase() === b.toLowerCase()
const includesId = (ids: readonly string[], id: string) => ids.some((i) => same(i, id))

export function resolveCreationScope(layer: ScopeLayer | null | undefined, ctx: ScopeContext): CreationScope {
  const roots = ctx.childTypes(null)
  const isRoot = (typeId: string) => includesId(roots, typeId)
  const canHold = (parent: ScopeNode, typeId?: string) => {
    const kids = ctx.childTypes(parent.typeId)
    return typeId ? includesId(kids, typeId) : kids.length > 0
  }
  const lastIn = (urn: string, allowed: readonly string[]) => {
    const last = ctx.lastTypeIn?.[urn]
    return last && includesId(allowed, last) ? last : null
  }
  const selection = ctx.selectionId ? ctx.node(ctx.selectionId) : undefined
  const soleRoot = roots.length === 1 ? roots[0] : null

  /** The layer's parents to offer: `first` (when given), then the selection, then its top-level rows. */
  const layerChoices = (first?: ScopeNode, selectionHere?: ScopeNode): ScopeNode[] => {
    const out: ScopeNode[] = []
    const seen = new Set<string>()
    const add = (n: ScopeNode | undefined) => {
      if (!n || seen.has(n.urn) || out.length >= SCOPE_CHOICE_LIMIT || !canHold(n)) return
      seen.add(n.urn)
      out.push(n)
    }
    add(first)
    add(selectionHere)
    for (const n of ctx.layerRoots) {
      if (out.length >= SCOPE_CHOICE_LIMIT) break
      add(n)
    }
    return out
  }

  /** A type that needs a parent: the selection when it can hold it, else the only candidate, else ask. */
  const needsParent = (typeId: string): CreationScope => {
    const base = { kind: 'needs-parent' as const, preferredTypeId: typeId, topLevelTypeId: soleRoot }
    if (selection && canHold(selection, typeId)) {
      return { ...base, parentUrn: selection.urn, askParent: false, choices: [selection] }
    }
    const candidates = ctx.parentsFor(typeId).slice(0, SCOPE_CHOICE_LIMIT)
    if (candidates.length === 1) return { ...base, parentUrn: candidates[0].urn, askParent: false, choices: candidates }
    return { ...base, parentUrn: null, askParent: true, choices: candidates }
  }

  // Asked for by type: a top-level type at the top level (as it always was), any other inside something.
  if (ctx.typeId) {
    if (isRoot(ctx.typeId)) {
      return { kind: 'top-level', parentUrn: null, preferredTypeId: ctx.typeId, askParent: false, choices: [], topLevelTypeId: ctx.typeId }
    }
    return needsParent(ctx.typeId)
  }

  const selectionHere = selection && layer && ctx.layerOf(ctx.selectionId!) === layer.id && canHold(selection)
    ? selection : undefined

  // A layer mapped to a node IS that node: what is added from it goes inside.
  if (layer?.anchorUrn && !ctx.anchorIssue) {
    const anchor = ctx.node(layer.anchorUrn)
    const inside = anchor ? ctx.childTypes(anchor.typeId) : []
    if (anchor && inside.length > 0) {
      return {
        kind: 'anchored',
        parentUrn: anchor.urn,
        preferredTypeId: lastIn(anchor.urn, inside) ?? inside[0],
        askParent: false,
        choices: layerChoices(anchor, selectionHere),
        topLevelTypeId: isRoot(anchor.typeId) ? anchor.typeId : soleRoot,
      }
    }
  }

  const layerTypes = layer?.entityTypes ?? []
  const ownRootType = layerTypes.find(isRoot) ?? null

  // Its types all need a parent (an "Apps" layer): that type, inside something.
  if (layerTypes.length > 0 && !ownRootType) return needsParent(layerTypes[0])

  const topLevelTypeId = ownRootType ?? (layerTypes.length === 0 ? soleRoot : null)

  // Several top-level entities, one of them (or something inside one) selected: inside it.
  if (selectionHere) {
    return {
      kind: 'selection',
      parentUrn: selectionHere.urn,
      preferredTypeId: lastIn(selectionHere.urn, ctx.childTypes(selectionHere.typeId)),
      askParent: false,
      choices: layerChoices(selectionHere),
      topLevelTypeId,
    }
  }

  // Otherwise the top level, as the layer's own type — and inside one of its entities one click away.
  return {
    kind: 'top-level',
    parentUrn: null,
    preferredTypeId: ownRootType,
    askParent: false,
    choices: layerChoices(),
    topLevelTypeId,
  }
}

/** Lowest hierarchy level first, then name — the builder's order everywhere. */
const byLevelThenName = (a: EntityTypeSchema, b: EntityTypeSchema) =>
  a.hierarchy.level - b.hierarchy.level || a.name.localeCompare(b.name)

/**
 * The builder's gate ({@link builderAllowedChildTypeIds}) as a lookup by parent type, sorted as the
 * builder offers types, and remembered per parent type — a canvas of thousands asks it for a handful
 * of types, many times.
 */
export function childTypesLookup(
  entityTypes: EntityTypeSchema[],
  rootEntityTypes: string[],
  hierarchyMap: Record<string, { canContain?: string[]; canBeContainedBy?: string[] }>,
  relationshipTypes: RelationshipTypeSchema[],
  containmentEdgeTypes: string[],
): (parentType: string | null) => readonly string[] {
  const byId = new Map(entityTypes.map((t) => [t.id, t]))
  const cache = new Map<string, readonly string[]>()
  return (parentType) => {
    const key = parentType ?? ''
    let hit = cache.get(key)
    if (!hit) {
      const ids = builderAllowedChildTypeIds(parentType, entityTypes, rootEntityTypes, hierarchyMap, relationshipTypes, containmentEdgeTypes)
      hit = [...ids]
        .map((id) => byId.get(id))
        .filter((t): t is EntityTypeSchema => !!t)
        .sort(byLevelThenName)
        .map((t) => t.id)
      cache.set(key, hit)
    }
    return hit
  }
}
