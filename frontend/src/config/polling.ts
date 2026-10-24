/**
 * Centralised polling configuration.
 *
 * Two responsibilities:
 *
 * 1. **One place to tune intervals.** Every poll across the app reads
 *    its baseline from here so an operator can re-balance the load
 *    floor without grepping for `setInterval(`.
 *
 * 2. **Jitter helper.** Adds up to ±`frac` random noise to a base
 *    interval so 1000 clients don't all poll at the same instant.
 *    Without jitter, the backend sees a `users / interval` spike at
 *    every multiple of the interval; with jitter, the load is spread
 *    flat. For 1000 users at 15s baseline that's `~67 req/s spike → ~67
 *    req/s flat` — same average but no thundering herd.
 *
 * The values here are baselines. The change manifest's is also
 * admin-configurable: every manifest carries the Live updates interval,
 * which overrides the constant below, so ops can dial it remotely
 * without a deploy.
 */

/** Baseline interval constants. All values in milliseconds. */
export const POLLING_INTERVALS = {
  /**
   * Provider health/status, re-read while a provider is down and only
   * then (`lib/outageRecheck.ts`). Otherwise both follow the change feed.
   * The cadence the old background poll used, kept for the one moment
   * that matters: noticing a recovery whose published transition was
   * lost, or is waiting behind a long change-feed interval.
   */
  providerOutageRecheck: 60_000,
  /**
   * The change manifest (`GET /api/v1/changes`) — the one request that
   * replaced seven — until the server says otherwise. Every manifest
   * carries `checkAfterSeconds`, the admin's Live updates setting (15s to
   * 10 minutes), and the feed follows it.
   *
   * With live push on, this is a reconciliation floor rather than the
   * mechanism: it catches what the stream missed (a delivery lost across
   * a reconnect, a stream refused because a process was full). 60s is
   * the interval most of the seven polls it replaced ran at.
   */
  changeManifest: 60_000,
  /**
   * Aggregation worker fleet panel (admin → workspace). Ticks while the
   * panel is mounted; the fleet is a live operational view, so 10s is
   * the cadence an operator expects. Jitter and the hidden-tab pause
   * come from `usePolling`, which this now uses — the panel previously
   * hand-rolled its own loop and had neither.
   */
  aggregationFleet: 10_000,
  /**
   * Aggregation job history — only ticks while a job is actually
   * pending/running. Bumped from 3s to 5s because below 5s the UI
   * gains nothing (humans perceive ~2s as "real time") and the cost
   * scales linearly with how many users are watching.
   */
  aggregationHistoryActive: 5_000,
  /**
   * "Your connections are still catching up" — the canvas asks the projector
   * whether a source really is behind, and it only arms once a read came back
   * SHORT. So this is the one poll guaranteed to be running while the graph
   * store is already hurting, on every affected viewer at once. 60s rather
   * than the 15s it started at: the condition it watches clears in minutes,
   * not seconds, and a minute of notice latency on a banner that says "this
   * clears on its own" costs the reader nothing.
   */
  projectionCatchUp: 60_000,
  /**
   * Canvas auto-retry cadence while the graph provider is warming up
   * (loading its dataset) or briefly unavailable. Deliberately NOT tight:
   * a graph that's reloading takes seconds-to-minutes, so hammering every
   * 2-3s just multiplies load across every affected user with no faster
   * recovery. A few gentle, JITTERED attempts (see PROVIDER_RETRY_MAX_ATTEMPTS)
   * catch a quick recovery; after that the canvas stops and offers an
   * explicit Retry. Jitter avoids a thundering herd when 100s of users hit
   * the same outage; the retry also pauses entirely while the tab is hidden.
   * Overridable per-deployment via VITE_PROVIDER_RETRY_INTERVAL_MS.
   */
  providerRetry: (() => {
    const env = Number(import.meta.env?.VITE_PROVIDER_RETRY_INTERVAL_MS)
    return Number.isFinite(env) && env >= 2_000 ? env : 10_000
  })(),
  /**
   * Slow background retry cadence AFTER the fast auto-retry budget
   * (PROVIDER_RETRY_MAX_ATTEMPTS) is exhausted while the provider is hard
   * unavailable. A node rotation + dataset reload routinely outlasts the
   * fast window (~1 min); without a slow floor the canvas latched on the
   * overlay until a manual Retry or page reload. Jittered, and paused
   * while the tab is hidden — the same order of load as the existing
   * 60s provider-health polls. Warming retries never drop to this cadence
   * (they stay on providerRetry — the backend explicitly said Retry-After).
   * Overridable per-deployment via VITE_PROVIDER_RETRY_SLOW_INTERVAL_MS.
   */
  providerRetrySlow: (() => {
    const env = Number(import.meta.env?.VITE_PROVIDER_RETRY_SLOW_INTERVAL_MS)
    return Number.isFinite(env) && env >= 10_000 ? env : 60_000
  })(),
} as const

