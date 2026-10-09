/**
 * The Context View's layout writer, reachable from hooks the canvas renders deep below it (the
 * entity drawer, a tree row) without prop-drilling. The canvas registers `current` (the view's
 * normalized reference layout) and `persist` (write it: store now, durable save debounced) while it
 * is mounted; nothing else writes layout through here.
 */
import type { NormalizedReferenceLayout } from '@/utils/referenceLayout'

export interface LayoutWriter {
  current: () => NormalizedReferenceLayout
  persist: (next: NormalizedReferenceLayout) => void
}

let writer: LayoutWriter | null = null

/** Register the mounted canvas's writer; the returned function unregisters it. */
export function registerLayoutWriter(w: LayoutWriter): () => void {
  writer = w
  return () => { if (writer === w) writer = null }
}

export function layoutWriter(): LayoutWriter | null {
  return writer
}
