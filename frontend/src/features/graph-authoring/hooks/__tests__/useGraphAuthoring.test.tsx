import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useGraphAuthoring } from '../useGraphAuthoring'
import { useCanvasStore } from '@/store/canvas'
import { useSchemaStore } from '@/store/schema'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { ensureDraftOpen } from '@/features/versioning/model/ensureDraftOpen'
import type { EntityTypeSchema, RelationshipTypeSchema, WorkspaceSchema } from '@/types/schema'

vi.mock('@/features/versioning/model/ensureDraftOpen', () => ({
  ensureDraftOpen: vi.fn(async () => 'branch-1'),
}))

const et = (id: string, canContain: string[] = []): EntityTypeSchema => ({
  id, name: id, pluralName: id, visual: {} as never, fields: [], behavior: {} as never,
  hierarchy: { level: 0, canContain, canBeContainedBy: [], defaultExpanded: false, rollUpFields: [] },
})
const rt = (id: string, s: string[], t: string[], extra: Partial<RelationshipTypeSchema> = {}): RelationshipTypeSchema =>
  ({ id, name: id, sourceTypes: s, targetTypes: t, isLineage: true, ...extra } as RelationshipTypeSchema)

const setSchema = () => {
  const schema = {
    entityTypes: [et('dataset'), et('dataJob'), et('domain', ['dataset'])],
    relationshipTypes: [
      rt('FLOWS_TO', ['dataset'], ['dataset']),
      rt('DERIVED_FROM', ['dataset'], ['dataset']),
      rt('PRODUCES', ['dataJob'], ['dataset']),
    ],
    containmentEdgeTypes: ['CONTAINS'],
    rootEntityTypes: ['domain'],
  } as unknown as WorkspaceSchema
  useSchemaStore.setState({ schema })
}

const addNode = (id: string, type: string) =>
  useCanvasStore.getState().addNodes([{ id, type: 'generic', position: { x: 0, y: 0 }, data: { label: id, type, urn: id } }])

beforeEach(() => {
  useCanvasStore.setState({ nodes: [], edges: [], _nodeIndex: new Set(), _edgeIndex: new Set(), selectedNodeIds: [], selectedEdgeIds: [] })
  useStagedChangesStore.setState({ changes: [], redoStack: [], applyStatus: 'idle', lastApplyResult: null })
  setSchema()
  vi.mocked(ensureDraftOpen).mockClear()
})

