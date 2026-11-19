import { afterEach, describe, expect, it } from 'vitest'

import type { MembershipResult } from '@/types/membership'

import { specFor } from '../model'
import { useNarrowStore } from '../narrowStore'

const RESULT: MembershipResult = {
  specHash: 'h',
  members: [{ urn: 'col', via: 'seed' }],
  wholeSubtree: [],
  chains: { col: ['tbl'] },
  counts: { seeds: 1, inside: 0, upstream: 0, downstream: 0, partnerInside: 0, total: 1 },
  missingSeeds: 0, truncated: [], dataVersion: '', elapsedMs: 0,
}
const DRAFT = { spec: specFor({ urns: ['col'] }), seedsLabel: 'col' }

describe('narrowStore', () => {
  afterEach(() => useNarrowStore.getState().clear())

  it('applying works out what the canvas draws, once, and closes the composer', () => {
    useNarrowStore.getState().openComposer('v1', DRAFT)
    useNarrowStore.getState().apply('v1', DRAFT, RESULT)
    const s = useNarrowStore.getState()
    expect(s.composer).toBeNull()
    expect(s.applied?.visibility.byUrn.has('col')).toBe(true)
    expect(s.applied?.visibility.ancestors.get('tbl')).toBe(1)
  })

  it('a narrowing never follows the reader into another view', () => {
    useNarrowStore.getState().apply('v1', DRAFT, RESULT)
    useNarrowStore.getState().openComposer('v2', DRAFT)
    expect(useNarrowStore.getState().applied).toBeNull()
    expect(useNarrowStore.getState().viewId).toBe('v2')
  })

  it('Show everything puts it away', () => {
    useNarrowStore.getState().apply('v1', DRAFT, RESULT)
    useNarrowStore.getState().clear()
    expect(useNarrowStore.getState().applied).toBeNull()
  })
})

describe('narrowStore — saved with the view', () => {
  it('marks the narrowing on screen as saved, and never another one', () => {
    const result = { specHash: 'h1', members: [], wholeSubtree: [], chains: {}, missingSeeds: 0, truncated: [], dataVersion: '', elapsedMs: 0,
      counts: { seeds: 1, inside: 0, upstream: 0, downstream: 0, partnerInside: 0, total: 1 } }
    useNarrowStore.getState().apply('v1', { spec: specFor({ urns: ['a'] }), seedsLabel: 'a' }, result)
    useNarrowStore.getState().markSaved({ id: 'n1', name: 'A', savedAt: null }, 'other-spec')
    expect(useNarrowStore.getState().applied?.saved).toBeUndefined()
    useNarrowStore.getState().markSaved({ id: 'n1', name: 'A', savedAt: null }, 'h1')
    expect(useNarrowStore.getState().applied?.saved).toEqual({ id: 'n1', name: 'A', savedAt: null })
    useNarrowStore.getState().apply('v1', { spec: specFor({ urns: ['b'] }), seedsLabel: 'b' }, { ...result, specHash: 'h2' })
    expect(useNarrowStore.getState().applied?.saved).toBeUndefined()
  })
})
