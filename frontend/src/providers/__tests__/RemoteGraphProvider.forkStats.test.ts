/**
 * A fork's data source keeps no stats (they would count its parent's graph too): its stats read
 * answers `status: "unavailable"` with `missing_fields: ["not_available_for_a_fork"]`, and nothing
 * will ever fill it. That is not a cache miss or a backend error, so `getStats()` answers null
 * instead of throwing, and the provider probes (GraphProviderContext, ViewExecutionContext) count
 * a view on a fork as reachable. Any other envelope without data still throws.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/fetchWithTimeout', () => ({
  fetchWithTimeout: vi.fn(),
}))

import { fetchWithTimeout } from '@/services/fetchWithTimeout'
import { RemoteGraphProvider } from '../RemoteGraphProvider'

const mockFetch = vi.mocked(fetchWithTimeout)

function envelope(status: string, missingFields: string[]): Response {
  const body = {
    data: null,
    meta: {
      status, source: 'none', age_seconds: null, ttl_seconds: null,
      missing_fields: missingFields, data_source_id: 'dsfork_1',
      stats_service_status: 'unknown', provider_health: 'unknown', refreshing: false,
    },
  }
  return new Response(JSON.stringify(body), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  })
}

beforeEach(() => {
  mockFetch.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('RemoteGraphProvider.getStats on a fork', () => {
  it('answers null: a fork keeps no stats, and that is not a failure', async () => {
    mockFetch.mockResolvedValue(envelope('unavailable', ['not_available_for_a_fork']))
    const provider = new RemoteGraphProvider({ workspaceId: 'ws_1', dataSourceId: 'dsfork_1' })
    await expect(provider.getStats()).resolves.toBeNull()
  })

  it('still throws on a cache miss, which a poll will fill', async () => {
    mockFetch.mockResolvedValue(envelope('computing', []))
    const provider = new RemoteGraphProvider({ workspaceId: 'ws_1', dataSourceId: 'ds_1' })
    await expect(provider.getStats()).rejects.toThrow('Stats unavailable')
  })
})
