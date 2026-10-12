/**
 * Every line the canvas draws for a card can be clicked, and the click opens the relationship
 * drawer on it:
 *  - a SELECTED card's lines;
 *  - a HOVERED card's lines — the pointer has to leave the card to reach them, and may rest there;
 *  - a line docked to the Anchor Rail because its partner is scrolled out of the same column.
 * A docked line is the relationship's own line, drawn as every line is, source to target. In its
 * row's column it runs down the gutter on the side the row marks it (Display › Marker sides), where
 * it can be clicked, rather than across the rows.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { act, fireEvent, waitFor } from '@testing-library/react'
import { renderCanvasWithTrace } from '@/test/canvasHarness'
import { cfoEstate } from '@/test/fixtures/traceEstates'
import type { LensWalkModel, LensWalkNode } from '@/components/canvas/context-view/lens/closure-adapter'
import type { ViewLayerConfig } from '@/types/schema'
import { useCanvasStore, type LineageEdge } from '@/store/canvas'
import { usePreferencesStore } from '@/store/preferences'
import { useAnchorRailStore } from '@/store/anchorRail'

const hits = () => [...document.querySelectorAll<SVGPathElement>('path[data-canvas-interactive]')]
const lineIds = () => [...document.querySelectorAll<SVGGElement>('g[data-edge-id]')].map(g => g.getAttribute('data-edge-id')!)
const row = (id: string) => document.getElementById(`layer-node-${id}`)!
const opened = () => {
  const d = useCanvasStore.getState().drawerEdge
  return d?.kind === 'relationship' ? `${d.source}>${d.target}` : null
}
/** The drawn line from one card to another. */
const lineBetween = (source: string, target: string) =>
  [...document.querySelectorAll<SVGGElement>('g[data-edge-id]')]
    .find(g => g.getAttribute('data-edge-src') === source && g.getAttribute('data-edge-tgt') === target) ?? null
/** Every x a path passes through or bends toward, in order (M, C and H). */
const pathXs = (d: string) => {
  const xs: number[] = []
  for (const [, cmd, args] of d.matchAll(/([MCH])([^MCH]*)/g)) {
    const n = args.match(/-?[\d.]+/g)!.map(Number)
    if (cmd === 'H') xs.push(...n)
    else for (let i = 0; i < n.length; i += 2) xs.push(n[i])
  }
  return xs
}
/**
 * The harness gives every element one rect; give these their real widths, as a browser would (the
 * route turns on them). `dock` stands for what a docked line ends beside — whichever element
 * carries `data-anchor-dock`: the tray, or the hint pill's strip of the same width.
 */
async function withWidths(widths: Record<string, [number, number]>, dock: [number, number] | null, run: () => Promise<void>) {
  const base = Element.prototype.getBoundingClientRect
  const across = (el: Element, [left, right]: [number, number]) =>
    ({ ...base.call(el), x: left, left, right, width: right - left, toJSON: () => ({}) }) as DOMRect
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (widths[this.id]) return across(this, widths[this.id])
    if (dock && this.hasAttribute('data-anchor-dock')) return across(this, dock)
    return base.call(this)
  }
  try {
    await run()
  } finally {
    Element.prototype.getBoundingClientRect = base
  }
}
/** Real time: how long a pointer takes to cross from a card onto a line, or rests there. */
const wait = (ms: number) => act(async () => { await new Promise(r => setTimeout(r, ms)) })
/** A docked line is drawn a pass after its rail entry mounts, so wait for the lines to settle on
 *  their count rather than assume one pass (a loaded full-suite run can need more). */
const drawn = (n: number) => waitFor(() => expect(lineIds()).toHaveLength(n), { timeout: 5000 })
/** Settle until the drawn lines stop changing — a docked line joins a pass after its rail entry. */
async function settleLines(h: { settle(): Promise<void> }) {
  await h.settle()
  let before = -1
  for (let i = 0; i < 40 && lineIds().length !== before; i++) {
    before = lineIds().length
    await wait(50)
    await h.settle()
  }
}

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
 *  virtualizer leaves the bottom rows unmounted — and a second column. `inside` puts entities
 *  (id → label) in a card, collapsed. */
