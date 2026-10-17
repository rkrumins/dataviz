/**
 * appVisibility — one "the user came back" signal for the whole app.
 *
 * Several always-mounted surfaces want to refresh the moment a tab
 * regains attention: the announcement banner, the permission poller,
 * the feature-flag sync, the notification bells. Each of them grew its
 * own listener, and the listeners disagreed about what "came back"
 * means — `store/features.ts` and `NotificationBell.tsx` each listened
 * to BOTH `visibilitychange` and `focus`, so a single alt-tab fired
 * them twice apiece. Counting across all the subscribers, returning to
 * a tab cost 5-7 immediate requests, none of them coordinated.
 *
 * This module owns the listeners once and hands subscribers a single
 * coalesced callback. Two behaviours do the work:
 *
 *  1. **Coalescing.** `visibilitychange` and `focus` arrive within a
 *     frame of each other when a window is re-activated. A short debounce
 *     collapses that pair (and any other burst) into one notification.
 *
 *  2. **A refresh floor.** Alt-tabbing away and back three times in ten
 *     seconds does not make the data any staler than the first return
 *     did. `minIntervalMs` skips a notification that lands too soon
 *     after the last one, which is what stops rapid window-switching
 *     from multiplying into a request storm.
 *
 * This does NOT reduce the steady-state poll rate — that is the change
 * feed's job. It bounds the transient cost of attention changes, which
 * is a different and previously unbounded problem.
 */

/** Fires when the document becomes visible or the window regains focus. */
type Listener = () => void

interface Subscription {
  cb: Listener
  minIntervalMs: number
  lastFiredAt: number
}

/**
 * How long to wait for a burst of attention events to settle before
 * notifying. `visibilitychange` and `focus` land within a frame of one
 * another; 150ms comfortably covers that without being perceptible.
 */
const COALESCE_MS = 150

/**
 * Default floor between notifications for one subscriber. 10s is chosen
 * to be shorter than every poll interval in `config/polling.ts` (the
 * fastest idle poll is 60s), so this never delays a refresh the timer
 * would have done sooner — it only collapses repeated attention events.
 */
const DEFAULT_MIN_INTERVAL_MS = 10_000

const subscriptions = new Set<Subscription>()
let coalesceTimer: ReturnType<typeof setTimeout> | null = null
let listenersInstalled = false

function notifySubscribers(): void {
  coalesceTimer = null
  // A burst that ends with the tab hidden again (alt-tab through) is
  // not a return — drop it rather than fetching for a tab nobody is
  // looking at.
  if (typeof document !== 'undefined' && document.hidden) return

  const now = Date.now()
  for (const sub of subscriptions) {
    if (now - sub.lastFiredAt < sub.minIntervalMs) continue
    sub.lastFiredAt = now
    try {
      sub.cb()
    } catch {
      // A throwing subscriber must not stop the others from being
      // told. Callbacks own their own error handling.
    }
  }
}

function onAttentionEvent(): void {
  if (coalesceTimer !== null) clearTimeout(coalesceTimer)
  coalesceTimer = setTimeout(notifySubscribers, COALESCE_MS)
}

function installListeners(): void {
  if (listenersInstalled) return
  if (typeof document === 'undefined' || typeof window === 'undefined') return
  // `visibilitychange` fires on document, `focus` on window. Both are
  // needed: switching browser tabs fires the former, switching between
  // applications with the tab already frontmost fires only the latter.
  document.addEventListener('visibilitychange', onAttentionEvent)
  window.addEventListener('focus', onAttentionEvent)
  listenersInstalled = true
}

/**
 * Call `cb` when the app regains attention, at most once per
 * `minIntervalMs`. Returns an unsubscribe function.
 *
 * The first call installs the DOM listeners lazily, so importing this
 * module has no side effect — which keeps it safe to import from
 * modules that run at boot before the DOM is meaningful, and keeps
 * tests from inheriting listeners they did not ask for.
 */
export function onAppVisible(
  cb: Listener,
  options?: { minIntervalMs?: number },
): () => void {
  installListeners()
  const sub: Subscription = {
    cb,
    minIntervalMs: options?.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS,
    // Zero, NOT `Date.now()`. The floor exists to collapse *repeated*
    // returns; the first return after subscribing is the one every
    // caller actually cares about ("an admin changed a flag, I looked
    // at my tab, it refreshed"). Seeding with the current time puts
    // that first return inside the floor and silently swallows it,
    // which is the exact behaviour these subscriptions exist to provide.
    lastFiredAt: 0,
  }
  subscriptions.add(sub)
  return () => {
    subscriptions.delete(sub)
  }
}

/** Test-only: drop all subscribers and pending timers. */
export function __resetAppVisibilityForTests(): void {
  subscriptions.clear()
  if (coalesceTimer !== null) {
    clearTimeout(coalesceTimer)
    coalesceTimer = null
  }
}