/**
 * How many FAST auto-retries (providerRetry cadence) the canvas makes while
 * the provider is hard-unavailable before degrading to the slow background
 * cadence (providerRetrySlow) — it never stops entirely, so recovery from a
 * node rotation doesn't require a user click. Warming (503 + Retry-After)
 * never counts against this budget: the backend explicitly said "retry
 * later". Overridable via VITE_PROVIDER_RETRY_MAX_ATTEMPTS.
 */
export const PROVIDER_RETRY_MAX_ATTEMPTS = (() => {
  const env = Number(import.meta.env?.VITE_PROVIDER_RETRY_MAX_ATTEMPTS)
  return Number.isFinite(env) && env >= 0 ? env : 5
})()

/**
 * Add bounded jitter to a base interval. Used to prevent lockstep
 * polling across many clients — without this, every client that
 * started near the same instant would fire at the same wall-clock
 * times forever.
 *
 * Returns an integer milliseconds value in the range
 * `[baseMs, baseMs * (1 + frac)]`. Default `frac = 0.3` matches what
 * exponential-backoff libraries typically use; tune lower (e.g.
 * `0.1`) if a tight cadence matters, higher if smoothing is more
 * important than predictability.
 *
 * Pure function: easy to unit-test, no DOM / timer dependencies.
 */
export function withJitter(baseMs: number, frac = 0.3): number {
  // `> 0` rather than `<= 0`, because `NaN <= 0` is FALSE. A NaN base (an
  // undefined interval multiplied out at a call site) would otherwise flow
  // through `Math.floor(NaN)` and out as NaN — and `setTimeout(fn, NaN)`
  // coerces its delay to 0, which turns a caller's poll into a tight loop.
  if (!(baseMs > 0)) return 0
  const spread = Number.isFinite(frac) ? Math.max(0, Math.min(1, frac)) : 0
  return Math.floor(baseMs + Math.random() * baseMs * spread)
}

/**
 * How long a background lookup waits before asking again after its nth
 * failure in a row (n ≥ 1): 2s, doubling, capped at a minute, and jittered
 * so canvases that failed together do not come back together. For the
 * lookups a card's lineage markers wait on (ancestor chains, degree totals):
 * they retry on their own clock, not on the next canvas change, which may
 * never come.
 */
export function lookupRetryDelayMs(failures: number): number {
  return withJitter(Math.min(60_000, 2_000 * 2 ** Math.max(0, failures - 1)))
}

/**
 * How long a job's progress poll (an import, an export, a publish, enabling
 * version control) waits before asking again after its `tick`th answer
 * (0-based): 1s for the first five, so a short job's result shows at once,
 * then 2s, and 5s once thirty answers have shown the job to be a long one:
 * each dialog watching a job that runs for an hour asks about 700 times,
 * rather than 3,600 at a steady second. Jittered, so dialogs opened together
 * don't keep asking together.
 */
export function jobPollDelayMs(tick: number): number {
  return withJitter(tick < 5 ? 1_000 : tick < 30 ? 2_000 : 5_000)
}
