/**
 * useGraphHydration — provider-health recovery event re-hydrates the canvas.
 *
 * The provider-health store learns of recovery independently of the canvas
 * retry loop (60s /health/providers poll + sub-second X-Provider-Health
 * response headers). Pinned here: an unhealthy→healthy transition for THIS
 * provider scope triggers an immediate re-hydration while the canvas sits in
 * warming/unavailable — and does NOT re-hydrate a canvas that is already
 * ready. The retry loop is disabled (huge intervals) so any recovery in this
 * test is attributable ONLY to the health-store subscription.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockProvider } = vi.hoisted(() => ({
  mockProvider: {
    getNodes: vi.fn(async () => []),
    getEdgesBetween: vi.fn(async () => []),
    getChildren: vi.fn(async () => []),
  },
}))

vi.mock('@/providers/GraphProviderContext', () => ({
  useGraphProvider: () => mockProvider,
  useGraphProviderContext: () => ({
    providerVersion: 1,
    workspaceId: 'ws1',
    dataSourceId: 'ds1',
  }),
}))
vi.mock('@/hooks/useViewSchema', () => ({
  useViewContainmentEdgeTypes: () => ['CONTAINS'],
  useViewLineageEdgeTypes: () => ['FLOWS_TO'],
  useViewRootEntityTypes: () => ['layer'],
  useViewEntityTypes: () => [
    { id: 'layer', hierarchy: { canBeContainedBy: [], canContain: ['object'] } },
    { id: 'object', hierarchy: { canBeContainedBy: ['layer'], canContain: [] } },
  ],
  useViewSchemaIsReady: () => true,
}))
vi.mock('@/store/schema', () => ({
  useActiveView: () => ({
    id: 'v1',
    layout: { type: 'graph', referenceLayout: { layers: [] } },
    content: { visibleEntityTypes: ['layer', 'object'] },
  }),
  isContainmentEdgeType: () => false,
  normalizeEdgeType: (t: string) => t,
}))
// Retry loop effectively OFF: any re-hydration in this test can only come
// from the provider-health subscription under test.
vi.mock('@/config/polling', () => ({
  POLLING_INTERVALS: { providerRetry: 1_000_000, providerRetrySlow: 1_000_000 },
  PROVIDER_RETRY_MAX_ATTEMPTS: 0,
  withJitter: (ms: number) => ms,
}))

import { useGraphHydration } from '../useGraphHydration'
import { useCanvasStore } from '@/store/canvas'
import { useProviderHealthStore } from '@/store/providerHealth'

function setProviderHealth(status: 'healthy' | 'unhealthy') {
  act(() => {
    useProviderHealthStore.setState({
      providers: new Map([[
        'ws1:ds1',
        { status, lastChecked: Date.now() },
      ]]),
    })
  })
}

describe('useGraphHydration provider-health recovery wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useProviderHealthStore.setState({ providers: new Map() })
    useCanvasStore.setState({ hydrationStatus: 'loading' } as never)
  })

  it('unhealthy→healthy re-hydrates an unavailable canvas to ready', async () => {
    let down = true
    mockProvider.getNodes.mockImplementation(async () => {
      if (down) throw new Error('ECONNREFUSED')
      return []
    })

    const { result } = renderHook(() => useGraphHydration({ hydrate: true }))
    await waitFor(() => expect(result.current.hydrationStatus).toBe('unavailable'))
    const callsWhileDown = mockProvider.getNodes.mock.calls.length

    // CanvasRouter mirrors the hook's status into the canvas store; the
    // subscription reads that mirror. Simulate the mount wiring.
    act(() => {
      useCanvasStore.setState({ hydrationStatus: 'unavailable' } as never)
    })

    // Node rotation completes: provider back, health store learns of it.
    down = false
    setProviderHealth('unhealthy')
    setProviderHealth('healthy')

    await waitFor(() => expect(result.current.hydrationStatus).toBe('ready'))
    expect(mockProvider.getNodes.mock.calls.length).toBeGreaterThan(callsWhileDown)
  })

  it('a healthy flip while the canvas is ready does NOT re-hydrate', async () => {
    mockProvider.getNodes.mockResolvedValue([])

    const { result } = renderHook(() => useGraphHydration({ hydrate: true }))
    await waitFor(() => expect(result.current.hydrationStatus).toBe('ready'))
    act(() => {
      useCanvasStore.setState({ hydrationStatus: 'ready' } as never)
    })
    const settledCalls = mockProvider.getNodes.mock.calls.length

    setProviderHealth('unhealthy')
    setProviderHealth('healthy')

    // Give any (unwanted) re-hydration a chance to fire, then assert it didn't.
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(mockProvider.getNodes.mock.calls.length).toBe(settledCalls)
  })
})
