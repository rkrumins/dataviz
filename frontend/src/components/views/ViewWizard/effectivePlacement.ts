/**
 * effectivePlacement — where the CANVAS would put a top-level entity, answered
 * inside the wizard.
 *
 * Why this exists: a layer carrying `entityTypes` places matching roots by rule,
 * with no entry in `referenceLayout.assignments`. The wizard's tree and layer
 * rail read only that assignment map, so rule-placed entities would render as
 * "unassigned" in the wizard while the canvas showed them neatly in columns —
 * breaking the invariant stated in hooks/useLayerAssignment.ts, that the wizard
 * is the user's source of truth and the canvas must agree with it.
 *
 * So this does NOT reimplement placement. It calls the very pair the canvas
 * calls — `buildLayerRules` (hooks/lib/resolveRootLayer.ts) and
 * `resolveLayerAssignment` (providers/GraphDataProvider.ts) — in the same
 * explicit-then-rule order as `resolveRootLayer`. Two consequences worth knowing:
 *
 *   • When two layers declare the same entity type, the LATER layer wins, because
 *     generated rules are priced `layer.order * 10 + idx` and the resolver sorts
 *     highest-priority first. (`buildTypeLayerMap` in Build Mode is first-wins —
 *     deliberately not used here, or the wizard would disagree with the canvas.)
 *   • Type matching is case-SENSITIVE (`matchesRule` uses `includes`), so a layer
 *     whose `entityTypes` casing differs from the graph's label resolves to
 *     'none'. That is the truth about what the canvas will do, and surfacing it
 *     is better than hiding it behind a fold.
 *
 * Only ROOT-level entities need this. Containment children never consult rules —
 * they hard-inherit their parent's layer.
 *
 * No React — safe to unit test in isolation.
 */
import type { LayerAssignmentEntry, ViewContentConfig, ViewLayerConfig } from '@/types/schema'
import {
  resolveLayerAssignment,
  type EntityType,
  type GraphNode,
} from '@/providers/GraphDataProvider'
import { buildLayerRules } from '@/hooks/lib/resolveRootLayer'
import { deriveEntityScope, type NormalizedReferenceLayout } from '@/utils/referenceLayout'

/** How an entity ended up in its layer. */
export type PlacementSource = 'explicit' | 'rule' | 'none'

export interface Placement {
  /** Absent when nothing places this entity — it would render nowhere. */
  layerId?: string
  source: PlacementSource
}

export interface PlaceableEntity {
  urn: string
  type: string
}

const NOWHERE: Placement = { source: 'none' }

/**
 * Build a resolver for one draft layout. Layers are sorted by `order` first, the
 * way the canvas sorts them, so rule priorities match what will actually run.
 *
 * The returned function is cheap to call per row — the rule list is compiled once.
 */
export function buildWizardPlacement(
  layers: ViewLayerConfig[],
  assignments: Record<string, LayerAssignmentEntry>,
): (entity: PlaceableEntity) => Placement {
  const sortedLayers = [...layers].sort((a, b) => a.order - b.order)
  const rules = buildLayerRules(sortedLayers)
  const validLayerIds = new Set(sortedLayers.map(l => l.id))

  return (entity: PlaceableEntity): Placement => {
    // Explicit wins in BOTH scopes — same order as resolveRootLayer.
    const explicit = assignments[entity.urn]?.layerId
    if (explicit) {
      // A stale id (its layer was deleted) must not strand the entity silently.
      return validLayerIds.has(explicit) ? { layerId: explicit, source: 'explicit' } : NOWHERE
    }
    if (rules.length === 0) return NOWHERE

    const node: GraphNode = {
      urn: entity.urn,
      entityType: entity.type as EntityType,
      displayName: entity.urn,
      properties: {},
      tags: [],
    }
    const ruled = resolveLayerAssignment(node, rules)
    return ruled ? { layerId: ruled, source: 'rule' } : NOWHERE
  }
}

/**
 * Per-layer counts of what the canvas would actually render at root level —
 * explicit placements AND rule-placed roots. The wizard's mini preview counted
 * raw `assignments` entries, which reads 0 for every rule-driven column.
 */
export function countPlacementsByLayer(
  layers: ViewLayerConfig[],
  assignments: Record<string, LayerAssignmentEntry>,
  entities: Iterable<PlaceableEntity>,
): Map<string, number> {
  const place = buildWizardPlacement(layers, assignments)
  const counts = new Map<string, number>()
  const seen = new Set<string>()

  for (const entity of entities) {
    if (seen.has(entity.urn)) continue
    seen.add(entity.urn)
    const { layerId } = place(entity)
    if (layerId) counts.set(layerId, (counts.get(layerId) ?? 0) + 1)
  }

  // An explicit placement for an entity outside the scanned population (a deeper
  // node the user placed by hand) still occupies its column.
  for (const [urn, entry] of Object.entries(assignments)) {
    if (seen.has(urn) || !entry?.layerId) continue
    seen.add(urn)
    counts.set(entry.layerId, (counts.get(entry.layerId) ?? 0) + 1)
  }

  return counts
}

/**
 * The scope a wizard save should write.
 *
 * A PINNED scope (set when the user picks a rule-driven layout) is honoured only
 * while the layout still has a rule to serve — i.e. while some layer declares
 * `entityTypes`. That guard makes the pin self-healing: undo the gesture, or
 * delete the last rule-driven layer, and the pin stops applying instead of
 * silently holding a view open that no longer resolves anything by rule.
 *
 * With no pin in force this is exactly the previous behaviour — `deriveEntityScope`
 * on the submitted layout.
 */
export function resolveWizardEntityScope(
  pinned: 'all' | 'curated' | undefined,
  layout: NormalizedReferenceLayout,
  content: ViewContentConfig | undefined,
): 'all' | 'curated' {
  const ruleDriven = layout.layers.some(l => (l.entityTypes ?? []).length > 0)
  return (ruleDriven ? pinned : undefined) ?? deriveEntityScope(content, layout)
}
