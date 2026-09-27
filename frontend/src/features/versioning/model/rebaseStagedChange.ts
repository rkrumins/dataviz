/**
 * rebaseStagedChange — settle a conflicting change: rebase what the user CHANGED onto the entity as
 * it is now, field by field.
 *
 * Only the user's patch moves (the fields they changed, the properties they set or removed), never
 * their whole copy of the entity — so everything someone else changed meanwhile is kept, and the
 * fields in conflict go the way the user chose: "mine" keeps their value, "theirs" drops it from
 * the patch. The rebased change reads from the current value and its token, so saving it again is
 * not a conflict (unless the entity moves again). An edit left with nothing to change is dropped.
 */
import { useCanvasStore, type LineageNode } from '@/store/canvas'
import { useStagedChangesStore, type StagedChange } from '@/store/stagedChangesStore'
import { toCanvasNode } from '@/lib/canvasNodeMapper'
import { applyNodePatch } from '@/lib/nodeFields'
import { nodeUpdatePatch, propertiesPatch } from './stagedChangesToOps'

export type ConflictChoice = 'mine' | 'theirs'

type Bag = Record<string, unknown>
const asBag = (v: unknown): Bag => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Bag) : {})

/** The part of a patch a "theirs" choice gives up: a field, or one property (removal included). */
function dropTheirs(payload: Bag, unset: string[], path: string[]): string[] {
  if (path[0] === 'properties' && path[1] !== undefined) {
    const props = asBag(payload.properties)
    delete props[path[1]]
    if (Object.keys(props).length === 0) delete payload.properties
    return unset.filter((k) => k !== path[1])
  }
  if (path[0] !== undefined) delete payload[path[0]]
  return unset
}

/** The rebased change — or `null` when nothing of the edit is left (it goes away). */
export function rebaseStagedChange(
  change: StagedChange,
  choices: Record<string, ConflictChoice>,
): StagedChange | null {
  const conflict = change.conflict
  if (!conflict) return change
  const current = conflict.current
  if (current.deleted) return null                          // gone meanwhile: nothing to edit
  const theirs = conflict.fields.filter((f) => (choices[f.key] ?? 'mine') === 'theirs')

  if (current.kind === 'edge' && change.type === 'edit_edge') {
    const patch = propertiesPatch(asBag(asBag(change.before).properties), asBag(asBag(change.after).properties))
    const payload: Bag = { properties: patch.set }
    let unset = patch.unset
    for (const f of theirs) unset = dropTheirs(payload, unset, f.path)
    const base = asBag(current.edge.properties)
    const properties = { ...base, ...asBag(payload.properties) }
    for (const k of unset) delete properties[k]
    const before = { properties: base, version: current.version }
    const rest = propertiesPatch(base, properties)
    if (Object.keys(rest.set).length === 0 && rest.unset.length === 0) return null
    return { ...change, before, after: { ...asBag(change.after), properties }, conflict: undefined, error: undefined }
  }

  if (current.kind === 'node' && (change.type === 'update_entity' || change.type === 'rename_entity')) {
    const { payload, unset: unset0 } = nodeUpdatePatch(change.before, change.after)
    let unset = unset0
    for (const f of theirs) unset = dropTheirs(payload, unset, f.path)
    const before = toCanvasNode(current.node).data as Bag
    const after = applyNodePatch({ ...asBag(change.after), ...before }, payload, unset)
    const rest = nodeUpdatePatch(before, after)
    if (Object.keys(rest.payload).length === 0 && rest.unset.length === 0) return null
    return { ...change, before, after, conflict: undefined, error: undefined }
  }
  return change
}

/** Settle one staged change's conflict — rebased in the store and on the canvas, or dropped. */
export function resolveConflict(changeId: string, choices: Record<string, ConflictChoice>): void {
  const change = useStagedChangesStore.getState().changes.find((c) => c.id === changeId)
  if (!change?.conflict) return
  const current = change.conflict.current
  const rebased = rebaseStagedChange(change, choices)
  const canvas = useCanvasStore.getState()
  if (current.kind === 'node' && !current.deleted) {
    // The canvas shows the outcome: the rebased edit, or the current value when none is left.
    const shown = (rebased?.after ?? toCanvasNode(current.node).data) as LineageNode['data']
    canvas.updateNode(change.targetId, shown)
  } else if (current.kind === 'edge' && !current.deleted) {
    canvas.applyServerEdges([current.edge])
  }
  useStagedChangesStore.setState((s) => ({
    changes: rebased === null
      ? s.changes.filter((c) => c.id !== changeId)
      : s.changes.map((c) => (c.id === changeId ? withDiscard(rebased) : c)),
  }))
}

/** A rebased node edit's discard puts back the value it was rebased onto, not the stale read. */
function withDiscard(change: StagedChange): StagedChange {
  if (change.type !== 'update_entity' && change.type !== 'rename_entity') return change
  const base = change.before as LineageNode['data']
  return { ...change, discard: () => useCanvasStore.getState().updateNode(change.targetId, base) }
}
