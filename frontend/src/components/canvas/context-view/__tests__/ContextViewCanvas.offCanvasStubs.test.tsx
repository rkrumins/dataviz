/**
 * A card's lineage on the real canvas, in and out of the view.
 *
 *   - Lineage that leaves the view has stubs; they follow the Missing-link
 *     alerts switch, and a click opens the Focus Lens on the stub's row.
 *   - Lineage into a row of an anchored column that is not loaded is in the
 *     view: selecting the card brings that row in, with nothing said.
 *
 * jsdom gives every row the same box, so the overlay never has room to paint
 * a stub; what the canvas hands the overlay for its stubs is read instead.
 */
import { act, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { OffCanvasLineage } from '@/hooks/useEdgeProjection'
import { renderCanvasWithTrace } from '@/test/canvasHarness'
import { anchoredPortsEstate, perTypeEstate } from '@/test/fixtures/traceEstates'
import { useAuthStore } from '@/store/auth'
import { useCanvasStore } from '@/store/canvas'
import { usePreferencesStore } from '@/store/preferences'
import { useNotificationStore } from '@/components/ui/notifications'
import type { GraphDataProvider } from '@/providers/GraphDataProvider'

const overlay = vi.hoisted(() => ({
  offCanvas: undefined as ReadonlyMap<string, OffCanvasLineage> | undefined,
  onOpen: undefined as ((nodeId: string) => void) | undefined,
}))
vi.mock('../LineageFlowOverlay', async (original) => {
  const real = await original<typeof import('../LineageFlowOverlay')>()
  return {
    ...real,
    LineageFlowOverlay: (props: Parameters<typeof real.LineageFlowOverlay>[0]) => {
      overlay.offCanvas = props.offCanvasLineage
      overlay.onOpen = props.onOpenOffCanvas
      return <real.LineageFlowOverlay {...props} />
    },
  }
})

beforeEach(() => {
  useAuthStore.setState({ permissions: { global: ['system:admin'], ws: {} } } as never)
  usePreferencesStore.setState({ showMissingConnectionIndicators: true, externalLineagePreview: false } as never)
  overlay.offCanvas = undefined
  overlay.onOpen = undefined
})

const flow = (source: string, target: string) => ({
  id: `f:${source}>${target}`, source, target, type: 'lineage',
  data: { edgeType: 'TRANSFORMS', relationship: 'TRANSFORMS' },
})

async function openView() {
  const estate = anchoredPortsEstate()
  const h = await renderCanvasWithTrace(estate, {
    focus: 'SRC.raw_orders',
    // s9 is a row of Staging past its loaded page; `far` is held by nothing.
    browseHolds: estate.model.nodes.map(n => n.urn).filter(urn => urn !== 's9' && urn !== 'far'),
    ancestorChains: true,
  })
  act(() => {
    useCanvasStore.getState().addGraph([], [flow('far', 'dash'), flow('s2', 's9')] as never)
  })
  await h.settle()
  return h
}

describe('stubs for lineage that leaves the view', () => {
  it('follow the Missing-link alerts switch', async () => {
    await openView()
    await waitFor(() => expect(overlay.offCanvas?.get('dash')?.in).toBe(1), { timeout: 8000 })

    act(() => { usePreferencesStore.setState({ showMissingConnectionIndicators: false } as never) })
    await waitFor(() => expect(overlay.offCanvas).toBeUndefined())

    act(() => { usePreferencesStore.setState({ showMissingConnectionIndicators: true } as never) })
    await waitFor(() => expect(overlay.offCanvas?.get('dash')?.in).toBe(1))
  }, 20_000)
})

describe('a card\'s lines into rows of an anchored column that are not loaded', () => {
  it('selecting the card brings those rows in, and says nothing about it', async () => {
    const h = await openView()
    await waitFor(() => expect(overlay.offCanvas?.get('s2')?.columns.get('stg')?.outPartners.has('s9')).toBe(true),
      { timeout: 8000 })
    expect(h.visibleCardIds()).not.toContain('s9')
    const said = useNotificationStore.getState().notifications.length

    act(() => { useCanvasStore.getState().selectNode('s2') })

    await waitFor(() => expect(h.visibleCardIds()).toContain('s9'), { timeout: 8000 })
    await h.settle()
    expect(useNotificationStore.getState().notifications).toHaveLength(said)
    expect(h.consoleErrors()).toEqual([])
  }, 20_000)

  it('a row that could not be brought in is asked again once, after a wait', async () => {
    const estate = anchoredPortsEstate()
    // The first read of s9's path fails; the reveal lands nothing.
    let failures = 1
    const h = await renderCanvasWithTrace(estate, {
      focus: 'SRC.raw_orders',
      browseHolds: estate.model.nodes.map(n => n.urn).filter(urn => urn !== 's9' && urn !== 'far'),
      ancestorChains: true,
      wrapProvider: p => ({
        ...p,
        getNodes: async (query: Parameters<typeof p.getNodes>[0]) => {
          if (query.urns?.includes('s9') && failures-- > 0) throw new Error('503 Service Unavailable')
          return p.getNodes(query)
        },
      }) as typeof p,
    })
    act(() => { useCanvasStore.getState().addGraph([], [flow('s2', 's9')] as never) })
    await waitFor(() => expect(overlay.offCanvas?.get('s2')?.columns.get('stg')?.outPartners.has('s9')).toBe(true),
      { timeout: 8000 })

    act(() => { useCanvasStore.getState().selectNode('s2') })

    await waitFor(() => expect(h.visibleCardIds()).toContain('s9'), { timeout: 12_000 })
    expect(failures).toBe(-1)
  }, 30_000)

  it('and only once: a row that misses twice is left for the next selection', async () => {
    const estate = anchoredPortsEstate()
    let reads = 0
    await renderCanvasWithTrace(estate, {
      focus: 'SRC.raw_orders',
      browseHolds: estate.model.nodes.map(n => n.urn).filter(urn => urn !== 's9' && urn !== 'far'),
      ancestorChains: true,
      wrapProvider: p => ({
        ...p,
        getNodes: async (query: Parameters<typeof p.getNodes>[0]) => {
          if (query.urns?.includes('s9')) { reads += 1; throw new Error('503 Service Unavailable') }
          return p.getNodes(query)
        },
      }) as typeof p,
    })
    act(() => { useCanvasStore.getState().addGraph([], [flow('s2', 's9')] as never) })
    await waitFor(() => expect(overlay.offCanvas?.get('s2')?.columns.get('stg')?.outPartners.has('s9')).toBe(true),
      { timeout: 8000 })

    act(() => { useCanvasStore.getState().selectNode('s2') })

    await waitFor(() => expect(reads).toBe(2), { timeout: 12_000 })
    await act(async () => { await new Promise(r => setTimeout(r, 6000)) })
    expect(reads).toBe(2)
  }, 40_000)
})

describe('selecting cards the view opened with', () => {
  // Nothing is added by hand: the flows come the way the app reads them,
  // from the provider, and only because a card was selected.
  async function openWithFlows(flows: Array<{ sourceUrn: string; targetUrn: string }>,
    wrapProvider?: (provider: GraphDataProvider) => GraphDataProvider) {
    const estate = anchoredPortsEstate()
    // s9 and `uncounted` are rows of Staging and Report past their loaded page.
    const unloaded = new Set(['s9', 'uncounted', 'far'])
    const h = await renderCanvasWithTrace(estate, {
      focus: 'SRC.raw_orders',
      browseHolds: estate.model.nodes.map(n => n.urn).filter(urn => !unloaded.has(urn)),
      ancestorChains: true,
      flows,
      wrapProvider,
    })
    await h.settle()
    return h
  }

  it('a row whose read failed is read again when selected again', async () => {
    let shedding = true
    let reads = 0
    const h = await openWithFlows([{ sourceUrn: 's2', targetUrn: 's9' }], p => ({
      ...p,
      getEdges: async (q: Parameters<GraphDataProvider['getEdges']>[0]) => {
        reads++
        if (shedding) throw Object.assign(new Error('shed'), { status: 429 })
        return p.getEdges(q)
      },
    }) as GraphDataProvider)

    act(() => { useCanvasStore.getState().selectNode('s2') })
    await waitFor(() => expect(reads).toBeGreaterThan(0), { timeout: 8000 })
    await h.settle()
    // Not again while it stays selected.
    const failedReads = reads
    await act(async () => { await new Promise(r => setTimeout(r, 1000)) })
    expect(reads).toBe(failedReads)

    shedding = false
    act(() => { useCanvasStore.getState().clearSelection() })
    await h.settle()
    act(() => { useCanvasStore.getState().selectNode('s2') })

    await waitFor(() => expect(h.visibleCardIds()).toContain('s9'), { timeout: 8000 })
  }, 30_000)

  it('a row whose flows a collapse pruned reads them again when selected', async () => {
    const h = await openWithFlows([{ sourceUrn: 'SRC.DB_B.t2', targetUrn: 'rpt' }])
    await h.toggle('SRC.DB_B')
    await waitFor(() => expect(h.visibleCardIds()).toContain('SRC.DB_B.t2'), { timeout: 8000 })
    act(() => { useCanvasStore.getState().selectNode('rpt') })
    await waitFor(() => expect(h.wires()).toContainEqual({ source: 'SRC.DB_B.t2', target: 'rpt' }), { timeout: 8000 })
    act(() => { useCanvasStore.getState().clearSelection() })
    await h.settle()

    await h.toggle('SRC.DB_B')
    await waitFor(() => {
      expect(useCanvasStore.getState().edges.map(e => e.id)).not.toContain('f:SRC.DB_B.t2>rpt')
    }, { timeout: 8000 })
    act(() => { useCanvasStore.getState().selectNode('rpt') })

    await waitFor(() => expect(h.wires()).toContainEqual({ source: 'SRC.DB_B', target: 'rpt' }), { timeout: 8000 })
  }, 30_000)

  it('a row on a first page reads its own flows, and brings in the rows they reach', async () => {
    const h = await openWithFlows([{ sourceUrn: 's2', targetUrn: 's9' }])
    expect(h.visibleCardIds()).not.toContain('s9')

    act(() => { useCanvasStore.getState().selectNode('s2') })

    await waitFor(() => expect(h.visibleCardIds()).toContain('s9'), { timeout: 8000 })
    await h.settle()
    expect(h.consoleErrors()).toEqual([])
  }, 20_000)

  it('with several selected, brings in the rows of each', async () => {
    const h = await openWithFlows([
      { sourceUrn: 's2', targetUrn: 's9' },
      { sourceUrn: 'SRC.raw_orders', targetUrn: 'uncounted' },
    ])

    act(() => { useCanvasStore.getState().selectNode('s2') })
    await waitFor(() => expect(h.visibleCardIds()).toContain('s9'), { timeout: 8000 })
    act(() => { useCanvasStore.getState().selectNode('SRC.raw_orders', true) })

    await waitFor(() => expect(h.visibleCardIds()).toContain('uncounted'), { timeout: 8000 })
    await h.settle()
    expect(h.consoleErrors()).toEqual([])
  }, 20_000)

  it('a row brought in reads its own flows, so its other lines draw', async () => {
    const h = await openWithFlows([
      { sourceUrn: 's2', targetUrn: 's9' },
      { sourceUrn: 's9', targetUrn: 'dash' },
    ])

    act(() => { useCanvasStore.getState().selectNode('s2') })

    await waitFor(() => expect(h.visibleCardIds()).toContain('s9'), { timeout: 8000 })
    await waitFor(() => expect(useCanvasStore.getState().edges.some(e => e.id === 'f:s9>dash')).toBe(true), { timeout: 8000 })
    await h.settle()
    expect(h.consoleErrors()).toEqual([])
  }, 20_000)
})

describe('selecting a card in a view open to its whole data source', () => {
  it("brings in the row its flows reach past its type column's page", async () => {
    const h = await renderCanvasWithTrace(perTypeEstate(), {
      focus: 'src1',
      entityScope: 'all',
      browseHolds: ['src1', 'src2', 'rep1', 'rep2'],
      ancestorChains: true,
      flows: [{ sourceUrn: 'src1', targetUrn: 'rep9' }],
    })
    await h.settle()
    expect(h.visibleCardIds()).not.toContain('rep9')

    act(() => { useCanvasStore.getState().selectNode('src1') })

    await waitFor(() => expect(h.visibleCardIds()).toContain('rep9'), { timeout: 8000 })
    await waitFor(() => expect(h.wires()).toContainEqual({ source: 'src1', target: 'rep9' }), { timeout: 8000 })
  }, 30_000)
})

describe('a stub\'s click', () => {
  it('opens the Focus Lens on its row', async () => {
    await openView()
    await waitFor(() => expect(overlay.onOpen).toBeDefined())

    act(() => { overlay.onOpen!('dash') })

    expect(await screen.findByRole('dialog', { name: /Connections of dash/ })).toBeInTheDocument()
  }, 20_000)
})

describe('the external preview', () => {
  it('lists only the partners outside the view, never a row the view holds', async () => {
    usePreferencesStore.setState({ externalLineagePreview: true } as never)
    const estate = anchoredPortsEstate()
    // Into dash: from `far`, held by nothing, and from s9, a row of Staging
    // past its loaded page.
    const into = [{ sourceUrn: 'far', targetUrn: 'dash' }, { sourceUrn: 's9', targetUrn: 'dash' }]
    const h = await renderCanvasWithTrace(estate, {
      focus: 'SRC.raw_orders',
      browseHolds: estate.model.nodes.map(n => n.urn).filter(urn => urn !== 's9' && urn !== 'far'),
      ancestorChains: true,
      flows: into,
    })
    act(() => {
      useCanvasStore.getState().addGraph([], into.map(f => flow(f.sourceUrn, f.targetUrn)) as never)
    })
    await h.settle()
    await waitFor(() => expect(overlay.offCanvas?.get('dash')?.columns.get('stg')?.inPartners.has('s9')).toBe(true),
      { timeout: 8000 })

    act(() => { overlay.onOpen!('dash') })

    const heading = await screen.findByText('Outside this view')
    const preview = heading.closest('div.border-dashed')!
    await waitFor(() => expect(preview.textContent).toContain('1 entity'))
    expect(preview.textContent).toContain('far')
    expect(preview.textContent).not.toContain('s9')
  }, 20_000)
})
