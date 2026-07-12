/**
 * useGraphHydration — auto-retry must never latch the canvas.
 *
 * Regression under test (GKE node-rotation outage): the retry loop used to
 * hard-stop after PROVIDER_RETRY_MAX_ATTEMPTS for BOTH warming and
 * unavailable, so any outage longer than the fast window (~1 min real time)
 * latched the overlay until a manual Retry or page reload. Pinned here:
 *
 *  - 'warming' (backend answered 503 PROVIDER_LOADING + Retry-After) is
 *    NEVER budget-capped — attempts continue past the fast budget and the
 *    canvas reaches 'ready' on its own once the dataset finishes loading.
 *  - 'unavailable' (hard down) degrades to the slow background cadence
 *    after the fast budget instead of stopping — recovery still happens
 *    with zero user action.
 *
 * Intervals are mocked tiny (and jitter-free) so the loop runs in
 * milliseconds; the cadence values themselves are pinned in config/polling.
 */
import { renderHook, waitFor } from '@testing-library/react'
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
    layout: { type: 'graph', referenceLayout: { layers: [] } },
    content: { visibleEntityTypes: ['layer', 'object'] },
  }),
  isContainmentEdgeType: () => false,
  normalizeEdgeType: (t: string) => t,
}))
// Tiny, jitter-free cadences so the loop runs in ms. Budget of 3 fast
// attempts mirrors the real shape (default 5) without slowing the test.
vi.mock('@/config/polling', () => ({
  POLLING_INTERVALS: { providerRetry: 10, providerRetrySlow: 25 },
  PROVIDER_RETRY_MAX_ATTEMPTS: 3,
  withJitter: (ms: number) => ms,
}))

import { useGraphHydration } from '../useGraphHydration'

describe('useGraphHydration auto-retry (node-rotation outage)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('warming: retries past the fast budget and reaches ready unaided', async () => {
    // 6 consecutive PROVIDER_LOADING failures (> budget of 3), then success.
    let failures = 6
    mockProvider.getNodes.mockImplementation(async () => {
      if (failures > 0) {
        failures--
        throw new Error('PROVIDER_LOADING')
      }
      return []
    })

    const { result } = renderHook(() => useGraphHydration({ hydrate: true }))

    await waitFor(() => expect(result.current.hydrationStatus).toBe('warming'))
    // Old behavior: stops for good after 1 + 3 attempts, latched on 'warming'.
    await waitFor(
      () => expect(result.current.hydrationStatus).toBe('ready'),
      { timeout: 5_000 },
    )
    expect(mockProvider.getNodes.mock.calls.length).toBeGreaterThanOrEqual(7)
  })

  it('unavailable: degrades to the slow cadence instead of stopping, then recovers', async () => {
    let down = true
    mockProvider.getNodes.mockImplementation(async () => {
      if (down) throw new Error('ECONNREFUSED')
      return []
    })

    const { result } = renderHook(() => useGraphHydration({ hydrate: true }))

    await waitFor(() => expect(result.current.hydrationStatus).toBe('unavailable'))
    // Old behavior capped total attempts at 1 + 3; ≥6 proves the slow
    // background cadence kept going after the fast budget was exhausted.
    await waitFor(
      () => expect(mockProvider.getNodes.mock.calls.length).toBeGreaterThanOrEqual(6),
      { timeout: 5_000 },
    )
    expect(result.current.hydrationStatus).toBe('unavailable')

    down = false
    await waitFor(
      () => expect(result.current.hydrationStatus).toBe('ready'),
      { timeout: 5_000 },
    )
  })
})
