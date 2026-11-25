/**
 * A hidden row's direction, read against its OWN column's visible box.
 *
 * The canvas used to read it against the whole canvas scroller, which takes in
 * every column's sticky header and the band the bottom chrome reserves. A row
 * hidden under the header sat inside that box, and a guess from the visible
 * end's height called it "down" — so a column scrolled to its very end still
 * said "↓ 7 more".
 */
import { describe, expect, it } from 'vitest'
import { classifyHiddenEnd, columnVisibleRect } from '../hiddenEnd'

/** The canvas scroller: 1440 wide, its rows' band from 64 to 900 (the
 *  reserved bottom band included, as the old reading had it). */
const CANVAS = { top: 64, bottom: 900, left: 0, right: 1440 }
/** A column whose list starts under a 64px sticky header (y 128) and ends
 *  above a 140px reserved band (y 760). */
const LIST = { top: 128, bottom: 760, left: 600, right: 1070 }
const visible = columnVisibleRect(LIST, CANVAS)
const row = (top: number, left = 600, right = 1070) => ({ top, height: 60, left, right })

describe('classifyHiddenEnd', () => {
  it('a row hidden under its column’s sticky header lies above', () => {
    // Inside the canvas scroller, so the old reading had no answer and guessed.
    expect(classifyHiddenEnd(row(80), visible)).toBe('up')
    expect(classifyHiddenEnd(row(-400), visible)).toBe('up')
  })

  it('a row in the reserved bottom band, or past it, lies below', () => {
    expect(classifyHiddenEnd(row(760), visible)).toBe('down')
    expect(classifyHiddenEnd(row(2400), visible)).toBe('down')
  })

  it('a row whose centre is in view is not hidden at all', () => {
    expect(classifyHiddenEnd(row(128), visible)).toBeNull()
    expect(classifyHiddenEnd(row(700), visible)).toBeNull()
  })

  it('a column scrolled to its end has nothing below: every row it hides lies above', () => {
    // The last row ends on the list's bottom edge; the rest are scrolled up,
    // some under the header, some above the canvas.
    const hidden = [row(-1200), row(-60), row(20), row(68)]
    expect(hidden.map(r => classifyHiddenEnd(r, visible))).toEqual(['up', 'up', 'up', 'up'])
    expect(classifyHiddenEnd(row(700), visible)).toBeNull()
  })

  it('a column scrolled sideways off the canvas lies left or right', () => {
    const offRight = columnVisibleRect({ ...LIST, left: 1500, right: 1970 }, CANVAS)
    expect(classifyHiddenEnd(row(300, 1500, 1970), offRight)).toBe('right')
    const offLeft = columnVisibleRect({ ...LIST, left: -700, right: -230 }, CANVAS)
    expect(classifyHiddenEnd(row(300, -700, -230), offLeft)).toBe('left')
  })

  it('the further-out axis wins', () => {
    const offRight = columnVisibleRect({ ...LIST, left: 1450, right: 1920 }, CANVAS)
    // 245px past the canvas's right edge, 2000px below the list: down.
    expect(classifyHiddenEnd(row(2730, 1450, 1920), offRight)).toBe('down')
    // 245px past the right edge, 10px below: right.
    expect(classifyHiddenEnd(row(740, 1450, 1920), offRight)).toBe('right')
  })
})

describe('columnVisibleRect', () => {
  it('is the column list’s viewport, cut to the canvas', () => {
    expect(columnVisibleRect(LIST, CANVAS)).toEqual(LIST)
    expect(columnVisibleRect({ top: 40, bottom: 1000, left: -20, right: 300 }, CANVAS))
      .toEqual({ top: 64, bottom: 900, left: 0, right: 300 })
  })
})
