/**
 * stagedIndex — the staged changes indexed by what they change, built once per version of the
 * list and shared by every reader.
 *
 * Every row of the canvas, the drawers and the overlays ask "is this staged?". Answered by scanning
 * the list, a 10,000-change draft with a few hundred rows mounted cost millions of comparisons on
 * every edit; here each answer is a map lookup, and the selectors built on it return the same
 * value until that row's answer changes — so an edit re-renders the rows it touches, not all.
 */
import type { StagedChange } from './stagedChangesStore'

export interface StagedIndex {
  /** By target id and by target urn: the last change made to it, and where it is in the list. */
  last: Map<string, { change: StagedChange; at: number }>
  /** A node's edit (`update_entity` / `rename_entity`), by its id. */
  nodeEdit: Map<string, StagedChange>
  /** A relationship's edit, by its id. */
  edgeEdit: Map<string, StagedChange>
  /** A relationship's delete, by its id. */
  edgeDelete: Map<string, StagedChange>
}

const cache = new WeakMap<readonly StagedChange[], StagedIndex>()

export function stagedIndexOf(changes: readonly StagedChange[]): StagedIndex {
  let ix = cache.get(changes)
  if (ix) return ix
  ix = { last: new Map(), nodeEdit: new Map(), edgeEdit: new Map(), edgeDelete: new Map() }
  changes.forEach((c, at) => {
    ix!.last.set(c.targetId, { change: c, at })
    if (c.targetUrn) ix!.last.set(c.targetUrn, { change: c, at })
    if ((c.type === 'update_entity' || c.type === 'rename_entity') && !ix!.nodeEdit.has(c.targetId)) ix!.nodeEdit.set(c.targetId, c)
    else if (c.type === 'edit_edge' && !ix!.edgeEdit.has(c.targetId)) ix!.edgeEdit.set(c.targetId, c)
    else if (c.type === 'delete_edge' && !ix!.edgeDelete.has(c.targetId)) ix!.edgeDelete.set(c.targetId, c)
  })
  cache.set(changes, ix)
  return ix
}

/** The last change staged to an entity, by its id or its urn. */
export function lastStagedFor(changes: readonly StagedChange[], id: string, urn?: string | null): StagedChange | undefined {
  const { last } = stagedIndexOf(changes)
  const a = last.get(id)
  const b = urn && urn !== id ? last.get(urn) : undefined
  if (!a) return b?.change
  if (!b) return a.change
  return a.at >= b.at ? a.change : b.change
}
