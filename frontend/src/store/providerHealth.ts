/**
 * Per-provider health store — tracks which workspace/datasource providers
 * are healthy vs unhealthy.
 *
 * Polls /api/v1/health/providers every 30s (only when tab visible).
 * Used by sidebar, workspace cards, and GraphProviderContext to show
 * health indicators and warn users before switching to broken providers.
 */
import { create } from 'zustand'
import { fetchWithTimeout } from '@/services/fetchWithTimeout'
import { TIMEOUTS } from '@/config/timeouts'
import { onAppVisible } from '@/lib/appVisibility'
import { TOPICS, subscribeToTopic } from '@/store/changeFeed'

export type ProviderStatus = 'healthy' | 'unhealthy' | 'unknown'

interface ProviderHealthEntry {
  status: ProviderStatus
  error?: string
  lastChecked: number
}

// Compare the re-render-relevant fields only. `lastChecked` is a heartbeat
// bumped every poll and nothing renders it, so comparing it would defeat the
// dedupe and churn a fresh Map reference each tick.
function healthMapsEqual(
  a: Map<string, ProviderHealthEntry>,
  b: Map<string, ProviderHealthEntry>,
): boolean {
  if (a.size !== b.size) return false
  for (const [key, x] of a) {
    const y = b.get(key)
    if (!y || x.status !== y.status || x.error !== y.error) return false
  }
  return true
}

interface ProviderHealthState {
  /** Map of "workspaceId:dataSourceId" → health entry */
  providers: Map<string, ProviderHealthEntry>

  /** Get status for a specific provider scope */
  getStatus: (workspaceId?: string, dataSourceId?: string) => ProviderStatus

  /** Refresh from backend */
  refresh: () => Promise<void>

  /** Ingest a header-borne signal from a real request response (e.g.
   *  ``X-Provider-Health: unreachable``). Lets the UI react in < 1s
   *  instead of waiting for the next 30s ``/health/providers`` poll. */
  markFromHeader: (workspaceId: string | undefined, dataSourceId: string | undefined, value: string) => void
}

export const useProviderHealthStore = create<ProviderHealthState>((set, get) => ({
  providers: new Map(),

  getStatus: (workspaceId?: string, dataSourceId?: string) => {
    if (!workspaceId || !dataSourceId) return 'unknown'
    const key = `${workspaceId}:${dataSourceId}`
    return get().providers.get(key)?.status ?? 'unknown'
  },

  refresh: async () => {
    try {
      const res = await fetchWithTimeout('/api/v1/health/providers', { timeoutMs: TIMEOUTS.PROVIDER_HEALTH_MS })
      if (!res.ok) return

      const data = await res.json() as { providers: Record<string, { status: string; error?: string }> }
      const now = Date.now()
      const newMap = new Map<string, ProviderHealthEntry>()

      for (const [key, entry] of Object.entries(data.providers)) {
        newMap.set(key, {
          status: entry.status === 'healthy' ? 'healthy' : 'unhealthy',
          error: entry.error,
          lastChecked: now,
        })
      }

      // Skip the write when the meaningful health snapshot is unchanged so
      // subscribers keep their Map reference (consistent with markFromHeader's
      // no-op dedupe below).
      if (healthMapsEqual(get().providers, newMap)) return
      set({ providers: newMap })
    } catch {
      // Poll failure — don't clear existing data, just skip this cycle
    }
  },

  markFromHeader: (workspaceId, dataSourceId, value) => {
    if (!workspaceId || !dataSourceId) return
    // Only act on the two values the backend emits; ignore anything else
    // so future header values don't accidentally flip status.
    if (value !== 'unreachable' && value !== 'healthy') return
    const key = `${workspaceId}:${dataSourceId}`
    const cur = get().providers.get(key)
    const next: ProviderStatus = value === 'healthy' ? 'healthy' : 'unhealthy'
    // No-op if already in the same state — avoids triggering subscribers
    // on every request response.
    if (cur && cur.status === next) return
    const newMap = new Map(get().providers)
    newMap.set(key, {
      status: next,
      error: value === 'unreachable' ? 'Reported unreachable by recent request' : undefined,
      lastChecked: Date.now(),
    })
    set({ providers: newMap })
  },
}))

// ─── Polling ──────────────────────────────────────────────────────────────────

let authReady = false
/** Teardown for the change-topic subscription, or null when not subscribed. */
let unsubscribeTopic: (() => void) | null = null
// Set SYNCHRONOUSLY before any await, so a re-entrant caller cannot start a
// second read while the first is still in flight. The original guard tested
// `pollTimer`, which was only assigned AFTER `await refresh()` resolved — so
// for the whole duration of the in-flight request it was still null and the
// guard let re-entrant callers straight through.
let running = false
// Invalidates a read that is parked in `await refresh()` when the session
// ends underneath it, so it cannot apply its result to a torn-down store.
//
// It used to carry more weight than that. This was a self-rescheduling chain,
// and a parked poll held no timer handle, so a teardown's clearTimeout had
// nothing to cancel: the poll woke afterwards and re-armed itself,
// resurrecting a chain that was meant to be dead. Each leaked chain then
// rescheduled forever and could never be cancelled, so the request rate
// climbed monotonically for the lifetime of the tab — measured at this 60s
// poll arriving 5.9x/second, roughly 350 live chains, with the heap climbing
// alongside as every chain retained its closure. It bit hardest exactly when
// a provider was DOWN, because the re-entrancy window IS the in-flight
// request latency and /health/providers probes a dead provider with a 30s
// timeout.
//
// Nothing re-arms now, so that whole failure mode is gone by construction.
let epoch = 0

/** Read provider health once. Nothing re-arms; the caller decides when. */
function refreshOnce() {
  if (running || !authReady) return
  if (typeof document !== 'undefined' && document.hidden) return
  running = true
  const myEpoch = epoch
  void (async () => {
    try {
      if (myEpoch !== epoch) return
      await useProviderHealthStore.getState().refresh()
    } finally {
      if (myEpoch === epoch) running = false
    }
  })()
}

function stopPolling() {
  epoch += 1
  running = false
  if (unsubscribeTopic) {
    unsubscribeTopic()
    unsubscribeTopic = null
  }
}

/** Call once after auth resolves. */
export function enableProviderHealthPolling() {
  authReady = true
  // Provider health changes when a provider actually goes down or comes
  // back, and the backend publishes exactly those transitions — not every
  // probe, which would make this busier than the poll it replaces. So the
  // indicator now moves when the thing it indicates moves, instead of
  // asking sixty times an hour whether it had.
  if (unsubscribeTopic === null) {
    unsubscribeTopic = subscribeToTopic(TOPICS.providerHealth, refreshOnce)
  }
  refreshOnce()
}

/** Call on logout / session loss. */
export function disableProviderHealthPolling() {
  authReady = false
  stopPolling()
}

// Coming back to a tab is worth one read: the change feed's transport may
// have been disconnected while it was hidden.
onAppVisible(refreshOnce)