describe('useGraphAuthoring', () => {
  it('starts idle', () => {
    const { result } = renderHook(() => useGraphAuthoring())
    expect(result.current.mode.kind).toBe('idle')
    expect(result.current.connectContext).toBeNull()
  })

  it('beginInlineCreate opens a draft, then enters inline-create', async () => {
    const { result } = renderHook(() => useGraphAuthoring())
    await act(async () => { await result.current.beginInlineCreate('layer-1', null) })
    expect(ensureDraftOpen).toHaveBeenCalledOnce()
    expect(result.current.mode).toMatchObject({ kind: 'inline-create', layerId: 'layer-1', parentId: null })
  })

  it('beginConnect opens a draft, enters connect, and exposes connectContext valid targets', async () => {
    addNode('src', 'dataset')
    const { result } = renderHook(() => useGraphAuthoring())
    await act(async () => { await result.current.beginConnect('src', 'drag', { x: 10, y: 20 }) })
    expect(ensureDraftOpen).toHaveBeenCalledOnce()
    expect(result.current.mode).toMatchObject({ kind: 'connect', sourceId: 'src', via: 'drag' })
    // dataset → dataset is the only valid target type for a dataset source
    expect([...result.current.connectContext!.validTypeIds]).toEqual(['dataset'])
  })

  it('resolveTarget opens the edge-type picker for a valid pair', async () => {
    addNode('src', 'dataset'); addNode('tgt', 'dataset')
    const { result } = renderHook(() => useGraphAuthoring())
    await act(async () => { await result.current.beginConnect('src', 'drag') })
    act(() => { result.current.resolveTarget('tgt', { x: 5, y: 6 }) })
    expect(result.current.mode).toMatchObject({ kind: 'edge-type-pick', sourceId: 'src', targetId: 'tgt' })
  })

  it('resolveTarget rejects an ontology-invalid pair, notifies, and returns to idle', async () => {
    addNode('src', 'dataset'); addNode('tgt', 'dataJob') // no edge dataset → dataJob
    const notify = vi.fn()
    const { result } = renderHook(() => useGraphAuthoring({ notify }))
    await act(async () => { await result.current.beginConnect('src', 'drag') })
    act(() => { result.current.resolveTarget('tgt', { x: 5, y: 6 }) })
    expect(result.current.mode.kind).toBe('idle')
    expect(notify).toHaveBeenCalledWith(expect.any(String), 'error')
  })

  it('confirmEdgeType stages a create_edge and returns to idle', async () => {
    addNode('src', 'dataset'); addNode('tgt', 'dataset')
    const { result } = renderHook(() => useGraphAuthoring())
    await act(async () => { await result.current.beginConnect('src', 'drag') })
    act(() => { result.current.resolveTarget('tgt', { x: 5, y: 6 }) })
    act(() => { result.current.confirmEdgeType('FLOWS_TO') })
    expect(result.current.mode.kind).toBe('idle')
    const change = useStagedChangesStore.getState().changes[0]
    expect(change.type).toBe('create_edge')
    expect(change.after).toMatchObject({ edgeType: 'FLOWS_TO', source: 'src', target: 'tgt' })
  })

  it('handleEscape returns true and resets to idle when active, false when already idle', async () => {
    const { result } = renderHook(() => useGraphAuthoring())
    expect(result.current.handleEscape()).toBe(false)
    await act(async () => { await result.current.beginCompose() })
    expect(result.current.mode.kind).toBe('compose')
    let handled = false
    act(() => { handled = result.current.handleEscape() })
    expect(handled).toBe(true)
    expect(result.current.mode.kind).toBe('idle')
  })

  it('commitCreate stages the entity, fires onEntityStaged + onExpandParent, and closes unless keepOpen', async () => {
    const onEntityStaged = vi.fn()
    const onExpandParent = vi.fn()
    const { result } = renderHook(() => useGraphAuthoring({ onEntityStaged, onExpandParent }))
    await act(async () => { await result.current.beginInlineCreate('layer-1', 'p') })

    let temp = ''
    act(() => { temp = result.current.commitCreate({ entityType: 'dataset', displayName: 'A', parentUrn: 'p' }, { keepOpen: true, layerId: 'layer-1' }) })
    expect(temp).toContain('urn:staged:dataset')
    expect(onEntityStaged).toHaveBeenCalledWith(temp, { parentUrn: 'p', layerId: 'layer-1' })
    expect(onExpandParent).toHaveBeenCalledWith('p')
    // keepOpen → still in inline-create for rapid sibling entry
    expect(result.current.mode.kind).toBe('inline-create')

    act(() => { result.current.commitCreate({ entityType: 'dataset', displayName: 'B' }) })
    expect(result.current.mode.kind).toBe('idle')
  })

  it('beginCreatePanel and beginCompose each open a draft first', async () => {
    const { result } = renderHook(() => useGraphAuthoring())
    await act(async () => { await result.current.beginCreatePanel({ parentId: 'p', layerId: 'L' }) })
    expect(result.current.mode).toMatchObject({ kind: 'create-panel', parentId: 'p', layerId: 'L' })
    await act(async () => { await result.current.beginCompose({ seedParentId: 'p', seedLayerId: 'L' }) })
    expect(result.current.mode).toMatchObject({ kind: 'compose', seedParentId: 'p', seedLayerId: 'L' })
    expect(ensureDraftOpen).toHaveBeenCalledTimes(2)
  })
})
