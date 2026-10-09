import { describe, expect, it } from 'vitest'
import { routeGutter, routeLine, SAME_COLUMN_LANE_BASE, SAME_COLUMN_LANE_START, SAME_COLUMN_LANE_STEP, type RowBox } from '../lineRoute'

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

/** Every x a path passes through or bends toward, in order (M, C and H). */
function pathXs(pathD: string): number[] {
  const xs: number[] = []
  for (const [, cmd, args] of pathD.matchAll(/([MCH])([^MCH]*)/g)) {
    const n = args.match(/-?\d+(\.\d+)?/g)!.map(Number)
    if (cmd === 'H') xs.push(...n)
    else for (let i = 0; i < n.length; i += 2) xs.push(n[i])
  }
  return xs
}

describe('routeGutter — a line docked to the Anchor Rail runs down its column\'s gutter', () => {
  const row: RowBox = { left: 108, right: 408, top: 100, height: 40 }
  /** A hint pill's dock: its strip, as wide as a tray, a little inset from the rows. */
  const pill: RowBox = { left: 110, right: 406, top: 600, height: 20 }

  it('two boxes whose edges line up get routeLine\'s own same-column curve', () => {
    const s = card(400, 100)
    const t = card(400, 600)
    expect(routeGutter(s, t, 'left', 2).pathD).toBe(routeLine(s, t, 2).pathD)
  })

  it('left: from the pill into the row, bowing through the lane and never entering either', () => {
    const r = routeGutter(pill, row, 'left', 0)
    const xs = pathXs(r.pathD)
    expect([xs[0], r.sx]).toEqual([pill.left - SAME_COLUMN_LANE_START, pill.left - SAME_COLUMN_LANE_START])
    expect([xs.at(-1), r.tx]).toEqual([row.left - SAME_COLUMN_LANE_START, row.left - SAME_COLUMN_LANE_START])
    expect(Math.min(...xs)).toBe(row.left - SAME_COLUMN_LANE_START - SAME_COLUMN_LANE_BASE)
    expect(Math.max(...xs)).toBeLessThan(row.left)
    expect([r.sy, r.ty]).toEqual([610, 120])
  })

  it('right: mirrored through the right gutter, ending just outside the dock — never over the rows', () => {
    const r = routeGutter(row, pill, 'right', 0)
    const xs = pathXs(r.pathD)
    expect(xs[0]).toBe(row.right + SAME_COLUMN_LANE_START)
    expect(Math.max(...xs)).toBe(row.right + SAME_COLUMN_LANE_START + SAME_COLUMN_LANE_BASE)
    expect(xs.every(x => x > row.right)).toBe(true)
    // A dock inset from the rows is reached by a short level run, to just outside it.
    expect(r.pathD.endsWith(`${row.right + SAME_COLUMN_LANE_START} 610 H ${pill.right + SAME_COLUMN_LANE_START}`)).toBe(true)
    expect([r.tx, r.ty]).toEqual([pill.right + SAME_COLUMN_LANE_START, 610])
  })

  it('lanes step outward, one per line between the same two boxes', () => {
    const lane0 = Math.min(...pathXs(routeGutter(row, pill, 'left', 0).pathD))
    const lane1 = Math.min(...pathXs(routeGutter(row, pill, 'left', 1).pathD))
    expect(lane0 - lane1).toBe(SAME_COLUMN_LANE_STEP)
  })

  it('level ends make a short loop out and back — no NaN', () => {
    const r = routeGutter(row, { ...pill, top: row.top + 10 }, 'left', 0)
    expect(r.pathD).not.toMatch(/NaN/)
    expect(r.sy).toBe(r.ty)
  })
})
