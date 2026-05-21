/**
 * Per-(workspace, dataSource) staleness signal store.
 *
 * Driven by the ``X-Cache-Status: stale-fallback`` response header the
 * backend sets when GraphCache's stale-on-error path serves data from
 * the last-known-good snapshot (see backend P1.1). The signal is
 * **ephemeral**: it auto-clears after ``STALE_TTL_MS`` so the UI banner
 * disappears the moment the provider recovers and fresh responses
 * resume coming through.
 *
 * Two write paths feed this store:
 *   1. ``RemoteGraphProvider._doFetch`` — every graph-cache endpoint
 *   2. ``cacheEnvelope._runEnvelopeFetch`` — every cached-stats endpoint
 *
 * Read path: ``<StaleDataBanner />`` (and any other component that wants
 * to surface a "data may be stale" hint near the affected scope).
 */
import { create } from 'zustand'

interface StaleEntry {
  /** Monotonic time-of-marking; used to compute auto-expiry. */
  ts: number
  /** Endpoint label that triggered the signal (children-with-edges, aggregated, …) — for diagnostics only. */
  endpoint?: string
}

interface CacheStalenessState {
  /** Key = ``"<workspaceId>:<dataSourceId>"`` (matches providerHealth shape). */
  entries: Map<string, StaleEntry>

  /** Mark a scope stale. Idempotent — a second call within the TTL window only refreshes ``ts``. */
  markStale: (workspaceId: string | undefined, dataSourceId: string | undefined, endpoint?: string) => void
  /** Explicitly clear a scope, e.g. when a fresh response arrives. */
  clear: (workspaceId: string | undefined, dataSourceId: string | undefined) => void
  /** True iff this scope is currently flagged stale (within the TTL window). */
  isStale: (workspaceId: string | undefined, dataSourceId: string | undefined) => boolean
}

/**
 * How long after the last stale-fallback signal we keep the banner up.
 * Matches the breaker's default reset_timeout (30 s) so the banner
 * disappears at roughly the same moment the provider gets a chance to
 * probe healthy again. Overridable via ``VITE_CACHE_STALENESS_TTL_MS``.
 */
const STALE_TTL_MS = Number(
  (import.meta.env as Record<string, string | undefined>).VITE_CACHE_STALENESS_TTL_MS ?? 30_000,
) || 30_000

function _key(workspaceId?: string, dataSourceId?: string): string | null {
  if (!workspaceId || !dataSourceId) return null
  return `${workspaceId}:${dataSourceId}`
}

export const useCacheStalenessStore = create<CacheStalenessState>((set, get) => ({
  entries: new Map(),

  markStale: (workspaceId, dataSourceId, endpoint) => {
    const key = _key(workspaceId, dataSourceId)
    if (!key) return
    const next = new Map(get().entries)
    next.set(key, { ts: Date.now(), endpoint })
    set({ entries: next })
  },

  clear: (workspaceId, dataSourceId) => {
    const key = _key(workspaceId, dataSourceId)
    if (!key) return
    const cur = get().entries
    if (!cur.has(key)) return
    const next = new Map(cur)
    next.delete(key)
    set({ entries: next })
  },

  isStale: (workspaceId, dataSourceId) => {
    const key = _key(workspaceId, dataSourceId)
    if (!key) return false
    const entry = get().entries.get(key)
    if (!entry) return false
    return Date.now() - entry.ts < STALE_TTL_MS
  },
}))
