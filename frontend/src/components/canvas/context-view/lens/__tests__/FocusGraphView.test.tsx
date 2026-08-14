import { describe, it, expect } from 'vitest'
import { clampPeekY } from '../FocusGraphView'

/**
 * Task 20, P6/fix round 1. `clampPeekY` was the peek panel's vertical
 * placement, un-extracted, inline in `LensPeek` — no dedicated pin, on
 * the reasoning that jsdom does no real layout (`paneH` always reads 0
 * in a component-level render), so a REGRESSION on this specific clamp
 * ("a short pane" — the case the fix exists for) could never be
 * exercised by rendering the component at all. Extracted as its own
 * pure function so the formula itself is testable directly, no DOM or
 * measurement mocking required.
 */
describe('clampPeekY', () => {
  it('centres on the row when the pane is comfortably tall', () => {
    // Neither bound engaged: the row's own y comes straight through.
    expect(clampPeekY(400, 800)).toBe(400)
  })

  it('clamps a row near the TOP edge', () => {
    expect(clampPeekY(5, 800)).toBe(148) // PEEK_MAX_H/2 (140) + 8
  })

  it('clamps a row near the BOTTOM edge', () => {
    expect(clampPeekY(795, 800)).toBe(652) // 800 - 140 - 8
  })

  /**
   * The regression this fix exists for. Before it, the clamp was
   * skipped entirely below `PEEK_MAX_H + 16` (296) and the raw row
   * position passed straight through — genuinely unclamped, not merely
   * less padded, so a peek on a short window could run off either edge
   * by however far the row itself sat past it.
   */
  it('still clamps on a pane too short to fit the panel at all', () => {
    // A 200px-tall pane — well under PEEK_MAX_H (280) — with a row
    // sitting right at its bottom edge. The old code returned 195
    // (the raw `rowY`) here, off the bottom of a 200px pane.
    expect(clampPeekY(195, 200)).toBe(148) // pinned near the top, 8px in
    // And a row near the pane's own top, which the OLD code also let
    // through unclamped in the other direction.
    expect(clampPeekY(5, 200)).toBe(148)
  })

  it('never returns a value that would sit above the pane, even at 0 height', () => {
    // Every one of this fix's own tests holds the floor: the panel
    // pins to `PEEK_MAX_H/2 + 8` when there is nowhere real to put it,
    // rather than a negative or NaN position.
    expect(clampPeekY(0, 0)).toBe(148)
  })
})
