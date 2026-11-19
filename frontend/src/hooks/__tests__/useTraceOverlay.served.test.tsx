/**
 * useTraceOverlay in a view the server places: the server's word on where each entity is
 * drawn (`placement.served`) reaches the view the canvas draws — not only the model. Without
 * it a list view, which keeps no assignments, would draw a trace's every chain outside it.
 */
import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { LensWalkModel, LensWalkNode } from '@/components/canvas/context-view/lens/closure-adapter'
import type { ViewLayerConfig } from '@/types/schema'

import { useTraceOverlay } from '../useTraceOverlay'

const wn = (urn: string, type: string): LensWalkNode => ({
  id: urn, type: 'default', position: { x: 0, y: 0 },
  data: { urn, label: urn, type, childCount: 0 }, urn, displayName: urn, entityType: type,
}) as unknown as LensWalkNode

const layers: ViewLayerConfig[] = [
  { id: 'seeds', name: 'Starting points', entityTypes: [], order: 0 } as unknown as ViewLayerConfig,
  { id: 'down', name: 'Consumers', entityTypes: [], order: 1 } as unknown as ViewLayerConfig,
]
const model = {
  focusUrn: 'seed',
  nodes: [wn('seed', 'dataset'), wn('d1', 'dataset')],
  containmentEdges: [],
  lineageEdges: [{ id: 'r:seed>d1', sourceUrn: 'seed', targetUrn: 'd1', edgeType: 'TRANSFORMS', kind: 'raw', weight: null }],
  upstreamUrns: new Set(), downstreamUrns: new Set(['d1']),
  frontierUp: [], frontierDown: [], truncated: false, truncationReason: null, seedTruncated: false, seedCursor: null,
} as unknown as LensWalkModel

const lanesOf = (served?: ReadonlyMap<string, string | null>) => {
  const { result } = renderHook(() => useTraceOverlay({
    model, focusUrn: 'seed', layers, assignments: {}, viewIsCurated: true,
    showUpstream: true, showDownstream: true, depthUp: 25, depthDown: 25,
    placement: { backendAssignments: new Map(), ...(served ? { served } : {}) },
  }))
  return Object.fromEntries((result.current.view?.lanes ?? []).map((l) => [l.layerId, l.roots.map((r) => r.id)]))
}

describe('useTraceOverlay — a view the server places', () => {
  it('draws the trace where the server says', () => {
    expect(lanesOf(new Map([['seed', 'seeds'], ['d1', 'down']]))).toEqual({ seeds: ['seed'], down: ['d1'] })
  })

  it('without it, a list view places nothing', () => {
    expect(lanesOf()).toEqual({})
  })
})
