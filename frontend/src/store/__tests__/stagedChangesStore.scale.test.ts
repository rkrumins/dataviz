import { beforeEach, describe, expect, it } from 'vitest'
import { MAX_UNDO_STEPS, useStagedChangesStore, type StagedChange } from '../stagedChangesStore'
import { lastStagedFor, stagedIndexOf } from '../stagedIndex'

const s = () => useStagedChangesStore.getState()
const mk = (id: string, over: Partial<StagedChange> = {}): StagedChange => ({
  id, type: 'rename_entity', targetId: `t-${id}`, after: {}, summary: id, timestamp: 0, ...over,
})

beforeEach(() => useStagedChangesStore.setState({ changes: [], past: [], redoStack: [] } as never))

describe('the staged history at volume', () => {
  it('undoes and redoes a 5,000-change step in one pass', () => {
    const others = Array.from({ length: 10_000 }, (_, i) => mk(`o${i}`))
    useStagedChangesStore.setState({ changes: others } as never)
    const batch = Array.from({ length: 5000 }, (_, i) => mk(`b${i}`))
    s().stageMany(batch)
    const t = performance.now()
    s().undo()
    expect(s().changes).toHaveLength(10_000)
    s().redo()
    expect(performance.now() - t).toBeLessThan(500)
    expect(s().changes).toHaveLength(15_000)
    expect(s().changes[10_000].id).toBe('b0')
  })

  it(`keeps the last ${MAX_UNDO_STEPS} actions`, () => {
    for (let i = 0; i < MAX_UNDO_STEPS + 20; i++) s().stage({ type: 'rename_entity', targetId: `t${i}`, after: {}, summary: '' })
    expect(s().past).toHaveLength(MAX_UNDO_STEPS)
    expect(s().changes).toHaveLength(MAX_UNDO_STEPS + 20)
  })
})

describe('stagedIndexOf', () => {
  it('answers "what is staged on this" by lookup, once per version of the list', () => {
    const changes = [
      mk('a', { targetId: 'n1', targetUrn: 'urn:n1', type: 'update_entity' }),
      mk('b', { targetId: 'e1', type: 'edit_edge' }),
      mk('c', { targetId: 'e2', type: 'delete_edge' }),
      mk('d', { targetId: 'n1', targetUrn: 'urn:n1', type: 'move_entity' }),
    ]
    const ix = stagedIndexOf(changes)
    expect(stagedIndexOf(changes)).toBe(ix)
    expect(ix.nodeEdit.get('n1')?.id).toBe('a')
    expect(ix.edgeEdit.get('e1')?.id).toBe('b')
    expect(ix.edgeDelete.get('e2')?.id).toBe('c')
    expect(lastStagedFor(changes, 'n1', 'urn:n1')?.id).toBe('d')
    expect(lastStagedFor(changes, 'nope')).toBeUndefined()
  })
})
