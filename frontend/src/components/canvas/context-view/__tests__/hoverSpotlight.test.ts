import { describe, expect, it } from 'vitest'
import { delegatedLineState, hoverSpotlight } from '../hoverSpotlight'

const line = (id: string, source: string, target: string) => ({ id, source, target })

describe('hoverSpotlight — what a hover lights up', () => {
  const lines = [
    line('a-b', 'a', 'b'),
    line('b-c', 'b', 'c'),
    line('kid-z', 'kid', 'z'),
    line('x-y', 'x', 'y'),
  ]

  it('lights the hovered entity, its lines, and the far end of each', () => {
    const spot = hoverSpotlight('b', new Map(), lines)!
    expect([...spot.rows].sort()).toEqual(['a', 'b', 'c'])
    expect([...spot.lines].sort()).toEqual(['a-b', 'b-c'])
  })

  it("an open container lights its descendants' lines too", () => {
    const childMap = new Map([['box', ['mid']], ['mid', ['kid']]])
    const spot = hoverSpotlight('box', childMap, lines)!
    expect([...spot.lines]).toEqual(['kid-z'])
    expect([...spot.rows].sort()).toEqual(['box', 'kid', 'z'])
  })

  it('an entity with no lineage on the board dims nothing', () => {
    expect(hoverSpotlight('lonely', new Map(), lines)).toBeNull()
  })
})

describe('delegatedLineState — a container line set aside comes back on hover', () => {
  const delegated = { source: 'p', target: 'b', isDelegated: true }
  const residual = { source: 'p', target: 'b', isResidual: true }

  it('stands aside for its children until an end is hovered, then draws in full', () => {
    expect(delegatedLineState(delegated, null)).toBe('hidden')
    expect(delegatedLineState(delegated, 'x')).toBe('hidden')
    expect(delegatedLineState(delegated, 'p')).toBe('full')
    expect(delegatedLineState(delegated, 'b')).toBe('full')
  })

  it('a residual line draws faint until an end is hovered', () => {
    expect(delegatedLineState(residual, null)).toBe('faint')
    expect(delegatedLineState(residual, 'p')).toBe('full')
  })

  it('an ordinary line is always full', () => {
    expect(delegatedLineState({ source: 'a', target: 'b' }, null)).toBe('full')
  })
})
