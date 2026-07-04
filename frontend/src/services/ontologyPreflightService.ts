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
import { relationshipLabel } from '@/lib/relationshipLabel'
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
 * Case-insensitive id equality: a discovered graph may store type/relationship
 * ids in a different case than the ontology (e.g. `flows_to` vs `FLOWS_TO`,
 * `attribute` vs `Attribute`) — validation must not require exact casing. If an
 * ontology pathologically defines two ids differing only by case, the first
 * match wins; not engineered for further.
 */
const sameId = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/** Case-insensitive entity-type lookup by id (exact match first, then case-insensitive). */
function findEntityType(id: string, entityTypes: EntityTypeSchema[]): EntityTypeSchema | undefined {
  return entityTypes.find((et) => et.id === id) ?? entityTypes.find((et) => sameId(et.id, id))
}

/** Case-insensitive hierarchyMap key lookup — same exact-then-case-insensitive strategy as {@link findEntityType}. */
function findHierarchyEntry(
  id: string,
  hierarchyMap: Record<string, { canContain?: string[] }>,
): { canContain?: string[] } | undefined {
  if (id in hierarchyMap) return hierarchyMap[id]
  const key = Object.keys(hierarchyMap).find((k) => sameId(k, id))
  return key ? hierarchyMap[key] : undefined
}

/**
 * Case-insensitive `Set.has`: `set` is assumed ONTOLOGY-cased (e.g. the result of
 * {@link allowedChildTypeIds}), while `id` may be a discovered graph's differently-cased
 * type id. Exact match first, then case-insensitive.
 */
export function setHasId(set: Set<string>, id: string): boolean {
  return set.has(id) || [...set].some((s) => sameId(s, id))
}

/**
 * The entity type ids that may be created directly under a parent of
 * `parentType` (or at the root when `parentType` is null), per the ontology's
 * containment rules. An empty `canContain` means "unrestricted" (allow all).
 * `parentType` is matched against the schema/hierarchyMap case-insensitively
 * (a discovered graph node's type may be cased differently than the ontology's
 * canonical id); the returned ids are always in ONTOLOGY casing.
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
  const fromSchema = findEntityType(parentType, entityTypes)?.hierarchy.canContain ?? []
  const fromOntology = findHierarchyEntry(parentType, hierarchyMap)?.canContain ?? []
  const canContain = [...new Set([...fromSchema, ...fromOntology])]
  // Empty canContain = unrestricted: every type is a valid child.
  if (canContain.length === 0) return new Set(entityTypes.map((et) => et.id))
  return new Set(canContain)
}

/**
 * Builder leaf policy: a parent whose `canContain` is empty/absent in BOTH the
 * schema and the hierarchyMap is CLOSED to nesting — consistent with the
 * FlatTreeItem add-child gate. This intentionally differs from
 * `allowedChildTypeIds`, whose lenient "empty = unrestricted" rule mirrors
 * backend fail-open validation and must not change. `parentType` is matched
 * case-insensitively (see {@link allowedChildTypeIds}).
 */
export function isClosedToNesting(
  parentType: string,
  entityTypes: EntityTypeSchema[],
  hierarchyMap: Record<string, { canContain?: string[] }>,
): boolean {
  const fromSchema = findEntityType(parentType, entityTypes)?.hierarchy.canContain ?? []
  const fromOntology = findHierarchyEntry(parentType, hierarchyMap)?.canContain ?? []
  return fromSchema.length === 0 && fromOntology.length === 0
}

/**
 * The entity type ids the Hierarchy Builder offers under `parentType` (or at
 * the root when null): {@link allowedChildTypeIds} with the builder's two
 * extra gates — a parent CLOSED to nesting (see {@link isClosedToNesting})
 * offers nothing, and a child type is only offered when at least one
 * containment relationship can actually nest it under the parent
 * ({@link deriveContainmentEdges}). Sorting is left to call sites.
 * The outline parser deliberately resolves against the lenient
 * {@link allowedChildTypeIds} set instead of this gate to produce per-row
 * diagnoses — do not "finish" the consolidation by swapping it to this gate.
 */
