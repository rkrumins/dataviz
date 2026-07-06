import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearSnapshot,
  markSnapshotCommitting,
  readSnapshot,
  reconcileSnapshot,
  toSerializableChange,
  writeSnapshot,
  type StagedDraftSnapshot,
} from './stagedDraftPersistence'
import type { StagedChange } from '@/store/stagedChangesStore'

function snap(overrides: Partial<StagedDraftSnapshot> = {}): StagedDraftSnapshot {
  return {
    version: 1,
    scopeKey: 'ws1::ds1::br1',
    branchId: 'br1',
    phase: 'staged',
    savedAt: 0,
    changes: [
      { id: 'c1', type: 'create_entity', targetId: 't1', after: { displayName: 'A' }, summary: 'Create A', timestamp: 1 },
    ],
    pendingNodes: [],
    pendingEdges: [],
    ...overrides,
  }
}

describe('stagedDraftPersistence — reconcileSnapshot (double-create guard)', () => {
  it('restores a staged snapshot on the matching branch', () => {
    expect(reconcileSnapshot(snap(), 'br1')).toBe('restore')
  })

  it('discards a snapshot marked committing (crash mid-save must not re-apply)', () => {
    expect(reconcileSnapshot(snap({ phase: 'committing' }), 'br1')).toBe('discard')
  })

  it('discards a snapshot from a different branch (no cross-branch contamination)', () => {
    expect(reconcileSnapshot(snap({ branchId: 'br1' }), 'br2')).toBe('discard')
  })

  it('discards an empty snapshot', () => {
    expect(reconcileSnapshot(snap({ changes: [] }), 'br1')).toBe('discard')
  })

  it('no-ops when there is no snapshot', () => {
    expect(reconcileSnapshot(null, 'br1')).toBe('noop')
  })
})

describe('stagedDraftPersistence — serialization', () => {
  it('strips non-serializable closures, keeps data', () => {
    const live: StagedChange = {
      id: 'c1',
      type: 'create_entity',
      targetId: 't1',
      targetUrn: 'urn:staged:x',
      after: { displayName: 'A' },
      summary: 'Create A',
      timestamp: 5,
      apply: async () => {},
      discard: () => {},
      reapply: () => {},
    }
    const out = toSerializableChange(live)
    expect(out).toEqual({
      id: 'c1',
      type: 'create_entity',
      targetId: 't1',
      targetUrn: 'urn:staged:x',
      before: undefined,
      after: { displayName: 'A' },
      summary: 'Create A',
      timestamp: 5,
    })
    expect('apply' in out).toBe(false)
    expect('discard' in out).toBe(false)
    // Round-trips through JSON cleanly.
    expect(() => JSON.stringify(out)).not.toThrow()
  })
})

describe('stagedDraftPersistence — localStorage round-trip', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => vi.restoreAllMocks())

  it('writes, reads, and clears by scope key', () => {
    writeSnapshot(snap())
    const read = readSnapshot('ws1::ds1::br1')
    expect(read?.changes).toHaveLength(1)
    clearSnapshot('ws1::ds1::br1')
    expect(readSnapshot('ws1::ds1::br1')).toBeNull()
  })

  it('markSnapshotCommitting flips phase in place', () => {
    writeSnapshot(snap())
    markSnapshotCommitting('ws1::ds1::br1')
    expect(readSnapshot('ws1::ds1::br1')?.phase).toBe('committing')
  })

  it('ignores a snapshot written under an older version', () => {
    localStorage.setItem(
      'synodic:staged-draft:ws1::ds1::br1',
      JSON.stringify(snap({ version: 0 })),
    )
    expect(readSnapshot('ws1::ds1::br1')).toBeNull()
  })

  it('treats corrupt JSON as absent', () => {
    localStorage.setItem('synodic:staged-draft:ws1::ds1::br1', '{not json')
    expect(readSnapshot('ws1::ds1::br1')).toBeNull()
  })
})
