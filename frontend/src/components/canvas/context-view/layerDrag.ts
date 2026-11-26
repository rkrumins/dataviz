/**
 * The column a header drag is carrying, and where it is shown. A browser hides a drag's data until
 * the drop, yet the hint a header shows while one hovers it depends on what is dragged: "Move after
 * Apps" from the left, "Move before Apps" from the right, nothing over its own header. The header
 * that starts the drag records it here and clears it when the drag ends.
 */
export interface DraggedLayer {
  id: string
  /** Its place among the columns as shown (`ViewLayerConfig.order`). */
  order: number
}

let dragged: DraggedLayer | null = null

export function setDraggedLayer(layer: DraggedLayer | null): void {
  dragged = layer
}

/** The column being dragged, or null (no header drag, or one this canvas did not start). */
export function draggedLayer(): DraggedLayer | null {
  return dragged
}
