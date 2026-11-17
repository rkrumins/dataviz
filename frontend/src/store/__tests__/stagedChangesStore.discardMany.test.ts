import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useStagedChangesStore, type StagedChange } from '../stagedChangesStore'

const s = () => useStagedChangesStore.getState()
const mk = (id: string, over: Partial<StagedChange> = {}): StagedChange => ({
  id, type: 'rename_entity', targetId: `t-${id}`, after: {}, summary: id, timestamp: 0, ...over,
})

beforeEach(() => {
  useStagedChangesStore.setState({ changes: [], past: [], redoStack: [] } as never)
})

describe('discardMany', () => {
  it('discards them in one write, and one Redo brings them back', () => {
    const hooks = { a: vi.fn(), b: vi.fn() }
    useStagedChangesStore.setState({ changes: [mk('a', { discard: hooks.a }), mk('b', { discard: hooks.b }), mk('c')] } as never)
    const writes = vi.fn()
    const unsub = useStagedChangesStore.subscribe(writes)
    s().discardMany(['a', 'b'])
    unsub()
    expect(writes).toHaveBeenCalledTimes(1)
    expect(s().changes.map((c) => c.id)).toEqual(['c'])
    expect(hooks.a).toHaveBeenCalled()
    expect(hooks.b).toHaveBeenCalled()
    expect(s().redoStack).toHaveLength(1)
    s().redo()
    expect(s().changes.map((c) => c.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('takes an entity created in the draft with its children and links, and does not offer them back', () => {
    useStagedChangesStore.setState({
      changes: [
        mk('p', { type: 'create_entity', targetUrn: 'urn:staged:p' }),
        mk('child', { type: 'create_entity', targetUrn: 'urn:staged:c', after: { parentUrn: 'urn:staged:p' } }),
        mk('link', { type: 'create_edge', after: { source: 'urn:staged:c', target: 'urn:x' } }),
        mk('edit'),
        mk('keep'),
      ],
    } as never)
    s().discardMany(['p', 'edit'])
    expect(s().changes.map((c) => c.id)).toEqual(['keep'])
    expect(s().redoStack).toHaveLength(1)
    expect(s().redoStack[0].entries.map((e) => e.after?.id)).toEqual(['edit'])
  })

  it('discards 10,000 at once in linear time', () => {
    const many = Array.from({ length: 10_000 }, (_, i) => mk(`m${i}`))
    useStagedChangesStore.setState({ changes: many } as never)
    const t = performance.now()
    s().discardMany(many.map((c) => c.id))
    expect(performance.now() - t).toBeLessThan(500)
    expect(s().changes).toHaveLength(0)
  })
})
