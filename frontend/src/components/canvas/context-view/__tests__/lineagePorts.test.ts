import { describe, expect, it } from 'vitest'
import type { OffCanvasFlows, OffCanvasLineage } from '@/hooks/useEdgeProjection'
import { buildNodePorts, columnEndLayer, portView, unloadedColumnLines } from '../lineagePorts'

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
    ({ ...flows(0, 0), columns: new Map(Object.entries(columns)) })
  // The anchored Warehouse column's id, placed like the columns above.
  const columnAt: Record<string, number> = { WH: 3, REP: 4 }
  const layerOfAny = (id: string) => layer[id] ?? columnAt[columnEndLayer(id) ?? '']

  it('a row whose only lineage leads to rows Warehouse has not loaded is solid on the side facing it', () => {
    const lines = unloadedColumnLines(new Map([['rep', undrawn({ WH: flows(0, 4) })]]))
    const ports = buildNodePorts(lines, layerOfAny)
    expect(ports.get('rep')!.left).toEqual({ in: 0, out: 1 })
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
    expect(ports.get('rep')!.left).toEqual({ in: 1, out: 2 })
    expect(ports.get('src')!.right).toEqual({ in: 1, out: 0 })
  })

  it('a row with nothing undrawn in any column adds no line', () => {
    expect(unloadedColumnLines(new Map([['rep', undrawn({})]]))).toEqual([])
    expect(unloadedColumnLines(new Map([['rep', undrawn({ WH: flows(0, 0) })]]))).toEqual([])
  })
})
