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
 * explicit-then-rule order as `resolveRootLayer`. Two consequences worth knowing
 * (flag off):
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
 * With placementContractEnabled on, `contract` places through the One Placement
 * Contract (lib/placement) instead: first layer wins, types fold case, a stale
 * entry falls through, and stamps, tags and properties count.
 *
 * No React — safe to unit test in isolation.
 */
import type { LayerAssignmentEntry, ViewContentConfig, ViewLayerConfig } from '@/types/schema'
import {
  resolveLayerAssignmentIn,
  sortLayerRules,
  type EntityType,
  type GraphNode,
} from '@/providers/GraphDataProvider'
import { buildLayerRules } from '@/hooks/lib/resolveRootLayer'
import { deriveEntityScope, type NormalizedReferenceLayout } from '@/utils/referenceLayout'
import {
  compilePlacementSpec,
  isMember,
  place,
  type PlacementFacts,
  type PlacementSource,
} from '@/lib/placement/placement'

/** How an entity ended up in its layer. The legacy resolver answers only
 *  explicit, rule or none; the contract any source. */
export type { PlacementSource }

export interface Placement {
  /** Absent when nothing places this entity — it would render nowhere. */
  layerId?: string
  source: PlacementSource
}

export interface PlaceableEntity {
  urn: string
  type: string
  /** Its full facts (stamp, tags, properties) — read by the contract only. */
  facts?: PlacementFacts
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
  /**
   * The view's effective scope. CURATED views never consult type rules for a
   * root (`resolveRootLayer` reaches `ruleAssignment` only down the open
   * branch), so claiming a rule placement here would badge entities "by type"
   * that the canvas drops and curated hydration never even fetches — the very
   * wizard/canvas divergence this module exists to prevent, inverted.
   * Defaults to the same derivation `deriveEntityScope` uses.
   */
  entityScope?: 'all' | 'curated',
  /** placementContractEnabled: place through the One Placement Contract. */
  contract = false,
): (entity: PlaceableEntity) => Placement {
  if (contract) {
    // The draft compiled once, as the canvas compiles the saved view, and each
    // entity placed as a root (no parents). Fallback is display only: unplaced.
    const spec = compilePlacementSpec({ layout: { referenceLayout: { layers, assignments } }, content: { entityScope } })
    return (entity: PlaceableEntity): Placement => {
      const facts = entity.facts ?? { urn: entity.urn, entityType: entity.type, tags: [], properties: {} }
      const placed = place(spec, entity.urn, facts, [])
      return isMember(placed) ? { layerId: placed.layerId!, source: placed.source } : { source: placed.source }
    }
  }

  const sortedLayers = [...layers].sort((a, b) => a.order - b.order)
  // Sorted ONCE here, not per entity: this resolver runs across every scanned
  // top-level entity and re-sorting each time measured ~8.7ms per 50,000.
  const rules = sortLayerRules(buildLayerRules(sortedLayers))
  const validLayerIds = new Set(sortedLayers.map(l => l.id))
  const curated = entityScope
    ? entityScope === 'curated'
    : Object.keys(assignments).length > 0

  return (entity: PlaceableEntity): Placement => {
    // Explicit wins in BOTH scopes — same order as resolveRootLayer.
    const explicit = assignments[entity.urn]?.layerId
    if (explicit) {
      // A stale id (its layer was deleted) must not strand the entity silently.
      return validLayerIds.has(explicit) ? { layerId: explicit, source: 'explicit' } : NOWHERE
    }
    if (curated || rules.length === 0) return NOWHERE

    const node: GraphNode = {
      urn: entity.urn,
      entityType: entity.type as EntityType,
      displayName: entity.urn,
      properties: {},
      tags: [],
    }
    const ruled = resolveLayerAssignmentIn(node, rules)
    return ruled ? { layerId: ruled, source: 'rule' } : NOWHERE
  }
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
