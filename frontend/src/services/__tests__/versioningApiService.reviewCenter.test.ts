/**
 * The Review Center's two reads go where the server answers them: the page to
 * /review-inbox, the counts to /review-inbox/counts, each named workspace as its
 * own `workspaceId`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../fetchWithTimeout', () => ({ fetchWithTimeout: vi.fn() }))

import { fetchWithTimeout } from '../fetchWithTimeout'
import { getReviewCenter, getReviewCenterCounts } from '../versioningApiService'

const answer = (body: unknown) => vi.mocked(fetchWithTimeout).mockResolvedValue(
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }))
const url = () => String(vi.mocked(fetchWithTimeout).mock.calls[0][0])

beforeEach(() => vi.mocked(fetchWithTimeout).mockReset())

describe('the Review Center routes', () => {
  it('reads the counts from /review-inbox/counts', async () => {
    answer({ counts: {}, unread: {}, capped: false, byWorkspace: {} })
    await getReviewCenterCounts()
    expect(url()).toBe('/api/v1/review-inbox/counts')
  })

  it('reads a page from /review-inbox with its queue, order and workspaces', async () => {
    answer({ counts: {}, unread: {}, capped: false, byWorkspace: {}, queue: 'open', items: [], total: 0 })
    await getReviewCenter({ queue: 'open', sort: 'created', limit: 25, offset: 0, workspaceIds: ['ws1', 'ws2'] })
    expect(url()).toBe('/api/v1/review-inbox?queue=open&sort=created&limit=25&offset=0&workspaceId=ws1&workspaceId=ws2')
  })
})
