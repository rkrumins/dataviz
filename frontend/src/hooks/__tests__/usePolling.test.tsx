import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { usePolling } from '../usePolling'

/**
 * Locks usePolling's cancellation contract as an executable invariant.
 *
 * THE BUG THIS GUARDS (observed in production as a request storm):
 * `cancelledRef` / `timerRef` are single shared refs with no generation
 * token. A tick parked in `await callback()` when the effect re-arms will
 * wake up AFTER the new effect generation has reset `cancelled` back to
 * false — so it sees "not cancelled", re-arms itself, and becomes a second,
 * immortal poll chain. `timerRef` only ever holds ONE handle, so cleanup can
 * never cancel the other one.
 *
 * Because the always-mounted surfaces (announcement banner, provider health)
 * never unmount, those chains accumulate for the lifetime of the tab. Every
 * re-arm that lands during an in-flight request permanently adds another
 * chain. The observed result: a request rate that climbs monotonically to
 * hundreds/sec, and a heap that grows with it.
 */
describe('usePolling — cancellation contract', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('does NOT keep polling from a superseded generation (chain leak)', async () => {
    // Each call parks until we explicitly release it, so we can re-arm the
    // effect while a tick is mid-flight — the exact race that leaks.
    const releases: Array<() => void> = []
    const callback = vi.fn(() => new Promise<void>((res) => releases.push(res)))

    const { rerender } = renderHook(
      ({ ms }) => usePolling(callback, ms, { jitterFrac: 0 }),
      { initialProps: { ms: 1000 } },
    )

    // Generation A fired on mount and is now parked inside `await`.
    expect(callback).toHaveBeenCalledTimes(1)

    // Re-arm the effect (interval change) WHILE generation A is still in
    // flight. Generation B fires immediately and parks too.
    await act(async () => {
      rerender({ ms: 2000 })
    })
    expect(callback).toHaveBeenCalledTimes(2)

    // Release both parked ticks. Generation A is superseded and MUST die.
    // Only generation B is allowed to schedule another tick — at 2000ms.
    await act(async () => {
      releases.forEach((r) => r())
      await Promise.resolve()
    })

    // Advance 1000ms: generation A's (dead) cadence. Generation B is not due
    // until 2000ms, so nothing may fire. If the superseded chain survived, it
    // re-armed itself at 1000ms and fires here — that is the leak.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })

    expect(callback).toHaveBeenCalledTimes(2)
  })

  it('stops completely on unmount, even mid-flight', async () => {
    const releases: Array<() => void> = []
    const callback = vi.fn(() => new Promise<void>((res) => releases.push(res)))

    const { unmount } = renderHook(() =>
      usePolling(callback, 1000, { jitterFrac: 0 }),
    )
    expect(callback).toHaveBeenCalledTimes(1)

    unmount()
    await act(async () => {
      releases.forEach((r) => r())
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(5000)
    })

    expect(callback).toHaveBeenCalledTimes(1)
  })

  it('refuses to run on a non-finite interval instead of spinning at 0ms', async () => {
    // `undefined * 1000` is NaN. `NaN <= 0` is FALSE, so a `<= 0` guard does
    // not catch it, `withJitter` returns NaN, and `setTimeout(fn, NaN)`
    // coerces the delay to 0 — turning the poller into a tight loop that
    // re-fires as fast as the network can answer.
    const callback = vi.fn(() => Promise.resolve())

    renderHook(() => usePolling(callback, NaN, { jitterFrac: 0 }))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })

    // A NaN interval is a bug at the call site; the poller must stay silent
    // rather than melt the backend.
    expect(callback).not.toHaveBeenCalled()
  })
})
