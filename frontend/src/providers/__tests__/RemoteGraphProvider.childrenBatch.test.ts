/**
 * getChildrenBatch — the first pages of many containers in one request
 * (`POST /nodes/children-batch`).
 *
 * Against a server that predates the route (a deploy in progress), the POST
 * lands on GET /nodes/{urn} — 405 — or nowhere — 404. The provider then says
 * it has no batch (`null`) for the rest of the session, without asking again,
 * and the loader loads each container alone, as it did before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/fetchWithTimeout', () => ({
  fetchWithTimeout: vi.fn(),
}))

import { fetchWithTimeout } from '@/services/fetchWithTimeout'
import { classifyEndpoint } from '@/services/circuitBreaker'
import { isIdempotentGraphRead } from '@/services/graphRequestFailure'
import { RemoteGraphProvider } from '../RemoteGraphProvider'

const mockFetch = vi.mocked(fetchWithTimeout)

function reply(status: number, body: unknown, headers = new Headers()): Response {
  return {
    ok: status < 400,
    status,
    statusText: String(status),
    headers,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

const PAGE = { children: [], containmentEdges: [], lineageEdges: [], totalChildren: 0, hasMore: false, nextOffset: 0 }

beforeEach(() => { mockFetch.mockReset() })
afterEach(() => { vi.clearAllMocks() })

describe('RemoteGraphProvider.getChildrenBatch', () => {
  it('posts the parents and the page query, and answers each parent by urn', async () => {
    mockFetch.mockResolvedValueOnce(reply(200, { results: { a: PAGE, b: PAGE } }))
    const provider = new RemoteGraphProvider({ workspaceId: 'ws', dataSourceId: 'ds' })
    const got = await provider.getChildrenBatch([{ urn: 'a', offset: 0 }, { urn: 'b', offset: 100 }], {
      edgeTypes: ['CONTAINS'], limit: 100, lineageScope: 'siblings', sortDirection: 'desc', includeLineageEdges: true,
    })
    expect(got).toEqual({ a: PAGE, b: PAGE })
    const [url, init] = mockFetch.mock.calls[0]
    expect(new URL(String(url), 'http://x').pathname).toBe('/api/v1/ws/graph/nodes/children-batch')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({
      parents: [{ urn: 'a', offset: 0 }, { urn: 'b', offset: 100 }],
      edgeTypes: ['CONTAINS'], limit: 100, lineageScope: 'siblings', sortDirection: 'desc', includeLineageEdges: true,
    })
  })

  it.each([405, 404])('against a server without the route (%i): no batch, and not asked again', async (status) => {
    mockFetch.mockResolvedValueOnce(reply(status, { detail: 'Method Not Allowed' }))
    const provider = new RemoteGraphProvider({ workspaceId: 'ws', dataSourceId: 'ds' })
    expect(await provider.getChildrenBatch([{ urn: 'a' }])).toBeNull()
    expect(await provider.getChildrenBatch([{ urn: 'b' }])).toBeNull()
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('is retried in place when the backend sheds it (429), like every read', async () => {
    mockFetch
      .mockResolvedValueOnce(reply(429, { detail: { code: 'PROVIDER_BUSY' } }, new Headers({ 'Retry-After': '0' })))
      .mockResolvedValueOnce(reply(200, { results: { a: PAGE } }))
    const provider = new RemoteGraphProvider({ workspaceId: 'ws', dataSourceId: 'ds' })
    expect(await provider.getChildrenBatch([{ urn: 'a' }])).toEqual({ a: PAGE })
    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(isIdempotentGraphRead('POST', '/api/v1/ws/graph/nodes/children-batch')).toBe(true)
  })

  it('does not hide a real failure behind the fallback', async () => {
    mockFetch.mockResolvedValue(reply(500, { detail: 'boom' }))
    const provider = new RemoteGraphProvider({ workspaceId: 'ws', dataSourceId: 'ds' })
    await expect(provider.getChildrenBatch([{ urn: 'a' }])).rejects.toBeTruthy()
  })

  it('fails as a children page does: the same breaker', () => {
    expect(classifyEndpoint('/api/v1/ws/graph/nodes/children-batch')).toBe(classifyEndpoint('/api/v1/ws/graph/nodes/a/children-with-edges'))
  })
})
