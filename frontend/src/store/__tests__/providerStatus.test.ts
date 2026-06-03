import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useProviderStatusStore } from '../providerStatus'
import { providerService, type ProviderStatusResponse } from '@/services/providerService'

function entry(over: Partial<ProviderStatusResponse> = {}): ProviderStatusResponse {
  return {
    id: 'p1',
    name: 'Prod',
    status: 'ready',
    lastCheckedAt: '2026-01-01T00:00:00Z',
    ...over,
  }
}

describe('providerStatus store — refresh dedupe', () => {
  beforeEach(() => {
    useProviderStatusStore.setState({ statuses: {}, lastUpdatedAt: null, fromCache: false })
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('preserves the statuses reference when only the lastCheckedAt heartbeat changes', async () => {
    const spy = vi.spyOn(providerService, 'listStatus')

    spy.mockResolvedValueOnce([entry({ lastCheckedAt: 't1' })])
    await useProviderStatusStore.getState().refresh()
    const ref1 = useProviderStatusStore.getState().statuses

    // Same meaningful status, only the heartbeat advanced — must be a no-op.
    spy.mockResolvedValueOnce([entry({ lastCheckedAt: 't2' })])
    await useProviderStatusStore.getState().refresh()
    const ref2 = useProviderStatusStore.getState().statuses

    expect(ref2).toBe(ref1)
  })

  it('updates when a provider status actually changes', async () => {
    const spy = vi.spyOn(providerService, 'listStatus')

    spy.mockResolvedValueOnce([entry({ status: 'ready' })])
    await useProviderStatusStore.getState().refresh()
    const ref1 = useProviderStatusStore.getState().statuses

    spy.mockResolvedValueOnce([entry({ status: 'unavailable', error: 'boom' })])
    await useProviderStatusStore.getState().refresh()
    const state = useProviderStatusStore.getState()

    expect(state.statuses).not.toBe(ref1)
    expect(state.statuses['p1'].status).toBe('unavailable')
    expect(state.statuses['p1'].error).toBe('boom')
  })

  it('first poll after cache hydration writes through to clear fromCache', async () => {
    // Mimic a localStorage-hydrated snapshot holding identical data.
    useProviderStatusStore.setState({ statuses: { p1: entry() }, lastUpdatedAt: 123, fromCache: true })
    const ref1 = useProviderStatusStore.getState().statuses

    const spy = vi.spyOn(providerService, 'listStatus')
    spy.mockResolvedValueOnce([entry()]) // equal values, but fromCache must clear

    await useProviderStatusStore.getState().refresh()
    const state = useProviderStatusStore.getState()

    expect(state.fromCache).toBe(false)
    expect(state.statuses).not.toBe(ref1)
  })
})
