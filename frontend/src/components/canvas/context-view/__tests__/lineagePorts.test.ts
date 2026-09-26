import { describe, expect, it } from 'vitest'
import type { ColumnFlows, OffCanvasLineage } from '@/hooks/useEdgeProjection'
import { buildNodePorts, columnEndLayer, partialLines, portTotals, portView, sideVolume, unloadedColumnLines, unplacedLines } from '../lineagePorts'

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

  it('lineage no line shows yet: solid on the conventional side', () => {
    expect(portView('left', undefined, { in: 12, out: 0 })).toEqual({ kind: 'lineage', dir: 'in' })
    expect(portView('right', undefined, { in: 12, out: 0 })).toBeNull()
    expect(portView('right', undefined, { in: 0, out: 3 })).toEqual({ kind: 'lineage', dir: 'out' })
  })

  it('hollow only for lineage the canvas placed outside the view', () => {
    expect(portView('left', undefined, { in: 12, out: 0 }, false, { in: 12, out: 0 })).toEqual({ kind: 'beyond', dir: 'in' })
    // Confirmed, it needs no total.
    expect(portView('right', undefined, undefined, false, { in: 0, out: 2 })).toEqual({ kind: 'beyond', dir: 'out' })
    // The other direction's outside says nothing about this one.
    expect(portView('right', undefined, { in: 12, out: 1 }, false, { in: 3, out: 0 })).toEqual({ kind: 'lineage', dir: 'out' })
  })

  it('hollow only when what it placed outside accounts for everything it counted that way', () => {
    // Two flows in, one placed outside: the other is somewhere the canvas
    // has not read — a partner pruned with a collapse, a member not primed.
    expect(portView('left', undefined, { in: 2, out: 0 }, false, { in: 1, out: 0 })).toEqual({ kind: 'lineage', dir: 'in' })
    expect(portView('left', undefined, { in: 2, out: 0 }, false, { in: 2, out: 0 })).toEqual({ kind: 'beyond', dir: 'in' })
  })

  it('holding roll-up cells is lineage, never a flow more to account for', () => {
    // A cube server flags every entity with a flow: its own flow is a cell
    // to the ancestors of its far end.
    expect(portView('left', undefined, { in: 1, out: 0, rollupIn: 1, rollupOut: 0 }, false, { in: 1, out: 0 }))
      .toEqual({ kind: 'beyond', dir: 'in' })
    expect(portView('right', undefined, { in: 0, out: 5, rollupIn: 0, rollupOut: 1 }, false, { in: 0, out: 5 }))
      .toEqual({ kind: 'beyond', dir: 'out' })
    expect(portView('left', undefined, { in: 2, out: 0, rollupIn: 1, rollupOut: 0 }, false, { in: 1, out: 0 }))
      .toEqual({ kind: 'lineage', dir: 'in' })
  })

  it('no marker for a direction the canvas already shows', () => {
    const ports = buildNodePorts([{ source: 'rep', target: 'src' }], layerOf)
    // `src` has incoming on its right; neither its total in nor its flows
    // placed outside add an incoming port on the left as well.
    expect(portView('left', ports.get('src'), { in: 40, out: 0 })).toBeNull()
    expect(portView('left', ports.get('src'), { in: 40, out: 0 }, false, { in: 5, out: 0 })).toBeNull()
  })

  it('a line that stands aside says the lineage is in view: never hollow, and no marker of its own', () => {
    const ports = buildNodePorts([{ source: 'src', target: 'wh', isDelegated: true }], layerOf)
    expect(portView('right', ports.get('src'), { in: 0, out: 0 }, false, { in: 0, out: 2 })).toEqual({ kind: 'lineage', dir: 'out' })
    expect(portView('right', ports.get('src'), { in: 0, out: 0 })).toBeNull()
    expect(portView('left', ports.get('wh'), { in: 0, out: 0 })).toBeNull()
  })

  it('no lineage, or a total still on its way: no port', () => {
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

  it('never when anything else says it has lineage', () => {
    expect(portView('left', undefined, undefined, true, { in: 2, out: 0 })).toEqual({ kind: 'beyond', dir: 'in' })
    expect(portView('right', undefined, undefined, true, { in: 2, out: 0 })).toBeNull()
    const held = buildNodePorts(unplacedLines(new Map([['rep', {
      in: 0, out: 0, inPartners: new Set<string>(), outPartners: new Set<string>(), columns: new Map(), unplaced: { in: 0, out: 1 },
    }]])), () => undefined)
    expect(portView('right', held.get('rep'), undefined, true)).toEqual({ kind: 'lineage', dir: 'out' })
    expect(portView('left', held.get('rep'), undefined, true)).toBeNull()
  })

  it('never once its total says it has lineage', () => {
    expect(portView('left', undefined, { in: 3, out: 0 }, true)).toEqual({ kind: 'lineage', dir: 'in' })
    expect(portView('right', undefined, { in: 3, out: 0 }, true)).toBeNull()
    expect(portView('left', undefined, { in: 0, out: 0, rollupIn: 0, rollupOut: 1 }, true)).toBeNull()
  })

  it('a total whose roll-up check failed says nothing yet: unknown while nothing else does', () => {
    // Flows counted, none; whether it holds roll-up cells, not known.
    expect(portView('left', undefined, { in: 0, out: 0 }, true)).toEqual({ kind: 'unknown', dir: 'both' })
    expect(portView('left', undefined, { in: 0, out: 0 })).toBeNull()
  })
})

