/**
 * IMAGE EXPORT — the whole board, never a section of it.
 *
 * Reported live: "when I use Export as Image, it doesn't actually take a
 * correct one but only a section". The old frame was capped at 3200x2400
 * and the board was then fitted into it with a MINIMUM zoom of 0.25, so
 * a board too big to fit at 0.25 was drawn at 0.25 anyway and the rest
 * fell outside the frame.
 *
 * The property these pin is containment: whatever the bounds, the four
 * transformed board corners land INSIDE the exported frame. Pure maths,
 * because the rasterizer needs a real browser and jsdom has no layout —
 * the harness screenshots cover the pixels.
 */
import { describe, it, expect } from 'vitest'
import { exportFrameFor } from '../FocusGraphView'

/** Where a board point ends up in the exported image. */
function project(
  frame: ReturnType<typeof exportFrameFor>,
  x: number,
  y: number,
): { x: number; y: number } {
  return { x: x * frame.vp.zoom + frame.vp.x, y: y * frame.vp.zoom + frame.vp.y }
}

/** The frame is whole pixels while the transform is continuous, so
 *  containment is a statement about pixels, not about reals. The bug
 *  this guards cropped thousands of them. */
const TOL = 1

function expectFullyInside(bounds: { x: number; y: number; width: number; height: number }) {
  const frame = exportFrameFor(bounds)
  const corners = [
    project(frame, bounds.x, bounds.y),
    project(frame, bounds.x + bounds.width, bounds.y),
    project(frame, bounds.x, bounds.y + bounds.height),
    project(frame, bounds.x + bounds.width, bounds.y + bounds.height),
  ]
  for (const c of corners) {
    expect(c.x).toBeGreaterThanOrEqual(-TOL)
    expect(c.y).toBeGreaterThanOrEqual(-TOL)
    expect(c.x).toBeLessThanOrEqual(frame.width + TOL)
    expect(c.y).toBeLessThanOrEqual(frame.height + TOL)
  }
  return frame
}

describe('exportFrameFor', () => {
  it('draws a small board at 1:1 with padding on every side', () => {
    const frame = expectFullyInside({ x: 0, y: 0, width: 600, height: 400 })
    expect(frame.vp.zoom).toBe(1)
    expect(frame.width).toBe(600 + 160)
    expect(frame.height).toBe(400 + 160)
    // The board's top-left sits one pad in, not at the corner.
    expect(project(frame, 0, 0)).toEqual({ x: 80, y: 80 })
  })

  it('does not enlarge a board that is smaller than the ceiling', () => {
    expect(exportFrameFor({ x: 0, y: 0, width: 50, height: 20 }).vp.zoom).toBe(1)
  })

  it('offsets a board that does not start at the origin', () => {
    // A walk that grew upstream puts cards at negative coordinates; the
    // old frame started at 0 and simply lost them.
    const frame = expectFullyInside({ x: -4200, y: -900, width: 1200, height: 600 })
    expect(frame.vp.zoom).toBe(1)
    expect(project(frame, -4200, -900)).toEqual({ x: 80, y: 80 })
  })

  it('SHRINKS a board past the ceiling instead of cropping it', () => {
    // A board 20000 wide needed zoom 0.16 to fit the old 3200 frame; the
    // old fit floored at 0.25 and drew 5000px of board into 3200px of
    // frame, so a third of it simply was not in the file.
    const bounds = { x: 0, y: 0, width: 20000, height: 3000 }
    const frame = expectFullyInside(bounds)
    expect(frame.vp.zoom).toBeLessThan(0.25)
    expect(frame.width).toBeLessThanOrEqual(4000)
    expect(frame.height).toBeLessThanOrEqual(4000)
    // The far corner is one scaled pad inside the frame's far edge —
    // the board fills the file, less its margin, rather than running off
    // the side of it.
    expect(project(frame, 20000, 3000).x).toBeCloseTo(frame.width - 80 * frame.vp.zoom, 0)
  })

  it('holds a very tall board too — the ceiling binds on either axis', () => {
    const frame = expectFullyInside({ x: 0, y: 0, width: 800, height: 30000 })
    expect(frame.height).toBeLessThanOrEqual(4000)
    expect(frame.vp.zoom).toBeCloseTo(4000 / (30000 + 160), 6)
  })

  it('keeps a lopsided board fully inside on BOTH axes', () => {
    // One shared zoom, chosen by whichever axis is worse.
    const frame = expectFullyInside({ x: -500, y: -20000, width: 20000, height: 40000 })
    expect(frame.width).toBeLessThanOrEqual(4000)
    expect(frame.height).toBeLessThanOrEqual(4000)
  })

  it('survives a degenerate one-card board', () => {
    const frame = expectFullyInside({ x: 10, y: 10, width: 0, height: 0 })
    expect(frame.width).toBe(160)
    expect(frame.height).toBe(160)
  })
})
