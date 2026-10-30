import { describe, it, expect } from 'vitest'
import type { Branch } from '@/services/versioningApiService'
import { groupDrafts } from '../draftGroups'

const d = (branchId: string, over: Partial<Branch> = {}) => ({ branchId, owner: 'ana', ...over }) as Branch

describe('groupDrafts', () => {
  it('lists the caller’s own drafts, then those shared with them, then the public ones', () => {
    const groups = groupDrafts([
      d('pub', { owner: 'bob', visibility: 'public' }),
      d('mine', { visibility: 'private' }),
      d('member', { owner: 'bob', visibility: 'private', myRole: 'editor' }),
      d('pub-member', { owner: 'bob', visibility: 'public', myRole: 'maintainer' }),
      d('review', { owner: 'bob', visibility: 'private' }),          // read through its review
      d('mine-public', { visibility: 'public' }),
    ], 'ana')
    expect(groups.map((g) => [g.label, g.drafts.map((b) => b.branchId)])).toEqual([
      ['Your drafts', ['mine', 'mine-public']],
      ['Shared with you', ['member', 'pub-member', 'review']],
      ['Public drafts', ['pub']],
    ])
  })

  it('leaves out a group with nothing in it', () => {
    expect(groupDrafts([d('mine')], 'ana').map((g) => g.key)).toEqual(['mine'])
    expect(groupDrafts([], 'ana')).toEqual([])
  })
})