export function builderAllowedChildTypeIds(
  parentType: string | null,
  entityTypes: EntityTypeSchema[],
  rootEntityTypes: string[],
  hierarchyMap: Record<string, { canContain?: string[] }>,
  relationshipTypes: RelationshipTypeSchema[],
  containmentEdgeTypes: string[],
): Set<string> {
  if (!parentType) return allowedChildTypeIds(null, entityTypes, rootEntityTypes, hierarchyMap)
  if (isClosedToNesting(parentType, entityTypes, hierarchyMap)) return new Set()
  const candidates = allowedChildTypeIds(parentType, entityTypes, rootEntityTypes, hierarchyMap)
  return new Set(
    [...candidates].filter((id) =>
      deriveContainmentEdges(parentType, id, relationshipTypes, containmentEdgeTypes).some((e) => e.allowed),
    ),
  )
}

/**
 * Ontology containment chains from the given start types (e.g.
 * `['domain','dataPlatform','container','dataset']`), to power one-click
 * template scaffolds. DFS along `hierarchy.canContain`.
 *
 * Unlike `allowedChildTypeIds`, an empty `canContain` here means the type is
 * TERMINAL for chain purposes (not "unrestricted") — the unrestricted rule
 * only applies to computing a parent's allowed children; unrestricted
 * expansion would blow up here. A child id already on the current path is
 * skipped (folds self-nesting / DAG re-entry), as is any id with no matching
 * entity type. `maxLength` (default 5) caps the number of types in a path; a
 * path truncated at the cap is still emitted. Only maximal paths are emitted
 * — a path that is a strict prefix of another emitted path is dropped — and
 * exact duplicates are deduped. Children are visited in `hierarchy.level`
 * order (then name) for a deterministic result.
 */
