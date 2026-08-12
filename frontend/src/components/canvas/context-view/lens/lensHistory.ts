/**
 * Lens focus history — browser-style back/forward semantics for the
 * Lineage Lens walk, replacing the old destructive stack (where Back
 * dropped the hop forever and jumping truncated the trail).
 *
 * `entries` is the walked path; `cursor` points at the current focal.
 * Moving the cursor (back / forward / jump) never loses entries;
 * focusing a NEW node from anywhere truncates the forward side first —
 * the same invariant as the canvas undo/redo (a new action clears the
 * redo stack). Pure functions so the semantics are unit-testable
 * without a component in the loop.
 */

export interface LensHistory {
  /** Visited focal nodes in walk order. Empty = lens closed. */
  entries: string[]
  /** Index of the current focal in `entries`; -1 when closed. */
  cursor: number
}

export const EMPTY_LENS_HISTORY: LensHistory = { entries: [], cursor: -1 }

/** The current focal node id, or null when the lens is closed. */
export const lensFocalOf = (h: LensHistory): string | null =>
  h.entries[h.cursor] ?? null

/**
 * Focus a node: drop any forward entries past the cursor, append, and
 * move the cursor to it. Focusing the current focal is a no-op (the
 * trail must never grow duplicate consecutive hops).
 */
export function lensPush(h: LensHistory, nodeId: string): LensHistory {
  if (lensFocalOf(h) === nodeId) return h
  const entries = [...h.entries.slice(0, h.cursor + 1), nodeId]
  return { entries, cursor: entries.length - 1 }
}

/** Step back one hop; no-op at the start of the path. */
export function lensBackward(h: LensHistory): LensHistory {
  return h.cursor > 0 ? { entries: h.entries, cursor: h.cursor - 1 } : h
}

/** Step forward one hop; no-op at the end of the path. */
export function lensForwardStep(h: LensHistory): LensHistory {
  return h.cursor < h.entries.length - 1 ? { entries: h.entries, cursor: h.cursor + 1 } : h
}

/** Jump the cursor to entry `index` (clamped) without dropping anything. */
export function lensJump(h: LensHistory, index: number): LensHistory {
  if (h.entries.length === 0) return h
  const cursor = Math.max(0, Math.min(index, h.entries.length - 1))
  return cursor === h.cursor ? h : { entries: h.entries, cursor }
}
