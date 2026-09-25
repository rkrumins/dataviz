import { describe, expect, it } from 'vitest'
import { buildNodePorts, portView } from '../lineagePorts'

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
