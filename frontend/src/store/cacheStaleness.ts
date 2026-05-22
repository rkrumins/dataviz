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
import { TIMEOUTS } from '@/config/timeouts'

interface StaleEntry {
  /** Monotonic time-of-marking; used to compute auto-expiry. */
  ts: number
  /** Endpoint label that triggered the signal (children-with-edges, aggregated, …) — for diagnostics only. */
  endpoint?: string
}

interface CacheStalenessState {
  /** Key = ``"<workspaceId>:<dataSourceId>"`` (matches providerHealth shape). */
  entries: Map<string, StaleEntry>

  /** Mark a scope stale. Idempotent — a second call within the TTL window
   *  refreshes ``ts`` and resets the auto-clear timer. */
  markStale: (workspaceId: string | undefined, dataSourceId: string | undefined, endpoint?: string) => void
  /** Explicitly clear a scope, e.g. when a fresh response arrives. */
  clear: (workspaceId: string | undefined, dataSourceId: string | undefined) => void
  /** True iff this scope is currently flagged stale (within the TTL window). */
  isStale: (workspaceId: string | undefined, dataSourceId: string | undefined) => boolean
  /** Wipe everything — entries + pending timers. Called by
   *  ``cleanupOnWorkspaceSwitch`` so the banner doesn't bleed across
   *  workspace boundaries. */
  reset: () => void
}

// TTL window for a stale-fallback signal. Sourced from the central
// TIMEOUTS config — see ``frontend/src/config/timeouts.ts`` for the
// safe-range clamp + env override (``VITE_CACHE_STALENESS_TTL_MS``).
const STALE_TTL_MS = TIMEOUTS.CACHE_STALENESS_TTL_MS

function _key(workspaceId?: string, dataSourceId?: string): string | null {
  if (!workspaceId || !dataSourceId) return null
  return `${workspaceId}:${dataSourceId}`
}

/**
 * Pending auto-clear timers keyed by scope. Lives at module scope (not
 * in the store state) because timer handles are not serializable and
 * never read by selectors — only `markStale` / `clear` / `reset` touch
 * them. Without this map the banner stays visible past the TTL since
 * Zustand only re-renders on state mutation, not on wall-clock elapse.
 */
const _timers = new Map<string, ReturnType<typeof setTimeout>>()

function _cancelTimer(key: string): void {
  const handle = _timers.get(key)
  if (handle !== undefined) {
    clearTimeout(handle)
    _timers.delete(key)
  }
}

export const useCacheStalenessStore = create<CacheStalenessState>((set, get) => ({
  entries: new Map(),

  markStale: (workspaceId, dataSourceId, endpoint) => {
    const key = _key(workspaceId, dataSourceId)
    if (!key) return
    // Coalesce: if the same scope is re-marked within the TTL window
    // (which is normal under a stale-fallback storm), skip the state
    // mutation but reset the timer so the banner stays up for a fresh
    // TTL from the latest signal. This avoids re-render-on-every-fetch.
    const existing = get().entries.get(key)
    const now = Date.now()
    if (existing && now - existing.ts < STALE_TTL_MS / 2) {
      _cancelTimer(key)
      _timers.set(key, setTimeout(() => {
        get().clear(workspaceId, dataSourceId)
      }, STALE_TTL_MS))
      return
    }
    const next = new Map(get().entries)
    next.set(key, { ts: now, endpoint })
    set({ entries: next })
    // Schedule auto-clear so subscribers re-render when the window
    // closes — Zustand won't fire on a passive Date.now() tick.
    _cancelTimer(key)
    _timers.set(key, setTimeout(() => {
      get().clear(workspaceId, dataSourceId)
    }, STALE_TTL_MS))
  },

  clear: (workspaceId, dataSourceId) => {
    const key = _key(workspaceId, dataSourceId)
    if (!key) return
    _cancelTimer(key)
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

  reset: () => {
    for (const handle of _timers.values()) clearTimeout(handle)
    _timers.clear()
    set({ entries: new Map() })
  },
}))
