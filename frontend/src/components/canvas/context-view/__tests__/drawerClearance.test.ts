/**
 * THE PANEL MUST NOT HIDE ITS OWN SUBJECT (2026-08-22).
 *
 * The details drawer is a flex sibling: opening it takes 420–560 px off the
 * canvas's width. Whatever sat near the right edge — very often the card
 * that was just clicked to open it — is then outside the visible box, so the
 * reader loses sight of the entity they are reading about (reported on a
 * traced board: click a dashboard, the drawer opens over it).
 *
 * The remedy is the SMALLEST scroll that clears it. Not centring: the board
 * should settle, not lurch, and a reader who has arranged their view keeps
 * it. This is the arithmetic of "the least that clears it".
 */
import { describe, it, expect } from 'vitest'
import { shiftToClear } from '../drawerClearance'

/** A viewport 1,000 wide starting at x=0 — the canvas after the drawer took its share. */
const viewport = { left: 0, right: 1000 }

describe('shiftToClear', () => {
  it('leaves a row that is already comfortably inside exactly where it is', () => {
    expect(shiftToClear({ left: 200, right: 500 }, viewport, 24)).toBe(0)
  })

  it('scrolls right by the overflow when the drawer clipped the row — and no further', () => {
    // The row ends 40px past the viewport; with a 24px margin it must move 64.
    expect(shiftToClear({ left: 740, right: 1040 }, viewport, 24)).toBe(64)
  })

  it('scrolls left when the row sits off the left edge', () => {
    // Its left is 30px before the viewport; with the margin, 54 the other way.
    expect(shiftToClear({ left: -30, right: 270 }, viewport, 24)).toBe(-54)
  })

  it('a row flush against the edge still earns its margin', () => {
    expect(shiftToClear({ left: 700, right: 1000 }, viewport, 24)).toBe(24)
    expect(shiftToClear({ left: 0, right: 300 }, viewport, 24)).toBe(-24)
  })

  it('a row too wide to fit shows its LEFT edge — the end that carries the name', () => {
    // 1,200 wide in a 1,000 viewport: no scroll can clear both ends, so the
    // identity end wins rather than the actions end.
    expect(shiftToClear({ left: 100, right: 1300 }, viewport, 24)).toBe(76)
    // Already left-aligned with its margin: nothing to do.
    expect(shiftToClear({ left: 24, right: 1224 }, viewport, 24)).toBe(0)
  })

  it('reads the viewport\'s own offset, not the page origin', () => {
    // The canvas starts 300px in (rail, gutters); the same row is fine here.
    expect(shiftToClear({ left: 400, right: 700 }, { left: 300, right: 1300 }, 24)).toBe(0)
    expect(shiftToClear({ left: 1100, right: 1400 }, { left: 300, right: 1300 }, 24)).toBe(124)
  })
})
