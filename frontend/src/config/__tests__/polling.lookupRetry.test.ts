/**
 * lookupRetryDelayMs — the one backoff for the background lookups a card's
 * lineage markers wait on. They retry on their own clock, so a failure never
 * waits for the next canvas change, and never hammers a server that is
 * already failing them.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { lookupRetryDelayMs } from '../polling'

afterEach(() => { vi.restoreAllMocks() })

describe('lookupRetryDelayMs', () => {
  it('starts at 2s and doubles per failure, capped at a minute', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    expect([1, 2, 3, 4, 5, 6, 7, 12].map(lookupRetryDelayMs))
      .toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000])
  })

  it('is jittered, so canvases that failed together do not return together', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99)
    const delay = lookupRetryDelayMs(1)
    expect(delay).toBeGreaterThan(2_000)
    expect(delay).toBeLessThanOrEqual(2_600)
  })
})
