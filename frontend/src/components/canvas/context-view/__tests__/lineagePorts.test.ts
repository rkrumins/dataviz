import { describe, expect, it } from 'vitest'
import type { OffCanvasFlows, OffCanvasLineage } from '@/hooks/useEdgeProjection'
import { buildNodePorts, columnEndLayer, portTotals, portView, sideVolume, unloadedColumnLines, unplacedLines } from '../lineagePorts'

// Columns left to right: Source 0, Warehouse 3, Report 4.
const layer: Record<string, number> = { src: 0, wh: 3, rep: 4, rep2: 4 }
const layerOf = (id: string) => layer[id]

describe('buildNodePorts — a port sits where the lines plug in', () => {
  it('a line to a column on the right leaves by the right edge and arrives on the left', () => {
    const ports = buildNodePorts([{ source: 'src', target: 'wh' }], layerOf)
    expect(ports.get('src')!.right).toEqual({ in: 0, out: 1 })
    expect(ports.get('wh')!.left).toEqual({ in: 1, out: 0 })
  })

  it('a right-to-left line leaves by the LEFT edge — the Report cards on ABCDE', () => {
    // Every Report line ran back to Source / Warehouse; the old ports put
    // the marker on the right while every line met the bare left edge.
    const ports = buildNodePorts([{ source: 'rep', target: 'src' }], layerOf)
    expect(ports.get('rep')!.left).toEqual({ in: 0, out: 1 })
    expect(ports.get('rep')!.right).toEqual({ in: 0, out: 0 })
    expect(ports.get('src')!.right).toEqual({ in: 1, out: 0 })
  })

  it('two cards in one column meet on the left, where their lane runs', () => {
    const ports = buildNodePorts([{ source: 'rep', target: 'rep2' }], layerOf)
    expect(ports.get('rep')!.left.out).toBe(1)
    expect(ports.get('rep2')!.left.in).toBe(1)
  })

  it('an end in no known column takes the convention: out right, in left', () => {
    const ports = buildNodePorts([{ source: 'src', target: 'ghost' }], layerOf)
    expect(ports.get('src')!.right.out).toBe(1)
    expect(ports.get('ghost')!.left.in).toBe(1)
  })

  it('a two-way bundle carries both directions on the side facing its partner', () => {
    // Drawn once, oriented by id (src < wh), but data flows both ways.
    const ports = buildNodePorts([{ source: 'src', target: 'wh', isBidirectional: true }], layerOf)
    expect(ports.get('src')!.right).toEqual({ in: 1, out: 1 })
    expect(ports.get('wh')!.left).toEqual({ in: 1, out: 1 })
    expect(portView('right', ports.get('src'), undefined)).toEqual({ kind: 'here', dir: 'both' })
    expect(portView('left', ports.get('wh'), undefined)).toEqual({ kind: 'here', dir: 'both' })
  })

  it('a line that stands aside for finer ones makes no port', () => {
    const ports = buildNodePorts([{ source: 'src', target: 'wh', isDelegated: true }], layerOf)
    expect(ports.get('src')!.right).toEqual({ in: 0, out: 0 })
    expect(ports.get('wh')!.left).toEqual({ in: 0, out: 0 })
    expect(portView('right', ports.get('src'), undefined)).toBeNull()
  })
})

describe('portView — what each side shows', () => {
  it('a side carrying both directions says both', () => {
    const ports = buildNodePorts([
      { source: 'src', target: 'wh' },
      { source: 'rep', target: 'src' },
    ], layerOf)
    expect(portView('right', ports.get('src'), undefined)).toEqual({ kind: 'here', dir: 'both' })
    expect(portView('left', ports.get('src'), undefined)).toBeNull()
  })

  it('lineage with nothing on this canvas: a hollow port on the conventional side', () => {
    expect(portView('left', undefined, { in: 12, out: 0 })).toEqual({ kind: 'beyond', dir: 'in' })
    expect(portView('right', undefined, { in: 12, out: 0 })).toBeNull()
  })

  it('no hollow port for a direction the canvas already shows', () => {
    const ports = buildNodePorts([{ source: 'rep', target: 'src' }], layerOf)
    // `src` has incoming on its right; its total in must not add a hollow
    // incoming port on the left as well.
    expect(portView('left', ports.get('src'), { in: 40, out: 0 })).toBeNull()
  })

  it('a line that stands aside still says the lineage is in view — no hollow port', () => {
    const ports = buildNodePorts([{ source: 'src', target: 'wh', isDelegated: true }], layerOf)
    expect(portView('right', ports.get('src'), { in: 0, out: 5 })).toBeNull()
    expect(portView('left', ports.get('wh'), { in: 5, out: 0 })).toBeNull()
  })

  it('no lineage, or an unknown total: no port', () => {
    expect(portView('left', undefined, { in: 0, out: 0 })).toBeNull()
    expect(portView('right', undefined, undefined)).toBeNull()
  })
})

