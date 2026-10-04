/**
 * THE CANVAS UNDER THE ONE PLACEMENT CONTRACT (placementContractEnabled).
 *
 * With the flag on, the canvas compiles one spec from the layers it renders and places every
 * loaded entity locally: the backend compute is never asked, a hand placement on an ancestor the
 * canvas never loaded still reaches a deep entity (through its fetched chain), a child its own
 * rule puts in another column carries the Placed tag naming why, rail and Build Mode pin a new
 * entity only when the view is curated or the contract would place it elsewhere, and the drawer's
 * auto-scroll follows the column an entity is actually drawn in.
 */
import { act, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { LensWalkModel, LensWalkNode } from '@/components/canvas/context-view/lens/closure-adapter'
import { useHierarchyBuilderStore } from '@/components/canvas/create/hierarchyBuilderStore'
import type { BuildRow } from '@/components/canvas/create/buildmode/buildRow'
import type { GraphDataProvider } from '@/providers/GraphDataProvider'
import { useAuthStore } from '@/store/auth'
import { useCanvasStore } from '@/store/canvas'
import { useReferenceModelStore } from '@/store/referenceModelStore'
import { useSchemaStore } from '@/store/schema'
import { renderCanvasWithTrace, type TraceEstate } from '@/test/canvasHarness'
import type { ViewLayerConfig } from '@/types/schema'

// The creation panels, reduced to the callbacks the canvas hands them: what is under test is the
// canvas's placement of what they stage, not their own UI.
const captured: {
  rail?: { onEntityStaged?: (tempUrn: string, parentUrn?: string) => void }
  build?: { onRowStaged?: (row: BuildRow, urn: string, hasParent: boolean) => void }
} = {}
vi.mock('@/components/canvas/create/HierarchyBuilderPanel', () => ({
  HierarchyBuilderPanel: (props: typeof captured.rail) => { captured.rail = props; return null },
}))
vi.mock('@/components/canvas/create/buildmode/BuildPanel', () => ({
  BuildPanel: (props: typeof captured.build) => { captured.build = props; return null },
}))

const wn = (urn: string, type: string, childCount = 0): LensWalkNode => ({
  id: urn, type: 'default', position: { x: 0, y: 0 },
  data: { urn, label: urn, type, childCount }, urn, displayName: urn, entityType: type,
}) as unknown as LensWalkNode

function estate(nodes: LensWalkNode[], containment: [string, string][], layers: ViewLayerConfig[],
  assignments: Record<string, { layerId: string }> = {}): TraceEstate {
  const model: LensWalkModel = {
    focusUrn: nodes[0].urn, nodes, lineageEdges: [],
    containmentEdges: containment.map(([sourceUrn, targetUrn]) => ({ sourceUrn, targetUrn })),
    upstreamUrns: new Set(), downstreamUrns: new Set(), frontierUp: [], frontierDown: [],
    truncated: false, truncationReason: null, seedTruncated: false, seedCursor: null,
  }
  return { model, layers, assignments }
}

const layer = (id: string, name: string, order: number, entityTypes: string[] = []): ViewLayerConfig =>
  ({ id, name, order, entityTypes })

/** A container in Left; its dataset, by type, in Right. */
const splitByRule = (assignments: Record<string, { layerId: string }> = {}) => estate(
  [wn('P', 'container', 1), wn('K', 'dataset')], [['P', 'K']],
  [layer('left', 'Left', 0, ['container']), layer('right', 'Right', 1, ['dataset'])], assignments,
)

const columnOf = (id: string): string | null =>
  document.getElementById(`layer-node-${id}`)?.closest('[data-layer-id]')?.getAttribute('data-layer-id') ?? null

const viewAssignments = (): Record<string, { layerId: string }> =>
  (useSchemaStore.getState().getActiveView()?.layout?.referenceLayout?.assignments ?? {}) as Record<string, { layerId: string }>

function computeSpy() {
  const spy = vi.fn()
  const wrap = (provider: GraphDataProvider): GraphDataProvider => {
    spy.mockImplementation(provider.computeLayerAssignments.bind(provider))
    return { ...provider, computeLayerAssignments: spy } as GraphDataProvider
  }
  return { spy, wrap }
}

beforeEach(() => {
  useAuthStore.setState({ permissions: { global: ['system:admin'], ws: {} } } as never)
  // A previous mount leaves the assignment store settled; each test starts where a fresh view does.
  useReferenceModelStore.setState({ assignmentStatus: 'idle', effectiveAssignments: new Map(), instanceAssignments: new Map() } as never)
})

afterEach(() => {
  useHierarchyBuilderStore.setState({ isOpen: false, layerId: null, parentUrn: null, surface: 'rail' } as never)
})

describe('the canvas under the One Placement Contract', () => {
  it('never asks the backend to compute placements (and still does with the flag off)', async () => {
    const off = computeSpy()
    await renderCanvasWithTrace(splitByRule({ P: { layerId: 'left' } }), { focus: 'P', entityScope: 'all', wrapProvider: off.wrap })
    await waitFor(() => expect(off.spy).toHaveBeenCalled())

    useReferenceModelStore.setState({ assignmentStatus: 'idle' } as never)
    const on = computeSpy()
    const h = await renderCanvasWithTrace(splitByRule({ P: { layerId: 'left' } }), {
      focus: 'P', entityScope: 'all', wrapProvider: on.wrap, placementContract: true,
    })
    await h.settle()
    expect(on.spy).not.toHaveBeenCalled()
    expect(columnOf('P')).toBe('left')
  })

  it('a hand placement on an ancestor the canvas never loaded reaches a deep entity through its chain', async () => {
    const e = estate(
      [wn('C', 'column'), wn('T', 'table', 1), wn('D', 'domain', 1)], [['D', 'T'], ['T', 'C']],
      [layer('left', 'Left', 0, ['column']), layer('right', 'Right', 1)], { D: { layerId: 'right' } },
    )
    const h = await renderCanvasWithTrace(e, {
      focus: 'C', entityScope: 'all', browseHolds: ['C'], ancestorChains: true, placementContract: true,
    })
    await waitFor(() => expect(columnOf('C')).toBe('right'), { timeout: 4000 })
    expect(h.chainRequests().flat()).toContain('C')
  })

  it('a child its own rule puts in another column carries the Placed tag, saying a layer rule placed it', async () => {
    await renderCanvasWithTrace(splitByRule(), { focus: 'P', entityScope: 'all', placementContract: true })
    expect(columnOf('K')).toBe('right')
    const tag = document.querySelector<HTMLElement>('#layer-node-K button[title^="Placed in"]')
    expect(tag?.textContent).toContain('Placed')
    expect(tag?.getAttribute('title')).toMatch(/^Placed in Right by a layer rule for this view only/)
  })

  it('a child placed by hand says so', async () => {
    await renderCanvasWithTrace(estate(
      [wn('P', 'container', 1), wn('K', 'dataset')], [['P', 'K']],
      [layer('left', 'Left', 0, ['container']), layer('right', 'Right', 1)], { K: { layerId: 'right' } },
    ), { focus: 'P', entityScope: 'all', placementContract: true })
    expect(columnOf('K')).toBe('right')
    expect(document.querySelector('#layer-node-K button[title^="Placed in"]')?.getAttribute('title'))
      .toMatch(/^Placed in Right by hand for this view only/)
  })

  describe('rail and Build Mode pin a new root only when they must', () => {
    const stagedNode = (urn: string, type: string) => ({
      id: urn, type: 'generic', position: { x: 0, y: 0 },
      data: { urn, label: urn, type, classifications: [], properties: {} },
    })
    const row = (id: string, typeId: string, extra: Partial<BuildRow> = {}): BuildRow => ({
      id, name: id, typeId, parentId: null, depth: 0, status: 'valid', issues: [], fixes: [], ...extra,
    })

    async function openRail(h: Awaited<ReturnType<typeof renderCanvasWithTrace>>, layerId: string | null) {
      act(() => { useHierarchyBuilderStore.setState({ isOpen: true, surface: 'rail', layerId, parentUrn: null } as never) })
      await h.settle()
    }
    function stageOnRail(urn: string, type: string) {
      act(() => {
        useCanvasStore.getState().addNodes([stagedNode(urn, type)] as never)
        captured.rail!.onEntityStaged!(urn)
      })
    }

    it('rail, open view: no entry where the rule already places it; an entry where it would not', async () => {
      const h = await renderCanvasWithTrace(splitByRule(), { focus: 'P', entityScope: 'all', placementContract: true })
      await openRail(h, 'right')
      stageOnRail('urn:staged:dataset:a', 'dataset')
      expect(viewAssignments()['urn:staged:dataset:a']).toBeUndefined()
      stageOnRail('urn:staged:container:b', 'container')
      expect(viewAssignments()['urn:staged:container:b']?.layerId).toBe('right')
    })

    it('rail, curated view: always an entry', async () => {
      const h = await renderCanvasWithTrace(splitByRule({ P: { layerId: 'left' } }), { focus: 'P', placementContract: true })
      await openRail(h, 'right')
      stageOnRail('urn:staged:dataset:c', 'dataset')
      expect(viewAssignments()['urn:staged:dataset:c']?.layerId).toBe('right')
    })

    it('Build, open view: the row\'s own choice or the contract; the Build layer only for what nothing places', async () => {
      const h = await renderCanvasWithTrace(splitByRule(), { focus: 'P', entityScope: 'all', placementContract: true })
      act(() => { useHierarchyBuilderStore.setState({ isOpen: true, surface: 'build', layerId: 'left', parentUrn: null } as never) })
      await h.settle()
      act(() => {
        captured.build!.onRowStaged!(row('r1', 'dataset'), 'urn:staged:dataset:r1', false)
        captured.build!.onRowStaged!(row('r2', 'misc'), 'urn:staged:misc:r2', false)
        captured.build!.onRowStaged!(row('r3', 'container', { layerId: 'right' }), 'urn:staged:container:r3', false)
      })
      expect(viewAssignments()['urn:staged:dataset:r1']).toBeUndefined()
      expect(viewAssignments()['urn:staged:misc:r2']?.layerId).toBe('left')
      expect(viewAssignments()['urn:staged:container:r3']?.layerId).toBe('right')
    })
  })

  it('auto-scrolls to the column an entity is drawn in', async () => {
    const h = await renderCanvasWithTrace(splitByRule(), { focus: 'P', entityScope: 'all', placementContract: true })
    expect(columnOf('K')).toBe('right')
    // Right sits past the viewport's right edge; nothing else moves.
    const real = Element.prototype.getBoundingClientRect
    const scrollTo = vi.spyOn(Element.prototype, 'scrollTo')
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const rect = real.call(this)
      return this.getAttribute('data-layer-id') === 'right' ? { ...rect, left: 1080, right: 1500 } as DOMRect : rect
    }
    try {
      act(() => { useCanvasStore.getState().selectNode('K') })
      await h.settle()
      const smooth = scrollTo.mock.calls.map(([arg]) => arg as ScrollToOptions).filter(o => o?.behavior === 'smooth')
      expect(smooth.some(o => (o.left ?? 0) > 1000)).toBe(true)
    } finally {
      Element.prototype.getBoundingClientRect = real
      scrollTo.mockRestore()
    }
  })
})
