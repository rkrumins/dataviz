/**
 * A canvas root page is ONE request now, not three.
 *
 * `/canvas/bootstrap` has existed since WS5 and had no client — the
 * isolation lane in circuitBreaker.ts classified `/canvas/` and never
 * carried traffic. The three calls it replaces fire together on every open
 * and queue on the browser's six HTTP/1.1 connections, so over real network
 * RTT what one request saves is the queueing, not the query time.
 *
 * The claim here is REQUEST COUNT, and that the fallback is real: the
 * batched endpoint is an optimisation, never a new way for a canvas to fail
 * to open.
 */
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockProvider } = vi.hoisted(() => ({
  mockProvider: {
    getNodes: vi.fn(async () => []),
    getEdgesBetween: vi.fn(async () => []),
    getChildren: vi.fn(async () => []),
    canvasBootstrap: vi.fn(async () => ({ roots: { nodes: [], hasMore: false }, edges: [] })),
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
  ],
  useViewSchemaIsReady: () => true,
}))
vi.mock('@/store/schema', () => ({
  useActiveView: () => ({
    id: 'v1',
    layout: { type: 'reference', referenceLayout: { layers: [] } },
    content: { visibleEntityTypes: ['layer'] },
  }),
  isContainmentEdgeType: () => false,
  normalizeEdgeType: (t: string) => t,
}))

import { useGraphHydration } from '../useGraphHydration'

const root = { urn: 'urn:a', entityType: 'layer', displayName: 'A' }
const edge = { id: 'e1', sourceUrn: 'urn:a', targetUrn: 'urn:b', edgeType: 'FLOWS_TO' }

describe('the canvas root page goes through /canvas/bootstrap', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockProvider.canvasBootstrap.mockResolvedValue({
      roots: { nodes: [root], hasMore: false }, edges: [edge],
    } as never)
  })

  it('asks once, and asks the question the canvas actually asks', async () => {
    const { result } = renderHook(() => useGraphHydration({ hydrate: false }))
    await result.current.loadChildren('')

    expect(mockProvider.canvasBootstrap).toHaveBeenCalledTimes(1)
    // Not one request saved and two still made.
    expect(mockProvider.getNodes).not.toHaveBeenCalled()
    expect(mockProvider.getEdgesBetween).not.toHaveBeenCalled()

    const req = mockProvider.canvasBootstrap.mock.calls[0][0] as any
    // By entity type, not by the structural "no incoming containment edge"
    // query — routing it through that would change which nodes are painted.
    expect(req.rootQuery.entityTypes).toEqual(['layer'])
    expect(req.rootQuery.offset).toBe(0)
    expect(Array.isArray(req.visibleUrns)).toBe(true)
  })

  it('falls back to the three calls when the batched endpoint fails', async () => {
    mockProvider.canvasBootstrap.mockRejectedValue(new Error('502'))
    mockProvider.getNodes.mockResolvedValue([root] as never)

    const { result } = renderHook(() => useGraphHydration({ hydrate: false }))
    await result.current.loadChildren('')

    await waitFor(() => expect(mockProvider.getNodes).toHaveBeenCalledTimes(1))
    expect(mockProvider.getEdgesBetween).toHaveBeenCalledTimes(1)
  })

  it('uses the old path against a provider that does not implement it', async () => {
    const without = mockProvider.canvasBootstrap
    // @ts-expect-error — deliberately removing the optional method
    delete mockProvider.canvasBootstrap
    mockProvider.getNodes.mockResolvedValue([root] as never)
    try {
      const { result } = renderHook(() => useGraphHydration({ hydrate: false }))
      await result.current.loadChildren('')
      await waitFor(() => expect(mockProvider.getNodes).toHaveBeenCalledTimes(1))
    } finally {
      mockProvider.canvasBootstrap = without
    }
  })
})
