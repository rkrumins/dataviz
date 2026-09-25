/**
 * POST /nodes/ancestor-chains runs in the 60s graph tier. On the 30s default
 * the browser gave up on work the server was about to finish, and asked again:
 * the client must outlast the tier, so the server's own answer always lands.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/fetchWithTimeout', () => ({
  fetchWithTimeout: vi.fn(),
}))

import { fetchWithTimeout } from '@/services/fetchWithTimeout'
import { TIMEOUTS } from '@/config/timeouts'
import { RemoteGraphProvider } from '../RemoteGraphProvider'

const mockFetch = vi.mocked(fetchWithTimeout)

/** HTTP_TIMEOUT_GRAPH_SECS, the tier around /api/v1/graph/ (main.py). */
const GRAPH_TIER_MS = 60_000

beforeEach(() => { mockFetch.mockReset() })

describe('RemoteGraphProvider.getAncestorChains', () => {
  it('outlasts the graph tier', async () => {
    mockFetch.mockResolvedValue({
      ok: true, status: 200, headers: { get: () => null },
      json: async () => ({ chains: { a: ['b'] } }),
    } as unknown as Response)
    const provider = new RemoteGraphProvider({ workspaceId: 'ws_ac', dataSourceId: 'ds_ac' })

    expect(await provider.getAncestorChains(['a'])).toEqual({ a: ['b'] })
    const [, init] = mockFetch.mock.calls[0]
    expect(init?.timeoutMs).toBe(TIMEOUTS.ANCESTOR_CHAINS_MS)
    expect(TIMEOUTS.ANCESTOR_CHAINS_MS).toBeGreaterThan(GRAPH_TIER_MS)
  })
})
