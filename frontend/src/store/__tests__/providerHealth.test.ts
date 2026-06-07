import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/fetchWithTimeout', () => ({
  fetchWithTimeout: vi.fn(),
}))

import { useProviderHealthStore } from '../providerHealth'
import { fetchWithTimeout } from '@/services/fetchWithTimeout'

const mockFetch = vi.mocked(fetchWithTimeout)

function res(providers: Record<string, { status: string; error?: string }>): Response {
  return { ok: true, json: async () => ({ providers }) } as unknown as Response
}

describe('providerHealth store — refresh dedupe', () => {
  beforeEach(() => {
    useProviderHealthStore.setState({ providers: new Map() })
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('preserves the providers Map reference when only the heartbeat changes', async () => {
    mockFetch.mockResolvedValueOnce(res({ 'ws:ds': { status: 'healthy' } }))
    await useProviderHealthStore.getState().refresh()
    const ref1 = useProviderHealthStore.getState().providers

    // Same status — refresh() rebuilds the Map with a new lastChecked, but the
    // meaningful snapshot is unchanged, so the store must keep its reference.
    mockFetch.mockResolvedValueOnce(res({ 'ws:ds': { status: 'healthy' } }))
    await useProviderHealthStore.getState().refresh()
    const ref2 = useProviderHealthStore.getState().providers

    expect(ref2).toBe(ref1)
  })

  it('updates when a provider status or error changes', async () => {
    mockFetch.mockResolvedValueOnce(res({ 'ws:ds': { status: 'healthy' } }))
    await useProviderHealthStore.getState().refresh()
    const ref1 = useProviderHealthStore.getState().providers

    mockFetch.mockResolvedValueOnce(res({ 'ws:ds': { status: 'down', error: 'boom' } }))
    await useProviderHealthStore.getState().refresh()
    const after = useProviderHealthStore.getState().providers

    expect(after).not.toBe(ref1)
    expect(after.get('ws:ds')?.status).toBe('unhealthy')
    expect(after.get('ws:ds')?.error).toBe('boom')
  })
})
