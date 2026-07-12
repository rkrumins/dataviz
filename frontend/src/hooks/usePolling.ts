/**
 * usePolling — jittered, visibility-aware polling for React components.
 *
 * Replaces hand-rolled `useEffect`-with-`setInterval` patterns across
 * the app with a single, well-behaved primitive that:
 *
 *  1. **Jitters every tick** via `withJitter(baseMs)`. Without this,
 *     1000 clients that mounted within a render frame of each other
 *     would all fire their next poll at the same wall-clock instant
 *     forever, creating a sawtooth on the backend.
 *  2. **Pauses on `document.hidden`** via the Page Visibility API.
 *     A user with 10 backgrounded tabs is paying nothing for any of
 *     them; coming back triggers one immediate refresh so the UI
 *     isn't showing stale data for up to one interval-cycle.
 *  3. **Cleans up on unmount.** No dangling timers, no setState after
 *     unmount (the running callback is `cancelled`-checked on its
 *     own completion).
 *
 * Pass `enabled = false` to suspend without unmounting — useful for
 * "only poll while a job is running" patterns. The hook returns a
 * `refresh()` so callers can imperatively kick a fetch (e.g. after a
 * user-driven action) without waiting for the next tick.
 */
import { useCallback, useEffect, useRef } from 'react'
import { withJitter } from '@/config/polling'

export interface UsePollingOptions {
  /** When false, the hook does nothing (no initial fetch, no timer). */
  enabled?: boolean
  /**
   * If true, fire the callback once immediately on mount / on
   * `enabled` flipping true. Default true — matches the
   * historical behaviour of every site this hook replaces.
   */
  fireOnMount?: boolean
  /** Jitter fraction (0..1). Forwarded to `withJitter`. */
  jitterFrac?: number
}

/**
 * Schedule ``callback`` on a jittered interval, pausing while the tab
 * is hidden.
 *
 * The callback can be sync or async; an async one is awaited before
 * the next tick is scheduled so we never have two overlapping
 * in-flight calls from the same hook instance. This is the behaviour
 * almost every existing site wants (the previous `setInterval`
 * pattern could overlap on slow responses; this is a strict
 * improvement, not a regression).
 *
 * Returns ``{ refresh }`` so callers can kick a fetch on user action
 * (route change, manual button) without waiting for the next tick.
 */
export function usePolling(
  callback: () => void | Promise<void>,
  baseIntervalMs: number,
  options?: UsePollingOptions,
): { refresh: () => void } {
  const { enabled = true, fireOnMount = true, jitterFrac } = options ?? {}

  // Keep the latest callback in a ref so changing the callback
  // identity (component re-renders) doesn't cancel and re-arm the
  // timer. The effect below depends only on stable values.
  const cbRef = useRef(callback)
  cbRef.current = callback

  // Stable refresh — uses the latest callback via the ref so callers
  // can wire it to a button without dep-array churn.
  const refresh = useCallback(() => {
    void cbRef.current()
  }, [])

  useEffect(() => {
    // `> 0` rather than `<= 0`: a NaN interval must be REJECTED. Call sites
    // compute this (`pollIntervalSeconds * 1000`), and `undefined * 1000` is
    // NaN. `NaN <= 0` is FALSE, so the old guard waved NaN through; then
    // `withJitter(NaN)` returns NaN and `setTimeout(fn, NaN)` coerces the
    // delay to 0 — turning this poller into a tight loop that re-fires as
    // fast as the network can answer. Measured: 1002 calls per second.
    if (!enabled || !(baseIntervalMs > 0)) return

    // Closure-local, deliberately NOT refs. Each effect run owns its own
    // `cancelled` flag and timer handle, so a tick parked in `await` belongs
    // to exactly one generation and dies with it.
    //
    // These used to be shared refs, and that leaked immortal poll chains: the
    // cleanup set `cancelledRef.current = true`, but the NEXT effect run
    // immediately reset it to false. A tick still parked in `await` from the
    // previous run would then wake, read `cancelled === false`, and re-arm
    // itself — a second chain. The single shared `timerRef` only ever held one
    // handle, so cleanup could never cancel the other. Since the surfaces that
    // poll (announcement banner, provider health) are always mounted, those
    // chains accumulated for the lifetime of the tab: the request rate climbed
    // without bound (measured: a 60s poll arriving 5.9x/sec — ~350 live
    // chains) and every chain retained its closure, so the heap climbed with
    // it. BackendHealthBanner already used this closure-local idiom, which is
    // precisely why its /health poll was the one that never stormed.
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const tick = async () => {
      if (cancelled) return
      // Skip the network call while hidden. The visibilitychange
      // listener below will fire an immediate tick on resume so the
      // user doesn't sit with stale data after un-hiding.
      if (typeof document !== 'undefined' && document.hidden) {
        // Re-arm at the base cadence; the resume handler will kick
        // sooner if the user comes back.
        timer = setTimeout(tick, withJitter(baseIntervalMs, jitterFrac))
        return
      }
      try {
        await cbRef.current()
      } catch {
        // Swallow — the polled callback is the right place to log /
        // handle. usePolling staying alive across errors is the
        // historical behaviour and the desired one for banners /
        // status indicators.
      }
      if (cancelled) return
      timer = setTimeout(tick, withJitter(baseIntervalMs, jitterFrac))
    }

    // Initial fire: immediate (cache-warming) unless caller asked otherwise.
    if (fireOnMount) {
      void tick()
    } else {
      timer = setTimeout(tick, withJitter(baseIntervalMs, jitterFrac))
    }

    // Wake-on-visible: when the user returns to the tab, fire one
    // immediate tick so the UI snaps fresh. The tick itself re-arms
    // the timer at the jittered cadence.
    const onVisibilityChange = () => {
      if (typeof document === 'undefined') return
      if (document.hidden) return
      if (cancelled) return
      if (timer) clearTimeout(timer)
      void tick()
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange)
    }

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      timer = null
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange)
      }
    }
    // ``callback`` intentionally NOT in deps — it's accessed via the
    // ref so identity changes don't trigger a timer reset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, baseIntervalMs, fireOnMount, jitterFrac])

  return { refresh }
}
