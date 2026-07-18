/**
 * computeFitZoom — pure fit-to-width math for the Context View.
 */
import { describe, it, expect } from 'vitest'
import {
  computeFitZoom,
  EXPANDED_COLUMN_MIN_WIDTH_PX,
  COLUMN_GAP_PX,
} from '../fitZoom'
import { EXTREMITY_EDGE_GUTTER_PX } from '../LineageFlowOverlay'
import { CANVAS_ZOOM_MIN } from '@/store/preferences'

const intrinsic = (cols: number) =>
  cols * EXPANDED_COLUMN_MIN_WIDTH_PX + (cols - 1) * COLUMN_GAP_PX + 2 * EXTREMITY_EDGE_GUTTER_PX

describe('computeFitZoom', () => {
  it('returns 1 when the content already fits', () => {
    expect(computeFitZoom(2, 0, intrinsic(2) + 500)).toBe(1)
  })

  it('never zooms IN beyond 100% to fill a wide viewport', () => {
    expect(computeFitZoom(1, 0, 10_000)).toBe(1)
  })

  it('scales down so all columns fit exactly', () => {
    const cols = 5
    const viewport = intrinsic(cols) * 0.8
    expect(computeFitZoom(cols, 0, viewport)).toBeCloseTo(0.8, 5)
  })

  it('clamps at the canvas zoom floor for very wide graphs', () => {
    expect(computeFitZoom(30, 0, 800)).toBe(CANVAS_ZOOM_MIN)
  })

  it('handles degenerate inputs safely', () => {
    expect(computeFitZoom(0, 0, 1200)).toBe(1)
    expect(computeFitZoom(3, 0, 0)).toBe(1)
  })
})