describe('portView — a card whose lineage could not be counted', () => {
  it('says unknown on both sides, in neither direction colour', () => {
    expect(portView('left', undefined, undefined, true)).toEqual({ kind: 'unknown', dir: 'both' })
    expect(portView('right', undefined, undefined, true)).toEqual({ kind: 'unknown', dir: 'both' })
  })

  it('never when a line of its own already says it has lineage', () => {
    const ports = buildNodePorts([{ source: 'src', target: 'wh' }], layerOf)
    expect(portView('left', ports.get('src'), undefined, true)).toBeNull()
    expect(portView('right', ports.get('src'), undefined, true)).toEqual({ kind: 'here', dir: 'out' })
    const standing = buildNodePorts([{ source: 'src', target: 'wh', isDelegated: true }], layerOf)
    expect(portView('left', standing.get('src'), undefined, true)).toBeNull()
  })

  it('never once its total is known', () => {
    expect(portView('left', undefined, { in: 0, out: 0 }, true)).toBeNull()
    expect(portView('left', undefined, { in: 3, out: 0 }, true)).toEqual({ kind: 'beyond', dir: 'in' })
  })
})

describe('unloadedColumnLines — lineage into rows an anchored column has not drawn is IN the view', () => {
  const flows = (inN: number, outN: number): OffCanvasFlows =>
    ({ in: inN, out: outN, inPartners: new Set(), outPartners: new Set() })
  const undrawn = (columns: Record<string, OffCanvasFlows>): OffCanvasLineage =>
    ({ ...flows(0, 0), columns: new Map(Object.entries(columns)), unplaced: { in: 0, out: 0 } })
  // The anchored Warehouse column's id, placed like the columns above.
  const columnAt: Record<string, number> = { WH: 3, REP: 4 }
  const layerOfAny = (id: string) => layer[id] ?? columnAt[columnEndLayer(id) ?? '']

  it('a row whose only lineage leads to rows Warehouse has not loaded is solid on the side facing it', () => {
    const lines = unloadedColumnLines(new Map([['rep', undrawn({ WH: flows(0, 4) })]]))
    const ports = buildNodePorts(lines, layerOfAny)
    expect(ports.get('rep')!.left).toEqual({ in: 0, out: 4 })
    expect(portView('left', ports.get('rep'), { in: 0, out: 4 })).toEqual({ kind: 'here', dir: 'out' })
    // Not hollow on the conventional side: that would say "only outside".
    expect(portView('right', ports.get('rep'), { in: 0, out: 4 })).toBeNull()
  })

  it("one line per row, column and direction; toward the row's own column it meets the left", () => {
    const lines = unloadedColumnLines(new Map([
      ['rep', undrawn({ WH: flows(2, 7), REP: flows(0, 1) })],
      ['src', undrawn({ WH: flows(5, 0) })],
    ]))
    expect(lines).toHaveLength(4)
    const ports = buildNodePorts(lines, layerOfAny)
    // Naming no row (an anchor's rest), each counts its flows.
    expect(ports.get('rep')!.left).toEqual({ in: 2, out: 8 })
    expect(ports.get('src')!.right).toEqual({ in: 5, out: 0 })
  })

  it('counts the lines it stands for: one per row it reaches, and the glow follows', () => {
    const toRows: OffCanvasFlows = { in: 0, out: 9, inPartners: new Set(), outPartners: new Set(['w1', 'w2', 'w3']) }
    const lines = unloadedColumnLines(new Map([['rep', undrawn({ WH: toRows })]]))
    expect(lines).toHaveLength(1)
    const ports = buildNodePorts([...lines, { source: 'rep', target: 'src' }], layerOfAny)
    // Three rows of Warehouse not drawn, and one line drawn to Source.
    expect(ports.get('rep')!.left).toEqual({ in: 0, out: 4 })
    expect(sideVolume(ports.get('rep'), 'left')).toBe(4)
  })

  it('a row with nothing undrawn in any column adds no line', () => {
    expect(unloadedColumnLines(new Map([['rep', undrawn({})]]))).toEqual([])
    expect(unloadedColumnLines(new Map([['rep', undrawn({ WH: flows(0, 0) })]]))).toEqual([])
  })
})

