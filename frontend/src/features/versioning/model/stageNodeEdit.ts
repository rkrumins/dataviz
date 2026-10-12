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
 */
import { useCanvasStore, type LineageNode } from '@/store/canvas'
import { useStagedChangesStore, type StagedChange } from '@/store/stagedChangesStore'
import { nodeUpdatePatch } from './stagedChangesToOps'

type NodeData = LineageNode['data']

const isNodeEdit = (nodeId: string) => (c: StagedChange) =>
  (c.type === 'update_entity' || c.type === 'rename_entity') && c.targetId === nodeId

const labelOf = (d: Record<string, unknown>) => String(d.label ?? d.displayName ?? '')

/**
 * Stage `after` as the node's edit and show it on the canvas.
 *
 * `current` is the node's data as the caller read it just now. When an earlier edit of this node
 * is already staged, its recorded `before` is the original — completed from `current` for any
 * field it did not record (an older partial snapshot), since the earlier edit left those alone.
 */
export function stageNodeEdit(nodeId: string, current: NodeData, after: NodeData): void {
  const store = useStagedChangesStore.getState()
  const existing = store.changes.find(isNodeEdit(nodeId))
  const original = (existing
    ? { ...current, ...(existing.before as Record<string, unknown> | undefined) }
    : { ...current }) as NodeData

  useCanvasStore.getState().updateNode(nodeId, after)

  const { payload, unset } = nodeUpdatePatch(original, after)
  const changed = [...Object.keys(payload).filter((k) => k !== 'properties'),
    ...Object.keys((payload.properties as Record<string, unknown> | undefined) ?? {}), ...unset]
  if (changed.length === 0) {
    // Back where it started: nothing to save, and nothing for a discard to restore.
    if (existing) useStagedChangesStore.setState((s) => ({ changes: s.changes.filter((c) => c.id !== existing.id) }))
    return
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
    discard: () => useCanvasStore.getState().updateNode(nodeId, original),
  }
  if (!existing) {
    store.stage(input)
    return
  }
  // Replaced in place (not `stageOrReplace`, which keeps the old `before`): the completed original.
  useStagedChangesStore.setState((s) => ({
    changes: s.changes.map((c) => (c.id === existing.id ? { ...c, ...input, timestamp: Date.now() } : c)),
  }))
}
