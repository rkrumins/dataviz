/**
 * POST /trace/expand-batch hands back the pairs the server says it could
 * not expand, when it says so, and reads nothing into an answer that does
 * not.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/fetchWithTimeout', () => ({
  fetchWithTimeout: vi.fn(),
}))

import { fetchWithTimeout } from '@/services/fetchWithTimeout'
import { RemoteGraphProvider } from '../RemoteGraphProvider'

const mockFetch = vi.mocked(fetchWithTimeout)

const answering = (extra: Record<string, unknown>) => mockFetch.mockResolvedValue({
  ok: true, status: 200, headers: { get: () => null },
  json: async () => ({
    nodes: [], edges: [], containmentEdges: [], upstreamUrns: [], downstreamUrns: [],
    focus: { urn: 'a' }, effectiveLevel: 1, truncated: false, ...extra,
  }),
} as unknown as Response)

const REQUEST = { pairs: [{ sourceUrn: 'a', targetUrn: 'b', nextLevel: 1 }], lineageEdgeTypes: null, includeContainmentEdges: true }

beforeEach(() => mockFetch.mockReset())

describe('RemoteGraphProvider.expandAggregatedBatch', () => {
  it('reads the well-formed pairs the server could not expand', async () => {
    answering({ pairErrors: [{ sourceUrn: 'a', targetUrn: 'b', retryable: true }, { sourceUrn: 'a' }, 'nonsense'] })
    const provider = new RemoteGraphProvider({ workspaceId: 'ws_eb', dataSourceId: 'ds_eb' })
    expect((await provider.expandAggregatedBatch(REQUEST)).pairErrors)
      .toEqual([{ sourceUrn: 'a', targetUrn: 'b', retryable: true }])
  })

  it('says nothing of pairs when the server does not', async () => {
    answering({})
    const provider = new RemoteGraphProvider({ workspaceId: 'ws_eb2', dataSourceId: 'ds_eb2' })
    expect((await provider.expandAggregatedBatch(REQUEST)).pairErrors).toBeUndefined()
  })
})
