/**
 * stageNodeEdit — the ONE way a node edit is staged, whatever made it (the entity drawer, an
 * inline rename on the canvas).
 *
 * Each surface used to stage its own change: the drawer an `update_entity`, the inline rename a
 * `rename_entity` recorded as `{ label }` alone. A rename and an edit of the same node were two
 * changes, two ops, and discarding one restored the other's stale snapshot over the canvas.
 *
 * Now a node has at most one staged edit. It keeps the node as it was FIRST read (`before`, the
 * diff base the save sends a patch against and the state a discard restores) and the latest
 * state (`after`). An edit that nets out to nothing — the user put everything back — drops the
 * staged change instead of saving a no-op.
 *
 * Each call is one step in the undo history (`replace`): Undo puts the node back as the previous
 * edit left it — not all the way to the original — and Redo draws the edit again (`reapply`).
 */
import { useCanvasStore, type LineageNode } from '@/store/canvas'
import { generateId } from '@/lib/utils'
import { useStagedChangesStore, type StagedChange } from '@/store/stagedChangesStore'
import { nodeUpdatePatch } from './stagedChangesToOps'

type NodeData = LineageNode['data']

const isNodeEditChange = (c: StagedChange) => c.type === 'update_entity' || c.type === 'rename_entity'

const labelOf = (d: Record<string, unknown>) => String(d.label ?? d.displayName ?? '')

export interface NodeEdit {
  nodeId: string
  /** The node's data as the caller read it just now. */
  current: NodeData
  after: NodeData
}

/**
 * Stage `after` as the node's edit and show it on the canvas.
 *
 * `current` is the node's data as the caller read it just now. When an earlier edit of this node
 * is already staged, its recorded `before` is the original — completed from `current` for any
 * field it did not record (an older partial snapshot), since the earlier edit left those alone.
 */
export function stageNodeEdit(nodeId: string, current: NodeData, after: NodeData): void {
  stageNodeEdits([{ nodeId, current, after }])
}

/**
 * Stage many node edits as one action — one write to the canvas, one to the staged changes, one
 * Undo step — each exactly as `stageNodeEdit` would stage it alone. A bulk edit of 10,000
 * entities is one pass, not 10,000 writes that each scan every change. Returns the Undo step's id
 * (none when nothing changed).
 */
export function stageNodeEdits(edits: readonly NodeEdit[]): string | undefined {
  const store = useStagedChangesStore.getState()
  const existingFor = new Map<string, StagedChange>()
  for (const c of store.changes) if (isNodeEditChange(c) && !existingFor.has(c.targetId)) existingFor.set(c.targetId, c)
  const canvas = new Map<string, NodeData>()
  const entries: { before: StagedChange | null; after: StagedChange | null }[] = []

  for (const { nodeId, current, after } of edits) {
    // A node edited twice in one batch builds on its first edit here.
    const existing = existingFor.get(nodeId)
    const original = (existing
      ? { ...current, ...(existing.before as Record<string, unknown> | undefined) }
      : { ...current }) as NodeData
    canvas.set(nodeId, after)

    const { payload, unset } = nodeUpdatePatch(original, after)
    const changed = [...Object.keys(payload).filter((k) => k !== 'properties'),
      ...Object.keys((payload.properties as Record<string, unknown> | undefined) ?? {}), ...unset]
    if (changed.length === 0) {
      // Back where it started: nothing to save, and nothing for a discard to restore — but the step
      // that put it back can be undone.
      if (existing) { entries.push({ before: existing, after: null }); existingFor.delete(nodeId) }
      continue
    }

    const onlyRename = changed.length === 1 && 'displayName' in payload
    const name = labelOf(original) || nodeId
    const input: Omit<StagedChange, 'id' | 'timestamp'> = {
      type: onlyRename ? 'rename_entity' : 'update_entity',
      targetId: nodeId,
      targetUrn: (original.urn as string | undefined) ?? nodeId,
      before: original,
      after: { ...after },
      summary: onlyRename
        ? `Rename '${name}' → '${labelOf(after)}'`
        : `Edit ${changed.length} field${changed.length === 1 ? '' : 's'} on '${name}'`,
      discard: () => useCanvasStore.getState().updateNode(nodeId, exactly(original, after)),
      reapply: () => useCanvasStore.getState().updateNode(nodeId, exactly(after, original)),
    }
    // Replaced in place (not `stageOrReplace`, which keeps the old `before`): the completed original.
    const next: StagedChange = existing
      ? { ...existing, ...input, timestamp: Date.now() }
      : { ...input, id: generateId('staged'), timestamp: Date.now() }
    entries.push({ before: existing ?? null, after: next })
    existingFor.set(nodeId, next)
  }

  useCanvasStore.getState().updateNodes(canvas)
  return entries.length ? store.replaceMany(collapse(entries)) : undefined
}

/** `to` as a merge over `from`: a field `from` has and `to` does not is written as absent, so the
 *  canvas (which merges an update into what it holds) shows `to`, not a mix of both. */
function exactly(to: NodeData, from: NodeData): NodeData {
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(from)) if (!(k in to)) out[k] = undefined
  return { ...out, ...to } as NodeData
}

/** One entry per node: a node edited twice in a batch is one change, from where it was before the
 *  batch to where the batch left it. */
function collapse(entries: { before: StagedChange | null; after: StagedChange | null }[]) {
  const byNode = new Map<string, { before: StagedChange | null; after: StagedChange | null }>()
  for (const e of entries) {
    const id = (e.after ?? e.before)!.targetId
    const was = byNode.get(id)
    byNode.set(id, was ? { before: was.before, after: e.after } : e)
  }
  return [...byNode.values()].filter((e) => e.before !== e.after)
}
