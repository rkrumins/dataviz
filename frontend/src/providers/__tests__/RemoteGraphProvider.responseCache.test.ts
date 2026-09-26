/**
 * The GET response cache is BOUNDED. Its entries live 2–60 s, but the map
 * used to keep every response it was given — a read skipped a stale entry,
 * nothing removed it — so a session spent expanding and scrolling held every
 * children page it had ever fetched for the life of the tab.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/fetchWithTimeout', () => ({
  fetchWithTimeout: vi.fn(),
}))

import { fetchWithTimeout } from '@/services/fetchWithTimeout'
import { RemoteGraphProvider } from '../RemoteGraphProvider'

const mockFetch = vi.mocked(fetchWithTimeout)

beforeEach(() => {
  mockFetch.mockReset()
  mockFetch.mockImplementation(async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ page: 'x'.repeat(64) }), text: async () => JSON.stringify({ page: 'x'.repeat(64) }) }) as unknown as Response)
})

afterEach(() => {
  vi.clearAllMocks()
})

const get = (p: RemoteGraphProvider, path: string) =>
  (p as unknown as { fetch: (path: string) => Promise<unknown> }).fetch(path)

describe('RemoteGraphProvider response cache', () => {
  it('never holds more than its ceiling, however many pages a session fetches', async () => {
    const provider = new RemoteGraphProvider({ workspaceId: 'ws_1', dataSourceId: 'ds_1' })
    for (let i = 0; i < RemoteGraphProvider.RESPONSE_CACHE_MAX + 150; i++) await get(provider, `/nodes/page-${i}`)
    expect(provider.cachedResponseCount).toBeLessThanOrEqual(RemoteGraphProvider.RESPONSE_CACHE_MAX)
  })

  it('still answers a repeat read from the cache', async () => {
    const provider = new RemoteGraphProvider({ workspaceId: 'ws_1', dataSourceId: 'ds_1' })
    await get(provider, '/nodes/same')
    await get(provider, '/nodes/same')
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('"Free memory" drops every cached response; the next read asks the server', async () => {
    const provider = new RemoteGraphProvider({ workspaceId: 'ws_1', dataSourceId: 'ds_1' })
    await get(provider, '/nodes/same')
    provider.releaseCaches()
    expect(provider.cachedResponseCount).toBe(0)
    await get(provider, '/nodes/same')
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })
})