describe('unplacedLines — lineage whose far end is not placed yet never reads hollow', () => {
  const held = (inN: number, outN: number): OffCanvasLineage => ({
    in: 0, out: 0, inPartners: new Set(), outPartners: new Set(), columns: new Map(), unplaced: { in: inN, out: outN },
  })
  const layerOfRow = (id: string) => (id === 'rep' ? 4 : undefined)

  it('keeps that direction from reading hollow, and draws no port for it', () => {
    const ports = buildNodePorts(unplacedLines(new Map([['rep', held(0, 2)]])), layerOfRow)
    expect(portView('right', ports.get('rep'), { in: 0, out: 2 })).toBeNull()
    expect(portView('left', ports.get('rep'), { in: 0, out: 2 })).toBeNull()
  })

  it('leaves the other direction to say what it knows', () => {
    const ports = buildNodePorts(unplacedLines(new Map([['rep', held(0, 2)]])), layerOfRow)
    expect(portView('left', ports.get('rep'), { in: 1, out: 2 })).toEqual({ kind: 'beyond', dir: 'in' })
  })

  it('adds no line for a row with nothing held', () => {
    expect(unplacedLines(new Map([['rep', held(0, 0)]]))).toEqual([])
  })
})

describe('portView — a container whose lineage sits below it', () => {
  it('roll-up cells say it has lineage: hollow when none of it is on the canvas', () => {
    expect(portView('right', undefined, { in: 0, out: 0, rollupIn: 0, rollupOut: 1 })).toEqual({ kind: 'beyond', dir: 'out' })
    expect(portView('left', undefined, { in: 0, out: 0, rollupIn: 1, rollupOut: 0 })).toEqual({ kind: 'beyond', dir: 'in' })
    expect(portView('left', undefined, { in: 0, out: 0, rollupIn: 0, rollupOut: 1 })).toBeNull()
  })

  it('never when some of it is on the canvas', () => {
    const ports = buildNodePorts([{ source: 'src', target: 'wh' }], layerOf)
    expect(portView('right', ports.get('src'), { in: 0, out: 0, rollupIn: 0, rollupOut: 1 })).toEqual({ kind: 'here', dir: 'out' })
  })
})

describe('portTotals — what each card reads for the lineage it has no line for', () => {
  type Node = { id: string; isLogical?: boolean; children: Node[] }
  const entity = (id: string, children: Node[] = []): Node => ({ id, children })
  const group = (id: string, children: Node[]): Node => ({ id, isLogical: true, children })
  const closed = () => false

  it('a closed group reads its members\' totals, summed', () => {
    const { totals } = portTotals(
      [group('logical:g', [entity('a'), entity('b'), group('logical:inner', [entity('c')])])],
      new Map([['a', { in: 1, out: 0 }], ['b', { in: 0, out: 2 }], ['c', { in: 0, out: 0, rollupIn: 0, rollupOut: 1 }]]),
      new Set(), closed, false,
    )
    expect(totals.get('logical:g')).toEqual({ in: 1, out: 2, rollupIn: 0, rollupOut: 1 })
    expect(totals.get('logical:inner')).toEqual({ in: 0, out: 0, rollupIn: 0, rollupOut: 1 })
    expect(portView('right', undefined, totals.get('logical:g'))).toEqual({ kind: 'beyond', dir: 'out' })
  })

  it('only once every member is counted; a member whose count failed makes it unknown', () => {
    const roots = [group('logical:g', [entity('a'), entity('b')])]
    const waiting = portTotals(roots, new Map([['a', { in: 1, out: 0 }]]), new Set(), closed, false)
    expect(waiting.totals.has('logical:g')).toBe(false)
    expect(waiting.failed.has('logical:g')).toBe(false)
    const failed = portTotals(roots, new Map([['a', { in: 1, out: 0 }]]), new Set(['b']), closed, false)
    expect(failed.totals.has('logical:g')).toBe(false)
    expect(failed.failed.has('logical:g')).toBe(true)
  })

  it('an open group, or an open container, leaves it to what it holds', () => {
    const open = (id: string) => id === 'logical:g' || id === 'box'
    const { totals } = portTotals(
      [group('logical:g', [entity('a')]), entity('box', [entity('box.t')])],
      new Map([['a', { in: 1, out: 0 }], ['box', { in: 0, out: 0, rollupIn: 1, rollupOut: 1 }]]),
      new Set(), open, false,
    )
    expect(totals.has('logical:g')).toBe(false)
    // Its own flows still count; its roll-up cells summarise rows it now shows.
    expect(totals.get('box')).toEqual({ in: 0, out: 0 })
    expect(portView('left', undefined, totals.get('box'))).toBeNull()
    expect(totals.get('a')).toEqual({ in: 1, out: 0 })
  })

  it('a hidden flow type could explain any gap: no card reads hollow', () => {
    const { totals, failed } = portTotals(
      [entity('a'), entity('b')],
      new Map([['a', { in: 3, out: 0 }]]), new Set(['b']), closed, true,
    )
    expect(portView('left', undefined, totals.get('a'))).toBeNull()
    // A count that failed still says so.
    expect(portView('left', undefined, totals.get('b'), failed.has('b'))).toEqual({ kind: 'unknown', dir: 'both' })
  })
})
