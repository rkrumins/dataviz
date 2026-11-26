/**
 * getUnplacedTopLevel — the top-level entities of some types a view doesn't place
 * (`POST /nodes/top-level/unplaced`). A view's health check asks it once per load, on the
 * branch the canvas reads: a draft's provider asks the draft.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/fetchWithTimeout', () => ({
  fetchWithTimeout: vi.fn(),
}))

import { fetchWithTimeout } from '@/services/fetchWithTimeout'
import { isIdempotentGraphRead } from '@/services/graphRequestFailure'
import { RemoteGraphProvider } from '../RemoteGraphProvider'

const mockFetch = vi.mocked(fetchWithTimeout)
const ANSWER = { nodes: [], byType: { domain: 3 }, totalCount: 3, complete: true }

function reply(body: unknown): Response {
  return {
    ok: true, status: 200, statusText: '200', headers: new Headers(),
    json: async () => body, text: async () => JSON.stringify(body),
  } as unknown as Response
}

beforeEach(() => { mockFetch.mockReset() })
afterEach(() => { vi.clearAllMocks() })

describe('RemoteGraphProvider.getUnplacedTopLevel', () => {
  it('posts the types and the placed urns, and answers what the server counted', async () => {
    mockFetch.mockResolvedValueOnce(reply(ANSWER))
    const provider = new RemoteGraphProvider({ workspaceId: 'ws', dataSourceId: 'ds' })
    const got = await provider.getUnplacedTopLevel({ entityTypes: ['domain'], placedUrns: ['urn:a'], limit: 200 })
    expect(got).toEqual(ANSWER)
    const [url, init] = mockFetch.mock.calls[0]
    const asked = new URL(String(url), 'http://x')
    expect(asked.pathname).toBe('/api/v1/ws/graph/nodes/top-level/unplaced')
    expect(asked.searchParams.get('branchId')).toBeNull()
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({ entityTypes: ['domain'], placedUrns: ['urn:a'], limit: 200 })
  })

  it('on a draft, asks the draft', async () => {
    mockFetch.mockResolvedValueOnce(reply(ANSWER))
    const provider = new RemoteGraphProvider({ workspaceId: 'ws', dataSourceId: 'ds', branchId: 'br_1' })
    await provider.getUnplacedTopLevel({ entityTypes: ['domain'], placedUrns: [] })
    expect(new URL(String(mockFetch.mock.calls[0][0]), 'http://x').searchParams.get('branchId')).toBe('br_1')
  })

  it('is a read: safe to replay', () => {
    expect(isIdempotentGraphRead('POST', '/api/v1/ws/graph/nodes/top-level/unplaced?branchId=br_1')).toBe(true)
  })
})
