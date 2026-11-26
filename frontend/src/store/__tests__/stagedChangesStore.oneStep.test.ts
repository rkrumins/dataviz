/**
 * One choice, one Undo. A dialog choice can stage several changes at once — delete a column's
 * entities from the data and remove the column, say — and discard the creates of entities new in
 * this draft on the way. Undo (the toolbar's, or the notice's) takes the whole choice back, the new
 * entities included: a discard made as part of an action is undone with it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useStagedChangesStore, type StagedChange } from '../stagedChangesStore'

const s = () => useStagedChangesStore.getState()
const mk = (id: string, over: Partial<StagedChange> = {}): Omit<StagedChange, 'id' | 'timestamp'> & { id: string } => ({
  id, type: 'rename_entity', targetId: `t-${id}`, after: {}, summary: id, ...over,
})
const ids = () => s().changes.map((c) => c.id)

beforeEach(() => {
  useStagedChangesStore.setState({ changes: [], past: [], redoStack: [] } as never)
})

describe('asOneStep', () => {
  it('records everything the action stages as one Undo step, and returns its id', () => {
    s().stage(mk('earlier'))
    let step: string | undefined
    step = s().asOneStep(() => {
      s().stage(mk('a'))
      s().stageMany([{ ...mk('b'), timestamp: 0 } as StagedChange, { ...mk('c'), timestamp: 0 } as StagedChange])
    })
    expect(s().past).toHaveLength(2)
    expect(s().past[1].id).toBe(step)

    s().undo()
    expect(s().changes.map((c) => c.summary)).toEqual(['earlier'])
    s().redo()
    expect(s().changes.map((c) => c.summary)).toEqual(['earlier', 'a', 'b', 'c'])
    step = s().asOneStep(() => {})
    expect(step).toBeUndefined()
  })

  it('an undoable discard in it comes back with it — a new entity, its child and its link, drawn again', () => {
    const drawn = { p: vi.fn(), child: vi.fn(), link: vi.fn() }
    const gone = vi.fn()
    useStagedChangesStore.setState({
      changes: [
        { ...mk('p', { type: 'create_entity', targetUrn: 'urn:staged:p', reapply: drawn.p, discard: gone }), timestamp: 1 },
        { ...mk('child', { type: 'create_entity', targetUrn: 'urn:staged:c', after: { parentUrn: 'urn:staged:p' }, reapply: drawn.child }), timestamp: 2 },
        { ...mk('link', { type: 'create_edge', after: { source: 'urn:staged:c', target: 'urn:x' }, reapply: drawn.link }), timestamp: 3 },
        { ...mk('keep'), timestamp: 4 },
      ],
    } as never)
    s().asOneStep(() => {
      s().discardMany(['p'], { undoable: true })
      s().stage(mk('column'))
    })
    expect(gone).toHaveBeenCalledTimes(1)
    expect(ids().filter((id) => id !== s().changes.find((c) => c.summary === 'column')?.id)).toEqual(['keep'])

    s().undo()
    expect(ids().sort()).toEqual(['child', 'keep', 'link', 'p'])
    // Parent first: each is drawn again before what hangs off it.
    expect(drawn.p.mock.invocationCallOrder[0]).toBeLessThan(drawn.child.mock.invocationCallOrder[0])
    expect(drawn.child.mock.invocationCallOrder[0]).toBeLessThan(drawn.link.mock.invocationCallOrder[0])

    // Redo discards them again.
    s().redo()
    expect(gone).toHaveBeenCalledTimes(2)
    expect(ids()).not.toContain('p')
  })

  it('a plain discard still does not offer a new entity back', () => {
    useStagedChangesStore.setState({
      changes: [{ ...mk('p', { type: 'create_entity', targetUrn: 'urn:staged:p' }), timestamp: 1 }],
    } as never)
    s().discardMany(['p'])
    expect(s().redoStack).toHaveLength(0)
    expect(s().past).toHaveLength(0)
  })
})
