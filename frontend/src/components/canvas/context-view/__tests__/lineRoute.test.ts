import { describe, expect, it } from 'vitest'
import { routeLine, SAME_COLUMN_LANE_BASE, SAME_COLUMN_LANE_START, type RowBox } from '../lineRoute'

/** The five points of `M x y C x y, x y, x y` as [start, c1, c2, end]. */
function points(pathD: string): Array<[number, number]> {
  const n = pathD.match(/-?\d+(\.\d+)?/g)!.map(Number)
  return [[n[0], n[1]], [n[2], n[3]], [n[4], n[5]], [n[6], n[7]]]
}

const card = (left: number, top: number): RowBox => ({ left, right: left + 300, top, height: 48 })

describe('routeLine — a line joins the sides that face each other', () => {
  it('rightward: leaves the source by its right side and lands on the target by its left', () => {
    const s = card(0, 100)
    const t = card(700, 400)
    const r = routeLine(s, t, 0)
    const [start, c1, c2, end] = points(r.pathD)
    expect(start[0]).toBe(s.right + 6)
    expect(end[0]).toBe(t.left - 8)
    // Every control point between the two cards: nothing bows back.
    for (const [x] of [c1, c2]) {
      expect(x).toBeGreaterThanOrEqual(start[0])
      expect(x).toBeLessThanOrEqual(end[0])
    }
  })

  it('leftward: leaves the source by its LEFT side and lands on the target by its RIGHT', () => {
    // A Report card (right) feeding a Source card (left) three columns over.
    const s = card(1400, 300)
    const t = card(0, 700)
    const r = routeLine(s, t, 0)
    const [start, c1, c2, end] = points(r.pathD)
    expect(start[0]).toBe(s.left - 6)
    expect(end[0]).toBe(t.right + 8)
    // The loop this replaces set off RIGHTWARDS from the source's right side
    // and came back across every column between: no point may lie right of
    // where the line leaves, or left of where it lands.
    for (const [x] of [start, c1, c2, end]) {
      expect(x).toBeLessThanOrEqual(start[0])
      expect(x).toBeGreaterThanOrEqual(end[0])
    }
  })

  it('leftward: stays level with its two rows — no arc dipping under them', () => {
    const r = routeLine(card(1400, 300), card(0, 700), 0)
    for (const [, y] of points(r.pathD)) {
      expect(y).toBeGreaterThanOrEqual(300 + 24)
      expect(y).toBeLessThanOrEqual(700 + 24)
    }
  })

  it('two rows of one column bow through its left gutter lane', () => {
    const s = card(400, 100)
    const t = card(400, 600)
    const r = routeLine(s, t, 2)
    const [start, c1, c2, end] = points(r.pathD)
    expect(start[0]).toBe(400 - SAME_COLUMN_LANE_START)
    expect(end[0]).toBe(400 - SAME_COLUMN_LANE_START)
    expect(c1[0]).toBe(start[0] - (SAME_COLUMN_LANE_BASE + 2 * 8))
    expect(c2[0]).toBe(c1[0])
  })

  it('same row band: rightward takes a lane above the row, leftward a lane below', () => {
    const right = points(routeLine(card(0, 200), card(700, 205), 0).pathD)
    expect(right[1][1]).toBeLessThan(right[0][1])
    expect(right[0][0]).toBe(306)
    const left = points(routeLine(card(700, 200), card(0, 205), 0).pathD)
    expect(left[1][1]).toBeGreaterThan(left[0][1])
    expect(left[0][0]).toBe(694)
    expect(left[3][0]).toBe(308)
  })
})
