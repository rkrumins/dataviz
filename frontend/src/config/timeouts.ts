/**
 * Central frontend timeout configuration.
 *
 * Every fetch/AbortController deadline + cache-banner TTL used by the
 * app comes from here. Defaults are intentionally generous so
 * legitimately slow backend responses (deep trace traversals, wide
 * containment fanout) are not aborted before the backend's own
 * per-operation budget fires.
 *
 * Every value is clamped to a documented safe range so a bad env
 * override (typo, accidental negative, unrealistically huge number)
 * cannot break the app — invalid input falls back to the default, and
 * an out-of-range valid number is clamped to the nearest bound.
 *
 * Override at build/run time via Vite env vars:
 *   VITE_TIMEOUT_DEFAULT_MS
 *   VITE_TIMEOUT_TRACE_MS
 *   VITE_TIMEOUT_GET_CHILDREN_MS
 *   VITE_TIMEOUT_TOP_LEVEL_MS
 *   VITE_TIMEOUT_AGGREGATED_EDGES_MS
 *   VITE_TIMEOUT_EDGES_BETWEEN_MS
 *   VITE_TIMEOUT_PROVIDER_HEALTH_MS
 *   VITE_TIMEOUT_ADMIN_LIST_MS
 *   VITE_TIMEOUT_LINEAGE_FOCUS_MS
 *   VITE_CACHE_STALENESS_TTL_MS
 *
 * Companion backend constants live in
 * backend/app/config/resilience.py.
 */

interface MsBounds {
  /** Lowest legal value in ms. Anything lower clamps to this. */
  min: number
  /** Highest legal value in ms. Anything higher clamps to this. */
  max: number
}

function readMs(key: string, fallback: number, bounds: MsBounds): number {
  const raw = (import.meta.env as Record<string, string | undefined>)[key]
  if (raw === undefined) return fallback
  const n = Number(raw)
  // Reject NaN / Infinity / non-positive / non-numeric — the env value is
  // worse than the default if it can't be safely used.
  if (!Number.isFinite(n) || n <= 0) {
    if (typeof console !== 'undefined') {
      console.warn(
        `[timeouts] ${key}=${raw} is not a positive finite number; ` +
        `falling back to default ${fallback}ms`,
      )
    }
    return fallback
  }
  // Clamp to documented bounds rather than silently honouring extreme
  // values — a typo like 5 (meaning 5000) would otherwise instant-abort
  // every request.
  if (n < bounds.min) {
    if (typeof console !== 'undefined') {
      console.warn(
        `[timeouts] ${key}=${n}ms is below the safe minimum ${bounds.min}ms; ` +
        `clamping up`,
      )
    }
    return bounds.min
  }
  if (n > bounds.max) {
    if (typeof console !== 'undefined') {
      console.warn(
        `[timeouts] ${key}=${n}ms is above the safe maximum ${bounds.max}ms; ` +
        `clamping down`,
      )
    }
    return bounds.max
  }
  return n
}

// Safe ranges for every knob below. Bounds chosen so:
//   * The lower bound is too short to be useful in practice but still
//     non-zero, so a "0" override clamps to a value that still lets a
//     fast response succeed instead of instant-aborting everything.
//   * The upper bound is the longest a user is willing to wait in any
//     reasonable scenario — beyond it the browser tab feels dead and
//     the failure mode (timeout + retry) is preferable.
const _SHORT  = { min: 1_000,  max: 30_000  } as const   // 1s..30s
const _MEDIUM = { min: 2_000,  max: 120_000 } as const   // 2s..2min
const _LONG   = { min: 5_000,  max: 300_000 } as const   // 5s..5min
const _BANNER = { min: 5_000,  max: 600_000 } as const   // 5s..10min

export const TIMEOUTS = {
  DEFAULT_MS:           readMs('VITE_TIMEOUT_DEFAULT_MS',           30_000, _MEDIUM),
  TRACE_MS:             readMs('VITE_TIMEOUT_TRACE_MS',             60_000, _LONG),
  // Ontology publish runs the impact check and cache invalidation for every
  // assigned data source server-side — give it headroom over the default.
  PUBLISH_MS:           readMs('VITE_TIMEOUT_PUBLISH_MS',           60_000, _LONG),
  GET_CHILDREN_MS:      readMs('VITE_TIMEOUT_GET_CHILDREN_MS',      30_000, _MEDIUM),
  // /nodes/top-level. Must exceed the backend's worst case for this
  // endpoint (page query 15s + best-effort count 5s + queue/serialize
  // overhead — see FALKORDB_TOP_LEVEL_* in resilience.py) so the
  // backend always loses the race and surfaces its own, accurate error.
  TOP_LEVEL_MS:         readMs('VITE_TIMEOUT_TOP_LEVEL_MS',         45_000, _LONG),
  AGGREGATED_EDGES_MS:  readMs('VITE_TIMEOUT_AGGREGATED_EDGES_MS',  45_000, _LONG),
  EDGES_BETWEEN_MS:     readMs('VITE_TIMEOUT_EDGES_BETWEEN_MS',     45_000, _LONG),
  PROVIDER_HEALTH_MS:   readMs('VITE_TIMEOUT_PROVIDER_HEALTH_MS',   30_000, _MEDIUM),
  // Per-call deadline for admin/dashboard list fan-outs wrapped in
  // Promise.allSettled. Generous enough for a healthy backend, tight
  // enough that one slow provider does not pin the page on a spinner.
  ADMIN_LIST_MS:        readMs('VITE_TIMEOUT_ADMIN_LIST_MS',         8_000, _SHORT),
  // Lineage drawer canvas reveal (onFocusNode). The drawer should never
  // hang for more than a few seconds waiting for the canvas to pan to
  // a node — if it does, drop the wait and let the user keep working.
  LINEAGE_FOCUS_MS:     readMs('VITE_TIMEOUT_LINEAGE_FOCUS_MS',      5_000, _SHORT),
  // How long the StaleDataBanner stays visible after the last
  // ``X-Cache-Status: stale-fallback`` signal. Aligned with the
  // backend breaker's reset_timeout (30s) so the banner disappears at
  // roughly the same moment the provider gets a chance to probe healthy.
  CACHE_STALENESS_TTL_MS: readMs('VITE_CACHE_STALENESS_TTL_MS',     30_000, _BANNER),
} as const
