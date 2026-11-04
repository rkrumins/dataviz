/**
 * stageEdgeCreateMany — a bulk link lands in the draft exactly as that many
 * hand-drawn links would: the same gate per pair, the direction as given,
 * every staged link undoable on its own — but in ONE canvas update and ONE
 * staged batch, because the canvas re-renders on every store update.
 */
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/providers/GraphProviderContext', () => ({ useGraphProvider: () => null }))
vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify: vi.fn() }) }))

import { useCanvasInteractions } from '../useCanvasInteractions'
import { useCanvasStore, type LineageNode } from '@/store/canvas'
import { useSchemaStore } from '@/store/schema'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import type { WorkspaceSchema } from '@/types/schema'

const node = (id: string, type: string) =>
  ({ id, position: { x: 0, y: 0 }, data: { label: id, urn: id, type } }) as unknown as LineageNode

const rel = (id: string, sourceTypes: string[], targetTypes: string[]) => ({
  id, name: id, sourceTypes, targetTypes, isLineage: true, bidirectional: false, showLabel: false,
  visual: { strokeColor: '#000', strokeWidth: 1, strokeStyle: 'solid', animated: false, animationSpeed: 'normal', arrowType: 'arrow' },
})

beforeEach(() => {
  useCanvasStore.setState({
    nodes: [node('t1', 'table'), node('t2', 'table'), node('r1', 'report')],
    edges: [{ id: 'e0', source: 't2', target: 'r1', type: 'lineage', data: { edgeType: 'FLOWS_TO' } }],
  } as never)
  useSchemaStore.setState({
    schema: {
      entityTypes: [], relationshipTypes: [rel('FLOWS_TO', ['table'], ['table', 'report'])], containmentEdgeTypes: ['CONTAINS'],
    } as unknown as WorkspaceSchema,
  })
  useStagedChangesStore.setState({ changes: [], redoStack: [] } as never)
})

describe('stageEdgeCreateMany', () => {
  it('stages the pairs the gate allows, in the direction given, and returns the rest with reasons', () => {
    const { result } = renderHook(() => useCanvasInteractions())
    let outcome!: ReturnType<typeof result.current.stageEdgeCreateMany>
    act(() => {
      outcome = result.current.stageEdgeCreateMany(
        [
          { source: 't1', target: 'r1' }, // allowed
          { source: 't2', target: 'r1' }, // already linked
          { source: 'r1', target: 't1' }, // a report cannot feed anything
        ],
        'FLOWS_TO',
      )
    })
    expect(outcome.staged).toBe(1)
    expect(outcome.rejected.map((r) => [r.source, r.target])).toEqual([['t2', 'r1'], ['r1', 't1']])
    expect(outcome.rejected.every((r) => !!r.reason)).toBe(true)

    const changes = useStagedChangesStore.getState().changes
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ type: 'create_edge', after: { edgeType: 'FLOWS_TO', source: 't1', target: 'r1' } })
    expect(useCanvasStore.getState().edges.some((e) => e.source === 't1' && e.target === 'r1')).toBe(true)
  })

  it('lands in one canvas update and one staged batch, however many links', () => {
    const { result } = renderHook(() => useCanvasInteractions())
    const canvasWrites = vi.fn()
    const stagedWrites = vi.fn()
    const offCanvas = useCanvasStore.subscribe(canvasWrites)
    const offStaged = useStagedChangesStore.subscribe(stagedWrites)
    act(() => {
      result.current.stageEdgeCreateMany([{ source: 't1', target: 'r1' }, { source: 't1', target: 't2' }, { source: 't2', target: 't1' }], 'FLOWS_TO')
    })
    offCanvas()
    offStaged()
    expect(useStagedChangesStore.getState().changes).toHaveLength(3)
    expect(canvasWrites).toHaveBeenCalledTimes(1)
    expect(stagedWrites).toHaveBeenCalledTimes(1)
  })

  it('judges by the ontology the batch was previewed with — a view\'s own — when given one', () => {
    const { result } = renderHook(() => useCanvasInteractions())
    let outcome!: ReturnType<typeof result.current.stageEdgeCreateMany>
    act(() => {
      // FEEDS_REPORT exists only in the view's ontology, not the workspace schema.
      outcome = result.current.stageEdgeCreateMany([{ source: 't1', target: 'r1' }], 'FEEDS_REPORT', {
        relationshipTypes: [rel('FEEDS_REPORT', ['table'], ['report'])] as never,
        containmentEdgeTypes: ['CONTAINS'],
        entityTypes: [],
      })
    })
    expect(outcome.staged).toBe(1)
  })

  it('each staged link can still be discarded on its own', () => {
    const { result } = renderHook(() => useCanvasInteractions())
    act(() => {
      result.current.stageEdgeCreateMany([{ source: 't1', target: 'r1' }, { source: 't1', target: 't2' }], 'FLOWS_TO')
    })
    const [first] = useStagedChangesStore.getState().changes
    act(() => useStagedChangesStore.getState().discard(first.id))
    expect(useStagedChangesStore.getState().changes).toHaveLength(1)
    expect(useCanvasStore.getState().edges.some((e) => e.source === 't1' && e.target === 'r1')).toBe(false)
    expect(useCanvasStore.getState().edges.some((e) => e.source === 't1' && e.target === 't2')).toBe(true)
  })
})

describe('a drawn link is unsaved work', () => {
  it('is marked pending, one link or many, so a collapse keeps it and the save redraws it', () => {
    const { result } = renderHook(() => useCanvasInteractions())
    let one: string | null = null
    act(() => {
      one = result.current.stageEdgeCreate('t1', 't2', 'FLOWS_TO')
      result.current.stageEdgeCreateMany([{ source: 't1', target: 'r1' }], 'FLOWS_TO')
    })
    const drawn = () => useCanvasStore.getState().edges.filter((e) => e.id !== 'e0')
    expect(drawn().map((e) => e.id)).toContain(one)
    expect(drawn()).toHaveLength(2)
    expect(drawn().every((e) => e.data?.isPending === 'create')).toBe(true)
    // Collapsing a subtree drops the links a re-expand reads back — never these, which it can't.
    act(() => useCanvasStore.getState().removeEdgesByNodeIds(['t1']))
    expect(drawn()).toHaveLength(2)
  })
})

describe('reverseEdge', () => {
  it('draws the reversed line under a temp id, unsaved, for the save to mint its real one', () => {
    const { result } = renderHook(() => useCanvasInteractions())
    act(() => { result.current.reverseEdge('e0') })
    const [change] = useStagedChangesStore.getState().changes
    expect(change.type).toBe('reverse_edge')
    expect(change.targetId).toMatch(/^staged-edge/)
    expect(change.targetId).not.toContain('reversed')
    const reversed = useCanvasStore.getState().edges.find((e) => e.id === change.targetId)
    expect(reversed).toMatchObject({ source: 'r1', target: 't2', data: { isPending: 'create' } })
    expect(useCanvasStore.getState().edges.some((e) => e.id === 'e0')).toBe(false)
  })
})