describe('unloadedColumnLines — lineage into rows an anchored column has not drawn is IN the view', () => {
  // Naming no row: an anchor's rest.
  const flows = (inN: number, outN: number): ColumnFlows =>
    ({ in: inN, out: outN, inPartners: new Set(), outPartners: new Set(), unnamed: { in: inN, out: outN } })
  const undrawn = (columns: Record<string, ColumnFlows>): OffCanvasLineage =>
    ({ in: 0, out: 0, inPartners: new Set(), outPartners: new Set(), columns: new Map(Object.entries(columns)), unplaced: { in: 0, out: 0 } })
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
    const toRows: ColumnFlows = { in: 0, out: 9, inPartners: new Set(), outPartners: new Set(['w1', 'w2', 'w3']), unnamed: { in: 0, out: 0 } }
    const lines = unloadedColumnLines(new Map([['rep', undrawn({ WH: toRows })]]))
    expect(lines).toHaveLength(1)
    const ports = buildNodePorts([...lines, { source: 'rep', target: 'src' }], layerOfAny)
    // Three rows of Warehouse not drawn, and one line drawn to Source.
    expect(ports.get('rep')!.left).toEqual({ in: 0, out: 4 })
    expect(sideVolume(ports.get('rep'), 'left')).toBe(4)
  })

  it('rows it names and an anchor\'s rest: the larger, so a forty-flow rest is not one line', () => {
    const mixed: ColumnFlows = { in: 0, out: 41, inPartners: new Set(), outPartners: new Set(['w1']), unnamed: { in: 0, out: 40 } }
    const lines = unloadedColumnLines(new Map([['rep', undrawn({ WH: mixed })]]))
    expect(lines).toEqual([{ source: 'rep', target: 'column:WH', weight: 40 }])
  })

  it('a row with nothing undrawn in any column adds no line', () => {
    expect(unloadedColumnLines(new Map([['rep', undrawn({})]]))).toEqual([])
    expect(unloadedColumnLines(new Map([['rep', undrawn({ WH: flows(0, 0) })]]))).toEqual([])
  })
})

describe('unplacedLines — lineage whose far end is not placed yet is solid, never hollow', () => {
  const held = (inN: number, outN: number): OffCanvasLineage => ({
    in: 0, out: 0, inPartners: new Set(), outPartners: new Set(), columns: new Map(), unplaced: { in: inN, out: outN },
  })
  const layerOfRow = (id: string) => (id === 'rep' ? 4 : undefined)

  it('says the card has lineage that way, on the conventional side, with no line of its own', () => {
    const ports = buildNodePorts(unplacedLines(new Map([['rep', held(0, 2)]])), layerOfRow)
    expect(ports.get('rep')!.right).toEqual({ in: 0, out: 0 })
    expect(portView('right', ports.get('rep'), { in: 0, out: 2 }, false, { in: 0, out: 1 })).toEqual({ kind: 'lineage', dir: 'out' })
    // With no total at all (a draft cannot count).
    expect(portView('right', ports.get('rep'), undefined)).toEqual({ kind: 'lineage', dir: 'out' })
    expect(portView('left', ports.get('rep'), { in: 0, out: 2 })).toBeNull()
  })

  it('leaves the other direction to say what it knows', () => {
    const ports = buildNodePorts(unplacedLines(new Map([['rep', held(0, 2)]])), layerOfRow)
    expect(portView('left', ports.get('rep'), { in: 1, out: 2 }, false, { in: 1, out: 0 })).toEqual({ kind: 'beyond', dir: 'in' })
  })

  it('adds no line for a row with nothing held', () => {
    expect(unplacedLines(new Map([['rep', held(0, 0)]]))).toEqual([])
  })
})

