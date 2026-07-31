/**
 * The viewId capability context must ride on EVERY workspace-scoped
 * request — buildUrl is the single funnel, so one option covers
 * bootstrap/nodes/edges/trace/search/metadata alike. Absent the
 * option, no request may carry it (members' URLs stay byte-identical
 * to before).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/fetchWithTimeout', () => ({
  fetchWithTimeout: vi.fn(),
}))

import { fetchWithTimeout } from '@/services/fetchWithTimeout'
import { RemoteGraphProvider } from '../RemoteGraphProvider'
import { poolKey } from '../providerPool'

const mockFetch = vi.mocked(fetchWithTimeout)

function okJson(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response
}

function lastUrl(): string {
  const call = mockFetch.mock.calls.at(-1)
  if (!call) throw new Error('fetchWithTimeout was never called')
  return String(call[0])
}

beforeEach(() => {
  mockFetch.mockReset()
  mockFetch.mockResolvedValue(okJson({ data: {}, meta: null }))
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('RemoteGraphProvider viewId threading', () => {
  it('appends viewId to a plain GET (stats)', async () => {
    const provider = new RemoteGraphProvider({
      workspaceId: 'ws_1', dataSourceId: 'ds_1', viewId: 'view_42',
    })
    await provider.getStats().catch(() => {})
    const url = lastUrl()
    expect(url).toContain('/api/v1/ws_1/graph/')
    expect(url).toContain('viewId=view_42')
    expect(url).toContain('dataSourceId=ds_1')
  })

  it('appends viewId to top-level nodes (canvas hydration path)', async () => {
    const provider = new RemoteGraphProvider({
      workspaceId: 'ws_1', dataSourceId: 'ds_1', viewId: 'view_42',
    })
    await provider.getTopLevelNodes({ limit: 5 } as never).catch(() => {})
    expect(lastUrl()).toContain('viewId=view_42')
  })

  it('omits viewId when the option is absent — member URLs unchanged', async () => {
    const provider = new RemoteGraphProvider({
      workspaceId: 'ws_1', dataSourceId: 'ds_1',
    })
    await provider.getStats().catch(() => {})
    expect(lastUrl()).not.toContain('viewId=')
  })

  it('folds viewId into scopeKey so URN-keyed caches cannot collide across capability contexts', () => {
    const a = new RemoteGraphProvider({ workspaceId: 'w', dataSourceId: 'd', viewId: 'v1' })
    const b = new RemoteGraphProvider({ workspaceId: 'w', dataSourceId: 'd', viewId: 'v2' })
    expect(a.scopeKey).not.toBe(b.scopeKey)
  })
})

describe('providerPool viewId keying', () => {
  it('two views on one source get distinct pool keys', () => {
    expect(poolKey('w', 'd', null, 'v1')).not.toBe(poolKey('w', 'd', null, 'v2'))
    expect(poolKey('w', 'd', null, 'v1')).not.toBe(poolKey('w', 'd', null))
  })
})
