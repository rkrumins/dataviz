/**
 * Right after a publish the watermark reads idle-and-behind for a moment (the projection has not
 * started yet). The poll used to stop on exactly that reading, so Data health could say "behind"
 * until something else refetched it.
 */
import { describe, expect, it } from 'vitest'
import { watermarkPollInterval } from '../useVersioning'

const behindIdle = { fresh: false, status: 'idle' as const }

describe('watermarkPollInterval', () => {
  it('keeps polling a behind-and-idle graph for a while after main advanced, then stops', () => {
    expect(watermarkPollInterval(behindIdle, false, 1_000, 5_000)).toBe(3_000)
    expect(watermarkPollInterval(behindIdle, false, 1_000, 1_000 + 61_000)).toBe(false)
    expect(watermarkPollInterval(behindIdle, false, undefined, 5_000)).toBe(false)
  })

  it('stops on a recorded failure, and never polls a graph that is in sync', () => {
    expect(watermarkPollInterval({ ...behindIdle, lastError: 'boom' }, false, 1_000, 5_000)).toBe(false)
    expect(watermarkPollInterval({ fresh: true, status: 'idle' }, false, 1_000, 5_000)).toBe(false)
  })

  it('polls while catching up or rebuilding, and always when forced', () => {
    expect(watermarkPollInterval({ fresh: false, status: 'projecting' }, false, undefined, 0)).toBe(3_000)
    expect(watermarkPollInterval({ fresh: false, status: 'rebuilding' }, false, undefined, 0)).toBe(3_000)
    expect(watermarkPollInterval(undefined, true, undefined, 0)).toBe(3_000)
  })
})
