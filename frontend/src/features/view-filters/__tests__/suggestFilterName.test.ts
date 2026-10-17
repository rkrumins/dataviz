/**
 * A saved filter is named from what it filters, so the name has to read as a
 * phrase and say every part of it, in the order the filters appear.
 */
import { describe, expect, it } from 'vitest'
import { suggestFilterName, type FilterLookups } from '../dimensions'
import { EMPTY_FILTERS, ME } from '../model'

const LOOKUPS: FilterLookups = {
  today: '2026-10-12',
  workspaceName: id => ({ ws_fin: 'Finance' } as Record<string, string>)[id],
  dataSourceName: () => undefined,
  personName: id => ({ u_ada: 'Ada Lovelace' } as Record<string, string>)[id],
  viewTypeLabel: t => t,
}

describe('suggestFilterName', () => {
  it('names every part, periods mid-sentence', () => {
    const state = { ...EMPTY_FILTERS, sourceKind: 'external' as const, updated: '30d', contributorIds: ['u_ada'] }
    expect(suggestFilterName(state, LOOKUPS)).toBe('External · Updated past 30 days · By Ada Lovelace')
  })

  it('says the role, and "you" for yourself', () => {
    const state = { ...EMPTY_FILTERS, contributorIds: [ME], contributorRole: 'edited' as const, created: '2026-09' }
    expect(suggestFilterName(state, LOOKUPS)).toMatch(/^Created September 2026 · Edited by you$/)
  })

  it('keeps a pill short', () => {
    const state = { ...EMPTY_FILTERS, tags: ['a-very-long-tag-name', 'another-long-tag', 'and-a-third-one', 'fourth'] }
    expect(suggestFilterName(state, LOOKUPS).length).toBeLessThanOrEqual(60)
  })
})
