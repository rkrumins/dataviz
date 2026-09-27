import { describe, it, expect } from 'vitest'

import type { PropertyOpJob, PropertyOpList } from '@/services/versioningApiService'
import type { Predicate } from '@/types/search'

import { canUndo, isLive, opLabel, opOutcome, opsOverlay, withPrecondition } from '../propertyOps'

function job(partial: Partial<PropertyOpJob> & { jobId: string }): PropertyOpJob {
  return {
    kind: 'apply', undoOf: null, undoneBy: null, status: 'completed', phase: null,
    cancelRequested: false, graphId: 'g1', branchId: 'br1', viewId: 'v1', actor: 'alice',
    op: { kind: 'set', key: 'owner', value: 'alice' }, predicate: null, expectedCount: null,
    processed: 0, total: 0, percent: 100, summary: { applied: 3, commits: ['c1'] }, error: null,
    createdAt: '', startedAt: null, completedAt: null,
    ...partial,
  }
}

const list = (...ops: PropertyOpJob[]): PropertyOpList => ({ ops, draftChanges: 0, maxDraftChanges: 100_000 })

const FINANCE = { kind: 'property', key: 'owner', op: 'contains', value: 'finance' } as Predicate

describe('withPrecondition', () => {
  it('narrows a fill to the empty key and a rename or remove to the present one', () => {
    expect(withPrecondition({ kind: 'fillEmpty', key: 'tier' }, FINANCE)).toEqual({
      kind: 'group', op: 'and', children: [FINANCE, { kind: 'property', key: 'tier', op: 'isEmpty' }],
    })
    for (const kind of ['rename', 'remove'] as const) {
      expect(withPrecondition({ kind, key: 'tier' }, FINANCE)).toEqual({
        kind: 'group', op: 'and', children: [FINANCE, { kind: 'hasProperty', key: 'tier', negate: false }],
      })
    }
  })

  it('leaves a set as its search: it can change any match', () => {
    expect(withPrecondition({ kind: 'set', key: 'tier' }, FINANCE)).toBeNull()
  })
})

describe('opLabel', () => {
  it('names an operation as its commits do, a 64-bit integer exact', () => {
    expect(opLabel({ kind: 'set', key: 'reviewed', value: true })).toBe('Set reviewed = true')
    expect(opLabel({ kind: 'set', key: 'gvId', value: '9223372036854775807' })).toBe('Set gvId = 9223372036854775807')
    expect(opLabel({ kind: 'fillEmpty', key: 'owner', value: 'erin' })).toBe('Fill empty owner with erin')
    expect(opLabel({ kind: 'rename', key: 'owner', newKey: 'steward' })).toBe('Rename owner to steward')
    expect(opLabel({ kind: 'remove', key: 'owner' })).toBe('Remove owner')
    expect(opLabel({ kind: 'set', key: 'notes', value: 'x'.repeat(200) })).toHaveLength('Set notes = '.length + 80)
  })
})

describe('opOutcome', () => {
  it('says what an operation did, leaving out what didn\'t happen', () => {
    expect(opOutcome(job({ jobId: 'a', summary: { applied: 12, unchanged: 1, notInDraft: 0 } })))
      .toBe('12 entities changed · 1 already so')
    expect(opOutcome(job({ jobId: 'a', summary: { applied: 1, skipped: { targetExists: 2, ontology: 1 } } })))
      .toBe('1 entity changed · 2 skipped: the new name has a value · 1 skipped: the ontology refused it')
  })

  it('says what an undo put back and what it left', () => {
    expect(opOutcome(job({ jobId: 'u', kind: 'undo', summary: { restored: 11, changedSince: 1, missing: 1 } })))
      .toBe('11 entities put back · 1 edited since, left as it is · 1 no longer in the draft')
  })
})

describe('standing operations', () => {
  const applied = job({ jobId: 'a', op: { kind: 'rename', key: 'owner', newKey: 'steward' } })
  const set = job({ jobId: 's', op: { kind: 'set', key: 'tier', value: 'gold' } })
  const nothing = job({ jobId: 'n', summary: { applied: 0, commits: [] } })

  it('badges each key a standing operation changed', () => {
    const overlay = opsOverlay(list(set, applied, nothing))
    expect([...overlay.keys()].sort()).toEqual(['owner', 'tier'])
    expect(overlay.get('owner')).toMatchObject({ renameTo: 'steward' })
    expect(overlay.get('tier')).toMatchObject({ value: 'gold' })
    expect(overlay.get('tier')!.kinds.has('set')).toBe(true)
  })

  it('drops an operation once it is undone, and keeps it while its undo failed', () => {
    const undone = { ...applied, undoneBy: 'u' }
    expect(opsOverlay(list(job({ jobId: 'u', kind: 'undo', status: 'completed' }), undone)).has('owner')).toBe(false)
    expect(opsOverlay(list(job({ jobId: 'u', kind: 'undo', status: 'failed' }), undone)).has('owner')).toBe(true)
  })

  it('offers an undo for what wrote something, never beside a live operation', () => {
    expect(canUndo(applied, list(applied))).toBe(true)
    expect(canUndo(nothing, list(nothing))).toBe(false)
    const running = job({ jobId: 'r', status: 'running' })
    expect(isLive(running)).toBe(true)
    expect(canUndo(applied, list(running, applied))).toBe(false)
    expect(canUndo(job({ jobId: 'u', kind: 'undo' }), list())).toBe(false)
  })
})
