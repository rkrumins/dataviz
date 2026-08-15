import { describe, it, expect } from 'vitest'
import { clampPeekY, edgeGrainVisual } from '../FocusGraphView'

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

/**
 * Task 24, F8 + F8b. `edgeGrainVisual` decides the three strata an
 * isolated cone paints a wire in — extracted for the same reason
 * `clampPeekY` was: React Flow draws no edges at all until its nodes
 * have been measured, and jsdom measures nothing, so a full-component
 * render can never exercise a REGRESSION here (T22 shipped exactly one,
 * caught only by a live screenshot). The formula is pinned directly.
 */
describe('edgeGrainVisual', () => {
  const base = {
    onCone: false, offCone: false, seam: false, strong: false, adjacent: false,
    aggregated: false, trail: false, containment: false, reducedMotion: false,
    tint: '#3b82f6', mutedTint: '#9ca3af',
  }

  it('a column-certain cone wire: full colour, full weight, the tight flowing dash', () => {
    const v = edgeGrainVisual({ ...base, onCone: true, strong: true, adjacent: true })
    expect(v.stroke).toBe('#3b82f6') // the cone's own tint, not muted
    expect(v.strokeWidth).toBe(3) // adjacent
    expect(v.className).toBe('lens-cone-flow')
    expect(v.strokeDasharray).toBeUndefined() // the class carries the dash
  })

  it('a coarse (SEAM) cone wire: the SAME full colour and weight as certain — F8, the muting was the bug', () => {
    const certain = edgeGrainVisual({ ...base, onCone: true, strong: true, adjacent: true })
    const coarse = edgeGrainVisual({ ...base, onCone: true, seam: true, strong: true, adjacent: true })
    expect(coarse.stroke).toBe(certain.stroke) // full cone colour, not mutedTint
    expect(coarse.strokeWidth).toBe(certain.strokeWidth) // full stroke weight, unchanged by grain
  })

  it('certain vs coarse stay honestly distinguishable — different class, F8 rule 4', () => {
    const certain = edgeGrainVisual({ ...base, onCone: true, strong: true })
    const coarse = edgeGrainVisual({ ...base, onCone: true, seam: true, strong: true })
    expect(certain.className).toBe('lens-cone-flow')
    expect(coarse.className).toBe('lens-seam-flow')
    expect(certain.className).not.toBe(coarse.className)
  })

  it('a plain off-cone wire under an active isolation: muted, thin, and never dashed', () => {
    const v = edgeGrainVisual({ ...base, offCone: true })
    expect(v.stroke).toBe('#9ca3af') // mutedTint
    expect(v.strokeWidth).toBe(1) // whisper-thin — thinner than the 1.5 background floor
    expect(v.className).toBeFalsy() // no motion off-cone
    expect(v.strokeDasharray).toBeUndefined()
  })

  it('an off-cone CONTAINMENT wire loses its own dash too — F8b stratum 3, the regression this fix closes', () => {
    // Before this fix, `containment` always won a dash regardless of
    // cone state — texture at whisper opacity read as noise, not
    // recession, on exactly this wire.
    const v = edgeGrainVisual({ ...base, offCone: true, containment: true })
    expect(v.strokeDasharray).toBeUndefined()
  })

  it('a containment wire with NO isolation active keeps its own dash — unchanged baseline', () => {
    const v = edgeGrainVisual({ ...base, containment: true })
    expect(v.strokeDasharray).toBe('4 4')
  })

  it('reduced motion silences the drift on both certain and coarse wires alike', () => {
    const certain = edgeGrainVisual({ ...base, onCone: true, strong: true, reducedMotion: true })
    const coarse = edgeGrainVisual({ ...base, onCone: true, seam: true, strong: true, reducedMotion: true })
    expect(certain.className).toBeFalsy()
    expect(coarse.className).toBeFalsy()
  })
})
