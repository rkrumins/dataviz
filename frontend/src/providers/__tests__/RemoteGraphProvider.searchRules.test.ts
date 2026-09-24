/**
 * The reads that answer for what is on screen: which entities match which
 * display rules (``searchMembership``), each rule's exact total in the view
 * (``searchCounts``), and how many of a search's matches each container
 * holds (``searchAncestorCounts``). Pins the route, the body as sent, the
 * forwarded AbortSignal, and the counts call's raised timeout (a count
 * answer waits on the server for up to ``waitMs``).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/fetchWithTimeout', () => ({
  fetchWithTimeout: vi.fn(),
}))

import { fetchWithTimeout } from '@/services/fetchWithTimeout'
import { TIMEOUTS } from '@/config/timeouts'
import { RemoteGraphProvider } from '../RemoteGraphProvider'
import type { Predicate } from '@/types/search'

const mockFetch = vi.mocked(fetchWithTimeout)

function okJson(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

const predicate: Predicate = {
  kind: 'group', op: 'and', children: [{ kind: 'tag', op: 'hasAny', values: ['PII'] }],
}

beforeEach(() => {
  mockFetch.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('RemoteGraphProvider display-rule reads', () => {
  it('searchMembership POSTs the rules and entities to /search/membership', async () => {
    mockFetch.mockResolvedValue(okJson({ matches: { r1: ['urn:a'] }, errors: {} }))
    const provider = new RemoteGraphProvider({ workspaceId: 'ws_1', dataSourceId: 'ds_1' })
    const controller = new AbortController()
    const body = {
      scope: { viewId: 'v1', scopeMode: 'view' as const },
      items: [{ id: 'r1', predicate }],
      urns: ['urn:a', 'urn:b'],
    }

    const answer = await provider.searchMembership(body, { signal: controller.signal })

    expect(answer.matches).toEqual({ r1: ['urn:a'] })
    const [url, init] = mockFetch.mock.calls[0]
    expect(String(url)).toContain('/graph/search/membership')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual(body)
    expect(init?.signal).toBe(controller.signal)
  })

  it('searchCounts POSTs to /search/counts with the search timeout', async () => {
    mockFetch.mockResolvedValue(okJson({
      counts: { r1: { count: 7, status: 'complete' } },
    }))
    const provider = new RemoteGraphProvider({ workspaceId: 'ws_1', dataSourceId: 'ds_1' })
    const controller = new AbortController()
    const body = {
      scope: { viewId: 'v1', scopeMode: 'view' as const },
      items: [{ id: 'r1', predicate }],
      waitMs: 1000,
      sessions: { r1: 'sid-1' },
    }

    const answer = await provider.searchCounts(body, { signal: controller.signal })

    expect(answer.counts.r1.count).toBe(7)
    const [url, init] = mockFetch.mock.calls[0]
    expect(String(url)).toContain('/graph/search/counts')
    expect(JSON.parse(String(init?.body))).toEqual(body)
    expect(init?.signal).toBe(controller.signal)
    expect(init?.timeoutMs).toBe(TIMEOUTS.SEARCH_ADVANCED_MS)
  })

  it('searchAncestorCounts POSTs the session and containers to /search/ancestor-counts', async () => {
    mockFetch.mockResolvedValue(okJson({
      status: 'complete', counts: { c1: { count: 3, typeCounts: { column: 3 } } },
    }))
    const provider = new RemoteGraphProvider({ workspaceId: 'ws_1', dataSourceId: 'ds_1' })
    const controller = new AbortController()
    const body = { scope: { viewId: 'v1', scopeMode: 'view' as const }, sessionId: 'sid', urns: ['c1'] }

    const answer = await provider.searchAncestorCounts(body, { signal: controller.signal })

    expect(answer.counts.c1.count).toBe(3)
    const [url, init] = mockFetch.mock.calls[0]
    expect(String(url)).toContain('/graph/search/ancestor-counts')
    expect(JSON.parse(String(init?.body))).toEqual(body)
    expect(init?.signal).toBe(controller.signal)
  })

  it('searchCatalog POSTs the scope and session to /search/catalog with the search timeout', async () => {
    mockFetch.mockResolvedValue(okJson({
      sessionId: 's', status: 'complete', entities: 3, entityTypes: [], properties: [], tags: [],
    }))
    const provider = new RemoteGraphProvider({ workspaceId: 'ws_1', dataSourceId: 'ds_1' })
    const body = { scope: { viewId: 'v1', scopeMode: 'view' as const }, waitMs: 800, sessionId: 's' }

    const answer = await provider.searchCatalog(body)

    expect(answer.entities).toBe(3)
    const [url, init] = mockFetch.mock.calls[0]
    expect(String(url)).toContain('/graph/search/catalog')
    expect(JSON.parse(String(init?.body))).toEqual(body)
    expect(init?.timeoutMs).toBe(TIMEOUTS.SEARCH_ADVANCED_MS)
  })
})
