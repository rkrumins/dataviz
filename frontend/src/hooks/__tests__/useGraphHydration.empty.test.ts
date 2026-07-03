/**
 * useGraphHydration — an EMPTY graph must complete hydration, not stall.
 *
 * Regression: every empty-result early return used to exit without setting
 * hydrationPhase to 'complete', leaving the canvas in ghost-loading forever.
 * Blank (hand-built) models legitimately start at zero nodes, so the empty
 * path is now a first-class journey on both the reference and graph layouts.
 */
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockProvider, viewState } = vi.hoisted(() => ({
  mockProvider: {
    getNodes: vi.fn(async () => []),
    getEdgesBetween: vi.fn(async () => []),
    getChildren: vi.fn(async () => []),
  },
  viewState: { layoutType: 'reference' as string },
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
    layout: { type: viewState.layoutType, referenceLayout: { layers: [] } },
    content: { visibleEntityTypes: ['layer', 'object'] },
  }),
  isContainmentEdgeType: () => false,
  normalizeEdgeType: (t: string) => t,
}))

import { useGraphHydration } from '../useGraphHydration'

describe('useGraphHydration on an empty graph', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockProvider.getNodes.mockResolvedValue([])
  })

  it('reference view: reaches complete with zero nodes', async () => {
    viewState.layoutType = 'reference'
    const { result } = renderHook(() => useGraphHydration({ hydrate: true }))
    await waitFor(() => expect(result.current.hydrationPhase).toBe('complete'))
  })

  it('graph view: reaches complete with zero nodes', async () => {
    viewState.layoutType = 'graph'
    const { result } = renderHook(() => useGraphHydration({ hydrate: true }))
    await waitFor(() => expect(result.current.hydrationPhase).toBe('complete'))
  })
})
