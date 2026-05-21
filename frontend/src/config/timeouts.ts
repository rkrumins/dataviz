/**
 * Central frontend timeout configuration.
 *
 * Every fetch/AbortController deadline used by the app comes from here.
 * Defaults are intentionally generous so legitimately slow backend
 * responses (deep trace traversals, wide containment fanout) are not
 * aborted before the backend's own per-operation budget fires.
 *
 * Override at build/run time via Vite env vars:
 *   VITE_TIMEOUT_DEFAULT_MS
 *   VITE_TIMEOUT_TRACE_MS
 *   VITE_TIMEOUT_GET_CHILDREN_MS
 *   VITE_TIMEOUT_AGGREGATED_EDGES_MS
 *   VITE_TIMEOUT_ADMIN_LIST_MS
 *   VITE_TIMEOUT_LINEAGE_FOCUS_MS
 *
 * Companion backend constants live in
 * backend/app/config/resilience.py.
 */

function readMs(key: string, fallback: number): number {
  const raw = (import.meta.env as Record<string, string | undefined>)[key]
  const n = raw === undefined ? NaN : Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export const TIMEOUTS = {
  DEFAULT_MS:          readMs('VITE_TIMEOUT_DEFAULT_MS',          30_000),
  TRACE_MS:            readMs('VITE_TIMEOUT_TRACE_MS',            60_000),
  GET_CHILDREN_MS:     readMs('VITE_TIMEOUT_GET_CHILDREN_MS',     30_000),
  AGGREGATED_EDGES_MS: readMs('VITE_TIMEOUT_AGGREGATED_EDGES_MS', 45_000),
  EDGES_BETWEEN_MS:    readMs('VITE_TIMEOUT_EDGES_BETWEEN_MS',    45_000),
  PROVIDER_HEALTH_MS:  readMs('VITE_TIMEOUT_PROVIDER_HEALTH_MS',  30_000),
  // Per-call deadline for admin/dashboard list fan-outs wrapped in
  // Promise.allSettled. Generous enough for a healthy backend, tight
  // enough that one slow provider does not pin the page on a spinner.
  ADMIN_LIST_MS:       readMs('VITE_TIMEOUT_ADMIN_LIST_MS',       8_000),
  // Lineage drawer canvas reveal (onFocusNode). The drawer should never
  // hang for more than a few seconds waiting for the canvas to pan to
  // a node — if it does, drop the wait and let the user keep working.
  LINEAGE_FOCUS_MS:    readMs('VITE_TIMEOUT_LINEAGE_FOCUS_MS',    5_000),
} as const
