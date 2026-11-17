/**
 * Deleting several entities at once: staged together (one write, one Undo step), entities created
 * in the draft discarded instead, and — in a draft — what each takes with it read a few at a time
 * and filled in with one update.
 */
import { renderHook, act, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/providers/GraphProviderContext', () => ({ useGraphProvider: () => ({}) }))
const impact = vi.hoisted(() => ({ inFlight: 0, peak: 0 }))
vi.mock('@/services/versioningApiService', async (orig) => ({
  ...(await orig<typeof import('@/services/versioningApiService')>()),
  getDeleteImpact: vi.fn(async (_ws: string, _ds: string, _br: string, urn: string) => {
    impact.inFlight++
    impact.peak = Math.max(impact.peak, impact.inFlight)
    await new Promise((r) => setTimeout(r, 1))
    impact.inFlight--
    return { nodes: [{ urn }, { urn: `${urn}/child` }], edges: [], nodeTotal: 2, edgeTotal: 0 }
  }),
}))

import { useCanvasInteractions } from '../useCanvasInteractions'
import { useCanvasStore, type LineageNode } from '@/store/canvas'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { useBranchStore } from '@/store/branchStore'

const node = (id: string): LineageNode => ({ id, type: 'generic', position: { x: 0, y: 0 }, data: { urn: id, label: id } }) as unknown as LineageNode
const staged = () => useStagedChangesStore.getState()

beforeEach(() => {
  const nodes = [...Array.from({ length: 40 }, (_, i) => node(`n${i}`)), ...Array.from({ length: 40 }, (_, i) => node(`n${i}/child`)), node('new')]
  useCanvasStore.setState({ nodes, edges: [], _nodeIndex: new Set(nodes.map((n) => n.id)), selectedNodeIds: [], selectedEdgeIds: [] } as never)
  useStagedChangesStore.setState({
    changes: [{ id: 'c-new', type: 'create_entity', targetId: 'new', targetUrn: 'new', after: {}, summary: 'create', timestamp: 0 }],
    past: [], redoStack: [],
  } as never)
  useBranchStore.setState({ currentBranchId: 'br', graphId: 'g', dataSourceId: 'ds', workspaceId: 'ws' } as never)
  impact.inFlight = 0
  impact.peak = 0
})

describe('deleting a selection', () => {
  it('stages every delete at once, then fills in what each takes with it, a few at a time', async () => {
    const { result } = renderHook(() => useCanvasInteractions())
    act(() => useCanvasStore.setState({ selectedNodeIds: [...Array.from({ length: 40 }, (_, i) => `n${i}`), 'new'] }))
    const pastBefore = staged().past.length
    act(() => result.current.deleteSelected())

    const deletes = staged().changes.filter((c) => c.type === 'delete_entity')
    expect(deletes).toHaveLength(40)
    expect(staged().changes.some((c) => c.id === 'c-new')).toBe(false)   // a draft's own create is discarded
    expect(staged().past.length - pastBefore).toBe(1)
    expect(useCanvasStore.getState().nodes.find((n) => n.id === 'n3')!.data.isPending).toBe('delete')

    await waitFor(() => expect(staged().changes.find((c) => c.targetId === 'n7')!.summary).toMatch(/also removes 1 contained entity/))
    expect(impact.peak).toBeLessThanOrEqual(6)
    expect(useCanvasStore.getState().nodes.find((n) => n.id === 'n7/child')!.data.isPending).toBe('delete')

    // Undo takes the deletes back, and what they marked with them.
    act(() => { staged().undo() })
    expect(staged().changes.filter((c) => c.type === 'delete_entity')).toHaveLength(0)
    expect(useCanvasStore.getState().nodes.find((n) => n.id === 'n7/child')!.data.isPending).toBeUndefined()
  })
})
