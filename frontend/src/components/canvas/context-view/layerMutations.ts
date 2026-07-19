/**
 * Pure transforms over a view's `referenceLayout.layers` array — the single source the Context View
 * canvas renders columns from. Every op returns a NEW array with `order` re-normalized to 0..n-1, so
 * the caller just hands the result to `updateView({ layout: { referenceLayout: { layers } } })`.
 *
 * Kept pure + separately tested (layerMutations.test.ts) because the reorder/remove index math is
 * where off-by-ones hide. The handlers in ContextViewCanvas (addLayer/renameLayer/deleteLayer/
 * reorderLayer) are thin wrappers that mint ids/persist; all the list logic lives here.
 */
import type { LayerNodeSortMode, ViewLayerConfig } from '@/types/schema'
import type { NormalizedReferenceLayout } from '@/utils/referenceLayout'
import { compareOrderKeys, generateNKeysBetween } from '@/utils/orderKeys'

const renumber = (layers: ViewLayerConfig[]): ViewLayerConfig[] =>
  layers.map((l, i) => (l.order === i ? l : { ...l, order: i }))

/** Append a new layer at the end; its `order` is forced to the (pre-append) length. */
export function appendLayer(layers: ViewLayerConfig[], newLayer: ViewLayerConfig): ViewLayerConfig[] {
  return [...layers, { ...newLayer, order: layers.length }]
}

/** Rename one layer by id; no-op if not found. Order untouched. */
export function renameLayer(layers: ViewLayerConfig[], id: string, name: string): ViewLayerConfig[] {
  return layers.map((l) => (l.id === id ? { ...l, name } : l))
}

/** Remove one layer by id and re-normalize order; no-op if not found. */
export function removeLayer(layers: ViewLayerConfig[], id: string): ViewLayerConfig[] {
  if (!layers.some((l) => l.id === id)) return layers
  return renumber(layers.filter((l) => l.id !== id))
}

/**
 * Move `draggedId` next to `targetId`, list-reorder semantics: dragging RIGHT drops it AFTER the
 * target, dragging LEFT drops it BEFORE — so the layer lands where you released it. No-op if either
 * id is missing or they're the same. Order re-normalized. The layer's nodes/edges follow for free —
 * they render wherever the layer sits (they key off `layerAssignment`, not a column index).
 */
export function reorderLayer(layers: ViewLayerConfig[], draggedId: string, targetId: string): ViewLayerConfig[] {
  if (draggedId === targetId) return layers
  const fromIdx = layers.findIndex((l) => l.id === draggedId)
  const toIdx = layers.findIndex((l) => l.id === targetId)
  if (fromIdx < 0 || toIdx < 0) return layers

  const dragged = layers[fromIdx]
  const without = layers.filter((l) => l.id !== draggedId)
  const targetPos = without.findIndex((l) => l.id === targetId)
  const insertAt = fromIdx < toIdx ? targetPos + 1 : targetPos
  return renumber([...without.slice(0, insertAt), dragged, ...without.slice(insertAt)])
}

/**
 * Set (or clear, with `mode === null`) a layer's `nodeSortMode` override. Operates on the full
 * `NormalizedReferenceLayout` because entering 'custom' also SEEDS `orderKey`s: the layer's existing
 * UNKEYED assignment entries get fractional keys following `seedOrder` (the column's current visual
 * root ids), appended after the largest already-existing key so re-entering custom is idempotent and
 * never reshuffles keys a user already arranged. Leaving custom keeps the keys — they are inert in
 * alpha modes, so flipping back restores the manual arrangement. No-op returns the same layout.
 */
export function setLayerNodeSortMode(
  layout: NormalizedReferenceLayout,
  layerId: string,
  mode: LayerNodeSortMode | null,
  seedOrder?: string[],
): NormalizedReferenceLayout {
  const target = layout.layers.find((l) => l.id === layerId)
  if (!target) return layout
  const modeUnchanged = mode === null ? target.nodeSortMode === undefined : target.nodeSortMode === mode
  if (modeUnchanged && mode !== 'custom') return layout // re-selecting 'custom' may still need seeding
  const layers = layout.layers.map((l) => {
    if (l.id !== layerId) return l
    if (mode === null) {
      const { nodeSortMode: _drop, ...rest } = l
      return rest as ViewLayerConfig
    }
    return { ...l, nodeSortMode: mode }
  })

  let assignments = layout.assignments
  if (mode === 'custom' && seedOrder && seedOrder.length > 0) {
    const existingKeys = Object.values(layout.assignments)
      .filter((e) => e.layerId === layerId && e.orderKey)
      .map((e) => e.orderKey as string)
      .sort(compareOrderKeys)
    const last = existingKeys.length > 0 ? existingKeys[existingKeys.length - 1] : null
    const toSeed = seedOrder.filter((urn) => {
      const entry = layout.assignments[urn]
      return entry?.layerId === layerId && !entry.orderKey
    })
    if (toSeed.length > 0) {
      const keys = generateNKeysBetween(last, null, toSeed.length)
      assignments = { ...layout.assignments }
      toSeed.forEach((urn, i) => {
        assignments[urn] = { ...assignments[urn], orderKey: keys[i] }
      })
    }
  }
  return { ...layout, layers, assignments }
}

/**
 * Set the view-wide `defaultNodeSortMode` and clear every layer's asc/desc override so all columns
 * follow it ("Apply to all layers"). Layers in 'custom' mode keep their override — a manual
 * arrangement is a deliberate per-layer choice a view-wide default must not destroy.
 */
export function setViewDefaultSortMode(
  layout: NormalizedReferenceLayout,
  mode: 'alpha-asc' | 'alpha-desc',
): NormalizedReferenceLayout {
  const layers = layout.layers.map((l) => {
    if (!l.nodeSortMode || l.nodeSortMode === 'custom') return l
    const { nodeSortMode: _drop, ...rest } = l
    return rest as ViewLayerConfig
  })
  return { ...layout, layers, defaultNodeSortMode: mode }
}
