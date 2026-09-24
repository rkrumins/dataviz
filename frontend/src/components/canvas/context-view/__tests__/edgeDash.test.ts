/**
 * edgeDashArray — the one dash rule the canvas draws by: a roll-up is
 * always dashed; every other line takes the ontology's own stroke style.
 */
import { describe, it, expect } from 'vitest'
import { edgeDashArray, VIRTUAL_HOP_DASH } from '../edgeDash'
import { lineDash } from '../lineDensity'

describe('edgeDashArray', () => {
  it('a roll-up is dashed whatever the ontology says', () => {
    expect(edgeDashArray(true, 'solid')).toBe('6 4')
  })

  it('a direct relationship with a solid ontology style draws solid', () => {
    expect(edgeDashArray(false, 'solid')).toBe('none')
  })

  it('a direct relationship honours a dashed and a dotted ontology style', () => {
    expect(edgeDashArray(false, 'dashed')).toBe('6,3')
    expect(edgeDashArray(false, 'dotted')).toBe('2,2')
  })

  it('an unknown stroke style falls back to solid', () => {
    expect(edgeDashArray(false, undefined)).toBe('none')
  })
})

describe('a virtual hop\'s stitch', () => {
  it('is its own, unlike any roll-up or ontology style', () => {
    const others = [edgeDashArray(true), edgeDashArray(false, 'dashed'), edgeDashArray(false, 'dotted'), edgeDashArray(false)]
    expect(others).not.toContain(VIRTUAL_HOP_DASH)
  })

  it('survives a dense board, where a roll-up\'s dash is flattened', () => {
    // A virtual hop is never drawn as a roll-up (isGhost), so the density
    // rule that turns roll-ups solid past the premium tier leaves it alone.
    expect(lineDash({ isGhost: false, dashArray: VIRTUAL_HOP_DASH }, false)).toBe(VIRTUAL_HOP_DASH)
    expect(lineDash({ isGhost: true, dashArray: '6 4' }, false)).toBe('none')
  })
})
