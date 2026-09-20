/**
 * autoLayers — pure derivations for the wizard's "one layer per…" gestures.
 *
 * Two shapes, because the two modes mean genuinely different things:
 *
 *   • BY TYPE — one layer per ontology ROOT TYPE, carrying `entityTypes: [type]`.
 *     That field is already an automatic placement rule (see `buildLayerRules` in
 *     hooks/lib/resolveRootLayer.ts), so no per-entity assignment is written at
 *     all: every root-level node of the type resolves into the column, and its
 *     containment children inherit. A root ingested next week lands there too —
 *     but ONLY while the view runs in open ('all') scope, because curated scope
 *     ignores rules for root nodes. The caller must pin the scope.
 *
 *   • BY ENTITY — one layer per top-level ENTITY, carrying one explicit
 *     assignment each (`inheritsChildren`, so the subtree follows). Bounded: one
 *     entry per column, not per entity in the graph. Curated scope is correct
 *     here — the view IS those roots and their subtrees.
 *
 * Root-type resolution is NOT re-derived here: it reuses `buildHierarchyLevels`,
 * whose three-tier precedence (declared `rootEntityTypes` → explicit `level === 0`
 * → `canContain`-inversion) is already the contract the Entities step previews.
 * Layers built here therefore match the spine the user just looked at.
 *
 * No React — safe to unit test in isolation.
 */
import type { EntityTypeSchema, LayerAssignmentEntry, ViewLayerConfig } from '@/types/schema'
import { generateId } from '@/lib/utils'
import { caseFold } from '@/features/ontology/lib/caseFold'
import {
  buildHierarchyLevels,
  type HierarchyPreviewEntityType,
  type HierarchyPreviewRelationship,
} from './OntologyHierarchyPreview'
import { LAYER_COLORS } from './steps/LayoutStep'

/**
 * One offerable column in the "by type" mode.
 *
 * `typeId` is the spelling written into `layer.entityTypes`, and it is the
 * OBSERVED graph spelling whenever the type was seen — `matchesRule`
 * (providers/GraphDataProvider.ts) compares entity types with a case-SENSITIVE
 * `includes`, and entity types get none of the case-folding edge types do, so an
 * ontology id of `Domain` written against a graph label of `domain` would build a
 * column that silently stays empty for ever.
 */
export interface RootTypeCandidate {
  /** Spelling to write into `layer.entityTypes` — observed wins over declared. */
  typeId: string
  /** Column name: the type's plural name, else its name, else the id. */
  label: string
  /** Instances seen in the scanned top-level population. Absent = not seen. */
  observedCount?: number
  /** False for a type that only shows up as an orphan root in the graph. */
  declaredByOntology: boolean
  /** Set when an existing layer already declares this type — nothing to add. */
  coveredByLayerId?: string
  /** The entity type's own icon/color, so columns match the rest of the app. */
  icon?: string
  color?: string
}

/** Per-case-fold-group observation: the spelling the graph actually uses, and how often. */
interface ObservedType {
  spelling: string
  count: number
}

/**
 * Fold an observed top-level population down to one entry per case-fold group,
 * keeping the most frequent physical spelling (ties resolve to first-seen, so the
 * result is stable for a stable input order).
 */
function foldObserved(observed: Iterable<{ type: string }>): Map<string, ObservedType> {
  const byFold = new Map<string, Map<string, number>>()
  for (const { type } of observed) {
    if (!type) continue
    const fold = caseFold(type)
    if (!fold) continue
    const spellings = byFold.get(fold) ?? new Map<string, number>()
    spellings.set(type, (spellings.get(type) ?? 0) + 1)
    byFold.set(fold, spellings)
  }

  const result = new Map<string, ObservedType>()
  byFold.forEach((spellings, fold) => {
    let best = ''
    let bestCount = -1
    let total = 0
    spellings.forEach((count, spelling) => {
      total += count
      if (count > bestCount) {
        best = spelling
        bestCount = count
      }
    })
    result.set(fold, { spelling: best, count: total })
  })
  return result
}

/** First existing layer declaring `typeId` (case-insensitively), if any. */
function layerCovering(layers: ViewLayerConfig[], typeId: string): string | undefined {
  const fold = caseFold(typeId)
  return layers.find(l => (l.entityTypes ?? []).some(t => caseFold(t) === fold))?.id
}

export interface DeriveRootTypeCandidatesArgs {
  entityTypes: EntityTypeSchema[] | HierarchyPreviewEntityType[]
  relationshipTypes?: HierarchyPreviewRelationship[]
  rootEntityTypes?: string[]
  containmentEdgeTypes?: string[]
  /** The scanned top-level population — `snapshot.directory.values()`. */
  observedTopLevel?: Iterable<{ type: string }>
  /** Layers already on the draft, so covered types can be shown as such. */
  existingLayers?: ViewLayerConfig[]
}

/**
 * The columns worth offering, declared ontology roots first (in the hierarchy
 * preview's own order), then types that only appear as orphan roots in the graph
 * — sorted by how many were seen, then by name.
 *
 * An orphan-root type is offered because "top-level" in the graph is structural
 * (no incoming containment edge), so a Platform ingested without its Domain IS a
 * root on the canvas even though the ontology never calls it one. Offering it is
 * what stops those entities from being stranded; the flag lets the caller leave
 * it unchecked by default.
 */
