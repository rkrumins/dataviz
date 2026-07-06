/**
 * Pure transforms over a view's `referenceLayout.layers` array — the single source the Context View
 * canvas renders columns from. Every op returns a NEW array with `order` re-normalized to 0..n-1, so
 * the caller just hands the result to `updateView({ layout: { referenceLayout: { layers } } })`.
 *
 * Kept pure + separately tested (layerMutations.test.ts) because the reorder/remove index math is
 * where off-by-ones hide. The handlers in ContextViewCanvas (addLayer/renameLayer/deleteLayer/
 * reorderLayer) are thin wrappers that mint ids/persist; all the list logic lives here.
 */
import type { ViewLayerConfig } from '@/types/schema'

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
