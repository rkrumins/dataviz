/**
 * The entity a row drag is carrying. A browser hides a drag's data until the drop, so a target
 * cannot read it while the drag hovers — yet the hint it shows ("Move inside Finance · changes the
 * data", "Back under Sales · only this view", or why it can't) depends on what is dragged. The row
 * that starts a drag records it here and clears it when the drag ends.
 */
let dragged: string | null = null

export function setDraggedEntity(id: string | null): void {
  dragged = id
}

/** The entity being dragged, or null (no row drag, or one this canvas did not start). */
export function draggedEntity(): string | null {
  return dragged
}
