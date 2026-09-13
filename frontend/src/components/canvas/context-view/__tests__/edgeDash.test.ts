/**
 * edgeDashArray — the one dash rule the canvas draws by: a roll-up is
 * always dashed; every other line takes the ontology's own stroke style.
 */
import { describe, it, expect } from 'vitest'
import { edgeDashArray } from '../edgeDash'

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