export function deriveRootTypeCandidates({
  entityTypes,
  relationshipTypes = [],
  rootEntityTypes = [],
  containmentEdgeTypes = [],
  observedTopLevel = [],
  existingLayers = [],
}: DeriveRootTypeCandidatesArgs): RootTypeCandidate[] {
  const types = entityTypes as HierarchyPreviewEntityType[]
  const byFold = new Map(types.map(et => [caseFold(et.id), et]))
  const observed = foldObserved(observedTopLevel)

  const levels = buildHierarchyLevels(types, relationshipTypes, rootEntityTypes, containmentEdgeTypes)
  const declaredRootIds = levels[0]?.types.map(t => t.id) ?? []
  const declaredFolds = new Set(declaredRootIds.map(caseFold))

  const candidateFor = (
    declaredId: string | undefined,
    fold: string,
    declaredByOntology: boolean,
  ): RootTypeCandidate => {
    const schema = byFold.get(fold)
    const seen = observed.get(fold)
    // The spelling the graph uses wins — see the `matchesRule` note above.
    const typeId = seen?.spelling ?? declaredId ?? fold
    const label = schema?.pluralName || schema?.name || typeId
    const coveredByLayerId = layerCovering(existingLayers, typeId)
    return {
      typeId,
      label,
      ...(seen ? { observedCount: seen.count } : {}),
      declaredByOntology,
      ...(coveredByLayerId ? { coveredByLayerId } : {}),
      ...(schema?.visual?.icon ? { icon: schema.visual.icon } : {}),
      ...(schema?.visual?.color ? { color: schema.visual.color } : {}),
    }
  }

  const declared = declaredRootIds.map(id => candidateFor(id, caseFold(id), true))

  const orphans = [...observed.entries()]
    .filter(([fold]) => !declaredFolds.has(fold))
    .map(([fold]) => candidateFor(undefined, fold, false))
    .sort((a, b) => (b.observedCount ?? 0) - (a.observedCount ?? 0) || a.label.localeCompare(b.label))

  return [...declared, ...orphans]
}

/**
 * True when every entity type in the ontology reports as a root. `rootEntityTypes`
 * is DECLARATIVE — the backend derives it from an empty `can_be_contained_by`
 * (app/ontology/resolver.py) — so an ungoverned or introspection-synthesized
 * ontology marks everything a root and this gesture would mint a column per type.
 * Worth saying out loud rather than quietly producing forty columns.
 */
export function ontologyLooksUngoverned(
  candidates: RootTypeCandidate[],
  entityTypeCount: number,
): boolean {
  const declared = candidates.filter(c => c.declaredByOntology).length
  return entityTypeCount > 1 && declared >= entityTypeCount
}

/** Palette entry for a column at `order`, preferring the entity type's own color. */
function colorFor(candidateColor: string | undefined, order: number): string {
  return candidateColor ?? LAYER_COLORS[order % LAYER_COLORS.length]
}

/**
 * One rule-driven layer per candidate. No assignments: `entityTypes` places the
 * roots and containment inheritance places everything beneath them.
 *
 * `order` AND `sequence` are both stamped — the wizard writes both, and the
 * canvas sorts columns on `order`.
 */
export function layersForRootTypes(
  candidates: RootTypeCandidate[],
  startOrder = 0,
): ViewLayerConfig[] {
  return candidates.map((candidate, i) => {
    const order = startOrder + i
    return {
      id: generateId('layer'),
      name: candidate.label,
      description: '',
      color: colorFor(candidate.color, order),
      ...(candidate.icon ? { icon: candidate.icon } : {}),
      entityTypes: [candidate.typeId],
      order,
      sequence: order,
    }
  })
}

/** One top-level entity offered as its own column. */
export interface TopLevelEntity {
  urn: string
  name: string
  type: string
  /** How many entities it contains — what the column would hold. */
  childCount?: number
}

/**
 * One layer per entity: an `anchorUrn` so the column IS that entity and its
 * children are the rows, plus a single explicit assignment so the subtree
 * resolves into the column in the first place. The assignment is what a client
 * without `anchorUrn` falls back to, which is why both are written.
 *
 * `entityTypes` is deliberately EMPTY: a type rule here would drag every other
 * entity of the same type into this entity's column. Placement is the assignment.
 */
export function layersForTopLevelEntities(
  entities: TopLevelEntity[],
  startOrder = 0,
): { layers: ViewLayerConfig[]; assignments: Record<string, LayerAssignmentEntry> } {
  const layers: ViewLayerConfig[] = []
  const assignments: Record<string, LayerAssignmentEntry> = {}
  const assignedAt = new Date().toISOString()

  entities.forEach((entity, i) => {
    const order = startOrder + i
    const id = generateId('layer')
    layers.push({
      id,
      name: entity.name,
      description: '',
      color: colorFor(undefined, order),
      entityTypes: [],
      order,
      sequence: order,
      // The column IS this entity, so its CHILDREN are the rows — otherwise the
      // column spends its only row repeating its own name, with everything you
      // came to see one expand deeper.
      anchorUrn: entity.urn,
    })
    assignments[entity.urn] = {
      layerId: id,
      inheritsChildren: true,
      assignedBy: 'rule',
      assignedAt,
    }
  })

  return { layers, assignments }
}
