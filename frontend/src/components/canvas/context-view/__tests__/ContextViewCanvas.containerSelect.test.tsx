/**
 * SELECTING A COLLAPSED CONTAINER DRAWS ITS LINES — on the real canvas.
 *
 * A closed container's lineage is its rows', and the canvas asks for
 * roll-ups only among the rows it draws and the rows it holds past a page.
 * A container whose partners are rows past another column's page that no
 * holder cell names, or rows no line reaches yet, had lineage and no line:
 * selecting it drew nothing and brought nothing in. Selecting it now asks
 * for all of its roll-ups — out with no target named, in with no source
 * named — and places each far end through its chain: a row past another
 * column's page is brought in (strongest first), a row inside a closed row
 * on the canvas gets a roll-up line to that row, and only an end outside
 * the view makes the port hollow.
 *
 * One partner is brought in per selection here, so the one that comes
 * first shows.
 */
import { act, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { renderCanvasWithTrace } from '@/test/canvasHarness'
import { anchoredPortsEstate, groupAndAnchorEstate } from '@/test/fixtures/traceEstates'
import { useAuthStore } from '@/store/auth'
import { useCanvasStore } from '@/store/canvas'
import type { AggregatedEdgeRequest, GraphDataProvider } from '@/providers/GraphDataProvider'

vi.mock('@/hooks/useRevealPartners', async (original) => ({
  ...(await original<typeof import('@/hooks/useRevealPartners')>()),
  REVEAL_PARTNERS_CAP: 1,
}))

beforeEach(() => {
  useAuthStore.setState({ permissions: { global: ['system:admin'], ws: {} } } as never)
})

/** `kind:dir` of the card's port on each side, or null for no port. */
function ports(id: string): { left: string | null; right: string | null } {
  const at = (side: 'left' | 'right') => {
    const el = document.getElementById(`layer-node-${id}`)?.querySelector<HTMLElement>(`[data-lineage-port="${side}"]`)
    return el ? `${el.dataset.port}:${el.dataset.dir}` : null
  }
  return { left: at('left'), right: at('right') }
}

const rollUp = (sourceUrn: string, targetUrn: string, edgeCount = 1) => ({
  id: `agg-${sourceUrn}-${targetUrn}`, sourceUrn, targetUrn, edgeCount,
  edgeTypes: ['TRANSFORMS'], confidence: 1, sourceEdgeIds: [],
})

/** s9 is a row of Staging past its loaded page (s2 too, when asked); `far`
 *  is held by nothing. */
function open(opts: {
  degrees: Parameters<typeof renderCanvasWithTrace>[1]['nodeDegrees']
  cells: ReturnType<typeof rollUp>[]
  unloaded?: string[]
}) {
  const estate = anchoredPortsEstate()
  const unloaded = new Set(['s9', 'far', ...(opts.unloaded ?? [])])
  return renderCanvasWithTrace(estate, {
    focus: 'SRC.raw_orders',
    browseHolds: estate.model.nodes.map(n => n.urn).filter(urn => !unloaded.has(urn)),
    ancestorChains: true,
    nodeDegrees: opts.degrees,
    aggregatedCells: opts.cells,
  })
}

/** Each /edges/aggregated ask as [sources, targets]. */
const asksOf = (h: Awaited<ReturnType<typeof open>>) =>
  h.aggregatedSources().map((sources, i) => [sources, h.aggregatedTargets()[i]])

describe('selecting a collapsed container', () => {
  it("brings in the row its roll-ups reach past another column's page, and draws to it", async () => {
    const h = await open({
      degrees: { 'SRC.DB_A': { in: 0, out: 0, rollupIn: 0, rollupOut: 3 } },
      // SRC.DB_A → s9; to a holder ask, SRC.DB_A → Staging's anchor.
      cells: [rollUp('SRC.DB_A', 'STG', 3), rollUp('SRC.DB_A', 's9', 3)],
    })
    await waitFor(() => expect(ports('SRC.DB_A').right).toBe('here:out'), { timeout: 8000 })
    expect(h.visibleCardIds()).not.toContain('s9')

    act(() => { useCanvasStore.getState().selectNode('SRC.DB_A') })

    await waitFor(() => expect(h.visibleCardIds()).toContain('s9'), { timeout: 8000 })
    await waitFor(() => expect(h.wires()).toContainEqual({ source: 'SRC.DB_A', target: 's9' }), { timeout: 8000 })
    // Its roll-ups out: from it, no target named.
    expect(asksOf(h)).toContainEqual([['SRC.DB_A'], []])
    expect(h.consoleErrors()).toEqual([])
  }, 30_000)

  it('asks what flows into it with no source named, and draws from the row that reaches it', async () => {
    const h = await open({
      degrees: { 'SRC.DB_B': { in: 0, out: 0, rollupIn: 2, rollupOut: 0 } },
      cells: [rollUp('s9', 'SRC.DB_B', 2)],
    })
    await waitFor(() => expect(ports('SRC.DB_B')).toEqual({ left: 'lineage:in', right: null }), { timeout: 8000 })

    act(() => { useCanvasStore.getState().selectNode('SRC.DB_B') })

    await waitFor(() => expect(h.visibleCardIds()).toContain('s9'), { timeout: 8000 })
    await waitFor(() => expect(h.wires()).toContainEqual({ source: 's9', target: 'SRC.DB_B' }), { timeout: 8000 })
    expect(asksOf(h)).toContainEqual([[], ['SRC.DB_B']])
  }, 30_000)

  it('brings in its strongest partner first', async () => {
    const h = await open({
      degrees: { 'SRC.DB_A': { in: 0, out: 0, rollupIn: 0, rollupOut: 6 } },
      unloaded: ['s2'],
      cells: [rollUp('SRC.DB_A', 's2', 1), rollUp('SRC.DB_A', 's9', 5)],
    })
    await waitFor(() => expect(ports('SRC.DB_A').right).not.toBeNull(), { timeout: 8000 })

    act(() => { useCanvasStore.getState().selectNode('SRC.DB_A') })

    await waitFor(() => expect(h.visibleCardIds()).toContain('s9'), { timeout: 8000 })
    await h.settle()
    expect(h.visibleCardIds()).not.toContain('s2')
  }, 30_000)

  it('draws to its partner past a page however many heavier cells it has with rows it holds', async () => {
    const estate = anchoredPortsEstate()
    // Cells to rows it holds that the canvas never loaded, heavier than its
    // one partner's: the server leaves them out when asked to.
    const inner = Array.from({ length: 260 }, (_, i) => rollUp('SRC.DB_A', `SRC.DB_A.hidden_${i}`, 10))
    const h = await renderCanvasWithTrace(estate, {
      focus: 'SRC.raw_orders',
      browseHolds: estate.model.nodes.map(n => n.urn).filter(urn => urn !== 's9' && urn !== 'far'),
      ancestorChains: true,
      nodeDegrees: { 'SRC.DB_A': { in: 0, out: 0, rollupIn: 0, rollupOut: 1 } },
      aggregatedCells: [rollUp('SRC.DB_A', 's9', 1)],
      wrapProvider: (p: GraphDataProvider) => ({
        ...p,
        getAggregatedEdges: async (req: AggregatedEdgeRequest) => {
          const answer = await p.getAggregatedEdges(req)
          const own = req.targetUrns === undefined && req.sourceUrns.includes('SRC.DB_A')
          return own && !req.excludeInternal ? { ...answer, aggregatedEdges: [...inner, ...answer.aggregatedEdges] } : answer
        },
      }) as GraphDataProvider,
    })
    await waitFor(() => expect(ports('SRC.DB_A').right).toBe('lineage:out'), { timeout: 8000 })

    act(() => { useCanvasStore.getState().selectNode('SRC.DB_A') })

    await waitFor(() => expect(h.visibleCardIds()).toContain('s9'), { timeout: 8000 })
    await waitFor(() => expect(h.wires()).toContainEqual({ source: 'SRC.DB_A', target: 's9' }), { timeout: 8000 })
  }, 30_000)

  it('draws a roll-up line to the closed row on the canvas that holds a far end', async () => {
    const h = await open({
      degrees: { 'SRC.DB_A': { in: 0, out: 0, rollupIn: 0, rollupOut: 1 } },
      // Into a row of SRC.DB_B, which the canvas draws closed.
      cells: [rollUp('SRC.DB_A', 'SRC.DB_B.t2', 1)],
    })
    await waitFor(() => expect(ports('SRC.DB_A')).toEqual({ left: null, right: 'lineage:out' }), { timeout: 8000 })

    act(() => { useCanvasStore.getState().selectNode('SRC.DB_A') })

    await waitFor(() => expect(h.wires()).toContainEqual({ source: 'SRC.DB_A', target: 'SRC.DB_B' }), { timeout: 8000 })
  }, 30_000)

  it('asks even with a line of its own drawn, when a column holds more of its lineage', async () => {
    const h = await open({
      degrees: { 'SRC.DB_A': { in: 0, out: 0, rollupIn: 0, rollupOut: 1 } },
      // rpt is drawn; Staging holds four flows past its page, s9's.
      cells: [rollUp('SRC.DB_A', 'rpt', 1), rollUp('SRC.DB_A', 'STG', 4), rollUp('SRC.DB_A', 's9', 4)],
    })
    await waitFor(() => expect(ports('SRC.DB_A').right).toBe('here:out'), { timeout: 8000 })

    act(() => { useCanvasStore.getState().selectNode('SRC.DB_A') })

    await waitFor(() => expect(h.wires()).toContainEqual({ source: 'SRC.DB_A', target: 'rpt' }), { timeout: 8000 })
    await waitFor(() => expect(asksOf(h)).toContainEqual([['SRC.DB_A'], []]), { timeout: 8000 })
    await waitFor(() => expect(h.visibleCardIds()).toContain('s9'), { timeout: 8000 })
    await waitFor(() => expect(h.wires()).toContainEqual({ source: 'SRC.DB_A', target: 's9' }), { timeout: 8000 })
  }, 30_000)

  it('reads hollow once every far end its roll-ups name is outside the view, and not before', async () => {
    const h = await open({
      degrees: { 'SRC.DB_A': { in: 0, out: 0, rollupIn: 0, rollupOut: 1 } },
      cells: [rollUp('SRC.DB_A', 'far', 1)],
    })
    await waitFor(() => expect(ports('SRC.DB_A')).toEqual({ left: null, right: 'lineage:out' }), { timeout: 8000 })
    await h.settle()
    expect(ports('SRC.DB_A')).toEqual({ left: null, right: 'lineage:out' })

    act(() => { useCanvasStore.getState().selectNode('SRC.DB_A') })

    await waitFor(() => expect(ports('SRC.DB_A')).toEqual({ left: null, right: 'beyond:out' }), { timeout: 8000 })
  }, 30_000)

  it('with a flow of its own, reads hollow once its roll-ups all lead outside', async () => {
    const h = await open({
      // A cube server flags it: its own flow is a cell too.
      degrees: { 'SRC.DB_A': { in: 0, out: 1, rollupIn: 0, rollupOut: 1 } },
      cells: [rollUp('SRC.DB_A', 'far', 1)],
    })
    await waitFor(() => expect(ports('SRC.DB_A')).toEqual({ left: null, right: 'lineage:out' }), { timeout: 8000 })
    await h.settle()

    act(() => { useCanvasStore.getState().selectNode('SRC.DB_A') })

    await waitFor(() => expect(ports('SRC.DB_A')).toEqual({ left: null, right: 'beyond:out' }), { timeout: 8000 })
  }, 30_000)

  it('an answer cut short never makes it hollow: what it left out may be in the view', async () => {
    const estate = anchoredPortsEstate()
    const h = await renderCanvasWithTrace(estate, {
      focus: 'SRC.raw_orders',
      browseHolds: estate.model.nodes.map(n => n.urn).filter(urn => urn !== 's9' && urn !== 'far'),
      ancestorChains: true,
      nodeDegrees: { 'SRC.DB_A': { in: 0, out: 0, rollupIn: 0, rollupOut: 1 } },
      aggregatedCells: [rollUp('SRC.DB_A', 'far', 1)],
      // Its own roll-ups out come back at the server's cap.
      wrapProvider: (p: GraphDataProvider) => ({
        ...p,
        getAggregatedEdges: async (req: AggregatedEdgeRequest) => {
          const answer = await p.getAggregatedEdges(req)
          return req.targetUrns === undefined ? { ...answer, truncated: true, truncationReason: null } : answer
        },
      }) as GraphDataProvider,
    })
    await waitFor(() => expect(ports('SRC.DB_A')).toEqual({ left: null, right: 'lineage:out' }), { timeout: 8000 })

    act(() => { useCanvasStore.getState().selectNode('SRC.DB_A') })

    await waitFor(() => expect(asksOf(h)).toContainEqual([['SRC.DB_A'], []]), { timeout: 8000 })
    await h.settle()
    await act(async () => { await new Promise(r => setTimeout(r, 1500)) })
    expect(ports('SRC.DB_A')).toEqual({ left: null, right: 'lineage:out' })
  }, 30_000)
})

describe('selecting a closed logical group', () => {
  /** s9 is a row of Staging past its loaded page; `far` is held by nothing. */
  async function openGroup(opts: Pick<Parameters<typeof renderCanvasWithTrace>[1], 'nodeDegrees' | 'aggregatedCells' | 'flows' | 'wrapProvider'>) {
    const estate = groupAndAnchorEstate()
    const h = await renderCanvasWithTrace(estate, {
      focus: 'solo',
      browseHolds: estate.model.nodes.map(n => n.urn).filter(urn => urn !== 's9' && urn !== 'far'),
      ancestorChains: true,
      ...opts,
    })
    await waitFor(() => expect(h.visibleCardIds()).toContain('g.a'), { timeout: 8000 })
    await h.toggle('logical:grp')
    await waitFor(() => expect(h.visibleCardIds()).not.toContain('g.a'), { timeout: 8000 })
    return h
  }

  it('reads its leaf members\' flows, and draws to the row they reach past a page', async () => {
    const h = await openGroup({
      nodeDegrees: { 'g.a': { in: 0, out: 1 } },
      flows: [{ sourceUrn: 'g.a', targetUrn: 's9' }],
    })
    await waitFor(() => expect(ports('logical:grp').right).toBe('lineage:out'), { timeout: 8000 })

    act(() => { useCanvasStore.getState().selectNode('logical:grp') })

    await waitFor(() => expect(h.visibleCardIds()).toContain('s9'), { timeout: 8000 })
    await waitFor(() => expect(h.wires()).toContainEqual({ source: 'logical:grp', target: 's9' }), { timeout: 8000 })
  }, 30_000)

  it("asks its container members' roll-ups, and draws to the row they reach past a page", async () => {
    const h = await openGroup({
      nodeDegrees: { 'g.c': { in: 0, out: 0, rollupIn: 0, rollupOut: 1 } },
      aggregatedCells: [rollUp('g.c', 's9', 2)],
    })
    await waitFor(() => expect(ports('logical:grp').right).toBe('lineage:out'), { timeout: 8000 })

    act(() => { useCanvasStore.getState().selectNode('logical:grp') })

    await waitFor(() => expect(asksOf(h)).toContainEqual([['g.c'], []]), { timeout: 8000 })
    await waitFor(() => expect(h.visibleCardIds()).toContain('s9'), { timeout: 8000 })
    await waitFor(() => expect(h.wires()).toContainEqual({ source: 'logical:grp', target: 's9' }), { timeout: 8000 })
  }, 30_000)

  it("is never hollow on a container member's roll-ups cut short", async () => {
    const cut = (p: GraphDataProvider) => ({
      ...p,
      getAggregatedEdges: async (req: AggregatedEdgeRequest) => {
        const answer = await p.getAggregatedEdges(req)
        return req.targetUrns === undefined ? { ...answer, truncated: true, truncationReason: null } : answer
      },
    }) as GraphDataProvider
    const h = await openGroup({
      nodeDegrees: { 'g.c': { in: 0, out: 0, rollupIn: 0, rollupOut: 1 } },
      aggregatedCells: [rollUp('g.c', 'far', 1)],
      wrapProvider: cut,
    })
    await waitFor(() => expect(ports('logical:grp').right).toBe('lineage:out'), { timeout: 8000 })

    act(() => { useCanvasStore.getState().selectNode('logical:grp') })

    await waitFor(() => expect(asksOf(h)).toContainEqual([['g.c'], []]), { timeout: 8000 })
    await h.settle()
    await act(async () => { await new Promise(r => setTimeout(r, 1500)) })
    expect(ports('logical:grp').right).toBe('lineage:out')
  }, 30_000)
})

describe('selecting a collapsed container on a reader that cannot count', () => {
  // A branch counts no degrees: a container there has nothing to say it has
  // lineage, and selecting it is how to find out.
  const onBranch = (cells: ReturnType<typeof rollUp>[], extra?: Record<string, unknown>) => {
    const estate = anchoredPortsEstate()
    return renderCanvasWithTrace(estate, {
      focus: 'SRC.raw_orders',
      browseHolds: estate.model.nodes.map(n => n.urn).filter(urn => urn !== 's9' && urn !== 'far'),
      ancestorChains: true,
      aggregatedCells: cells,
      wrapProvider: extra && ((p: GraphDataProvider) => ({
        ...p,
        getAggregatedEdges: async (req: AggregatedEdgeRequest) => {
          const answer = await p.getAggregatedEdges(req)
          const own = req.targetUrns === undefined || req.sourceUrns.length === 0
          return own ? { ...answer, ...extra } : answer
        },
      }) as GraphDataProvider),
    })
  }

  it('asks its roll-ups both ways, and draws to what they reach', async () => {
    const h = await onBranch([rollUp('SRC.DB_A', 's9', 2), rollUp('s1', 'SRC.DB_A', 1)])
    await h.settle()

    act(() => { useCanvasStore.getState().selectNode('SRC.DB_A') })

    await waitFor(() => {
      expect(asksOf(h)).toContainEqual([['SRC.DB_A'], []])
      expect(asksOf(h)).toContainEqual([[], ['SRC.DB_A']])
    }, { timeout: 8000 })
    await waitFor(() => expect(h.wires()).toContainEqual({ source: 's1', target: 'SRC.DB_A' }), { timeout: 8000 })
    await waitFor(() => expect(h.wires()).toContainEqual({ source: 'SRC.DB_A', target: 's9' }), { timeout: 8000 })
  }, 30_000)

  it('an answer cut at the derivation bound reads solid, never outside', async () => {
    const h = await onBranch([rollUp('SRC.DB_A', 'far', 1)],
      { truncated: true, stale: true, staleReason: 'derive_scope_cap', truncationReason: null })
    await h.settle()

    act(() => { useCanvasStore.getState().selectNode('SRC.DB_A') })

    await waitFor(() => expect(ports('SRC.DB_A').right).toBe('lineage:out'), { timeout: 8000 })
    await h.settle()
    await act(async () => { await new Promise(r => setTimeout(r, 1500)) })
    expect(ports('SRC.DB_A').right).toBe('lineage:out')
  }, 30_000)
})
