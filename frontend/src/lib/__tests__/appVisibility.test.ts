/**
 * Locks down the two behaviours that make `onAppVisible` worth having.
 *
 * The bug it replaces: five always-mounted surfaces each installed their
 * own attention listener, and two of them (`store/features.ts`,
 * `NotificationBell.tsx`) listened to BOTH `visibilitychange` and
 * `focus`. Returning to a tab therefore cost 5-7 immediate requests, and
 * alt-tabbing back and forth multiplied without bound because nothing
 * applied a floor.
 *
 * So: a `visibilitychange` + `focus` pair must produce ONE notification,
 * and a second return inside the refresh floor must produce NONE.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { onAppVisible, __resetAppVisibilityForTests } from '../appVisibility'

/** Drive `document.hidden` / `visibilityState`, which are read-only. */
function setHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { value: hidden, configurable: true })
  Object.defineProperty(document, 'visibilityState', {
    value: hidden ? 'hidden' : 'visible',
    configurable: true,
  })
}

/** The pair a real browser fires when a window is re-activated. */
function fireAttentionPair(): void {
  document.dispatchEvent(new Event('visibilitychange'))
  window.dispatchEvent(new Event('focus'))
}

describe('onAppVisible', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setHidden(false)
    __resetAppVisibilityForTests()
  })

  afterEach(() => {
    __resetAppVisibilityForTests()
    vi.useRealTimers()
  })

  it('coalesces a visibilitychange + focus pair into one notification', () => {
    const cb = vi.fn()
    onAppVisible(cb, { minIntervalMs: 0 })

    fireAttentionPair()
    vi.advanceTimersByTime(200)

    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('applies a refresh floor across repeated returns', () => {
    const cb = vi.fn()
    onAppVisible(cb, { minIntervalMs: 10_000 })

    // The first return always fires — the floor applies between
    // notifications, not between subscribing and the first one.
    fireAttentionPair()
    vi.advanceTimersByTime(200)
    expect(cb).toHaveBeenCalledTimes(1)

    // A second return two seconds later is inside the floor — the data
    // is no staler than it was two seconds ago, so no request.
    vi.advanceTimersByTime(2_000)
    fireAttentionPair()
    vi.advanceTimersByTime(200)
    expect(cb).toHaveBeenCalledTimes(1)

    // Past the floor, it fires again.
    vi.advanceTimersByTime(10_001)
    fireAttentionPair()
    vi.advanceTimersByTime(200)
    expect(cb).toHaveBeenCalledTimes(2)
  })

  it('does not notify when the burst ends with the tab hidden', () => {
    const cb = vi.fn()
    onAppVisible(cb, { minIntervalMs: 0 })

    // Alt-tabbing *away*: the event fires, but by the time the debounce
    // settles the tab is hidden. Fetching for a tab nobody is looking at
    // is exactly the waste this module exists to stop.
    setHidden(true)
    document.dispatchEvent(new Event('visibilitychange'))
    vi.advanceTimersByTime(200)

    expect(cb).not.toHaveBeenCalled()
  })

  it('stops notifying after unsubscribe', () => {
    const cb = vi.fn()
    const unsubscribe = onAppVisible(cb, { minIntervalMs: 0 })
    unsubscribe()

    fireAttentionPair()
    vi.advanceTimersByTime(200)

    expect(cb).not.toHaveBeenCalled()
  })

  it('keeps notifying the other subscribers when one throws', () => {
    const boom = vi.fn(() => {
      throw new Error('subscriber blew up')
    })
    const ok = vi.fn()
    onAppVisible(boom, { minIntervalMs: 0 })
    onAppVisible(ok, { minIntervalMs: 0 })

    fireAttentionPair()
    vi.advanceTimersByTime(200)

    expect(boom).toHaveBeenCalledTimes(1)
    expect(ok).toHaveBeenCalledTimes(1)
  })
})
