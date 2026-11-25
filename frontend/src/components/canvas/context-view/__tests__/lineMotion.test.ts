import { describe, expect, it } from 'vitest'
import { CALM_MOTION_AT, MOTION_FOCUS_LIMIT, pickLineMotion, pickMovingLines, type MotionLine } from '../lineMotion'
import { lineDash, nextRenderTier } from '../lineDensity'

const line = (id: string, source: string, target: string, isFocusIncident = false): MotionLine =>
  ({ id, source, target, isFocusIncident })

const board = [
  line('a-b', 'a', 'b'),
  line('b-c', 'b', 'c'),
  line('c-d', 'c', 'd'),
  line('x-y', 'x', 'y', true),
]
const idle = { hoveredEdgeId: null, hoveredNodeId: null, highlighted: null }

describe('pickMovingLines — lines move when they are looked at', () => {
  it('a board nobody is looking at is still (the flicker was every line moving at rest)', () => {
    expect(pickMovingLines(board.slice(0, 3), 'focus', idle)).toEqual([])
  })

  it("hovering an entity moves that entity's lines", () => {
    const moving = pickMovingLines(board, 'focus', { ...idle, hoveredNodeId: 'b' })
    expect(moving.map(l => l.id)).toEqual(['a-b', 'b-c', 'x-y'])
  })

  it('the trace focus keeps its lines moving', () => {
    expect(pickMovingLines(board, 'focus', idle).map(l => l.id)).toEqual(['x-y'])
  })

  it('a selection highlight moves only the lit lines, not the hovered row\'s', () => {
    const moving = pickMovingLines(board, 'focus', {
      ...idle, hoveredNodeId: 'c', highlighted: new Set(['a-b']),
    })
    expect(moving.map(l => l.id)).toEqual(['a-b', 'x-y'])
  })

  it('a hub never pushes the line under the pointer out of the cap', () => {
    const fan = Array.from({ length: 400 }, (_, i) => line(`h-${i}`, 'hub', `n${i}`))
    const moving = pickMovingLines(fan, 'focus', { ...idle, hoveredNodeId: 'hub', hoveredEdgeId: 'h-399' })
    expect(moving).toHaveLength(MOTION_FOCUS_LIMIT)
    expect(moving[0].id).toBe('h-399')
  })

  it("'calm' moves a small group as 'focus' does, and holds a big fan still", () => {
    expect(pickLineMotion(board, 'calm', { ...idle, hoveredNodeId: 'b' }))
      .toEqual(pickLineMotion(board, 'focus', { ...idle, hoveredNodeId: 'b' }))
    const fan = Array.from({ length: CALM_MOTION_AT + 1 }, (_, i) => line(`t-${i}`, 'lake', `d${i}`, true))
    const atRest = pickLineMotion(fan, 'calm', idle)
    expect(atRest.moving).toEqual([])
    expect(atRest.held).toHaveLength(CALM_MOTION_AT + 1)
    // What the reader narrows to still moves: the line under the pointer, and a
    // hovered entity with a handful of lines.
    const pointed = pickLineMotion(fan, 'calm', { ...idle, hoveredEdgeId: 't-3' })
    expect(pointed.moving.map(l => l.id)).toEqual(['t-3'])
    expect(pointed.held).toHaveLength(CALM_MOTION_AT)
    const small = [...fan, line('d0-x', 'd0', 'x')]
    const hovered = pickLineMotion(small, 'calm', { ...idle, hoveredNodeId: 'd0' })
    expect(hovered.moving.map(l => l.id)).toEqual(['t-0', 'd0-x'])
  })

  it("'focus' holds nothing back, as before", () => {
    const fan = Array.from({ length: 40 }, (_, i) => line(`t-${i}`, 'lake', `d${i}`, true))
    expect(pickLineMotion(fan, 'focus', idle)).toEqual({ moving: fan, held: [] })
  })

  it("'all' moves every line; 'off' moves none, whatever is focused", () => {
    expect(pickMovingLines(board, 'all', idle)).toHaveLength(4)
    expect(pickMovingLines(board, 'off', { ...idle, hoveredNodeId: 'b', hoveredEdgeId: 'a-b' })).toEqual([])
  })
})

describe('nextRenderTier — the board look does not flip on every batch', () => {
  it('crossing a boundary takes 10% past it, in either direction', () => {
    expect(nextRenderTier(210, 'premium')).toBe('premium')
    expect(nextRenderTier(221, 'premium')).toBe('standard')
    expect(nextRenderTier(190, 'standard')).toBe('standard')
    expect(nextRenderTier(179, 'standard')).toBe('premium')
    expect(nextRenderTier(850, 'standard')).toBe('standard')
    expect(nextRenderTier(881, 'standard')).toBe('coalesced')
    expect(nextRenderTier(750, 'coalesced')).toBe('coalesced')
    expect(nextRenderTier(719, 'coalesced')).toBe('standard')
  })

  it('a count far past both boundaries lands where it belongs', () => {
    expect(nextRenderTier(5000, 'premium')).toBe('coalesced')
    expect(nextRenderTier(850, 'premium')).toBe('standard')
    expect(nextRenderTier(12, 'coalesced')).toBe('premium')
  })
})

describe('lineDash — a roll-up dashes only where the dash can be read', () => {
  it('dashes a roll-up on a sparse board or when looked at, draws it solid on a dense one', () => {
    const rollup = { isGhost: true, dashArray: '6 4' }
    expect(lineDash(rollup, true)).toBe('6 4')
    expect(lineDash(rollup, false)).toBe('none')
  })

  it("never touches the ontology's own dash for a type", () => {
    expect(lineDash({ isGhost: false, dashArray: '6,3' }, false)).toBe('6,3')
  })
})
