/**
 * outageRecheck — while something is down, keep asking on a timer.
 *
 * Provider health and status no longer poll. They refresh when the server
 * publishes a transition, when a graph response carries
 * `X-Provider-Health`, on mount, and on coming back to the tab. While
 * everything is up that is enough. During an outage it is not quite,
 * because the one signal that matters then — "it is back" — can be
 * missed: a transition published while Redis is unreachable is lost, and
 * with live push off the admin's check interval can be minutes long.
 *
 * So for exactly as long as something is down, this re-reads on the
 * cadence the old pollers used. It costs nothing while everything is
 * healthy, and it depends on neither Redis, the change feed, nor the
 * feed's check interval.
 */
import { withJitter } from '@/config/polling'

/**
 * Call `recheck` every `intervalMs` (jittered) while `isDown()` is true.
 *
 * `subscribe` is how it hears that something may have gone down — a
 * zustand store's `subscribe` fits — so a timer exists only during an
 * outage. One timer at most, however often the store changes. Returns a
 * teardown.
 */
export function startOutageRecheck(
  isDown: () => boolean,
  recheck: () => void,
  intervalMs: number,
  subscribe: (listener: () => void) => () => void,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  const arm = () => {
    if (stopped || timer !== null || !isDown()) return
    timer = setTimeout(() => {
      timer = null
      // Recovered while we waited: stop without a request.
      if (stopped || !isDown()) return
      recheck()
      // Re-arm on our own rather than waiting for a state change: a
      // refresh that finds the same outage changes nothing, so the
      // subscription would never fire again.
      arm()
    }, withJitter(intervalMs))
  }

  const unsubscribe = subscribe(arm)
  arm()

  return () => {
    stopped = true
    unsubscribe()
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
}
