/**
 * jobPollDelayMs — the one pace for following a job: often while it may still be a short one, then
 * less as it proves long, so a fleet of open dialogs asks a long job about itself a few times a
 * minute rather than every second.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { jobPollDelayMs } from '../polling'

afterEach(() => { vi.restoreAllMocks() })

describe('jobPollDelayMs', () => {
  it('asks every second for five answers, then every 2s, then every 5s after thirty', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    expect([0, 4, 5, 29, 30, 500].map(jobPollDelayMs)).toEqual([1_000, 1_000, 2_000, 2_000, 5_000, 5_000])
  })

  it('is jittered, so dialogs opened together do not keep asking together', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99)
    const delay = jobPollDelayMs(30)
    expect(delay).toBeGreaterThan(5_000)
    expect(delay).toBeLessThanOrEqual(6_500)
  })
})
