/**
 * An approval names the draft head the reviewer saw, and the server's "the draft moved on since"
 * arrives as a typed error carrying the head it is at now.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../fetchWithTimeout', () => ({ fetchWithTimeout: vi.fn() }))

import { fetchWithTimeout } from '../fetchWithTimeout'
import { approveMergeRequest, HeadMovedError } from '../versioningApiService'

const answer = (status: number, body: unknown) =>
  vi.mocked(fetchWithTimeout).mockResolvedValue(
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))

const call = () => vi.mocked(fetchWithTimeout).mock.calls[0] as [string, RequestInit | undefined]

beforeEach(() => vi.mocked(fetchWithTimeout).mockReset())

describe('approving a merge request', () => {
  it('sends the head the reviewer saw', async () => {
    answer(200, { prId: 'pr_1', approvalStatus: 'approved' })
    await approveMergeRequest('ws1', 'pr_1', 'cmt_seen')
    expect(call()[0]).toBe('/api/v1/ws1/versioning/merge-requests/pr_1/approve')
    expect(JSON.parse(String(call()[1]?.body))).toEqual({ expectedHeadCommitId: 'cmt_seen' })
  })

  it('raises HeadMovedError when the draft moved on', async () => {
    answer(409, { detail: { type: 'head_moved', prId: 'pr_1', headCommitId: 'cmt_now',
                            message: 'pr pr_1 has changed since it was reviewed' } })
    const err = await approveMergeRequest('ws1', 'pr_1', 'cmt_seen').catch((e) => e)
    expect(err).toBeInstanceOf(HeadMovedError)
    expect(err.headCommitId).toBe('cmt_now')
    expect(err.message).toMatch(/changed since you loaded it/)
  })
})
