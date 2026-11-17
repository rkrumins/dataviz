/**
 * nodeUpdateBatch — gather the canvas node updates a burst of hooks makes (an Undo of a 5,000-entity
 * bulk edit runs 5,000 of them) and write them to the canvas once.
 *
 * The staged-changes store runs each change's hooks; the canvas store, which imports it, applies
 * them — so the canvas registers how a batch is written, and the staged store opens the batch.
 */
type Updates = Map<string, Record<string, unknown>>

let pending: Updates | null = null
let write: ((updates: Updates) => void) | null = null

/** How a batch is written (the canvas store's `updateNodes`). */
export function registerNodeUpdateWriter(w: (updates: Updates) => void) {
  write = w
}

/** The batch being gathered, if one is: `updateNode` adds to it instead of writing. */
export function gatheringNodeUpdates(): Updates | null {
  return pending
}

/** Run `fn`, writing every node update it makes to the canvas once, when it is done. */
export function batchNodeUpdates<T>(fn: () => T): T {
  if (pending || !write) return fn()
  pending = new Map()
  try {
    return fn()
  } finally {
    const updates = pending
    pending = null
    if (updates.size) write(updates)
  }
}
