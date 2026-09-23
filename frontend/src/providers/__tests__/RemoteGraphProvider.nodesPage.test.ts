/**
 * getNodesPage — one page of a node query plus where the next page starts.
 *
 * Against a server that predates /nodes/page (a deploy in progress), the POST
 * lands on GET /nodes/{urn} — 405 — or nowhere — 404. The canvas must degrade
 * to paging by counting, as it did before, rather than fail to open.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/fetchWithTimeout', () => ({
  fetchWithTimeout: vi.fn(),
}))

import { fetchWithTimeout } from '@/services/fetchWithTimeout'
import { RemoteGraphProvider } from '../RemoteGraphProvider'

const mockFetch = vi.mocked(fetchWithTimeout)

function reply(status: number, body: unknown): Response {
  return {
    ok: status < 400,
    status,
    statusText: String(status),
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

const nodes = (n: number) => Array.from({ length: n }, (_, i) => ({ urn: `u${i}`, entityType: 't', displayName: `n${i}` }))

beforeEach(() => { mockFetch.mockReset() })
afterEach(() => { vi.clearAllMocks() })

describe('RemoteGraphProvider.getNodesPage', () => {
  it("returns the server's page and position", async () => {
    mockFetch.mockResolvedValueOnce(reply(200, { nodes: nodes(2), hasMore: true, nextOffset: 7 }))
    const provider = new RemoteGraphProvider({ workspaceId: 'ws', dataSourceId: 'ds' })
    const page = await provider.getNodesPage({ entityTypes: ['t'], limit: 2, offset: 5 })
    expect(page).toEqual({ nodes: nodes(2), hasMore: true, nextOffset: 7 })
    expect(String(mockFetch.mock.calls[0][0])).toContain('/nodes/page')
  })

  it.each([405, 404])('falls back to paging by counting against a server without it (%i)', async (status) => {
    mockFetch
      .mockResolvedValueOnce(reply(status, { detail: 'Method Not Allowed' }))
      .mockResolvedValueOnce(reply(200, nodes(2)))
    const provider = new RemoteGraphProvider({ workspaceId: 'ws', dataSourceId: 'ds' })
    const page = await provider.getNodesPage({ entityTypes: ['t'], limit: 2, offset: 4 })
    expect(String(mockFetch.mock.calls[1][0])).toContain('/nodes/query')
    expect(page).toEqual({ nodes: nodes(2), hasMore: true, nextOffset: 6 })
  })

  it('is retried in place when the backend sheds it (429), like every read', async () => {
    // Every open-view type page and the Hierarchy roots go through it: one shed
    // page must not fail the view's load.
    const busy = { ...reply(429, { detail: { code: 'PROVIDER_BUSY' } }), headers: new Headers({ 'Retry-After': '0' }) } as Response
    mockFetch
      .mockResolvedValueOnce(busy)
      .mockResolvedValueOnce(reply(200, { nodes: nodes(1), hasMore: false, nextOffset: 1 }))
    const provider = new RemoteGraphProvider({ workspaceId: 'ws', dataSourceId: 'ds' })
    const page = await provider.getNodesPage({ entityTypes: ['t'], limit: 1 })
    expect(page.nextOffset).toBe(1)
    expect(mockFetch.mock.calls.filter(c => String(c[0]).includes('/nodes/page'))).toHaveLength(2)
  })

  it('does not hide a real failure behind the fallback', async () => {
    mockFetch.mockResolvedValue(reply(500, { detail: 'boom' }))
    const provider = new RemoteGraphProvider({ workspaceId: 'ws', dataSourceId: 'ds' })
    await expect(provider.getNodesPage({ entityTypes: ['t'], limit: 2 })).rejects.toBeTruthy()
    expect(mockFetch.mock.calls.every(c => String(c[0]).includes('/nodes/page'))).toBe(true)
  })
})