export function containmentChains(
  entityTypes: EntityTypeSchema[],
  rootEntityTypes: string[],
  opts?: { maxLength?: number; startType?: string },
): string[][] {
  const maxLength = opts?.maxLength ?? 5
  const byId = new Map(entityTypes.map((et) => [et.id, et]))
  const startIds = opts?.startType
    ? [opts.startType]
    : rootEntityTypes.length > 0
      ? rootEntityTypes
      : entityTypes.filter((et) => et.hierarchy.canBeContainedBy.length === 0).map((et) => et.id)

  const sortChildren = (ids: string[]): string[] =>
    [...ids].sort((a, b) => {
      const ea = byId.get(a)
      const eb = byId.get(b)
      const levelDiff = (ea?.hierarchy.level ?? 0) - (eb?.hierarchy.level ?? 0)
      return levelDiff !== 0 ? levelDiff : (ea?.name ?? a).localeCompare(eb?.name ?? b)
    })

  const chains: string[][] = []
  const walk = (path: string[]): void => {
    const children = (byId.get(path[path.length - 1])?.hierarchy.canContain ?? [])
      .filter((id) => byId.has(id) && !path.includes(id))
    if (children.length === 0 || path.length >= maxLength) {
      chains.push(path)
      return
    }
    for (const child of sortChildren(children)) walk([...path, child])
  }
  for (const id of startIds) {
    if (byId.has(id)) walk([id])
  }

  const deduped = [...new Map(chains.map((c) => [JSON.stringify(c), c])).values()]
  return deduped.filter(
    (c) => !deduped.some((other) => other.length > c.length && c.every((id, i) => other[i] === id)),
  )
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

/** True when `type` satisfies an endpoint constraint (empty / '*' = wildcard; membership is case-insensitive). */
export function endpointOk(type: string | null, allowedTypes: string[] | undefined): boolean {
  return !type || !allowedTypes?.length || allowedTypes.includes('*') || allowedTypes.some((t) => sameId(t, type))
}

const upper = (t?: string | null) => (t ?? '').toUpperCase()

// ── Plain-language endpoint reasons (shared by deriveConnectableEdges and
// validateDrawnEdge). Entity-type ids resolve to their display NAMES via the
// optional `entityTypes` list (unknown ids fall back to the id); the edge is
// named by its label, never its raw id.
const displayTypeName = (id: string, entityTypes?: EntityTypeSchema[]): string =>
  (entityTypes && findEntityType(id, entityTypes))?.name ?? id

const indefinite = (name: string): string => (/^[aeiou]/i.test(name) ? 'An' : 'A')

const edgeDisplayLabel = (rt: RelationshipTypeSchema): string =>
  rt.name && rt.name !== rt.id ? rt.name : relationshipLabel(rt.id)

/** e.g. `An Attribute can't be the source of 'Flows To'. Works from: Column, Data Job.` */
function endpointReason(
  side: 'source' | 'target',
  typeId: string,
  rt: RelationshipTypeSchema,
  entityTypes?: EntityTypeSchema[],
): string {
  const name = displayTypeName(typeId, entityTypes)
  const works = ((side === 'source' ? rt.sourceTypes : rt.targetTypes) ?? [])
    .map((t) => displayTypeName(t, entityTypes))
    .sort((a, b) => a.localeCompare(b))
    .join(', ')
  return `${indefinite(name)} ${name} can't be the ${side} of '${edgeDisplayLabel(rt)}'. Works ${side === 'source' ? 'from' : 'to'}: ${works}.`
}

/** A minimal edge shape for duplicate detection (canvas store LineageEdge subset). */
export interface EdgeLike {
  source?: string
  target?: string
  data?: { edgeType?: string; relationship?: string }
}

/** The (UPPERCASE) relationship types that already connect `sourceId`→`targetId` among `edges`. */
export function connectedEdgeTypes(
  edges: EdgeLike[] | undefined,
  sourceId: string | undefined,
  targetId: string | undefined,
): Set<string> {
  const out = new Set<string>()
  if (!edges || !sourceId || !targetId) return out
  for (const e of edges) {
    if (e.source === sourceId && e.target === targetId) out.add(upper(e.data?.edgeType ?? e.data?.relationship))
  }
  return out
}

export interface DrawnEdgeContext {
  sourceType: string | null
  targetType: string | null
  edgeType: string
  relationshipTypes: RelationshipTypeSchema[]
  containmentEdgeTypes: string[]
  /** Existing canvas edges + the specific endpoint ids, for duplicate detection (optional). */
  existingEdges?: EdgeLike[]
  sourceId?: string
  targetId?: string
  /** Resolves reason strings to display names; omitted → raw ids. */
  entityTypes?: EntityTypeSchema[]
}

export interface EdgeValidation {
  allowed: boolean
  reason?: string
}

/**
 * The single gate for a hand-DRAWN edge between two nodes (free-draw / connect / reconnect).
 * Free-draw is lineage-only — containment is set via Create-child / "Move to", never drawn — so a
 * containment type is rejected here. Also rejects unknown / non-drawable types, endpoint-type
 * violations, and exact duplicates (same source+target+type already on the canvas). Containment
 * single-parent + duplicate are enforced on the reparent/create-child paths and authoritatively by
 * the backend; this keeps every drawing surface honest before save.
 */
export function validateDrawnEdge(ctx: DrawnEdgeContext): EdgeValidation {
  const { sourceType, targetType, edgeType, relationshipTypes, containmentEdgeTypes } = ctx
  const rt = relationshipTypes.find((r) => upper(r.id) === upper(edgeType))

  const isContainment = rt
    ? isContainmentRelType(rt, containmentEdgeTypes)
    : new Set(containmentEdgeTypes.map(upper)).has(upper(edgeType))
  if (isContainment) {
    return { allowed: false, reason: 'Containment is set by adding a child or using “Move to”, not by drawing an edge.' }
  }
  if (!rt) return { allowed: false, reason: `“${edgeType}” isn’t a relationship in the ontology.` }
  if (NON_DRAWABLE_EDGE_TYPES.has(rt.id)) return { allowed: false, reason: `“${rt.id}” can’t be drawn by hand.` }
  if (!endpointOk(sourceType, rt.sourceTypes)) {
    return { allowed: false, reason: endpointReason('source', sourceType ?? '?', rt, ctx.entityTypes) }
  }
  if (!endpointOk(targetType, rt.targetTypes)) {
    return { allowed: false, reason: endpointReason('target', targetType ?? '?', rt, ctx.entityTypes) }
  }
  if (connectedEdgeTypes(ctx.existingEdges, ctx.sourceId, ctx.targetId).has(upper(edgeType))) {
    return { allowed: false, reason: 'These entities are already connected by this relationship.' }
  }
  return { allowed: true }
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
  /** Resolves reason strings to display names; omitted → raw ids. */
  entityTypes?: EntityTypeSchema[],
): AllowedEdgeOption[] {
  return relationshipTypes
    .filter((rt) => isDrawableLineageType(rt, containmentEdgeTypes))
    .map((rt) => {
      const srcOk = endpointOk(sourceType, rt.sourceTypes)
      const tgtOk = endpointOk(targetType, rt.targetTypes)
      const allowed = srcOk && tgtOk
      let reason: string | undefined
      if (!srcOk) reason = endpointReason('source', sourceType ?? '?', rt, entityTypes)
      else if (!tgtOk) reason = endpointReason('target', targetType ?? '?', rt, entityTypes)
      return { edgeType: rt.id, label: rt.name ?? rt.id, description: rt.description, allowed, reason }
    })
}

/** A node under consideration for a type change, for {@link typesValidForNode}. */
export interface RetypeNode {
  id: string
  urn: string
  name: string
  type: string
}

/**
 * Graph adjacency for `node`, supplied by the caller (store/canvas) so that
 * {@link typesValidForNode} stays pure. `parentTypeOf`/`childrenOf` resolve
 * containment adjacency; `incidentLineageEdges` resolves the node's drawn
 * lineage edges (not containment).
 */
export interface RetypeContext {
  entityTypes: EntityTypeSchema[]
  relationshipTypes: RelationshipTypeSchema[]
  containmentEdgeTypes: string[]
  parentTypeOf: (nodeId: string) => string | null
  childrenOf: (nodeId: string) => RetypeNode[]
  incidentLineageEdges: (nodeId: string) => { edgeType: string; role: 'source' | 'target'; otherType: string }[]
}

/** Whether some containment relationship type can nest `childType` under `parentType`. */
function containmentAllowed(parentType: string, childType: string, ctx: RetypeContext): boolean {
  return deriveContainmentEdges(parentType, childType, ctx.relationshipTypes, ctx.containmentEdgeTypes).some(
    (o) => o.allowed,
  )
}

/**
 * The entity type ids `node` could legally become, for the "change entity type"
 * authoring flow. A candidate must (a) be a valid child of the node's current
 * parent (if any), (b) be able to contain every one of the node's existing
 * children, and (c) keep every one of the node's incident lineage edges
 * endpoint-valid. Sorted by `hierarchy.level` then name. Pure — the server
 * re-validates authoritatively on save.
 */
export function typesValidForNode(node: RetypeNode, ctx: RetypeContext): string[] {
  const parentType = ctx.parentTypeOf(node.id)
  const children = ctx.childrenOf(node.id)
  const edges = ctx.incidentLineageEdges(node.id)
  const byLevelThenName = (a: EntityTypeSchema, b: EntityTypeSchema) =>
    a.hierarchy.level - b.hierarchy.level || a.name.localeCompare(b.name)
  return [...ctx.entityTypes]
    .sort(byLevelThenName)
    .map((t) => t.id)
    .filter((candidate) => {
      if (parentType && !containmentAllowed(parentType, candidate, ctx)) return false
      for (const c of children) {
        if (!containmentAllowed(candidate, c.type, ctx)) return false
      }
      for (const e of edges) {
        const opts = deriveConnectableEdges(
          e.role === 'source' ? candidate : e.otherType,
          e.role === 'source' ? e.otherType : candidate,
          ctx.relationshipTypes,
          ctx.containmentEdgeTypes,
          ctx.entityTypes,
        )
        const opt = opts.find((o) => sameId(o.edgeType, e.edgeType))
        if (opt && !opt.allowed) return false
      }
      return true
    })
}
