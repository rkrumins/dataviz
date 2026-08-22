/**
 * The toolbar's fit decision (2026-08-22): which groups fold into the
 * Display menu, least important first, until the row fits.
 */
import { describe, it, expect } from 'vitest'
import { fitToolbar, DISPLAY_MENU_W } from '../useToolbarOverflow'

const ORDER = ['direction', 'walk', 'density', 'wires', 'steps', 'next'] as const
const W: Record<string, number> = { direction: 230, walk: 190, density: 250, wires: 260, steps: 210, next: 170 }
const widthOf = (id: string) => W[id]

describe('fitToolbar', () => {
  it('everything fits: nothing collapses', () => {
    expect(fitToolbar(ORDER, widthOf, 2000, 8)).toEqual([])
  })
  it('collapses the least important groups first, and only as many as it must', () => {
    // Total need = 1310 + 6×8 = 1358. With 1200 free, the menu costs 120
    // → room 1080: drop next (178) → 1180, steps (218) → 962 ≤ 1080.
    expect(fitToolbar(ORDER, widthOf, 1200, 8)).toEqual(['next', 'steps'])
  })
  it('a row that cannot hold even the most important group collapses all', () => {
    expect(fitToolbar(ORDER, widthOf, 300, 8)).toEqual(['next', 'steps', 'wires', 'density', 'walk', 'direction'])
  })
  it('an unmeasured row collapses nothing — the toolbar folds only on evidence', () => {
    expect(fitToolbar(ORDER, widthOf, 0, 8)).toEqual([])
    expect(fitToolbar(ORDER, () => undefined, 500, 8)).toEqual([])
  })
  it('the menu reserves its own room', () => {
    expect(DISPLAY_MENU_W).toBeGreaterThan(80)
    // Need 1358; free 1350: does not fit. Room after the menu = 1230;
    // dropping next leaves 1180 ≤ 1230 → one group.
    expect(fitToolbar(ORDER, widthOf, 1350, 8)).toEqual(['next'])
  })
})
