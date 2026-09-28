/**
 * Every line the canvas draws for a card can be clicked, and the click opens the relationship
 * drawer on it:
 *  - a SELECTED card's lines;
 *  - a HOVERED card's lines — the pointer has to leave the card to reach them, and may rest there;
 *  - a line docked to the Anchor Rail because its partner is scrolled out of the same column.
 * A docked line to the hint pill bows out through the column's gutter, where it can be clicked,
 * rather than across the rows.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { act, fireEvent } from '@testing-library/react'
import { renderCanvasWithTrace } from '@/test/canvasHarness'
import { cfoEstate } from '@/test/fixtures/traceEstates'
import type { LensWalkModel, LensWalkNode } from '@/components/canvas/context-view/lens/closure-adapter'
import type { ViewLayerConfig } from '@/types/schema'
import { useCanvasStore, type LineageEdge } from '@/store/canvas'
import { usePreferencesStore } from '@/store/preferences'

const hits = () => [...document.querySelectorAll<SVGPathElement>('path[data-canvas-interactive]')]
const lineIds = () => [...document.querySelectorAll<SVGGElement>('g[data-edge-id]')].map(g => g.getAttribute('data-edge-id')!)
const row = (id: string) => document.getElementById(`layer-node-${id}`)!
const opened = () => {
  const d = useCanvasStore.getState().drawerEdge
  return d?.kind === 'relationship' ? `${d.source}>${d.target}` : null
}
/** Real time: how long a pointer takes to cross from a card onto a line, or rests there. */
const wait = (ms: number) => act(async () => { await new Promise(r => setTimeout(r, ms)) })

afterEach(() => { delete document.documentElement.dataset.hoveredNode })

async function twoLinesAtTableau() {
  const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo' })
  act(() => {
    useCanvasStore.getState().addEdges([
      { id: 'f1', source: 'INTERMEDIATE_T2', target: 'tableau', data: { edgeType: 'FLOWS_TO' } },
      { id: 'f2', source: 'tableau', target: 'REPORTING', data: { edgeType: 'FLOWS_TO' } },
    ] as LineageEdge[])
  })
  await h.settle()
  return h
}

/** One anchored column of 80 rows (SRC.c00 … SRC.c79) — taller than the view, so the
 *  virtualizer leaves the bottom rows unmounted — and a second column. */
function tallColumnEstate() {
  const wn = (urn: string, type: string, childCount = 0) => ({
    id: urn, type: 'default', position: { x: 0, y: 0 },
    data: { urn, label: urn, type, childCount }, urn, displayName: urn, entityType: type,
  }) as unknown as LensWalkNode
  const kids = Array.from({ length: 80 }, (_, i) => `SRC.c${String(i).padStart(2, '0')}`)
  const nodes = [wn('SRC', 'dataPlatform', kids.length), ...kids.map(k => wn(k, 'dataset')), wn('DST', 'dataPlatform', 1), wn('DST.out', 'dataset')]
  const containmentEdges = [...kids.map(k => ({ sourceUrn: 'SRC', targetUrn: k })), { sourceUrn: 'DST', targetUrn: 'DST.out' }]
  const model = {
    focusUrn: 'SRC.c00', nodes, lineageEdges: [], containmentEdges,
    upstreamUrns: new Set(), downstreamUrns: new Set(), frontierUp: [], frontierDown: [],
    truncated: false, truncationReason: null, seedTruncated: false, seedCursor: null,
  } as unknown as LensWalkModel
  const layers: ViewLayerConfig[] = [
    { id: 'src', name: 'Source', order: 0, entityTypes: [], anchorUrn: 'SRC' },
    { id: 'dst', name: 'Target', order: 1, entityTypes: [], anchorUrn: 'DST' },
  ]
  return { model, layers, assignments: { SRC: { layerId: 'src' }, DST: { layerId: 'dst' } } }
}

/** SRC.c00 selected, with a partner scrolled out of its own column (SRC.c70) and one across. */
async function dockedPartner() {
  const h = await renderCanvasWithTrace(tallColumnEstate(), { focus: 'SRC.c00' })
  act(() => {
    useCanvasStore.getState().addEdges([
      { id: 'same', source: 'SRC.c70', target: 'SRC.c00', data: { edgeType: 'FLOWS_TO' } },
      { id: 'across', source: 'SRC.c00', target: 'DST.out', data: { edgeType: 'FLOWS_TO' } },
    ] as LineageEdge[])
  })
  await h.settle()
  expect(h.visibleCardIds()).toContain('SRC.c00')
  expect(h.visibleCardIds()).not.toContain('SRC.c70')
  return h
}

