/**
 * Staged changes are scoped per (workspace, data source, branch): switching branches must NOT
 * show another branch's staged edits (a draft is isolated until merged), and switching back must
 * restore the branch's own edits. Regression for the cross-branch leak where a delete staged on
 * branch "123" bled onto branch "456"/"789"'s canvas + containment tree.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useStagedChangesStore } from '../stagedChangesStore'

const del = (id: string) => ({
  type: 'delete_entity' as const, targetId: id, after: null, summary: `delete ${id}`,
})

const reset = () =>
  useStagedChangesStore.setState({ changes: [], redoStack: [], _scopeKey: null, _byScope: {} })

const ids = () => useStagedChangesStore.getState().changes.map((c) => c.targetId)

describe('stagedChangesStore branch scoping', () => {
  beforeEach(reset)

  it('isolates staged changes between branches', () => {
    const s = useStagedChangesStore.getState()
    s.setScope('ws::ds::123')
    s.stage(del('D1'))
    expect(ids()).toEqual(['D1'])               // staged on 123

    s.setScope('ws::ds::456')
    expect(ids()).toEqual([])                    // 456 must NOT see 123's delete (no leak)

    s.stage(del('D2'))
    expect(ids()).toEqual(['D2'])               // 456's own edit
  })

  it('preserves each branch’s staged changes across switches', () => {
    const s = useStagedChangesStore.getState()
    s.setScope('ws::ds::123'); s.stage(del('D1'))
    s.setScope('ws::ds::456'); s.stage(del('D2'))

    s.setScope('ws::ds::123')
    expect(ids()).toEqual(['D1'])               // 123 restored, not D2
    s.setScope('ws::ds::456')
    expect(ids()).toEqual(['D2'])               // 456 restored, not D1
  })

  it('switching data source (scope) also isolates', () => {
    const s = useStagedChangesStore.getState()
    s.setScope('ws::dsA::main'); s.stage(del('X'))
    s.setScope('ws::dsB::main')
    expect(ids()).toEqual([])                    // different data source → clean
  })

  it('re-activating the same scope is a no-op (keeps edits)', () => {
    const s = useStagedChangesStore.getState()
    s.setScope('ws::ds::123'); s.stage(del('D1'))
    s.setScope('ws::ds::123')                    // same key
    expect(ids()).toEqual(['D1'])
  })
})