describe('portView — a container whose lineage sits below it', () => {
  it('roll-up cells say it has lineage: solid, never hollow on their own', () => {
    // They cannot tell lineage between its own rows from lineage leaving it.
    expect(portView('right', undefined, { in: 0, out: 0, rollupIn: 0, rollupOut: 1 })).toEqual({ kind: 'lineage', dir: 'out' })
    expect(portView('left', undefined, { in: 0, out: 0, rollupIn: 1, rollupOut: 0 })).toEqual({ kind: 'lineage', dir: 'in' })
    expect(portView('left', undefined, { in: 0, out: 0, rollupIn: 0, rollupOut: 1 })).toBeNull()
  })

  it('hollow once what it holds is placed outside the view', () => {
    expect(portView('right', undefined, { in: 0, out: 0, rollupIn: 0, rollupOut: 1 }, false, { in: 0, out: 7 }))
      .toEqual({ kind: 'beyond', dir: 'out' })
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
      new Set(), closed,
    )
    expect(totals.get('logical:g')).toEqual({ in: 1, out: 2, rollupIn: 0, rollupOut: 1 })
    expect(totals.get('logical:inner')).toEqual({ in: 0, out: 0, rollupIn: 0, rollupOut: 1 })
    expect(portView('right', undefined, totals.get('logical:g'))).toEqual({ kind: 'lineage', dir: 'out' })
  })

  it("a member's lineage is the group's at once; unknown only when none has any and a count failed", () => {
    const roots = [group('logical:g', [entity('a'), entity('b')])]
    const waiting = portTotals(roots, new Map([['a', { in: 1, out: 0 }]]), new Set(), closed)
    expect(waiting.totals.get('logical:g')).toEqual({ in: 1, out: 0, rollupIn: 0, rollupOut: 0 })
    const failed = portTotals(roots, new Map([['a', { in: 1, out: 0 }]]), new Set(['b']), closed)
    expect(failed.totals.get('logical:g')).toEqual({ in: 1, out: 0, rollupIn: 0, rollupOut: 0 })
    expect(failed.failed.has('logical:g')).toBe(false)

    const nothingYet = portTotals(roots, new Map([['a', { in: 0, out: 0 }]]), new Set(), closed)
    expect(nothingYet.totals.has('logical:g')).toBe(false)
    expect(nothingYet.failed.has('logical:g')).toBe(false)
    const nothingKnown = portTotals(roots, new Map([['a', { in: 0, out: 0 }]]), new Set(['b']), closed)
    expect(nothingKnown.totals.has('logical:g')).toBe(false)
    expect(nothingKnown.failed.has('logical:g')).toBe(true)
  })

  it("a member whose roll-up check failed still lends the group the flows it counted", () => {
    const roots = [group('logical:g', [entity('a'), entity('b')])]
    const counted = portTotals(roots, new Map([['a', { in: 0, out: 2 }], ['b', { in: 0, out: 0 }]]), new Set(['a']), closed)
    expect(counted.totals.get('logical:g')).toEqual({ in: 0, out: 2, rollupIn: 0, rollupOut: 0 })
    expect(counted.failed.has('logical:g')).toBe(false)
    const none = portTotals(roots, new Map([['a', { in: 0, out: 0 }], ['b', { in: 0, out: 0 }]]), new Set(['a']), closed)
    expect(none.failed.has('logical:g')).toBe(true)
  })

  it('an open container reads its own flows alone, so a failed roll-up check leaves it counted', () => {
    const open = (id: string) => id === 'box'
    const { totals, failed } = portTotals([entity('box', [entity('box.t')])],
      new Map([['box', { in: 0, out: 0 }]]), new Set(['box']), open)
    expect(totals.get('box')).toEqual({ in: 0, out: 0 })
    expect(failed.has('box')).toBe(false)
    // Closed, whether it holds cells is what it has to say.
    expect(portTotals([entity('box')], new Map([['box', { in: 0, out: 0 }]]), new Set(['box']), closed).failed.has('box')).toBe(true)
  })

  it('an open group, or an open container, leaves it to what it holds', () => {
    const open = (id: string) => id === 'logical:g' || id === 'box'
    const { totals } = portTotals(
      [group('logical:g', [entity('a')]), entity('box', [entity('box.t')])],
      new Map([['a', { in: 1, out: 0 }], ['box', { in: 0, out: 0, rollupIn: 1, rollupOut: 1 }]]),
      new Set(), open,
    )
    expect(totals.has('logical:g')).toBe(false)
    // Its own flows still count; its roll-up cells summarise rows it now shows.
    expect(totals.get('box')).toEqual({ in: 0, out: 0 })
    expect(portView('left', undefined, totals.get('box'))).toBeNull()
    expect(totals.get('a')).toEqual({ in: 1, out: 0 })
  })
})

describe('partialLines — a row whose lineage was read only in part is solid that way, never hollow', () => {
  const layerOfRow = (id: string) => (id === 'rep' ? 4 : undefined)

  it('says the card has lineage that way, draws no line, and leaves the other alone', () => {
    const ports = buildNodePorts(partialLines({ in: new Set(), out: new Set(['rep']) }), layerOfRow)
    expect(ports.get('rep')!.right).toEqual({ in: 0, out: 0 })
    expect(portView('right', ports.get('rep'), { in: 1, out: 3 }, false, { in: 1, out: 1 })).toEqual({ kind: 'lineage', dir: 'out' })
    expect(portView('left', ports.get('rep'), { in: 1, out: 3 }, false, { in: 1, out: 1 })).toEqual({ kind: 'beyond', dir: 'in' })
  })
})
