/**
 * getTopLevelNodes({ orphansOnly }) — the power-user orphans list.
 *
 * The flag goes on the wire only when true, so every default request (and the
 * server's cache key for it) stays exactly as it was.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/fetchWithTimeout', () => ({
  fetchWithTimeout: vi.fn(),
}))

import { fetchWithTimeout } from '@/services/fetchWithTimeout'
import { RemoteGraphProvider } from '../RemoteGraphProvider'

const mockFetch = vi.mocked(fetchWithTimeout)

const page = { nodes: [], totalCount: 0, hasMore: false, nextCursor: null, rootTypeCount: 0, orphanCount: 0 }

function reply(): Response {
  return {
    ok: true,
    status: 200,
    statusText: '200',
    headers: new Headers(),
    json: async () => page,
    text: async () => JSON.stringify(page),
  } as unknown as Response
}

const params = () => new URL(String(mockFetch.mock.calls[0][0]), 'http://x').searchParams

beforeEach(() => { mockFetch.mockReset(); mockFetch.mockResolvedValue(reply()) })
afterEach(() => { vi.clearAllMocks() })

describe('RemoteGraphProvider.getTopLevelNodes orphansOnly', () => {
  it('sends orphansOnly=true when asked, alongside the type filter', async () => {
    const provider = new RemoteGraphProvider({ workspaceId: 'ws', dataSourceId: 'ds' })
    await provider.getTopLevelNodes({ orphansOnly: true, entityTypes: ['Table'], limit: 50 })
    expect(String(mockFetch.mock.calls[0][0])).toContain('/nodes/top-level')
    expect(params().get('orphansOnly')).toBe('true')
    expect(params().getAll('entityTypes')).toEqual(['Table'])
  })

  it.each([undefined, false])('leaves it out when orphansOnly is %s', async (orphansOnly) => {
    const provider = new RemoteGraphProvider({ workspaceId: 'ws', dataSourceId: 'ds' })
    await provider.getTopLevelNodes({ orphansOnly, limit: 50 })
    expect(params().has('orphansOnly')).toBe(false)
  })
})
