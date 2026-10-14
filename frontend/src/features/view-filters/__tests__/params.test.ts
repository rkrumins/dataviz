/**
 * Every view request — the list, the stats bar, the counts — is built here, so
 * this is where "the same filters" is decided.
 */
import { describe, expect, it } from 'vitest'
import { resolveFilters, toQueryParams } from '../params'
import { EMPTY_FILTERS, ME } from '../model'

const CTX = { currentUserId: 'u_me', today: '2026-10-12' }

describe('resolveFilters', () => {
  it('turns "me" into the signed-in person, once', () => {
    const r = resolveFilters({ ...EMPTY_FILTERS, contributorIds: [ME, 'u2', 'u_me'] }, CTX)
    expect(r.contributorIds).toEqual(['u_me', 'u2'])
  })

  it('matches nobody for "me" when nobody is signed in, rather than everyone', () => {
    const r = resolveFilters({ ...EMPTY_FILTERS, contributorIds: [ME] }, { ...CTX, currentUserId: null })
    expect(r.contributorIds).toEqual(['__no_user__'])
  })

  it('turns date rules into instants', () => {
    const r = resolveFilters({ ...EMPTY_FILTERS, created: 'today', updated: '..2026-09-30' }, CTX)
    expect(r.createdAfter).toBe(new Date(2026, 9, 12).toISOString())
    expect(r.createdBefore).toBe(new Date(2026, 9, 13).toISOString())
    expect(r.updatedAfter).toBeNull()
    expect(r.updatedBefore).toBe(new Date(2026, 9, 1).toISOString())
  })

  it('pins a scoped surface to its workspace whatever the state says', () => {
    const r = resolveFilters({ ...EMPTY_FILTERS, workspaceIds: ['other'] }, { ...CTX, scopeWorkspaceId: 'ws_1' })
    expect(r.workspaceIds).toEqual(['ws_1'])
  })
})

describe('toQueryParams', () => {
  it('sends nothing for an empty filter set', () => {
    const p = toQueryParams(resolveFilters(EMPTY_FILTERS, CTX))
    expect(Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined))).toEqual({})
  })

  it('maps the new filters onto their params', () => {
    const p = toQueryParams(resolveFilters({
      ...EMPTY_FILTERS, sourceKind: 'external', contributorIds: ['u2'], contributorRole: 'created',
    }, CTX))
    expect(p).toMatchObject({ sourceKind: 'external', contributorIn: ['u2'], contributorRole: 'created' })
  })

  it('intersects Recent with a created rule: the later lower bound wins', () => {
    const narrow = toQueryParams(resolveFilters({ ...EMPTY_FILTERS, category: 'recently-added', created: 'today' }, CTX))
    expect(narrow.createdAfter).toBe(new Date(2026, 9, 12).toISOString())

    const wide = toQueryParams(resolveFilters({ ...EMPTY_FILTERS, category: 'recently-added', created: 'this-year' }, CTX))
    // This year starts long before Recent's 7 days, so Recent's cutoff stands.
    expect(wide.createdAfter! > new Date(2026, 0, 1).toISOString()).toBe(true)
  })
})
