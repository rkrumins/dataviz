import { describe, it, expect, vi, beforeEach } from 'vitest'
import { stageEdgeCreate, stageEdgeDelete, stageEdgeReverse, stageEdgeRetype, stageEdgePropertyEdit } from '../stageEdge'
import { useCanvasStore, type LineageEdge } from '@/store/canvas'
import { useStagedChangesStore, type ApplyContext } from '@/store/stagedChangesStore'
import type { GraphDataProvider } from '@/providers/GraphDataProvider'

vi.mock('@/services/edgeApi', () => ({
  patchEdge: vi.fn(async () => ({})),
  deleteEdge: vi.fn(async () => undefined),
}))

const resetStores = () => {
  useCanvasStore.setState({
    nodes: [], edges: [], _nodeIndex: new Set(), _edgeIndex: new Set(),
    selectedNodeIds: [], selectedEdgeIds: [],
  })
  useStagedChangesStore.setState({ changes: [], redoStack: [], applyStatus: 'idle', lastApplyResult: null })
}

const addEdge = (id: string, over: Partial<LineageEdge> = {}) => {
  useCanvasStore.getState().addEdges([{
    id, source: 'urn:a', target: 'urn:b', type: 'lineage',
    data: { edgeType: 'FLOWS_TO', relationship: 'flows_to', confidence: 0.7 },
    ...over,
  }])
}

const ctx = (provider?: Partial<GraphDataProvider>): ApplyContext => ({
  provider: provider as GraphDataProvider,
  wsId: 'ws',
  resolveTempId: () => undefined,
  registerTempIdResolution: () => undefined,
})

beforeEach(resetStores)

describe('stageEdgeCreate', () => {
  it('adds an optimistic edge and stages a create_edge change', () => {
    const id = stageEdgeCreate('urn:a', 'urn:b', 'FLOWS_TO')
    expect(useCanvasStore.getState().edges.find((e) => e.id === id)?.data?.edgeType).toBe('FLOWS_TO')
    const change = useStagedChangesStore.getState().changes[0]
    expect(change.type).toBe('create_edge')
    expect(change.after).toMatchObject({ edgeType: 'FLOWS_TO', source: 'urn:a', target: 'urn:b' })
  })

  it('apply reads the LATEST after — a retype folded into the create persists the new type', async () => {
    const id = stageEdgeCreate('urn:a', 'urn:b', 'FLOWS_TO')
    stageEdgeRetype(id, 'DERIVED_FROM')
    expect(useStagedChangesStore.getState().changes).toHaveLength(1)
    const createEdge = vi.fn(async () => ({ success: true, edge: null }))
    await useStagedChangesStore.getState().changes[0].apply?.(ctx({ createEdge } as never))
    expect(createEdge).toHaveBeenCalledWith(expect.objectContaining({ edgeType: 'DERIVED_FROM' }))
  })
})

describe('stageEdgeRetype', () => {
  it('swaps the edge to a new canvas id and stages retype_edge with the original snapshot', () => {
    addEdge('e1')
    const newId = stageEdgeRetype('e1', 'DERIVED_FROM')
    expect(newId).toBe('e1-retyped')
    expect(useCanvasStore.getState().edges.find((e) => e.id === 'e1')).toBeUndefined()
    const retyped = useCanvasStore.getState().edges.find((e) => e.id === newId)
    expect(retyped?.data?.edgeType).toBe('DERIVED_FROM')
    expect(retyped?.data?.confidence).toBe(0.7) // mutable data carried

    const change = useStagedChangesStore.getState().changes[0]
    expect(change.type).toBe('retype_edge')
    expect(change.targetId).toBe(newId)
    expect((change.before as { edge: LineageEdge }).edge.data?.edgeType).toBe('FLOWS_TO')
  })

  it('re-retyping replaces the staged change, keeping the ORIGINAL before', () => {
    addEdge('e1')
    const newId = stageEdgeRetype('e1', 'DERIVED_FROM')!
    stageEdgeRetype(newId, 'CONSUMES')
    const changes = useStagedChangesStore.getState().changes
    expect(changes).toHaveLength(1)
    expect((changes[0].before as { edge: LineageEdge }).edge.data?.edgeType).toBe('FLOWS_TO')
    expect(useCanvasStore.getState().edges.find((e) => e.id === newId)?.data?.edgeType).toBe('CONSUMES')
  })

  it('discard restores the original edge', () => {
    addEdge('e1')
    stageEdgeRetype('e1', 'DERIVED_FROM')
    useStagedChangesStore.getState().discard(useStagedChangesStore.getState().changes[0].id)
    const restored = useCanvasStore.getState().edges.find((e) => e.id === 'e1')
    expect(restored?.data?.edgeType).toBe('FLOWS_TO')
    expect(useCanvasStore.getState().edges).toHaveLength(1)
  })

  it('refuses aggregated and containment edges', () => {
    addEdge('agg', { data: { edgeType: 'FLOWS_TO', isAggregated: true } })
    addEdge('cont', { type: 'containment', data: { edgeType: 'CONTAINS' } })
    expect(stageEdgeRetype('agg', 'DERIVED_FROM')).toBeNull()
    expect(stageEdgeRetype('cont', 'DERIVED_FROM')).toBeNull()
    expect(useStagedChangesStore.getState().changes).toHaveLength(0)
  })
})

