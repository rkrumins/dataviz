/**
 * THE CANVAS'S ORPHANS PANEL (Display menu → Advanced → Orphaned entities…).
 *
 * The panel itself has its own suite (OrphansDrawer.test.tsx); here it is reduced to the props
 * the canvas hands it. What is under test is the canvas's side: the board is the same with the
 * panel closed or open, "where" reads the drawn column first and the view's own placement next
 * (under both settings of placementContractEnabled), and Place in layer is offered on a draft
 * only and pins, stages and draws the entity like any other layer move.
 */
import { act, fireEvent, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { LensWalkModel, LensWalkNode } from '@/components/canvas/context-view/lens/closure-adapter'
import type { GraphDataProvider, GraphNode } from '@/providers/GraphDataProvider'
import { useAuthStore } from '@/store/auth'
import { useFeaturesStore } from '@/store/features'
import { useReferenceModelStore } from '@/store/referenceModelStore'
import { useSchemaStore } from '@/store/schema'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { renderCanvasWithTrace, type TraceEstate } from '@/test/canvasHarness'
import type { ViewLayerConfig } from '@/types/schema'
import type { OrphansDrawerProps } from '../OrphansDrawer'

const captured: { drawer?: OrphansDrawerProps } = {}
vi.mock('@/components/canvas/context-view/OrphansDrawer', () => ({
  OrphansDrawer: (props: OrphansDrawerProps) => { captured.drawer = props; return null },
}))

const wn = (urn: string, name: string, type: string, childCount = 0): LensWalkNode => ({
  id: urn, type: 'default', position: { x: 0, y: 0 },
  data: { urn, label: name, type, childCount }, urn, displayName: name, entityType: type,
}) as unknown as LensWalkNode

const layers: ViewLayerConfig[] = [
  { id: 'L1', name: 'Domains', order: 0, entityTypes: ['domain'] },
  { id: 'L2', name: 'Tables', order: 1, entityTypes: ['table'] },
]

/** A domain holding a table, and an orphan table ("Orders") the board has not loaded. */
function estate(assignments: Record<string, { layerId: string }> = { D: { layerId: 'L1' } }): TraceEstate {
  const model: LensWalkModel = {
    focusUrn: 'D',
    nodes: [wn('D', 'Sales', 'domain', 1), wn('T', 'Invoices', 'table'), wn('O', 'Orders', 'table')],
    lineageEdges: [],
    containmentEdges: [{ sourceUrn: 'D', targetUrn: 'T' }],
    upstreamUrns: new Set(), downstreamUrns: new Set(), frontierUp: [], frontierDown: [],
    truncated: false, truncationReason: null, seedTruncated: false, seedCursor: null,
  }
  return { model, layers, assignments }
}

const graphNode = (urn: string, entityType: string): GraphNode =>
  ({ urn, displayName: urn, entityType, properties: {} }) as GraphNode

const columnOf = (id: string): string | null =>
  document.getElementById(`layer-node-${id}`)?.closest('[data-layer-id]')?.getAttribute('data-layer-id') ?? null

const viewAssignments = (): Record<string, { layerId: string }> =>
  (useSchemaStore.getState().getActiveView()?.layout?.referenceLayout?.assignments ?? {}) as Record<string, { layerId: string }>

/** A getTopLevelNodes the canvas itself must never call. */
function topLevelSpy() {
  const spy = vi.fn(async () => ({ nodes: [], totalCount: 0, hasMore: false, nextCursor: null, rootTypeCount: 0, orphanCount: 0 }))
  return { spy, wrap: (p: GraphDataProvider) => ({ ...p, getTopLevelNodes: spy }) as GraphDataProvider }
}

beforeEach(() => {
  captured.drawer = undefined
  useAuthStore.setState({ permissions: { global: ['system:admin'], ws: {} } } as never)
  useReferenceModelStore.setState({ assignmentStatus: 'idle', effectiveAssignments: new Map(), instanceAssignments: new Map() } as never)
  useStagedChangesStore.setState({ changes: [], redoStack: [], isReviewPanelOpen: false } as never)
})

describe('the canvas and its orphans panel', () => {
  it('leaves the board as it is, closed or open, and never lists top-level entities itself', async () => {
    const top = topLevelSpy()
    const h = await renderCanvasWithTrace(estate(), { focus: 'D', browseHolds: ['D', 'T'], wrapProvider: top.wrap })
    expect(captured.drawer?.open).toBe(false)
    const board = h.visibleCardIds()
    expect(board).not.toContain('O')

    fireEvent.click(screen.getByRole('button', { name: 'Display' }))
    fireEvent.click(screen.getByRole('button', { name: 'Orphaned entities…' }))
    await h.settle()
    expect(captured.drawer?.open).toBe(true)
    expect(h.visibleCardIds()).toEqual(board)
    expect(top.spy).not.toHaveBeenCalled()

    act(() => { captured.drawer!.onClose() })
    await h.settle()
    expect(captured.drawer?.open).toBe(false)
  })

  for (const placementContract of [false, true]) {
    describe(`placementContractEnabled ${placementContract ? 'on' : 'off'}`, () => {
      it('where: the drawn column first, else the view\'s own entry, else nowhere (curated)', async () => {
        const h = await renderCanvasWithTrace(estate({ D: { layerId: 'L1' }, 'urn:pinned': { layerId: 'L2' } }), {
          focus: 'D', browseHolds: ['D', 'T'], placementContract,
        })
        await h.settle()
        const layerOf = captured.drawer!.layerOf
        expect(layerOf(graphNode('D', 'domain'))).toEqual({ layerId: 'L1', drawn: true })
        expect(layerOf(graphNode('urn:pinned', 'table'))).toEqual({ layerId: 'L2', drawn: false })
        // Curated: a type rule places nothing.
        expect(layerOf(graphNode('urn:loose', 'table'))).toEqual({ layerId: undefined, drawn: false })
      })

      it('where: an open view\'s type rule places an entity the board has not loaded', async () => {
        const h = await renderCanvasWithTrace(estate(), { focus: 'D', browseHolds: ['D', 'T'], entityScope: 'all', placementContract })
        await h.settle()
        expect(captured.drawer!.layerOf(graphNode('urn:loose', 'table'))).toEqual({ layerId: 'L2', drawn: false })
      })

      it('Place in layer pins it, stages a move naming it, and draws it there', async () => {
        const h = await renderCanvasWithTrace(estate(), { focus: 'D', browseHolds: ['D', 'T'], draft: true, placementContract })
        expect(columnOf('O')).toBeNull()

        await act(async () => { captured.drawer!.onPlace!('O', 'L2') })
        await h.settle()

        expect(viewAssignments().O?.layerId).toBe('L2')
        const staged = useStagedChangesStore.getState().changes.filter(c => c.type === 'assign_layer' && c.targetId === 'O')
        expect(staged).toHaveLength(1)
        expect(staged[0].summary).toBe("Move 'Orders' → Tables")
        expect(columnOf('O')).toBe('L2')
        expect(captured.drawer!.layerOf(graphNode('O', 'table'))).toEqual({ layerId: 'L2', drawn: true })
      })
    })
  }

  it('offers no Place in layer off a draft', async () => {
    await renderCanvasWithTrace(estate(), { focus: 'D', browseHolds: ['D', 'T'] })
    expect(captured.drawer).toBeDefined()
    expect(captured.drawer!.onPlace).toBeUndefined()
  })

  it('offers Place in layer on a draft, whether or not graph editing is switched on', async () => {
    const h = await renderCanvasWithTrace(estate(), { focus: 'D', browseHolds: ['D', 'T'], draft: true })
    expect(captured.drawer?.onPlace).toBeTypeOf('function')
    // A layer pin is a view-layout write: the graph-editing switch does not gate it.
    act(() => {
      useFeaturesStore.setState({ values: { ...useFeaturesStore.getState().values, editModeEnabled: false } } as never)
    })
    await h.settle()
    expect(captured.drawer?.onPlace).toBeTypeOf('function')
  })

  it('withdraws Place in layer while a trace is running', async () => {
    const h = await renderCanvasWithTrace(estate(), { focus: 'D', browseHolds: ['D', 'T'], draft: true })
    expect(captured.drawer?.onPlace).toBeTypeOf('function')
    await h.startTrace('D')
    expect(h.isTracing()).toBe(true)
    expect(captured.drawer!.onPlace).toBeUndefined()
  })
})
