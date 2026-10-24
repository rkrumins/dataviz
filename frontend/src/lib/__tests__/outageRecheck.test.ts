import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startOutageRecheck } from '../outageRecheck'

const INTERVAL = 60_000
/** `withJitter` adds up to 30%, so one interval has certainly passed by here. */
const ONE_TICK = INTERVAL * 1.3 + 1

function fakeStore(initiallyDown: boolean) {
  let down = initiallyDown
  const listeners = new Set<() => void>()
  return {
    isDown: () => down,
    set(next: boolean) {
      down = next
      listeners.forEach((l) => l())
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

describe('startOutageRecheck', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('costs nothing while everything is healthy', () => {
    const store = fakeStore(false)
    const recheck = vi.fn()
    const stop = startOutageRecheck(store.isDown, recheck, INTERVAL, store.subscribe)

    vi.advanceTimersByTime(ONE_TICK * 10)

    expect(recheck).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    stop()
  })

  it('rechecks on every interval for as long as something is down', () => {
    const store = fakeStore(true)
    const recheck = vi.fn()
    const stop = startOutageRecheck(store.isDown, recheck, INTERVAL, store.subscribe)

    vi.advanceTimersByTime(ONE_TICK)
    expect(recheck).toHaveBeenCalledTimes(1)
    // The same outage again changes no state, so nothing else would re-arm.
    vi.advanceTimersByTime(ONE_TICK)
    expect(recheck).toHaveBeenCalledTimes(2)
    stop()
  })

  it('stops once everything is back, without one last request', () => {
    const store = fakeStore(true)
    const recheck = vi.fn()
    const stop = startOutageRecheck(store.isDown, recheck, INTERVAL, store.subscribe)

    store.set(false)
    vi.advanceTimersByTime(ONE_TICK * 5)

    expect(recheck).not.toHaveBeenCalled()
    stop()
  })

  it('starts when something goes down later, and keeps one timer however often it hears so', () => {
    const store = fakeStore(false)
    const recheck = vi.fn()
    const stop = startOutageRecheck(store.isDown, recheck, INTERVAL, store.subscribe)

    store.set(true)
    store.set(true)
    store.set(true)
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(ONE_TICK)

    expect(recheck).toHaveBeenCalledTimes(1)
    stop()
  })

  it('does nothing after teardown', () => {
    const store = fakeStore(true)
    const recheck = vi.fn()
    const stop = startOutageRecheck(store.isDown, recheck, INTERVAL, store.subscribe)

    stop()
    store.set(true)
    vi.advanceTimersByTime(ONE_TICK * 5)

    expect(recheck).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