function tallColumnEstate(inside: Record<string, Record<string, string>> = {}) {
  const wn = (urn: string, type: string, childCount = 0, label = urn) => ({
    id: urn, type: 'default', position: { x: 0, y: 0 },
    data: { urn, label, type, childCount }, urn, displayName: label, entityType: type,
  }) as unknown as LensWalkNode
  const kids = Array.from({ length: 80 }, (_, i) => `SRC.c${String(i).padStart(2, '0')}`)
  const held = Object.entries(inside).flatMap(([card, ids]) => Object.entries(ids).map(([id, label]) => ({ card, id, label })))
  const nodes = [
    wn('SRC', 'dataPlatform', kids.length),
    ...kids.map(k => wn(k, 'dataset', Object.keys(inside[k] ?? {}).length)),
    ...held.map(({ id, label }) => wn(id, 'schemaField', 0, label)),
    wn('DST', 'dataPlatform', 1), wn('DST.out', 'dataset'),
  ]
  const containmentEdges = [
    ...kids.map(k => ({ sourceUrn: 'SRC', targetUrn: k })),
    ...held.map(({ card, id }) => ({ sourceUrn: card, targetUrn: id })),
    { sourceUrn: 'DST', targetUrn: 'DST.out' },
  ]
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
async function dockedPartner(edges: Array<Pick<LineageEdge, 'id' | 'source' | 'target'>> = [
  { id: 'same', source: 'SRC.c70', target: 'SRC.c00' },
  { id: 'across', source: 'SRC.c00', target: 'DST.out' },
], estate = tallColumnEstate()) {
  const h = await renderCanvasWithTrace(estate, { focus: 'SRC.c00' })
  act(() => {
    useCanvasStore.getState().addEdges(edges.map(e => ({ ...e, data: { edgeType: 'FLOWS_TO' } })) as LineageEdge[])
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
          await settleLines(h)
          // The partner docks on the rail, and its line runs to it.
          expect(document.getElementById('anchor-proxy-SRC.c70') ?? document.getElementById('anchor-rail-src-down')).not.toBeNull()
          await drawn(2)
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

describe('the SELECTED entity scrolled out of its column', () => {
  it('its lines to the rows still on screen dock to the rail and each opens its relationship', async () => {
    usePreferencesStore.setState({ lineageRenderMode: 'stubs', showConnectedTrays: false } as never)
    const h = await renderCanvasWithTrace(tallColumnEstate(), { focus: 'SRC.c00' })
    act(() => {
      useCanvasStore.getState().addEdges([
        { id: 'o1', source: 'SRC.c70', target: 'SRC.c00', data: { edgeType: 'FLOWS_TO' } },
        { id: 'o2', source: 'SRC.c70', target: 'SRC.c01', data: { edgeType: 'FLOWS_TO' } },
      ] as LineageEdge[])
    })
    await h.settle()
    expect(h.visibleCardIds()).not.toContain('SRC.c70')
    const seen = new Set<string>()
    for (let i = 0; ; i++) {
      // Select the entity that is scrolled away, as the canvas does when its row was clicked
      // before the column scrolled.
      await act(async () => { useCanvasStore.getState().selectNode('SRC.c70') })
      await settleLines(h)
      await drawn(2)
      expect(hits()).toHaveLength(2)
      if (i >= 2) break
      await act(async () => { fireEvent.click(hits()[i]) })
      await h.settle()
      seen.add(opened()!)
    }
    expect([...seen].sort()).toEqual(['SRC.c70>SRC.c00', 'SRC.c70>SRC.c01'])
  }, 30000)

  it('they dock to a stand-in for the selection itself — never listed as its own partner', async () => {
    usePreferencesStore.setState({ lineageRenderMode: 'stubs', showConnectedTrays: true } as never)
    const h = await renderCanvasWithTrace(tallColumnEstate(), { focus: 'SRC.c00' })
    act(() => {
      useCanvasStore.getState().addEdges([
        { id: 'o1', source: 'SRC.c70', target: 'SRC.c00', data: { edgeType: 'FLOWS_TO' } },
        { id: 'o2', source: 'SRC.c70', target: 'SRC.c01', data: { edgeType: 'FLOWS_TO' } },
      ] as LineageEdge[])
    })
    await h.settle()
    await act(async () => { useCanvasStore.getState().selectNode('SRC.c70') })
    await settleLines(h)
    const rail = useAnchorRailStore.getState()
    expect(rail.focusId).toBe('SRC.c70')
    const proxies = rail.groups.get('src')!.proxies
    // One entry, for the selection, its flow still its own: it feeds both rows.
    expect(proxies).toHaveLength(1)
    expect(proxies[0]).toMatchObject({ nodeId: 'SRC.c70', isFocus: true, flow: 'out', count: 2 })
    expect(proxies[0].realId).toBeUndefined()
    expect(proxies[0].partners).toBeUndefined()
    // Both lines run to its tray entry — the real lines, drawn from the stand-in into each row.
    expect(document.getElementById('anchor-proxy-SRC.c70')).not.toBeNull()
    expect(lineBetween('SRC.c70', 'SRC.c00')).not.toBeNull()
    expect(lineBetween('SRC.c70', 'SRC.c01')).not.toBeNull()
  }, 30000)
})

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

describe('a line docked to the Anchor Rail', () => {
  it('is the relationship\'s own line: it looks, points and moves as the selection\'s other lines do', async () => {
    usePreferencesStore.setState({ lineageRenderMode: 'stubs', showConnectedTrays: true } as never)
    const h = await dockedPartner()
    await withWidths({ 'layer-node-SRC.c00': [108, 408], 'anchor-proxy-SRC.c70': [112, 404] }, [112, 404], async () => {
      await h.clickCard('SRC.c00')
      await settleLines(h)
      expect(document.getElementById('anchor-proxy-SRC.c70')).not.toBeNull()
      // No stand-in line: the docked line carries the relationship's line id.
      expect(document.querySelector('g[data-edge-id^="proxy-edge-"]')).toBeNull()
      const docked = lineBetween('SRC.c70', 'SRC.c00')!
      const active = lineBetween('SRC.c00', 'DST.out')!
      expect(docked).not.toBeNull()
      expect(active).not.toBeNull()
      // One drawing for both — gradient, glow, core, source dot — with the same stroke.
      const parts = (g: Element) => [...g.children].map(c => c.tagName.toLowerCase())
      expect(parts(docked)).toEqual(parts(active))
      const stroke = (g: Element) => {
        const core = g.querySelector<SVGPathElement>('path[marker-end]')!
        return [core.style.strokeWidth, core.style.strokeDasharray]
      }
      expect(stroke(docked)).toEqual(stroke(active))
      expect(stroke(docked)[0]).not.toBe('')
      // Its arrowhead: the canvas's own marker, at the target end — on the row, since SRC.c70
      // feeds SRC.c00. Drawn from the tray's entry to the row's left.
      const markerEnd = docked.querySelector('path[marker-end]')?.getAttribute('marker-end')
      expect(markerEnd).toMatch(/^url\(#arrow-/)
      expect(document.getElementById(markerEnd!.slice(5, -1))?.tagName.toLowerCase()).toBe('marker')
      expect(docked.querySelector('path[marker-start]')).toBeNull()
      const xs = pathXs(docked.querySelector('path[marker-end]')!.getAttribute('d')!)
      expect(xs[0]).toBe(112 - 6)
      expect(xs.at(-1)).toBe(108 - 6)
      // And it moves with the selection's lines (LineMotionLayer).
      const moving = [...document.querySelectorAll('[data-moving-line]')].map(g => g.getAttribute('data-moving-line'))
      expect(moving).toContain(docked.getAttribute('data-edge-id'))
      expect(moving).toContain(active.getAttribute('data-edge-id'))
    })
  }, 30000)

  it('to the hint pill, flowing IN: from the pill through the left gutter into the row — not across the rows', async () => {
    usePreferencesStore.setState({ lineageRenderMode: 'stubs', showConnectedTrays: false } as never)
    const h = await dockedPartner()
    // The selected row, and the small pill at the left of its strip, as wide as a tray.
    await withWidths({ 'layer-node-SRC.c00': [108, 408], 'anchor-rail-src-down': [110, 205] }, [110, 406], async () => {
      await h.clickCard('SRC.c00')
      await settleLines(h)
      const d = lineBetween('SRC.c70', 'SRC.c00')!.querySelector('path')!.getAttribute('d')!
      const xs = pathXs(d)
      // Source to target: it leaves the pill's left edge, and its arrowhead ends at the row's left.
      expect(xs[0]).toBe(110 - 6)
      expect(xs.at(-1)).toBe(108 - 6)
      // It bows through the gutter lane (routeLine's lane 0), never into the row or the pill.
      expect(Math.min(...xs)).toBe(108 - 6 - 24)
      expect(Math.max(...xs)).toBeLessThan(108)
    })
  }, 30000)

  it('to the hint pill, flowing OUT: down the right gutter, ending level with the pill — never back across the rows', async () => {
    usePreferencesStore.setState({ lineageRenderMode: 'stubs', showConnectedTrays: false } as never)
    const h = await dockedPartner([{ id: 'out', source: 'SRC.c00', target: 'SRC.c70' }])
    await withWidths({ 'layer-node-SRC.c00': [108, 408], 'anchor-rail-src-down': [110, 205] }, [110, 406], async () => {
      await h.clickCard('SRC.c00')
      await settleLines(h)
      const line = lineBetween('SRC.c00', 'SRC.c70')!
      const d = line.querySelector('path')!.getAttribute('d')!
      const xs = pathXs(d)
      // Out of the row's right side; its arrowhead ends in the right gutter, beside the pill's strip.
      expect(xs[0]).toBe(408 + 6)
      expect(xs.every(x => x > 408)).toBe(true)
      expect(xs.at(-1)).toBe(406 + 6)
      const hit = hits().find(p => p.getAttribute('d') === d)!
      await act(async () => { fireEvent.click(hit) })
      await h.settle()
      expect(opened()).toBe('SRC.c00>SRC.c70')
    })
  }, 30000)

  it('to the selection\'s own hint pill, scrolled away, from a row that feeds it: the right gutter too', async () => {
    usePreferencesStore.setState({ lineageRenderMode: 'stubs', showConnectedTrays: false } as never)
    const h = await renderCanvasWithTrace(tallColumnEstate(), { focus: 'SRC.c00' })
    act(() => {
      useCanvasStore.getState().addEdges([
        { id: 'feeds', source: 'SRC.c00', target: 'SRC.c70', data: { edgeType: 'FLOWS_TO' } },
      ] as LineageEdge[])
    })
    await h.settle()
    await withWidths({ 'layer-node-SRC.c00': [108, 408], 'anchor-rail-src-down': [110, 205] }, [110, 406], async () => {
      await act(async () => { useCanvasStore.getState().selectNode('SRC.c70') })
      await settleLines(h)
      expect(document.getElementById('anchor-rail-src-down')).toHaveTextContent('(selected)')
      const line = lineBetween('SRC.c00', 'SRC.c70')!
      const d = line.querySelector('path')!.getAttribute('d')!
      const xs = pathXs(d)
      expect(xs[0]).toBe(408 + 6)
      expect(xs.every(x => x > 408)).toBe(true)
      expect(xs.at(-1)).toBe(406 + 6)
      const hit = hits().find(p => p.getAttribute('d') === d)!
      await act(async () => { fireEvent.click(hit) })
      await h.settle()
      expect(opened()).toBe('SRC.c00>SRC.c70')
    })
  }, 30000)

  it('to a hint pill in a column to its left: it ends at that column\'s edge, never over its rows', async () => {
    usePreferencesStore.setState({ lineageRenderMode: 'stubs', showConnectedTrays: false } as never)
    const h = await renderCanvasWithTrace(tallColumnEstate(), { focus: 'SRC.c00' })
    act(() => {
      useCanvasStore.getState().addEdges([
        { id: 'to-dst', source: 'SRC.c70', target: 'DST.out', data: { edgeType: 'FLOWS_TO' } },
      ] as LineageEdge[])
    })
    await h.settle()
    // SRC's rows and its pill's strip on the left; DST.out in the column to their right.
    await withWidths({
      'layer-node-SRC.c00': [108, 408], 'layer-node-DST.out': [608, 908], 'anchor-rail-src-down': [110, 205],
    }, [110, 406], async () => {
      await act(async () => { useCanvasStore.getState().selectNode('SRC.c70') })
      await settleLines(h)
      const line = lineBetween('SRC.c70', 'DST.out')!
      const xs = pathXs(line.querySelector('path')!.getAttribute('d')!)
      // From just outside the strip's right to the arrowhead at DST.out's left.
      expect(xs[0]).toBe(406 + 6)
      expect(xs.at(-1)).toBe(608 - 8)
      expect(Math.min(...xs)).toBeGreaterThan(408)
    })
  }, 30000)

  for (const sides of ['direction', 'lines'] as const) {
    it(`to the tray, flowing OUT, Marker sides "${sides}": ${sides === 'direction' ? 'leaves the row on the right, down the right gutter' : 'leaves the row on the left, as every line within a column'}`, async () => {
      usePreferencesStore.setState({ lineageRenderMode: 'stubs', showConnectedTrays: true, lineagePortSides: sides } as never)
      const h = await dockedPartner([{ id: 'out', source: 'SRC.c00', target: 'SRC.c70' }])
      try {
        await withWidths({ 'layer-node-SRC.c00': [108, 408], 'anchor-proxy-SRC.c70': [112, 404] }, [112, 404], async () => {
          await h.clickCard('SRC.c00')
          await settleLines(h)
          expect(document.getElementById('anchor-proxy-SRC.c70')).not.toBeNull()
          const line = lineBetween('SRC.c00', 'SRC.c70')!
          const xs = pathXs(line.querySelector('path')!.getAttribute('d')!)
          if (sides === 'direction') {
            // Out of the row's right side, down the right gutter, to just outside the tray's right.
            expect(xs[0]).toBe(408 + 6)
            expect(Math.max(...xs)).toBe(408 + 6 + 24)
            expect(Math.min(...xs)).toBeGreaterThan(404)
            expect(xs.at(-1)).toBe(404 + 6)
          } else {
            expect(xs[0]).toBe(108 - 6)
            expect(Math.min(...xs)).toBe(108 - 6 - 24)
            expect(Math.max(...xs)).toBeLessThan(108)
            expect(xs.at(-1)).toBe(112 - 6)
          }
          // Its arrowhead points into the tray: the selection feeds SRC.c70.
          expect(line.querySelector('path[marker-end]')).not.toBeNull()
          expect(line.querySelector('path[marker-start]')).toBeNull()
          // Clickable, and it opens its relationship.
          const hit = hits().find(p => p.getAttribute('d') === line.querySelector('path')!.getAttribute('d'))!
          await act(async () => { fireEvent.click(hit) })
          await h.settle()
          expect(opened()).toBe('SRC.c00>SRC.c70')
        })
      } finally {
        usePreferencesStore.setState({ lineagePortSides: 'direction' } as never)
      }
    }, 30000)
  }
})

describe('the Anchor Rail', () => {
  it('names the partner and which way it flows; a click on it reveals it and keeps the selection', async () => {
    usePreferencesStore.setState({ lineageRenderMode: 'stubs', showConnectedTrays: true } as never)
    const h = await dockedPartner()
    await h.clickCard('SRC.c00')
    await settleLines(h)
    const entry = document.getElementById('anchor-proxy-SRC.c70')!
    expect(entry).toHaveTextContent('SRC.c70')
    expect(entry).toHaveTextContent('feeds SRC.c00')
    const pulsed = new Set<string>()
    const unsub = useCanvasStore.subscribe(s => { for (const id of s.pulseNodeIds) pulsed.add(id) })
    try {
      await act(async () => { fireEvent.click(entry) })
      await wait(200)
      await h.settle()
    } finally {
      unsub()
    }
    // The drawer's reveal: the partner's row is scrolled to and pulses; the selection stays.
    expect([...pulsed]).toEqual(['SRC.c70'])
    expect(useCanvasStore.getState().selectedNodeIds).toEqual(['SRC.c00'])
  }, 30000)

  it('a partner inside a collapsed card is named, not the card; a click reveals it and keeps the selection', async () => {
    usePreferencesStore.setState({ lineageRenderMode: 'stubs', showConnectedTrays: true } as never)
    const h = await dockedPartner(
      [{ id: 'key', source: 'SRC.c70.k', target: 'SRC.c00' }],
      tallColumnEstate({ 'SRC.c70': { 'SRC.c70.k': 'order_key' } }),
    )
    await h.clickCard('SRC.c00')
    await settleLines(h)
    const proxies = useAnchorRailStore.getState().groups.get('src')!.proxies
    expect(proxies).toHaveLength(1)
    expect(proxies[0]).toMatchObject({ nodeId: 'SRC.c70', flow: 'in', realId: 'SRC.c70.k' })
    const entry = document.getElementById('anchor-proxy-SRC.c70')!
    expect(entry.textContent).toMatch(/^order_key/)
    expect(entry).toHaveTextContent('feeds SRC.c00 · in SRC.c70')
    const pulsed = new Set<string>()
    const unsub = useCanvasStore.subscribe(s => { for (const id of s.pulseNodeIds) pulsed.add(id) })
    try {
      await act(async () => { fireEvent.click(entry) })
      await wait(200)
      await h.settle()
    } finally {
      unsub()
    }
    expect([...pulsed]).toEqual(['SRC.c70.k'])
    expect(useCanvasStore.getState().selectedNodeIds).toEqual(['SRC.c00'])
  }, 30000)

  it('an entry for several entities in a collapsed card opens the card down to them, pulses them and scrolls to them', async () => {
    usePreferencesStore.setState({ lineageRenderMode: 'stubs', showConnectedTrays: true } as never)
    const h = await dockedPartner(
      [{ id: 'k1', source: 'SRC.c70.a', target: 'SRC.c00' }, { id: 'k2', source: 'SRC.c70.b', target: 'SRC.c00' }],
      tallColumnEstate({ 'SRC.c70': { 'SRC.c70.a': 'order_key', 'SRC.c70.b': 'order_date' } }),
    )
    await h.clickCard('SRC.c00')
    await settleLines(h)
    expect(useAnchorRailStore.getState().groups.get('src')!.proxies[0])
      .toMatchObject({ nodeId: 'SRC.c70', partners: 2, realIds: ['SRC.c70.a', 'SRC.c70.b'] })
    const entry = document.getElementById('anchor-proxy-SRC.c70')!
    expect(entry).toHaveTextContent('2 sources')
    // The column is asked to scroll to them. jsdom lays nothing out, so the offset it asks for
    // clamps to 0: the virtualizer's request is the proof.
    const scrolledTo: number[] = []
    const scrollTo = Element.prototype.scrollTo
    Element.prototype.scrollTo = function (this: Element, arg?: ScrollToOptions | number) {
      if (typeof arg === 'object' && typeof arg.top === 'number') scrolledTo.push(arg.top)
    } as typeof Element.prototype.scrollTo
    const pulsed = new Set<string>()
    const unsub = useCanvasStore.subscribe(s => { for (const id of s.pulseNodeIds) pulsed.add(id) })
    try {
      await act(async () => { fireEvent.click(entry) })
      await wait(300)
      await h.settle()
    } finally {
      unsub()
      Element.prototype.scrollTo = scrollTo
    }
    expect([...pulsed].sort()).toEqual(['SRC.c70.a', 'SRC.c70.b'])
    expect(scrolledTo.length).toBeGreaterThan(0)
    // The card is open: its entities are rows now, each off-screen partner listed by its own name.
    const listed = useAnchorRailStore.getState().groups.get('src')!.proxies.map(p => p.nodeId).sort()
    expect(listed).toEqual(['SRC.c70.a', 'SRC.c70.b'])
    expect(useCanvasStore.getState().selectedNodeIds).toEqual(['SRC.c00'])
  }, 30000)

  it('clears once the selection\'s off-screen partner is gone, the selection still on screen', async () => {
    usePreferencesStore.setState({ lineageRenderMode: 'stubs', showConnectedTrays: true } as never)
    const h = await dockedPartner()
    await h.clickCard('SRC.c00')
    await settleLines(h)
    expect(document.getElementById('anchor-proxy-SRC.c70')).not.toBeNull()
    act(() => { useCanvasStore.getState().removeEdges(['same']) })
    await wait(500)
    await h.settle()
    expect(useAnchorRailStore.getState().groups.size).toBe(0)
    expect(document.getElementById('anchor-proxy-SRC.c70')).toBeNull()
  }, 30000)
})

describe('the line the relationship drawer is open on marks its two ends', () => {
  const tags = () => [...document.querySelectorAll<HTMLElement>('[data-line-end]')]
  const tagOf = (id: string) => row(id)?.querySelector('[data-line-end]')?.getAttribute('data-line-end') ?? null

  it('as From and To, only while the drawer is open on it — not for a selection, and nothing dims', async () => {
    usePreferencesStore.setState({ lineageRenderMode: 'stubs' })
    const h = await twoLinesAtTableau()
    expect(tags()).toHaveLength(0)
    // A selected card is not an open line: no end is marked.
    await h.clickCard('tableau')
    await settleLines(h)
    expect(tags()).toHaveLength(0)

    await act(async () => { fireEvent.click(hits()[0]) })
    await settleLines(h)
    const [from, to] = opened()!.split('>')
    expect(tagOf(from)).toBe('from')
    expect(tagOf(to)).toBe('to')
    expect(row(from).textContent).toContain('From')
    expect(tags()).toHaveLength(2)
    // Lit, with nothing dimmed: every row on screen keeps its full opacity.
    expect(row(from).className).toContain('ring-blue-400/40')
    expect(h.visibleCardIds().filter(id => row(id).className.includes('opacity-40'))).toEqual([])

    h.pressEscape()
    await h.settle()
    expect(useCanvasStore.getState().drawerEdge).toBeNull()
    expect(tags()).toHaveLength(0)
  }, 30000)

  it('a two-way line marks both ends Two-way', async () => {
    usePreferencesStore.setState({ lineageRenderMode: 'raw' })
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo' })
    act(() => {
      useCanvasStore.getState().addEdges([
        { id: 'fw', source: 'INTERMEDIATE_T2', target: 'tableau', data: { edgeType: 'FLOWS_TO' } },
        { id: 'bw', source: 'tableau', target: 'INTERMEDIATE_T2', data: { edgeType: 'FLOWS_TO' } },
      ] as LineageEdge[])
    })
    await settleLines(h)
    await act(async () => { fireEvent.click(hits()[0]) })
    await settleLines(h)
    expect(tagOf('INTERMEDIATE_T2')).toBe('twoWay')
    expect(tagOf('tableau')).toBe('twoWay')
  }, 30000)

  it('an end scrolled away: the line stays drawn, docked to that end\'s rail entry, which says which end it is — and only it docks', async () => {
    usePreferencesStore.setState({ lineageRenderMode: 'stubs', showConnectedTrays: true } as never)
    // SRC.c00 feeds SRC.c70 (off-screen below) and is fed by SRC.c75 (off-screen too).
    const h = await dockedPartner([
      { id: 'out', source: 'SRC.c00', target: 'SRC.c70' },
      { id: 'in', source: 'SRC.c75', target: 'SRC.c00' },
    ])
    await h.clickCard('SRC.c00')
    await settleLines(h)
    await drawn(2)
    const outLine = lineBetween('SRC.c00', 'SRC.c70')!
    const outId = outLine.getAttribute('data-edge-id')!
    const hit = hits().find(p => p.getAttribute('d') === outLine.querySelector('path')!.getAttribute('d'))!
    await act(async () => { fireEvent.click(hit) })
    await settleLines(h)

    // The click took the selection; the drawer is open on the line.
    expect(useCanvasStore.getState().selectedNodeIds).toEqual([])
    expect(opened()).toBe('SRC.c00>SRC.c70')
    // It is still drawn, to the far end's entry, which is marked To; the source's row is From.
    await drawn(1)
    expect(lineIds()).toEqual([outId])
    const entry = document.getElementById('anchor-proxy-SRC.c70')!
    expect(entry.querySelector('[data-line-end]')?.getAttribute('data-line-end')).toBe('to')
    expect(entry.getAttribute('aria-label')).toContain('to end')
    expect(tagOf('SRC.c00')).toBe('from')
    // Only the open line docks: the source's other off-screen partner is not listed.
    expect(document.getElementById('anchor-proxy-SRC.c75')).toBeNull()
  }, 30000)
})
