/**
 * useGraphHydration — a slow, shed or session-repair failure is 'slow', not
 * 'unavailable'.
 *
 * Regression under test: every failure that was not the literal string
 * PROVIDER_LOADING became 'unavailable' — "Graph service is unavailable" over
 * a FalkorDB that was serving. A 504 from a query over budget, a 429 from the
 * backend shedding the view's own burst, a 401 from a just-expired token and a
 * client-side timeout all did it. Only a backend-CONFIRMED outage may.
 *
 * Also pinned: the initial load runs its node batches through a bounded
 * pool instead of firing every batch at once.
 */
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockProvider, viewState } = vi.hoisted(() => ({
  mockProvider: {
    getNodes: vi.fn(async () => [] as unknown[]),
    getEdgesBetween: vi.fn(async () => []),
    getChildren: vi.fn(async () => []),
  },
  viewState: { assignments: {} as Record<string, { layerId: string }> },
}))

vi.mock('@/providers/GraphProviderContext', () => ({
  useGraphProvider: () => mockProvider,
  useGraphProviderContext: () => ({ providerVersion: 1 }),
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
    layout: {
      type: 'reference',
      referenceLayout: { layers: [{ id: 'L1' }], assignments: viewState.assignments },
    },
    content: { visibleEntityTypes: ['layer', 'object'], entityScope: 'curated' },
  }),
  isContainmentEdgeType: () => false,
  normalizeEdgeType: (t: string) => t,
}))
// Retry loop effectively OFF so each test observes exactly one attempt.
vi.mock('@/config/polling', () => ({
  POLLING_INTERVALS: { providerRetry: 1_000_000, providerRetrySlow: 1_000_000 },
  PROVIDER_RETRY_MAX_ATTEMPTS: 0,
  withJitter: (ms: number) => ms,
}))

import { useGraphHydration, worstHydrationFailure, toHydrationFailure } from '../useGraphHydration'

function apiError(status: number, code?: string) {
  return Object.assign(new Error(`API Error ${status}: ${code ?? ''}`), { status, code })
}

function assignUrns(count: number) {
  const assignments: Record<string, { layerId: string }> = {}
  for (let i = 0; i < count; i++) assignments[`urn:e:${i}`] = { layerId: 'L1' }
  viewState.assignments = assignments
}

describe('useGraphHydration failure classification', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    assignUrns(3)
  })

  it.each([
    ['a 504 from a query over its budget', apiError(504, 'PROVIDER_TIMEOUT')],
    ['a 504 from the request-timeout middleware', apiError(504, 'REQUEST_TIMEOUT')],
    ['a 429 from load shedding', apiError(429, 'PROVIDER_BUSY')],
    ['a 401 from an expired access token', apiError(401)],
    ['a 403 from a CSRF token the fetch layer is repairing', apiError(403, 'csrf_failed')],
    ['a 502 gateway hiccup', apiError(502)],
    ['a client-side timeout', new TypeError('Request timed out after 30s (client-side limit)')],
  ])('%s is slow, never unavailable', async (_label, err) => {
    mockProvider.getNodes.mockRejectedValue(err)
    const { result } = renderHook(() => useGraphHydration({ hydrate: true }))
    await waitFor(() => expect(result.current.hydrationStatus).toBe('slow'))
    expect(result.current.hydrationError).toMatch(/taking longer/i)
  })

  it('a backend-confirmed outage is unavailable', async () => {
    mockProvider.getNodes.mockRejectedValue(apiError(503, 'PROVIDER_UNAVAILABLE'))
    const { result } = renderHook(() => useGraphHydration({ hydrate: true }))
    await waitFor(() => expect(result.current.hydrationStatus).toBe('unavailable'))
  })

  it('a warming provider is warming', async () => {
    mockProvider.getNodes.mockRejectedValue(apiError(503, 'PROVIDER_LOADING'))
    const { result } = renderHook(() => useGraphHydration({ hydrate: true }))
    await waitFor(() => expect(result.current.hydrationStatus).toBe('warming'))
  })

  it('a batch that succeeded keeps the canvas ready even when another was slow', async () => {
    assignUrns(150) // two batches of 100 + 50
    mockProvider.getNodes
      .mockRejectedValueOnce(apiError(504, 'PROVIDER_TIMEOUT'))
      .mockResolvedValueOnce([{ urn: 'urn:e:100', entityType: 'object', displayName: 'x' }])
    const { result } = renderHook(() => useGraphHydration({ hydrate: true }))
    await waitFor(() => expect(result.current.hydrationStatus).toBe('ready'))
  })

  it('loads node batches through a bounded pool, never all at once', async () => {
    assignUrns(1_000) // ten batches
    let inFlight = 0
    let peak = 0
    mockProvider.getNodes.mockImplementation(async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise(resolve => setTimeout(resolve, 5))
      inFlight--
      return []
    })
    const { result } = renderHook(() => useGraphHydration({ hydrate: true }))
    await waitFor(() => expect(mockProvider.getNodes).toHaveBeenCalledTimes(10))
    await waitFor(() => expect(result.current.hydrationStatus).toBe('ready'))
    expect(peak).toBeLessThanOrEqual(4)
    expect(peak).toBeGreaterThan(1)
  })
})

describe('worstHydrationFailure', () => {
  it('a confirmed outage outranks warming, which outranks slowness', () => {
    expect(worstHydrationFailure([apiError(504), apiError(429)])).toBe('slow')
    expect(worstHydrationFailure([apiError(504), apiError(503, 'PROVIDER_LOADING')])).toBe('warming')
    expect(worstHydrationFailure([apiError(503, 'PROVIDER_LOADING'), apiError(503, 'PROVIDER_UNAVAILABLE')])).toBe('unavailable')
    expect(worstHydrationFailure([])).toBe('slow')
  })

  it('reads the client breaker rejection and a dead backend as unavailable', () => {
    expect(toHydrationFailure(new Error('Provider unavailable (circuit open)'))).toBe('unavailable')
    expect(toHydrationFailure(new TypeError('Failed to fetch'))).toBe('unavailable')
  })
})
