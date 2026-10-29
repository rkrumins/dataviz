/**
 * A draft's members: the client reads, adds and removes them at the members routes, and a refusal
 * that names the role it needs on a shared draft arrives as a typed error carrying that role.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../fetchWithTimeout', () => ({ fetchWithTimeout: vi.fn() }))

import { fetchWithTimeout } from '../fetchWithTimeout'
import {
  addBranchMember, DraftRoleRequiredError, listBranchMembers, removeBranchMember,
} from '../versioningApiService'

const answer = (status: number, body: unknown) =>
  vi.mocked(fetchWithTimeout).mockResolvedValue(
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))

const call = () => vi.mocked(fetchWithTimeout).mock.calls[0] as [string, RequestInit | undefined]
const members = '/api/v1/ws1/versioning/graphs/g1/branches/br_1/members'

beforeEach(() => vi.mocked(fetchWithTimeout).mockReset())

describe('the members routes', () => {
  it('lists the members with the caller’s role', async () => {
    answer(200, { members: [{ subjectType: 'user', subjectId: 'bob', role: 'editor', name: 'Bob B' }], myRole: 'owner' })
    const res = await listBranchMembers('ws1', 'g1', 'br_1')
    expect(call()[0]).toBe(members)
    expect(call()[1]?.method ?? 'GET').toBe('GET')
    expect(res.myRole).toBe('owner')
    expect(res.members[0].name).toBe('Bob B')
  })

  it('adds a member with a POST of who and which role', async () => {
    answer(200, { subjectType: 'group', subjectId: 'grp_eng', role: 'maintainer' })
    await addBranchMember('ws1', 'g1', 'br_1', { subjectType: 'group', subjectId: 'grp_eng', role: 'maintainer' })
    expect(call()[0]).toBe(members)
    expect(call()[1]?.method).toBe('POST')
    expect(JSON.parse(String(call()[1]?.body))).toEqual({ subjectType: 'group', subjectId: 'grp_eng', role: 'maintainer' })
  })

  it('removes a member with a DELETE of its subject', async () => {
    answer(200, { removed: true })
    await removeBranchMember('ws1', 'g1', 'br_1', 'user', 'bob')
    expect(call()[0]).toBe(`${members}/user/bob`)
    expect(call()[1]?.method).toBe('DELETE')
  })
})

describe('a refusal on a shared draft', () => {
  it('names the role it needs', async () => {
    answer(403, { detail: { type: 'access_denied', code: 'not_owner_or_member', required: 'maintainer',
                            branchId: 'br_1', message: 'needs maintainer access to shared draft br_1' } })
    const err = await removeBranchMember('ws1', 'g1', 'br_1', 'user', 'bob').catch((e) => e)
    expect(err).toBeInstanceOf(DraftRoleRequiredError)
    expect(err.required).toBe('maintainer')
    expect(err.branchId).toBe('br_1')
  })

  it('carries the server’s words when someone cannot be added', async () => {
    answer(422, { detail: { type: 'ineligible_member', subjectId: 'viola', reason: 'no_manage',
                            message: 'viola can’t edit this workspace’s data sources' } })
    const err = await addBranchMember('ws1', 'g1', 'br_1', { subjectType: 'user', subjectId: 'viola', role: 'editor' })
      .catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(DraftRoleRequiredError)
    expect(err.message).toBe('viola can’t edit this workspace’s data sources')
  })
})
