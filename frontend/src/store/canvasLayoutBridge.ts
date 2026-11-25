/**
 * The Context View's layout writer, reachable from hooks the canvas renders deep below it (the
 * entity drawer, a tree row) without prop-drilling. The canvas registers `current` (the view's
 * normalized reference layout) and `persist` (write it: store now, durable save debounced) while it
 * is mounted; nothing else writes layout through here.
 *
 * Beside it, the canvas's MOVE HOST: what a move made below the canvas (a row's drop, a column's,
 * the drawer's "Choose a new parent…") asks of the canvas it is made on.
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

/** Why the canvas refuses a move right now: a few words for a drop hint, a sentence for the notice. */
export interface MoveRefusal {
  hint: string
  message: string
}

export interface MoveHost {
  /** Why a move (a DATA change) is refused here — the same gates as the canvas's menus — or null. */
  blocked: () => MoveRefusal | null
  /** The column an entity is drawn in, if any. */
  columnOf: (id: string) => string | undefined
  /** Whether this view draws the entity — as a row, or as the column mapped to it. */
  isDrawn: (id: string) => boolean
  /** A move was staged: open its new parent (and the way to it) so the entity stays in sight. */
  moved: (childId: string, parentId: string | null) => void
}

let host: MoveHost | null = null

/** Register the mounted canvas's move host; the returned function unregisters it. */
export function registerMoveHost(h: MoveHost): () => void {
  host = h
  return () => { if (host === h) host = null }
}

/** The mounted Context View's move host — none on a canvas that has not registered one. */
export function moveHost(): MoveHost | null {
  return host
}
