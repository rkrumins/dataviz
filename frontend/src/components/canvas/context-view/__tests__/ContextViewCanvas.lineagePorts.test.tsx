/**
 * ON OPEN, EVERY CARD SAYS WHETHER IT HAS LINEAGE — on the real canvas, on a
 * view built the way Data Source views are (one anchored column per entity).
 *
 * Each card's ports end in one of four states:
 *   solid   — its lineage reaches something in the view, on the side facing
 *             it: a row, a collapsed container (the roll-up), a row of an
 *             anchored column that is not loaded, or that column's anchor;
 *   hollow  — its lineage only leaves the view;
 *   none    — it has none;
 *   unknown — its count failed (and it has no line of its own to say more).
 *
 * And only lineage that truly leaves the view is kept for a stub: none of it
 * names an anchor or a row the canvas draws.
 */
import { act, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { OffCanvasLineage } from '@/hooks/useEdgeProjection'
import { renderCanvasWithTrace } from '@/test/canvasHarness'
import { anchoredPortsEstate, groupedEstate } from '@/test/fixtures/traceEstates'
import { useAuthStore } from '@/store/auth'
import { useCanvasStore } from '@/store/canvas'
import { useConnectionVisibilityStore } from '@/store/connectionVisibility'

// The stubs' own data, as the canvas hands it to the overlay. jsdom gives
// every row the same box, so the overlay never has room to paint a stub;
// what a stub would say is read where it comes from instead.
const projection = vi.hoisted(() => ({ offCanvas: undefined as ReadonlyMap<string, OffCanvasLineage> | undefined }))
vi.mock('@/hooks/useEdgeProjection', async (original) => {
  const real = await original<typeof import('@/hooks/useEdgeProjection')>()
  return {
    ...real,
    useEdgeProjection: (...args: Parameters<typeof real.useEdgeProjection>) => {
      const result = real.useEdgeProjection(...args)
      projection.offCanvas = result.offCanvasByNode
      return result
    },
  }
})

beforeEach(() => {
  useAuthStore.setState({ permissions: { global: ['system:admin'], ws: {} } } as never)
})

const flow = (source: string, target: string) => ({
  id: `f:${source}>${target}`, source, target, type: 'lineage',
  data: { edgeType: 'TRANSFORMS', relationship: 'TRANSFORMS' },
})

const rollUp = (sourceUrn: string, targetUrn: string, edgeCount: number) => ({
  id: `agg:${sourceUrn}>${targetUrn}`, sourceUrn, targetUrn, edgeCount,
  edgeTypes: ['TRANSFORMS'], confidence: 1, sourceEdgeIds: [],
})

/** `kind:dir` of the card's port on each side, or null for no port. */
function ports(id: string): { left: string | null; right: string | null } {
  const at = (side: 'left' | 'right') => {
    const el = document.getElementById(`layer-node-${id}`)?.querySelector<HTMLElement>(`[data-lineage-port="${side}"]`)
    return el ? `${el.dataset.port}:${el.dataset.dir}` : null
  }
  return { left: at('left'), right: at('right') }
}

const ANCHORS = ['SRC', 'STG', 'REP']

describe('an anchored view: every card ends solid, hollow, none or unknown', () => {
  it('on open, each card says what its lineage reaches', async () => {
    const estate = anchoredPortsEstate()
    const h = await renderCanvasWithTrace(estate, {
      focus: 'SRC.raw_orders',
      // s9 is a row of Staging past its loaded page; `far` is held by nothing.
      browseHolds: estate.model.nodes.map(n => n.urn).filter(urn => urn !== 's9' && urn !== 'far'),
      ancestorChains: true,
      nodeDegrees: {
        'SRC.raw_orders': { in: 0, out: 2 },
        'SRC.DB_A': { in: 0, out: 3 },
        'SRC.DB_B.t2': { in: 0, out: 1 },
        s1: { in: 1, out: 0 },
        s2: { in: 3, out: 1 },
        dash: { in: 1, out: 0 },
        rpt: { in: 1, out: 0 },
        uncounted: 'fail',
      },
      aggregatedExtra: { aggregatedEdges: [rollUp('SRC.DB_A', 's2', 3)] },
    })

    act(() => {
      useCanvasStore.getState().addGraph([], [
        flow('SRC.raw_orders', 's1'),
        flow('SRC.raw_orders', 'STG'),
        flow('s2', 's9'),
        flow('SRC.DB_B.t2', 'rpt'),
        flow('far', 'dash'),
      ] as never)
    })
    await h.toggle('SRC.DB_B')

    // The anchors are the columns; a nested row sits inside its open container.
    expect(h.visibleCardIds().sort()).toEqual([
      'SRC.DB_A', 'SRC.DB_B', 'SRC.DB_B.t2', 'SRC.quiet', 'SRC.raw_orders',
      'dash', 'rpt', 's1', 's2', 'uncounted',
    ])

    await waitFor(() => {
      // Solid, facing a row — and, beside it, another column's anchor.
      expect(ports('SRC.raw_orders')).toEqual({ left: null, right: 'here:out' })
      expect(ports('s1')).toEqual({ left: 'here:in', right: null })
      // Solid through a collapsed container's roll-up.
      expect(ports('SRC.DB_A')).toEqual({ left: null, right: 'here:out' })
      // Same column: s9 is a Staging row that is not loaded, and a line to
      // one's own column meets the left — with DB_A's roll-up arriving there.
      expect(ports('s2')).toEqual({ left: 'here:both', right: null })
      // A nested row inside an open container carries its own port; the
      // container, with no line of its own, carries none.
      expect(ports('SRC.DB_B.t2')).toEqual({ left: null, right: 'here:out' })
      expect(ports('rpt')).toEqual({ left: 'here:in', right: null })
      expect(ports('SRC.DB_B')).toEqual({ left: null, right: null })
      // Hollow: its only lineage leaves the view.
      expect(ports('dash')).toEqual({ left: 'beyond:in', right: null })
      // None.
      expect(ports('SRC.quiet')).toEqual({ left: null, right: null })
      // Unknown: its count failed and nothing else says.
      expect(ports('uncounted')).toEqual({ left: 'unknown:both', right: 'unknown:both' })
    }, { timeout: 8000 })
    // s2's solid out came from a row that is still not loaded, not from a line to it.
    expect(useCanvasStore.getState().nodes.some(n => n.id === 's9')).toBe(false)

    // Only lineage that truly leaves the view is kept for a stub, and none
    // of it names an anchor or a row the canvas draws.
    const drawn = new Set(h.visibleCardIds())
    const stubbed = [...(projection.offCanvas ?? new Map()).entries()]
      .filter(([, l]) => l.in + l.out > 0)
    expect(stubbed.map(([row, l]) => [row, l.in, l.out, [...l.inPartners, ...l.outPartners]]))
      .toEqual([['dash', 1, 0, ['far']]])
    for (const [, l] of projection.offCanvas ?? new Map()) {
      for (const partner of [...l.inPartners, ...l.outPartners]) {
        expect(ANCHORS).not.toContain(partner)
        expect(drawn.has(partner)).toBe(false)
      }
    }
  }, 20_000)

  it('a card whose partner has no known place yet is neither solid nor hollow', async () => {
    const estate = anchoredPortsEstate()
    const h = await renderCanvasWithTrace(estate, {
      focus: 'SRC.raw_orders',
      browseHolds: estate.model.nodes.map(n => n.urn).filter(urn => urn !== 's9' && urn !== 'far'),
      ancestorChains: true,
      nodeDegrees: { 'SRC.quiet': { in: 0, out: 1 }, dash: { in: 1, out: 0 } },
    })

    act(() => {
      useCanvasStore.getState().addGraph([], [flow('SRC.quiet', 'ghost'), flow('far', 'dash')] as never)
    })
    // `far` is a root, so its card is hollow: the totals and the chains are in.
    await waitFor(() => {
      expect(ports('dash')).toEqual({ left: 'beyond:in', right: null })
    }, { timeout: 8000 })
    // `ghost` is no entity the chains know, so its place is still being asked.
    expect(h.chainRequests().flat()).toContain('ghost')
    expect(ports('SRC.quiet')).toEqual({ left: null, right: null })
  }, 20_000)

  it('in a view open to its whole data source, an end no column holds is not outside', async () => {
    const estate = anchoredPortsEstate()
    const h = await renderCanvasWithTrace(estate, {
      focus: 'SRC.raw_orders',
      entityScope: 'all',
      browseHolds: estate.model.nodes.map(n => n.urn).filter(urn => urn !== 's9' && urn !== 'far'),
      ancestorChains: true,
      nodeDegrees: { dash: { in: 1, out: 0 }, uncounted: { in: 1, out: 0 } },
    })

    act(() => {
      useCanvasStore.getState().addGraph([], [flow('far', 'dash')] as never)
    })
    await waitFor(() => {
      expect(h.chainRequests().flat()).toContain('far')
      // No edge of uncounted's is loaded at all, so it reads hollow as soon
      // as the totals are in.
      expect(ports('uncounted')).toEqual({ left: 'beyond:in', right: null })
    }, { timeout: 8000 })
    await h.settle()
    // `far` is a root no column holds: in the view, column unknown.
    expect(ports('dash')).toEqual({ left: null, right: null })
    expect([...(projection.offCanvas ?? new Map()).values()].some(l => l.in + l.out > 0)).toBe(false)
  }, 20_000)
})

describe("a card's lineage into rows an anchored column has not drawn", () => {
  it('counts one line per row it reaches, in the tip and the glow', async () => {
    const estate = anchoredPortsEstate()
    await renderCanvasWithTrace(estate, {
      focus: 'SRC.raw_orders',
      // s1 and s9 are rows of Staging past its loaded page.
      browseHolds: estate.model.nodes.map(n => n.urn).filter(urn => !['s1', 's9', 'far'].includes(urn)),
      ancestorChains: true,
      nodeDegrees: { s2: { in: 0, out: 2 } },
    })
    act(() => {
      useCanvasStore.getState().addGraph([], [flow('s2', 's9'), flow('s2', 's1')] as never)
    })
    await waitFor(() => {
      expect(ports('s2')).toEqual({ left: 'here:out', right: null })
      const port = document.getElementById('layer-node-s2')?.querySelector<HTMLElement>('[data-lineage-port="left"]')
      expect(port?.dataset.out).toBe('2')
    }, { timeout: 8000 })
  }, 20_000)
})

describe('a card whose lineage sits below it, or that the reader hid', () => {
  it('a closed container holding roll-up cells is hollow; open, it leaves that to its rows', async () => {
    const estate = anchoredPortsEstate()
    const h = await renderCanvasWithTrace(estate, {
      focus: 'SRC.raw_orders',
      browseHolds: estate.model.nodes.map(n => n.urn).filter(urn => urn !== 's9' && urn !== 'far'),
      ancestorChains: true,
      // Neither has a flow of its own; the rows inside them do.
      nodeDegrees: {
        'SRC.DB_A': { in: 0, out: 0, rollupIn: 0, rollupOut: 1 },
        'SRC.DB_B': { in: 0, out: 0, rollupIn: 1, rollupOut: 0 },
      },
    })
    await h.toggle('SRC.DB_B')

    await waitFor(() => {
      expect(ports('SRC.DB_A')).toEqual({ left: null, right: 'beyond:out' })
    }, { timeout: 8000 })
    expect(ports('SRC.DB_B')).toEqual({ left: null, right: null })
  }, 20_000)

  it('a card whose lineage was read only in part never reads hollow that way', async () => {
    const estate = anchoredPortsEstate()
    await renderCanvasWithTrace(estate, {
      focus: 'SRC.raw_orders',
      browseHolds: estate.model.nodes.map(n => n.urn).filter(urn => urn !== 's9' && urn !== 'far'),
      ancestorChains: true,
      nodeDegrees: { dash: { in: 1, out: 0 } },
    })
    act(() => {
      useCanvasStore.getState().addGraph([], [flow('far', 'dash')] as never)
    })
    await waitFor(() => {
      expect(ports('dash')).toEqual({ left: 'beyond:in', right: null })
    }, { timeout: 8000 })

    // Its incoming read came back at the cap: the flows past it may reach the view.
    act(() => { useCanvasStore.getState().markLineagePartial({ in: ['dash'], out: [] }) })
    await waitFor(() => {
      expect(ports('dash')).toEqual({ left: null, right: null })
    }, { timeout: 8000 })
  }, 20_000)

  it('a hidden flow type never makes a card hollow', async () => {
    const estate = anchoredPortsEstate()
    await renderCanvasWithTrace(estate, {
      focus: 'SRC.raw_orders',
      browseHolds: estate.model.nodes.map(n => n.urn).filter(urn => urn !== 's9' && urn !== 'far'),
      ancestorChains: true,
      nodeDegrees: { dash: { in: 1, out: 0 } },
    })
    act(() => {
      useCanvasStore.getState().addGraph([], [flow('far', 'dash')] as never)
    })
    await waitFor(() => {
      expect(ports('dash')).toEqual({ left: 'beyond:in', right: null })
    }, { timeout: 8000 })

    // Its total counts every type; with one hidden, that one could be all of it.
    act(() => { useConnectionVisibilityStore.getState().setHidden('harness-view', ['TRANSFORMS']) })
    try {
      await waitFor(() => {
        expect(ports('dash')).toEqual({ left: null, right: null })
      }, { timeout: 8000 })
    } finally {
      act(() => { useConnectionVisibilityStore.getState().setHidden('harness-view', []) })
    }
  }, 20_000)

  it('a closed logical group reads its members: hollow from theirs', async () => {
    const h = await renderCanvasWithTrace(groupedEstate(), {
      focus: 'solo',
      nodeDegrees: { 'g.a': { in: 0, out: 2 }, 'g.b': { in: 0, out: 0 } },
    })
    // Open, its members speak for themselves.
    await waitFor(() => {
      expect(ports('g.a')).toEqual({ left: null, right: 'beyond:out' })
    }, { timeout: 8000 })
    expect(ports('logical:grp')).toEqual({ left: null, right: null })

    await h.toggle('logical:grp')
    await waitFor(() => {
      expect(ports('logical:grp')).toEqual({ left: null, right: 'beyond:out' })
    }, { timeout: 8000 })
    expect(ports('solo')).toEqual({ left: null, right: null })
  }, 20_000)

  it('a closed logical group whose member could not be counted says unknown', async () => {
    const h = await renderCanvasWithTrace(groupedEstate(), {
      focus: 'solo',
      nodeDegrees: { 'g.a': { in: 0, out: 2 }, 'g.b': 'fail' },
    })
    await h.toggle('logical:grp')
    await waitFor(() => {
      expect(ports('logical:grp')).toEqual({ left: 'unknown:both', right: 'unknown:both' })
    }, { timeout: 8000 })
  }, 20_000)
})
