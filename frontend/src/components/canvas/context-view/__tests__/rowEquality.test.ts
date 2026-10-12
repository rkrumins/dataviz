/**
 * `sameRows` — the guard that stops a measure pass re-rendering every edge.
 *
 * It has to be exact in both directions: a false "equal" freezes the overlay on
 * stale geometry, and a false "changed" gives back the O(edges) re-render per
 * scroll frame that this exists to remove.
 */
import { describe, it, expect } from 'vitest'
import { sameRows } from '../rowEquality'

const edge = (over: Record<string, unknown> = {}) => ({
  id: 'e1', source: 'a', target: 'b', minY: 0, maxY: 10,
  pathD: 'M0,0 L1,1', color: '#fff', dynamicStrokeWidth: 1, edgeOpacity: 1,
  isGhost: false, isBundled: false, edgeCount: 1,
  sx: 0, sy: 0, tx: 1, ty: 1, types: ['FEEDS'], confidence: 1,
  ...over,
})

describe('sameRows', () => {
  it('treats a rebuilt-but-identical row array as unchanged', () => {
    expect(sameRows([edge()], [edge()])).toBe(true)
  })

  it('is true for the same reference and for two empties', () => {
    const rows = [edge()]
    expect(sameRows(rows, rows)).toBe(true)
    expect(sameRows([], [])).toBe(true)
  })

  it('detects a change in any scalar field', () => {
    expect(sameRows([edge()], [edge({ pathD: 'M0,0 L2,2' })])).toBe(false)
    expect(sameRows([edge()], [edge({ maxY: 11 })])).toBe(false)
    expect(sameRows([edge()], [edge({ color: '#000' })])).toBe(false)
    expect(sameRows([edge()], [edge({ isGhost: true })])).toBe(false)
  })

  it('compares array-valued fields element-wise, not by reference', () => {
    expect(sameRows([edge({ types: ['FEEDS'] })], [edge({ types: ['FEEDS'] })])).toBe(true)
    expect(sameRows([edge({ types: ['FEEDS'] })], [edge({ types: ['OWNS'] })])).toBe(false)
    expect(sameRows([edge({ types: ['FEEDS'] })], [edge({ types: ['FEEDS', 'OWNS'] })])).toBe(false)
  })

  it('detects length and ordering changes', () => {
    expect(sameRows([edge()], [edge(), edge({ id: 'e2' })])).toBe(false)
    expect(
      sameRows([edge({ id: 'a' }), edge({ id: 'b' })], [edge({ id: 'b' }), edge({ id: 'a' })]),
    ).toBe(false)
  })

  it('detects an optional field appearing or disappearing', () => {
    expect(sameRows([edge()], [edge({ isTraceEdge: true })])).toBe(false)
    expect(sameRows([edge({ isTraceEdge: true })], [edge()])).toBe(false)
  })

  it('fails open on NaN — a rebuild is the safe direction for an optimisation', () => {
    expect(sameRows([edge({ minY: NaN })], [edge({ minY: NaN })])).toBe(false)
  })
})
