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

// 60s (was 30s): aligned to the provider-status poll so provider health
// polling settles at ~once/minute. The advisory signal doesn't need to be
// tighter — real outages surface through request failures and the banner.
const POLL_INTERVAL_MS = 60_000
let pollTimer: ReturnType<typeof setTimeout> | null = null
let authReady = false

function startPolling() {
  if (pollTimer || !authReady) return
  const poll = async () => {
    await useProviderHealthStore.getState().refresh()
    const jitter = Math.random() * 5_000
    pollTimer = setTimeout(poll, POLL_INTERVAL_MS + jitter)
  }
  poll()
}

function stopPolling() {
  if (pollTimer) {
    clearTimeout(pollTimer)
    pollTimer = null
  }
}

/** Call once after auth resolves to enable polling. */
export function enableProviderHealthPolling() {
  authReady = true
  if (typeof document !== 'undefined' && !document.hidden) {
    startPolling()
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopPolling()
    } else {
      startPolling()
    }
  })
}
