/**
 * Undo steps back ONE action, the most recent one — whatever slot its change sits in. A node edited
 * three times keeps a single staged change (stageNodeEdit), so Undo used to drop that whole change
 * (every edit at once) and could pick an older node's change instead; Redo re-added the record but
 * left the canvas showing the original value.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { useCanvasStore, type LineageNode } from '@/store/canvas'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { stageNodeEdit } from '@/features/versioning/model/stageNodeEdit'

const node = (id: string, owner: string) =>
  ({ id, type: 'generic', position: { x: 0, y: 0 }, data: { label: id, urn: id, type: 't', properties: { owner } } }) as unknown as LineageNode

const store = () => useStagedChangesStore.getState()
const data = (id: string) => useCanvasStore.getState().nodes.find((n) => n.id === id)!.data as Record<string, unknown>
const owner = (id: string) => (data(id).properties as { owner: string }).owner

/** One committed edit of `owner` on a node, as the drawer stages it. */
function setOwner(id: string, value: string) {
  const current = data(id) as LineageNode['data']
  stageNodeEdit(id, current, { ...current, properties: { owner: value } } as LineageNode['data'])
}

beforeEach(() => {
  useCanvasStore.setState({ nodes: [node('a', 'ann'), node('b', 'bob')], edges: [], _nodeIndex: new Set(['a', 'b']), _edgeIndex: new Set() } as never)
  useStagedChangesStore.setState({ changes: [], past: [], redoStack: [], applyStatus: 'idle', _scopeKey: null, _byScope: {} } as never)
})

describe('undo / redo of node edits', () => {
  it('steps back one edit at a time on a node edited twice', () => {
    setOwner('a', 'amy')
    setOwner('a', 'ada')
    expect(store().changes).toHaveLength(1)

    store().undo()
    expect(owner('a')).toBe('amy')
    expect(store().changes).toHaveLength(1)
    expect((store().changes[0].after as { properties: { owner: string } }).properties.owner).toBe('amy')

    store().undo()
    expect(owner('a')).toBe('ann')
    expect(store().changes).toHaveLength(0)
  })

  it('undoes the most recent edit, not the change that sits last', () => {
    setOwner('a', 'amy')
    setOwner('b', 'bea')
    setOwner('a', 'ada')        // a's change keeps its first slot

    store().undo()
    expect(owner('a')).toBe('amy')
    expect(owner('b')).toBe('bea')
  })

  it('redo draws the edit again on the canvas', () => {
    setOwner('a', 'amy')
    setOwner('a', 'ada')
    store().undo()
    store().undo()
    store().redo()
    expect(owner('a')).toBe('amy')
    store().redo()
    expect(owner('a')).toBe('ada')
    expect(store().redoStack).toHaveLength(0)
  })

  it('an edit that puts the value back can itself be undone', () => {
    setOwner('a', 'amy')
    setOwner('a', 'ann')       // nets out: nothing left to save
    expect(store().changes).toHaveLength(0)

    store().undo()
    expect(owner('a')).toBe('amy')
    expect(store().changes).toHaveLength(1)
  })

  it('a fresh edit clears what could be redone', () => {
    setOwner('a', 'amy')
    store().undo()
    setOwner('b', 'bea')
    expect(store().redoStack).toHaveLength(0)
  })

  it('a discarded edit comes back with Redo, drawn again', () => {
    setOwner('a', 'amy')
    store().discard(store().changes[0].id)
    expect(owner('a')).toBe('ann')
    store().redo()
    expect(owner('a')).toBe('amy')
    expect(store().changes).toHaveLength(1)
  })

  it('a saved edit leaves the history; edits made after it stay undoable', () => {
    setOwner('a', 'amy')
    const saved = store().changes[0].id
    setOwner('b', 'bea')
    store().clearSaved([saved])
    store().undo()
    expect(owner('b')).toBe('bob')
    expect(store().undo()).toBe(false)
    expect(owner('a')).toBe('amy')
  })

  it('without a history (restored after a reload) takes back the newest change', () => {
    setOwner('a', 'amy')
    setOwner('b', 'bea')
    useStagedChangesStore.setState({ past: [] })
    store().undo()
    expect(owner('b')).toBe('bob')
    expect(owner('a')).toBe('amy')
  })
})
