/**
 * Centralised polling configuration.
 *
 * Two responsibilities:
 *
 * 1. **One place to tune intervals.** Every poll across the app reads
 *    its baseline from here so an operator can re-balance the load
 *    floor (announcements every 30s instead of 15s, etc.) without
 *    grepping for `setInterval(`.
 *
 * 2. **Jitter helper.** Adds up to ±`frac` random noise to a base
 *    interval so 1000 clients don't all poll at the same instant.
 *    Without jitter, the backend sees a `users / interval` spike at
 *    every multiple of the interval; with jitter, the load is spread
 *    flat. For 1000 users at 15s baseline that's `~67 req/s spike → ~67
 *    req/s flat` — same average but no thundering herd.
 *
 * The values here are baselines. The announcements poll is also
 * admin-configurable via the backend's announcement config (overrides
 * the constant below) so ops can dial it remotely without a deploy.
 */

/** Baseline interval constants. All values in milliseconds. */
export const POLLING_INTERVALS = {
  /**
   * Active announcements (banner). Backend's admin config can
   * override this per-deployment via `/announcements/config`; this is
   * the fallback used until the config response lands. 60s (was 15s):
   * this was the highest-frequency idle poll in the app — at fleet
   * scale it dominated baseline request volume for a surface where a
   * minute of announcement latency is invisible. Ops can still dial
   * it down remotely via the admin config when a faster banner is
   * genuinely needed.
   */
  announcements: 60_000,
  /**
   * Provider health/status. Background poll for the connection status
   * indicator across all configured providers. 60s (was 30s): the
   * indicator is advisory; real outages surface through request
   * failures and the health banner long before this poll.
   */
  providerStatus: 60_000,
  /**
   * Aggregation job history — only ticks while a job is actually
   * pending/running. Bumped from 3s to 5s because below 5s the UI
   * gains nothing (humans perceive ~2s as "real time") and the cost
   * scales linearly with how many users are watching.
   */
  aggregationHistoryActive: 5_000,
  /**
   * Caller's own permissions (``GET /me/permissions``). Catches the
   * idle-user case where an admin mutates bindings while the user is
   * staring at a page without making any API calls — the silent
   * refresh-on-401 dance only fires when the user actively requests
   * something, so without this poll, idle users would still be on
   * stale claims until natural JWT expiry. The endpoint is a no-DB
   * JWT decode (``backend/app/api/v1/endpoints/me.py:39``) so a 60s
   * poll is essentially free.
   */
  permissions: 60_000,
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
  if (baseMs <= 0) return 0
  const spread = Math.max(0, Math.min(1, frac))
  return Math.floor(baseMs + Math.random() * baseMs * spread)
}
