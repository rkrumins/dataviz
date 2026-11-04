/**
 * Redo of a create draws it again. Undo runs a create's discard — its node, its containment link,
 * its drawn line leave the canvas — and redo used to put back only the staged record: a change in
 * Review & Save for something the canvas no longer showed. Each create now redraws exactly what
 * its undo took away (as it was then: a rename made since stays). And a link staged to an entity
 * that is discarded is not offered for redo — its end is gone.
 */
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/providers/GraphProviderContext', () => ({ useGraphProvider: () => null }))
vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify: vi.fn() }) }))

import { useCanvasStore, type LineageNode } from '@/store/canvas'
import { useSchemaStore } from '@/store/schema'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { useCanvasInteractions } from '@/hooks/useCanvasInteractions'
import { useStageEntityCreation } from '@/components/canvas/create/useStageEntityCreation'
import { planBuildStaging } from '@/components/canvas/create/buildmode/stageBuildRows'
import { makeRow } from '@/components/canvas/create/buildmode/buildRow'
import type { WorkspaceSchema } from '@/types/schema'

const node = (id: string, type: string) =>
  ({ id, type: 'generic', position: { x: 0, y: 0 }, data: { label: id, urn: id, type } }) as unknown as LineageNode

const store = () => useStagedChangesStore.getState()
const canvas = () => useCanvasStore.getState()

beforeEach(() => {
  useCanvasStore.setState({
    nodes: [node('t1', 'table'), node('t2', 'table')], edges: [], _nodeIndex: new Set(['t1', 't2']), _edgeIndex: new Set(),
  } as never)
  useSchemaStore.setState({
    schema: {
      entityTypes: [],
      relationshipTypes: [{
        id: 'FLOWS_TO', name: 'FLOWS_TO', sourceTypes: ['table'], targetTypes: ['table'], isLineage: true,
        bidirectional: false, showLabel: false,
        visual: { strokeColor: '#000', strokeWidth: 1, strokeStyle: 'solid', animated: false, animationSpeed: 'normal', arrowType: 'arrow' },
      }],
      containmentEdgeTypes: ['CONTAINS'],
    } as unknown as WorkspaceSchema,
  })
  useStagedChangesStore.setState({ changes: [], redoStack: [], _scopeKey: null, _byScope: {} } as never)
})

describe('redo of a create', () => {
  it('draws a drawn link again', () => {
    const { result } = renderHook(() => useCanvasInteractions())
    let id: string | null = null
    act(() => { id = result.current.stageEdgeCreate('t1', 't2', 'FLOWS_TO') })

    act(() => { store().undo() })
    expect(canvas().edges.some((e) => e.id === id)).toBe(false)
    act(() => { store().redo() })
    expect(store().changes.map((c) => c.targetId)).toEqual([id])
    expect(canvas().edges.find((e) => e.id === id)).toMatchObject({ source: 't1', target: 't2', data: { isPending: 'create' } })
  })

  it('draws a created entity again, with its containment link, as it was when undone', () => {
    const { result } = renderHook(() => useStageEntityCreation())
    let urn = ''
    act(() => { urn = result.current.stageEntity({ entityType: 'column', displayName: 'id', parentUrn: 't1', containmentEdgeType: 'CONTAINS' }) })
    act(() => { result.current.updateStagedEntity(urn, { displayName: 'order_id' }) })

    act(() => { store().undo() })
    expect(canvas().nodes.some((n) => n.id === urn)).toBe(false)
    act(() => { store().redo() })
    expect(canvas().nodes.find((n) => n.id === urn)?.data).toMatchObject({ label: 'order_id', isPending: 'create' })
    expect(canvas().edges.some((e) => e.source === 't1' && e.target === urn && e.type === 'containment')).toBe(true)
  })

  it('draws a Build row again', () => {
    const plan = planBuildStaging([makeRow({ id: 'r1', name: 'Orders', typeId: 'table', parentId: null })],
      { rootParentUrn: 't1', containmentEdgeTypeFor: () => 'CONTAINS' })
    act(() => {
      canvas().addNodes(plan.nodes)
      canvas().addEdges(plan.edges)
      store().stageMany(plan.changes)
    })
    const urn = plan.rowUrn.get('r1')!

    act(() => { store().undo() })
    expect(canvas().nodes.some((n) => n.id === urn)).toBe(false)
    act(() => { store().redo() })
    expect(canvas().nodes.some((n) => n.id === urn)).toBe(true)
    expect(canvas().edges.some((e) => e.source === 't1' && e.target === urn)).toBe(true)
  })

  it('does not offer a link for redo once the entity it ends at is discarded', () => {
    const create = renderHook(() => useStageEntityCreation()).result
    const links = renderHook(() => useCanvasInteractions()).result
    let urn = ''
    act(() => { urn = create.current.stageEntity({ entityType: 'table', displayName: 'New' }) })
    act(() => { links.current.stageEdgeCreate(urn, 't2', 'FLOWS_TO') })
    const entity = store().changes.find((c) => c.type === 'create_entity')!

    act(() => { store().discard(entity.id) })
    expect(store().changes).toEqual([])
    expect(store().redoStack).toEqual([])
  })
})
