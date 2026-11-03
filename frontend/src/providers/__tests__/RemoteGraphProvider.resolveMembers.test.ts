/**
 * POST /members — a narrowing resolved on the server, read in a view: the view
 * travels as `viewId` (the scope is read in it, and a share link's access is
 * checked against it), with the source and draft every graph read carries. A
 * resolution walks lineage, so it is budgeted and isolated like a trace.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/fetchWithTimeout', () => ({
  fetchWithTimeout: vi.fn(),
}))

import { fetchWithTimeout } from '@/services/fetchWithTimeout'
import { TIMEOUTS } from '@/config/timeouts'
import { classifyEndpoint } from '@/services/circuitBreaker'
import { RemoteGraphProvider } from '../RemoteGraphProvider'

const mockFetch = vi.mocked(fetchWithTimeout)

const ANSWER = { specHash: 'h', members: [{ urn: 'a', via: 'seed' }] }

beforeEach(() => {
  mockFetch.mockReset()
  mockFetch.mockResolvedValue({
    ok: true, status: 200, headers: { get: () => null },
    json: async () => ANSWER,
    text: async () => JSON.stringify(ANSWER),
  } as unknown as Response)
})

describe('RemoteGraphProvider.resolveMembers', () => {
  it('posts the spec, read in the view, on the draft it is on', async () => {
    const provider = new RemoteGraphProvider({ workspaceId: 'ws_m', dataSourceId: 'ds_m', branchId: 'br_m' })
    const spec = { v: 1 as const, seeds: { urns: ['a'] }, within: 'view' as const,
      expand: { children: 0, upstream: 'all' as const, downstream: 0, partnerChildren: 0 } }
    const controller = new AbortController()

    expect(await provider.resolveMembers('view_1', { spec }, { signal: controller.signal })).toEqual(ANSWER)

    const [url, init] = mockFetch.mock.calls[0]
    const u = new URL(String(url), 'http://x')
    expect(u.pathname).toBe('/api/v1/ws_m/graph/members')
    expect(Object.fromEntries(u.searchParams)).toEqual({ viewId: 'view_1', dataSourceId: 'ds_m', branchId: 'br_m' })
    expect(JSON.parse(String(init?.body))).toEqual({ spec })
    expect(init?.signal).toBe(controller.signal)
    expect(init?.timeoutMs).toBe(TIMEOUTS.TRACE_MS)
  })

  it('fails as a trace does: its own breaker, never the one browsing shares', () => {
    expect(classifyEndpoint('/api/v1/ws/graph/members?viewId=v')).toBe('trace')
  })
})
