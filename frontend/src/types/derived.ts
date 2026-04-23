/**
 * Response envelope for derived (cached/computed) backend endpoints.
 *
 * Mirrors `backend/app/schemas/derived.py`. Applied today to
 * `/graph/stats` and `/graph/metadata/schema` — other derived endpoints
 * still return their raw shapes.
 *
 * The envelope exists so a cold or degraded cache yields a normal 200
 * with an explicit `status` the UI can handle, instead of a 504 that
 * breaks the page.
 */

export type DerivedStatus =
  | 'fresh'        // within TTL
  | 'stale'        // past TTL, usable, recompute queued
  | 'computing'    // no cached data, recompute queued
  | 'partial'      // schema only: types present, counts missing
  | 'unavailable'  // cache dead and fallback dead (rare)

export interface DerivedMeta {
  status: DerivedStatus
  source: 'memory' | 'db' | 'ontology' | 'none'
  /** ISO timestamp of last successful computation, if any. */
  computed_at: string | null
  age_seconds: number
  ttl_seconds: number
  job_id: string | null
  missing_fields: string[]
}

export interface DerivedResponse<T> {
  data: T | null
  meta: DerivedMeta
}

/**
 * Type guard: `true` when the value looks like a DerivedResponse envelope.
 *
 * Used by the fetch adapters to detect whether a given endpoint has been
 * migrated to the envelope shape, so callers can still consume legacy
 * raw responses without breaking.
 */
export function isDerivedResponse<T>(value: unknown): value is DerivedResponse<T> {
  if (!value || typeof value !== 'object') return false
  const v = value as { meta?: unknown; data?: unknown }
  if (v.meta === undefined || !v.meta || typeof v.meta !== 'object') return false
  const m = v.meta as { status?: unknown }
  return typeof m.status === 'string'
}

/**
 * Unwrap a DerivedResponse to its `data` payload, or pass through a
 * legacy raw response unchanged. Throws only on `status=unavailable`
 * (a genuine infra failure) so callers preserve their existing
 * error-handling semantics.
 */
export function unwrapDerived<T>(value: T | DerivedResponse<T>): {
  data: T | null
  meta: DerivedMeta | null
} {
  if (isDerivedResponse<T>(value)) {
    if (value.meta.status === 'unavailable') {
      throw new Error(
        `Derived endpoint returned status=unavailable (source=${value.meta.source}). ` +
        `Cache and fallback are both unreachable.`,
      )
    }
    return { data: value.data, meta: value.meta }
  }
  // Legacy raw response — no envelope, return as-is with null meta.
  return { data: value as T, meta: null }
}

/**
 * True iff the envelope represents a state where data is present but
 * might be behind the live graph (stale, partial, computing-with-prior-data).
 * Useful for UI banners that say "schema is being refreshed".
 */
export function isDerivedStale(meta: DerivedMeta | null): boolean {
  if (!meta) return false
  return meta.status === 'stale' || meta.status === 'partial' || meta.status === 'computing'
}