describe('stageEdgeDelete', () => {
  it('removes the edge and stages delete_edge; discard restores it', () => {
    addEdge('e1')
    expect(stageEdgeDelete('e1')).toBe(true)
    expect(useCanvasStore.getState().edges).toHaveLength(0)
    const change = useStagedChangesStore.getState().changes[0]
    expect(change.type).toBe('delete_edge')
    useStagedChangesStore.getState().discard(change.id)
    expect(useCanvasStore.getState().edges.find((e) => e.id === 'e1')?.data?.edgeType).toBe('FLOWS_TO')
  })

  it('discards the create instead of staging a delete for a staged-as-create edge', () => {
    const id = stageEdgeCreate('urn:a', 'urn:b', 'FLOWS_TO')
    stageEdgeDelete(id)
    expect(useStagedChangesStore.getState().changes).toHaveLength(0)
    expect(useCanvasStore.getState().edges).toHaveLength(0)
  })

  it('deleting a retyped edge discards the retype and stages a delete of the ORIGINAL edge', () => {
    addEdge('e1')
    const newId = stageEdgeRetype('e1', 'DERIVED_FROM')!
    stageEdgeDelete(newId)
    const changes = useStagedChangesStore.getState().changes
    expect(changes).toHaveLength(1)
    expect(changes[0].type).toBe('delete_edge')
    expect(changes[0].targetId).toBe('e1')
    expect(useCanvasStore.getState().edges).toHaveLength(0)
  })

  it('refuses aggregated edges', () => {
    addEdge('agg', { data: { edgeType: 'FLOWS_TO', isAggregated: true } })
    expect(stageEdgeDelete('agg')).toBe(false)
    expect(useCanvasStore.getState().edges).toHaveLength(1)
  })
})

describe('stageEdgeReverse', () => {
  it('swaps endpoints under a new canvas id and stages reverse_edge', () => {
    addEdge('e1')
    expect(stageEdgeReverse('e1')).toBe(true)
    const reversed = useCanvasStore.getState().edges[0]
    expect(reversed.id).toBe('e1-reversed')
    expect(reversed.source).toBe('urn:b')
    expect(reversed.target).toBe('urn:a')
    expect(useStagedChangesStore.getState().changes[0].type).toBe('reverse_edge')
  })

  it('refuses containment edges', () => {
    addEdge('cont', { type: 'containment', data: { edgeType: 'CONTAINS' } })
    expect(stageEdgeReverse('cont')).toBe(false)
  })
})

describe('stageEdgePropertyEdit', () => {
  it('updates the canvas edge data and stages a single merged edit_edge', () => {
    addEdge('e1')
    stageEdgePropertyEdit('e1', { confidence: 0.9 })
    stageEdgePropertyEdit('e1', { label: 'orders flow' })
    const changes = useStagedChangesStore.getState().changes
    expect(changes).toHaveLength(1)
    expect(changes[0].type).toBe('edit_edge')
    expect(changes[0].after).toMatchObject({ confidence: 0.9, label: 'orders flow' })
    const edge = useCanvasStore.getState().edges.find((e) => e.id === 'e1')
    expect(edge?.data?.confidence).toBe(0.9)
    expect(edge?.data?.label).toBe('orders flow')
  })

  it('folds property edits on a staged-as-create edge into the create change', () => {
    const id = stageEdgeCreate('urn:a', 'urn:b', 'FLOWS_TO')
    stageEdgePropertyEdit(id, { confidence: 0.5 })
    const changes = useStagedChangesStore.getState().changes
    expect(changes).toHaveLength(1)
    expect(changes[0].type).toBe('create_edge')
    expect((changes[0].after as { properties?: Record<string, unknown> }).properties).toMatchObject({ confidence: 0.5 })
  })

  it('refuses aggregated edges', () => {
    addEdge('agg', { data: { edgeType: 'FLOWS_TO', isAggregated: true } })
    expect(stageEdgePropertyEdit('agg', { confidence: 1 })).toBe(false)
  })
})
