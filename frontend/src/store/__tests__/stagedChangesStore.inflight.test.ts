/**
 * A change staged while a save runs is not part of that save, so the save must not take it away:
 * the draft path clears only what it sent (`clearSaved`), and the write-through `applyAll` keeps
 * whatever arrived mid-apply. Publishing or merging a draft with edits still on the canvas would
 * leave them behind, so `unsavedCountOnBranch` counts them — on the active scope and on any scope
 * parked by a branch switch.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useStagedChangesStore, unsavedCountOnBranch, type StagedChange } from '../stagedChangesStore'

const change = (id: string, over: Partial<StagedChange> = {}): StagedChange => ({
  id, type: 'rename_entity', targetId: `t-${id}`, after: {}, summary: id, timestamp: 0, ...over,
})

const reset = () => useStagedChangesStore.setState({
  changes: [], redoStack: [], applyStatus: 'idle', lastApplyResult: null, _scopeKey: null, _byScope: {},
})

const ids = () => useStagedChangesStore.getState().changes.map((c) => c.id)

describe('clearSaved', () => {
  beforeEach(reset)

  it('clears only the changes the save carried, and leaves the save’s status to its owner', () => {
    useStagedChangesStore.setState({
      changes: [change('a'), change('b')], redoStack: [change('r')], applyStatus: 'applying',
      lastApplyResult: { ok: 1, failed: 1 },
    })
    useStagedChangesStore.getState().stage({ type: 'rename_entity', targetId: 't-late', after: {}, summary: 'late' })

    useStagedChangesStore.getState().clearSaved(['a', 'b'])

    const s = useStagedChangesStore.getState()
    expect(s.changes.map((c) => c.summary)).toEqual(['late'])
    expect(s.redoStack).toEqual([])
    expect(s.lastApplyResult).toBeNull()
    expect(s.applyStatus).toBe('applying')
  })
})

describe('applyAll', () => {
  beforeEach(reset)

  it('keeps a change staged while it was applying', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    useStagedChangesStore.setState({ changes: [change('a', { apply: () => gate })] })

    const done = useStagedChangesStore.getState().applyAll({} as never, 'ws')
    useStagedChangesStore.getState().stage({ type: 'rename_entity', targetId: 't-late', after: {}, summary: 'late' })
    release()
    await done

    expect(useStagedChangesStore.getState().changes.map((c) => c.summary)).toEqual(['late'])
  })
})

describe('unsavedCountOnBranch', () => {
  beforeEach(reset)

  it('counts the active scope and parked scopes of that branch only', () => {
    const s = useStagedChangesStore.getState()
    s.setScope('ws::ds::br1')
    s.stageMany([change('a'), change('b')])
    s.setScope('ws::ds2::br1')
    s.stageMany([change('c')])
    s.setScope('ws::ds::br2')
    s.stageMany([change('d')])
    s.setScope('ws::ds2::br1')

    const now = useStagedChangesStore.getState()
    expect(unsavedCountOnBranch(now, 'br1')).toBe(3)
    expect(unsavedCountOnBranch(now, 'br2')).toBe(1)
    expect(unsavedCountOnBranch(now, 'br3')).toBe(0)
    expect(unsavedCountOnBranch(now, null)).toBe(0)
    expect(ids()).toEqual(['c'])
  })
})
