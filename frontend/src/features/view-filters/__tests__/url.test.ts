/**
 * The address is what people bookmark and send, and now what saved filters store.
 * Old links must keep their meaning, filter writes must not disturb the rest of
 * the address, and two spellings of one list must compare equal.
 */
import { describe, expect, it } from 'vitest'
import { canonicalFilterQuery, readFilterState, writeFilterState } from '../url'
import { EMPTY_FILTERS } from '../model'

describe('readFilterState', () => {
  it('reads every filter', () => {
    const s = readFilterState(new URLSearchParams(
      'q=sales&category=recently-added&visibility=private&workspace=w1&workspace=w2&dataSource=d1'
      + '&type=graph&tag=pii&contributor=me&contributor=u2&contributorRole=edited'
      + '&sourceKind=versioned&created=this-year&updated=7d',
    ))
    expect(s).toEqual({
      search: 'sales', category: 'recently-added', visibility: 'private',
      workspaceIds: ['w1', 'w2'], dataSourceId: 'd1', viewTypes: ['graph'], tags: ['pii'],
      contributorIds: ['me', 'u2'], contributorRole: 'edited', sourceKind: 'versioned',
      created: 'this-year', updated: '7d',
    })
  })

  it('keeps an old creator= link meaning "created by"', () => {
    const s = readFilterState(new URLSearchParams('creator=u1&creator=u2'))
    expect(s.contributorIds).toEqual(['u1', 'u2'])
    expect(s.contributorRole).toBe('created')
  })

  it('drops values it doesn\'t understand instead of failing the page', () => {
    const s = readFilterState(new URLSearchParams('sourceKind=maybe&contributorRole=boss&created=soon&updated=0d'))
    expect(s.sourceKind).toBeNull()
    expect(s.contributorRole).toBeNull()
    expect(s.created).toBeNull()
    expect(s.updated).toBeNull()
  })
})

describe('writeFilterState', () => {
  it('replaces filter keys and keeps sort, layout and anything else', () => {
    const prev = new URLSearchParams('sort=az&layout=list&creator=u1&tag=old&utm=x')
    const next = writeFilterState(prev, { ...EMPTY_FILTERS, tags: ['new'], sourceKind: 'external' })
    expect(next.get('sort')).toBe('az')
    expect(next.get('layout')).toBe('list')
    expect(next.get('utm')).toBe('x')
    expect(next.getAll('tag')).toEqual(['new'])
    expect(next.get('sourceKind')).toBe('external')
    // The legacy spelling goes once the filter is rewritten.
    expect(next.has('creator')).toBe(false)
  })

  it('round-trips through readFilterState', () => {
    const state = {
      ...EMPTY_FILTERS, search: 'x', contributorIds: ['me'], contributorRole: 'published' as const,
      created: '2026-09-01..2026-09-15', updated: 'today',
    }
    expect(readFilterState(writeFilterState(new URLSearchParams(), state))).toEqual(state)
  })
})

describe('canonicalFilterQuery', () => {
  it('gives two spellings of the same list the same query', () => {
    const a = canonicalFilterQuery({ ...EMPTY_FILTERS, tags: ['b', 'a'], workspaceIds: ['w'] })
    const b = canonicalFilterQuery({ ...EMPTY_FILTERS, workspaceIds: ['w'], tags: ['a', 'b'] })
    expect(a).toBe(b)
  })

  it('ignores a role with nobody picked — it filters nothing', () => {
    expect(canonicalFilterQuery({ ...EMPTY_FILTERS, contributorRole: 'edited' }))
      .toBe(canonicalFilterQuery(EMPTY_FILTERS))
  })

  it('carries the sort when given', () => {
    expect(canonicalFilterQuery(EMPTY_FILTERS, { sort: 'newest' })).toBe('sort=newest')
  })
})
