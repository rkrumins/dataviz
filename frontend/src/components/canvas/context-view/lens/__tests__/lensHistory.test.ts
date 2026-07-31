import { describe, it, expect } from 'vitest'
import {
  EMPTY_LENS_HISTORY,
  lensFocalOf,
  lensPush,
  lensBackward,
  lensForwardStep,
  lensJump,
  type LensHistory,
} from '../lensHistory'

const h = (entries: string[], cursor: number): LensHistory => ({ entries, cursor })

describe('lensHistory', () => {
  it('empty history has no focal', () => {
    expect(lensFocalOf(EMPTY_LENS_HISTORY)).toBeNull()
  })

  it('push appends and moves the cursor to the new entry', () => {
    const next = lensPush(lensPush(h(['a'], 0), 'b'), 'c')
    expect(next).toEqual(h(['a', 'b', 'c'], 2))
    expect(lensFocalOf(next)).toBe('c')
  })

  it('push of the current focal is a no-op', () => {
    const cur = h(['a', 'b'], 1)
    expect(lensPush(cur, 'b')).toBe(cur)
  })

  it('back and forward move the cursor without dropping entries', () => {
    const walked = h(['a', 'b', 'c'], 2)
    const back = lensBackward(walked)
    expect(back).toEqual(h(['a', 'b', 'c'], 1))
    expect(lensForwardStep(back)).toEqual(h(['a', 'b', 'c'], 2))
  })

  it('back clamps at the start; forward clamps at the end', () => {
    const start = h(['a', 'b'], 0)
    expect(lensBackward(start)).toBe(start)
    const end = h(['a', 'b'], 1)
    expect(lensForwardStep(end)).toBe(end)
  })

  it('push after back truncates the forward side (undo/redo invariant)', () => {
    const back = lensBackward(h(['a', 'b', 'c'], 2))
    expect(lensPush(back, 'd')).toEqual(h(['a', 'b', 'd'], 2))
  })

  it('push after back to the SAME next hop still truncates to a single path', () => {
    const back = lensBackward(h(['a', 'b', 'c'], 2))
    expect(lensPush(back, 'c')).toEqual(h(['a', 'b', 'c'], 2))
  })

  it('jump moves the cursor anywhere in range, clamped, non-destructively', () => {
    const walked = h(['a', 'b', 'c', 'd'], 3)
    expect(lensJump(walked, 1)).toEqual(h(['a', 'b', 'c', 'd'], 1))
    expect(lensJump(walked, -5)).toEqual(h(['a', 'b', 'c', 'd'], 0))
    expect(lensJump(walked, 99)).toEqual(h(['a', 'b', 'c', 'd'], 3))
    expect(lensJump(EMPTY_LENS_HISTORY, 0)).toBe(EMPTY_LENS_HISTORY)
  })
})
