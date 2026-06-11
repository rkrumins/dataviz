import { describe, it, expect, vi, beforeEach } from 'vitest'
import { stageEntityCreate, stageNodeUpdate, stageNodeDelete } from '../stageNode'
import { useCanvasStore } from '@/store/canvas'
import { useStagedChangesStore, type ApplyContext } from '@/store/stagedChangesStore'
import type { GraphDataProvider } from '@/providers/GraphDataProvider'

vi.mock('@/services/versioningApiService', () => ({
  getDeleteImpact: vi.fn(async () => ({ nodes: [], edges: [], nodeTotal: 1, edgeTotal: 0 })),
}))

const resetStores = () => {
  useCanvasStore.setState({
    nodes: [], edges: [], _nodeIndex: new Set(), _edgeIndex: new Set(),
    selectedNodeIds: [], selectedEdgeIds: [],
  })
  useStagedChangesStore.setState({ changes: [], redoStack: [], applyStatus: 'idle', lastApplyResult: null })
}

const addRealNode = (id: string, label = id, type = 'dataset') => {
  useCanvasStore.getState().addNodes([{
    id, type: 'generic', position: { x: 0, y: 0 },
    data: { label, type, urn: id },
  }])
}

const ctx = (provider?: Partial<GraphDataProvider>): ApplyContext => {
  const map = new Map<string, string>()
  return {
    provider: provider as GraphDataProvider,
    wsId: 'ws',
    resolveTempId: (t) => map.get(t),
    registerTempIdResolution: (t, r) => map.set(t, r),
  }
}

beforeEach(resetStores)

describe('stageEntityCreate', () => {
  it('adds an optimistic pending node and stages a create_entity change', () => {
    const temp = stageEntityCreate({ entityType: 'dataset', displayName: 'Orders' })
    const node = useCanvasStore.getState().nodes.find((n) => n.id === temp)
    expect(node?.data.isPending).toBe('create')
    expect(node?.data.label).toBe('Orders')
    const change = useStagedChangesStore.getState().changes[0]
    expect(change.type).toBe('create_entity')
    expect(change.targetId).toBe(temp)
  })

  it('adds a containment edge when the parent is a node on the canvas', () => {
    addRealNode('urn:parent')
    const temp = stageEntityCreate({ entityType: 'dataset', displayName: 'X', parentUrn: 'urn:parent' })
    const edge = useCanvasStore.getState().edges[0]
    expect(edge.source).toBe('urn:parent')
    expect(edge.target).toBe(temp)
    expect(edge.type).toBe('containment')
    expect((useStagedChangesStore.getState().changes[0].after as { parentUrn?: string }).parentUrn).toBe('urn:parent')
  })

  it('ignores a parent that is not a canvas node (layer id) — no dangling containment edge', () => {
    const temp = stageEntityCreate({ entityType: 'dataset', displayName: 'X', parentUrn: 'layer-3' })
    expect(useCanvasStore.getState().edges).toHaveLength(0)
    expect((useStagedChangesStore.getState().changes[0].after as { parentUrn?: string }).parentUrn).toBeUndefined()
    expect(temp).toContain('urn:staged:dataset')
  })

  it('apply reads the LATEST staged after — a folded rename creates with the new name', async () => {
    const temp = stageEntityCreate({ entityType: 'dataset', displayName: 'Old name' })
    stageNodeUpdate(temp, { label: 'New name' })
    // Folding must not produce a second change.
    expect(useStagedChangesStore.getState().changes).toHaveLength(1)
    const createNode = vi.fn(async (req: { displayName: string }) => ({
      success: true,
      node: { urn: 'urn:real:1', displayName: req.displayName, entityType: 'dataset', tags: [], properties: {} },
      containmentEdge: null,
    }))
    const change = useStagedChangesStore.getState().changes[0]
    await change.apply?.(ctx({ createNode } as never))
    expect(createNode).toHaveBeenCalledWith(expect.objectContaining({ displayName: 'New name' }))
  })

  it('discarding a parent create also discards dependent child creates (recursively)', () => {
    const gp = stageEntityCreate({ entityType: 'domain', displayName: 'GP' })
    const p = stageEntityCreate({ entityType: 'system', displayName: 'P', parentUrn: gp })
    stageEntityCreate({ entityType: 'dataset', displayName: 'C', parentUrn: p })
    expect(useStagedChangesStore.getState().changes).toHaveLength(3)

    const gpChange = useStagedChangesStore.getState().changes.find((c) => c.targetId === gp)!
    useStagedChangesStore.getState().discard(gpChange.id)

    expect(useStagedChangesStore.getState().changes).toHaveLength(0)
    expect(useCanvasStore.getState().nodes).toHaveLength(0)
    expect(useCanvasStore.getState().edges).toHaveLength(0)
  })
})

describe('stageNodeUpdate', () => {
  it('stages a single update_entity, merging successive edits and preserving the original before', () => {
    addRealNode('n1', 'Orders')
    stageNodeUpdate('n1', { label: 'Orders v2' })
    stageNodeUpdate('n1', { properties: { owner: 'data-eng' } })

    const changes = useStagedChangesStore.getState().changes
    expect(changes).toHaveLength(1)
    expect(changes[0].type).toBe('update_entity')
    const after = changes[0].after as Record<string, unknown>
    expect(after.label).toBe('Orders v2')
    expect(after.properties).toEqual({ owner: 'data-eng' })
    expect((changes[0].before as Record<string, unknown>).label).toBe('Orders')

    const node = useCanvasStore.getState().nodes.find((n) => n.id === 'n1')
    expect(node?.data.label).toBe('Orders v2')
    expect(node?.data.properties).toEqual({ owner: 'data-eng' })
  })

  it('is a no-op when nothing changed', () => {
    addRealNode('n1', 'Orders')
    stageNodeUpdate('n1', { label: 'Orders' })
    expect(useStagedChangesStore.getState().changes).toHaveLength(0)
  })

  it('discard restores the original canvas data', () => {
    addRealNode('n1', 'Orders')
    stageNodeUpdate('n1', { label: 'Orders v2' })
    stageNodeUpdate('n1', { label: 'Orders v3' })
    const change = useStagedChangesStore.getState().changes[0]
    useStagedChangesStore.getState().discard(change.id)
    expect(useCanvasStore.getState().nodes.find((n) => n.id === 'n1')?.data.label).toBe('Orders')
  })
})

describe('stageNodeDelete', () => {
  it('discards the create instead of staging a delete for a staged-as-create node', () => {
    const temp = stageEntityCreate({ entityType: 'dataset', displayName: 'X' })
    stageNodeDelete(temp)
    expect(useStagedChangesStore.getState().changes).toHaveLength(0)
    expect(useCanvasStore.getState().nodes).toHaveLength(0)
  })

  it('marks a real node pending-delete and stages delete_entity', () => {
    addRealNode('n1', 'Orders')
    stageNodeDelete('n1')
    expect(useCanvasStore.getState().nodes.find((n) => n.id === 'n1')?.data.isPending).toBe('delete')
    const change = useStagedChangesStore.getState().changes[0]
    expect(change.type).toBe('delete_entity')
    expect(change.targetId).toBe('n1')
  })

  it('discarding the delete clears the pending marker', () => {
    addRealNode('n1')
    stageNodeDelete('n1')
    const change = useStagedChangesStore.getState().changes[0]
    useStagedChangesStore.getState().discard(change.id)
    expect(useCanvasStore.getState().nodes.find((n) => n.id === 'n1')?.data.isPending).toBeUndefined()
  })
})