for (const mode of ['stubs', 'raw'] as const) {
  describe(`clicking a line — Edge Density "${mode}"`, () => {
    it('a SELECTED card: every line drawn for it has a hit path, and each opens the drawer on its relationship', async () => {
      usePreferencesStore.setState({ lineageRenderMode: mode })
      const h = await twoLinesAtTableau()
      const seen = new Set<string>()
      for (let i = 0; i < 2; i++) {
        // The click on a line takes the selection, so select again before each one.
        await h.clickCard('tableau')
        expect(lineIds()).toHaveLength(2)
        expect(hits()).toHaveLength(2)
        await act(async () => { fireEvent.click(hits()[i]) })
        await h.settle()
        seen.add(opened()!)
      }
      expect([...seen].sort()).toEqual(['INTERMEDIATE_T2>tableau', 'tableau>REPORTING'])
    }, 30000)

    it('a HOVERED card: its lines stay drawn and clickable while the pointer crosses onto one, and while it rests there', async () => {
      usePreferencesStore.setState({ lineageRenderMode: mode })
      const h = await twoLinesAtTableau()
      await act(async () => { fireEvent.mouseEnter(row('tableau')) })
      await h.settle()
      expect(lineIds()).toHaveLength(2)
      expect(hits()).toHaveLength(2)
      const line = hits()[0]

      // Leaving the card and arriving on the line are one pointer move.
      await act(async () => {
        fireEvent.mouseLeave(row('tableau'))
        fireEvent.mouseEnter(line)
      })
      await wait(150)
      await h.settle()
      expect(line.isConnected).toBe(true)
      // Resting on it past the crossing's grace keeps it: the pointer is on the line.
      await wait(700)
      await h.settle()
      expect(line.isConnected).toBe(true)
      await act(async () => { fireEvent.click(line) })
      await h.settle()
      expect(opened()).toMatch(/^(INTERMEDIATE_T2>tableau|tableau>REPORTING)$/)
    }, 30000)

    for (const trays of [false, true]) {
      it(`a line docked to the Anchor Rail (${trays ? 'tray' : 'hint pill'}) — partner off-screen in the SAME column — is clickable`, async () => {
        usePreferencesStore.setState({ lineageRenderMode: mode, showConnectedTrays: trays } as never)
        const h = await dockedPartner()
        const seen = new Set<string>()
        for (let i = 0; ; i++) {
          await h.clickCard('SRC.c00')
          await h.settle()
          // The partner docks on the rail, and its line runs to it.
          expect(document.getElementById('anchor-proxy-SRC.c70') ?? document.getElementById('anchor-rail-src-down')).not.toBeNull()
          expect(lineIds()).toHaveLength(2)
          expect(hits()).toHaveLength(lineIds().length)
          if (i >= hits().length) break
          await act(async () => { fireEvent.click(hits()[i]) })
          await h.settle()
          seen.add(opened()!)
        }
        expect([...seen].sort()).toEqual(['SRC.c00>DST.out', 'SRC.c70>SRC.c00'])
      }, 30000)
    }
  })
}

describe('hover lines, On Hover density', () => {
  it('outlive the hover only for the crossing: a pointer that never reaches a line lets them go', async () => {
    usePreferencesStore.setState({ lineageRenderMode: 'stubs' })
    const h = await twoLinesAtTableau()
    await act(async () => { fireEvent.mouseEnter(row('tableau')) })
    await h.settle()
    expect(hits()).toHaveLength(2)
    await act(async () => { fireEvent.mouseLeave(row('tableau')) })
    await wait(100)
    await h.settle()
    expect(hits()).toHaveLength(2)
    await wait(700)
    await h.settle()
    expect(hits()).toHaveLength(0)
  }, 30000)
})

describe('the line docked to the hint pill', () => {
  it('bows out through the column gutter, not across the rows', async () => {
    usePreferencesStore.setState({ lineageRenderMode: 'stubs', showConnectedTrays: false } as never)
    const h = await dockedPartner()
    // The harness gives every element one rect; give the selected row and the small pill at the
    // column's left edge their real widths, as a browser would (the route turns on those).
    const base = Element.prototype.getBoundingClientRect
    const across = (left: number, right: number) => {
      const r = base.call(document.body)
      return { ...r, x: left, left, right, width: right - left, toJSON: () => ({}) } as DOMRect
    }
    Element.prototype.getBoundingClientRect = function (this: Element) {
      if (this.id === 'layer-node-SRC.c00') return across(108, 408)
      if (this.id === 'anchor-rail-src-down') return across(110, 205)
      return base.call(this)
    }
    try {
      await h.clickCard('SRC.c00')
      await h.settle()
      const d = document.querySelector('g[data-edge-id^="proxy-edge-"] path')!.getAttribute('d')!
      const xs = [...d.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map(m => Number(m[1]))
      // M start, then the curve's two control points and its end.
      expect(xs).toHaveLength(4)
      expect(Math.max(xs[1], xs[2])).toBeLessThan(108 - 8)   // both control points in the gutter
      expect(xs[3]).toBeLessThan(110)                        // it lands on the pill's left edge
    } finally {
      Element.prototype.getBoundingClientRect = base
    }
  }, 30000)
})
