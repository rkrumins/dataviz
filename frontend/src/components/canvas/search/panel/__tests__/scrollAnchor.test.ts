/**
 * scrollAnchor — the list holds still while pages land above the fold.
 */
import { describe, expect, it } from 'vitest'

import { captureAnchor, restoreScrollTop } from '../scrollAnchor'

const rows = (...spans: Array<[string, number, number]>) =>
  spans.map(([key, start, end]) => ({ key, start, end }))

describe('captureAnchor', () => {
  it('pins the first row that is at least partly visible', () => {
    const items = rows(['a', 0, 64], ['b', 64, 128], ['c', 128, 192])
    expect(captureAnchor(items, 70)).toEqual({ key: 'b', offset: -6 })
  })

  it('pins a row that starts exactly at the fold with no offset', () => {
    const items = rows(['a', 0, 64], ['b', 64, 128])
    expect(captureAnchor(items, 64)).toEqual({ key: 'b', offset: 0 })
  })

  it('holds the top of the list rather than anchoring', () => {
    const items = rows(['a', 0, 64], ['b', 64, 128])
    expect(captureAnchor(items, 0)).toBeNull()
  })

  it('has nothing to pin to in an empty list', () => {
    expect(captureAnchor([], 120)).toBeNull()
  })

  it('stringifies a numeric key so it can be matched later', () => {
    const items = [{ key: 7, start: 0, end: 64 }]
    expect(captureAnchor(items, 10)?.key).toBe('7')
  })
})

describe('restoreScrollTop', () => {
  it('puts the anchored row back where it was', () => {
    // 'b' was 6px above the fold; it now starts 300px down the list, so the
    // scroller has to sit at 306 for it to land in the same place.
    const anchor = { key: 'b', offset: -6 }
    expect(restoreScrollTop(anchor, () => 300)).toBe(306)
  })

  it('leaves the scroller alone when the anchored row is gone', () => {
    expect(restoreScrollTop({ key: 'b', offset: -6 }, () => null)).toBeNull()
  })

  it('leaves the scroller alone when there was no anchor', () => {
    expect(restoreScrollTop(null, () => 300)).toBeNull()
  })

  it('never asks the scroller for a negative offset', () => {
    expect(restoreScrollTop({ key: 'a', offset: 40 }, () => 10)).toBe(0)
  })

  it('is a no-op when nothing moved', () => {
    const items = [{ key: 'b', start: 64, end: 128 }]
    const anchor = captureAnchor(items, 70)!
    expect(restoreScrollTop(anchor, () => 64)).toBe(70)
  })
})
