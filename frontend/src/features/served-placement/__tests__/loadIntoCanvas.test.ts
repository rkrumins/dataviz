/**
 * loadIntoCanvas: an entity loaded where the view draws it, whatever page of its layer it
 * falls on — tagged for its layer, drawn inside the containers its layer draws it in (rows of
 * context, nothing more loaded), with its page's edges, each batch in one store write; and
 * nothing asked about an entity the canvas already holds in its layer.
 */
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useLayerAssignment } from '@/hooks/useLayerAssignment'
import { toCanvasNode, withFeedLayer } from '@/lib/canvasNodeMapper'
import type { GraphEdge } from '@/providers/GraphDataProvider'
import { useCanvasStore } from '@/store/canvas'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import type { ViewPlacementsAnswer } from '@/types/membership'
import type { ViewLayerConfig } from '@/types/schema'
import type { FeedNode } from '@/types/searchView'

import { loadIntoCanvas } from '../loadIntoCanvas'
import { ServedPlacements } from '../servedPlacements'

const step = (urn: string, entityType: string) => ({ urn, displayName: urn.replace('urn:', ''), entityType })
const PATH = [step('urn:db', 'database'), step('urn:sales', 'schema')]
const feedNode = (urn: string, inLayer = 2): FeedNode =>
  ({ urn, entityType: 'table', displayName: urn.replace('urn:', ''), ancestorPath: PATH, inLayer }) as unknown as FeedNode

const viewPlacements = vi.fn(async (_v: string, urns: string[]): Promise<ViewPlacementsAnswer> => ({
  placements: Object.fromEntries(urns.map((u) => [u, u.includes('out')
    ? { layerId: null, source: 'none' as const }
    : { layerId: 'L1', source: 'inside' as const, inLayer: 2 }])),
  nodes: Object.fromEntries(urns.filter((u) => !u.includes('out')).map((u) => [u, feedNode(u)])),
  epoch: 1, dataVersion: 'd', digest: 'x',
}))
const edge = (id: string, sourceUrn: string, targetUrn: string, edgeType: string) =>
  ({ id, sourceUrn, targetUrn, edgeType }) as GraphEdge
const getEdges = vi.fn(async (q: { sourceUrns?: string[]; targetUrns?: string[]; edgeTypes?: string[] }) => {
  if (q.edgeTypes?.includes('CONTAINS')) return [edge('c1', 'urn:sales', 'urn:orders', 'CONTAINS')]   // its container: not loaded
  return q.sourceUrns ? [edge('f1', 'urn:orders', 'urn:held', 'FLOWS_TO')] : []
})
const getEdgesBetween = vi.fn(async () => [] as GraphEdge[])
const provider = { getEdges, getEdgesBetween }
const opts = { containmentEdgeTypes: ['CONTAINS'], lineageEdgeTypes: ['FLOWS_TO'] }

const service = () => new ServedPlacements({ viewId: 'v1', provider: { viewPlacements } })
const held = (urn: string, layerId?: string) => toCanvasNode(layerId
  ? withFeedLayer({ urn, entityType: 'table', displayName: urn } as never, layerId)
  : ({ urn, entityType: 'table', displayName: urn } as never))

describe('loadIntoCanvas', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useStagedChangesStore.setState({ changes: [], _scopeKey: null, _byScope: {} } as never)
    useCanvasStore.getState().setGraph([held('urn:held', 'L1')], [])
  })

  it('loads each entity tagged for its layer, with its page’s edges, in one write a batch', async () => {
    const writes: number[] = []
    const stop = useCanvasStore.subscribe((s, prev) => { if (s.nodes !== prev.nodes) writes.push(s.nodes.length) })
    const out = await loadIntoCanvas(service(), provider, ['urn:orders', 'urn:out-of-view'], opts)
    stop()
    expect(out).toEqual({ loaded: ['urn:orders'], outside: ['urn:out-of-view'], failed: [] })
    expect(writes).toEqual([2])
    const orders = useCanvasStore.getState().nodes.find((n) => n.id === 'urn:orders')!
    expect(orders.data).toMatchObject({ feedLayerId: 'L1', viaServed: true, inLayer: 2 })
    expect(orders.data.ancestorPath?.map((a) => a.urn)).toEqual(['urn:db', 'urn:sales'])
    // Kept once both ends are loaded: the flow to a held row, not the unloaded container.
    expect(useCanvasStore.getState().edges.map((e) => e.id)).toEqual(['f1'])
    expect(viewPlacements).toHaveBeenCalledWith('v1', ['urn:orders', 'urn:out-of-view'], expect.objectContaining({ nodes: true }))
  })

  it('is drawn inside the containers its layer draws it in — rows of context, nothing more loaded', async () => {
    await loadIntoCanvas(service(), provider, ['urn:orders'], opts)
    const nodes = useCanvasStore.getState().nodes
    const layers: ViewLayerConfig[] = [{ id: 'L1', name: 'Tables', entityTypes: [], order: 0 }]
    const { result } = renderHook(() => useLayerAssignment({
      nodes, sortedLayers: layers, nodeEdgeFingerprint: nodes.map((n) => n.id).join(','),
      instanceAssignments: new Map(nodes.map((n) => [n.id, { layerId: n.data.feedLayerId! }])),
      effectiveAssignments: new Map(), nodeMap: new Map(nodes.map((n) => [n.id, n])),
      childMap: new Map(), parentMap: new Map(), branchCreatedUrns: new Set(), whereTheySit: true,
    }))
    const shape = (n: { name: string; children: unknown[] }): unknown =>
      n.children.length ? { [n.name]: (n.children as typeof n[]).map(shape) } : n.name
    const rows = result.current.nodesByLayer.get('L1')!
    expect(rows.map(shape)).toEqual([{ db: [{ sales: ['orders'] }] }, 'urn:held'])
    expect(rows[0].id).toBe('logical:context:L1:urn:db')
    expect(useCanvasStore.getState().nodes.some((n) => n.id === 'urn:db')).toBe(false)
  })

  it('asks nothing about an entity the canvas already holds in its layer', async () => {
    useCanvasStore.getState().addGraph([held('urn:orders', 'L1')], [])
    const out = await loadIntoCanvas(service(), provider, ['urn:orders', 'urn:customers'], opts)
    expect(viewPlacements).toHaveBeenCalledTimes(1)
    expect(viewPlacements.mock.calls[0][1]).toEqual(['urn:customers'])
    expect(out.loaded.sort()).toEqual(['urn:customers', 'urn:orders'])

    vi.clearAllMocks()
    await loadIntoCanvas(service(), provider, ['urn:orders'], opts)
    expect(viewPlacements).not.toHaveBeenCalled()
  })
})
